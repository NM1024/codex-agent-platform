# Validation

## Default business concurrency and management project knowledge

Verified on 2026-10-24 with Node.js 24 and synthetic data:

- New configuration, Compose services, deploy initialization, execution settings, dispatcher/Runner capacity and the overview fallback default to five business tasks. Explicit or persisted values, including one, remain authoritative. Tests check real capacity reservations and dispatch rather than only inspecting constants.
- Every management thread start/resume receives versioned project operating rules in addition to saved editable instructions and the fixed human connection policy. Coverage checks both new and resumed threads with changed custom instructions, the shared default interpolation and release rejection when the new prompt resource is absent. Rules cover lifecycle/request independence, plugin/capability contracts, model inheritance, schedules, deployment and current chat behavior. Tool discovery remains authoritative for live state; no repository, shell, SQL or credential access was added.
- Production capability discovery advertises only Agent-editable delivery mode `none` and exposes safe human connection policy metadata. Existing human-only endpoints and callback enforcement remain unchanged; generic library catalogs retain their delivery behavior.
- Complete verification passed: 238 isolated Linux npm checks plus two host Compose checks (240 total), 70 production-bundle browser checks, TypeScript/production build and release validation (80 modules, 3 JSON resources). Lifecycle hooks were skipped only for the read-only Linux npm run after the frontend build ran separately. Original single-slot runtime scenarios now explicitly request concurrency one; their implicit-default failure was reproduced before correcting the fixture. Separate coverage verifies default capacity five.
- All four Docker packaging targets built from clean staged source. The final non-root, read-only, network-disabled test image passed 233 checks. Validation used the previously documented temporary Dockerfile without the blocked apt step and with the unchanged verified production dependency layer; a fresh unmodified production Docker build remains unverified here.
- Independent review found one inaccurate schedule explanation: admission failures belong to `schedules.blocked_reason`, while waits after acceptance require `overview` and `tasks/task`. The wording was corrected and re-reviewed with no remaining findings. Prompt and tool descriptions must be updated alongside future behavior changes; first-install prompt or README changes alone do not inform saved installations.

No real model/account tasks, credentials or local platform deployment were used. Temporary evidence is under `.tmp/manager-context/`. Synthetic transport tests verify what instructions are sent; they do not establish that a real model will always follow them.

## Admin workspace, settings tabs and verified password changes

Verified on 2026-10-23 with Node.js 24 and synthetic data:

- Rebuilt the shared shell and responsive styles. Chat has separate user/Agent bubbles, a desktop conversation list/mobile drawer, a scrolling transcript, compact model/effort controls and a persistent composer. Execution records collapse and scroll separately. Enter sends, Shift+Enter adds a line, and IME composition does not send. Settings categories use separate tabs and preserve drafts across tabs/languages.
- Every remote password update (direct HTTP, operations and management MCP) requires the current password. Wrong/missing passwords preserve active sessions; successful changes revoke all sessions. Version-conditional replacement prevents concurrent use of an outdated password. The trusted local stdin recovery path remains available. Regression tests check both remote routes, MCP schema enforcement, races and absence of submitted passwords in action records.
- 206 isolated Linux `npm test` checks plus the separate host Compose configuration check passed (207 total). The frontend build/typecheck ran separately before the read-only Linux test run with lifecycle hooks skipped. `npm run check:release` passed for 77 JavaScript modules and 3 JSON resources, including every deferred/compressed Admin resource.
- 46 browser checks passed against the production bundle. All six views were checked in Chinese/English at 390, 768, 1440 and 2560 pixels. Short English phones at 320×568/390×568 and landscape at 844×390 keep header and Send controls reachable. Tests cover long transcripts, scroll retention, six-line input, long expanded activity, model-save retry/order across page unmounts, global-default labels, tab isolation/drafts and password rejection/session revocation.
- Task and overview tables now keep phone status/actions visible without horizontal scrolling. UUIDs retain their full text/title while truncating visually; hidden secondary columns remain available in task details. Search, investigation, artifact downloads, retry and pagination remain intact.
- All four isolated Docker targets built; the final non-root, read-only, network-disabled test image passed 201 tests. The previously documented temporary validation Dockerfile accommodations for blocked apt downloads and verified production dependency-layer reuse still apply.
- Independent review reproduced model-save ordering, inherited-model labeling, expanded activity and short-screen layout issues. Failing regressions were added and the fixes re-reviewed. No remaining actionable findings. Fresh screenshots from every page, all six settings categories and desktop/phone security/chat previews were inspected.

No actual credentials, real account/model tasks or local platform deployment were used. Preview text is synthetic; `.tmp/chat-layout/` contains temporary logs and screenshots and is excluded from distribution.

## Admin loading and compressed assets

Verified on 2026-10-23 with Node.js 24 and synthetic data:

