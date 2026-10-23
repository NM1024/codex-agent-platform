# Architecture

```mermaid
flowchart LR
    Caller[API caller] --> Gateway
    Admin[Admin console] --> Manager
    Manager[Operations Agent + MCP] --> Gateway
    Gateway --> DB[(Task SQLite)]
    Gateway --> Runner
    Runner --> Codex[One Codex thread per task]
    Codex --> MCP[Task-scoped MCP]
    MCP --> Gateway
    MCP --> Artifacts[Task artifacts]
    Gateway --> Callback[Per-plugin callback receiver]
```

## Responsibilities

| Module | Responsibility |
| --- | --- |
| `application.mjs` | Assemble generic capabilities, example plugins and configuration scopes. |
| `core/` | Request/run identity, queue, dispatch, durable lifecycle, operations and completion receipts. |
| `prompts/` (repository root), `src/prompts.mjs` | Platform-owned system instructions and fixed task/management message templates; plugin instructions remain plugin configuration. |
| `plugins/` | Validate and store JSON contracts; construct complete task messages and permitted capabilities. |
| `capabilities/` | Task-owned image/text artifacts and requests to named HTTP destinations. |
| `delivery/` | Configured final-result delivery, independent of Agent execution status. |
| `runtime/`, `codex/` | App-server transport, per-run workspaces, tool policy, lifecycle events and resumption. |
| `configuration/` | Persistent module-owned settings with write-only credentials and application hooks. |
| `operations/` | Preset task/plugin/configuration operations and persistent cron plans. |
| `manager/` | Independent management conversation, MCP adapter, Admin authentication and web console. |
| `frontend/` | React + TypeScript + Ant Design Admin source. Vite bundles it into generated `src/manager/web-dist/`; Manager serves only those production assets. |
| `contracts/`, `observability/` | Shared management schemas and bounded resource measurements. |

Admin pages load on demand. The build generates Brotli and gzip variants of every hashed JS/CSS resource; Manager negotiates `Accept-Encoding` and returns `Vary: Accept-Encoding` with immutable caching. Nonce HTML and authenticated API responses are not compressed by this path. Release validation requires the complete manifest graph and both compressed variants, including deferred pages.

The Manager accesses Gateway operations through an internal API authenticated only by `RUNNER_TOKEN`. Its operations client does not use a public plugin entry key. It does not import the task runtime or query an external business database. Both management and task Agents use preset MCP tools plus their explicitly permitted native Codex capabilities; arbitrary shell, code editing and foreign MCP tools are denied.

## Lifecycle

Every accepted API request has a fresh `task_id`. Its execution uses one `run_id` and one root Codex thread. Agent-internal collaboration is permitted, but the platform does not split a business request into multiple root conversations or drive business steps message by message.

Normal execution sends one initial message. `complete_task` validates the plugin's result schema and task artifact ownership, then records completion. A task can fail if the Codex turn ends without submission, the runtime reports failure or its configured timeout expires. A failed business outcome can also be represented inside a successfully submitted result; execution status alone does not count business successes.

During restart, incomplete work is suspended, its files and known thread identifiers persist, and the dispatcher resumes it under the configured concurrency. A resumed task receives an extra continuation turn in its existing thread. Lost or unusable thread state cannot guarantee successful continuation. Completed/failed tasks require an explicit new request or retry to run again.

Accepted plugin contracts are stored with each request; editing or disabling a plugin affects new requests. Missing human connection configuration blocks admission, trials, schedules and queued/recovered launches. Execution settings are selected per launch/resumption segment; current work keeps its model/timeout snapshot. Per-plugin entry credentials change immediately. Pending callbacks resolve the current human callback configuration; ordinary HTTP capability calls use deployment-provided named targets.

## Persistence and trust

Admin offers simple enable/disable controls for plugins and schedules, plus scalar/model/password settings. Plugin/plan definitions and management instructions are changed through the management Agent. Each plugin row's Configure connection modal is available only to a human's authenticated browser session; a dedicated internal Gateway endpoint persists its values and is absent from Agent tool contracts. Agents can read entry addresses and readiness and request backend initialization of missing entry keys through plugin_connection_initialize, without specifying or receiving credentials. Initialization preserves existing keys and human configuration. Humans must claim generated keys once in Configure connection; pending keys cannot authenticate or enable/execute work. Claim/replacement/callback endpoints remain browser-only and outside Agent tool contracts. Saving a connection does not enable a plugin. The connection modal separates retained entry/callback tabs, uses one entry-secret display/edit area and opens integration documentation without discarding drafts. Invalid fields select their own tab; disabling callbacks only deletes saved callback settings after Save. List tables size status/actions by content and switch to compact rows in narrow containers. Named HTTP capability targets are deployment bootstrap configuration, not live management settings. Management replies use React Markdown with GFM, escaped raw HTML and links in place of external images. Message timestamps retain UTC epoch storage and use the browser's local locale/time zone for display. Author, timestamp and Replying share one line; constrained screens shorten the timestamp visually while its title retains the full local value. Codex thread names synchronize through response metadata and name notifications; an optional one-second metadata read follows durable successful completion. Missing names preserve the existing title, with no extra generation turn.

Gateway owns `tasks.sqlite`; Manager owns `manager.sqlite`. Runner owns isolated work directories, Codex session state and artifacts. Gateway reads artifacts through a read-only workspace mount. Neither service has a Docker socket. Internal ports are not published; public ports bind loopback by default.

