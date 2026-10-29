# Deployment and operations

Use a Linux host with Docker Engine, Compose v2 (2.20+), Python 3.10+, curl and outbound HTTPS access to the OpenAI authentication/Codex services. The pinned runtime is Codex `0.159.2`, Node.js `24`, with default model `gpt-6.1-sol`. Model availability depends on your own account. No API Key or substitute model/image provider is configured.

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

Legacy global `access` and `http` settings are no longer applied after upgrade. Humans must reconfigure any former global callback destination and its receiver credential on each relevant plugin. Old Agent-managed destination credentials are not copied into plugin connections. Ordinary `http_request` targets now use the separate live `http_targets` configuration group, editable in **Settings → HTTP targets** and through management configuration operations. `PLATFORM_HTTP_TARGETS_JSON` initializes this new scope only; retired saved `http` settings are not imported.

### Model and reasoning selection

Admin **Settings → Task execution** and **Settings → Management Agent** provide separate model and reasoning selectors. Choices come from Codex `model/list`, including each model's supported reasoning efforts; discovering the list does not start a model turn. The list is cached for up to one minute and does not guarantee that a later task will succeed or have remaining account allowance.

Each **Management chat** can save its own model and reasoning settings above the composer. Sending a message also saves the current choices. They apply to subsequent turns; already running work keeps its settings. Started message settings are recorded for inspection and recovery.

Open **Business plugins → Configure connection → Model settings** to choose a plugin's model and reasoning effort directly, or ask the management Agent to configure its optional `execution` object. Saving updates only these overrides and checks the plugin revision; if another operator or Agent changed the plugin, reload before saving. Business instructions, enablement and connections stay separate. Existing accepted tasks retain their plugin snapshot; editing a plugin affects only new submissions. Creation, business logic edits and trials still use management chat.

**Inherit global settings** leaves that override unset. **Model default** stores a null reasoning effort. A different model selected without an explicit effort uses that model's default rather than inheriting an effort from the global model. An explicit effort is checked against the selected model before a model turn starts.

Older saved model settings and plugin definitions are retained; plugin connections still require the human setup described above. If the model catalog is unavailable, the console preserves saved values and allows unrelated settings to be edited; restore Codex login/connectivity and refresh before selecting new models. Existing deployments should use Admin rather than changing the first-start `CODEX_MODEL` environment value.

To upgrade for these controls, rebuild the images and run `start` with the same runtime directory. The Manager adds optional execution columns to its existing database; keep your normal backup before upgrading.

The entire Admin interface uses React, TypeScript and Ant Design. Docker builds its static bundle in a dedicated `admin-build` stage; no frontend development server, Node installation on the host or additional container is required. The three-service deployment and `/admin/` reverse-proxy route stay the same. After upgrading, reload the browser page to receive the new hashed assets.

### Mobile console checks after an update

The top bar displays the platform title. Below 992px, a menu button opens the six page links; repository, language and sign-out actions use icons with accessible names. Chat keeps model, reasoning, image upload and send on one row, with full choices in their menus. Phone-only time-zone and keyboard hints are hidden; errors and settings-save feedback remain available.

After rebuilding and starting with your existing runtime directory, reload Admin and check the following on your phone:

- Open and dismiss navigation, switch language, and return to a chat with an unsent draft.
- Open and close the software keyboard, type several lines, and rotate the device. The composer should follow the visible browser area, with Send reachable and history scrolling independently. Pinch zoom remains browser-controlled.
- Add an image, open its in-page preview, close it, and send a short test message when you intend to use the account. Automated UI checks use synthetic transport; physical iOS/Android keyboard behavior is a deployment check.

### Browser and proxy caching

Manager supplies the following cache policy; normal Nginx proxying can pass it through without an additional cache configuration.

