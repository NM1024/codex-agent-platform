# Default host updater

The operator approved making web upgrades part of standard deployment, automatically adding the service to existing installations on upgrade, preserving an explicit opt-out and explaining unsupported hosts. This changes the deployment default; the human-only Unix-socket upgrade boundary remains unchanged.

Use the existing root-owned Linux/systemd helper. Do not mount Docker into Manager or add Agent tools. `start` ensures the helper after starting services. Staged `validate` also ensures it after application validation: published v1.0.0/v1.0.1 updaters invoke this command but have no post-activation hook. Installation must use the selected staged source, while the running broker continues to resolve activated deployment metadata. Already-active services must not restart during their own upgrade job.

Persist explicit enable/disable in a small private runtime policy file, include it in backups, and preserve opt-out on subsequent starts and updates. Automatic setup skips unsupported hosts (non-root, missing running systemd, untrusted source/runtime) with an actionable warning; setup failure must not strand an otherwise healthy application update. Explicit enable continues to report setup errors. Automatic setup never runs during ordinary `validate`, build, init, or status.

Retain root-owned, non-writable, non-symlink path checks. New standard installation instructions use a root-owned checkout. User-owned checkouts can first use the CLI stable updater to stage a trusted release. The UI explains that standard deployments configure the service automatically and provides status/repair guidance when unavailable.

Alternatives considered: keep manual opt-in (does not meet the approved request); install only from `start` or a new updater hook (misses upgrades invoked by published scripts). The selected compatibility hook is bounded to `PLATFORM_UPDATE_STAGED=1` and does not touch an already-active broker.

Ship as a new patch release, v1.0.2, after exact-commit complete CI. Do not alter v1.0.0/v1.0.1 published tags or assets. Tests use synthetic paths/systemctl commands and never install a real service on the development or CI host.
