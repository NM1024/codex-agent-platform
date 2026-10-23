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

Admin offers simple enable/disable controls for plugins and schedules, plus scalar/model/password settings. Plugin/plan definitions and management instructions are changed through the management Agent. Each plugin row's Configure connection modal is available only to a human's authenticated browser session; a dedicated internal Gateway endpoint persists its values and is absent from Agent tool contracts. Agents see connection readiness, entry path and missing field names, and must direct humans to finish configuration. Saving a connection does not enable a plugin. Named HTTP capability targets are deployment bootstrap configuration, not live management settings. Management replies use React Markdown with GFM, escaped raw HTML and links in place of external images. Message timestamps retain UTC epoch storage and use the browser's local locale/time zone for display. Codex thread names synchronize through response metadata and name notifications; an optional one-second metadata read follows durable successful completion. Missing names preserve the existing title, with no extra generation turn.

Gateway owns `tasks.sqlite`; Manager owns `manager.sqlite`. Runner owns isolated work directories, Codex session state and artifacts. Gateway reads artifacts through a read-only workspace mount. Neither service has a Docker socket. Internal ports are not published; public ports bind loopback by default.

Admin uses its own password hash and expiring hashed cookie sessions. Every remote password update, including the management operation, requires the current password; a version-conditional update prevents concurrent verification against an outdated hash. Failure preserves sessions and success revokes all sessions. Trusted local recovery over stdin remains separate. Gateway keeps each plugin's unique entry path/key and optional callback URL/token in a private SQLite connection table, separate from business JSON and task snapshots. Entry keys are hashed; callback tokens are private and write-only. Human reads return configured-secret flags. Public authentication binds the key to one plugin for submission, task queries and artifact downloads. Entry addresses may be absolute HTTP(S) URLs or `/hooks/...` paths; human changes survive Agent edits. Deployments must protect runtime volumes and backups.

The Admin shell bounds scrolling to each workspace. Chat has a desktop conversation sidebar/mobile drawer, separate user and Agent bubbles, a scrolling transcript and a persistent composer with compact model/effort controls. Existing conversation selections save automatically in request order; new conversations apply selections when sending. Configuration categories use separate tabs with retained drafts; password changes live in the security tab.

`callback_once` records the attempt before sending. A transport failure can leave delivery `unknown`; the platform does not promise exactly-once remote effects or automatically replay an ambiguous callback. An HTTP acceptance response does not prove downstream storage succeeded.

## Platform prompts

Built-in instructions are indexed in [`prompts/README.md`](../prompts/README.md). The task wrapper composes the plugin instructions and request/schema data without interpreting placeholders inside inserted content. Resume templates belong to the runtime, and investigation messages are generated by Manager on the server. Manager default instructions initialize persistent configuration; saved instructions remain authoritative on upgrades and subsequent turns. Tool contracts and capability enforcement remain code-owned.
