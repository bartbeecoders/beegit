# BeeGit Web — design

Status: proposal (plan phase "Web front end", tasks `B-WEB-*` in [plan.html](plan.html)).

A browser front end for BeeGit: browse repositories, trees and files, read history, inspect
changesets and diffs, follow refs, blame a file — the "GitHub repository page" experience,
backed directly by the existing `beegit.v1` RPCs.

## Goals

- **Overview** of every repository the viewer may read: default ref, last change, activity.
- **Code browsing**: directory tree, file view with syntax highlighting, rendered README /
  Markdown, raw download, images, binary and redaction placeholders.
- **History**: log per ref and per path with pagination, first-parent toggle, author/date,
  jump to any revision (`main~3`, `git:<sha>`, id prefixes — the CLI revision grammar).
- **Changesets**: message and metadata, parents, file list, unified and split diffs.
- **Refs**: list of refs with tips and versions, ref log (who moved a ref, when, to what).
- **Blame**: line origins with links to the changeset that introduced each line.
- **Compare**: diff between any two revisions.
- Same authorization as the CLI: the UI only ever shows what the viewer's ACL allows.

Non-goals for the first version: editing files or committing from the browser, code review,
code search, CI status. They are later tasks in the plan.

## Architecture

```text
 Browser (React SPA)                                     VPS (K3s, namespace beegit)
 ┌──────────────────────┐   https://beegit.hideterms.com
 │ Connect-ES clients   │── /beegit.v1.*  (gRPC-Web) ──▶ cloudflared ─▶ NodePort 32100 → beegit-server
 │ generated from       │                                         │
 │ proto/beegit/v1      │── everything else (HTML/JS) ──────────▶ └──▶ NodePort 32101 → beegit-web
 └──────────────────────┘                                                (static files, nginx)
```

