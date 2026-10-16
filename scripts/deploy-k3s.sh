#!/bin/bash
set -euo pipefail

#===============================================================================
# BeeGit - K3S Deployment Script (Podman)
#===============================================================================
# Builds and pushes the BeeGit image, then deploys it to K3S on the VPS.
#
# Architecture (namespace: beegit):
#   • beegit-server     Stateless gRPC + gRPC-Web server (TLS with BeeGit's private CA).
#                       NodePort 32100 — Cloudflare Tunnel forwards
#                       https://beegit.hideterms.com here over HTTP/2
#                       (tunnel config managed outside this repo). Clients use
#                       grpc-web+https://beegit.hideterms.com, because the tunnel
#                       drops the HTTP/2 trailers that plain gRPC relies on.
#   • beegit-cockroach  CockroachDB, single node, metadata (PVC 10Gi). ClusterIP only.
#   • beegit-minio      MinIO, object bytes (PVC 20Gi). ClusterIP only.
#
#   Ports 32100 and up are reserved for BeeGit on the VPS:
#     32100  gRPC (beegit CLI, daemon, importer)
#     32101+ free for later (web UI, git gateway)
#
# Registry:  beecodersregistry.azurecr.io  (reuses the existing acr-secret
#            ImagePullSecret — copied into this namespace on first deploy).
# Secrets:   generated locally into deploy/k3s/state (git-ignored) by the
#            `secrets` command; streamed to the VPS inside the kustomize bundle
#            and removed from the VPS disk right after `kubectl apply`.
#            Back that directory up: it holds the signing key and admin secret.
#
# Usage:
#   ./scripts/deploy-k3s.sh [all|build|push|deploy|status|logs|shell|secrets|login|smoke|tunnel|bundle]
#
#   all        secrets → build → push → deploy → status (default)
#   build      build the image locally with podman
#   push       podman login + push the image
#   deploy     apply the manifests on the VPS and wait for the rollout
#   status     kubectl get on the namespace
#   logs       tail the server logs
#   shell      open a shell in the running server pod
#   secrets    generate deploy/k3s/state if missing (idempotent)
#   login      print the commands to log in as `admin` through the tunnel
#   smoke      run dev/smoke.sh against https://beegit.hideterms.com
#   tunnel     print the Cloudflare Tunnel ingress rule
#   bundle DIR write the kustomize bundle that `deploy` applies to DIR (inspection)
#
# Version: <workspace version>-<git sha> (e.g. 0.1.0-92fae23); a dirty tree adds
# -dirty-<timestamp>. Every image is also pushed as :latest. `push` and `deploy`
# reuse the version of the last `build` (override with APP_VERSION=...).
#
# Required tools locally:
#   podman, ssh, openssl, git
#===============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMMAND="${1:-all}"

REGISTRY="${REGISTRY:-beecodersregistry.azurecr.io}"
NAMESPACE="beegit"
IMAGE="$REGISTRY/beegit"
NODE_PORT=32100
PUBLIC_HOST="${PUBLIC_HOST:-beegit.hideterms.com}"
# Cloudflare Tunnel public hostnames drop HTTP/2 trailers, which plain gRPC needs for its
# status; gRPC-Web carries the status in the body, so clients use the grpc-web+https scheme.
PUBLIC_ENDPOINT="grpc-web+https://$PUBLIC_HOST"

# VPS target (override via environment variables).
VPS_IP="${VPS_IP:-212.47.77.32}"
VPS_USER="${VPS_USER:-bart}"

K8S_DIR="$ROOT_DIR/deploy/k3s"
STATE_DIR="$K8S_DIR/state"
STATE_FILES=(acl.toml tls.crt tls.key signing.ed25519.pem secrets.env s3.env)

app_version() {
  local base sha
  base="$(sed -n '/^\[workspace.package\]/,/^\[/s/^version = "\(.*\)"/\1/p' Cargo.toml)"
  sha="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    echo "$base-$sha-dirty-$(date +%Y%m%d%H%M%S)"
  else
    echo "$base-$sha"
  fi
}
# `build` records the version it built, so a later `push` / `deploy` uses the same tag
# even when a dirty tree would compute a new timestamp.
VERSION_FILE="$ROOT_DIR/target/deploy-k3s.version"
if [[ -z "${APP_VERSION:-}" ]]; then
  if [[ "$COMMAND" =~ ^(push|deploy|bundle)$ && -s "$VERSION_FILE" ]]; then
    APP_VERSION="$(cat "$VERSION_FILE")"
  else
    APP_VERSION="$(app_version)"
  fi
fi

ssh_vps() {
  local cmd="$1"
  ssh -o StrictHostKeyChecking=accept-new "$VPS_USER@$VPS_IP" "bash -lc $(printf %q "$cmd")"
}

