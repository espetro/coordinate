// Dispatcher daemon: claim loop, subprocess execution, lease heartbeat, reaper.
// cmd jobs run as shell children; acp jobs (port of the Python ACP lane) go through
// spawnAcpJob in acp.ts: JSON-RPC over the agent's stdio, session persisted for resume.
// Python's Popen raised OSError synchronously and the loop recorded `failed` (daemon.py:307-309);
// node reports the same failures asynchronously as an `error` event on the ChildProcess, so
// spawnJob passes the running list down and spawnRaw marks the entry on error instead of
// letting the unhandled event crash the daemon.

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configPath, dbPath } from "./env.ts";
import { Database } from "@cutils/sqlite";
import * as q from "./queue.ts";
import type { AcpHandle } from "./acp.ts";
import { acpPayloadOf, startAcpJob } from "./acp.ts";
import { ConfigError, DEFAULT_TOOL_CLASSES, slotLimit, validateConfig } from "./config.ts";
import { matchToolClass, projectKey, shlexSplit, toolSlotKey, which } from "./toolclass.ts";
import * as up from "./upgrade.ts";
// Effect v4 for the daemon's async machinery: the claim loop, the backoff
// sleep, the stop contract and the singleton-takeover probe. Deep module paths
// keep the static build small (each Effect module compiles on its own) and the
// import style is function-style, which is what Effect v4's tree-shaking
// expects.
import { gen, runPromise, race, sleep, succeed, sync } from "effect/Effect";
import type { Effect } from "effect/Effect";
import { makeUnsafe as makeDeferredUnsafe, await as awaitDeferred, doneUnsafe as completeDeferred } from "effect/Deferred";
import { millis as durationMillis } from "effect/Duration";

const BACKOFF_MAX = 2.0;
const BACKOFF_MIN = 0.05;
// How long the daemon may take to shut down after SIGTERM/SIGINT before it
// exits anyway. The normal path is milliseconds; the budget exists so a
// pathological close can never make the daemon look like it ignores the
// signal (measured on v0.1.3: 29 s of 100% CPU before the process fell out).
const SHUTDOWN_BUDGET_MS = 5000;
const SH = process.platform === "win32" ? "cmd.exe" : "/bin/sh";

// Completing a Deferred from outside the Effect world (a signal handler)
// needs the completion effect, not the value: doneUnsafe takes an Effect.
function syncStop(): Effect<"stop"> {
  return succeed("stop" as const);
}

function syncInterrupt(): Effect<"interrupt"> {
  return succeed("interrupt" as const);
}

interface Running {
  jid: number;
  proc: cp.ChildProcess;
  spawnErrored?: boolean;
}

// An in-flight ACP agent-session job: the spawnAcpJob promise drives the protocol
// (session/new or session/load, then session/prompt) and settles on completion.
interface RunningAcp {
  jid: number;
  handle: AcpHandle;
  settled: boolean;
}

class Parked {
  key: string;
  constructor(key: string) {
    this.key = key;
  }
}




function auditSpawn(db: Database, jid: number, argv0: string, cls: string, proj: string): void {
  q.qRun(db, "INSERT INTO spawn_audit(ts,job_id,argv0,tool_class,project) VALUES(?,?,?,?,?)", [
    Date.now() / 1000,
    jid,
    argv0,
    cls,
    proj,
  ]);
}

function acquireToolLease(db: Database, jid: number, key: string, cost: number): boolean {
  return q.acquireLease(db, key, "job:" + jid, cost) !== null;
}

interface DeadlineRow {
  deadline_at: number | null;
}

// Absolute epoch-second deadline of this attempt, set at claim; empty when the job has no cap.
function deadlineEnv(db: Database, jid: number): string {
  const rows = q.qAll(db, "SELECT deadline_at FROM jobs WHERE id=?", [jid]) as DeadlineRow[];
  if (rows.length === 0 || rows[0].deadline_at === null) {
    return "";
  }
  return String(rows[0].deadline_at);
}

interface AttemptRow {
  attempts: number;
  max_attempts: number;
}

