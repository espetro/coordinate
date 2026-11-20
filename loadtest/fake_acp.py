#!/usr/bin/env python3
"""Zero-token stand-in for `fleet-acp`, used by `run.py --fake-acp` to self-test the acp scenarios.

Mimics the contract the daemon relies on:
- stdout line 1 is {"sessionId": ...} (stable per cwd, so --session resumes the same id)
- the "agent" is a detached process in its own session, its pid goes to --pid-file
- the task is a fake `sleep N` taken from the prompt (sum of "sleep N" mentions, default 3s), then hello.txt + git commit
- exit 0 on success; exit 1 when the registry command is not an existing binary or the model is "bad"
- on exit the agent group gets SIGTERM (like the real wrapper)
Like the real one, it is killed by the daemon with SIGKILL on cancel, which leaves the detached agent alive.
"""
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time


def main(argv):
    if argv[0] != "run":
        return 2
    agent, rest = argv[1], argv[2:]
    opt = {rest[i].lstrip("-"): rest[i + 1] for i in range(0, len(rest) - 1, 2) if rest[i].startswith("--")}
    cwd, prompt = opt["cwd"], opt["prompt"]
    reg = json.load(open(opt["registry"])) if "registry" in opt else {}
    spec = reg.get(agent, {})
    model = opt.get("model") or spec.get("model")
    command = spec.get("command", "sleep")
    if not shutil.which(command):
        print(f"fleet-acp: cannot spawn {command}", file=sys.stderr)
        return 1
    session = opt.get("session") or "fake-" + hashlib.sha1(cwd.encode()).hexdigest()[:12]
    print(json.dumps({"sessionId": session}), flush=True)
    if model and ("bad" in model or "does-not-exist" in model):
        print("fleet-acp: set_model failed", file=sys.stderr)
        return 1
    agent_proc = subprocess.Popen(["sleep", "600"], start_new_session=True,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if "pid-file" in opt:
        with open(opt["pid-file"], "w") as f:
            f.write(str(agent_proc.pid))
    secs = sum(int(n) for n in re.findall(r"sleep (\d+)", prompt)) or 3
    time.sleep(secs)
    with open(os.path.join(cwd, "hello.txt"), "w") as f:
        f.write("hello\n")
    subprocess.run(["git", "-C", cwd, "add", "-A"], check=True)
    subprocess.run(["git", "-C", cwd, "commit", "-q", "-m", "loadtest: add hello"], check=True)
    try:
        os.killpg(agent_proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    agent_proc.wait()
    print(json.dumps({"stopReason": "end_turn"}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
