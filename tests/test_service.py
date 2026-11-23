"""service install/uninstall/status: file written and printed, nothing started."""
import os
import sys

import pytest

from coordinate import service


@pytest.fixture
def temp_home(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(service, "_unit_path", lambda: str(home / ("coordinated.plist" if sys.platform == "darwin" else "coordinated.service")))
    return home


def test_install_writes_unit(temp_home, capsys):
    assert service.main("install") == 0
    out = capsys.readouterr().out
    path = temp_home / "coordinated.service" if sys.platform != "darwin" else temp_home / "coordinated.plist"
    assert os.path.exists(path)
    assert str(path) in out


def test_unit_restarts_on_failure(temp_home):
    body = service.unit_contents()
    if sys.platform == "darwin":
        assert "<key>KeepAlive</key><true/>" in body
    else:
        assert "Restart=on-failure" in body
    assert "daemon" in body


def test_uninstall_removes(temp_home, capsys):
    service.main("install")
    assert service.main("uninstall") == 0
    assert not os.path.exists(temp_home / "coordinated.service")
    assert service.main("uninstall") == 0  # idempotent


def test_status_reports_missing(temp_home, capsys):
    service.main("status")
    assert "installed: no" in capsys.readouterr().out
