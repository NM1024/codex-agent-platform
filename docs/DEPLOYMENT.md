# Deployment and operations

Use a Linux host with Docker Engine, Compose v2 and outbound HTTPS access to the OpenAI authentication/Codex services. The pinned runtime is Codex `0.159.2`, Node.js `24`, with default model `gpt-6.1-sol`. Model availability depends on your own account. No API Key or substitute model/image provider is configured.

## Fresh installation

```bash
./deploy.sh init /data/codex-agent-platform
./deploy.sh build /data/codex-agent-platform
./deploy.sh login /data/codex-agent-platform
./deploy.sh start /data/codex-agent-platform
./deploy.sh status /data/codex-agent-platform
```

`init` generates the internal `RUNNER_TOKEN` and an independent initial Admin password. Public entry keys are configured separately for each plugin in Admin. Repeating initialization retains existing configuration and data. The default containers run as UID/GID `1000:1000`; when initializing as root, the script assigns new volume directories to that identity. Otherwise ensure the chosen directory is writable by that UID. Source scripts use Bash and Linux utilities.

`login` prints a device URL and code. Open that URL yourself, sign in and authorize only the login you started. Do not give another person the code. Successful login is retained in the deployment's `codex/` directory. Do not commit or copy it into source or images.

`start` validates and starts already built images. It does not build. Gateway/Runner/Manager bind to `127.0.0.1:3004`, internal-only, and `127.0.0.1:3007` respectively. Open `/admin/` on port 3007 and read the initial password locally from `manager/initial-password`. Password changes revoke existing sessions; the initial file is used only to initialize a new Manager database.

The data directory contains:

| Directory | Contents |
| --- | --- |
| `data/` | Gateway SQLite, task/plugin/settings/schedule records. |
| `workspace/` | Per-task sessions, lifecycle events and image/text artifacts. |
| `codex/` | Your account authentication and runtime state. |
| `manager/` | Management database, conversations, settings, password hash and initial password file. |

Use a separate data directory for a fresh installation. This standalone distribution has no automatic importer for another application's business-specific records.

## Live settings

Admin and management MCP can update execution model, concurrency, pause, queue limit, task/tool timeout, Manager model/prompt/timeout and Admin session TTL. Settings persist in SQLite and override first-start environment defaults. There are no global ingress-access or HTTP-target settings groups. Each plugin's entry address is generated independently. The Agent may initialize missing entry keys without reading them; only a human in Admin can claim a generated key once, replace existing keys or configure callbacks.

New installations default to **five simultaneous business tasks** across all plugins. Explicit environment values and saved settings, including `1`, are retained. Upgrading an existing installation does not rewrite them: set **Settings → Business execution → Concurrency** to `5` once, or ask the management Agent to call `configuration_update` with scope `execution` and patch `{"concurrency":5}`. Changing `.env` alone does not override an already saved value. This limit does not count management messages or a task Agent's internal collaboration.

Pausing queues new accepted tasks without interrupting running ones. Current execution keeps its launch settings. Resuming dispatches queued work under the configured capacity. Increasing concurrency starts more independent task conversations and can increase account usage.

Admin keeps simple controls such as model/reasoning selection, pause/resume, concurrency and passwords. Schedules provides viewing and enable/disable switches; creation and editing use management chat. Rule times and next-run values use the plan's configured zone. Business JSON and management instructions use management chat. The Agent can request backend-only initialization of missing entry keys and report addresses/readiness, but cannot read, claim, specify or rotate credentials. Humans claim or replace keys and configure callbacks.

Management replies use authenticated Server-Sent Events at `/admin/api/conversations/<id>/events`. Forward this path to Manager with the rest of `/admin/`, retain cookies and do not cache or buffer it. Manager sends `X-Accel-Buffering: no` and a heartbeat every 15 seconds; ordinary Nginx honors this response header. If another public proxy still batches output, set `proxy_buffering off;` and `proxy_cache off;` in the existing Admin proxy location and check that proxy's streaming settings. A lost connection restores a durable snapshot; it never resends the chat request. The UI displays connection status and falls back to polling when streaming is unavailable. History deletion requires an authenticated browser and rejects pending work; it removes local chat data and owned local thread/work directories, without deleting business task history or revoking shared account authorization.

### Plugin connections

