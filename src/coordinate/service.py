"""Per-user daemon service: systemd user unit on Linux, launchd agent on macOS.

`coordinate service install|uninstall|status`. Install writes the unit file and prints
its path; it never starts or enables anything from the CLI, so tests can run it against
a temp HOME and only verify the file.
"""
import os
import subprocess
import sys

from . import paths

LAUNCHD_LABEL = "dev.coordinate.coordinated"


def _unit_path() -> str:
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents", f"{LAUNCHD_LABEL}.plist")
    return os.path.join(os.path.expanduser("~"), ".config", "systemd", "user", "coordinated.service")


def unit_contents() -> str:
    """The service file body. The daemon is restarted on failure; KeepAlive for launchd."""
    exe = _executable()
    if sys.platform == "darwin":
        return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>daemon</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>{paths.log_dir()}/coordinated.log</string>
  <key>StandardErrorPath</key><string>{paths.log_dir()}/coordinated.log</string>
</dict>
</plist>
"""
    return f"""[Unit]
Description=coordinate per-device daemon

[Service]
ExecStart={exe} daemon
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
"""


def _executable() -> str:
    """The installed `coordinated` (or `coordinate`) binary, else a python -m fallback."""
    for name in ("coordinated", "coordinate"):
        p = paths.env("CMD") or _which(name)
        if p:
            return p
    return f"{sys.executable} -m coordinate"


def _which(name: str) -> str | None:
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def main(action: str) -> int:
    path = _unit_path()
    if action == "status":
        installed = os.path.exists(path)
        running = False
        if sys.platform != "darwin":
            r = subprocess.run(["systemctl", "--user", "is-active", "coordinated"],
                               capture_output=True, text=True)
            running = r.returncode == 0
        print(f"unit: {path}")
        print(f"installed: {'yes' if installed else 'no'}")
        print(f"running: {'yes' if running else 'unknown/no'}")
        return 0
    if action == "install":
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(unit_contents())
        print(f"wrote {path}")
        if sys.platform == "darwin":
            print(f"start it with: launchctl load {path}")
        else:
            print("start it with: systemctl --user enable --now coordinated.service")
        return 0
    # uninstall: remove the file; the user stops the service themselves
    if os.path.exists(path):
        os.unlink(path)
        print(f"removed {path}")
        if sys.platform == "darwin":
            print(f"stop it first with: launchctl unload {path}")
        else:
            print("stop it with: systemctl --user disable --now coordinated.service")
    else:
        print(f"not installed ({path})")
    return 0
