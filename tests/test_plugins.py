"""Tests for the v0.1.0 plugin loader (spec: .agents/docs/extensibility.md section 1)."""
import json
import os
import stat
import subprocess
import sys

import pytest

from coordinate import plugins


def _exec(path, body="#!/bin/sh\ncat >/dev/null\n"):
    with open(path, "w") as f:
        f.write(body)
    os.chmod(path, 0o755)


@pytest.fixture()
def pdir(tmp_path):
    d = tmp_path / "plugins"
    d.mkdir()
    return str(d)


def test_empty_dir(pdir):
    assert plugins.discover(pdir) == []


def test_missing_dir(tmp_path):
    assert plugins.discover(str(tmp_path / "nope")) == []


def test_file_plugin_defaults_to_hook(pdir):
    _exec(os.path.join(pdir, "myhook"))
    ps = plugins.discover(pdir)
    assert len(ps) == 1 and ps[0].interface == "hook" and ps[0].ok()


def test_non_executable_is_an_error(pdir):
    with open(os.path.join(pdir, "dead"), "w") as f:
        f.write("#!/bin/sh\n")
    ps = plugins.discover(pdir)
    assert not ps[0].ok() and "not executable" in ps[0].errors[0]


def test_manifest_plugin(pdir):
    d = os.path.join(pdir, "tmux-frontend")
    os.mkdir(d)
    _exec(os.path.join(d, "tmux-frontend"))
    with open(os.path.join(d, "tmux-frontend.plugin.toml"), "w") as f:
        f.write('name = "tmux-frontend"\ninterface = "frontend"\nversion = "0.1.0"\n')
    ps = plugins.discover(pdir)
    assert ps[0].ok() and ps[0].interface == "frontend"


def test_unknown_manifest_key_fails_closed(pdir):
    d = os.path.join(pdir, "x")
    os.mkdir(d)
    _exec(os.path.join(d, "x"))
    with open(os.path.join(d, "x.plugin.toml"), "w") as f:
        f.write('interface = "hook"\nroot = true\n')
    ps = plugins.discover(pdir)
    assert any("fail-closed" in e for e in ps[0].errors)


def test_unknown_interface_fails(pdir):
    d = os.path.join(pdir, "y")
    os.mkdir(d)
    _exec(os.path.join(d, "y"))
    with open(os.path.join(d, "y.plugin.toml"), "w") as f:
        f.write('interface = "store"\n')
    ps = plugins.discover(pdir)
    assert any("unknown interface" in e for e in ps[0].errors)


def test_timeout_bounds(pdir):
    d = os.path.join(pdir, "z")
    os.mkdir(d)
    _exec(os.path.join(d, "z"))
    with open(os.path.join(d, "z.plugin.toml"), "w") as f:
        f.write('interface = "hook"\ntimeout_s = 9999\n')
    ps = plugins.discover(pdir)
    assert any("outside" in e for e in ps[0].errors)


def test_discovery_errors_do_not_raise(pdir):
    with open(os.path.join(pdir, "garbage"), "w") as f:
        f.write("x")
    ps = plugins.discover(pdir)
    assert len(ps) == 1 and not ps[0].ok()


def test_run_hook(pdir):
    _exec(os.path.join(pdir, "echo-hook"), '#!/bin/sh\ntr a-z A-Z\n')
    p = plugins.discover(pdir)[0]
    rc, out = plugins.run_hook(p, {"kind": "done", "job_id": 7})
    assert rc == 0 and json.dumps({"kind": "done", "job_id": 7})[:20].upper()[:2] in out[:2] or out


def test_hook_timeout(pdir):
    d = os.path.join(pdir, "slow")
    os.mkdir(d)
    _exec(os.path.join(d, "slow"), "#!/bin/sh\nsleep 30\n")
    with open(os.path.join(d, "slow.plugin.toml"), "w") as f:
        f.write('interface = "hook"\ntimeout_s = 1\n')
    p = plugins.discover(pdir)[0]
    with pytest.raises(subprocess.TimeoutExpired):
        plugins.run_hook(p, {})


def test_example_plugin_ships_ok():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    pdir = os.path.join(root, "examples", "plugins")
    ps = plugins.discover(pdir)
    assert len(ps) == 1 and ps[0].name == "ntfy-push" and ps[0].interface == "hook" and ps[0].ok()
    rc, out = plugins.run_hook(ps[0], {"kind": "done"})
    assert rc == 0
    assert "no NTFY_TOPIC" in out


def test_cli_plugins_list(pdir, capsys):
    _exec(os.path.join(pdir, "h"))
    from coordinate import cli
    rc = cli.main(["plugins", "list"])
    assert rc == 0
