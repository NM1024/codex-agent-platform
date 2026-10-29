# Local manager memory comparison

This runs the complete `ManagementAgent` / `ManagerStore` execution path in isolated
Node workers against baseline `8db12f7` and the current source tree. It does **not**
measure the complete manager HTTP container, gateway, runner or frontend.

Requirements: Linux, Node 24+, Python 3.12+, Git, installed project dependencies,
and the pinned Codex 0.159.2 package. No build, Docker, login or model credentials
are needed. The environment must permit a local loopback HTTP listener. The default
binary path is the Linux x64 native package; use `--codex-binary` for another
installed native binary. Its version is checked before running.

Run from any directory:

```sh
python3 /path/to/repository/tests/benchmarks/manager-memory/run.py
```

The default scratch directory is `.tmp/manager-memory-benchmark` in the repository.
It contains baseline source extracted with `git archive`, synthetic native thread
seeds, per-worker JSONL samples and a combined `summary.json`. Existing complete
seeds are reused. A scratch directory records its baseline revision and cannot be
reused for another baseline. The runner only replaces its own `run-*` directories.
An external scratch directory is supported through a dependency symlink.

A small fresh-seed smoke run:

```sh
python3 tests/benchmarks/manager-memory/run.py \
  --scratch .tmp/manager-memory-benchmark-smoke \
  --short-turns 1 --long-turns 2 --reply-bytes 4096 \
  --queue-count 8 --native-count 3
```

The default comparison has three dimensions:

- 4 versus 32 saved native turns, each with approximately 256 KiB synthetic output;
  both branches resume independent copies of the exact same disk-backed seed.
- 2 versus 2,000 queued conversations using a stub client that holds turns open;
  this isolates scheduler allocations and records the number of created clients.
- 2 versus 6 conversations with real native Codex and delayed synthetic responses;
  this records actual active slots and combined process memory while all work completes.

The model provider is an auth-free loopback Responses fixture in a separate process.
Every native process receives an isolated `HOME` / `CODEX_HOME`, with no real auth.
The client hook replaces only the binary, isolated environment and local provider,
and disables web search / MCP tools. It makes no external model calls. The fixture
process is excluded from worker/native memory totals.

`summary.json` includes source hashes, seed byte counts and SHA-256 manifests,
response-result bytes, worker RSS/high-water/heap/external memory, native
RSS/PSS/anonymous memory, active/client counts, final GC samples and remaining
child process checks. Result byte counts omit the small JSON-RPC envelope and
are calculated without constructing another history-sized JSON string.

Read the measurements carefully:

- Process memory comes from `/proc/status` and `/proc/smaps_rollup`; disk seed
  size and whole-container filesystem cache are not treated as process RAM.
- RSS peaks are sampled at a target 25 ms; `rssHwm` also captures synchronous
  allocation peaks. PSS avoids double-counting shared native executable pages.
- Each default configuration runs once, so small RSS differences are noise.
- Native Codex still loads model context and can grow with native thread length.
  Metadata-only resume bounds management transport/history projection, not all RAM.
- The native binary is invoked directly. An npm Node launcher adds its own memory
  in deployments that use it. SSE and generated-image processing are not exercised.
- Stub queue runs demonstrate scheduler allocation behavior, not real model context
  memory. Final live heap and retained allocator/native anonymous memory differ.

This is a manual benchmark, not a normal test-suite assertion. `--help` lists the
fixture sizes, baseline revision and scratch-directory options.
