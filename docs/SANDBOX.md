# Local management code sandbox

Management chat can upload files, copy its own attachments into a temporary workspace, run Python/JavaScript or ordinary container commands, and publish generated files back into that conversation. These tools also work during ordinary scheduled management inspections. They do not grant native Codex shell access or host source editing.

The sandbox is an optional host capability. Without its helper or a working fixed image, chat and existing management operations continue; sandbox tools report unavailable. Uploads and published attachments remain in private Manager storage independently of temporary workspaces.

## Build and enable

Use a Linux Docker Engine host, Python 3.10+ and the normal root-owned deployment source and runtime directories. Docker must support the specified cgroup memory, swap, CPU and PID limits and bounded tmpfs. Run `init` again on an existing deployment to create its socket channel before recreating Manager:

```bash
sudo ./deploy.sh init /data/codex-agent-platform
sudo ./deploy.sh build-sandbox /data/codex-agent-platform
sudo ./deploy.sh enable-sandbox /data/codex-agent-platform
sudo ./deploy.sh sandbox-status /data/codex-agent-platform
```

`build` also builds the sandbox image alongside the three platform service images. `build-sandbox` builds only `codex-agent-platform-sandbox:1.0.3`. The image contains Python 3.13.8, Node.js 24, pytest, NumPy, pandas, Matplotlib and Pillow with pinned Python dependencies. It contains no Codex, platform source, login files or platform credentials. Rebuild the image and rerun `enable-sandbox` after updating sandbox code; the helper uses its own installed copy of all four Python modules. Enabling stages those modules and configuration, then restarts the service even when already active. This stops current sandbox jobs and discards temporary workspace files; published attachments remain.

For a managed build proxy, preserve the inherited Docker proxy settings. If HTTPS requires an additional CA, pass a trusted combined certificate bundle through the optional BuildKit secret, for example:

```bash
sudo --preserve-env=HTTP_PROXY,HTTPS_PROXY,NO_PROXY,CODEX_PROXY_CERT \
  ./deploy.sh build-sandbox /data/codex-agent-platform
```

`CODEX_PROXY_CERT` names a host certificate bundle; it is mounted only during dependency installation. TLS verification stays enabled, and the bundle is not copied into the image. On hosts with standard public CA trust it is unnecessary. The direct equivalent is `docker build --secret id=proxy_ca,src=/path/to/trusted-combined-ca.pem -f Dockerfile.sandbox -t codex-agent-platform-sandbox:1.0.3 .`.

Setup copies the fixed helper modules into `/usr/local/lib/codex-agent-platform-sandbox/<installation>/`, writes a root-only configuration under `/etc/codex-agent-platform-sandbox/` and creates a separate `codex-agent-platform-sandbox-<installation>.service`. The installation ID derives from the runtime directory. This service is independent of the host updater. Source, configuration and their ancestor directories must be root-owned and unwritable by other users; setup refuses symlinks. It never accepts a Docker endpoint, arbitrary image, mount, source path or host command from the Agent.

Manager receives only the read-only directory mount `/run/platform-sandbox`, containing a root-owned socket accessible to UID/GID 1000. Neither Manager nor a code container receives the Docker socket. The helper accepts local Unix peers with UID 0 or 1000, exact `POST /sandbox` JSON operations and bounded request bodies. It runs Docker with argument arrays; the code command is interpreted only inside its code container. Keep UID 1000 trusted on the host, because it can call this local interface.

Enabling requires a running systemd host. In another supported Linux environment, supervise the helper in the foreground explicitly:

```bash
sudo ./deploy.sh sandbox-foreground /data/codex-agent-platform
```

This stages the same trusted fixed configuration without installing or starting systemd. Keep the process supervised and stop it before replacing the installed modules. `sandbox-status` distinguishes the enabled policy, socket existence and systemd service state; socket existence alone does not establish image/resource readiness. Foreground mode has no active systemd service.

```bash
sudo ./deploy.sh disable-sandbox /data/codex-agent-platform
```

Disabling stops and disables the helper's systemd service and removes its socket. A foreground helper rejects further requests immediately and observes the disabled policy within a second, then destroys its temporary containers and exits; also stop its supervisor so it does not try to restart. Existing chat attachments remain available.

## Workspace and limits

Each conversation gets its own container on first file write/import or execution. Reading sandbox context does not create a container. Files live in the container's tmpfs, without host mounts. File tools reject traversal, symlinks, special files and paths outside the workspace. Editing, importing or deleting inputs invalidates approvals tied to the previous workspace revision.

