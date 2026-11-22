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
    path = os.environ.get("FLEET_CONFIG")
    if not path or not os.path.exists(path):
        return {}
    with open(path, "rb") as f:
        cfg = tomllib.load(f)
    return {str(k): int(v) for k, v in (cfg.get("slots") or {}).items()}


service = Service("JobRunner", inactivity_timeout=timedelta(hours=2))
lease = VirtualObject("ToolLease", inactivity_timeout=timedelta(hours=2))


async def exec_job(ctx: Context, job: dict) -> None:
    """Spawn the shell command as its own process group + session, wait, fail on nonzero."""
    data_dir = os.path.dirname(os.environ.get("FLEET_DB", "/tmp/fleet.db"))

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


app = app([service, lease])


ToolLease_acquire = lease.handlers["acquire"].fn
ToolLease_release = lease.handlers["release"].fn
