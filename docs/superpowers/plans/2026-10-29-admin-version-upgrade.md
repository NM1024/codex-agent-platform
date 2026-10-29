# Admin version and optional web upgrade implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated implementation domains, and integrate with fresh review.

**Goal:** Display actual running version and support optional authenticated browser-triggered stable updates.
**Architecture:** A scoped Unix-socket host daemon executes the verified existing updater. Manager exposes authenticated human-only version/upgrade projections. A lazy topbar dialog tracks the durable host job across restart.
**Tech stack:** Python3.10+, systemd, Docker Compose, Node24, React/Ant Design.
**Spec:** docs/superpowers/specs/2026-10-29-admin-version-upgrade-design.md

## Review focus
- Host helper input/peer/path trust cannot become arbitrary root command execution.
- Duplicate clicks, helper and Manager restart, migration failure and completion verification are honest.
- Ordinary installations start without host service; fixed mounts survive daemon socket replacement.
- API auth/origin checks and bounded GitHub/Unix responses apply; Agent gains no tool.
- Version/upgrade UI fits320px, preserves other drafts, and cleanup stops polling on logout.

### Task1 Host service
Write failing synthetic tests, implement structured updater events, durable pinned host worker/systemd installer, Compose channel/init and host status. Run owned Python tests, coordinate contract changes.

### Task2 Manager API
Write failing route/service tests; implement actual package version, fixed latest-release checks, bounded Unix client and authenticated human-only routes. Run owned Node tests.

### Task3 Frontend version/upgrade
Write browser regressions, add lazy badge/dialog, current/latest/host capability, confirmation and reconnecting progress. Run type check; coordinate focused browser test execution with parent.

### Task4 Integration
Finish plugin tab/icon steering independently. Run npm test/check:release, related browser suite/cold-login/mobile checks. Review full branch, resolve material findings and open a new PR; preserve published v1.0.0 tag/assets.
