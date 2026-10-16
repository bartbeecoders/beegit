# Deploying BeeGit on the K3s VPS

Target: the VPS at `212.47.77.32` (`ssh bart@212.47.77.32`) running single-node K3s, exposed
publicly through a Cloudflare Tunnel as **`beegit.hideterms.com`**. Clients connect with the
endpoint **`grpc-web+https://beegit.hideterms.com`** (see "Why gRPC-Web" below).
Everything lives in the namespace `beegit`, and one script does the work:
[`scripts/deploy-k3s.sh`](../scripts/deploy-k3s.sh) (same structure as the BeeDocs script).

```text
 beegit CLI ──HTTPS/gRPC──▶ Cloudflare edge ──tunnel──▶ cloudflared (VPS)
            beegit.hideterms.com                          │ https, HTTP/2
                                                          ▼
                                         NodePort 32100 → Deployment beegit-server
                                                          ├─▶ StatefulSet beegit-cockroach (PVC 10Gi)
                                                          └─▶ StatefulSet beegit-minio     (PVC 20Gi)
```

- **Ports.** BeeGit uses NodePorts from **32100** up: `32100` is gRPC. `32101+` are kept free for
  later (web UI, git gateway). Nothing else is exposed: CockroachDB, MinIO and the metrics
  listener are `ClusterIP` only.
