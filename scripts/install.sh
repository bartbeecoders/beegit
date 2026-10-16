#!/bin/sh
# Install the BeeGit client tools (beegit, beegit-daemon, beegit-import).
#
#   curl -fsSL https://github.com/bartbeecoders/beegit/releases/latest/download/install.sh | sh
#
# Environment:
#   BEEGIT_VERSION   release to install, e.g. 0.1.0 (default: the latest release)
#   BEEGIT_PREFIX    install prefix (default: ~/.local -> ~/.local/bin, ~/.local/share/beegit)
#   BEEGIT_ARCHIVE   install from this local .tar.gz instead of downloading (testing, offline)
#   BEEGIT_REPO      GitHub repository (default: bartbeecoders/beegit)
#
# The download is verified against its published SHA-256 before anything is installed.
set -eu

REPO="${BEEGIT_REPO:-bartbeecoders/beegit}"
PREFIX="${BEEGIT_PREFIX:-$HOME/.local}"

say() { printf 'beegit-install: %s\n' "$*"; }
die() { printf 'beegit-install: error: %s\n' "$*" >&2; exit 1; }

target() {
  os="$(uname -s)"; arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) die "unsupported CPU architecture: $arch" ;;
  esac
  case "$os" in
    Linux) echo "$arch-unknown-linux-gnu" ;;
    Darwin) echo "$arch-apple-darwin" ;;
    *) die "unsupported OS: $os (BeeGit clients run on Linux and macOS)" ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else die "curl or wget is required"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -n "${BEEGIT_ARCHIVE:-}" ]; then
  [ -f "$BEEGIT_ARCHIVE" ] || die "no such archive: $BEEGIT_ARCHIVE"
  cp "$BEEGIT_ARCHIVE" "$TMP/beegit.tar.gz"
  if [ -f "$BEEGIT_ARCHIVE.sha256" ]; then
    want="$(cut -d' ' -f1 < "$BEEGIT_ARCHIVE.sha256")"
  else
    die "missing $BEEGIT_ARCHIVE.sha256"
  fi
else
  T="$(target)"
  if [ -n "${BEEGIT_VERSION:-}" ]; then
    base="https://github.com/$REPO/releases/download/v$BEEGIT_VERSION"
    name="beegit-$BEEGIT_VERSION-$T.tar.gz"
  else
    # The latest release's asset names carry the version; resolve it from the redirect.
    latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" \
      || die "cannot reach GitHub releases of $REPO"
    v="${latest##*/v}"
    [ -n "$v" ] && [ "$v" != "$latest" ] || die "no release found for $REPO"
    base="https://github.com/$REPO/releases/download/v$v"
    name="beegit-$v-$T.tar.gz"
  fi
  say "downloading $name"
  fetch "$base/$name" "$TMP/beegit.tar.gz" || die "download failed: $base/$name"
  fetch "$base/$name.sha256" "$TMP/sum" || die "checksum download failed"
  want="$(cut -d' ' -f1 < "$TMP/sum")"
fi

got="$(sha256 "$TMP/beegit.tar.gz")"
[ "$got" = "$want" ] || die "checksum mismatch (expected $want, got $got)"

tar -xzf "$TMP/beegit.tar.gz" -C "$TMP"
DIR="$(find "$TMP" -maxdepth 1 -type d -name 'beegit-*' | head -n 1)"
[ -n "$DIR" ] || die "unexpected archive layout"

mkdir -p "$PREFIX/bin" "$PREFIX/share/beegit"
for b in beegit beegit-daemon beegit-import; do
  install -m 0755 "$DIR/bin/$b" "$PREFIX/bin/$b"
done
cp "$DIR"/share/beegit/* "$PREFIX/share/beegit/"
say "installed $("$PREFIX/bin/beegit" --version) to $PREFIX/bin"

case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) say "add $PREFIX/bin to your PATH, e.g.: echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> ~/.profile" ;;
esac
cat <<EOF

Next steps:
  export BEEGIT_ENDPOINT=grpc-web+https://beegit.hideterms.com
  beegit login                      # GitHub device flow, or: beegit login --service NAME
  beegit checkout main ~/work/repo

Optional node daemon (shared cache), see $PREFIX/share/beegit/beegit-daemon.service.
EOF