Open **Business plugins → Configure connection** on the relevant row. The entry address and entry key are mandatory. A new plugin defaults to `/hooks/{type}` with dots replaced by slashes, or the Agent's suggested `/hooks/...` route. Humans may replace it with another `/hooks/...` path or an absolute HTTP(S) URL using such a path. The public domain and proxy route must be configured by the operator; saving a URL does not provision either. Entry paths and keys must be unique across plugins. Generate keys in the modal or supply a suitable private key, then retain it in your calling application's secret store. Saved secrets cannot be read back. Alternatively ask the Agent to call plugin_connection_initialize, then claim the generated key once in this modal. An unclaimed key cannot authenticate or activate the plugin. Keep the claimed key before closing; if lost, generate and save a replacement here. Saving the replacement revokes the old key immediately. Existing keys and callbacks are never changed by initialization.

The callback URL and receiver Bearer token are optional and belong to that plugin. These human values control final-result delivery independently of the Agent's business JSON. Leaving the callback URL blank disables callbacks and clears its stored token. When editing, blank secret inputs preserve existing values. Never put credentials in management chat or task input.

Save the connection and enable the plugin separately. New and upgraded plugins without complete entry configuration remain disabled, and cannot accept tasks, run trials or execute scheduled work. Queued or recovered work also waits for connection readiness. Upgrades do not reuse a legacy global ingress token as a plugin key. Use each plugin's own key for public submissions, result queries and artifact downloads; `POST /v2/tasks` must name the matching plugin type. Manager-to-Gateway operations use the internal `RUNNER_TOKEN` only.

Legacy global `access` and `http` settings are no longer applied after upgrade. Humans must reconfigure any former global callback destination and its receiver credential on each relevant plugin. Old Agent-managed destination credentials are not copied into plugin connections. For ordinary `http_request` capability targets, an operator must configure `PLATFORM_HTTP_TARGETS_JSON` on the server and recreate Gateway; an old saved `http` settings group does not restore those targets.

### Model and reasoning selection

Admin **Settings → Task execution** and **Settings → Management Agent** provide separate model and reasoning selectors. Choices come from Codex `model/list`, including each model's supported reasoning efforts; discovering the list does not start a model turn. The list is cached for up to one minute and does not guarantee that a later task will succeed or have remaining account allowance.

Each **Management chat** can save its own model and reasoning settings above the composer. Sending a message also saves the current choices. They apply to subsequent turns; already running work keeps its settings. Started message settings are recorded for inspection and recovery.

The **Business plugins** page displays saved definitions and model overrides with enable/disable switches. Ask the management Agent to create/edit a plugin, configure its optional `execution` object or run a trial. Existing accepted tasks retain their plugin snapshot; editing a plugin affects only new submissions.

**Inherit global settings** leaves that override unset. **Model default** stores a null reasoning effort. A different model selected without an explicit effort uses that model's default rather than inheriting an effort from the global model. An explicit effort is checked against the selected model before a model turn starts.

Older saved model settings and plugin definitions are retained; plugin connections still require the human setup described above. If the model catalog is unavailable, the console preserves saved values and allows unrelated settings to be edited; restore Codex login/connectivity and refresh before selecting new models. Existing deployments should use Admin rather than changing the first-start `CODEX_MODEL` environment value.

To upgrade for these controls, rebuild the images and run `start` with the same runtime directory. The Manager adds optional execution columns to its existing database; keep your normal backup before upgrading.

The entire Admin interface uses React, TypeScript and Ant Design. Docker builds its static bundle in a dedicated `admin-build` stage; no frontend development server, Node installation on the host or additional container is required. The three-service deployment and `/admin/` reverse-proxy route stay the same. After upgrading, reload the browser page to receive the new hashed assets.

Management Agent replies render Markdown, including lists, tables and fenced code. Raw HTML remains literal text; images are links rather than automatic remote loads. Both user and Agent messages show their saved timestamps in the browser's local locale and time zone. Schedule rules still use each plan's explicit time zone.

Management chat also displays durable message states, queue order, elapsed time and collapsed activity. Available public reasoning summaries, assistant progress and tool lifecycle metadata are projected from the [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server); raw reasoning and tool arguments/results are not included in this activity view. Model output may omit summaries. Replies support Markdown copying and separate fenced-code copying. A message being accepted into the queue does not mean its Agent turn has completed.

Humans can attach up to four JPEG, PNG or WebP images by selection, paste or drop. Browser compression limits each image to 160 KiB and a 2048px longest edge; backend validation independently checks actual decoded raster data. The message text limit is 20,000 characters, so compressed image messages fit the existing 1 MiB JSON/Nginx body limit without a proxy increase. Manager stores private images alongside its message data and serves previews only through authenticated conversation-owned URLs. Preserve the Manager data volume during an upgrade. Images are included with the original message in one Codex turn; actual model support and account access still apply.