| Response | Cache policy |
| --- | --- |
| Content-hashed JS/CSS under `/admin/assets/` | `public, max-age=31536000, immutable`; new builds use new asset URLs. ETags support conditional reloads. Brotli, gzip and identity representations have distinct strong ETags and `Vary: Accept-Encoding`. |
| `/admin/` HTML | `no-store`, with a fresh CSP nonce and current bundle references on each request. |
| Favicon and third-party notices | `no-cache` with ETags; unchanged content can return 304. |
| Authenticated conversation images | `private, no-cache`, content ETag and `Vary: Cookie`. The browser may store image bytes, but revalidates session and conversation ownership before reusing them. A match returns 304 without image bytes; deleted or unauthorized images do not. |
| Admin JSON and credential responses | `no-store`; do not enable shared proxy/CDN caching. |
| Conversation SSE | Retain `no-cache, no-transform`, unbuffered streaming and the browser's EventSource cache bypass; keep shared proxy/CDN caching disabled. |

Preserve `Cache-Control`, `ETag`, `Vary`, `Content-Encoding` and cookies through your proxy. Avoid blanket `expires` or `add_header Cache-Control` rules that override or append contradictory policies for all `/admin/` responses. Do not strip image authorization or expose its private storage as a public static directory. In browser DevTools, turn off **Disable cache** while verifying normal caching: fresh hashed assets can use memory/disk cache directly; image revalidation and explicit conditional asset reloads can use 304. A browser-facing cached response may appear as 200 even when the underlying validation request received 304.

Management Agent replies render Markdown, including lists, tables and fenced code. Raw HTML remains literal text; images are links rather than automatic remote loads. Both user and Agent messages show their saved timestamps in the browser's local locale and time zone. Schedule rules still use each plan's explicit time zone.

Management chat also displays durable message states, queue order, elapsed time and collapsed activity. Available public reasoning summaries, assistant progress and tool lifecycle metadata are projected from the [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server); raw reasoning and tool arguments/results are not included in this activity view. Model output may omit summaries. Replies support Markdown copying and separate fenced-code copying. A message being accepted into the queue does not mean its Agent turn has completed.

Humans can attach up to four JPEG, PNG or WebP images by selection, paste or drop. Browser compression limits each image to 160 KiB and a 2048px longest edge; backend validation independently checks actual decoded raster data. The message text limit is 20,000 characters, so compressed image messages fit the existing 1 MiB JSON/Nginx body limit without a proxy increase. Manager stores private images alongside its message data and serves previews only through authenticated conversation-owned URLs. Preserve the Manager data volume during an upgrade. Images are included with the original message in one Codex turn; actual model support and account access still apply.

Conversation titles prefer Codex `thread.name` from start/resume responses, `thread/name/updated` notifications, and a bounded metadata read after a successful turn. The app-server may not supply a name: the existing title is retained in that case. The platform does not start an extra model turn to generate a title. Title lookup failures do not retry completed management work.

Ports (`PLATFORM_PORT`, `MANAGER_PORT`), volume root (`PLATFORM_DATA_DIR`), internal URLs and `RUNNER_TOKEN` are deployment bootstrap settings; changes need coordinated container recreation. `PLATFORM_PROJECT` is a shell override for the deployment script's Compose project name. Do not change existing deployment paths casually.

Changing the `.env` after initialization does not replace saved live values. Change those through Admin/management MCP. Ordinary `http_request` destinations are editable in **Settings → HTTP targets** or the `http_targets` configuration scope; their saved values override bootstrap `PLATFORM_HTTP_TARGETS_JSON`. Read the current revision before saving the complete targets map; retain unrelated targets and omit existing tokens to preserve them. Stale revisions return a conflict rather than overwriting another edit. Saving does not send a request, and the next tool call uses the new target without restart. These settings remain separate from per-plugin callbacks. Normal credential updates remain write-only. A pending backend-generated key can be disclosed once by the human-only claim action; it stays temporarily in private Gateway storage until claimed or replaced, then only its authentication hash remains. A lost claim response may require human replacement. Protect runtime databases and backups, including their free pages. Keep the runtime directory private even though credentials are hidden in the UI.

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

## Automatic history cleanup

Open **Settings → History retention**. Automatic deletion is **off by default** and stays off across upgrades until explicitly enabled. Choose 30 days, 60 days or a custom integer from 1 to 3650, then save the switch and retention days together. Settings persist across restarts. Concurrent changes require reloading the latest policy before saving.

