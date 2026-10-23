# Codex Agent Platform

[中文说明](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Plugins](docs/PLUGINS.md) · [Deployment](docs/DEPLOYMENT.md)

A self-hosted task platform built around autonomous Codex Agents. Submit structured input, let an Agent complete the work through MCP tools, and receive a structured result.

**Preview release.** Node.js 24, Docker Compose, SQLite and the pinned Codex CLI are required. Sign in using your own ChatGPT account; an account with the required model and native capabilities is necessary. This is an independent project, not an official OpenAI product. The console and bundled prompts currently use Chinese.

## How it works

- Each accepted request creates a new task and an independent Codex conversation, even when the request ID and input are identical.
- Normal execution sends one complete task message. The Agent chooses its steps and submits the final result through `complete_task`.
- JSON plugins define input/output schemas, prompts, tools and optional routes. Examples include content review and illustrated fiction.
- A separate operations Agent and Admin console manage tasks, explicit retries, plugins, schedules, health and persistent live settings.
- Restart recovery resumes incomplete work using its existing task, run and Codex thread. Terminal tasks do not restart automatically.
- Generated images and text can be stored as task artifacts. Optional callbacks use named destinations; credentials stay on the Gateway.

## Quick start

Run on a Linux host with Docker Compose v2. Keep the source directory separate from runtime data.

```bash
git clone https://github.com/NM1024/codex-agent-platform.git
cd codex-agent-platform
./deploy.sh init /data/codex-agent-platform
./deploy.sh build /data/codex-agent-platform
./deploy.sh login /data/codex-agent-platform
./deploy.sh start /data/codex-agent-platform
curl http://127.0.0.1:3004/healthz
```

Complete the device login in your own browser. Open `http://127.0.0.1:3007/admin/` on the server or through an SSH tunnel. The independently generated initial password is in `/data/codex-agent-platform/manager/initial-password`; change it after login. Use [the deployment guide](docs/DEPLOYMENT.md) for HTTPS, permissions and remote access.

Submit a task with the `INGRESS_TOKEN` generated in your local deployment `.env`:

```bash
read -r -s -p 'Ingress token: ' INGRESS_TOKEN; printf '\n'
export INGRESS_TOKEN
curl -sS http://127.0.0.1:3004/v2/tasks \
  -H "Authorization: Bearer $INGRESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"content.review","request_id":"example-1","input":{"content":"A short article to review."}}'
unset INGRESS_TOKEN
```

The response is HTTP 202 with a `task_id`. Query `GET /v2/tasks/{task_id}` using the same authentication. Completion and callback delivery have separate statuses. Business rules and output formats belong to plugins, rather than the scheduler.

## Development

```bash
npm ci --ignore-scripts
npm test
npm run check:release
```

Tests use synthetic fixtures, local services and fake Codex transports; they do not use a real account or spend model turns. `npm run probe:codex` checks account readiness; `npm run probe:runtime` checks the pinned app-server/MCP protocol without starting a model turn. Run those explicitly in an installation you own.

See [contributing](CONTRIBUTING.md) and [security](SECURITY.md). The platform source is MIT licensed. OpenAI services and third-party dependencies have their own terms and licenses.
