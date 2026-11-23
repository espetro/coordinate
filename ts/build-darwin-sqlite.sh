#!/bin/sh
# Build the @cutils/sqlite static archive for darwin targets with zig.
# Cross-compilation needs the FFI archive built for the target; scriptc does
# not translate native inputs (docs/platforms, cross-target limits).
# usage: build-darwin-sqlite.sh [arm64|x64]
set -eu
cd "$(dirname "$0")/node_modules/@cutils/sqlite"
ARCH="${1:-arm64}"
case "$ARCH" in
  arm64) TARGET="aarch64-macos.14.0" ;;
  x64) TARGET="x86_64-macos.14.0" ;;
  *) echo "arch must be arm64 or x64" >&2; exit 1 ;;
esac
FLAGS="-O2 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_FTS5"
mkdir -p "build-$ARCH"
zig cc -target "$TARGET" $FLAGS -c vendor/shim/sqlite_shim.c -o "build-$ARCH/sqlite_shim.o"
zig cc -target "$TARGET" $FLAGS -c vendor/sqlite-amalgamation/sqlite3.c -o "build-$ARCH/sqlite3.o"
ar rcs "build-$ARCH/libsqlite3-shim.a" "build-$ARCH/sqlite_shim.o" "build-$ARCH/sqlite3.o"
echo "built build-$ARCH/libsqlite3-shim.a"
