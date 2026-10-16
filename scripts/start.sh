#!/usr/bin/env bash
# Start BeeGit on this machine: CockroachDB + MinIO in containers, plus beegit-server.
#
#   scripts/start.sh                start (server in a container) and print how to connect
#   scripts/start.sh --native       run beegit-server from source (release build) instead
#   scripts/start.sh --smoke        also run the end-to-end smoke test once it is up
#   scripts/start.sh --stop         stop everything (data is kept)
#   scripts/start.sh --reset        stop everything and delete all data
#   scripts/start.sh --status       show what is running
#   scripts/start.sh --logs         follow the server log
#
# Uses Docker when its daemon is reachable, else rootless Podman (its user socket is started
# when needed). Secrets are generated on first run into dev/state (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
STATE="$ROOT/dev/state"
PIDFILE="$STATE/server.pid"
LOGFILE="$STATE/server.log"
COMPOSE_FILE="docker/compose.dev.yml"

MODE=container; SMOKE=0; ACTION=start
for arg in "$@"; do
  case "$arg" in
    --native) MODE=native ;;
    --smoke) SMOKE=1 ;;
    --stop) ACTION=stop ;;
    --reset) ACTION=reset ;;
    --status) ACTION=status ;;
    --logs) ACTION=logs ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "start.sh: unknown option $arg (see --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;33m🐝 %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mstart.sh: %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "'$1' is required ($2)"; }

# ---- container engine --------------------------------------------------------------------------
pick_engine() {
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    ENGINE=docker; export BEEGIT_UID; BEEGIT_UID="$(id -u)"; export BEEGIT_GID; BEEGIT_GID="$(id -g)"
  elif command -v podman >/dev/null; then
    ENGINE=podman
    # Rootless Podman maps your uid to root inside the container.
    export BEEGIT_UID=0 BEEGIT_GID=0
    if [ ! -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock" ]; then
      say "starting the Podman user socket"
      systemctl --user start podman.socket || die "could not start podman.socket"
    fi
  else
    die "Docker or Podman is required"
  fi
  COMPOSE=("$ENGINE" compose -f "$COMPOSE_FILE")
}

native_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

stop_native() {
  if native_running; then
    say "stopping native beegit-server (pid $(cat "$PIDFILE"))"
    kill "$(cat "$PIDFILE")" || true
    for _ in $(seq 1 20); do native_running || break; sleep 0.5; done
  fi
  rm -f "$PIDFILE"
}

wait_ready() {
  say "waiting for the server to become ready"
  for _ in $(seq 1 90); do
    if curl -fsS http://127.0.0.1:9464/readyz >/dev/null 2>&1; then return 0; fi
    if [ "$MODE" = native ] && ! native_running; then
      tail -n 30 "$LOGFILE" >&2; die "beegit-server exited; log above ($LOGFILE)"
    fi
    sleep 1
  done
  die "server not ready after 90s (try scripts/start.sh --logs)"
}

# ---- actions -----------------------------------------------------------------------------------
case "$ACTION" in
  stop|reset)
    pick_engine
    stop_native
    if [ "$ACTION" = reset ]; then
      say "stopping containers and deleting all data"
      "${COMPOSE[@]}" --profile server down -v
    else
      say "stopping containers (data is kept)"
      "${COMPOSE[@]}" --profile server down
    fi
    exit 0
    ;;
  status)
    pick_engine
    "${COMPOSE[@]}" --profile server ps
    if native_running; then echo "native beegit-server: running (pid $(cat "$PIDFILE"), log $LOGFILE)"; fi
    if curl -fsS http://127.0.0.1:9464/readyz 2>/dev/null; then :; else echo "server: not ready"; fi
    exit 0
    ;;
  logs)
    if native_running; then exec tail -f "$LOGFILE"; fi
    pick_engine
    exec "${COMPOSE[@]}" --profile server logs -f beegit-server
    ;;
esac

# ---- start -------------------------------------------------------------------------------------
need openssl "to generate local certificates and keys"
need curl "for readiness checks"
need cargo "install Rust via https://rustup.rs"
need protoc "install the protobuf compiler (e.g. pacman -S protobuf / apt install protobuf-compiler)"
pick_engine
say "container engine: $ENGINE"

dev/gen-secrets.sh

say "building the BeeGit binaries (release; the first build takes several minutes)"
cargo build --release --bin beegit --bin beegit-import --bin beegit-daemon \
  $([ "$MODE" = native ] && echo --bin beegit-server)

if [ "$MODE" = native ]; then
  # Free the ports if the server container from a previous container-mode run is up.
  "${COMPOSE[@]}" --profile server stop beegit-server >/dev/null 2>&1 || true
  say "starting CockroachDB and MinIO"
  "${COMPOSE[@]}" up -d --wait cockroach minio
  stop_native
  say "starting beegit-server natively (log: $LOGFILE)"
  (
    # shellcheck source=dev/env.sh
    source dev/env.sh
    nohup target/release/beegit-server config/beegit-server.toml >"$LOGFILE" 2>&1 &
    echo $! >"$PIDFILE"
  )
else
  stop_native
  say "building the image and starting CockroachDB, MinIO and beegit-server"
  "${COMPOSE[@]}" --profile server up -d --build --wait
fi
wait_ready

if [ "$SMOKE" = 1 ]; then
  say "running the smoke test"
  dev/smoke.sh
fi

cat <<EOF

$(say "BeeGit is running")
  gRPC endpoint     https://localhost:7443   (CA: dev/state/ca.pem)
  health/metrics    http://localhost:9464/readyz · /metrics
  CockroachDB UI    http://localhost:8080
  MinIO console     http://localhost:9001   (minioadmin / minioadmin)

  Use it:
    source dev/env.sh
    beegit login --service admin
    beegit checkout main ~/work/demo

  scripts/start.sh --status | --logs | --stop | --reset
EOF
