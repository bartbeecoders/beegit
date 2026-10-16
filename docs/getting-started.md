# Getting started

This guide takes you from a fresh checkout to a running BeeGit server on your machine, a working
CLI, and an imported Git repository. For the VPS, see [deployment-k3s.md](deployment-k3s.md).

## 1. Prerequisites

| Tool | Why | Check |
| --- | --- | --- |
| Rust via rustup | Builds everything; `rust-toolchain.toml` pins 1.98.0 and rustup installs it | `cargo --version` |
| `protoc` | Generates the gRPC code (`beegit-proto/build.rs`) | `protoc --version` |
| `openssl` | `dev/gen-secrets.sh` creates the CA, TLS cert, signing key, secrets | `openssl version` |
| Docker or Podman + Compose | CockroachDB and MinIO (and optionally the server) | `docker compose version` / `podman compose version` |
| `git` (optional) | Importing repositories; some differential tests | `git --version` |

**Podman notes.** The Makefile uses Docker when its daemon is reachable and falls back to Podman.
Rootless Podman needs its API socket for Compose: `systemctl --user start podman.socket`
(add `enable` to make it permanent). If you want Docker instead, add yourself to the `docker`
group and start the service (`sudo usermod -aG docker $USER && sudo systemctl enable --now docker`,
then log in again). Force one with `make CONTAINER=podman dev-up`.

## 2. Build

```sh
make build        # cargo build --workspace (debug)
make release      # optimized binaries in target/release
```

Four executables come out of the build:

| Binary | Role |
| --- | --- |
| `beegit-server` | The gRPC/TLS service. Stateless; all state lives in CockroachDB + S3. |
| `beegit` | The CLI: login, checkout, status, diff, commit, land, log, blame, cat, … |
| `beegit-daemon` | Optional per-machine cache that many working copies/jobs share over a Unix socket. |
| `beegit-import` | One-way Git → BeeGit history importer. |

## 3. Run the local stack

There are two ways; both use the same config file, `config/beegit-server.toml`, whose `$NAME`
values are filled in from environment variables.

### Option A — everything in containers

```sh
make dev-up       # = make secrets + compose up (cockroach, minio, beegit-server) --build --wait
make dev-logs     # follow the server log
make dev-down     # stop (data is kept in named volumes)
make dev-reset    # stop and wipe all data
```

### Option B — backends in containers, server from source

Best while changing server code: rebuilds are incremental and logs go to your terminal.

```sh
make dev-backends # CockroachDB + MinIO only
make run-server   # release build + `source dev/env.sh` + beegit-server config/beegit-server.toml
```

### What is running

| Endpoint | What |
| --- | --- |
| `https://localhost:7443` | BeeGit gRPC (TLS; CA in `dev/state/ca.pem`) |
| `http://localhost:9464/metrics` · `/healthz` · `/readyz` | Server admin listener |
| `http://localhost:8080` | CockroachDB admin UI |
| `http://localhost:9001` | MinIO console (`minioadmin` / `minioadmin`) |

On first start the server runs its database migrations and bootstraps the repository: a root
changeset and the ref `main`.

### Generated secrets (`dev/state/`, git-ignored)

`make secrets` runs `dev/gen-secrets.sh`, which is idempotent (existing files are kept;
`FORCE=1` regenerates):

| File | Purpose |
| --- | --- |
| `ca.pem`, `ca.key` | Private CA. Clients trust `ca.pem` via `BEEGIT_CA_FILE` or `--ca-file`. |
| `tls.crt`, `tls.key` | Server certificate for `localhost`, `127.0.0.1`, `beegit-server` (+ `BEEGIT_TLS_SANS`) |
| `signing.ed25519.pem` | Ed25519 key that signs session tokens (PASETO v4.public) |
| `admin.secret` | Secret of the `admin` service principal; its SHA-256 goes into `secrets.env` |
| `acl.toml` | Access policy: `service:admin` (+ `BEEGIT_ADMINS`) may do everything |
| `secrets.env`, `s3.env` | Env files consumed by Compose/K3s |

## 4. Use the CLI

```sh
source dev/env.sh                 # sets BEEGIT_ENDPOINT, BEEGIT_CA_FILE, admin credentials, PATH
beegit login --service admin      # token stored in ~/.config/beegit/credentials (0600)
beegit whoami

beegit checkout main ~/work/demo                       # full checkout
beegit checkout main ~/work/docs --sparse docs         # only docs/
cd ~/work/demo
echo hi > hello.txt
beegit status
beegit diff
beegit commit -m "Add hello"      # stored on the server immediately
beegit land --ref main            # rebase onto main and CAS the ref
beegit log --rev main --limit 10
beegit cat main:hello.txt
beegit blame hello.txt
beegit sparse --help              # change the sparse profile later
```

Every command supports `--json`, printing one line `{"schema":"beegit.cli.<cmd>.v1","data":…}`
(schemas in [`schemas/v1`](../schemas/v1)). Exit codes: 0 ok, 1 error, 2 usage, 3 conflicts,
4 refused because of dirty files.

Revisions: a changeset id or unique prefix (≥ 8 hex), a ref name, `<ref>@<version>`,
`git:<sha>` (imported commits), with suffixes `~n` and `^k`.

