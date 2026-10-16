#!/usr/bin/env bash
# Generate everything a BeeGit server needs that must not be committed:
#   - a private CA and a server TLS certificate (ca.pem, tls.crt, tls.key)
#   - an Ed25519 token-signing key (signing.ed25519.pem, PKCS#8 PEM)
#   - a random secret for the `admin` service principal (admin.secret) and its SHA-256
#   - an access policy (acl.toml) granting `service:admin` full access
#   - secrets.env with the values the server config reads through `$NAME`: the admin secret
#     hash (always rewritten) plus BEEGIT_GITHUB_CLIENT_ID / BEEGIT_GITHUB_CLIENT_SECRET for
#     GitHub login (added once; edit them in place, later runs keep your values)
#   - s3.env with random object-store credentials (used by the K3s MinIO)
#
#   dev/gen-secrets.sh [OUT_DIR]          default OUT_DIR: dev/state
#
# Environment:
#   BEEGIT_TLS_SANS   extra comma-separated SANs for the server certificate, e.g.
#                     "DNS:git.example.com,IP:212.47.77.32" (localhost, 127.0.0.1 and
#                     beegit-server are always included)
#   BEEGIT_ADMINS     extra comma-separated admin principals for acl.toml, e.g. "github:bart"
#   FORCE=1           regenerate files that already exist
#
# Existing files are kept unless FORCE=1, so re-running is safe and keeps tokens valid.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-dev/state}"
mkdir -p "$OUT"
chmod 700 "$OUT"

need() { command -v "$1" >/dev/null || { echo "gen-secrets: '$1' is required" >&2; exit 1; }; }
need openssl

fresh() { [ "${FORCE:-0}" = 1 ] || [ ! -s "$1" ]; }

# ---- CA ---------------------------------------------------------------------------------------
if fresh "$OUT/ca.pem"; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=BeeGit Dev CA" -keyout "$OUT/ca.key" -out "$OUT/ca.pem" 2>/dev/null
  echo "created $OUT/ca.pem"
fi

# ---- server certificate -----------------------------------------------------------------------
SANS="DNS:localhost,IP:127.0.0.1,DNS:beegit-server,DNS:beegit-server.beegit.svc,DNS:beegit-server.beegit.svc.cluster.local"
if [ -n "${BEEGIT_TLS_SANS:-}" ]; then SANS="$SANS,$BEEGIT_TLS_SANS"; fi
if fresh "$OUT/tls.crt" || [ "$(cat "$OUT/tls.sans" 2>/dev/null)" != "$SANS" ]; then
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -subj "/CN=beegit-server" -keyout "$OUT/tls.key" -out "$OUT/tls.csr" 2>/dev/null
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' "$SANS" \
    > "$OUT/tls.ext"
  openssl x509 -req -in "$OUT/tls.csr" -CA "$OUT/ca.pem" -CAkey "$OUT/ca.key" -CAcreateserial \
    -days 825 -extfile "$OUT/tls.ext" -out "$OUT/tls.crt" 2>/dev/null
  rm -f "$OUT/tls.csr" "$OUT/tls.ext" "$OUT/ca.srl"
  echo "$SANS" > "$OUT/tls.sans"
  echo "created $OUT/tls.crt ($SANS)"
fi

# ---- token signing key ------------------------------------------------------------------------
if fresh "$OUT/signing.ed25519.pem"; then
  openssl genpkey -algorithm ed25519 -out "$OUT/signing.ed25519.pem"
  echo "created $OUT/signing.ed25519.pem"
fi

# ---- admin service principal ------------------------------------------------------------------
if fresh "$OUT/admin.secret"; then
  openssl rand -hex 32 | tr -d '\n' > "$OUT/admin.secret"
  echo "created $OUT/admin.secret"
fi
ADMIN_SHA256="$(printf '%s' "$(cat "$OUT/admin.secret")" | openssl dgst -sha256 -r | cut -d' ' -f1)"

# ---- access policy ----------------------------------------------------------------------------
if fresh "$OUT/acl.toml"; then
  ADMINS='"service:admin"'
  IFS=',' read -ra extra <<< "${BEEGIT_ADMINS:-}"
  for p in "${extra[@]}"; do [ -n "$p" ] && ADMINS="$ADMINS, \"$p\""; done
  cat > "$OUT/acl.toml" <<EOF
# BeeGit access policy (SPEC 6.2). Hot-reloaded by the server when edited.
version = 1

[groups]
admins = [$ADMINS]
eng = ["group:admins"]

[[paths]]
prefix = "/"
read = ["group:eng"]
write = ["group:eng"]

[refs."main"]
update = ["group:eng"]
force = ["group:admins"]

[refs."*"]
update = ["group:eng"]
force = ["group:admins"]

[admin]
redact = ["group:admins"]
purge = ["group:admins"]
refs = ["group:admins"]
EOF
  echo "created $OUT/acl.toml"
fi

# ---- object store credentials (used by the K3s MinIO; the Compose stack uses minioadmin) ------
if fresh "$OUT/s3.env"; then
  printf 'AWS_ACCESS_KEY_ID=beegit\nAWS_SECRET_ACCESS_KEY=%s\n' "$(openssl rand -hex 24)" > "$OUT/s3.env"
  echo "created $OUT/s3.env"
fi

# ---- env file for the server config ------------------------------------------------------------
touch "$OUT/secrets.env"
set_env() { # KEY VALUE: replace the line for KEY
  grep -v "^$1=" "$OUT/secrets.env" > "$OUT/secrets.env.tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$OUT/secrets.env.tmp"
  mv "$OUT/secrets.env.tmp" "$OUT/secrets.env"
}
default_env() { # KEY VALUE: add KEY only when missing
  grep -q "^$1=" "$OUT/secrets.env" || printf '%s=%s\n' "$1" "$2" >> "$OUT/secrets.env"
}
set_env BEEGIT_ADMIN_SECRET_SHA256 "$ADMIN_SHA256"
# GitHub OAuth App (device flow for the CLI, web flow for the browser UI). Empty secret =
# browser login off.
default_env BEEGIT_GITHUB_CLIENT_ID not-configured
default_env BEEGIT_GITHUB_CLIENT_SECRET ""
chmod 600 "$OUT"/*.key "$OUT"/*.pem "$OUT/admin.secret" "$OUT/secrets.env" "$OUT/s3.env" 2>/dev/null || true
# The container runs as a non-root user and reads these through a bind mount.
chmod 644 "$OUT/ca.pem" "$OUT/tls.crt" "$OUT/acl.toml"
echo "secrets ready in $OUT"
