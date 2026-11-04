# Official Container Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Support source-built and official prebuilt updates through CLI and Admin, reducing host build/cache growth.

**Architecture:** A strict standard-library image release module verifies official manifests/archives and prepares the existing versioned local image aliases. CI publishes immutable verified candidates to GHCR; the publisher promotes those exact images and supplies a public Release image bundle. Existing source/data/backup/health contracts remain shared.

**Tech Stack:** Python 3.10+, Bash, Docker/Compose 2.20+, Node.js 24, React/Ant Design, GitHub Actions/GHCR.

**Spec:** `docs/superpowers/specs/2026-11-04-official-container-updates-design.md`

## Global Constraints

- Fixed methods `image` and `source`; new default `image`; ordinary deploy.sh build remains source.
- Four fixed components: gateway, runner, manager, sandbox; first supported platform linux/amd64.
- No arbitrary web registry, command, path or image reference. Preserve updater ProtectSystem=full and all private mounts.
- Prepare and verify before service stop. Back up before database validation. Preserve manual recovery semantics and versioned source.
- Use only synthetic data and callbacks. Management Agents gain no host shell, SQL or Docker API.
- Pages preview precedes UI changes; keep existing style. CLI source option remains usable when registry transport is unavailable.
- No global Docker prune. Cleanup defaults dry run, keeps three project versions and every container-referenced image.

## Review Focus

- A manifest/archive must never import unrelated tags: test archive tag/config/ID/label validation before docker load (Task 1).
- Old installed updater imports must still work with the standalone bootstrap and staged build hook: test legacy invocation and method default (Task 2).
- Same-version method switch must not report an unperformed switch: test saved method/no-op conditions and backup sequence (Task 2).
- Legacy web helpers must not be falsely labelled source-only: test capability absence and unchanged empty request (Task 3).
- CI candidates cannot authorize release from untrusted fork runs: test proof condition and immutable candidate revision checks (Task 4).

### Task 1: Verified official image artifacts and stable Docker dependency layers

**Files:** create `scripts/official_images.py`, `scripts/container-release.py`, `tests/official-images.test.mjs`; modify Dockerfile and Dockerfile.sandbox.

**Interfaces:** `validate_manifest(value, version, revision=None) -> dict`; `verify_archive(path, manifest) -> None`; `prepare(source, data, version, *, run=run_command, download=download_file) -> manifest`; `create_bundle(source, output, revision, *, run=run_command, registry=False) -> Path`. CLI actions `prepare`, `bundle`, `candidates`, `promote` have closed component/repository identities.

- [ ] Write tests using real JSON/tar fixture bytes, synthetic image identities, and only mocked external Docker/download boundaries. Assert wrong version/revision/platform/repo/components/config digest or unrelated archive tag raises before import/tagging. Assert registry failure uses the verified archive and never builds.
- [ ] Run `node --test tests/official-images.test.mjs`; expected missing capability failure, then implement the stdlib module and fixed CLI.
- [ ] Add canonical dependency-manifest generation and a production normalization test: root versions become 0.0.0, other dependencies/integrities remain exact. Use a dedicated Docker stage so only normalized manifests precede npm ci; restore actual package files afterward; delete npm cache within the same install layer. Add fixed OCI labels after dependency installation.
- [ ] Run the affected tests and release resource check; expected all pass. Commit the artifact/runtime boundary.

### Task 2: Source and image deployment paths

**Files:** modify deploy.sh, scripts/update-release.py, scripts/host-updater.py helper refresh files; extend tests/release_update_test.py and deployment tests; later actual scenario in tests/integration/release-update-smoke.py.

**Interfaces:** `update(install, event=None, method='image')`; CLI `update [runtime] --method image|source`, `pull [runtime]`; fixed `PLATFORM_UPDATE_METHOD` for staged compatibility. Successful state stores `method`.

