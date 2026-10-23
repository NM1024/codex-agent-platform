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

`init` generates distinct API/internal tokens and an independent initial Admin password. Repeating it retains existing configuration and data. The default containers run as UID/GID `1000:1000`; when initializing as root, the script assigns new volume directories to that identity. Otherwise ensure the chosen directory is writable by that UID. Source scripts use Bash and Linux utilities.

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

Admin and management MCP can update execution model, concurrency, pause, queue limit, task/tool timeout, ingress token, named HTTP targets, Manager model/prompt/timeout and Admin session TTL. Settings persist in SQLite and override first-start environment defaults.

Pausing queues new accepted tasks without interrupting running ones. Current execution keeps its launch settings. Resuming dispatches queued work under the configured capacity. Increasing concurrency starts more independent task conversations and can increase account usage.

Admin keeps simple controls such as model/reasoning selection, pause/resume, concurrency and passwords. Schedules provides viewing and enable/disable switches; creation and editing use management chat. Rule times and next-run values use the plan's configured zone. Structured JSON, HTTP targets and management instructions are read-only with a chat shortcut. The Agent retains every preset operation, including those directly available in Admin.

### Model and reasoning selection

Admin **Settings → Task execution** and **Settings → Management Agent** provide separate model and reasoning selectors. Choices come from Codex `model/list`, including each model's supported reasoning efforts; discovering the list does not start a model turn. The list is cached for up to one minute and does not guarantee that a later task will succeed or have remaining account allowance.

Each **Management chat** can save its own model and reasoning settings above the composer. Sending a message also saves the current choices. They apply to subsequent turns; already running work keeps its settings. Started message settings are recorded for inspection and recovery.

The **Business plugins** page displays saved definitions and model overrides with enable/disable switches. Ask the management Agent to create/edit a plugin, configure its optional `execution` object or run a trial. Existing accepted tasks retain their plugin snapshot; editing a plugin affects only new submissions.

**Inherit global settings** leaves that override unset. **Model default** stores a null reasoning effort. A different model selected without an explicit effort uses that model's default rather than inheriting an effort from the global model. An explicit effort is checked against the selected model before a model turn starts.

Older saved settings and plugins continue to work. If the catalog is unavailable, the console preserves saved values and allows unrelated settings to be edited; restore Codex login/connectivity and refresh before selecting new models. Existing deployments should use Admin rather than changing the first-start `CODEX_MODEL` environment value.

To upgrade for these controls, rebuild the images and run `start` with the same runtime directory. The Manager adds optional execution columns to its existing database; keep your normal backup before upgrading.

The entire Admin interface uses React, TypeScript and Ant Design. Docker builds its static bundle in a dedicated `admin-build` stage; no frontend development server, Node installation on the host or additional container is required. The three-service deployment and `/admin/` reverse-proxy route stay the same. After upgrading, reload the browser page to receive the new hashed assets.

Management Agent replies render Markdown, including lists, tables and fenced code. Raw HTML remains literal text; images are links rather than automatic remote loads. Both user and Agent messages show their saved timestamps in the browser's local locale and time zone. Schedule rules still use each plan's explicit time zone.

Conversation titles prefer Codex `thread.name` from start/resume responses, `thread/name/updated` notifications, and a bounded metadata read after a successful turn. The app-server may not supply a name: the existing title is retained in that case. The platform does not start an extra model turn to generate a title. Title lookup failures do not retry completed management work.

Ports (`PLATFORM_PORT`, `MANAGER_PORT`), volume root (`PLATFORM_DATA_DIR`), internal URLs and `RUNNER_TOKEN` are deployment bootstrap settings; changes need coordinated container recreation. `PLATFORM_PROJECT` is a shell override for the deployment script's Compose project name. Do not change existing deployment paths casually.

Changing the `.env` after initialization does not replace saved live values. Change those through Admin/management MCP. API credentials are write-only in settings responses. Keep the runtime directory private even though credentials are hidden in the UI.

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

`/healthz` reports process liveness. `/readyz` also checks account/capability readiness and queue pause. Admin task details show structured errors, execution diagnostics and separate delivery outcomes. A completed request may still contain negative business decisions; callback `accepted` means HTTP acceptance only.

Explicitly run protocol/account probes inside your installation when needed:

```bash
docker compose --env-file /data/codex-agent-platform/.env exec -T runner node scripts/probe-codex.mjs
docker compose --env-file /data/codex-agent-platform/.env exec -T runner node scripts/probe-runtime.mjs
```

Neither probe starts a model turn. Real tasks and Manager messages do use your account; automated tests do not.

For a forgotten Admin password, supply a new password over stdin without a command-line literal:

```bash
read -r -s -p 'New Admin password: ' admin_password; printf '\n'
printf '%s' "$admin_password" | docker compose --env-file /data/codex-agent-platform/.env exec -T manager node scripts/admin-password.mjs
unset admin_password
```

## Upgrade and backup

Back up all runtime directories together while services are stopped, or use SQLite-consistent snapshots with coordinated workspace backups. Backups contain sensitive account state and business data. Do not delete data to upgrade. Build the new source, then run `start`; container recreation suspends/resumes incomplete work where Codex session state is available. Keep a rollback copy of source/images and data before upgrading. No rollback compatibility across future schema changes is promised in preview releases.

## System prompt changes

The image includes the root `prompts/` directory. Rebuild/redeploy after editing its fixed message templates. Existing Manager instructions are persisted, including their initial default; edit `manager.instructions` through Admin or management MCP to apply an updated default without a restart. See the [system prompt guide](../prompts/README.md). Plugin instructions continue to be managed as plugin configuration.