// Attempt numbers let a retried job detect replay and stay idempotent (D17:
// at-least-once execution means a killed attempt can replay side effects).
function attemptEnv(db: Database, jid: number): { attempt: string; maxAttempts: string } {
  const rows = q.qAll(db, "SELECT attempts, max_attempts FROM jobs WHERE id=?", [jid]) as AttemptRow[];
  if (rows.length === 0) {
    return { attempt: "", maxAttempts: "" };
  }
  return { attempt: String(rows[0].attempts), maxAttempts: String(rows[0].max_attempts) };
}

function jobEnv(jid: number, deadlineAt: string, attempt: string, maxAttempts: string): Record<string, string> {
  const e: Record<string, string> = {};
  for (const k of Object.keys(process.env)) {
    const v = process.env[k];
    if (v !== undefined && !k.startsWith("COORDINATE_") && !k.startsWith("FLEET_")) {
      e[k] = v;
    }
  }
  e["COORDINATE_JOB_ID"] = String(jid);
  e["FLEET_JOB_ID"] = String(jid);
  e["COORDINATE_MACHINE"] = q.MACHINE;
  e["FLEET_MACHINE"] = q.MACHINE;
  e["COORDINATE_DB"] = dbPath();
  e["FLEET_DB"] = dbPath();
  e["COORDINATE_DEADLINE_AT"] = deadlineAt;
  e["FLEET_DEADLINE_AT"] = deadlineAt;
  e["COORDINATE_ATTEMPT"] = attempt;
  e["COORDINATE_MAX_ATTEMPTS"] = maxAttempts;
  return e;
}

// A shlex.split-style splitter for the scriptc subset: POSIX-style single and double quotes,
// backslash escapes outside single quotes. Like shlex.split, an unterminated quote returns
// null (Python raises ValueError); the caller then treats the string as unmatched.

function argv0Of(kind: string, payload: q.Payload): string | null {
  if (kind !== "cmd") {
    return null;
  }
  const cmd = payload.cmd;
  let toks: string[] | null = null;
  if (typeof cmd === "string") {
    toks = shlexSplit(cmd);
  } else if (Array.isArray(cmd)) {
    toks = cmd;
  }
  if (toks === null || toks.length === 0) {
    return null;
  }
  if (toks[0] === "sh" || toks[0] === "bash" || toks[0] === "zsh") {
    for (let i = 0; i < toks.length; i++) {
      if (toks[i] === "-c" && i + 1 < toks.length) {
        const inner = shlexSplit(toks[i + 1]);
        if (inner === null || inner.length === 0) {
          return null;
        }
        return inner[0];
      }
    }
    return null;
  }
  return toks[0];
}

function spawnJob(db: Database, jid: number, owner: string, kind: string, payload: q.Payload, running: Running[], runningAcp: RunningAcp[]): cp.ChildProcess {
  if (kind === "acp") {
    // ACP lane: no tool-class matching, no shell; the agent gets pipes and JSON-RPC.
    // Its stdout carries the protocol, so only stderr goes to a log file.
    const att = attemptEnv(db, jid);
    const attempt = Number(att.attempt);
    const opened = q.openLogFiles(jid, attempt, false);
    if (opened !== null) {
      q.recordLogFiles(db, jid, attempt, opened.pair);
    }
    const handle = startAcpJob(
      db,
      jid,
      owner,
      acpPayloadOf(payload),
      jobEnv(jid, deadlineEnv(db, jid), att.attempt, att.maxAttempts),
      opened === null ? null : opened.stderrFd,
    );
    runningAcp.push({ jid, handle, settled: false });
    return handle.proc;
  }
  const argv0 = argv0Of(kind, payload);
  if (argv0 === null) {
    return spawnRaw(db, jid, owner, kind, payload, running);
  }
  const resolved = which(argv0);
  const m = matchToolClass(resolved === null ? argv0 : resolved);
  if (m === null) {
    return spawnRaw(db, jid, owner, kind, payload, running);
  }
  const proj = projectKey(payload.cwd);
  auditSpawn(db, jid, argv0, m.cls, proj);
  const key = toolSlotKey(m.cls, proj);
  if (m.cost > slotLimit(key)) {
    // never grantable: config error, not contention
    q.finish(db, jid, owner, "failed");
    throw new Parked(key);
  }
  if (!acquireToolLease(db, jid, key, m.cost)) {
    q.waitOn(db, jid, key); // D7 park-at-boundary
    throw new Parked(key);
  }
  return spawnRaw(db, jid, owner, kind, payload, running);
}