Enabling cleanup or shortening the age applies to already-expired data from the next background check (within roughly one minute). Owners perform daily scans in bounded batches, continuing large backlogs over later wakeups. Disabling prevents new batches; a batch already in progress can finish. No model allowance is used. There is no archive/export stage: deletion is permanent.

- Management conversations expire from their last activity and include messages, execution/activity records, questions, uploaded/generated images and local session/work files. Unsent drafts, unconfirmed guidance and active/queued/recovering work are protected.
- Completed/failed tasks expire from their end time. Their input/results/errors, tool and execution records, artifacts/session/work files and associated trigger history are removed together. Valid receipt windows, pending callbacks and callbacks still sending are protected. Runner must confirm file cleanup before Gateway deletes task metadata; unreachable Runner leaves the task for retry.
- Plugin definitions, connection credentials, scheduled plan definitions, live settings and shared account authorization remain. This affects local platform data; it does not delete independent backups, upstream provider records or data already sent to external systems.

Services reclaim SQLite free pages while idle; database size may contract later than deletion when work is active or temporary disk space is insufficient. Deleted rows no longer appear through the platform even while physical compaction is deferred. Preserve ordinary backups separately if you need records past the chosen age. To install these controls, rebuild and recreate the existing three services with the same runtime directory, then reload Admin; no new environment variable is required.

## Upgrade and backup

Back up all runtime directories together while services are stopped, or use SQLite-consistent snapshots with coordinated workspace backups. Backups contain sensitive account state and business data. Do not delete data to upgrade. Build the new source, then run `start`; container recreation suspends/resumes incomplete work where Codex session state is available. Keep a rollback copy of source/images and data before upgrading. Schema rollback compatibility is not promised; restore the pre-update runtime backup together with its matching source/images.

## System prompt changes

The image includes the root `prompts/` directory. Rebuild/redeploy after editing its fixed message templates. Existing Manager instructions are persisted, including their initial default; ask the management Agent to update `manager.instructions` through management MCP to apply revised editable instructions without a restart. The versioned project rules and human-only connection policy are independently appended on every management start/resume with a content revision. An image upgrade applies these rules to the next turn even with saved custom instructions; history and custom responsibilities remain. `platform_context` explicitly refreshes those current rules without requiring Gateway. Live configuration and capabilities still come from their own tools. See the [system prompt guide](../prompts/README.md). Plugin instructions continue to be managed as plugin configuration.

### Read-only management source

Manager's `project_source` tool lists, searches and reads allowlisted files from the **currently deployed image**. The Manager image includes `frontend/src`, management/shared adapter source, `prompts`, `docs` and selected root documents. Use `mode: "list"` to find paths, `mode: "read"` with a repository-relative path for numbered lines, or `mode: "search"` with a literal query. `offset` starts at zero; follow `next_offset` for more results. Every response includes a source content revision. Source access works in existing conversations and without Gateway; relevant excerpts are sent to the model as tool results.

The tool has no write, shell, execution or Git operation. Fixed path/type allowlists exclude credentials, runtime volumes, generated bundles, hidden paths and symlinks. Reads and searches are bounded; oversized files are reported as unavailable. It does not clone a repository or turn source support into account authorization. After updating source, rebuild and recreate Manager with the existing runtime directory; `git pull` alone cannot update files inside a running image. Reload Admin, continue an old chat and ask it to refresh `platform_context` and inspect the implementation with `project_source`. The Manager target runs `check-release.mjs --manager-source` to verify that its readable source was packaged.

### Operations overview after an update

Rebuild and restart with the existing runtime directory using `deploy.sh build`, `deploy.sh start`, and `deploy.sh status`. No database migration or new configuration variable is required for the resource-card overview. Reload Admin and check **Overview**:

- Host memory and the Manager data filesystem show used/total capacity, plus available space. The filesystem can reserve free blocks, so used + available need not equal total.
- Host CPU needs two samples. Missing `/host/proc` or cgroup fields show unknown; an explicit cgroup `max` shows unlimited. RSS is the Manager process value, not a host or container total.
- Filter host/Manager cards, inspect service details, and check phone/tablet layouts. The page refreshes every ten seconds without overlapping slow reads.
- During an appropriate maintenance window, validate pause/resume and concurrency changes; lowering concurrency does not stop active tasks. Restart Runner only after reading the confirmation because it can interrupt active connections.

