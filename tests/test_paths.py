"""Path resolution rules: XDG layout, env overrides, FLEET_* fallback, legacy notice, migrate."""
import os
import sqlite3

import pytest

from coordinate import paths


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for var in ("XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
                "COORDINATE_DB", "COORDINATE_CONFIG", "FLEET_DB", "FLEET_CONFIG"):
        monkeypatch.delenv(var, raising=False)


def test_env_coordinate_wins(monkeypatch):
    monkeypatch.setenv("FLEET_DB", "/old/db")
    monkeypatch.setenv("COORDINATE_DB", "/new/db")
    assert paths.env("DB") == "/new/db"


def test_env_fleet_fallback(monkeypatch):
    monkeypatch.setenv("FLEET_DB", "/old/db")
    assert paths.env("DB") == "/old/db"


def test_db_default_xdg_state(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    assert paths.db_path(notice=False) == str(tmp_path / "state" / "coordinate" / "queue.db")


def test_config_default_xdg_config(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "conf"))
    assert paths.config_path(notice=False) == str(tmp_path / "conf" / "coordinate" / "config.toml")


def test_db_override(monkeypatch, tmp_path):
    monkeypatch.setenv("COORDINATE_DB", str(tmp_path / "x.db"))
    assert paths.db_path(notice=False) == str(tmp_path / "x.db")


def test_config_override(monkeypatch, tmp_path):
    monkeypatch.setenv("FLEET_CONFIG", str(tmp_path / "x.toml"))
    assert paths.config_path(notice=False) == str(tmp_path / "x.toml")


def test_runtime_dir_prefers_xdg_runtime(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    assert paths.runtime_dir() == str(tmp_path / "run" / "coordinate")


def test_runtime_dir_falls_back_to_state_run(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    assert paths.runtime_dir() == str(tmp_path / "state" / "coordinate" / "run")


def test_log_dir_under_state(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    assert paths.log_dir() == str(tmp_path / "state" / "coordinate" / "logs")


def test_legacy_db_notice(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setattr(paths, "LEGACY_DIR", str(tmp_path / ".fleet"))
    os.makedirs(tmp_path / ".fleet")
    sqlite3.connect(tmp_path / ".fleet" / "queue.db").close()
    got = paths.db_path()
    assert got == str(tmp_path / ".fleet" / "queue.db")
    out = capsys.readouterr().err
    assert "legacy" in out and "coordinate migrate" in out


def test_legacy_config_notice(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "conf"))
    monkeypatch.setattr(paths, "LEGACY_DIR", str(tmp_path / ".fleet"))
    os.makedirs(tmp_path / ".fleet")
    (tmp_path / ".fleet" / "config.toml").write_text("")
    got = paths.config_path()
    assert got == str(tmp_path / ".fleet" / "config.toml")
    assert "legacy" in capsys.readouterr().err


def test_new_db_silences_notice(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setattr(paths, "LEGACY_DIR", str(tmp_path / ".fleet"))
    os.makedirs(tmp_path / ".fleet")
    sqlite3.connect(tmp_path / ".fleet" / "queue.db").close()
    os.makedirs(tmp_path / "state" / "coordinate")
    sqlite3.connect(tmp_path / "state" / "coordinate" / "queue.db").close()
    assert paths.db_path() == str(tmp_path / "state" / "coordinate" / "queue.db")
    assert capsys.readouterr().err == ""


def test_migrate_copies_never_moves(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "conf"))
    legacy = tmp_path / ".fleet"
    legacy.mkdir()
    src = sqlite3.connect(legacy / "queue.db")
    src.execute("CREATE TABLE t(x)")
    src.execute("INSERT INTO t VALUES(1)")
    src.commit()
    src.close()
    (legacy / "config.toml").write_text("[defaults]\nmax_runtime = \"15m\"\n")
    written = paths.migrate(root=str(tmp_path))
    assert len(written) == 2
    assert (legacy / "queue.db").exists() and (legacy / "config.toml").exists()
    dst = sqlite3.connect(written[0])
    assert dst.execute("SELECT x FROM t").fetchall() == [(1,)]
    assert "max_runtime" in (tmp_path / "conf" / "coordinate" / "config.toml").read_text()


def test_migrate_nothing_to_do(tmp_path):
    assert paths.migrate(root=str(tmp_path / "home")) == []
