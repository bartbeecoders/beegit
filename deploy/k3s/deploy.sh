#!/usr/bin/env bash
# Build the BeeGit image, ship it to the K3s VPS and apply the manifests.
#
#   deploy/k3s/deploy.sh            build + import image + apply + wait for rollout
#   deploy/k3s/deploy.sh apply      apply manifests only (image already on the node)
#   deploy/k3s/deploy.sh status     pods, services and recent server logs
#   deploy/k3s/deploy.sh bundle DIR write the self-contained kustomization to DIR (inspection)
#
# Environment (defaults in brackets):
#   BEEGIT_SSH      ssh target                    [bart@212.47.77.32]
#   KUBECTL         kubectl on the VPS            [sudo k3s kubectl]
#   CTR             image import on the VPS       [sudo k3s ctr images import -]
#   CONTAINER       local image builder           [docker if reachable, else podman]
#   TAG             image tag                     [git short sha, else timestamp]
#   BEEGIT_REMOTE   run "remote" commands with this prefix instead of ssh; it receives one
#                   shell-command argument. Used to test against a local K3s container:
#                   BEEGIT_REMOTE="podman exec -i beegit-k3s sh -c" KUBECTL=kubectl \
#                   CTR="ctr images import -" deploy/k3s/deploy.sh
#
# No registry is needed: the image is streamed with `save | ssh ... ctr images import`.
# Secrets come from deploy/k3s/state (make k3s-secrets). They travel over SSH into a
# temporary directory on the VPS that is removed right after `kubectl apply`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SSH_TARGET="${BEEGIT_SSH:-bart@212.47.77.32}"
KUBECTL="${KUBECTL:-sudo k3s kubectl}"
CTR="${CTR:-sudo k3s ctr images import -}"
if [ -z "${CONTAINER:-}" ]; then
  if docker info >/dev/null 2>&1; then CONTAINER=docker; else CONTAINER=podman; fi
fi
TAG="${TAG:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
IMAGE="beegit.local/beegit:$TAG"
CMD="${1:-deploy}"
STATE_FILES=(acl.toml tls.crt tls.key signing.ed25519.pem secrets.env s3.env)

remote() {
  if [ -n "${BEEGIT_REMOTE:-}" ]; then $BEEGIT_REMOTE "$*"; else ssh "$SSH_TARGET" "$@"; fi
}

need_state() {
  for f in "${STATE_FILES[@]}"; do
    [ -s "$HERE/state/$f" ] || {
      echo "deploy: missing deploy/k3s/state/$f" >&2
      echo "        run: BEEGIT_TLS_SANS=IP:212.47.77.32 make k3s-secrets" >&2
      exit 1
    }
  done
}

# Assemble a self-contained kustomization (kustomize refuses files outside its root).
bundle() {
  local out="$1"
  mkdir -p "$out/bundle" "$out/state"
  cp "$HERE"/*.yaml "$out/"
  cp "$ROOT/config/beegit-server.toml" "$out/bundle/"
  for f in "${STATE_FILES[@]}"; do cp "$HERE/state/$f" "$out/state/"; done
  sed -i "s/newTag: .*/newTag: \"$TAG\"/" "$out/kustomization.yaml"
}

apply() {
  need_state
  local tmp
  tmp="$(mktemp -d)"
  bundle "$tmp"
  echo "deploy: applying manifests (image $IMAGE) on $SSH_TARGET"
  tar -C "$tmp" -czf - . | remote "set -e; d=\$(mktemp -d); trap 'rm -rf \$d' EXIT; tar -xzf - -C \$d; $KUBECTL apply -k \$d"
  rm -rf "$tmp"
  remote "$KUBECTL -n beegit rollout status statefulset/beegit-cockroach --timeout=300s && \
          $KUBECTL -n beegit rollout status statefulset/beegit-minio --timeout=300s && \
          $KUBECTL -n beegit rollout status deployment/beegit-server --timeout=300s"
  echo "deploy: done. Endpoint: https://${SSH_TARGET#*@}:7443 (CA: deploy/k3s/state/ca.pem)"
}

case "$CMD" in
  deploy)
    need_state
    echo "deploy: building $IMAGE with $CONTAINER"
    "$CONTAINER" build -t "$IMAGE" "$ROOT"
    echo "deploy: importing image on $SSH_TARGET (this streams ~100 MB)"
    "$CONTAINER" save "$IMAGE" | gzip -1 | remote "gunzip | $CTR"
    apply
    ;;
  apply) apply ;;
  status)
    remote "$KUBECTL -n beegit get pods,svc,pvc -o wide; echo; $KUBECTL -n beegit logs deploy/beegit-server --tail=30"
    ;;
  bundle)
    need_state
    [ -n "${2:-}" ] || { echo "usage: deploy.sh bundle DIR" >&2; exit 2; }
    bundle "$2"
    echo "bundle written to $2"
    ;;
  *) sed -n '2,23p' "$0"; exit 2 ;;
esac
