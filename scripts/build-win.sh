#!/bin/sh
# Cross-compile the coordinate CLI/daemon for Windows x64 from Linux.
# Requires: zig 0.14.1 (scriptc's "zig cc" driver; zig >= 0.15 dropped it),
# the @scriptc/runtime-win32-x64-msvc pack (devDependency, same version as scriptc),
# and a COFF build of @cutils/sqlite's static shim (see build-win-shim.sh).
set -e
cd "$(dirname "$0")/.."
ZIG=${ZIG:-zig}
OUT=${OUT:-dist/coordinate-windows-x64.exe}
export ZIG
# zig's mingw runtime does not export __chkstk, which the Windows x64 ABI
# requires for stack frames larger than one page (Effect's fiber runtime has
# them). Link a minimal probe implementation (scripts/win/chkstk.c, built by
# build-win-chkstk.sh) so lld-link resolves it.
if [ ! -f scripts/win/chkstk.o ]; then
  sh scripts/build-win-chkstk.sh
fi
mkdir -p "$(dirname "$OUT")"
exec env SCRIPTC_TARGET=x86_64-windows-gnu \
  SCRIPTC_LINKER="$PWD/scripts/zigcc-wrap" \
  SCRIPTC_EXTRA_OBJS="$PWD/scripts/win/chkstk.o" \
  scriptc build src/main-elf.ts \
  --npm-static effect,@cutils/sqlite,@cutils/cli \
  --ffi node_modules/@cutils/sqlite/ffi.json \
  -o "$OUT" "$@"
