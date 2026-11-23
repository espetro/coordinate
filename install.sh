#!/bin/sh
# Install a coordinate release binary into ~/.local/bin (or --prefix).
# Usage: install.sh [--prefix DIR] [--version vX.Y.Z]
# Requires: sh, curl (or wget), sha256sum (or shasum). No other dependencies.
set -eu

REPO="espetro/coordinate"
PREFIX="${COORDINATE_PREFIX:-$HOME/.local/bin}"
VERSION=""
BASE_URL="${COORDINATE_DOWNLOAD_URL:-https://github.com/$REPO/releases/download}"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    -h|--help)
      echo "usage: install.sh [--prefix DIR] [--version vX.Y.Z]"
      exit 0 ;;
    *) echo "install.sh: unknown option: $1" >&2; exit 2 ;;
  esac
done

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  Darwin-arm64) TARGET="darwin-arm64" ;;
  Darwin-x86_64) TARGET="darwin-x64" ;;
  Linux-x86_64)
    # musl static binary runs everywhere, including glibc systems, and
    # avoids loader version requirements; prefer it unless asked otherwise
    TARGET="${COORDINATE_TARGET:-linux-x64-musl}" ;;
  *) echo "install.sh: unsupported platform: $OS $ARCH" >&2; exit 1 ;;
esac

if [ -z "$VERSION" ]; then
  echo "install.sh: --version vX.Y.Z is required (no latest-release discovery without gh)"
  exit 2
fi

NAME="coordinate-${VERSION}-${TARGET}"
URL="$BASE_URL/$VERSION/$NAME"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "install.sh: need curl or wget" >&2; exit 1
  fi
}

echo "fetching $URL"
fetch "$URL" "$TMP/$NAME"
fetch "$URL.sha256" "$TMP/$NAME.sha256"

VERIFY="$(cd "$TMP" && sha256sum -c -- "$NAME.sha256" 2>/dev/null)" || VERIFY="$(cd "$TMP" && shasum -a 256 -c "$NAME.sha256")"
echo "${VERIFY:-checksum verified}"

mkdir -p "$PREFIX"
install -m 0755 "$TMP/$NAME" "$PREFIX/coordinate"
echo "installed: $PREFIX/coordinate"

"$PREFIX/coordinate" --help >/dev/null
echo "coordinate --help: ok (run '$PREFIX/coordinate stats' to use)"
