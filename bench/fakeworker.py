"""Fake TUI workload for the terminal-fallback bench: prints READY, echoes each
stdin line as ECHO:<line>, exits on 'quit'. Stdlib only, no agent."""
import sys

print("READY tfspike", flush=True)
for line in sys.stdin:
    msg = line.strip()
    if msg == "quit":
        print("BYE", flush=True)
        break
    print(f"ECHO:{msg}", flush=True)
print("EXIT", flush=True)
