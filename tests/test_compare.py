"""Tests for bench/compare.py: the regression gate that CI uses."""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

BENCH = Path(__file__).resolve().parent.parent / "bench"


def _load_compare():
    spec = importlib.util.spec_from_file_location("bench_compare", BENCH / "compare.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


compare = _load_compare()


def thresholds(**overrides):
    t = {"defaults": {"direction": "higher_is_worse", "percent_tolerance": 25.0}, "metrics": {}}
    for name, rule in overrides.items():
        t["metrics"][name] = rule
    return t


def test_identical_runs_pass():
    res = compare.compare({"a": 10.0, "gate": True}, {"a": 10.0, "gate": True}, thresholds(), None)
    assert res["ok"]
    assert not res["failures"]


def test_boolean_gate_must_hold():
    res = compare.compare({"cap_holds": True}, {"cap_holds": False}, thresholds(), None)
    assert not res["ok"]
    assert any("cap_holds" in f for f in res["failures"])


def test_boolean_gate_missing_fails():
    res = compare.compare({"cap_holds": True}, {}, thresholds(), None)
    assert not res["ok"]


def test_metric_inside_the_noise_band_passes():
    # baseline 100, stdev 10 in the noise file, so the band is 2 x 10 = 20;
    # a drift of 15 is inside the noise even though it is 15 percent
    noise = {"noise_per_scenario": {"cli": {"metrics": {"m": {"stdev": 10.0}}}}}
    res = compare.compare({"m": 100.0}, {"m": 115.0}, thresholds(m={"percent_tolerance": 5.0}), noise)
    assert res["ok"], res["failures"]


def test_metric_outside_the_noise_band_fails():
    noise = {"noise_per_scenario": {"cli": {"metrics": {"m": {"stdev": 10.0}}}}}
    res = compare.compare({"m": 100.0}, {"m": 130.0}, thresholds(m={"percent_tolerance": 5.0}), noise)
    assert not res["ok"]
    assert any("m" in f for f in res["failures"])


def test_metric_outside_the_percent_band_fails_even_without_noise():
    # no noise file at all: the percent tolerance is the only band
    res = compare.compare({"m": 100.0}, {"m": 130.0}, thresholds(m={"percent_tolerance": 5.0}), None)
    assert not res["ok"]


def test_lower_is_worse_direction():
    t = thresholds(m={"direction": "lower_is_worse", "percent_tolerance": 5.0})
    res = compare.compare({"m": 100.0}, {"m": 80.0}, t, None)
    assert not res["ok"]
    res = compare.compare({"m": 100.0}, {"m": 120.0}, t, None)
    assert res["ok"]


def test_none_direction_must_not_change():
    t = thresholds(m={"direction": "none"})
    res = compare.compare({"m": 3.0}, {"m": 4.0}, t, None)
    assert not res["ok"]
    res = compare.compare({"m": 3.0}, {"m": 3.0}, t, None)
    assert res["ok"]


def test_absolute_ceiling_and_floor():
    t = thresholds(m={"max": 0, "min": 0})
    res = compare.compare({"m": 0.0}, {"m": 1.0}, t, None)
    assert not res["ok"]
    res = compare.compare({"m": 0.0}, {"m": -1.0}, t, None)
    assert not res["ok"]


def test_absolute_tolerance_floors_the_band_for_a_zero_baseline():
    # baseline 0 means a percent tolerance gives a band of zero, so any wobble would fail
    t = thresholds(m={"percent_tolerance": 25.0, "absolute_tolerance": 2.0})
    res = compare.compare({"m": 0.0}, {"m": 1.0}, t, None)
    assert res["ok"], res["failures"]
    res = compare.compare({"m": 0.0}, {"m": 3.0}, t, None)
    assert not res["ok"]


def test_markdown_table_has_the_required_columns():
    res = compare.compare({"m": 1.0, "g": True}, {"m": 2.0, "g": False}, thresholds(), None)
    table = compare.markdown_table(res)
    assert "| metric | baseline | current | delta | tolerance | verdict |" in table
    assert "`m`" in table and "`g`" in table


def test_main_exits_one_on_regression(tmp_path, capsys):
    base = tmp_path / "base.json"
    cur = tmp_path / "cur.json"
    base.write_text(json.dumps({"m": 100.0, "cap_holds": True}))
    cur.write_text(json.dumps({"m": 400.0, "cap_holds": False}))
    rc = compare.main(["--baseline", str(base), "--current", str(cur),
                        "--thresholds", str(BENCH / "thresholds.toml")])
    assert rc == 1
    out = capsys.readouterr()
    assert "regression" in out.err


def test_main_exits_zero_when_clean(tmp_path):
    base = tmp_path / "base.json"
    cur = tmp_path / "cur.json"
    base.write_text(json.dumps({"m": 100.0, "cap_holds": True}))
    cur.write_text(json.dumps({"m": 101.0, "cap_holds": True}))
    rc = compare.main(["--baseline", str(base), "--current", str(cur),
                        "--thresholds", str(BENCH / "thresholds.toml")])
    assert rc == 0


def test_main_exits_two_on_unreadable_input(tmp_path):
    rc = compare.main(["--baseline", str(tmp_path / "missing.json"), "--current", str(tmp_path / "x.json")])
    assert rc == 2


def test_shipped_thresholds_and_noise_parse():
    t = compare.load_thresholds(BENCH / "thresholds.toml")
    assert t["gates"]["cap_holds"] is True
    noise_path = BENCH / "noise-linux.json"
    if noise_path.exists():
        sd = compare.noise_stdevs(compare.load_json(noise_path))
        assert "enqueue_cli_median_ms" in sd
        assert sd["enqueue_cli_median_ms"] > 0


def test_shipped_baseline_is_comparable():
    base_path = BENCH / "baseline-linux.json"
    if not base_path.exists():
        pytest.skip("no baseline yet")
    base = compare.load_json(base_path)
    res = compare.compare(base, base, compare.load_thresholds(BENCH / "thresholds.toml"),
                          compare.load_json(BENCH / "noise-linux.json"))
    assert res["ok"], res["failures"]
