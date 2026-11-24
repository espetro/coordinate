#!/bin/sh
# run-acp.sh AGENT CWD PROMPT_FILE [SESSION_ID]
# Job entry point for the real-agent bench. Sets PATH and BIFROST_API_KEY (the
# job env is the daemon's env, so the key is pulled from the macOS keychain at
# job start, never written to disk or stored in the queue payload), then runs
# the ACP client. Client stdout lands in <cwd>/client.jsonl: line 1 is the
# sessionId record, line 2 the stopReason.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="$1"; CWD="$2"; PROMPT_FILE="$3"; SESSION="${4:-}"

export PATH="$HERE/agents-bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$HOME/Library/pnpm/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

if [ -z "${BIFROST_API_KEY:-}" ]; then
  BIFROST_API_KEY="$(security find-generic-password -s bifrost -a "$USER" -w 2>/dev/null)" \
    || BIFROST_API_KEY="$(security find-generic-password -s bifrost -w 2>/dev/null)" \
    || true
fi
export BIFROST_API_KEY

mkdir -p "$CWD"
cd "$CWD"
PROMPT="$(cat "$PROMPT_FILE")"

NODE="${NODE:-$(command -v node)}"
if [ -n "$SESSION" ]; then
  "$NODE" "$HERE/acp-client.ts" run "$AGENT" --cwd "$CWD" --prompt "$PROMPT" --session "$SESSION" \
    >> "$CWD/client.jsonl" 2>> "$CWD/client.err"
else
  "$NODE" "$HERE/acp-client.ts" run "$AGENT" --cwd "$CWD" --prompt "$PROMPT" \
    >> "$CWD/client.jsonl" 2>> "$CWD/client.err"
fi