function spawnRaw(db: Database, jid: number, owner: string, kind: string, payload: q.Payload, running: Running[]): cp.ChildProcess {
  const cmd = payload.cmd;
  // Output capture: the child's stdout and stderr fds are the attempt's log
  // files when they open; otherwise the daemon inherits (the old behavior).
  // The files open only after every parking boundary, so a job that goes back
  // to waiting_on never gets an empty phantom attempt log.
  const attemptNow = q.currentAttempt(db, jid);
  const opened = q.openLogFiles(jid, attemptNow, true);
  let logFds: { stdoutFd: number; stderrFd: number } | null = null;
  if (opened !== null) {
    q.recordLogFiles(db, jid, attemptNow, opened.pair);
    logFds = { stdoutFd: opened.stdoutFd, stderrFd: opened.stderrFd };
  }
  const stdio: ("ignore" | "inherit" | number)[] =
    logFds === null ? ["ignore", "inherit", "inherit"] : ["ignore", logFds.stdoutFd, logFds.stderrFd];
  const att = attemptEnv(db, jid);
  const opts = { cwd: payload.cwd === null ? undefined : payload.cwd, detached: true, env: jobEnv(jid, deadlineEnv(db, jid), att.attempt, att.maxAttempts), stdio };
  const win = process.platform === "win32";
  const proc =
    typeof cmd === "string"
      ? win
        ? cp.spawn(SH, ["/c", cmd], opts)
        : cp.spawn(SH, ["-c", cmd], opts)
      : cp.spawn(cmd[0], cmd.slice(1), opts);
  // The parent's copies of the fds close right after the spawn: the child
  // holds its own dup2'd copies, and an open parent fd would keep the log
  // files' contents in the kernel buffer past the child's exit.
  if (logFds !== null) {
    fs.closeSync(logFds.stdoutFd);
    fs.closeSync(logFds.stderrFd);
  }
  // The handler must be attached before the pid check: on Linux, cp.spawn reports ENOENT
  // with pid already undefined, and the 'error' event still arrives on the next tick. An
  // unhandled 'error' event crashes the whole daemon.
  proc.on("error", (err: Error) => {
    const r = running.find((x) => x.jid === jid);
    if (r !== undefined) {
      r.spawnErrored = true;
    }
    const event = q.finish(db, jid, owner, "failed", "spawn failed: " + err.message, null);
    if (event !== null) {
      q.release(db, event);
    }
  });
  if (proc.pid === undefined || proc.pid === null) {
    // Spawn failed synchronously (bad cwd, permission): Python's Popen would have raised here.
    q.finish(db, jid, owner, "failed", "spawn failed");
    return proc;
  }
  q.setProc(db, jid, owner, proc.pid);
  return proc;
}

function killGroup(proc: cp.ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined || pid === null || pid <= 1) {
    return;
  }
  if (process.platform === "win32") {
    // Windows has no process groups: the detached child is its own leader, so
    // the direct pid is the best available kill target. Sibling leaks in a
    // shell pipeline are accepted for v0.1.0 (the shim runs one command).
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

// Startup can race another process that is still initializing or checkpointing
// the queue database. That lock is transient, just like lock loss inside the
// claim loop, so the daemon retries it instead of exiting before the first turn.
async function retryStartup<T>(op: () => T): Promise<T> {
  let last: unknown = null;
  for (let i = 0; i < 5; i++) {
    try {
      return op();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/locked|busy/i.test(msg)) {
        throw e;
      }
      last = e;
      if (i < 4) {
        await runPromise(sleep(durationMillis(150 + i * 100)));
      }
    }
  }
  throw last;
}

