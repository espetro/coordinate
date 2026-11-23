#!/usr/bin/env python3
"""Where the bytes of a parked session go, and whether TTL reclaim can shrink the file.

  python bench/bytes_analysis.py --db PATH [--out results.json] [--label NAME]

Answers with dbstat (the per-object page accounting) instead of file size alone:
- how many bytes each table and index holds, per parked session
- page size, page count, freelist pages and free bytes
- what a row actually stores (the payload and the fixed columns)

Then it measures the reclaim on a copy of the database:
1. delete or expire the parked rows
2. VACUUM, which rewrites the file without the free pages
3. PRAGMA auto_vacuum=INCREMENTAL plus PRAGMA incremental_vacuum, which returns the free
   pages to the filesystem without a full rewrite

auto_vacuum=INCREMENTAL has to be set before the database is created (or followed by a
VACUUM), so the copy is rebuilt for that variant.
"""
import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path


def host_state() -> dict:
    load1, load5, load15 = os.getloadavg()
    mem = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                if k in ("MemTotal", "MemAvailable"):
                    mem[k] = int(v.strip().split()[0]) // 1024
    except OSError:
        pass
    return {"load_1m": round(load1, 2), "load_5m": round(load5, 2), "load_15m": round(load15, 2),
            "mem_total_mb": mem.get("MemTotal"), "mem_available_mb": mem.get("MemAvailable"),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z")}


def dbstat(c: sqlite3.Connection) -> list[dict]:
    """Per object page accounting: name, pages, bytes, per page."""
    try:
        rows = c.execute(
            "SELECT name, pagetype, COUNT(*) AS pages, SUM(pgsize) AS bytes, "
            "SUM(unused) AS unused, SUM(payload) AS payload "
            "FROM dbstat GROUP BY name, pagetype ORDER BY bytes DESC").fetchall()
    except sqlite3.Error as e:
        return [{"error": f"dbstat unavailable: {e}"}]
    return [{"name": r[0], "pagetype": r[1], "pages": r[2], "bytes": r[3],
             "unused_bytes": r[4], "payload_bytes": r[5]} for r in rows]


def pragmas(c: sqlite3.Connection) -> dict:
    out = {}
    for p in ("page_size", "page_count", "freelist_count", "auto_vacuum", "journal_mode",
              "encoding", "user_version", "application_id"):
        try:
            v = c.execute(f"PRAGMA {p}").fetchone()
            out[p] = v[0] if v else None
        except sqlite3.Error:
            out[p] = None
    try:
        out["freelist_bytes"] = out["freelist_count"] * out["page_size"]
    except TypeError:
        out["freelist_bytes"] = None
    return out


def row_shape(c: sqlite3.Connection) -> dict:
    """What one parked row stores: the columns and the size of the payload."""
    row = c.execute("SELECT * FROM jobs WHERE status='waiting' LIMIT 1").fetchone()
    if row is None:
        row = c.execute("SELECT * FROM jobs LIMIT 1").fetchone()
    if row is None:
        return {}
    cols = [d[0] for d in c.execute("SELECT * FROM jobs LIMIT 1").description]
    out = {"columns": cols}
    for name, val in zip(cols, row):
        if name == "payload":
            out["payload_bytes"] = len(val or "")
            try:
                out["payload_keys"] = sorted(json.loads(val).keys())
            except (ValueError, TypeError):
                out["payload_keys"] = None
        elif isinstance(val, str):
            out.setdefault("text_columns", {})[name] = len(val)
    return out


def db_size(db: Path) -> dict:
    """File sizes: the main database and the WAL sidecars."""
    out = {"db_bytes": db.stat().st_size if db.exists() else 0}
    wal = [p for p in db.parent.glob(db.name + "-*") if p.is_file()]
    out["wal_bytes"] = sum(p.stat().st_size for p in wal)
    out["sidecar_bytes"] = out["db_bytes"] + out["wal_bytes"]
    out["sidecars"] = {p.name: p.stat().st_size for p in wal}
    return out


def analyze(db: Path) -> dict:
    c = sqlite3.connect(str(db))
    try:
        counts = dict(c.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status"))
        rows = c.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
        parked = counts.get("waiting", 0)
        res = {"rows": rows, "by_status": counts, "parked": parked,
               "pragmas": pragmas(c), "dbstat": dbstat(c), "row_shape": row_shape(c),
               "files": db_size(db)}
        stat = {f"{r['name']}:{r['pagetype']}": r for r in res["dbstat"] if "error" not in r}
        total = sum(r["bytes"] for r in stat.values())
        res["dbstat_total_bytes"] = total
        res["bytes_per_parked_session"] = round(total / parked, 1) if parked else None
        res["bytes_per_row"] = round(total / rows, 1) if rows else None
        res["per_object_per_session"] = {
            name: round(r["bytes"] / parked, 1) for name, r in stat.items()} if parked else {}
        # the payload alone: what the session record costs before any page overhead
        try:
            payload_total = c.execute(
                "SELECT SUM(LENGTH(payload)) FROM jobs WHERE status='waiting'").fetchone()[0] or 0
            res["payload_bytes_total"] = payload_total
            res["payload_bytes_per_session"] = round(payload_total / parked, 1) if parked else None
        except sqlite3.Error:
            pass
        return res
    finally:
        c.close()


def reclaim_variants(db: Path, workdir: Path) -> dict:
    """Measure the reclaim of the parked rows on copies of the database.

    Variants:
    - delete: DELETE the parked rows, no vacuum. The file keeps its size; the space goes to
      the freelist.
    - vacuum: DELETE plus VACUUM, which rewrites the file without the free pages.
    - incremental: a copy rebuilt with auto_vacuum=INCREMENTAL, DELETE plus
      PRAGMA incremental_vacuum, which hands the free pages back to the filesystem.
    """
    out = {}
    base = db_size(db)

    # delete only
    copy = workdir / "reclaim-delete.db"
    _copy_db(db, copy)
    c = sqlite3.connect(str(copy))
    try:
        before = db_size(copy)
        c.execute("DELETE FROM jobs WHERE status='waiting'")
        c.commit()
        c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        after = db_size(copy)
        out["delete"] = {"before": before, "after": after,
                         "freelist": pragmas(c).get("freelist_count"),
                         "freelist_bytes": pragmas(c).get("freelist_bytes"),
                         "note": "the file keeps its size; the freed pages go to the freelist"}
    finally:
        c.close()

    # delete plus VACUUM
    copy = workdir / "reclaim-vacuum.db"
    _copy_db(db, copy)
    c = sqlite3.connect(str(copy))
    try:
        before = db_size(copy)
        c.execute("DELETE FROM jobs WHERE status='waiting'")
        c.commit()
        c.execute("VACUUM")
        c.close()
        after = db_size(copy)
        out["vacuum"] = {"before": before, "after": after,
                         "note": "VACUUM rewrites the file without the free pages, so the file shrinks"}
    finally:
        try:
            c.close()
        except sqlite3.Error:
            pass

    # incremental vacuum on a database created with auto_vacuum=INCREMENTAL
    copy = workdir / "reclaim-incremental.db"
    _copy_db(db, copy)
    c = sqlite3.connect(str(copy))
    try:
        c.execute("PRAGMA auto_vacuum=INCREMENTAL")
        c.execute("VACUUM")
        c.close()
        c = sqlite3.connect(str(copy))
        before = db_size(copy)
        c.execute("DELETE FROM jobs WHERE status='waiting'")
        c.commit()
        c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        freed = c.execute("PRAGMA incremental_vacuum").fetchall()
        c.close()
        after = db_size(copy)
        c = sqlite3.connect(str(copy))
        try:
            pg = pragmas(c)
        finally:
            c.close()
        out["incremental"] = {"before": before, "after": after,
                              "auto_vacuum": pg.get("auto_vacuum"),
                              "freelist": pg.get("freelist_count"),
                              "freelist_bytes": pg.get("freelist_bytes"),
                              "incremental_vacuum_rows": len(freed),
                              "note": "auto_vacuum=INCREMENTAL plus incremental_vacuum returns the "
                                      "freed pages to the filesystem without a full rewrite"}
    finally:
        try:
            c.close()
        except sqlite3.Error:
            pass
    out["base"] = base
    return out


def _copy_db(src: Path, dst: Path) -> None:
    """Copy a database and its WAL sidecars (the WAL holds committed pages)."""
    for p in src.parent.glob(src.name + "-*"):
        if p.is_file():
            shutil.copy2(p, dst.parent / p.name.replace(src.name, dst.name))
    shutil.copy2(src, dst)


def wal_experiment(tree: Path, workdir: Path, counts=(1000, 10000)) -> dict:
    """How much of the on-disk cost of a parked session is the WAL, not the rows.

    The bench numbers that were reported per session (4,444 bytes at 1,000 sessions, 679 at
    10,000) include the WAL sidecar. This measures the same fill twice: once with a connection
    open on the store (which is what the daemon does, and what keeps the WAL from being
    checkpointed and truncated) and once with no other connection (so every writer checkpoints
    and truncates the WAL on close).

    The CLI path is what the daemon sees in production: one transaction per job, so each commit
    appends a frame set to the WAL.
    """
    out = {}
    for n in counts:
        for mode in ("open", "closed"):
            d = workdir / f"wal-{n}-{mode}"
            if d.exists():
                shutil.rmtree(d)
            d.mkdir(parents=True, exist_ok=True)
            db = d / "queue.db"
            holder = None
            if mode == "open":
                holder = subprocess.Popen(
                    [sys.executable, str(Path(__file__).parent / "wal_holder.py"), str(db), "600"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                time.sleep(1.0)
            t0 = time.time()
            r = subprocess.run([sys.executable, str(Path(__file__).parent / "park_filler.py"),
                                "--db", str(db), "--count", str(n), "--event", "e", "--kind", "cmd"],
                               capture_output=True, text=True)
            elapsed = time.time() - t0
            if holder is not None:
                holder.terminate()
                try:
                    holder.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    holder.kill()
            files = db_size(db)
            rows = sqlite3.connect(str(db)).execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
            out[f"{n}_{mode}"] = {"rows": rows, "fill_s": round(elapsed, 2), **files,
                                 "bytes_per_session": round(files["sidecar_bytes"] / rows, 1) if rows else None}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--label", default="")
    ap.add_argument("--workdir", default=None)
    ap.add_argument("--no-reclaim", action="store_true")
    ap.add_argument("--wal-experiment", action="store_true",
                    help="fill 1,000 and 10,000 sessions with and without a second connection open, "
                         "to separate the WAL cost from the row cost")
    ap.add_argument("--tree", default=str(Path(__file__).parent.parent))
    a = ap.parse_args()
    db = Path(a.db).resolve()
    workdir = Path(a.workdir) if a.workdir else db.parent
    workdir.mkdir(parents=True, exist_ok=True)
    res = {"label": a.label, "db": str(db), "host": host_state()}
    res.update(analyze(db))
    if not a.no_reclaim:
        res["reclaim"] = reclaim_variants(db, workdir)
    if a.wal_experiment:
        res["wal_experiment"] = wal_experiment(Path(a.tree), workdir)
    res["host_after"] = host_state()
    out = json.dumps(res, indent=2)
    if a.out:
        Path(a.out).write_text(out)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
