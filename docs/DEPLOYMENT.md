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

Ports (`PLATFORM_PORT`, `MANAGER_PORT`), volume root (`PLATFORM_DATA_DIR`), internal URLs and `RUNNER_TOKEN` are deployment bootstrap settings; changes need coordinated container recreation. `PLATFORM_PROJECT` is a shell override for the deployment script's Compose project name. Do not change existing deployment paths casually.

Changing the `.env` after initialization does not replace saved live values. Change those through Admin/management MCP. API credentials are write-only in settings responses. Keep the runtime directory private even though credentials are hidden in the UI.

## HTTPS and remote console access

For local administration from your computer:

```bash
ssh -L 3007:127.0.0.1:3007 user@your-server
```

Then open `http://127.0.0.1:3007/admin/`. For a public deployment, use `examples/nginx/platform.conf` as a reverse proxy template. Replace `agent.example.com` and the certificate paths with your domain and trusted full certificate chain. Configure certificate issuance/renewal with your existing ACME tooling. This repository does not install or alter host proxy/certificate services. Forward the original Host and `X-Forwarded-Proto`; the Admin uses them for origin checking and Secure cookies. Keep internal service ports private.

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
