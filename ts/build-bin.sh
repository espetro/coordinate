#!/bin/sh
# Build the scriptc binaries for the host platform. Run from ts/ with deps installed.
# usage: build-bin.sh [outdir]
set -eu
cd "$(dirname "$0")"
OUT="${1:-dist}"
mkdir -p "$OUT"
COMMON="--npm-static @cutils/sqlite,@cutils/cli --ffi node_modules/@cutils/sqlite/ffi.json --no-keep-llvm"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    scriptc build main-elf.ts $COMMON -o "$OUT/coordinate-v0.1.0-linux-x64-gnu"
    scriptc build main-elf.ts $COMMON --static -o "$OUT/coordinate-v0.1.0-linux-x64-musl"
    ;;
  Linux-aarch64)
    scriptc build main-elf.ts $COMMON --static -o "$OUT/coordinate-v0.1.0-linux-arm64-musl"
    ;;
  Darwin-arm64)
    scriptc build main-elf.ts $COMMON -o "$OUT/coordinate-v0.1.0-darwin-arm64"
    ;;
  Darwin-x86_64)
    scriptc build main-elf.ts $COMMON -o "$OUT/coordinate-v0.1.0-darwin-x64"
    ;;
  *)
    echo "unsupported platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac
echo "built into $OUT:"
ls -la "$OUT"
# checksums, so the local and CI artifacts are interchangeable
(cd "$OUT" && sha256sum -- ./* | tee SHA256SUMS)