Admin uses its own password hash and expiring hashed cookie sessions. Every remote password update, including the management operation, requires the current password; a version-conditional update prevents concurrent verification against an outdated hash. Failure preserves sessions and success revokes all sessions. Trusted local recovery over stdin remains separate. Gateway keeps each plugin's unique entry path/key and optional callback URL/token in a private SQLite connection table, separate from business JSON and task snapshots. Entry keys are hashed for authentication. A generated key awaiting its one-time human claim also has a temporary plaintext copy in the private connection table; claim atomically removes that copy, increments revision and activates the hash. Manual replacement also clears any pending copy. Concurrent claims disclose once; an ambiguous lost response requires a human replacement if the key was consumed. Callback tokens stay private and write-only. Ordinary metadata reads expose only configured/claimable flags; only the dedicated authenticated same-origin human claim response discloses a key, with no-store caching. Runtime database files and backups therefore remain sensitive, including SQLite free pages after logical deletion. Public authentication binds the key to one plugin for submission, task queries and artifact downloads. Entry addresses may be absolute HTTP(S) URLs or `/hooks/...` paths; human changes survive Agent edits. Deployments must protect runtime volumes and backups.

The Admin shell bounds scrolling to each workspace. Chat has a desktop conversation sidebar/mobile drawer, separate user and Agent bubbles, a scrolling transcript and a persistent composer with compact model/effort controls. Existing conversation selections save automatically in request order; new conversations apply selections when sending. Configuration categories use separate tabs with retained drafts and aligned label/input rows; password changes live in the security tab. The header uses the project name and repository/language/logout icons without a manual refresh action; live views retain their own updates, and navigating to other views reloads their data. Copy/export and chat composer icons retain accessible labels, tooltips and local busy/error feedback.

Per-plugin integration documentation is a human-only Manager projection. It combines the current definition with whitelisted connection metadata into localized Markdown sections; JSON Schema annotations describe business fields while fixed transport rules match the task and callback APIs. Examples are schema-validated or explicitly unavailable, and complete schemas accompany bounded field summaries. No account work, trial or new Agent permission is involved. The Admin drawer provides safe Markdown/code copy and export with plugin/locale request guards; relative paths retain a Gateway host placeholder, credentials and actual callback URLs are excluded. Protocol documentation and tests must evolve with API changes.

Management messages remain a durable FIFO within each conversation. Each user message owns its execution timestamps, activity records and eventual reply; queued messages wait for the preceding turn. Public reasoning summaries, assistant output and tool lifecycle metadata are projected from the pinned Codex protocol. A cookie-authenticated SSE endpoint sends an initial durable snapshot and coalesced changed-message/metadata patches; reconnects read a fresh snapshot without resubmitting work. Live assistant text has a separate bounded projection (up to 1,048,576 UTF-16 code units), independent of the smaller activity budget. Chinese text can stream without whitespace; credential-like ASCII suffixes wait for a safe boundary. Final replies remain independent of these live limits. The browser shows a real assistant bubble during execution and replaces it with the completed reply; unavailable streams fall back to polling. Raw reasoning, tool arguments and tool results are excluded. A collapsed timeline sits below its associated assistant bubble and shows reasoning summaries, tool calls and status records. Assistant-message activity supports compatible live-reply reconstruction but is excluded from the timeline to avoid repeating the reply; an assistant-only record leaves no empty timeline. Explicit queued/running/recovering/completed/failed states remain visible; absence of new activity does not imply completion. Open streams recheck sessions before updates and on 15-second heartbeats, disconnect slow clients and close during shutdown.

Humans can delete management history through authenticated, same-origin Admin DELETE requests. Pending queued/running/interrupted messages and still-finishing Agent processes block deletion. One transaction removes local conversation/message/image/activity/action records, followed by scoped local work/thread-directory cleanup that does not follow the shared login symlink. Cleanup failure is reported explicitly. Business tasks/results and the shared account authorization remain separate. Deleting local history is not a remote provider deletion request, and the platform does not claim secure erasure of SQLite free pages or filesystem backups.

Chat image attachments are private Manager data. The frontend rasterizes supported images, bounds dimensions and compresses them before sending within the existing 1 MiB HTTP envelope. Backend validation independently checks decoded image format, dimensions and size. Conversation responses contain attachment metadata and authenticated preview URLs; they do not repeatedly embed image data. The Agent's initial turn receives the stored images together with the message text. Attachment ownership follows the conversation, persists across queued/recovered messages and does not add another model turn.

`callback_once` records the attempt before sending. A transport failure can leave delivery `unknown`; the platform does not promise exactly-once remote effects or automatically replay an ambiguous callback. An HTTP acceptance response does not prove downstream storage succeeded.

## Platform prompts

Built-in instructions are indexed in [`prompts/README.md`](../prompts/README.md). The task wrapper composes the plugin instructions and request/schema data without interpreting placeholders inside inserted content. Resume templates belong to the runtime, and investigation messages are generated by Manager on the server. Manager default instructions initialize persistent configuration; upgrades preserve saved instructions. Every management start/resume combines those selected instructions with versioned `manager-project.md` operating rules and `manager-connections.md` human-only connection policy. This also updates existing conversations with customized instructions without replacing their editable role. The runtime does not automatically read repository documents. Live state and schemas remain tool-discovered; production capability discovery describes the human connection policy and only advertises Agent-editable delivery mode `none`. Tool contracts and capability enforcement remain code-owned.
