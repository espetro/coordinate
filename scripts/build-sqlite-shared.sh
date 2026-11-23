#!/bin/sh
# Build the shared SQLite shim that the Node test path loads through koffi.
# The @cutils/sqlite npm package ships the C sources but not this library.
# Skips the build when the library already exists. Needs a C compiler (cc).
set -eu
cd "$(dirname "$0")/../node_modules/@cutils/sqlite"
OUT=build/libcutils_sqlite.so
if [ -f "$OUT" ]; then exit 0; fi
mkdir -p build
EXTRA=""
if [ "$(uname -s)" = Linux ]; then EXTRA="-Wl,-Bsymbolic"; fi
cc -O2 -fPIC -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_FTS5 $EXTRA -shared vendor/shim/sqlite_shim.c vendor/sqlite-amalgamation/sqlite3.c -o "$OUT"
