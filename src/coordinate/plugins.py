"""Plugin discovery and loading for coordinate (v0.1.0, minimal loader).

Spec: `.agents/docs/extensibility.md` section 1. A plugin is an executable file
or a directory containing `<name>.plugin.toml`, under
`$XDG_CONFIG_HOME/coordinate/plugins/` (default `~/.config/coordinate/plugins/`).

Hard rules (extensibility.md section 4.3): plugins are never imported; each one
runs as its own process. Errors during discovery are collected, never raised,
so a broken plugin cannot take down the queue.
"""
import os
import subprocess
import sys

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None

INTERFACES = ("frontend", "resume", "hook")
KNOWN_KEYS = {"name", "interface", "version", "timeout_s", "sandbox"}
DEFAULT_TIMEOUT_S = 5
TIMEOUT_BOUNDS = (1, 300)


def plugin_dir() -> str:
    return os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config"),
        "coordinate", "plugins")


class Plugin:
    def __init__(self, name: str, path: str, interface: str, version: str = "",
                 timeout_s: float = DEFAULT_TIMEOUT_S, sandbox: str = ""):
        self.name, self.path, self.interface = name, path, interface
        self.version, self.timeout_s, self.sandbox = version, timeout_s, sandbox
        self.errors: list[str] = []

    def exec_path(self) -> str:
        return os.path.join(self.path, self.name) if os.path.isdir(self.path) else self.path

    def ok(self) -> bool:
        return not self.errors

    def as_dict(self) -> dict:
        return {"name": self.name, "path": self.path, "interface": self.interface,
                "version": self.version, "timeout_s": self.timeout_s,
                "sandbox": self.sandbox, "errors": self.errors}


def discover(root: str | None = None) -> list[Plugin]:
    """Scan the plugin directory. Returns every entry found, ok or not, sorted by name."""
    root = root or plugin_dir()
    out: list[Plugin] = []
    if not os.path.isdir(root):
        return out
    for entry in sorted(os.listdir(root)):
        path = os.path.join(root, entry)
        p = Plugin(entry, path, "")
        if not os.access(p.exec_path(), os.X_OK):
            p.errors.append("not executable")
        if os.path.isdir(path):
            manifest = os.path.join(path, f"{entry}.plugin.toml")
            if not os.path.exists(manifest):
                p.errors.append(f"directory without {entry}.plugin.toml")
            else:
                _apply_manifest(p, manifest)
        else:
            p.interface = "hook"  # file plugins: bare executables, interface via config row
        if p.interface and p.interface not in INTERFACES:
            p.errors.append(f"unknown interface {p.interface!r}")
        if tomllib is None and os.path.isdir(path):
            p.errors.append("tomllib unavailable")
        out.append(p)
    return out


def _apply_manifest(p: Plugin, manifest_path: str) -> None:
    with open(manifest_path, "rb") as f:
        data = tomllib.load(f)
    for key in data:
        if key not in KNOWN_KEYS:
            p.errors.append(f"unknown manifest key {key!r} (fail-closed)")
    p.interface = str(data.get("interface", ""))
    p.name = str(data.get("name", p.name))
    if p.name != os.path.basename(p.path):
        p.errors.append(f"manifest name {p.name!r} != directory name")
    p.version = str(data.get("version", ""))
    p.sandbox = str(data.get("sandbox", ""))
    p.timeout_s = data.get("timeout_s", DEFAULT_TIMEOUT_S)
    lo, hi = TIMEOUT_BOUNDS
    if not isinstance(p.timeout_s, (int, float)) or not lo <= p.timeout_s <= hi:
        p.errors.append(f"timeout_s {p.timeout_s!r} outside {lo}..{hi}")


def frontend_command(p: Plugin) -> list[str]:
    """Command to run a frontend plugin as a long-lived subprocess reading JSON lines on stdin."""
    return [p.path]


def run_hook(p: Plugin, event: dict) -> tuple[int, str]:
    """Run a hook plugin with one JSON event on stdin. Returns (returncode, combined output)."""
    proc = subprocess.run([p.exec_path()], input=_json_line(event), capture_output=True,
                          text=True, timeout=p.timeout_s)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def _json_line(obj: dict) -> str:
    import json
    return json.dumps(obj, separators=(",", ":")) + "\n"


def main(argv: list[str]) -> int:
    """`coordinate plugins list` and `coordinate plugins run --interface frontend`."""
    if not argv or argv[0] == "list":
        ps = discover()
        if not ps:
            print(f"no plugins in {plugin_dir()}")
            return 0
        for p in ps:
            status = "ok" if p.ok() else "ERROR: " + "; ".join(p.errors)
            print(f"{p.name}\t{p.interface or '?'}\t{status}")
        return 0
    if argv[0] == "run":
        rest = argv[1:]
        want = None
        if "--interface" in rest:
            i = rest.index("--interface")
            want = rest[i + 1]
            del rest[i:i + 2]
        ps = [p for p in discover() if p.ok() and p.interface == want] if want else \
             [p for p in discover() if p.ok()]
        if not ps:
            sys.exit(f"no loadable plugins (interface={want or 'any'})")
        for line in sys.stdin:
            for p in ps:
                try:
                    proc = subprocess.run([p.exec_path()], input=line, capture_output=True,
                                          text=True, timeout=p.timeout_s)
                    if proc.returncode != 0:
                        print(f"plugin {p.name} failed rc={proc.returncode}: "
                              f"{(proc.stderr or '').strip()}", file=sys.stderr)
                except subprocess.TimeoutExpired:
                    print(f"plugin {p.name} timed out after {p.timeout_s}s", file=sys.stderr)
        return 0
    sys.exit(f"plugins: unknown action {argv[0]!r} (use list | run)")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
