# Source this file to run the BeeGit binaries natively against the Docker dev backends:
#   source dev/env.sh
# Server-side variables (used by config/beegit-server.toml) and client-side variables.
_BEEGIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
_BEEGIT_STATE="$_BEEGIT_ROOT/dev/state"

# ---- server ----
export BEEGIT_LISTEN="127.0.0.1:7443"
export BEEGIT_METRICS_LISTEN="127.0.0.1:9464"
export BEEGIT_REPO="monorepo"
export BEEGIT_TLS_CERT="$_BEEGIT_STATE/tls.crt"
export BEEGIT_TLS_KEY="$_BEEGIT_STATE/tls.key"
export BEEGIT_SIGNING_KEY="$_BEEGIT_STATE/signing.ed25519.pem"
export BEEGIT_POLICY_PATH="$_BEEGIT_STATE/acl.toml"
export BEEGIT_DB_URL="postgresql://root@localhost:26257/defaultdb?sslmode=disable"
export BEEGIT_S3_ENDPOINT="http://localhost:9000"
export BEEGIT_S3_BUCKET="beegit"
export BEEGIT_GITHUB_CLIENT_ID="${BEEGIT_GITHUB_CLIENT_ID:-not-configured}"
export BEEGIT_GITHUB_CLIENT_SECRET="${BEEGIT_GITHUB_CLIENT_SECRET:-}"
export BEEGIT_LOG_FORMAT="text"
export AWS_ACCESS_KEY_ID="minioadmin"
export AWS_SECRET_ACCESS_KEY="minioadmin"
export AWS_REGION="us-east-1"
if [ -f "$_BEEGIT_STATE/secrets.env" ]; then
  set -a; . "$_BEEGIT_STATE/secrets.env"; set +a
fi

# ---- client ----
export BEEGIT_ENDPOINT="https://localhost:7443"
export BEEGIT_CA_FILE="$_BEEGIT_STATE/ca.pem"
export BEEGIT_SERVICE_NAME="admin"
if [ -f "$_BEEGIT_STATE/admin.secret" ]; then
  BEEGIT_SERVICE_SECRET="$(cat "$_BEEGIT_STATE/admin.secret")"
  export BEEGIT_SERVICE_SECRET
fi
export PATH="$_BEEGIT_ROOT/target/release:$_BEEGIT_ROOT/target/debug:$PATH"
unset _BEEGIT_ROOT _BEEGIT_STATE
