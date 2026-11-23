"""Restate services implementing the fleet job semantics: machine cap via flow-control scope,
repo cap via limit key, weighted tool leases via a Virtual Object plus awakeables.
"""
import asyncio
import hashlib
import json
import os
import subprocess
import tomllib
from datetime import timedelta

from restate import Context, ObjectContext, Service, TerminalError, VirtualObject, app

MATCH_NAMES = {
    "vitest": ("vitest", 2), "jest": ("jest", 2), "tsc": ("tsc", 2), "cargo": ("cargo", 2),
    "pytest": ("pytest", 2), "ruff": ("ruff", 1), "eslint": ("eslint", 2), "webpack": ("webpack", 2),
    "vite": ("vite", 2), "make": ("make", 2), "cmake": ("cmake", 2), "gradle": ("gradle", 2),
    "maven": ("maven", 2), "go": ("go", 1), "docker": ("docker", 2), "terraform": ("terraform", 2),
    "playwright": ("playwright", 2), "cypress": ("cypress", 2), "next": ("next", 2),
}


def repo_key(cwd: str) -> str:
    return "r" + hashlib.sha1(os.path.abspath(cwd).encode()).hexdigest()[:16]


def tool_key(cmd: str) -> tuple[str, int] | None:
    """(class, cost) if the command's first token matches a heavy tool class."""
    tok = cmd.strip().split()
    if not tok:
        return None
    name = os.path.basename(tok[0])
    return MATCH_NAMES.get(name)


def slots_config() -> dict[str, int]:
    path = os.environ.get("COORDINATE_CONFIG")
    if not path or not os.path.exists(path):
        return {}
    with open(path, "rb") as f:
        cfg = tomllib.load(f)
    return {str(k): int(v) for k, v in (cfg.get("slots") or {}).items()}


service = Service("JobRunner", inactivity_timeout=timedelta(hours=2))
lease = VirtualObject("ToolLease", inactivity_timeout=timedelta(hours=2))


async def exec_job(ctx: Context, job: dict) -> None:
    """Spawn the shell command as its own process group + session, wait, fail on nonzero."""
    data_dir = os.path.dirname(os.environ.get("COORDINATE_DB", "/tmp/fleet.db"))

    def spawn_and_wait() -> int:
        os.makedirs(data_dir, exist_ok=True)
        log_path = os.path.join(data_dir, f"job-{job['id']}.log")
        env = {**os.environ, **job.get("env", {})}
        with open(log_path, "ab") as log:
            p = subprocess.Popen(["/bin/sh", "-c", job["cmd"]], cwd=job["cwd"], env=env,
                                 stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                                 start_new_session=True)
            return p.wait()

    code = await ctx.run("exec", spawn_and_wait)
    if code != 0:
        raise TerminalError(f"job {job['id']} exited {code}", status_code=400)


@service.handler()
async def run(ctx: Context, job: dict) -> str:
    cfg = slots_config()
    tk = tool_key(job["cmd"])
    if tk:
        cls, cost = tk
        proj = repo_key(job["cwd"])
        lk = f"t{hashlib.sha1(f'{cls}:{proj}'.encode()).hexdigest()[:12]}"
        limit = cfg.get(f"{cls}:*") or cfg.get(f"tool:{cls}:*") or 1
        while not await ctx.object_call(ToolLease_acquire, lk, {"key": lk, "limit": limit,
                                                                "cost": cost}):
            await ctx.sleep(timedelta(milliseconds=200))
        await exec_job(ctx, job)
        await ctx.object_call(ToolLease_release, lk, cost)
    else:
        await exec_job(ctx, job)
    return "done"


@lease.handler()
async def acquire(ctx: ObjectContext, req: dict) -> bool:
    held = await ctx.get("held") or 0
    if int(held) + req["cost"] <= req["limit"]:
        ctx.set("held", int(held) + req["cost"])
        return True
    return False


@lease.handler()
async def release(ctx: ObjectContext, cost: int) -> None:
    held = await ctx.get("held") or 0
    ctx.set("held", max(0, int(held) - int(cost)))
    # wake the parked (truly suspended) waiters, if any: the suspension variant registers its
    # awakeable ids here on a failed acquire; the polling variant never touches `waiters`, so
    # this is a no-op for it and both paths stay comparable.
    waiters = await ctx.get("waiters") or []
    for aid in waiters:
        ctx.resolve_awakeable(aid, "wake")
    if waiters:
        ctx.set("waiters", [])


@lease.handler()
async def acquire_or_park(ctx: ObjectContext, req: dict) -> bool:
    """acquire if the weighted lease has room, else register the caller's awakeable id.

    Returning True means the caller holds the lease. Returning False means the caller must
    await its awakeable: the invocation suspends until release resolves it.
    """
    held = await ctx.get("held") or 0
    if int(held) + req["cost"] <= req["limit"]:
        ctx.set("held", int(held) + req["cost"])
        return True
    waiters = await ctx.get("waiters") or []
    waiters.append(req["awakeable_id"])
    ctx.set("waiters", waiters)
    return False


# True suspension variant: same job semantics as JobRunner.run, but a failed lease acquire
# parks the invocation on a durable awakeable instead of a 200ms sleep poll. The invocation
# leaves the running set while parked (sys_invocation status 'suspended') and is woken by the
# lease holder's release, which resolves every registered awakeable id.
service_s = Service("JobRunnerSuspended", inactivity_timeout=timedelta(hours=2))


@service_s.handler()
async def run_suspended(ctx: Context, job: dict) -> str:
    cfg = slots_config()
    tk = tool_key(job["cmd"])
    if tk:
        cls, cost = tk
        proj = repo_key(job["cwd"])
        lk = f"t{hashlib.sha1(f'{cls}:{proj}'.encode()).hexdigest()[:12]}"
        limit = cfg.get(f"{cls}:*") or cfg.get(f"tool:{cls}:*") or 1
        while True:
            aid, fut = ctx.awakeable(type_hint=str)
            if await ctx.object_call(ToolLease_acquire_or_park, lk,
                                     {"key": lk, "limit": limit, "cost": cost,
                                      "awakeable_id": aid}):
                break
            await fut
        await exec_job(ctx, job)
        await ctx.object_call(ToolLease_release, lk, cost)
    else:
        await exec_job(ctx, job)
    return "done"


app = app([service, lease, service_s])


ToolLease_acquire = lease.handlers["acquire"].fn
ToolLease_release = lease.handlers["release"].fn
ToolLease_acquire_or_park = lease.handlers["acquire_or_park"].fn