- **Why gRPC-Web.** Plain gRPC reports each call's final status in HTTP/2 *trailers*, and
  Cloudflare Tunnel public hostnames drop trailers: the body arrives but the status does not,
  and every call fails with `missing grpc-status trailer`. gRPC-Web puts the status (and
  BeeGit's `beegit-*` epoch trailers) inside the response body instead. The server accepts both
  on the same port, so in-cluster clients and the daemon can keep using plain gRPC.
- **TLS.** Clients see Cloudflare's public certificate for `beegit.hideterms.com`, so they need
  no private CA. Between cloudflared and the pod, the server still speaks TLS with a
  certificate from BeeGit's private CA (`deploy/k3s/state/ca.pem`).
- **Image.** Built with Podman and pushed to `beecodersregistry.azurecr.io/beegit`, pulled
  with the existing `acr-secret` (copied into `beegit` on first deploy from another
  namespace such as `beedocs`).
- **Version.** `<workspace version>-<git sha>`, e.g. `0.1.0-92fae23`; a dirty tree adds
  `-dirty-<timestamp>`. Each new tag rolls the server out by itself.
- **Storage.** K3s's `local-path` provisioner (data under `/var/lib/rancher/k3s/storage`).

## 1. Prerequisites

Locally: `podman`, `ssh`, `openssl`, `git`, and push access to the ACR
(`podman login beecodersregistry.azurecr.io`, or set `REGISTRY_USER`/`REGISTRY_PASSWORD`).

On the VPS:

- `bart` can run `kubectl`, or `sudo k3s kubectl` without a password prompt (the script uses
  whichever works, like the BeeDocs script).
- An `acr-secret` in one of `beedocs`, `beehosting`, `aidbooks`, `sqail`, `fietsloire`.
- cloudflared running a tunnel you control (configuration lives outside this repo).
- ~2 GiB free RAM (CockroachDB requests 768 MiB, limit 1.5 GiB) and ~30 GiB disk.

## 2. Cloudflare setup (once)

1. **Ingress rule.** Add to the tunnel configuration (print it with
   `./scripts/deploy-k3s.sh tunnel`):

   ```yaml
   - hostname: beegit.hideterms.com
     service: https://localhost:32100
     originRequest:
       http2Origin: true     # gRPC needs HTTP/2 to the origin
       noTLSVerify: true     # origin cert is signed by BeeGit's private CA
   ```

   If cloudflared runs somewhere other than the K3s node, use `https://<node-ip>:32100`.
   For the dashboard-managed tunnel: Public Hostname → Service `HTTPS` `localhost:32100`,
   and under Additional settings → TLS enable **HTTP2 connection** and **No TLS Verify**.
   Stricter alternative to `noTLSVerify`: `originServerName: beegit-server` plus
   `caPool: /path/to/ca.pem` (copy `deploy/k3s/state/ca.pem` to the cloudflared host).
2. **Enable gRPC** for the `hideterms.com` zone: dashboard → Network → gRPC → On.
   Without it Cloudflare will not pass gRPC requests through.
3. **No Cloudflare Access on this hostname.** The CLI cannot complete an interactive SSO login;
   BeeGit authenticates every call with its own tokens. (A later option is an Access
   service-token header — not supported by the CLI yet.)

Cloudflare limits that apply: a request body may be at most 100 MB on Free/Pro plans, which
caps a single upload batch (the client batches uploads in 8 MiB batches by default, and
`limits.max_blob_bytes` is 100 MiB), and responses must start within 100 s.

## 3. Generate production secrets (once)

```sh
./scripts/deploy-k3s.sh secrets     # = make k3s-secrets
```

This writes `deploy/k3s/state/` (git-ignored, mode 0700): a private CA, the origin certificate,
the token-signing key, the `admin` service secret, random MinIO credentials and `acl.toml`. It
is idempotent: existing files are kept.
**Back this directory up somewhere safe** (password manager or encrypted storage): losing the
signing key logs everyone out, losing the S3 credentials means re-keying MinIO, and the admin
secret is your way in.

## 4. Deploy

```sh
./scripts/deploy-k3s.sh             # all: secrets → build → push → deploy → status
```

Individual steps:

| Command | What it does |
| --- | --- |
| `build` | `podman build` → `beecodersregistry.azurecr.io/beegit:<version>` and `:latest` (~10 min cold) |
| `push` | `podman login` + push both tags |
| `deploy` | Namespace, `acr-secret`, then a kustomize bundle (manifests + `config/beegit-server.toml` + `deploy/k3s/state`) streamed over SSH into a temp dir, `kubectl apply -k`, temp dir removed; waits for the rollouts |
| `status` | `kubectl get pods,svc,deploy,sts,pvc` |
| `logs` | Last 80 server log lines |
| `shell` | Shell in the server pod |
| `login` | Prints the commands to log in as `admin` through the tunnel |
| `smoke` | Runs `dev/smoke.sh` against `https://beegit.hideterms.com` |
| `tunnel` | Prints the cloudflared ingress rule |
| `bundle DIR` | Writes the bundle that `deploy` would apply, for inspection |

`push` and `deploy` reuse the version of the last `build`. Override any of: `VPS_IP`,
`VPS_USER`, `REGISTRY`, `PUBLIC_HOST`, `APP_VERSION`.

Config, policy and secrets are generated by kustomize with content hashes in their names, so
changing `acl.toml`, `config/beegit-server.toml` or a secret and running `deploy` restarts the
server with the new values.

## 5. Connect

```sh
export BEEGIT_ENDPOINT=grpc-web+https://beegit.hideterms.com
unset BEEGIT_CA_FILE
BEEGIT_SERVICE_SECRET="$(cat deploy/k3s/state/admin.secret)" beegit login --service admin
beegit whoami
./scripts/deploy-k3s.sh smoke      # commits a small file under smoke/ on main
```

The same scheme works everywhere an endpoint is accepted: `--endpoint`, the CLI config files,
`beegit-import --endpoint`, and a daemon's `upstream`.

Directly against the origin (bypassing Cloudflare, e.g. for debugging on the VPS), plain gRPC
works: `BEEGIT_ENDPOINT=https://localhost:32100 BEEGIT_CA_FILE=ca.pem` — `localhost` is in the
certificate's SANs.

### More principals (CI, agents, colleagues)

Give each consumer its own service principal instead of sharing `admin`:

1. `SECRET=$(openssl rand -hex 32)`; `printf %s "$SECRET" | sha256sum`.
2. In `config/beegit-server.toml` add
   ```toml
   [[auth.service_principals]]
   name = "ci"
   secret_sha256 = "$BEEGIT_CI_SECRET_SHA256"
   ```
   and `BEEGIT_CI_SECRET_SHA256=<hash>` to `deploy/k3s/state/secrets.env` and
   `dev/state/secrets.env` (the local stack reads the same config template).
3. Grant `service:ci` in `deploy/k3s/state/acl.toml`, then `./scripts/deploy-k3s.sh deploy`.

### GitHub login for people

Register a GitHub OAuth App (Settings → Developer settings → OAuth Apps) with **Device Flow**
enabled. Set its client id in `deploy/k3s/beegit-server.yaml` (`BEEGIT_GITHUB_CLIENT_ID`), add
`github:<login>` entries to `acl.toml`, and deploy. `beegit login` then shows a code to enter
on github.com.

## 6. Operations

`kubectl` below means `kubectl` / `sudo k3s kubectl` on the VPS.

| Task | Command |
| --- | --- |
| Logs | `./scripts/deploy-k3s.sh logs`, or `kubectl -n beegit logs deploy/beegit-server -f` |
| Metrics / health | `kubectl -n beegit port-forward svc/beegit-server-admin 9464` → http://localhost:9464/metrics |
| CockroachDB UI | `kubectl -n beegit port-forward svc/beegit-cockroach 8080` |
| MinIO console | `kubectl -n beegit port-forward svc/beegit-minio 9001` (credentials in `state/s3.env`) |
| SQL shell | `kubectl -n beegit exec -it beegit-cockroach-0 -- cockroach sql --insecure` |
| Restart server | `kubectl -n beegit rollout restart deploy/beegit-server` |
| Scale server | `kubectl -n beegit scale deploy/beegit-server --replicas=2` (stateless) |
| Wipe everything | `kubectl delete namespace beegit` (**deletes all repository data**) |

To port-forward from your laptop, tunnel the API server first:
`ssh -L 6443:127.0.0.1:6443 bart@212.47.77.32` with a copy of `/etc/rancher/k3s/k3s.yaml`.

### Backups

There are no automated backups yet (task **B-OPS-1** in the [plan](plan.html)). Until then, a
manual consistent snapshot:

```sh
ssh bart@212.47.77.32 'sudo k3s kubectl -n beegit exec beegit-cockroach-0 -- \
  cockroach sql --insecure -e "BACKUP INTO '"'"'nodelocal://1/backups'"'"' AS OF SYSTEM TIME '"'"'-10s'"'"';"'
```

plus a copy of the MinIO bucket (`mc mirror`). Read
[operations/backup-retention.md](operations/backup-retention.md) first: backups also retain
purged (redacted) content, so they must expire within 30 days.

## 7. Security notes

- Only the tunnel reaches the server; NodePort 32100 is also open on the node itself, so keep
  it closed in the VPS firewall (only cloudflared on the host needs it).
- CockroachDB runs in `--insecure` mode (no TLS, no SQL auth), reachable only inside the
  cluster. Add a `NetworkPolicy` and secure mode (B-SEC-2).
- One CockroachDB node and one MinIO node: no redundancy; data lives on the VPS disk.
- The `admin` principal is all-powerful: give each consumer its own principal and keep
  `admin.secret` offline.

## 8. Troubleshooting

| Symptom | Check |
| --- | --- |
| `beegit-server` stuck in `Init` | The init container waits for CockroachDB and MinIO: `kubectl -n beegit get pods`, `describe pod`. |
| `ImagePullBackOff` | `acr-secret` present in `beegit`? Tag pushed? `kubectl -n beegit describe pod -l app=beegit-server` |
| `missing grpc-status trailer` | You used `https://` through Cloudflare; use `grpc-web+https://beegit.hideterms.com`. |
| Client: `UNAVAILABLE` / 502 via Cloudflare | gRPC enabled on the zone? Ingress rule uses `https://` with `http2Origin: true` and `noTLSVerify`? Test the origin on the VPS: `curl -k --http2 -sv https://localhost:32100 2>&1 \| grep ALPN`. |
| Client: `UNAUTHENTICATED` | Token expired (12h) — log in again. A Cloudflare Access policy on the hostname also causes this. |
| CrashLoop with a config error | `kubectl -n beegit logs deploy/beegit-server --previous`; errors name the TOML key. |
