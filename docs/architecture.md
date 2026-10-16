# Architecture

A map of BeeGit for people who want to change it. The normative details live in
[SPEC.md](../SPEC.md); this page tells you where things are and how they fit.

## Components

```text
 ┌────────────┐  unix socket  ┌───────────────┐   TLS / gRPC (beegit.v1)  ┌─────────────────┐
 │ beegit CLI │──────────────▶│ beegit-daemon │──────────────────────────▶│  beegit-server  │
 │ (beegit-wc)│               │ disk cache,   │                           │ stateless; N    │
 └─────┬──────┘               │ coalescing    │                           │ replicas behind │
       │                      └───────────────┘                           │ one endpoint    │
       └──────────────────────── TLS / gRPC ─────────────────────────────▶└───┬─────────┬───┘
                                                                              │         │
 beegit-import (git → BeeGit) ─────────────── TLS / gRPC ──────────▶          ▼         ▼
                                                                     CockroachDB    S3 / MinIO
                                                                     (metadata,     (object bytes,
                                                                      refs, CAS)     zstd frames)
```

| Component | Responsibility |
| --- | --- |
| **beegit-server** | Authoritative service. Authenticates, authorizes every path/ref, writes changesets, runs rebase/merge/land, answers history queries, computes derived data, applies redactions. Holds no state of its own. |
| **CockroachDB** | Metadata: object index and inline small objects, changesets and commit graph, refs with versioned CAS, ref log, `object_paths` for authorization, derived data, redactions. Serializable transactions. |
| **S3 / MinIO** | Content-addressed object bytes above the inline threshold (64 KiB), stored as zstd frames. |
| **beegit-daemon** | Optional per-machine cache. Speaks the same protocol over a Unix socket, verifies every object it serves, shares fetched objects across working copies and jobs, follows redactions. |
| **beegit CLI / beegit-wc** | Working copies: sparse checkout, stat-cache status, diff, commit (uploads blobs, then one `CreateChangeset`), amend, rebase with conflict resolution, land. State in `<root>/.beegit/`. |
| **beegit-import** | One-way Git history import, recording `git:<sha>` mappings. |

## Data model in one paragraph

Everything is an immutable object identified by `kind || BLAKE3(canonical bytes)`: **Blob**
(file contents), **Tree** (sorted directory entries with modes), **Meta** (author, committer,
message, creator) and **Changeset** (parents, root tree, delta against the first parent, meta
id, stable `change_id`). A **ref** is a named, versioned pointer to a changeset, updated only by
compare-and-swap. Landing rebases your stack onto the current tip server-side and CASes the ref;
on a lost race it retries — there is no global merge queue. **Derived data** (path history,
blame, commit graph, git mappings) is computed eagerly or lazily per changeset and cached.
See SPEC §4 (domain model), §5 (storage), §8 (write path), §9 (derived data).

## RPC surface (`proto/beegit/v1/beegit.proto`)

| Service | RPCs |
| --- | --- |
| `ObjectService` | `GetServerInfo`, `GetObjects` (stream), `HasObjects`, `ResolveRef` |
| `QueryService` | `GetChangesets`, `ReadPath`, `ListTree`, `Log`, `Blame`, `Diff`, `IsAncestor`, `MergeBase`, `Resolve`, `GetDerived` |
| `WriteService` | `UploadObjects` (stream), `CreateChangeset`, `Rebase`, `Merge`, `Land` |
| `RefService` | `UpdateRef`, `CreateRef`, `DeleteRef`, `GetRefLog` |
| `AuthService` | `Login` (GitHub token or service secret → PASETO token), `WhoAmI`, `CheckAccess` |
| `AdminService` | `Redact`, `Unredact`, `PurgeNow`, `ListRedactions` |

Every response carries `beegit-policy-epoch`, `beegit-redaction-epoch` and `beegit-tier`
trailers so caches can tell when to invalidate.

**Transports.** The server accepts plain gRPC and gRPC-Web on the same port (tonic-web is the
outermost layer of every service). Clients pick with the endpoint scheme: `https://` for gRPC,
`grpc-web+https://` for gRPC-Web, which carries the status and trailers in the response body
and therefore survives proxies that drop HTTP/2 trailers (Cloudflare Tunnel). See
`beegit-proto/src/client.rs` (`Conn`), `beegit-proto/src/grpc_web.rs` (the client-side decoder) and
amendment B-2.