# kubectl on the VPS: plain kubectl if bart has a kubeconfig, else sudo k3s kubectl.
KUBECTL_VPS='$(command -v kubectl >/dev/null 2>&1 && echo kubectl || echo "sudo k3s kubectl")'
kubectl_vps() {
  local args="$1"
  ssh_vps "$KUBECTL_VPS $args"
}

check_build_deps() {
  command -v podman >/dev/null 2>&1 || { echo "podman not found"; exit 1; }
}

check_remote_deps() {
  command -v ssh >/dev/null 2>&1 || { echo "ssh not found"; exit 1; }
}

# -----------------------------------------------------------------------------
# Secrets
# -----------------------------------------------------------------------------
ensure_secrets() {
  # The server cert only has to satisfy cloudflared (origin), so the default SANs
  # (beegit-server, *.svc, localhost) are enough; the public certificate for
  # beegit.hideterms.com is Cloudflare's.
  "$ROOT_DIR/dev/gen-secrets.sh" "$STATE_DIR"
}

need_state() {
  local f
  for f in "${STATE_FILES[@]}"; do
    [[ -s "$STATE_DIR/$f" ]] || {
      echo "missing deploy/k3s/state/$f — run: ./scripts/deploy-k3s.sh secrets"
      exit 1
    }
  done
}

# -----------------------------------------------------------------------------
# Build / push
# -----------------------------------------------------------------------------
build_image() {
  echo "==> Building $IMAGE:$APP_VERSION"
  echo "    (multi-stage: cargo build --release -> debian slim, ~10 min cold)"
  podman build \
    --pull=newer \
    -t "$IMAGE:latest" \
    -t "$IMAGE:$APP_VERSION" \
    -f "$ROOT_DIR/Dockerfile" \
    "$ROOT_DIR"
  mkdir -p "$(dirname "$VERSION_FILE")"
  echo "$APP_VERSION" > "$VERSION_FILE"
}

push_image() {
  echo "==> Logging into $REGISTRY"
  if [[ -n "${REGISTRY_USER:-}" && -n "${REGISTRY_PASSWORD:-}" ]]; then
    podman login -u "$REGISTRY_USER" -p "$REGISTRY_PASSWORD" "$REGISTRY"
  else
    podman login "$REGISTRY"
  fi

  echo "==> Pushing $IMAGE"
  podman push "$IMAGE:$APP_VERSION"
  podman push "$IMAGE:latest"
}

