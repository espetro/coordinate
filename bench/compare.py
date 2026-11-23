#!/usr/bin/env python3
"""Compare a bench result JSON against a baseline JSON, with thresholds. Stdlib only.

  python bench/compare.py --baseline bench/baseline-linux.json --current results.json \
      [--thresholds bench/thresholds.toml] [--noise bench/noise-linux.json] [--markdown]

Exit code 0 when nothing regressed, 1 when at least one gate failed or one numeric metric
got worse than its tolerance, 2 when the inputs could not be read.

How a numeric metric is judged:
  - The drift must be worse than BOTH the absolute noise band (2 x stdev of that metric in the
    noise file, when the noise file has it) and the relative band (percent_tolerance of the
    baseline value). A metric that moves less than either band is inside the noise.
  - `direction` says which way is worse: "higher_is_worse" (latency, RSS, seconds),
    "lower_is_worse" (throughput), or "none" (the value must not change at all).
  - `max` and `min` are absolute ceilings and floors that apply regardless of the baseline.

Boolean gates must hold: a gate that is true in the baseline and false in the current run is
a regression, and a gate that is false in the baseline and still false is not one (the gate
was already broken, that is a different conversation).
"""
import argparse
import json
import sys
from pathlib import Path

try:  # tomllib is stdlib from 3.11
    import tomllib
except ImportError:  # pragma: no cover
    tomllib = None

HIGHER_IS_WORSE = "higher_is_worse"
LOWER_IS_WORSE = "lower_is_worse"
NO_DIRECTION = "none"


# --- inputs ---------------------------------------------------------------------

