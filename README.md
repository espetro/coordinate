<h1 align="center">coordinate</h1>

<p align="center">A durable job queue for your machines and your coding agents.</p>

<p align="center">
  <a href="https://github.com/espetro/coordinate/releases"><img src="https://img.shields.io/github/v/release/espetro/coordinate" alt="latest release" /></a>
  <a href="https://github.com/espetro/coordinate/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license: Apache-2.0" /></a>
</p>

```sh
curl -fsSL https://raw.githubusercontent.com/espetro/coordinate/main/install.sh | sh

coordinate daemon &
coordinate enqueue --shell -- 'pnpm test && pnpm build'
coordinate status
coordinate events --follow
```

## Why

- Enqueue in 5 ms and drain 69 jobs per second on a 6-core VPS.
- The daemon idles at 5.9 MB, and the whole tool is one 4 MB binary.
- 10,000 parked jobs take 3 MB of disk and no process.
- Jobs are SQLite rows. A crash or a reboot expires a lease, and the job runs again.
- Per-machine and per-repo caps, named slots, priorities, retries, deadlines and an event stream.

| Measured on the same 6-core VPS | coordinate | Rivet | Restate |
| --- | --- | --- | --- |
| Idle memory | 5.9 MB | 128 MB | 532 MB |
| 10,000 parked jobs | 3 MB on disk | 1,489 MB of memory | not run (851 MB at 1,000) |

Every number comes from a result file in [`benchmarks/`](benchmarks/).

## Docs

- [Architecture](ARCHITECTURE.md)
- [Benchmarks](benchmarks/)
- [Agent skill](skills/coordinate/SKILL.md): copy it into your agent's skills directory
- [Contributing](CONTRIBUTING.md)

## Ecosystem

- [scriptc](https://github.com/vercel-labs/scriptc) — the TypeScript-to-binary compiler coordinate is built with
- [cutils](https://github.com/sigilco/cutils) — `@cutils/sqlite` and `@cutils/cli`, the scriptc-compilable packages under the hood
- [cauce](https://github.com/espetro/cauce) — sibling single-binary tool for agents

## License

[Apache-2.0](LICENSE). Copyright 2026 Joaquin Terrasa & contributors.