# -----------------------------------------------------------------------------
# Deploy
# -----------------------------------------------------------------------------
# Assemble a self-contained kustomization: manifests + config template + secrets.
# (kustomize refuses files outside its root, and secrets must not be scp'd to a
# permanent directory on the VPS.)
make_bundle() {
  local out="$1"
  mkdir -p "$out/bundle" "$out/state"
  cp "$K8S_DIR"/*.yaml "$out/"
  cp "$ROOT_DIR/config/beegit-server.toml" "$out/bundle/"
  local f
  for f in "${STATE_FILES[@]}"; do cp "$STATE_DIR/$f" "$out/state/"; done
  sed -i "s|newTag: .*|newTag: \"$APP_VERSION\"|" "$out/kustomization.yaml"
}

# Copy the existing acr-secret from a namespace that has one into beegit.
# Idempotent — does nothing if it's already there.
ensure_acr_secret() {
  if kubectl_vps "-n $NAMESPACE get secret acr-secret >/dev/null 2>&1"; then
    return 0
  fi

  local src
  for src in beedocs beehosting aidbooks sqail fietsloire; do
    if kubectl_vps "-n $src get secret acr-secret >/dev/null 2>&1"; then
      echo "==> $NAMESPACE/acr-secret missing; copying from $src/acr-secret"
      ssh_vps "K=$KUBECTL_VPS; \$K -n $src get secret acr-secret -o yaml \
        | sed -e '/namespace:/d' -e '/resourceVersion:/d' -e '/uid:/d' -e '/creationTimestamp:/d' \
        | \$K -n $NAMESPACE apply -f -"
      return 0
    fi
  done

  echo ""
  echo "ERROR: no source acr-secret found (looked in beedocs, beehosting, aidbooks, sqail, fietsloire)."
  echo "       Create it manually:"
  echo "         kubectl -n $NAMESPACE create secret docker-registry acr-secret \\"
  echo "           --docker-server=$REGISTRY \\"
  echo "           --docker-username=<acr-user> \\"
  echo "           --docker-password=<acr-token>"
  exit 1
}

deploy_manifests() {
  need_state
  echo "==> Deploying BeeGit $APP_VERSION to $VPS_USER@$VPS_IP (namespace: $NAMESPACE)"

  # 1. Namespace must exist before the pull secret can be copied into it.
  ssh_vps "$KUBECTL_VPS apply -f -" < "$K8S_DIR/namespace.yaml"

  # 2. ImagePullSecret — copy from a namespace that already has it.
  ensure_acr_secret

  # 3. Everything else, from a temporary bundle that is deleted afterwards.
  local tmp
  tmp="$(mktemp -d)"
  make_bundle "$tmp"
  tar -C "$tmp" -czf - . | ssh -o StrictHostKeyChecking=accept-new "$VPS_USER@$VPS_IP" \
    "bash -lc $(printf %q "set -e; d=\$(mktemp -d); trap 'rm -rf \$d' EXIT; tar -xzf - -C \$d; $KUBECTL_VPS apply -k \$d")"
  rm -rf "$tmp"

  # 4. Wait for the backends and the server. The image tag changes with every
  #    commit, so the server rolls out by itself; no restart needed.
  kubectl_vps "-n $NAMESPACE rollout status statefulset/beegit-cockroach --timeout=300s"
  kubectl_vps "-n $NAMESPACE rollout status statefulset/beegit-minio --timeout=300s"
  kubectl_vps "-n $NAMESPACE rollout status deployment/beegit-server --timeout=300s"

  echo ""
  echo "Deployed BeeGit $APP_VERSION"
  echo "  • gRPC (origin):  https://$VPS_IP:$NODE_PORT  (private CA: deploy/k3s/state/ca.pem)"
  echo "  • Public:         $PUBLIC_ENDPOINT  (via Cloudflare Tunnel)"
  echo ""
  tunnel_info
  echo "  Log in:  ./scripts/deploy-k3s.sh login"
  echo "  Test:    ./scripts/deploy-k3s.sh smoke"
}

tunnel_info() {
  cat <<EOF
  Cloudflare Tunnel — ingress rule for the tunnel config (cloudflared on the VPS):
    - hostname: $PUBLIC_HOST
      service: https://localhost:$NODE_PORT
      originRequest:
        http2Origin: true     # gRPC needs HTTP/2 to the origin
        noTLSVerify: true     # origin cert is signed by BeeGit's private CA
  Dashboard: enable gRPC for the zone (Network → gRPC), and keep Cloudflare Access
  off this hostname — the beegit CLI authenticates with its own tokens.

EOF
}

# -----------------------------------------------------------------------------
# Status / logs / client helpers
# -----------------------------------------------------------------------------
status() {
  kubectl_vps "-n $NAMESPACE get pods,svc,deploy,sts,pvc"
}

logs() {
  echo "==> beegit-server (last 80 lines)"
  kubectl_vps "-n $NAMESPACE logs deployment/beegit-server --tail=80" || true
}

shell() {
  echo "==> Opening a shell in the beegit-server pod"
  ssh -t -o StrictHostKeyChecking=accept-new "$VPS_USER@$VPS_IP" \
    "kubectl -n $NAMESPACE exec -it deployment/beegit-server -- bash || sudo k3s kubectl -n $NAMESPACE exec -it deployment/beegit-server -- bash"
}

login_info() {
  need_state
  cat <<EOF
export BEEGIT_ENDPOINT=$PUBLIC_ENDPOINT
unset BEEGIT_CA_FILE   # Cloudflare's public certificate; no private CA needed
BEEGIT_SERVICE_SECRET="\$(cat $STATE_DIR/admin.secret)" beegit login --service admin
beegit whoami
EOF
}

smoke() {
  need_state
  BEEGIT_ENDPOINT="$PUBLIC_ENDPOINT" BEEGIT_CA_FILE="" \
  BEEGIT_SERVICE_SECRET="$(cat "$STATE_DIR/admin.secret")" \
    "$ROOT_DIR/dev/smoke.sh"
}

# -----------------------------------------------------------------------------
# main
# -----------------------------------------------------------------------------
main() {
  case "$COMMAND" in
    all)
      check_build_deps
      check_remote_deps
      echo "Deploying BeeGit $APP_VERSION to $VPS_USER@$VPS_IP"
      ensure_secrets
      build_image
      push_image
      deploy_manifests
      status
      ;;
    build)   check_build_deps; build_image ;;
    push)    check_build_deps; push_image ;;
    deploy)  check_remote_deps; deploy_manifests ;;
    status)  check_remote_deps; status ;;
    logs)    check_remote_deps; logs ;;
    shell)   check_remote_deps; shell ;;
    secrets) ensure_secrets ;;
    login)   login_info ;;
    smoke)   smoke ;;
    tunnel)  tunnel_info ;;
    bundle)  need_state; [[ -n "${2:-}" ]] || { echo "usage: $0 bundle DIR"; exit 1; }
             make_bundle "$2"; echo "bundle written to $2" ;;
    *)
      echo "Unknown command: $COMMAND"
      echo "Usage: $0 [all|build|push|deploy|status|logs|shell|secrets|login|smoke|tunnel|bundle]"
      exit 1
      ;;
  esac
}

main "$@"
