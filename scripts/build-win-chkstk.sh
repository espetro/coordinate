#!/bin/sh
# Build the minimal x86_64 Windows stack probe (__chkstk) as a COFF object.
# zig's mingw runtime does not export __chkstk, which the Windows x64 ABI
# needs for stack frames larger than one page (Effect's fiber runtime has
# them), so the link fails with "undefined symbol: __chkstk". The MSVC CRT
# provides it; scripts/win/chkstk.c is the same routine for the mingw target.
set -e
cd "$(dirname "$0")/.."
ZIG=${ZIG:-zig}
mkdir -p scripts/win
"$ZIG" cc -target x86_64-windows-gnu -O2 -c scripts/win/chkstk.c -o scripts/win/chkstk.o
echo "wrote scripts/win/chkstk.o (COFF x86_64)"