Conversation titles prefer Codex `thread.name` from start/resume responses, `thread/name/updated` notifications, and a bounded metadata read after a successful turn. The app-server may not supply a name: the existing title is retained in that case. The platform does not start an extra model turn to generate a title. Title lookup failures do not retry completed management work.

Ports (`PLATFORM_PORT`, `MANAGER_PORT`), volume root (`PLATFORM_DATA_DIR`), internal URLs and `RUNNER_TOKEN` are deployment bootstrap settings; changes need coordinated container recreation. `PLATFORM_PROJECT` is a shell override for the deployment script's Compose project name. Do not change existing deployment paths casually.

Changing the `.env` after initialization does not replace saved live values. Change those through Admin/management MCP. Ordinary `http_request` capability destinations are supplied at deployment bootstrap through `PLATFORM_HTTP_TARGETS_JSON`; they are separate from per-plugin result callbacks and are not editable through global settings or the Agent. Recreate the Gateway after changing that bootstrap configuration. Normal credential updates remain write-only. A pending backend-generated key can be disclosed once by the human-only claim action; it stays temporarily in private Gateway storage until claimed or replaced, then only its authentication hash remains. A lost claim response may require human replacement. Protect runtime databases and backups, including their free pages. Keep the runtime directory private even though credentials are hidden in the UI.

## HTTPS and remote console access

For local administration from your computer:

```bash
ssh -L 3007:127.0.0.1:3007 user@your-server
```

Then open `http://127.0.0.1:3007/admin/`. Public domains, HTTPS certificates and external gateways are deployment responsibilities; this repository does not supply or manage them. When using your existing gateway, send `/admin/` requests to the Manager and task API requests to the Gateway. Preserve the original Host and `X-Forwarded-Proto`; Admin uses them for origin checking and Secure cookies. Keep internal service ports private and apply external access controls appropriate to your installation.

## Health and diagnostics

```bash
curl -sS http://127.0.0.1:3004/healthz
curl -sS 'http://127.0.0.1:3004/readyz?type=content.review'
docker compose --env-file /data/codex-agent-platform/.env logs --tail=100 gateway runner manager
```

`/healthz` reports process liveness. `/readyz?type=content.review` also checks that plugin's human connection configuration, account/capability readiness and queue pause. Complete its connection configuration before expecting it to become ready. Admin task details show structured errors, execution diagnostics and separate delivery outcomes. A completed request may still contain negative business decisions; callback `accepted` means HTTP acceptance only.

Explicitly run protocol/account probes inside your installation when needed:

```bash
docker compose --env-file /data/codex-agent-platform/.env exec -T runner node scripts/probe-codex.mjs
docker compose --env-file /data/codex-agent-platform/.env exec -T runner node scripts/probe-runtime.mjs
```

Neither probe starts a model turn. Real tasks and Manager messages do use your account; automated tests do not.

Remote Admin password changes require the current password, including the management operation. Use the **Security & sign-in** settings tab, rather than sending passwords in chat. For a forgotten Admin password, trusted local recovery can supply a new password over stdin without a command-line literal:

```bash
read -r -s -p 'New Admin password: ' admin_password; printf '\n'
printf '%s' "$admin_password" | docker compose --env-file /data/codex-agent-platform/.env exec -T manager node scripts/admin-password.mjs
unset admin_password
```

## Upgrade and backup

Back up all runtime directories together while services are stopped, or use SQLite-consistent snapshots with coordinated workspace backups. Backups contain sensitive account state and business data. Do not delete data to upgrade. Build the new source, then run `start`; container recreation suspends/resumes incomplete work where Codex session state is available. Keep a rollback copy of source/images and data before upgrading. No rollback compatibility across future schema changes is promised in preview releases.

## System prompt changes

The image includes the root `prompts/` directory. Rebuild/redeploy after editing its fixed message templates. Existing Manager instructions are persisted, including their initial default; ask the management Agent to update `manager.instructions` through management MCP to apply revised editable instructions without a restart. The versioned project rules and human-only connection policy are independently appended on every management start/resume, so an image upgrade applies these rules to the next turn even with saved custom instructions. The Agent obtains live configuration and capabilities from tools rather than reading repository documents. See the [system prompt guide](../prompts/README.md). Plugin instructions continue to be managed as plugin configuration.