def load_json(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def load_thresholds(path: Path | None) -> dict:
    if path is None or not Path(path).exists():
        return {}
    if tomllib is None:
        raise SystemExit("compare.py needs python 3.11+ for tomllib")
    with open(path, "rb") as f:
        return tomllib.load(f)


def noise_stdevs(noise: dict | None) -> dict[str, float]:
    """metric name -> stdev, flattened out of the noise-floor result file."""
    if not noise:
        return {}
    out: dict[str, float] = {}
    per = noise.get("noise_per_scenario") or {}
    for scen in per.values():
        for name, blk in (scen.get("metrics") or {}).items():
            out[name] = float(blk.get("stdev", 0.0) or 0.0)
    return out


# --- the comparison -------------------------------------------------------------

def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _metric_rule(thresholds: dict, name: str) -> dict:
    rule = dict((thresholds.get("defaults") or {}))
    rule.update((thresholds.get("metrics") or {}).get(name) or {})
    return rule


def compare(baseline: dict, current: dict, thresholds: dict, noise: dict | None) -> dict:
    """Return the full verdict structure: one row per metric or gate, plus the failures."""
    sd = noise_stdevs(noise)
    rows = []
    failures = []

    # ---- boolean gates ----
    gates = thresholds.get("gates") or {}
    for name in sorted(set(gates) | {k for k, v in baseline.items() if isinstance(v, bool)}):
        if name not in baseline and name not in current:
            continue
        b, c = baseline.get(name), current.get(name)
        if name in gates:
            want = bool(gates[name])
            if c is None:
                verdict, ok = "MISSING", False
            elif bool(c) == want:
                verdict, ok = "PASS", True
            else:
                verdict, ok = "FAIL", False
        else:
            # a boolean the thresholds file does not list: it must not flip from true to false
            if b is True and c is not True:
                verdict, ok = "FAIL", False
            elif b is True and c is True:
                verdict, ok = "PASS", True
            elif c is None:
                verdict, ok = "MISSING", False
            else:
                verdict, ok = "PASS", True
        rows.append({"kind": "gate", "metric": name, "baseline": b, "current": c,
                     "delta": None, "tolerance": None, "verdict": verdict, "ok": ok})
        if not ok:
            failures.append(f"gate {name}: baseline={b} current={c}")

    # ---- numeric metrics ----
    skip = {"host", "tree", "backend", "noise_per_scenario", "noise_repeats", "noise_scenarios"}
    for name in sorted(set(baseline) | set(current)):
        if name in skip:
            continue
        b, c = baseline.get(name), current.get(name)
        if not (_is_number(b) and _is_number(c)):
            continue
        rule = _metric_rule(thresholds, name)
        direction = rule.get("direction", HIGHER_IS_WORSE)
        pct = float(rule.get("percent_tolerance", thresholds.get("defaults", {}).get("percent_tolerance", 25.0)))
        abs_band = 2.0 * float(sd.get(name, 0.0))
        rel_band = abs(b) * pct / 100.0
        # absolute_tolerance is the floor of the band, for metrics whose baseline is near zero
        # (idle CPU percent), where a percent tolerance would be zero and every wobble a failure.
        fixed_band = float(rule.get("absolute_tolerance", 0.0))
        band = max(abs_band, rel_band, fixed_band)
        delta = c - b
        ok = True
        reason = ""
        if direction == NO_DIRECTION:
            if c != b:
                ok, reason = False, f"must stay {b}, got {c}"
        elif direction == HIGHER_IS_WORSE and delta > band:
            ok, reason = False, f"worse by {delta:.4g} (band {band:.4g})"
        elif direction == LOWER_IS_WORSE and -delta > band:
            ok, reason = False, f"worse by {-delta:.4g} (band {band:.4g})"
        if "max" in rule and c > float(rule["max"]):
            ok, reason = False, f"above the ceiling {rule['max']}"
        if "min" in rule and c < float(rule["min"]):
            ok, reason = False, f"below the floor {rule['min']}"
        verdict = "PASS" if ok else "FAIL"
        rows.append({"kind": "metric", "metric": name, "baseline": b, "current": c,
                     "delta": round(delta, 6), "tolerance": round(band, 6),
                     "verdict": verdict, "ok": ok, "reason": reason,
                     "direction": direction,
                     "abs_band": round(abs_band, 6), "rel_band": round(rel_band, 6)})
        if not ok:
            failures.append(f"metric {name}: baseline={b} current={c} ({reason})")

    # ---- metrics only in the current run (new, not in the baseline) ----
    for name in sorted(set(current) - set(baseline)):
        c = current[name]
        if _is_number(c):
            rows.append({"kind": "metric", "metric": name, "baseline": None, "current": c,
                         "delta": None, "tolerance": None, "verdict": "NEW", "ok": True})

    return {"rows": rows, "failures": failures, "ok": not failures,
            "baseline_host": baseline.get("host"), "current_host": current.get("host")}


# --- output ---------------------------------------------------------------------

def _fmt(v) -> str:
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return f"{v:.4g}"
    return str(v)


def markdown_table(result: dict) -> str:
    lines = ["| metric | baseline | current | delta | tolerance | verdict |",
             "|---|---|---|---|---|---|"]
    for r in result["rows"]:
        delta = "-" if r["delta"] is None else f"{r['delta']:+.4g}"
        lines.append(f"| `{r['metric']}` | {_fmt(r['baseline'])} | {_fmt(r['current'])} | {delta} | "
                     f"{_fmt(r['tolerance'])} | {r['verdict']} |")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--baseline", required=True, help="baseline result JSON")
    ap.add_argument("--current", required=True, help="current result JSON")
    ap.add_argument("--thresholds", default=None, help="thresholds TOML (bench/thresholds.toml)")
    ap.add_argument("--noise", default=None, help="noise-floor result JSON (bench/noise-linux.json)")
    ap.add_argument("--markdown", action="store_true", help="print the markdown table on stdout")
    ap.add_argument("--json", action="store_true", help="print the full verdict as JSON")
    ap.add_argument("--out", default=None, help="write the markdown table to this file")
    a = ap.parse_args(argv)

    try:
        baseline = load_json(Path(a.baseline))
        current = load_json(Path(a.current))
        thresholds = load_thresholds(Path(a.thresholds) if a.thresholds else None)
        noise = load_json(Path(a.noise)) if a.noise and Path(a.noise).exists() else None
    except (OSError, ValueError) as e:
        print(f"compare.py: cannot read the inputs: {e}", file=sys.stderr)
        return 2

    result = compare(baseline, current, thresholds, noise)

    table = markdown_table(result)
    if a.markdown or not a.json:
        print(table)
    if a.out:
        Path(a.out).write_text(table + "\n")
    if a.json:
        print(json.dumps(result, indent=2))

    if result["ok"]:
        print(f"\ncompare.py: no regression ({len(result['rows'])} checks)", file=sys.stderr)
        return 0
    print(f"\ncompare.py: {len(result['failures'])} regression(s):", file=sys.stderr)
    for f in result["failures"]:
        print(f"  - {f}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
