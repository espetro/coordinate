"""Single source of env-var and filesystem paths for coordinate.

Env vars: `COORDINATE_*` is canonical; `FLEET_*` is read as a fallback so existing
scripts keep working. Always go through `env()`.

Layout (XDG on Linux and macOS alike):
  config   $XDG_CONFIG_HOME/coordinate/config.toml   (default ~/.config)
  state    $XDG_STATE_HOME/coordinate/               (default ~/.local/state):
             queue.db, logs/, run/ (runtime fallback when XDG_RUNTIME_DIR is unset)
  runtime  $XDG_RUNTIME_DIR/coordinate/              (pid files, locks, sockets)

`COORDINATE_DB` / `COORDINATE_CONFIG` (and the FLEET_* fallbacks) override the
derived paths. Legacy `~/.fleet/` files are used when the new ones do not exist,
with a one-line notice pointing at `coordinate migrate`.
"""
import os
import shutil
import sqlite3
import sys

LEGACY_DIR = os.path.expanduser("~/.fleet")
PACKAGE = "coordinate"


def env(name: str, default: str | None = None) -> str | None:
    """COORDINATE_<name> wins over the FLEET_<name> fallback."""
    return os.environ.get(f"COORDINATE_{name}") or os.environ.get(f"FLEET_{name}") or default


def _xdg(var: str, default: str) -> str:
    return os.environ.get(var) or os.path.join(os.path.expanduser("~"), default)


def config_dir() -> str:
    return os.path.join(_xdg("XDG_CONFIG_HOME", ".config"), PACKAGE)


def state_dir() -> str:
    return os.path.join(_xdg("XDG_STATE_HOME", ".local/state"), PACKAGE)


def runtime_dir() -> str:
    if os.environ.get("XDG_RUNTIME_DIR"):
        return os.path.join(os.environ["XDG_RUNTIME_DIR"], PACKAGE)
    return os.path.join(state_dir(), "run")


def log_dir() -> str:
    return os.path.join(state_dir(), "logs")


def db_path(notice: bool = True) -> str:
    override = env("DB")
    if override:
        return override
    path = os.path.join(state_dir(), "queue.db")
    if notice and not os.path.exists(path) and os.path.exists(os.path.join(LEGACY_DIR, "queue.db")):
        print(f"note: using legacy {LEGACY_DIR}/queue.db; run `coordinate migrate` to adopt the "
              f"XDG location ({path})", file=sys.stderr)
        return os.path.join(LEGACY_DIR, "queue.db")
    return path


def config_path(notice: bool = True) -> str:
    override = env("CONFIG")
    if override:
        return override
    path = os.path.join(config_dir(), "config.toml")
    if notice and not os.path.exists(path) and os.path.exists(os.path.join(LEGACY_DIR, "config.toml")):
        print(f"note: using legacy {LEGACY_DIR}/config.toml; run `coordinate migrate` to adopt the "
              f"XDG location ({path})", file=sys.stderr)
        return os.path.join(LEGACY_DIR, "config.toml")
    return path


def migrate(root: str | None = None) -> list[str]:
    """Copy legacy ~/.fleet files into the XDG locations. Copy, never move or delete.

    The db goes through the SQLite backup API so WAL sidecars cannot be torn.
    Returns the destination paths written."""
    home = root or os.path.expanduser("~")
    legacy = os.path.join(home, ".fleet")
    dst_state = os.path.join(
        os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local/state"), PACKAGE)
    dst_conf = os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), PACKAGE)
    written: list[str] = []
    for d in (dst_state, dst_conf):
        os.makedirs(d, exist_ok=True)
    src_db = os.path.join(legacy, "queue.db")
    if os.path.exists(src_db):
        dst_db = os.path.join(dst_state, "queue.db")
        src = sqlite3.connect(src_db)
        dst = sqlite3.connect(dst_db)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        written.append(dst_db)
    for name in ("config.toml",):
        src = os.path.join(legacy, name)
        if os.path.exists(src):
            dst = os.path.join(dst_conf, name)
            shutil.copy2(src, dst)
            written.append(dst)
    return written