| Control | Fixed behavior |
| --- | --- |
| Container boundary | UID/GID 1000, read-only root, all capabilities dropped, no new privileges, private process/network namespace |
| Default resource limits | 1 vCPU, 1 GiB memory with equal swap limit, 128 processes |
| Temporary files | `/workspace` 256 MiB and 10,000 inodes; `/tmp` 64 MiB, counted against memory |
| Execution time | 60 seconds by default, up to 120 seconds without extra approval |
| Supported approved limits | At most 600 seconds and 2 GiB memory, subject to reported runtime support |
| Concurrent work | One command per conversation, at most two live sandbox containers |
| Output | stdout and stderr each retain at most 64 KiB; excess output is drained |
| File transfer | At most 20 MiB per uploaded/published file; at most five attachments/100 MiB per message |
| Text tools | Text writes at most 256 KiB, reads at most 64 KiB per slice, directory listings at most 200 entries |
| Idle lifecycle | Destroy after 30 minutes idle; reclaim the least recently used idle sandbox when capacity is needed |

Workspaces are temporary. Cancellation, timeout, out-of-memory failure, background process detection, recovery or explicit destruction can remove the entire container and its files. The execution record identifies confirmed cancellation or uncertain stop; it does not claim success when runtime isolation fails. Publish useful results before relying on them later. Attachment downloads remain authenticated and conversation-scoped; only safe bounded text and common images preview inline. HTML, SVG, PDF and archives download as attachments.

## Scoped human approval and networking

Ordinary code runs offline. Installing additional packages from an online registry requires supported network access and explicit approval. The Agent presents the exact command, working directory, requested domains, duration/memory and reason. A human allows, denies or revokes it in the conversation. Allow creates one continuation, bound to the conversation, container instance, input revision and request key; unused approval expires after ten minutes. A changed command or workspace requires a new request. Repeated execution keys do not replay side effects. Approval cannot select arbitrary Docker flags or widen the deployment hard limits.

Approved network access is available only when the host can enforce the adapter's complete Linux bridge/firewall boundary with rootful Docker, `iptables`, `ip6tables` and `ip` from iproute2. It uses an installation-local peer-bound HTTP/HTTPS proxy, exact canonical public domains on ports 80/443 and public DNS address validation. Direct egress, private/metadata addresses, raw IPs, wildcard domains, credentials in destinations and DNS rebinding are blocked. HTTPS CONNECT carries encrypted bytes; the adapter does not inspect methods inside TLS. Access ends when the command finishes, is cancelled or reaches its deadline; existing proxy sockets close as well.

The helper preserves configured upstream proxy policy in its root-only configuration and never passes upstream credentials to code. A host that requires an unsupported upstream proxy reports network approval unavailable: the adapter cannot promise pinned public DNS addresses while an upstream proxy independently resolves hostnames. It does not bypass that upstream policy. Missing firewall support likewise leaves offline execution available but blocks network approvals. A browser approval cannot repair an unsupported host network boundary.

## Operational checks

Inspect the helper's own unit with `systemctl status` or `journalctl -u` using the unit printed by `sandbox-status`. A missing helper, image, Docker daemon or resource limit is an unavailable capability, not a successful code execution. Check the sandbox context from Management chat for actual availability and supported limits. No host shell operation is exposed through management tools.

Helper startup and Manager recovery remove only containers labelled for that installation, expire unused grants and do not replay previous commands. Separate deployments derive different identities. Deleting a conversation queues scoped sandbox and attachment cleanup.

This uses ordinary Docker containers sharing the host kernel. It does not provide a separate kernel or hostile-tenant isolation. Docker operators, the host helper and server administrators remain trusted. The sandbox helper does not automatically start during a platform update or ordinary `start`; enabling it is an explicit deployment action.

### Attachment previews in chat

Supported UTF-8 text and source files open in a right-side drawer with a download action. Markdown (`.md`/`.markdown` or a supported Markdown MIME) renders with GFM headings, tables and code blocks, with a source-view toggle. Legacy Markdown attachments stored as plain text are recognized by their filename. Rendering reuses chat sanitization: raw HTML stays escaped, unsafe URLs are rejected and external images become links. HTML/SVG and unknown binary formats remain download-only. Images retain bounded previews. Invalid UTF-8 and NUL-bearing files cannot gain text preview by claiming a text MIME.

Sandbox permission requests belong under the management Agent bubble that initiated the work. If the corresponding reply has not been saved, chat renders a separate Agent activity bubble instead of placing the request beneath the human message. Permission identity, limits and authenticated allow/deny/revoke rules are unchanged.
