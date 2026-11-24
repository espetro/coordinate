#!/bin/sh
# Build the scriptc binaries. Needs deps installed (pnpm install) and scriptc 0.4.16 on PATH.
# usage: build-bin.sh [outdir]
# Linux binaries build natively; macOS binaries cross-compile with zig
# (SCRIPTC_TARGET, @scriptc/runtime-darwin-arm64 dev dependency) and are not
# runnable on the build host, so they get no smoke test here.
set -eu
cd "$(dirname "$0")/.."
OUT="${1:-dist}"
VERSION="$(node -p "require('./package.json').version")"
mkdir -p "$OUT"
COMMON="--npm-static @cutils/sqlite,@cutils/cli --ffi node_modules/@cutils/sqlite/ffi.json --no-keep-llvm"
SQLITE=node_modules/@cutils/sqlite

# Stamp the real release version into src/version.ts so the binary's doctor
# report and version strings match the artifact name.
sed -i.bak -E "s/^export const CLI_VERSION = .*$/export const CLI_VERSION = \"$VERSION\";/" src/version.ts
rm -f src/version.ts.bak

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    scriptc build src/main-elf.ts $COMMON -o "$OUT/coordinate-$VERSION-linux-x64-gnu"
    scriptc build src/main-elf.ts $COMMON --static -o "$OUT/coordinate-$VERSION-linux-x64-musl"
    ;;
  Darwin-arm64)
    scriptc build src/main-elf.ts $COMMON -o "$OUT/coordinate-$VERSION-darwin-arm64"
    scriptc build src/main-elf.ts $COMMON -o "$OUT/coordinate-$VERSION-darwin-x64" &
    wait
    ;;
  *)
    echo "unsupported build host: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

echo "built into $OUT:"
ls -la "$OUT"
# checksums, so the local and CI artifacts are interchangeable
(cd "$OUT" && sha256sum -- ./* | tee SHA256SUMS)
