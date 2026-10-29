# Default host updater implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline, followed by whole-branch review.

**Goal:** Standard supported deployment and upgrades make browser updates available without a separate manual installation.

**Architecture:** Reuse the root-owned broker, add idempotent automatic setup and durable opt-out, and invoke it from start plus the staged-validation compatibility path used by already-published updaters.

**Tech stack:** Bash, Python 3.10+, systemd, React/TypeScript, Node 24.

**Spec:** docs/superpowers/specs/2026-10-29-default-web-updater-design.md

## Constraints and review focus

- No arbitrary Agent or container host control; preserve root path trust and fixed upstream.
- An active broker must survive its own upgrade. Test no restart/reinstall on automatic ensure.
- A disabled installation remains disabled across starts, updates and backups.
- Published v1.0.1 updater must reach automatic setup through staged validation.
- Missing systemd/untrusted paths and installation failure leave application deployment usable and print actionable guidance.
- All host installation tests redirect installation paths and system commands; synthetic Compose integration explicitly opts out.

### Task 1: Idempotent default setup and durable choice

Files: scripts/host-updater.py, tests/host_updater_test.py.

- [x] Write and run failing behavioral tests for default installation, unsupported hosts, active service preservation, setup failure warnings, persistent disable and re-enable, staged-source selection, and policy symlinks.
- [x] Implement internal `ensure-web-update`, policy storage and testable fixed installation roots. Explicit enable/disable persist operator choice; automatic setup honors it and skips unsupported hosts.
- [x] Run all host helper tests and npm test.

### Task 2: Deployment and upgrade compatibility

Files: deploy.sh, scripts/update-release.py, tests/deployment.test.mjs, tests/release_update_test.py, tests/integration/release-update-smoke.py.

- [x] Add failing executable deployment tests for start/staged validate/ordinary validate and a backup-policy regression.
- [x] Ensure setup after successful start and successful staged validate. Ensure after same-version verification to repair missing installations. Staged validation supplies the upgrade hook for both old and new updaters; preserve an active service.
- [x] Include policy in backups; explicitly disable service installation in synthetic real-Compose smoke data.
- [x] Run targeted deployment/updater checks and npm test.

### Task 3: User guidance and patch release

Files: frontend/src/VersionDialog.tsx, version-i18n.ts, tests/browser/version-upgrade.spec.mjs, README files, docs/DEPLOYMENT.md, docs/ARCHITECTURE.md, release/version metadata.

- [x] Change unavailable-service copy from required manual installation to automatic-setup diagnostics/repair; verify bilingual browser layout and behavior.
- [x] Document default installation, opt-out persistence, unsupported hosts and recovery; bump only platform metadata to 1.0.2 and add release notes.
- [ ] Run full local backend/types/release checks, package exact commit, review the branch, push PR and await complete CI (browser, all Docker targets, container tests, actual Compose update).
- [ ] Merge passing PR, tag the exact tested commit, publish stable v1.0.2 and verify public latest/download checksums.
