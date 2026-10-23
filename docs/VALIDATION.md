# Validation

## Model settings and React Admin migration

Verified on 2026-10-23 with synthetic data and Node.js 24:

- Strict TypeScript (including unused code checks), Vite production build, and `npm run check:release` passed. Release validation covered 61 JavaScript modules, 2 JSON resources and all referenced Admin bundle assets/licenses.
- `npm test` passed 196 cases in an isolated Linux environment with Git and Bash. The frontend was built separately, so npm lifecycle hooks were skipped for this read-only test run. The single Compose configuration case was filtered using `NODE_OPTIONS=--test-skip-pattern=^Compose` and passed separately against the actual host Docker Compose CLI: 197 checks covered in total.
- 25 browser cases passed against the production React bundle: all six views and login, independent conversation/plugin model and reasoning selection, offline catalogs, locale and navigation drafts, schedule identity/enable state, request-ID search, task investigation, partial artifact availability, duplicate-retry protection, password/session revocation, 390px layout, local assets and nonce-based CSP.
- Independent review findings about chat drafts, retry duplication and partial artifact failures were reproduced with failing browser tests and fixed. A separate CSP check caught component-library style probes without a nonce; a narrow build adapter now supplies the document nonce at the vendor style insertion boundary and fails explicitly if the locked dependency changes that insertion function.
- Gateway, Runner, Manager and test Docker targets built using a temporary validation Dockerfile that omitted the system certificate installation step. The original production Dockerfile's Debian package download failed in this environment, so the unchanged CA installation step was not revalidated. The dedicated frontend build stage and copied runtime bundle were exercised; the Manager image contains compiled assets and bundled dependency notices, and excludes the old frontend and React/Vite/TypeScript development installations.

No local platform deployment, account login or real model task was performed. Temporary images, logs and browser screenshots are validation evidence only; `.tmp/` is excluded from source distribution. Actual account capability and full production image builds remain deployment/CI checks.

## Initial standalone snapshot

The initial standalone preview was checked with synthetic data and local services:

- Host: `npm test` — 181 passed, no skipped tests.
- Clean staged source export: `npm run check:release` — 58 modules and 2 JSON resources.
- Docker: `test`, `gateway`, `runner` and `manager` targets built from that export.
- Test container: non-root, read-only filesystem, no network — 175 passed. Six host deployment tests require Docker/Git and run in the host suite.
- Isolated Compose: three healthy services, generated independent Admin password, two generic plugins, five live configuration groups, paused queue submission, password/session revocation.
- Chromium: desktop and 390px mobile checks for login, live configuration, write-only credentials, ingress rotation, persisted settings, safe text rendering, password change and logout.
- Callback plugin restart: both a custom plugin and a bundled example edited to use a persisted HTTP destination remain usable after reopening storage.
- Gitleaks 8.24.3: no findings in the staged source distribution.
- `npm audit --omit=dev`: no reported advisories for the locked dependencies at validation time.

No real account authentication, model/image generation or production callback was used. Tests prove transport and platform behavior with fixtures; real-account capability availability and generated content quality still require verification in the operator's deployment. Scan results describe this snapshot, not a guarantee about future changes or every possible vulnerability.


## Bilingual console and workflow checks

The console follow-up was validated with the same account-free boundary:

- Host: `npm test` — 182 passed; no failures or skips.
- Browser: `npm run test:browser` — 14 passed in Chromium against a synthetic local server. Coverage includes plugin save/trial continuity, disabled schedule editing, settings drafts across group saves, Enter search and caller request IDs, image preview/text download, safe chat rendering and polling, session reload/logout, Chinese/English switching and persistence, mobile navigation, typing during a slow language refresh, and English service validation errors.
- UI review: 18 fresh screenshots across Chinese/English, desktop and 390px mobile. Navigation stays visible on phones; keyboard focus, field labels and secondary text contrast were improved. User-entered plugin definitions, prompts and task data are preserved when changing language.
- Clean Git-index export: release validation passed with 59 modules and 2 JSON resources. All four Docker targets built from the export; the non-root, read-only, network-disabled test container passed 176 tests with no skips.
- Locked dependency audit, including development dependencies: no reported advisories. Gitleaks 8.24.3 found no secrets in the clean source export.
- Independent review reproduced two additional issues (edits made while a language request was pending and untranslated schedule validation errors). Both were fixed and their targeted browser regressions passed on re-review.

Run the browser suite with the commands in [CONTRIBUTING.md](../CONTRIBUTING.md). Screenshots and test reports are temporary local evidence under `.tmp/`; they are not shipped as product data. Browser and transport tests use synthetic metrics, tasks and Agent messages. They do not verify production networking, actual account permissions, model output quality or the accuracy of a real management Agent's investigations.


## System prompt consolidation

The platform-owned Manager, task wrapper, recovery and investigation prompts are loaded from the root `prompts/` directory. Validation uses synthetic data only:

- Host: 185 tests passed. Coverage includes editing prompt files in another language, preserving literal business data during interpolation, and retaining saved Manager instructions over file defaults.
- Browser: 15 checks passed, including investigating a task from Admin and reopening its existing management conversation without another generated message.
- Release validation: 60 modules and 2 JSON resources. Removing each of the five prompt files makes validation fail; formatted multiline resource URLs with a trailing comma are checked too. Docker explicitly copies the prompt directory, and CI builds all four release targets before running the isolated container suite.
- Independent review compared the moved Manager prompt and rendered task/recovery/investigation messages against the previous implementation and found no wording changes.

No real model or account was used to assess the effectiveness of edited prompts. Changing wording in another language still requires the operator to evaluate the resulting Agent behavior.

## Management chat display and read-only plugins

Verified on 2026-10-23 with synthetic data and Node.js 24:

- `npm test` in the isolated Linux validation image: 202 passed, no failures/skips. The host Compose configuration test passed separately, for 203 platform/deployment checks. The Linux command excludes Compose because the validation image has no Docker CLI; host verification uses the same test file against `docker compose config` and starts no services.
- Production frontend build/typecheck and `npm run check:release` passed. The bundle includes locked React Markdown 10.1.0 and remark-gfm 4.0.1 plus generated license notices.
- Browser suite: 27 passed against the synthetic local fixture. Coverage includes Markdown headings/code/tables, escaped HTML, blocked script URLs, external images rendered as links, message timestamps in New York and Tokyo browser contexts, title updates during polling, read-only plugin details and the management-chat shortcut, plus the existing settings/task/schedule/session/mobile/CSP flows.
- Six new backend tests cover Codex start/resume names, matching-thread notifications, sanitization and title length, optional metadata lookup after durable completion, lookup timeout without replay, mismatched-thread metadata and malformed names. No title generation turn is added.
- Fresh desktop Markdown and mobile plugin screenshots were inspected. Independent code review found no actionable implementation issues; README plugin guidance was corrected to describe the read-only page.

These checks do not use actual login credentials, submit real account work or deploy the platform locally. They do not establish whether an upstream Codex client will generate a thread name; the platform uses names when supplied and otherwise keeps its fallback title.

Docker follow-up: all four targets (gateway, runner, manager, test) built with the latest source and frontend bundle using the temporary validation Dockerfile. As in the prior validation, the network-blocked Debian apt step was omitted. The new admin-build stage completed `npm ci` and built the bundle from the updated lockfile. Repeated production dependency downloads stalled, so the validation build reused the previous verified production layer after comparing all 136 production lock entries (versions and integrity hashes) and confirming exact equality. The production Dockerfile is unchanged by these test-only accommodations; a fresh unmodified image build including apt/network dependency installation remains an environment limitation.

The resulting test target passed all 197 container tests with no failures/skips, using a read-only root filesystem, no network and public CA roots mounted read-only for the synthetic TLS tests.

## Simple Admin controls and layout cleanup

The final interaction policy follows the user's clarification: humans can use single-operation controls (plugin/schedule enable-disable, queue pause-resume, model/reasoning selection and scalar/password settings). Complex plugin/plan creation, editing, trials, structured JSON, HTTP destinations and management instructions use management chat. The Agent retains every preset management operation.

Verified with Node.js 24 and synthetic data:

- 203 platform/deployment checks: 202 isolated Linux npm tests plus the host Compose configuration check; no failures or skips.
- 32 production-bundle browser tests: simple switches, rapid duplicate clicks, failure state preservation and retry, complex settings read-only display, management shortcuts, plugin/inspection/task plan details, localization, existing tasks/chat/settings/session behavior, and CSP.
- Layout checks cover all six pages in Chinese and English at 390px, 768px and 1440px. Twenty-four desktop/phone screenshots were generated; accepted screenshots from every page were inspected. No whole-page horizontal overflow; details actions stay within plugin/schedule mobile tables; settings cards have consistent spacing. Screenshots alone do not establish full accessibility conformance.
- CSS was consolidated into one readable layout/content sheet with duplicate overrides, unused classes and removed editor styles cleaned out. The old frontend directory is absent. A release regression creates a legacy directory/file and confirms that publishing validation rejects it; old asset URLs remain 404.
- Strict TypeScript/production frontend build and release resource validation passed. All four isolated packaging targets built and the final non-root, read-only, network-disabled test target passed 197 tests. The same apt/network and verified dependency-layer reuse accommodations described above apply; a fresh unmodified production Docker build remains unverified in this environment.
- Independent review found a directory/file existence mismatch in the release guard; it was fixed, regression-tested and re-reviewed successfully. No remaining implementation findings.

No real credentials, account/model tasks or local platform deployment were used. Temporary evidence is under .tmp/readonly-ui/ and is excluded from distributable source.
