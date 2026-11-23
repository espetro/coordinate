"""coordinate CLI: enqueue, status, wait-on, release, cancel, stats, dead retry, migrate, service, daemon."""
import argparse
import json
import os
import sys
import time

from . import paths
from . import queue as q


def _max_runtime(spec: str | None) -> float:
    """Resolve the execution-time cap: explicit flag wins, else [defaults] max_runtime.

    0 means unbounded; the flag value 0 explicitly disables the machine default."""
    if spec is None:
        return q.default_max_runtime()
    try:
        return q.parse_duration(spec)
    except ValueError:
        sys.exit(f"enqueue --max-runtime: bad duration {spec!r} (use e.g. 90s, 15m, 2h)")


def _job_view(row: dict) -> dict:
    """Add the derived timecap fields an agent needs: remaining budget and deadline delta."""
    cap = row.get("max_runtime_s")
    used = row.get("runtime_used_s") or 0.0
    out = dict(row)
    out["runtime_remaining_s"] = None if not cap else round(max(0.0, cap - used), 3)
    dl = row.get("deadline_at")
    out["deadline_in_s"] = None if not dl else round(dl - time.time(), 3)
    return out


def build() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="coordinate")
    s = p.add_subparsers(dest="verb", required=True)
    e = s.add_parser("enqueue", help="enqueue a command: coordinate enqueue [opts] -- cmd args...")
    e.add_argument("--cwd", default=None)
    e.add_argument("--repo", default=None, help="per-repo cap key (default: cwd)")
    e.add_argument("--priority", type=int, default=0)
    e.add_argument("--max-attempts", type=int, default=3)
    e.add_argument("--max-runtime", default=None, metavar="DUR",
                   help="execution-time cap for the job, e.g. 15m, 2h, 90s (0 = unbounded; "
                        "default comes from [defaults] max_runtime in config.toml)")
    e.add_argument("--wait-on", default=None, help="park immediately on this event id")
    e.add_argument("--acp", metavar="AGENT", default=None, help="enqueue an acp job for this agent (needs --cwd, --prompt)")
    e.add_argument("--prompt", default=None, help="acp prompt text")
    e.add_argument("--registry", default=None, help="acp agent registry file")
    e.add_argument("--model", default=None, help="acp model id, applied via session/set_model (fatal if the agent rejects it)")
    e.add_argument("--slot", action="append", default=None, metavar="KEY",
                   help="extra tool-level slot key (repeatable), e.g. --slot tool:vitest")
    e.add_argument("--shell", action="store_true", help="cmd is ONE string, stored and run verbatim via sh -c")
    e.add_argument("cmd", nargs=argparse.REMAINDER)
    st = s.add_parser("status", help="list jobs, or one job as JSON")
    st.add_argument("id", nargs="?")
    st.add_argument("--self", action="store_true",
                    help="status of the job named by $COORDINATE_JOB_ID (read-only)")
    w = s.add_parser("wait-on", help="park a job on an event id")
    w.add_argument("id", type=int)
    w.add_argument("event")
    r = s.add_parser("release", help="release jobs waiting on an event id")
    r.add_argument("event")
    x = s.add_parser("cancel")
    x.add_argument("id")
    s.add_parser("stats")
    ev = s.add_parser("events", help="list job events as JSONL")
    ev.add_argument("--follow", action="store_true", help="keep tailing new events")
    ev.add_argument("--since", type=int, default=0, metavar="ID", help="start after this event id")
    d = s.add_parser("dead", help="dead-letter operations")
    d.add_argument("action", choices=["retry"])
    d.add_argument("id", type=int, nargs="?")
    s.add_parser("migrate", help="copy legacy ~/.fleet files into the XDG locations")
    sv = s.add_parser("service", help="install/uninstall/status the per-user daemon service")
    sv.add_argument("action", choices=["install", "uninstall", "status"])
    s.add_parser("daemon", help="run the dispatcher")
    return p


