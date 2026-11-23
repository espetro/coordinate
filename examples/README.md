# Examples

- `ntfy-forward.sh`: sends every job event to an [ntfy](https://ntfy.sh) topic with `coordinate forward --exec`. Set `NTFY_TOPIC` and run it next to the daemon. Any other tool works the same way, because the command receives each event as JSON on stdin.