## Crate map

Dependencies only point downward; `scripts/check-layers.sh` enforces the table in
`scripts/layers.toml`.

| Layer | Crate | What it does |
| --- | --- | --- |
| Foundation | `beegit-core` | Errors and codes, ids, modes, principals, clock, limits, fault registry |
| | `beegit-object` | Canonical encoding/decoding of Blob, Tree, Meta, Changeset, HistoryNode; path rules |
| Storage | `beegit-store` | `MetaStore`/`BlobStore` traits, in-memory backends, `ObjectRepo`, fsck, counters |
| | `beegit-store-crdb` | CockroachDB `MetaStore`, embedded migrations |
| | `beegit-store-s3` | S3 `BlobStore` (via `object_store`) |
| Algorithms | `beegit-merge` | Myers diff, `line-diff3-v1` three-way merge |
| | `beegit-history` | Trees, changesets, commit graph, rebase, merge, refs, land, bootstrap |
| | `beegit-derived` | Derived-data framework and the v1 types |
| | `beegit-redaction` | Quarantine/purge lifecycle |
| Security & config | `beegit-auth` | Token keyring, service principals, GitHub client |
| | `beegit-policy` | `acl.toml` parsing and evaluation |
| | `beegit-config` | Server/daemon/client config with `$ENV` substitution |
| | `beegit-obs` | JSON logging, Prometheus metrics, `/healthz` `/readyz` |
| Protocol & service | `beegit-proto` | Generated gRPC code, conversions, error mapping, client |
| | `beegit-server` | Handlers, interceptors, authz adapters, rate limiting, background jobs |
| Client | `beegit-cache` | Verified content-addressed cache, request coalescing |
| | `beegit-daemon` | The node daemon |
| | `beegit-wc` | Working-copy library |
| | `beegit-cli` | The `beegit` binary |
| Tools | `beegit-import` | The `beegit-import` binary |
| Verification | `beegit-refmodel` | Independent reference model used as an oracle |
| | `beegit-testkit` | Fakes (GitHub, upstream), corpora, TLS, linearizability checker |
| | `beegit-conformance` | Cross-crate conformance suites and benchmarks |

Binaries: `crates/beegit-server/src/main.rs`, `crates/beegit-cli`, `crates/beegit-daemon`,
`crates/beegit-import/src/main.rs`.

## Where to start reading

| If you want to… | Read |
| --- | --- |
| Understand a commit end to end | `beegit-wc/src/commit.rs` → `beegit-server/src/handlers` (write) → `beegit-history/src/create.rs` |
| Understand landing | `beegit-history/src/{rebase.rs,land.rs}`, SPEC §8.4–8.6 |
| Add an RPC | `proto/beegit/v1/beegit.proto`, `beegit-proto`, a handler in `beegit-server/src/handlers`, then the client in `beegit-proto/src/client.rs` |
| Add a CLI command | `beegit-cli/src/cli/args.rs`, `cli/{wc_cmds,query,auth,redact}.rs`, a schema under `schemas/v1` (regenerate with `BEEGIT_REGEN_SCHEMAS=1 cargo test -p beegit-cli --test cli_json`) |
| Change storage | `beegit-store/src/meta.rs` (trait + in-memory model), then `beegit-store-crdb`; contracts in `docs/contracts/storage-semantics.md` |
| Change authorization | `beegit-policy`, `beegit-server/src/authz` |

## Scope and known limits

Inherited from upstream and still true:

- One repository per server, Unix clients (Linux, macOS).
- Deferred: regional cache servers, daemon snapshot bootstrap, virtualized (FUSE) checkouts,
  filesystem-watcher status, copy detection.
- No Git wire-protocol compatibility yet — a design exists in [git-gateway.md](git-gateway.md).
- No offline operation; code review, code search and CI orchestration are separate systems.
- Production throughput has not been established; the benchmark numbers in
  [upstream/benchmarks.md](upstream/benchmarks.md) are single-machine measurements from upstream.

The full list of deferred work and edge cases is
[SPEC Appendix A](../SPEC.md#appendix-a-deferred-work-and-known-edge-cases). Improvements we plan
are in [plan.html](plan.html).
