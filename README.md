# BeeGit 🐝

Server-first source control for always-online developers, coding agents and CI.

BeeGit keeps history and the expensive operations (commit, rebase, merge, land, log, blame)
on the server. Clients fetch immutable, content-addressed objects on demand and check out only
the paths a job needs. There is no clone and no push: a commit is stored on the server the
moment you make it.

BeeGit is a fork of [Scion](https://github.com/CarterT27/scion) by Carter Tran (Apache 2.0),
itself an independent implementation of the ideas in Anthropic's
[Redesigning source control](https://www.anthropic.com/engineering/redesigning-source-control).
Neither project is affiliated with Anthropic. See [NOTICE](NOTICE) for attribution and the
list of changes.

| | |
| --- | --- |
| **Status** | v0.1, single repository per server, Linux/macOS clients |
| **Language** | Rust 1.98 (pinned), 23 crates, ~130k lines incl. tests |
| **Storage** | CockroachDB (metadata) + any S3-compatible store (objects), e.g. MinIO |
| **Protocol** | gRPC or gRPC-Web over TLS (`beegit.v1`), BLAKE3 object ids, zstd compression |
| **Roadmap** | [docs/plan.html](docs/plan.html) — improvements and tasks |

## Install the client

```sh
curl -fsSL https://github.com/bartbeecoders/beegit/releases/latest/download/install.sh | sh
export BEEGIT_ENDPOINT=grpc-web+https://beegit.hideterms.com
beegit login
```

Installs `beegit`, `beegit-daemon` and `beegit-import` into `~/.local/bin` (Linux x86_64/arm64,
macOS) after verifying the release checksum. From a checkout: `scripts/package-client.sh` then
`BEEGIT_ARCHIVE=dist/beegit-<version>-<target>.tar.gz scripts/install.sh`.

## Quick start (local, about 5 minutes)

Prerequisites: Rust via rustup, `protoc`, `openssl`, and Docker **or** Podman with Compose.

```sh
scripts/start.sh                # secrets → build → CockroachDB + MinIO + beegit-server on :7443
scripts/start.sh --smoke        # same, then an end-to-end test (login, commit, land, log, cat, sparse)
scripts/start.sh --native       # run beegit-server from source instead of in a container
scripts/start.sh --status | --logs | --stop | --reset
```

(The `make dev-up`, `make run-server` and `make smoke` targets do the same steps individually.)

Web UI: `make web-dev` → http://localhost:5173 (sign in with a token from
`~/.config/beegit/credentials`; see [docs/web-ui.md](docs/web-ui.md)).

Then use the CLI yourself:

```sh
source dev/env.sh                       # endpoint, CA, admin service credentials, PATH
beegit login --service admin
beegit checkout main ~/work/demo
cd ~/work/demo && echo "hello" > hello.txt
beegit status
beegit commit -m "First BeeGit commit"
beegit land --ref main
beegit log --rev main
```

Prefer to run the server from source while hacking on it?
`make dev-backends && make run-server` starts only the databases in containers and runs
`beegit-server` natively. Details: [docs/getting-started.md](docs/getting-started.md).

Import an existing Git repository (one-way, full history):

```sh
source dev/env.sh
beegit-import --git /path/to/repo --ref HEAD --target-ref main --skip-submodules
```

## Deploy to the K3s VPS

Public endpoint: **`grpc-web+https://beegit.hideterms.com`** (Cloudflare Tunnel → NodePort 32100;
gRPC-Web because the tunnel drops the HTTP/2 trailers plain gRPC needs). The **web UI** is
served on the same hostname: **https://beegit.hideterms.com** (NodePort 32101).

```sh
./scripts/deploy-k3s.sh secrets   # once: origin TLS, signing key, admin secret, S3 creds
./scripts/deploy-k3s.sh           # build → push to ACR → deploy → status
./scripts/deploy-k3s.sh smoke     # end-to-end test through Cloudflare
```

Tunnel ingress rule, gRPC setting and operations: [docs/deployment-k3s.md](docs/deployment-k3s.md).

## How it works

```text
 beegit CLI ── Unix socket ──▶ beegit-daemon ── TLS/gRPC ──▶ beegit-server ──┬── CockroachDB
     │        (optional node cache, shared by jobs)              ▲          └── S3 / MinIO
     └──────────────────────── TLS/gRPC ──────────────────────────┘
```

- **Server-side writes.** Commit, rebase, merge and land are RPCs. No push step.
- **Incremental history.** Changesets store file deltas against their first parent plus a root
  tree pointer; history queries (log, blame, diff, ancestry) run on the server.
- **Sparse checkouts.** Fetch only the trees and blobs under the requested paths.
- **Lock-free landing.** Rebase onto the ref and compare-and-swap it, retrying with backoff.
- **Access control and redaction.** Path- and ref-level ACLs, GitHub device-flow login, service
  principals for agents/CI, and quarantine/purge of leaked content without rewriting ids.

More: [docs/architecture.md](docs/architecture.md) and the full [SPEC.md](SPEC.md).

## Repository layout

| Path | What |
| --- | --- |
| `crates/` | The 23 Rust crates (see [architecture](docs/architecture.md#crate-map)) |
| `proto/beegit/v1/` | gRPC protocol definition |
| `config/beegit-server.toml` | Server config template; every environment fills it via `$ENV` vars |
| `scripts/` | `start.sh` (local stack), `deploy-k3s.sh` (VPS), checks, benchmarks, `rebrand-upstream.sh` |
| `dev/` | Local tooling: `gen-secrets.sh`, `env.sh`, `smoke.sh` (state goes to `dev/state/`, git-ignored) |
| `docker/` | `compose.dev.yml` (local stack), `compose.test.yml` (external-backend tests) |
| `web/` | Web UI: React + TypeScript + Vite, Connect-ES gRPC-Web clients ([docs/web-ui.md](docs/web-ui.md)) |
| `deploy/k3s/` | Kustomize manifests for the VPS (applied by `scripts/deploy-k3s.sh`) |
| `Dockerfile` | One image with `beegit-server`, `beegit`, `beegit-daemon`, `beegit-import` |
| `docs/` | Guides, contracts, the [plan](docs/plan.html), [upstream benchmarks](docs/upstream/benchmarks.md) |
| `schemas/v1/` | JSON schemas for `beegit --json` output |
| `testdata/`, `corpus/` | Frozen golden vectors and Git fixtures |
| `scion/` | Pristine upstream checkout for reference/diffing (git-ignored) |

## Development

```sh
make help           # all targets
make test           # hermetic suite: in-memory storage, loopback TLS, no Docker (~1,300 tests)
make check          # fmt + build + test + clippy -D warnings + dependency-layer check
scripts/test-external.sh --up --all   # the suite against real CockroachDB + MinIO
```

See [docs/testing.md](docs/testing.md) and [docs/upstream-sync.md](docs/upstream-sync.md)
for pulling fixes from upstream Scion.

**Releasing the client:** bump `version` in `Cargo.toml` (`[workspace.package]`), commit, then
`git tag v<version> && git push origin v<version>`. `.github/workflows/release.yml` builds
Linux x86_64/arm64 and macOS arm64/x86_64 archives with `scripts/package-client.sh` and
publishes them, their `.sha256` files and `install.sh` as a GitHub release.

## Documentation

| Guide | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Local stack, CLI workflow, config and env vars, daemon, import |
| [Deployment on K3s](docs/deployment-k3s.md) | VPS deploy, operations, backups, hardening |
| [Architecture](docs/architecture.md) | Components, data model, crate map, scope |
| [Plan & tasks](docs/plan.html) | Roadmap of improvements (open in a browser) |
| [SPEC.md](SPEC.md) | Normative specification (formats, RPCs, algorithms, tests) |
| [Implementation-defined behaviour](docs/implementation-defined.md) | Choices the SPEC leaves open |
| [Amendments](docs/contracts/amendments.md) | Every deviation from the frozen plan, incl. the fork (B-1) |
| [Backup & retention](docs/operations/backup-retention.md) | Operational contract for backups |
| [Web UI](docs/web-ui.md) | Browser UI for repos, files, history, diffs, blame: usage and design |
| [Git gateway (draft)](docs/git-gateway.md) | Design for serving unmodified git clients |

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Third-party Git fixtures retain their own license notices in [`corpus/git`](corpus/git).