async function connectWithRetry(): Promise<Database> {
  return retryStartup(() => q.connect());
}

export async function run(): Promise<void> {
  try {
    validateConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write("coordinate: invalid config: " + e.message + "\n");
    } else {
      process.stderr.write("coordinate: " + String(e instanceof Error ? e.message : e) + "\n");
    }
    process.exit(1);
  }
  const db = await connectWithRetry();
  const owner = os.hostname() + ":" + process.pid;
  // Singleton: only one dispatcher per DB. The claim is atomic against the
  // daemon table row (SQLite-only, no flock/pgrep); a stale heartbeat from a
  // crashed daemon is claimable, a fresh one refuses this start. A SIGKILLed
  // daemon can leave a "fresh" heartbeat behind for up to one lease interval,
  // so on conflict this start briefly probes the row: a heartbeat that stops
  // advancing belongs to a dead daemon and is taken over instead.
  const conflict: { v: number | null } = { v: null };
  if (!(await retryStartup(() => q.claimDaemon(db, process.pid, conflict)))) {
    const ts0 = q.daemonHeartbeatTs(db);
    let takenOver = false;
    // The takeover probe waits a second per attempt and gives up early when
    // SIGINT arrives, so an interrupted start does not linger.
    const interrupt = makeDeferredUnsafe<"interrupt">();
    const onSigint = (): void => {
      completeDeferred(interrupt, syncInterrupt());
    };
    process.once("SIGINT", onSigint);
    try {
      for (let i = 0; i < 8; i++) {
        const signal = await runPromise(
          race(sleep(durationMillis(1000)), awaitDeferred(interrupt)),
        );
        if (signal === "interrupt") {
          break;
        }
        if (await retryStartup(() => q.claimDaemon(db, process.pid, conflict))) {
          takenOver = true;
          break;
        }
        if (q.daemonHeartbeatTs(db) !== ts0) {
          break; // row refreshed: the other daemon is alive
        }
      }
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
    if (!takenOver) {
      process.stderr.write("daemon already running (pid " + conflict.v + ")\n");
      db.close();
      process.exit(1);
    }
  }
  const running: Running[] = [];
  const runningAcp: RunningAcp[] = [];
  let delay = BACKOFF_MIN;
  let lastHb = 0.0;
  let lastReap = 0.0;
  // Implicit upgrade surface: when this daemon runs a compiled coordinate
  // binary (not the node shim), watch the binary file itself. A package
  // manager swap (mise/brew/install.sh) changes the inode or contents; once
  // the change is stable across two checks the daemon spawns its replacement
  // and exits through the normal stop path — so `mise upgrade` alone is the
  // whole upgrade procedure. Safe by the durability contract. Opt out with
  // COORDINATE_NO_AUTO_UPGRADE=1.
  const selfBin = path.basename(process.execPath).startsWith("coordinate") ? process.execPath : null;
  const fp0 = selfBin === null ? null : up.binFingerprint(selfBin);
  let fpPending: up.BinFingerprint | null = null;
  // Stop contract (ARCHITECTURE.md, durability): agents keep working when the orchestrator
  // stops. SIGTERM/SIGINT stop the claim loop and exit cleanly; running children are detached
  // (handles unref'd) and left alive. The next daemon start reaps their expired leases (X3).
  // Effect models the stop signal as a Deferred the loop races against its sleep:
  // the signal handler completes the Deferred, which wakes the sleep at once.
  //
  // The handler does the minimum: it marks the stop and wakes the loop. Closing
  // the DB happens once, after the loop has drained, in the shutdown path below.
  // Closing inside the handler is what made SIGTERM and SIGINT look ignored:
  // Node only delivers signal handlers between macrotasks, so a long
  // synchronous close inside the handler delayed the handler's own completion
  // and the user saw a daemon that burned CPU until it eventually fell out
  // (measured 29 s on a churned queue, v0.1.3).
  const stopSignal = makeDeferredUnsafe<"stop">();
  let stopping = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const r of running) {
      r.proc.unref();
      // Detached children keep their own process group; no kill: the job outlives the daemon.
    }
    completeDeferred(stopSignal, syncStop());
    // Backstop: if the loop does not reach the shutdown path in time, leave
    // anyway. A daemon that ignores its stop signal is worse than one that
    // exits with an unfinished checkpoint: the queue state is durable in the
    // WAL and the next start reaps the expired leases.
    shutdownTimer = setTimeout(() => {
      process.stderr.write("coordinate: shutdown exceeded " + String(SHUTDOWN_BUDGET_MS) + "ms, exiting\n");
      process.exit(0);
    }, SHUTDOWN_BUDGET_MS);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const exitProc = (r: Running, code: number | null): void => {
    // The exit code rides in the job's outcome column, so the live row says
    // why the attempt failed without reading the event history.
    const note = code === null ? null : code === 0 ? null : "exit code " + String(code);
    const event = q.finish(db, r.jid, owner, code === 0 ? "done" : "failed", note, code);
    if (event !== null) {
      q.release(db, event); // D7 wake: released jobs are picked up by the claim loop
    }
  };

  // One turn of the claim loop: reap the timed out, settle the finished jobs,
  // heartbeat the leases, then claim and spawn up to the machine cap.
  const turn = (): boolean => {
    let busy = false;
    const now = Date.now() / 1000;

    for (const row of q.expiredRunning(db)) {
      const payload = JSON.parse(row.payload) as q.Payload;
      if (row.kind === "acp") {
        // Timecap on an ACP job: ask the turn to stop first (best effort), like
        // daemon.py _acp_cancel, then the shared TERM path runs below.
        for (let i = 0; i < runningAcp.length; i++) {
          if (runningAcp[i].jid === row.id) {
            const sid = runningAcp[i].handle.sessionId;
            if (sid !== null) {
              runningAcp[i].handle.client.cancel(sid);
            }
          }
        }
      }
      q.finalizeTimedOut(db, row.id, "max runtime exceeded");
      // cmd lane: no recorded process to kill in this spike beyond best-effort pgid
      if (row.pgid !== null && row.pgid > 1) {
        try {
          // Windows has no process groups; kill the recorded pid directly.
          const target = process.platform === "win32" ? row.pgid : -row.pgid;
          process.kill(target, "SIGTERM");
        } catch {
          // gone
        }
      }
      void payload;
      busy = true;
    }

    // ACP completion poll: the protocol promise settles when the turn ends.
    for (let i = runningAcp.length - 1; i >= 0; i--) {
      const ra = runningAcp[i];
      if (ra.handle.settled) {
        const event = q.finish(db, ra.jid, owner, ra.handle.done && ra.handle.failure === null ? "done" : "failed", ra.handle.failure);
        if (event !== null) {
          q.release(db, event);
        }
        runningAcp.splice(i, 1);
        busy = true;
      }
    }

    for (let i = running.length - 1; i >= 0; i--) {
      const r = running[i];
      // spawn errors: node emits "error"; a missing binary exits with code 127 via sh
      if (r.proc.exitCode !== null || r.proc.signalCode !== null || r.spawnErrored === true) {
        exitProc(r, r.proc.exitCode);
        running.splice(i, 1);
        busy = true;
      }
    }

    if (now - lastHb >= q.LEASE_S / 3) {
      for (let i = running.length - 1; i >= 0; i--) {
        const r = running[i];
        if (!q.heartbeat(db, r.jid, owner)) {
          killGroup(r.proc);
          running.splice(i, 1);
        }
      }
      for (let i = runningAcp.length - 1; i >= 0; i--) {
        const ra = runningAcp[i];
        if (!q.heartbeat(db, ra.jid, owner)) {
          killGroup(ra.handle.proc);
          runningAcp.splice(i, 1);
        }
      }
      lastHb = now;
    }

    if (now - lastReap >= q.LEASE_S / 3) {
      if (selfBin !== null && fp0 !== null && process.env["COORDINATE_NO_AUTO_UPGRADE"] !== "1") {
        const fpNow = up.binFingerprint(selfBin);
        if (fpNow !== null && !up.sameFingerprint(fp0, fpNow)) {
          if (fpPending !== null && up.sameFingerprint(fpPending, fpNow)) {
            // Stable across two checks: the swap is complete. Hand off.
            q.emit(db, null, "upgrade_detected", { bin: selfBin, pid: process.pid });
            process.stderr.write("coordinate: binary changed on disk, spawning replacement daemon\n");
            up.spawnDaemon(selfBin);
            stop();
          } else {
            fpPending = fpNow;
          }
        } else {
          fpPending = null;
        }
      }
      q.reap(db);
      // Generalized lease maintenance: expire TTLs, reap dead pid owners and
      // drain FIFO waiters, so grants land even when no acquirer is polling
      // (async consumers such as parked jobs depend on this).
      {
        using _tx = q.writeTx(db);
        q.maintainLeases(db, []);
      }
      lastReap = now;
    }

    // Singleton heartbeat: refresh the daemon row every tick so doctor can
    // tell an idle dispatcher from a dead one (fresh ts = alive).
    q.daemonHeartbeat(db, process.pid);

    // The cap is read per turn, so `coordinate cap set` raises or lowers it
    // without a daemon restart. Lowering never interrupts the jobs already
    // running: the loop simply stops claiming until the count drains.
    while (running.length + runningAcp.length < q.machineCap(db)) {
      const got = q.claim(db, owner);
      if (got === null) {
        break;
      }
      busy = true;
      try {
        const proc = spawnJob(db, got.jid, owner, got.kind, got.payload, running, runningAcp);
        if (got.kind !== "acp") {
          // ACP jobs are tracked in runningAcp; their proc exit is not the completion signal.
          running.push({ jid: got.jid, proc });
        }
      } catch (e) {
        if (e instanceof Parked) {
          busy = true; // parked at the heavy-spawn boundary, no worker spawned
        } else {
          q.finish(db, got.jid, owner, "failed");
        }
      }
    }

    return busy;
  };

  // The claim loop: a turn, then a backoff sleep that a stop signal cuts
  // short. The sleep is a real timer (issue #5: a setImmediate pump spins one
  // core at ~100%), so the daemon parks in the kernel while idle and still
  // delivers SIGTERM/SIGINT between macrotasks.
  //
  // A turn can lose a race for the SQLite write lock (another process holds
  // it, or WAL setup needs an exclusive lock). That is transient, so the turn
  // is retried on the next tick instead of killing the daemon: an unhandled
  // SQLITE_BUSY here used to exit the process and lose the queue with it.
  const program = gen(function* () {
    while (true) {
      let busy = false;
      try {
        busy = yield* sync(() => turn());
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/locked|busy/i.test(msg)) {
          // Transient lock contention: back off a little and try again.
          process.stderr.write("coordinate: database busy, retrying: " + msg + "\n");
          delay = Math.max(delay, 0.1);
        } else {
          throw e;
        }
      }
      delay = busy ? BACKOFF_MIN : Math.min(delay * 2, BACKOFF_MAX);
      const signal = yield* race(sleep(durationMillis(delay * 1000)), awaitDeferred(stopSignal));
      if (signal === "stop") {
        return;
      }
    }
  });

  await runPromise(program);
  // Shutdown path: the loop has drained, running children are detached, so
  // closing the DB here is safe. The statement-tracking helpers in queue.ts
  // keep the tracked list short, so this close is milliseconds, not seconds.
  try {
    // A cleanly stopped daemon holds no claim: releasing the row lets a
    // replacement (auto-upgrade or `daemon restart`) take over at once
    // instead of waiting out the staleness probe.
    q.qRun(db, "DELETE FROM daemon WHERE id=1 AND pid=?", [process.pid]);
    db.close();
  } catch {
    // already closed by a concurrent turn
  }
  if (shutdownTimer !== null) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}
