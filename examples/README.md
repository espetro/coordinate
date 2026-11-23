# Examples

- `plugins/ntfy-push`: a plugin that forwards job events to an [ntfy](https://ntfy.sh) topic. It is an executable that reads one JSON event on stdin, plus a `.plugin.toml` that declares its name, interface and timeout. Set `NTFY_TOPIC` to send events, or leave it unset to print them to stderr. The plugin contract is in `.agents/docs/extensibility.md`.