- **Same origin, no CORS.** One hostname; the Cloudflare Tunnel routes by path: requests for
  `/beegit.v1.*` go to the server (32100), everything else to the static web container
  (32101, the next port in BeeGit's 32100+ range). The browser never makes a cross-origin
  call, so no CORS configuration or preflight handling is needed.
- **No backend for the frontend.** The SPA calls the server's gRPC-Web endpoint directly — the
  same transport the CLI uses through Cloudflare. All logic that needs authority (ACLs,
  redaction, filtered views) already lives in the server.
- **Generated, typed clients.** `buf generate` with `protoc-gen-es` produces TypeScript
  messages and Connect clients from `proto/beegit/v1/beegit.proto`; the `@connectrpc/connect-web`
  gRPC-Web transport supports unary and server-streaming calls (`ReadPath`, `Diff`,
  `GetObjects`) over `fetch`.
- **Stack.** React + TypeScript + Vite (the BeeDocs stack), TanStack Router and Query
  (caching keyed by immutable ids: a tree or blob id never changes, so cached entries never
  need invalidation), Shiki for highlighting, a virtualized list for large directories, logs
  and blame.

### Data flow per page

| Page | RPCs |
| --- | --- |
| Repository home | `ListRefs` (new), `Resolve`, `ListTree`, `ReadPath` (README), `Log` (latest) |
| Tree / file | `Resolve`, `ListTree`, `ReadPath` (stream; range reads for large files) |
| Log (ref or path) | `Log` with `page_token`, `GetChangesets` for metadata |
| Changeset | `GetChangesets`, `Diff(a = first parent, b = changeset, include_content_hunks)` |
| Compare | `Resolve` ×2, `MergeBase`, `Diff` |
| Blame | `Blame`, `GetChangesets` for the origin changesets |
| Refs | `ListRefs` (new), `GetRefLog` |
| Account | `WhoAmI`, `GetServerInfo` |
| Admin (admins only) | `ListRedactions`, `CheckAccess` |

Identifiers in URLs are full ids or ref names, so links are stable and shareable:
`/r/<repo>/tree/<rev>/<path>`, `/r/<repo>/blob/<rev>/<path>`, `/r/<repo>/log/<rev>[/<path>]`,
`/r/<repo>/c/<changeset>`, `/r/<repo>/blame/<rev>/<path>`, `/r/<repo>/compare/<a>...<b>`,
`/r/<repo>/refs`.

## What the server needs

1. **`ListRefs` RPC** — names, targets and versions, with a prefix filter and pagination,
   filtered by the viewer's read access. (Also unblocks `beegit ref list`, task B-CLI-1.)
2. **Browser login.** The GitHub device flow is built for terminals and GitHub's endpoints do
   not allow browser CORS. Add a GitHub *web* OAuth flow: `/auth/github/start` redirects to
   GitHub, `/auth/github/callback` exchanges the code server-side and returns a BeeGit token
   (same `Login` semantics, same 12 h TTL). The SPA keeps the token in memory and
   `sessionStorage`, never in `localStorage`; logout drops it. Service-principal secrets are
   never entered in a browser. Later: generic OIDC (task B-AUTH-1).
3. **HTTP/1.1 for gRPC-Web.** The server accepts HTTP/2 only. Browsers reach it over HTTP/2
   through Cloudflare, but local development (Vite dev proxy) and some proxies speak HTTP/1.1
   to the origin; enable `accept_http1` for gRPC-Web requests.
4. **Multiple repositories** (task B-FEAT-5) for a real "all repos" overview. Until then the
   overview shows the single configured repository; URLs already carry `<repo>` so nothing
   changes when more appear.
5. **Content-type and size hints** on `ListTree` entries (size is known server-side), so the UI
   can decide between highlighting, rendering, "too large to display" and download without
   fetching the blob first.

## UX details worth getting right

- **Revisions everywhere:** a revision picker accepting ref names, `ref@version`, id prefixes,
  `git:<sha>`, `~n` and `^k`, resolved with `Resolve`; the resolved id is shown and copyable.
- **Large content:** directories with 50k entries (virtualized), files above a few MiB shown
  truncated with a "load all" / raw download, binary detection (same NUL rule as the server's
  diff), images rendered inline.
- **Redaction and restriction:** redacted blobs render as the placeholder with the redaction
  reason when the viewer may see it; restricted subtrees (visible name, unreadable content)
  are shown with a lock icon; filtered changeset views say that some paths are hidden.
- **Imported history:** show `git:<sha>` aliases on changesets imported from Git, so links
  from old tooling keep working.
- **Theme and access:** light/dark following the OS, keyboard navigation (`t` file finder,
  `y` permalink to the resolved id, `b` blame), mobile layout down to 360 px.

## Deployment

- `web/` in this repository: Vite project, `npm run dev` proxies `/beegit.v1.*` to the local
  server (`scripts/start.sh`), so the UI runs against the real local stack.
- Image `beecodersregistry.azurecr.io/beegit-web` (nginx serving the built `dist/`), built and
  pushed by `scripts/deploy-k3s.sh` next to the server image; Deployment + NodePort 32101 in
  `deploy/k3s/beegit-web.yaml`.
- Tunnel ingress (path rule first):

  ```yaml
  - hostname: beegit.hideterms.com
    path: ^/beegit\.v1\.
    service: https://localhost:32100
    originRequest: { http2Origin: true, noTLSVerify: true }
  - hostname: beegit.hideterms.com
    service: http://localhost:32101
  ```

  The CLI keeps working unchanged: it only ever requests `/beegit.v1.*` paths.

## Testing

- Unit: components and the revision grammar (Vitest).
- End to end: Playwright against `scripts/start.sh --native` with a seeded repository
  (import a fixture Git repo), covering browse → file → blame → changeset → compare, plus
  ACL cases (a restricted subtree, a redacted blob, an anonymous visitor).
- Through Cloudflare: the same Playwright suite pointed at `beegit.hideterms.com` as a
  post-deploy smoke test.

## Open questions

- Public read access? An anonymous principal with read on selected paths would make the UI
  usable as a public code browser; today every RPC requires a token.
- Should the UI live on its own hostname (e.g. `git.hideterms.com`) with the API on
  `beegit.hideterms.com`? That needs CORS on the server but allows Cloudflare Access on the UI
  only.
- Rendering Markdown safely: sanitize HTML and keep relative links/images inside the repo.