Only the Manager data filesystem and the metrics already collected by the platform are displayed; this view does not enumerate every disk or collect network traffic/history. Warning colors do not automatically pause dispatch.

## Management concurrency and memory

Rebuild and recreate the existing services with the same runtime directory to install the memory controls. No new environment variable is required. Existing Manager settings gain `concurrency:2` while retaining model, prompt, timeouts and settings revision. In **Settings → Manager**, choose 1–5 simultaneous management rounds. This does not change business task concurrency or stop rounds already running.

Pending conversations and interrupted wake signals remain in SQLite. Saved conversations are not deleted or shortened, normal continuations preserve their native thread context, and Codex's existing compaction strategy stays unchanged. Busy image uploads can return retryable `503 IMAGE_PROCESSING_BUSY`; no management message has been enqueued on that failure. If unconfirmed operation history exceeds the bounded recovery context, automatic recovery pauses explicitly rather than repeating uncertain work.

For resource diagnosis, separate anonymous/process memory from file pages. An idle container can retain executable/library and database pages after Codex subprocesses exit; `docker stats` normally excludes inactive file pages but can include active ones. See [memory behavior, limits and benchmark method](MEMORY.md).


## Stable release updates

`deploy.sh update [runtime-directory]` installs GitHub's latest published stable Release, not a branch tip. Source, checksums and a standalone `update.sh` are attached to each release. For an older installation without this command, download the latest release's `update.sh` and run `sudo bash update.sh update`. It embeds the updater and discovers the original Compose source path from container labels; no host Node installation or Git checkout is required. Python 3.10+, curl, Docker Engine and Compose v2 2.20+ are required. Outbound HTTPS to api.github.com, github.com, release-asset redirects, npm and the image registry is needed.

Discovery uses existing Manager containers (including stopped containers), exact bind mounts and Compose project labels. An explicit runtime path or `PLATFORM_PROJECT` disambiguates installations. If containers no longer exist, provide the initialized runtime path from an existing source directory. Unsupported custom Compose files/overrides require manual upgrading; the updater will not guess a configuration. Never run two Compose projects against the same data directory. Environment overrides must agree with the persisted data path.

The updater locks one installation, validates published stable semantic-version metadata and asset URLs, verifies SHA256SUMS and archive paths/types, stages a private source copy under `releases/`, and checks the three services' persistent mounts. It builds first, then stops the same project, saves a consistent private backup under `backups/`, validates the new runtime configuration and starts with `--wait`. Validation can migrate SQLite data, so it happens after backup. Successful health checks record `.deployment.json` and install a fixed runtime `deploy.sh` launcher. If source and runtime share a directory containing an existing deployment script, the generated launcher is `platform-deploy.sh` so source is preserved. Future `update`, `status`, `logs`, `start`, `stop`, `login` and `build` follow the active release. The original source checkout remains untouched. A current installed release is a no-op. Previews, drafts, missing assets and downgrades are refused.

Backups include `.env`, management/task databases, workspaces, artifacts, account authorization and the previous update state/launcher. They exclude release source and previous backups, and do not follow symlinks. Backups are sensitive, are not covered by automatic history cleanup and are not automatically pruned. Source stages/images are also retained; review disk use and delete old backups/images only after verifying the deployment. Build or download failure leaves old services running. Backup failure attempts to restart the old stopped containers. Failed validation or health checks leave the new attempt unactivated, retain its diagnostics and report the backup; some new containers may be running, so inspect the printed Compose command. Health checks establish service liveness, not account/model availability; no model task is submitted by update.

### Recovering a failed update

Do not point an old image at a database already migrated by a newer version. First stop the affected project using the exact project and Compose arguments printed by the updater. Keep the failed runtime separately for diagnosis. Restore the full pre-update backup into a separate private runtime directory, or restore its contents into the original directory only after moving aside the failed state. The backup `.env` refers to the original runtime path: verify it deliberately before starting. Use the matching previous source recorded in `.deployment.json` (or the original checkout for the first update), build its images and start against the restored data. Do not delete Docker volumes or shared login state as an upgrade step. Update can interrupt current turns; schedule a maintenance window and pause new work when appropriate.

