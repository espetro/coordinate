"""fleet CLI: enqueue, status, wait-on, release, cancel, stats, dead retry, daemon."""
import argparse
import json
import os
import sys

from fleet import queue as q

DBOS = os.environ.get("FLEET_BACKEND") == "dbos"


def build() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="fleet")
    s = p.add_subparsers(dest="verb", required=True)
    e = s.add_parser("enqueue", help="enqueue a command: fleet enqueue [opts] -- cmd args...")
    e.add_argument("--cwd", default=None)
    e.add_argument("--repo", default=None, help="per-repo cap key (default: cwd)")
    e.add_argument("--priority", type=int, default=0)
    e.add_argument("--max-attempts", type=int, default=3)
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
    w = s.add_parser("wait-on", help="park a job on an event id")
    w.add_argument("id", type=int)
    w.add_argument("event")
    r = s.add_parser("release", help="release jobs waiting on an event id")
    r.add_argument("event")
    x = s.add_parser("cancel")
    x.add_argument("id")
    s.add_parser("stats")
    d = s.add_parser("dead", help="dead-letter operations")
    d.add_argument("action", choices=["retry"])
    d.add_argument("id", type=int, nargs="?")
    s.add_parser("daemon", help="run the dispatcher")
    return p


def _main_dbos(a) -> int:
    from fleet import dbos_backend as b
    if a.verb == "enqueue":
        kind = "acp" if a.acp else "cmd"
        if kind == "acp":
            payload = {"agent": a.acp, "cwd": os.path.abspath(a.cwd), "prompt": a.prompt}
            for k in ("registry", "model"):
                if getattr(a, k):
                    payload[k] = getattr(a, k)
        else:
            cmd = [t for t in a.cmd if t != "--"] if a.cmd[:1] == ["--"] else a.cmd
            if not cmd:
                sys.exit("enqueue: no command given")
            payload = {"cmd": cmd[0] if a.shell else cmd, "cwd": a.cwd}
        if a.repo:
            payload["repo"] = a.repo
        print(b.enqueue(payload, kind=kind, priority=a.priority, max_attempts=a.max_attempts))
    elif a.verb == "status":
        for r in b.status(a.id):
            print(json.dumps(r))
    elif a.verb == "cancel":
        b.cancel(a.id)
    elif a.verb == "stats":
        print(json.dumps(b.stats()))
    elif a.verb == "dead":
        print(*b.retry_dead(a.id))
    else:
        sys.exit(f"{a.verb}: not supported on the dbos backend (spike)")
    return 0


def main(argv=None) -> int:
    a = build().parse_args(argv)
    if a.verb == "daemon":
        if DBOS:
            from fleet import dbos_backend
            try:
                dbos_backend.run()
            except KeyboardInterrupt:
                pass
            return 0
        from fleet import daemon
        try:
            daemon.run()
        except KeyboardInterrupt:
            pass
        return 0
    if DBOS:
        return _main_dbos(a)
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
        jid = q.enqueue(c, payload, kind=kind, priority=a.priority, max_attempts=a.max_attempts)
        if a.wait_on:
            q.wait_on(c, jid, a.wait_on)
        print(jid)
    elif a.verb == "status":
        cols = "id,kind,status,priority,attempts,max_attempts,waiting_on,lease_owner,lease_expires_at,pgid,payload"
        if a.id is not None:
            cur = c.execute(f"SELECT {cols} FROM jobs WHERE id=?", (a.id,))
            row = cur.fetchone()
            if not row:
                sys.exit(f"no job {a.id}")
            print(json.dumps(dict(zip([d[0] for d in cur.description], row)), indent=2))
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
    elif a.verb == "dead":
        print(*q.retry_dead(c, a.id))
    return 0


if __name__ == "__main__":
    sys.exit(main())