- [ ] Add regression cases for source build, official import with no build, invalid method, prepare failure before stop, same-version unchanged method/no-op and explicit method switch, generated launcher option forwarding, standalone bootstrap and old staged build.
- [ ] Run `node --test tests/release-update.test.mjs tests/deployment.test.mjs`, observe new cases fail, implement using Task 1 module from the verified staged source.
- [ ] Extend backup preservation for the method metadata if needed. Keep source archive checksum, mount validation, exact active image IDs, source migration safeguards, and optional host helper setup behavior.
- [ ] Run these suites plus sandbox deployment tests; expected green. Commit.

### Task 3: Closed web method selection and matching version UI

**Files:** scripts/host-updater.py, src/manager/version.mjs, src/manager/server.mjs, frontend/src/VersionDialog.tsx, frontend/src/version-types.ts, frontend/src/version-i18n.ts, version CSS, relevant manager/browser tests and fixture.

**Interfaces:** POST /upgrade accepts `{}` or `{method:'image'|'source'}` only. New status advertises `methods:['image','source']`, `default_method:'image'`; jobs carry their actual `method`. Capability absence means release-default legacy behavior, not source-only. No client-supplied deployment options.

- [ ] Add failing parser/admission/client/API tests for both methods, unknown keys/values, duplicate requests preserving existing job method, and old helper empty-body compatibility.
- [ ] Implement safe projection and method-aware durable worker launch. Keep legacy start() with no parameter unchanged; explicit choices preflight capability and do not post unsupported fields.
- [ ] Implement Pages preview using existing modal styling. Busy job locks choice; command copy includes selected method; confirmation matches preparation; unknown legacy method is labelled default, not falsely image/source.
- [ ] Run manager-version and host updater suites; build Admin once and run version-upgrade browser suite with Chinese/English narrow layout and mode-handoff checks. Expected green. Commit.

### Task 4: Publish exactly tested official images

**Files:** .github/workflows/ci.yml and release.yml, scripts/container-release.py, scripts/package-release.py, scripts/verify-release-ci.mjs as needed, tests/ci-plan.test.mjs, tests/integration/release-update-smoke.py, docs/CI.md.

**Interfaces:** CI immutable tags `ghcr.io/nm1024/codex-agent-platform-COMPONENT:ci-SHA`; stable tags VERSION plus manifest digest; new public assets `container-images.json` and `codex-agent-platform-images-vVERSION-linux-amd64.tar.gz` covered by SHA256SUMS.

- [ ] Add policy tests for trusted candidate publishing and release proof; verify old source-only release compatibility. Expected new policy failure before implementation.
- [ ] Label/build all targets using actual tested SHA, run normal tests and both Compose update scenarios. Publish candidates only after all trusted CI checks pass; fork PRs keep code checks without publication permission or release proof.
- [ ] Publisher requires exact-commit CI proof, pulls and validates candidate IDs/labels, promotes immutable stable tags and produces the image bundle without rebuilding. Retry cannot replace different already-published stable images/assets.
- [ ] Upload and verify source/update/manifest/image assets in a draft, then promote stable. Public archive fallback remains usable when GHCR package visibility is private. Run actionlint and policy/unit checks. Commit.

### Task 5: Scoped cleanup, documentation and release

**Files:** scripts/official_images.py CLI, deploy.sh cleanup action, README.md, README.zh-CN.md, docs/DEPLOYMENT.md, docs/SANDBOX.md, release notes and explicit version pins.

- [ ] Add cleanup tests: default dry run changes nothing, keep newest three versions and all running/stopped referenced IDs, never remove other repositories' tags, require explicit apply flag and use no force/global prune. Run red, implement, run green.
- [ ] Document source and official install/update commands, architecture limits, GHCR visibility/Release bundle behavior, recovery and explicit cleanup. Bump only application versions to 1.0.8; preserve every dependency version/integrity.
- [ ] Run npm test and check:release, targeted browser suites, actual CI container/source/image scenarios, distributable checks, one independent whole-branch review and its necessary fixes.
- [ ] Create PR; once exact-source proof is green, merge, tag tested source, publish and verify public artifacts plus older-client update discovery. Update screenshot Page and report concrete usage.
