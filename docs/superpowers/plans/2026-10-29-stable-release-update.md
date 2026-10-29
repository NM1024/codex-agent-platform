# Stable release update implementation plan

> **For agentic workers:** use superpowers:executing-plans to implement this plan task by task.

**Goal:** Publish validated v1.0.0 and enable stable release self-updates.
**Architecture:** Bash deployment entry delegates safe discovery/update to a Python standard-library helper. GitHub latest stable assets are verified and staged, with consistent backups and Docker Compose health checks before recording activation.
**Tech Stack:** Bash, Python 3.10+, Docker Compose v2, Node 24 tests, Playwright.
**Spec:** docs/superpowers/specs/2026-10-29-stable-release-update-design.md

## Global constraints
- Never track main or prereleases for update; never overwrite checkout/runtime settings.
- Existing standard git/archive Compose installs supported; ambiguous/custom installs fail before stopping.
- Keep backup private, retain failed version for diagnosis; no automatic migrated-DB downgrade.

## Review focus
- Wrong directory/project and multiple installations must not restart another installation.
- Archive traversal, symlinks, checksum/version mismatch must fail before execution.
- Network/build/backup failures must retain prior deployment, and health failure must not claim success.
- Subsequent update/status must resolve active source, including unchanged-version no-op.
- Only tested release commit/assets are published; independent checkout changes preserved.

### Task 1: Release updater
Files: deploy.sh, scripts/update-release.py, tests/release-update.test.mjs.
- [x] Write process-level tests with synthetic HTTP responses and docker command adapter; observe missing helper failures.
- [x] Implement discovery, stable metadata checks, safe staging, lock, backup, build/health and activation.
- [x] Verify normal update, ambiguity, failures, checksum/traversal, no-op, and active-source resolution.

### Task 2: Release integration
Files: package.json, package-lock.json, compose.yaml, scripts/package-release.py, README*, docs/DEPLOYMENT.md, CI, browser code-copy test.
- [x] Stabilize code-copy measurement by asserting geometry in the retrying committed-frame check.
- [x] Add deterministic tracked-source packaging and checksum tests; version v1.0.0 and explain first upgrade/future update.
- [ ] Run npm test/check:release, all browser checks, all Docker targets and container suite.

### Task 3: Publish
- [x] Review branch with fresh reviewer, address material findings (project collision, live mounts, colocated source preservation, active updater, artifact builds).
- [ ] Push release preparation, wait for exact-commit GitHub CI success.
- [ ] Publish v1.0.0 tag and release with verified source/checksum assets; verify latest API and document update command.