### Publishing a stable version

Update package.json/package-lock.json, Compose/build image tags and Codex client version together. Commit, run all checks, and wait for CI success on the exact commit before creating `vX.Y.Z`. Package that exact Git commit with `python3 scripts/package-release.py --revision <commit> --output .tmp/release`. The packager uses git archive with explicit distributable roots; local changes, dependencies, runtime files and credentials are excluded. Upload the resulting versioned tar.gz, `SHA256SUMS` and `update.sh` to a non-prerelease GitHub Release and mark it latest only after asset upload. Do not replace published stable tags/assets. Publishing a tag alone does not make it an updater target.


<a id="optional-host-service-for-browser-upgrades"></a>

## Host service for browser upgrades

The Admin topbar gets its current version from the authenticated Manager endpoint reading the image's package.json; neither GitHub nor `.deployment.json` defines the running version. Latest-release discovery is a separate bounded, cached, fixed-upstream request. It requires the same published stable source/checksum/bootstrap assets as the CLI updater. The Admin upgrade routes remain outside management MCP.

Standard root deployments on Linux/systemd automatically ensure the host service after `deploy.sh start`. Existing installations are covered when upgrading, including updates invoked by published v1.0.0/v1.0.1 scripts: their staged validation command adds the helper after application validation succeeds. An already-active broker is left running, so its own upgrade job is not interrupted. The current updater also checks setup on same-version updates. Ordinary `validate`, `init`, `build` and `status` do not install a service.

Use a trusted root-owned deployed source, runtime and `.env`, with no symlink or group/world-writable ancestry. The installation guide clones under `/opt` as root. If the Git checkout is user-owned, use the stable CLI update as root to stage a root-owned release; the upgrade automatically configures the helper from that selected source. Non-root hosts, unavailable systemd, untrusted paths or setup failure print actionable warnings without stranding the application deployment. CLI updates remain available. `deploy.sh enable-web-update [runtime-directory]` explicitly retries configuration and reports failures.

Setup pins one installation, project and upstream in a private `/etc/codex-agent-platform-updater/<installation-id>.json`, copies trusted helpers beneath `/usr/local/lib/codex-agent-platform-updater/<installation-id>/`, and enables `codex-agent-platform-updater-<installation-id>.service`. The installation ID is derived from the absolute runtime path.

The standard Compose file mounts only `<runtime>/updater` read-only into Manager at `/run/platform-updater`. Init creates this harmless channel even without the helper. The root-owned Unix socket accepts only fixed status/start operations from root or UID1000, and accepts no command, URL, path, tag or environment override. Root-private state and bounded logs stay outside the mount at `/var/lib/codex-agent-platform-updater/<installation-id>/`. No other platform container gets the channel, and Docker's socket stays on the host.

A start returns a durable job immediately. Duplicate starts reuse active admission; work runs outside Manager's lifetime. The worker uses the current trusted release updater, pins the selected tag/digest privately, records phases, preserves pre-migration backup, and verifies running healthy containers against the built image IDs and in-image versions before success. Successful updates refresh the trusted helper and restart its fixed systemd unit after persisting completion. Helper restart marks uncertain work interrupted; it never automatically replays migration or downgrades data.

`deploy.sh web-update-status [runtime-directory]` shows the host service, saved enable/disable choice and durable job when Admin is unavailable. Private `worker.log` records bounded diagnostics; protect it and backups as sensitive operational data. `disable-web-update` persists an explicit opt-out in the private runtime `.web-update-policy.json` and stops the helper and its workers. Subsequent starts and upgrades honor this choice; `enable-web-update` restores it. A previously disabled/masked v1.0.1 unit is recognized as an opt-out when there is no policy file. The policy is included in backups; lock files are not. To opt out before first start, run `disable-web-update` after `init`.

Stopping during an upgrade can leave a recovery-required state. Before restoring data or changing the installation path/project, disable this service and follow the existing consistent-backup recovery procedure; re-enable it only for the intended restored installation. Service liveness and version verification do not prove account/model availability. No account model request is made by upgrading.
