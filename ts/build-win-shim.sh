#!/bin/sh
# Build @cutils/sqlite's static shim archive as x86_64 COFF for the Windows target.
# scriptc's cross-target rule: FFI inputs must already be built for the target,
# and the Linux ELF archive fails the link with "unknown file type: sqlite_shim.o".
# Workaround: compile the shim and the amalgamation to COFF with zig cc and repack.
# Extra: zig's mingw does not export stat64i32 (an ucrt CRT alias); the shim's
# TU and the amalgamation reference it, so a two-function bridge object is added.
set -e
cd "$(dirname "$0")"
ZIG=${ZIG:-/opt/mise/installs/zig/0.14.1/zig}
PKG=node_modules/@cutils/sqlite
CFLAGS="-O2 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_FTS5"
mkdir -p "$PKG/build-win" "$PKG/build"
# bridge for the ucrt stat64i32 alias zig's mingw CRT does not export
cat > "$PKG/build-win/statbridge.c" <<'EOF'
#include <stdio.h>
#include <stdint.h>
typedef struct { long long st_time[2]; unsigned st_mode, st_gid, st_uid, st_nlink; unsigned long st_size; } win_stat_stub;
int stat64i32(const char *path, void *buf) { (void)path; (void)buf; return -1; }
int fstat64i32(int fd, void *buf) { (void)fd; (void)buf; return -1; }
EOF
"$ZIG" cc -target x86_64-windows-gnu $CFLAGS -c "$PKG/vendor/shim/sqlite_shim.c" -o "$PKG/build-win/sqlite_shim.o"
"$ZIG" cc -target x86_64-windows-gnu $CFLAGS -c "$PKG/vendor/sqlite-amalgamation/sqlite3.c" -o "$PKG/build-win/sqlite3.o"
"$ZIG" cc -target x86_64-windows-gnu -O2 -c "$PKG/build-win/statbridge.c" -o "$PKG/build-win/statbridge.o"
(cd "$PKG/build-win" && ar rcs ../build/libsqlite3-shim.a sqlite_shim.o sqlite3.o statbridge.o)
echo "wrote $PKG/build/libsqlite3-shim.a (COFF x86_64)"