Run `dev/smoke.sh` at any time for a scripted end-to-end check. It uses a throw-away `HOME`, so
it never touches your real credentials.

### Logging in as a human (GitHub)

Service principals are enough for local work, agents and CI. For people, register a GitHub OAuth
App with device flow enabled, then set `BEEGIT_GITHUB_CLIENT_ID` for the server and add the users
to `acl.toml` (e.g. `admins = ["service:admin", "github:yourlogin"]`). `beegit login` without
`--service` then runs the device flow. The policy file is hot-reloaded.

## 5. Import a Git repository

```sh
source dev/env.sh   # beegit-import reads BEEGIT_SERVICE_NAME / BEEGIT_SERVICE_SECRET or BEEGIT_TOKEN
beegit-import --git /path/to/repo --ref HEAD --target-ref main --skip-submodules
```

The importer is one-way and resumable; re-importing unchanged history uploads nothing.
`--target-ref` must be absent or a fast-forward of what you import (the bootstrapped `main` only
holds the empty root, so import into a fresh server's `main`, or use e.g. `import/<name>`).
Imported commits are addressable as `git:<sha>`.

## 6. The node daemon (optional)

`beegit-daemon` caches objects on disk and shares them between working copies and CI jobs on the
same machine. Example `beegit-daemon.toml`:

```toml
socket = "/run/user/1000/beegit/daemon.sock"
upstream = "https://localhost:7443"
cache_dir = "/home/you/.cache/beegit"
max_cache_bytes = 10737418240     # 10 GiB
upstream_ca = "/path/to/BeeGit/dev/state/ca.pem"   # private CA of the server
# metrics_listen = "127.0.0.1:9465"               # optional /metrics, /healthz, /readyz
```

```sh
beegit-daemon --config beegit-daemon.toml
export BEEGIT_ENDPOINT=unix:///run/user/1000/beegit/daemon.sock
```

Keep the socket path short: Unix sockets are limited to about 107 bytes.
All keys are listed in [SPEC 6.3](../SPEC.md#63-daemon-config-beegit-daemontoml).

## 7. Configuration reference

`config/beegit-server.toml` is the single template. The variables it reads:

| Variable | Local (`dev/env.sh`) | Container / K3s |
| --- | --- | --- |
| `BEEGIT_LISTEN` | `127.0.0.1:7443` | `0.0.0.0:7443` (image default) |
| `BEEGIT_METRICS_LISTEN` | `127.0.0.1:9464` | `0.0.0.0:9464` |
| `BEEGIT_REPO` | `monorepo` | `monorepo` |
| `BEEGIT_DB_URL` | `postgresql://root@localhost:26257/defaultdb?sslmode=disable` | `…@beegit-cockroach:26257/…` |
| `BEEGIT_S3_ENDPOINT` / `BEEGIT_S3_BUCKET` | `http://localhost:9000` / `beegit` | `http://beegit-minio:9000` / `beegit` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `minioadmin` | from `s3.env` |
| `BEEGIT_TLS_CERT` / `BEEGIT_TLS_KEY` | `dev/state/tls.*` | `/etc/beegit/tls/tls.*` |
| `BEEGIT_SIGNING_KEY` | `dev/state/signing.ed25519.pem` | `/etc/beegit/keys/…` |
| `BEEGIT_POLICY_PATH` | `dev/state/acl.toml` | `/etc/beegit/policy/acl.toml` |
| `BEEGIT_ADMIN_SECRET_SHA256` | from `secrets.env` | from `secrets.env` |
| `BEEGIT_GITHUB_CLIENT_ID` | `not-configured` | `not-configured` |
| `BEEGIT_LOG_FORMAT` | `text` | `json` |

Unknown keys and unset variables are startup errors that name the key. Optional sections
(`[limits]`, `[land]`, `[derive]`, `[redaction]`, `[rate_limit]`) and their defaults are in
[SPEC 6.1/6.5](../SPEC.md#6-configuration-specification).

Client-side variables: `BEEGIT_ENDPOINT`, `BEEGIT_CA_FILE`, `BEEGIT_TOKEN`,
`BEEGIT_SERVICE_SECRET`, `BEEGIT_AUTHOR`, `BEEGIT_LOG`.

## 8. Tests

```sh
make test                              # ~1,300 hermetic tests, in-memory storage, no Docker
make check                             # what CI runs
scripts/test-external.sh --up --all    # against CockroachDB + MinIO (docker/compose.test.yml)
```

See [testing.md](testing.md) for the test architecture (reference model, fault injection,
Git differentials, complexity gates).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `permission denied … docker.sock` | Not in the `docker` group; use Podman (`systemctl --user start podman.socket`) or fix the group. |
| `failed to connect … podman.sock` | `systemctl --user start podman.socket` |
| Server exits with an unresolved-variable error naming a key | Source `dev/env.sh` (native) or check the Compose env. |
| `UNAVAILABLE` / TLS errors from the CLI | `BEEGIT_CA_FILE` must point at the CA that signed the server cert; the hostname must be in its SANs (`dev/state/tls.sans`). |
| `UNAUTHENTICATED` | Token expired (12h): run `beegit login …` again. |
| `PERMISSION_DENIED` | Principal not granted in `acl.toml`; edit it, the server reloads it. |
