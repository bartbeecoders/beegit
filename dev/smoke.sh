#!/usr/bin/env bash
# End-to-end smoke test against a running BeeGit server:
# login → whoami → checkout main → commit → land → log → cat → sparse checkout.
#
#   dev/smoke.sh                       local server (make dev-up or make run-server)
#   BEEGIT_ENDPOINT=https://host:7443 BEEGIT_CA_FILE=ca.pem \
#   BEEGIT_SERVICE_SECRET=... dev/smoke.sh     any other server (BEEGIT_CA_FILE= for public certs)
#
# Uses a throw-away HOME so your real ~/.config/beegit credentials are untouched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Defaults for the local stack; anything already exported wins.
: "${BEEGIT_ENDPOINT:=https://localhost:7443}"
# An explicitly empty BEEGIT_CA_FILE means "use the system roots" (e.g. behind Cloudflare).
: "${BEEGIT_CA_FILE=$ROOT/dev/state/ca.pem}"
: "${BEEGIT_SERVICE_NAME:=admin}"
if [ -z "${BEEGIT_SERVICE_SECRET:-}" ]; then
  BEEGIT_SERVICE_SECRET="$(cat "$ROOT/dev/state/admin.secret")"
fi
export BEEGIT_ENDPOINT BEEGIT_SERVICE_SECRET
if [ -n "$BEEGIT_CA_FILE" ]; then export BEEGIT_CA_FILE; else unset BEEGIT_CA_FILE; fi

BIN="${BEEGIT_BIN:-}"
if [ -z "$BIN" ]; then
  for c in "$ROOT/target/release/beegit" "$ROOT/target/debug/beegit"; do
    [ -x "$c" ] && { BIN="$c"; break; }
  done
fi
[ -n "$BIN" ] || { echo "smoke: build the CLI first (make build)" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config"
mkdir -p "$HOME"
bg() { echo "+ beegit $*" >&2; "$BIN" "$@"; }

bg login --service "$BEEGIT_SERVICE_NAME"
bg whoami

bg checkout main "$WORK/wc"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$WORK/wc/smoke/docs"
echo "hello from the BeeGit smoke test at $stamp" > "$WORK/wc/smoke/hello.txt"
echo "# docs" > "$WORK/wc/smoke/docs/README.md"
bg -C "$WORK/wc" status
bg -C "$WORK/wc" commit -m "smoke: $stamp"
bg -C "$WORK/wc" land --ref main
bg log --rev main --limit 10

got="$(bg cat "main:smoke/hello.txt")"
[ "$got" = "hello from the BeeGit smoke test at $stamp" ] || { echo "smoke: cat mismatch: $got" >&2; exit 1; }

bg checkout main "$WORK/sparse" --sparse smoke/docs
[ -f "$WORK/sparse/smoke/docs/README.md" ] || { echo "smoke: sparse file missing" >&2; exit 1; }
[ ! -e "$WORK/sparse/smoke/hello.txt" ] || { echo "smoke: sparse checkout leaked a file" >&2; exit 1; }

echo "smoke: OK"
