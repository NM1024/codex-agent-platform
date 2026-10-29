# Manager memory bounds

User goal: deeply investigate RAM growth and prevent management conversation count/history length from causing unbounded app memory. Preserve full stored conversations, thread continuity, tool isolation and no-replay recovery. User chose default management concurrency 2; range 1–5 remains an implementation choice.

Approach: retain per-active-turn Codex process isolation; replace eager conversation promises and waiting sets with SQLite-backed ready queue, dispatch one turn fairly per slot. Normal resume requests metadata only; interrupted reconciliation uses protocol-supported bounded turn/item pages. Stream queue only when its persistent revision changes; keep sidebar metadata separate from transcript. Image pipelines share one active slot and bounded waiting with small native cache; preserve complete final text.

Alternatives considered: sharing one Codex process would require redesigning per-thread permissions/tokens/hooks and expands failure scope; cgroup limits/restarts alone mask the application loading issues and can interrupt tasks. Neither is needed for this change.

Memory is bounded at application protocol/projection boundaries, not a promise that arbitrary provider tool output or Codex internal replay uses fixed RAM. Existing HTTP/RPC byte limits remain. Full history stays on disk and is never truncated by this change. Linux file cache is accounted separately from anonymous/private memory in benchmarks.

Validation: fail-first functional regressions; actual pinned Codex with offline Responses fixture; paired short/long history and 1/2/many queued conversation benchmarks using identical disk-backed synthetic state, measure cgroup anon/file/working-set plus process RSS/heap and protocol byte counts; complete backend/build/release, focused browser and Docker targets. No real account/model calls. Publish a new PR, leave production unchanged.