def main(argv=None) -> int:
    a = build().parse_args(argv)
    if a.verb == "daemon":
        from . import daemon
        try:
            daemon.run()
        except KeyboardInterrupt:
            pass
        return 0
    if a.verb == "migrate":
        written = paths.migrate()
        if not written:
            print("nothing to migrate (no legacy ~/.fleet files found)")
        for p in written:
            print(f"copied: {p}")
        print("note: the originals under ~/.fleet were kept; delete them when confident")
        return 0
    if a.verb == "service":
        from . import service
        return service.main(a.action)
    c = q.connect()
    if a.verb == "enqueue":
        kind = "acp" if a.acp else "cmd"
        if kind == "acp":
            if not (a.cwd and a.prompt):
                sys.exit("enqueue --acp: --cwd and --prompt are required")
            payload = {"agent": a.acp, "cwd": os.path.abspath(a.cwd), "prompt": a.prompt}
            if a.registry:
                payload["registry"] = os.path.abspath(a.registry)
            if a.model:
                payload["model"] = a.model
        else:
            cmd = [t for t in a.cmd if t != "--"] if a.cmd[:1] == ["--"] else a.cmd
            if not cmd:
                sys.exit("enqueue: no command given")
            if a.shell and len(cmd) != 1:
                sys.exit("enqueue --shell: pass the command as ONE quoted string, e.g. --shell -- 'sh -c \"echo hi\"'")
            payload = {"cmd": cmd[0] if a.shell else cmd, "cwd": a.cwd}
        if a.repo:
            payload["repo"] = a.repo
        if a.slot:
            payload["slots"] = a.slot
        jid = q.enqueue(c, payload, kind=kind, priority=a.priority, max_attempts=a.max_attempts,
                        max_runtime_s=_max_runtime(a.max_runtime))
        if a.wait_on:
            q.wait_on(c, jid, a.wait_on)
        print(jid)
    elif a.verb == "status":
        cols = ("id,kind,status,priority,attempts,max_attempts,waiting_on,lease_owner,lease_expires_at,"
                "pgid,payload,max_runtime_s,runtime_used_s,deadline_at,outcome")
        jid = a.id
        if a.self:
            jid = paths.env("JOB_ID")
            if not jid:
                sys.exit("status --self: COORDINATE_JOB_ID (or FLEET_JOB_ID) is not set")
        if jid is not None:
            cur = c.execute(f"SELECT {cols} FROM jobs WHERE id=?", (jid,))
            row = cur.fetchone()
            if not row:
                sys.exit(f"no job {jid}")
            print(json.dumps(_job_view(dict(zip([d[0] for d in cur.description], row))), indent=2))
        else:
            for row in c.execute("SELECT id,status,attempts,max_attempts,waiting_on,payload FROM jobs ORDER BY id"):
                print("\t".join("" if v is None else str(v) for v in row))
    elif a.verb == "wait-on":
        sys.exit(0 if q.wait_on(c, a.id, a.event) else f"job {a.id} not parkable")
    elif a.verb == "release":
        print(*q.release(c, a.event))
    elif a.verb == "cancel":
        sys.exit(0 if q.cancel(c, a.id) else f"job {a.id} not cancellable")
    elif a.verb == "stats":
        print(json.dumps(q.stats(c)))
    elif a.verb == "events":
        from .events import follow, row_event
        last = a.since
        for row in follow(c, last):
            last = row[0]
            print(json.dumps(row_event(row)))
        if a.follow:
            try:
                while True:
                    for row in follow(c, last):
                        last = row[0]
                        print(json.dumps(row_event(row)), flush=True)
                    time.sleep(0.5)
            except KeyboardInterrupt:
                pass
    elif a.verb == "dead":
        print(*q.retry_dead(c, a.id))
    return 0


if __name__ == "__main__":
    sys.exit(main())
