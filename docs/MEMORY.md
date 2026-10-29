# Manager memory and conversation history

Management conversations persist in SQLite and Codex session files. An inactive conversation has no dedicated process. Each active management round has its own Codex client/process, scoped credentials and work directory; the process closes when the round ends. Model computation runs through the configured upstream service.

## Controls and loading behavior

**Settings → Manager → Management concurrency** defaults to **2**, with a supported range of **1–5**. This is independent of business task concurrency. Changes apply to future dispatches; lowering the limit does not interrupt rounds already running. Existing installations receive the default without replacing saved model, prompt, timeout or settings revisions.

The ready queue and wake signals are stored in SQLite. Waiting conversations do not each allocate a Promise/client. Each slot executes one round, then returns a conversation with more work to the queue tail. Interrupted work waits for a new trigger or restart recovery. Startup restores pending work in SQL instead of materializing every pending conversation in JavaScript.

Normal continuation resumes the existing Codex thread with metadata only (`excludeTurns:true`). It does not return old turn/item payloads to Manager, and the native Codex thread still retains its context. Interrupted/lost-acknowledgement recovery reads bounded pages of turns/items, identifies the original message marker and projects the selected turn directly. Missing or malformed history cannot authorize replay of a potentially completed operation.

Recovery action summaries are bounded and prioritize all unconfirmed actions. Omitted confirmed records are explicitly identified; omission never means an operation did not happen. More than 100 unconfirmed records pauses automatic recovery with `MANAGER_RECOVERY_ACTION_OVERFLOW`, rather than silently omitting uncertainty. Full stored records remain available.

Manager reuses at most 64 prepared SQLite statements to reduce native allocation churn. Statements with more than 8 KiB of bound parameters are evicted, so the cache cannot retain a large final reply or image BLOB between operations.

Live updates omit an unchanged pending queue. Slow streams stop projecting new data while backpressured, retain at most 100 changed message IDs, refresh from durable state if necessary and destroy a stalled connection after 15 seconds. Deletion/shutdown also destroys unfinished backpressured responses. Reconnection reads existing state and never resubmits a task. The browser sidebar stores summaries rather than full snapshots for every visited conversation; the selected transcript retains complete messages and existing pagination.

Image libraries load on first image work. Uploads and generated images share one active decoder, with at most eight waiting slots and a 30-second admission timeout. Busy uploads return retryable `503 IMAGE_PROCESSING_BUSY` before enqueueing a message. Already accepted generated output waits using compact file descriptors and is drained before message completion. The native cache is limited to 8 MiB/16 entries with no open-file cache. These controls bound concurrency, not the memory needed to decode one valid large image. Full final text is retained independently of the bounded live-text buffer.

## Reading memory measurements

`docker stats`, cgroup `memory.current`, process RSS and JavaScript heap are different measurements. On Linux, Docker normally subtracts `inactive_file` from the container total. Active file cache, anonymous pages and kernel allocations can remain in the displayed working set. File pages include executable/library pages and runtime storage, not just project source or business task data. Such pages can outlive a Codex process; their presence alone is not evidence of a JavaScript leak.

For an idle Manager, compare process listings with cgroup `anon`, `file`, `active_file`, `inactive_file`, `shmem` and `kernel`. During work, include Codex descendants. Summed RSS can count shared executable/library pages more than once; PSS and anonymous/private pages help distinguish them. Do not treat image size on disk as RAM use.

## Limits of the optimization

These changes remove redundant history hydration, limit active rounds and reduce projection/allocation churn. They do not promise constant RAM for arbitrarily large contexts or traffic. Native Codex still processes its own context; its existing compaction strategy is unchanged. Legal large replies/queue snapshots, the currently loaded browser transcript and one large image can still have substantial transient size. Linux may retain file pages when memory is available. Historical cleanup primarily controls disk retention and is not a guarantee of immediate RSS reduction.

All comparisons use synthetic data and an auth-free loopback Responses fixture. No actual login state, production data or external model tasks are needed. Measured results and verification scope are recorded in [VALIDATION.md](VALIDATION.md#manager-memory-bounds).