- All six pages load on demand, with localized loading and recoverable chunk-failure feedback. Markdown stays in the deferred management-chat chunk. React, TypeScript and Ant Design remain in use.
- The previous public entry was 1,235,125 uncompressed bytes. The new login JS dependency graph is 760,106 raw bytes / 249,155 gzip bytes / 230,174 Brotli bytes. Login plus the default overview is 1,026,923 raw / 333,802 gzip / 310,121 Brotli bytes. These totals include shared dependencies; they are not just the entry filename. CSS adds about 2.7 kB gzip. Other pages add their deferred chunks when visited. These are build/browser byte measurements, not a promise of production network latency.
- 204 Linux npm tests and the separate host Compose check passed (205 total). Lifecycle hooks were skipped only in the read-only Linux test run after the production build was completed separately. Strict TypeScript/production build and `npm run check:release` passed (75 JavaScript modules, 3 JSON resources).
- 34 browser tests passed, including cold login/overview transfer budgets, deferred requests, chunk failure/reload recovery, CSP and all existing settings/chat/task/plugin/schedule/locale/responsive checks. A viewport test now waits for the mobile navigation before measuring its geometry.
- Brotli/gzip round trips, preference/zero-quality negotiation, identity fallback, exact HEAD lengths, Vary, MIME and missing/direct-compression URLs are covered. Nonce HTML and authenticated APIs are excluded from this compression path. Release tests reject missing deferred chunks and either compressed representation.
- All four isolated Docker packaging targets built, and the final non-root, read-only, network-disabled test image passed 199 checks. The previously documented temporary Dockerfile accommodations for blocked apt downloads and verified production dependency-layer reuse still apply. Independent review found no actionable implementation issues.

No real credentials/account tasks or local deployment were used. Temporary evidence is under `.tmp/admin-loading/`.

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

## Human-owned per-plugin connections

Verified on 2026-10-23 using Node.js 24 and synthetic data:

- 217 isolated Linux `npm test` checks plus the host Compose configuration check passed (218 total). Coverage includes unique paths/keys, cross-plugin submission/query/artifact denial, retired global-key rejection, credential rotation, human-only transport, secret-free Agent views and task snapshots, persistence, legacy migration, readiness gates and callback delivery. Unconfigured Agent-created plugins cannot enable, trial or execute scheduled work; saving connection settings does not enable them automatically.
- All 49 production-bundle browser checks passed. The frontend passes TypeScript, bundle budgets and release validation (79 modules, 3 JSON resources). Connection dialogs provide field guidance, cryptographic random values, write-only secret edits, safe examples and independent state across cancellation and delayed loads. Responsive probes cover 320/390/768/1440 widths and English on phones.
- Independent review found that default call examples incorrectly used the Admin origin in split-port deployments. Regression tests first reproduced the defect, then verified relative-path display/copy and explicit Gateway placeholders, plus absolute URL examples. A separate regression verifies that fixed connection guidance applies to existing saved custom Agent instructions on both thread start and resume.
- All four isolated Docker packaging targets built from both the working source and a clean staged-source export; both non-root, read-only, network-disabled test images passed 212 tests. The temporary Dockerfile uses the same apt/network and unchanged verified production dependency-layer accommodations described above. Exported dependency manifests were verified semantically identical and given the working copy's line endings to reuse the already validated dependency installation. A fresh unmodified production Docker build remains unverified in this environment.

Upgrades deliberately retire the global `access`/`http` settings groups. Humans must configure each plugin's entry key and optional callback; old credentials are not copied automatically. Ordinary HTTP capability targets use server bootstrap configuration. These checks do not use real login credentials, start account/model work or deploy the platform locally. Temporary evidence stays under `.tmp/plugin-connections/` and is excluded from source distribution.

## Management progress, image input and local feedback

Verified on 2026-10-23 with Node.js 24 and synthetic data:

- 228 isolated Linux `npm test` checks and the separate host Compose configuration check passed (229 total). New backend coverage includes exact thread/turn ownership, pre-acknowledgement events, finalized-event suppression, durable FIFO and restart recovery, private image validation/storage/authenticated previews, one multimodal initial turn, bounded public activity and complete final replies. Polling regressions check fragmented and quoted credentials, tool payload omission, raw reasoning omission and recovery without terminal replay.
- All 70 production-bundle browser checks passed. Coverage includes queued/running/terminal states, collapsed activity, partial replies, image compression/count/dimension limits, image-only messages, paste/drop/preview persistence, independent loading and guarded buttons, literal code copying and clipboard failure, slow or failed confirmation reads, navigation and logout races.
- Independent review found that component-owned send locks and draft cleanup did not survive navigation. A failing browser regression reproduced the issue; provider-owned, session-aware send ownership now retains busy state across reentry and clears accepted attachments once. Additional regressions cover initial chat-list loading and short-screen transcript space. Stable accessible labels keep clipboard controls usable when their loading icons animate.
- Twelve responsive captures cover Chinese/English phones, tablet, desktop and 844×390 landscape with queued work, four image drafts, six text lines and collapsed/expanded activity. Final metrics show no page overflow, clickable Send controls and at least 96px transcript space in the short landscape case. Four previews share one row on phones. Screenshots were visually inspected; this does not establish comprehensive accessibility conformance.
- TypeScript, production build, initial gzip bundle budget and release validation passed (80 modules, 3 JSON resources). All four isolated Docker packaging targets and the non-root, read-only, network-disabled test image were checked; the final container suite passed 223 checks. The same temporary Dockerfile and verified unchanged dependency-layer accommodations described above apply; a fresh unmodified production build including the network-blocked apt step remains unverified here.

Images persist in the Manager volume and are never embedded repeatedly in conversation polling responses. Activity records expose public summaries and tool metadata, not raw reasoning or tool argument/result payloads. No actual login credentials, model/account tasks or local platform deployment were used. Direct Windows suite attempts encountered known sandbox filesystem/symlink restrictions; complete-suite evidence comes from Linux. Temporary logs, generated protocol schemas and captures stay in `.tmp/chat-progress/` and are excluded from distribution.
