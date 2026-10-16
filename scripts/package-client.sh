#!/usr/bin/env bash
# Build the BeeGit client tools for one target and package them for distribution.
#
#   scripts/package-client.sh [TARGET]      default: the host target
#
# Writes dist/beegit-<version>-<target>.tar.gz and its .sha256. The archive contains
#   bin/beegit bin/beegit-daemon bin/beegit-import
#   share/beegit/beegit-daemon.service      (systemd user unit)
#   share/beegit/beegit-daemon.toml.example
#   LICENSE NOTICE README.md
# scripts/install.sh installs it; .github/workflows/release.yml runs this per platform.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
VERSION="$(sed -n '/^\[workspace.package\]/,/^\[/s/^version = "\(.*\)"/\1/p' Cargo.toml)"
NAME="beegit-$VERSION-$TARGET"
BINS=(beegit beegit-daemon beegit-import)

echo "package: building $NAME"
cargo build --release --locked --target "$TARGET" $(printf -- '--bin %s ' "${BINS[@]}")

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME/bin" "$STAGE/$NAME/share/beegit"
for b in "${BINS[@]}"; do
  install -m 0755 "target/$TARGET/release/$b" "$STAGE/$NAME/bin/$b"
done
install -m 0644 packaging/systemd/beegit-daemon.service packaging/beegit-daemon.toml.example \
  "$STAGE/$NAME/share/beegit/"
install -m 0644 LICENSE NOTICE README.md "$STAGE/$NAME/"

mkdir -p dist
tar -C "$STAGE" -czf "dist/$NAME.tar.gz" "$NAME"
( cd dist && if command -v sha256sum >/dev/null; then sha256sum "$NAME.tar.gz"; else shasum -a 256 "$NAME.tar.gz"; fi ) \
  > "dist/$NAME.tar.gz.sha256"
echo "package: dist/$NAME.tar.gz ($(du -h "dist/$NAME.tar.gz" | cut -f1))"
