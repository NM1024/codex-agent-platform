# Validation

## Automatic history retention

Verified on 2026-10-28 with Node.js 24 and synthetic data:

- Retention is off by default. Revision-checked settings persist the switch and 1–3650-day age, with 30/60-day presets. Enabling or shortening the policy applies to existing eligible history; disabling prevents new batches.
- Tests cover strict age boundaries, interrupted migrations, daily cursor/restart recovery, policy changes/outages, active work and callback protection, transactional metadata ownership, real Runner HTTP and file deletion, shared credential preservation, unsafe paths/symlinks/FIFOs, durable Manager cleanup retries and actual SQLite file contraction. Deferred compaction survives new sweeps.
- The full backend suite passed 363 checks, TypeScript/production build and release validation passed (92 modules, 3 JSON resources). All four unmodified Docker targets built; the non-root, read-only, network-disabled test image passed 356 checks, excluding host deployment checks.
- 66 focused production-bundle browser checks passed across retention settings, Admin/connection settings, streaming/deletion and HTTP targets. Coverage includes default-off behavior, custom age persistence, stale-write conflicts, English phone controls, cold-login transfer budgets and existing desktop/phone layouts. This was a focused run, not the full browser suite.
- Independent review identified ancestor-symlink protection, lost deferred compaction and interrupted timestamp backfills. Regression tests reproduced each issue before the fixes. No Critical or Important findings remain.

No real credentials, model tasks or deployed data were used. No live retention policy was enabled. Rebuild/recreate the services with the existing runtime directory to install the feature, then explicitly configure it in Admin.

## Per-plugin integration documentation

Verified on 2026-10-24 with Node.js 24 and synthetic data:

- Each plugin row now opens a read-only, localized integration drawer with protocol, request, response/query, callback and error tabs. Code/full Markdown copy and per-plugin Markdown downloads use the currently selected document. Loading, retries, plugin/locale changes and late responses remain isolated; incomplete setup has a human connection CTA, with no editor or automatic trial.
- The cookie-authenticated Manager endpoint derives current definition/connection revisions, bounded nested/reference field summaries and full input/result schemas. Examples are shown only when Ajv validates the complete schema; recursive/unsupported cases remain explicitly unavailable. Keys, callback credentials, actual callback URLs/query strings and business instructions are excluded. Relative paths retain a Gateway placeholder instead of assuming the Admin host.
- Seven backend regressions cover isolation, freshness after edits, unauthorized/missing resources, no task/Agent side effects, real synthetic acceptance/query envelopes, request_id length, reference siblings and validated examples. Bash examples were checked using a local replacement curl that only prints arguments, including variable expansion and safe apostrophe/command-substitution quoting.
- Complete Linux npm verification passed 254 checks plus two host Compose checks (256 total); TypeScript/production build and release validation passed (83 modules, 3 JSON resources). The frontend build ran separately before skipping lifecycle hooks in the read-only Linux test container. Both Manager-only dependency tests pass without broadening their original boundaries; documentation helpers belong to Manager, not the plugin compiler.
- The complete browser suite passed 86 checks before the final drawer-only phone cell-width adjustment; nine targeted documentation/responsive checks passed after it and after the final backend changes. A further strengthened annotation assertion/capture check passed. Coverage includes actual saved plugins, transport/error tables, input/result isolation, safe Markdown, copy/download and failures, retries/stale selection/locale, desktop/phone layout and setup guidance. The phone-width regression was observed failing at 61px cells before the scoped 96px minimum and contained horizontal scrolling fixed it. Final desktop/390px captures of real generated contracts were inspected.
- Independent backend review found Markdown row spacing and discarded reference-sibling fields; failing regressions were added, fixes passed and re-review found no remaining findings. Independent frontend review found no actionable issues. Bundled example schemas gained descriptions/examples only; existing persisted definitions remain unchanged and can be annotated through management chat.
- All four Docker targets built from clean staged source. The final non-root, read-only, network-disabled test image passed 249 checks. The existing temporary validation Dockerfile accommodations for blocked apt downloads and reuse of the unchanged verified dependency layer still apply; a fresh unmodified production Docker build remains unverified here.

No real credentials, model/account tasks or local platform deployment were used. Evidence is under `.tmp/plugin-docs/`. Direct Windows Bash invocation hit the known sandbox/WSL limitation; the authoritative shell and complete-suite checks ran in Linux. Reading/exporting a document submits no task and makes no model call. Missing business annotations remain explicit rather than generated by an account-backed model.

## Live management chat and deletable history

Verified on 2026-10-24 with Node.js 24 and synthetic data:

- Management chat uses a cookie-authenticated SSE snapshot/patch stream instead of healthy-connection transcript polling. Public Codex output appears directly in an assistant bubble; completion retains that bubble's identity. Reconnects restore state without submitting another turn. Streaming failure falls back to polling with explicit connection feedback. Read/navigation versions prevent delayed REST responses, including stale 404s, from overriding newer streamed content.
- Nine backend regressions cover initial/update/final/reconnect frames, conversation isolation, unauthorized/missing resources, revoked sessions, slow clients, shutdown, Chinese text without whitespace, fragmented credential filtering, text beyond the activity budget, reopen/recovery and transactional deletion. Local cleanup removes owned thread/work directories without following the shared synthetic login symlink. Busy conversation/Agent states reject deletion, and business data stays separate.
- Complete Linux npm verification passed 247 checks plus two host Compose checks (249 total). TypeScript/production build and release validation passed (81 JavaScript modules, 3 JSON resources). The frontend build ran separately before lifecycle hooks were skipped in the read-only Linux npm run. Direct Windows focused checks omit only Linux filesystem/symlink scenarios; the authoritative Linux suite has no skips.
- All four Docker targets built from clean staged source, and the non-root, read-only, network-disabled packaged test image passed 242 checks. The previously documented temporary Dockerfile accommodations for blocked apt downloads and reuse of the unchanged verified dependency layer still apply; a fresh unmodified production Docker build remains unverified here.
- Independent backend and frontend reviews found no actionable issues. The full browser suite passed 78 checks; an additional focused admission-order check passed after the unchanged production build (79 checks altogether). Nine new browser regressions exercise native EventSource, Chinese incremental output, completion without duplicate bubbles, deletion persistence, reconnect/fallback/navigation and stale-response guards, loading/errors, pending protection, draft retention and phone controls. Existing polling-era tests now assert actual streamed updates; REST-only layout fixtures explicitly exercise polling fallback. The delayed-admission regression verifies that an older POST acknowledgement cannot erase a running message already received over SSE.
- Desktop/390px phone live-reply captures and a settled, hit-tested mobile deletion-confirmation capture were inspected. The initial mobile capture caught the modal's enter transition; waiting for confirmation-button hit testing produced the visible dialog. No stacking or layout fix was needed. Screenshots and both full/targeted browser logs remain in `.tmp/chat-streaming/`.

No actual credentials, account/model tasks or local platform deployment were used. Temporary evidence is under `.tmp/chat-streaming/`. Provider-side deletion and secure erasure of SQLite free pages/backups are outside local chat-history deletion semantics.

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

## Admin presentation and assistant-owned activity

Verified on 2026-10-24 using Node.js 24 and synthetic fixtures:

- 254 isolated Linux npm tests and two host Compose checks passed. TypeScript, production build and release validation passed (83 modules, 3 JSON resources).
- All 89 browser checks passed before final presentation adjustments; affected activity, copy/export and responsive layout checks were rerun afterward. Stronger field-boundary checks reproduce and guard the phone input overflow, covering Chinese/English at 320px, 390px and desktop widths. Geometry is measured after the input becomes stable and clickable, with paired coordinates read in the same frame.
- A regression first reproduced assistant text duplicated in Activity. Completed and live replies now remain solely in assistant bubbles; collapsed reasoning/tool activity follows the corresponding AI message and retains correct request ownership. Reply-only activity does not leave an empty timeline. Icons preserve accessible names, independent busy states and honest clipboard feedback. Removal of the header refresh control also removes its unused orchestration; navigation reload and live updates retain coverage.
- Desktop/phone settings, connection and chat screenshots were inspected. A mobile component override found during visual review drove the explicit two-column form grid and input-boundary regression. Captures and logs remain in `.tmp/admin-polish/`, outside distributable source.
- All four isolated Docker packaging targets built from clean staged source; the non-root, read-only, network-disabled test image passed 249 checks. The temporary Dockerfile still omits the network-blocked apt step and reuses the previously verified unchanged production dependency layer, as described above; a fresh unmodified production Docker build remains unverified here.
- Independent review found no actionable issues. No real credentials, model/account tasks or local platform deployment were used.

## Backend-generated entry keys and live composer refinements

Verified on 2026-10-24 with Node.js 24 and synthetic data:

- All 261 isolated Linux npm tests and two separate host Compose checks passed (263 total). Seven added backend checks cover initialization without disclosure, idempotency, nonrotation, schema migration, pending authentication/admission/recovery gates, persistence, revision conflicts, concurrent single disclosure, manual revocation and human-only transport. Existing custom Manager instructions receive the updated fixed connection policy on subsequent turns.
- All 106 production-bundle browser checks passed. Ten claim checks include a real initialization/claim endpoint flow and synthetic loading, copy failures, lost responses, revisions, manual replacement, stale callbacks, logout and localization. Five reasoning checks confirm inherited global effort, selected-model defaults, explicit overrides and unchanged persistence semantics. Live message author/time/status remain on one line in mixed interface/browser locales. The composer uses one complete focus frame across typing, model selection and buttons, without separate textarea/toolbar outlines.
- The old Auto label and wrapped live heading were reproduced before their fixes. The integrated run exposed an inaccessible loading-state claim label and a transient modal zoom measurement; a fixed accessible name and settled geometry check addressed those issues. Read-only Linux validation also caught two tests writing to the source tree; they now use disposable OS temporary directories, consistent with the existing suite.
- TypeScript, production build and release validation passed (83 modules, 3 JSON resources). Four isolated Docker packaging targets built from clean staged source; the non-root, read-only, network-disabled container passed 256 checks. The existing temporary Dockerfile/network/dependency-layer accommodations still apply, so a fresh unmodified production build remains unverified here.
- Synthetic claim/header screenshots were inspected, with generated key fields masked. Pending plaintext exists only in private Gateway storage until a human claims or replaces it; normal metadata, definitions, task snapshots, Agent actions and exported docs never disclose it. Logical deletion is not secure erasure of SQLite free pages or backups. Lost keys require human replacement, whose save revokes the previous key.
- Independent review of backend claim authorization and UI stale-result handling found no actionable issues. No real credentials, account/model tasks or local platform deployment were used. Logs, temporary exports and captures remain in `.tmp/entry-claim/` and related ignored `.tmp/` files.

## Compact plugin connection layout and responsive list columns

Verified on 2026-10-24 with synthetic data only:

- Applied the approved Pages prototype to the production React modal: retained entry/callback tabs, aligned labels, one claimed/replacement key field, icon copy controls, collapsed help and an integration-document link that preserves form drafts. Invalid fields select their tab; disabling a saved callback explains deletion on save.
- Plugins, Schedules, Tasks and Overview use flexible text columns and content-sized status/action/time columns. Containers up to 820px use compact rows; long plugin descriptions/identifiers have bounded summaries with full text in titles/details. Protocol Markdown schema tables retain their own contained horizontal scrolling.
- All 109 browser checks have passing results: the full suite passed 108 and hit one transient four-image-draft failure; a targeted 16-check rerun passed that case, related image/chat cases and all three new connection/table regressions after the final CSS update. Chinese/English long-content checks cover 390, 768, 1024 and 1440px. Synthetic desktop/phone screenshots were inspected with key fields masked.
- TypeScript/Vite and release validation passed (83 modules, 3 JSON resources). The equivalent Node test runner passed all 261 non-Compose tests in isolated Linux; both host Compose configuration tests passed separately. The production non-root, read-only, network-disabled test container passed all 256 checks.
- Four temporary Docker packaging targets passed. They reuse the unchanged dependency layer and copy the existing validation image's system CA bundle, which the earlier exported base lacks. This validates current source/assets packaging, not a fresh standard apt/npm image build.
- Host Windows npm test is not claimed green: initialization/legacy Admin migration, release module validation, configuration reopening, Runner execution snapshot, independent Manager loading, foundation Codex task, native image review, pinned Manager recovery and separate Runner/MCP integration cases failed or hung under the host POSIX/native executable environment. Linux direct tests and container tests passed. The validation image's npm wrapper also exited before starting tests with no actionable error, so its identical package test command was executed directly through Node.
- Independent review found a hidden callback fragment-validation gap. A browser regression reproduced it before the fix; the final targeted suite passed after matching backend fragment rejection and selecting the callback tab. Earlier pending-claim busy labels regained explicit accessible names. No account/model tasks, actual credentials or platform services were used.

## Public reply items and native clarification cards

Verified on 2026-10-24 with Node.js 24 and synthetic data:

- A regression reproduced replacement of distinct assistant output by the final result. Public items now persist independently with stable bubble identities and per-item updates; the final record does not duplicate the last item. Interrupted trailing text is flushed into its own item rather than replacing earlier commentary or duplicating it as final output.
- Native item/tool/requestUserInput is enabled only for Manager, validated against the pinned 0.159.2 generated schema and checked against official App Server documentation. A real pinned Codex process connected to a local fake Responses server/MCP asked a question, waited for a human answer and continued with exactly one turn/start. No account authorization or external network was present.
- Tests cover up to three questions with choices/authorized free text, rejected secret prompts, exact active conversation/thread/turn binding, single answers, request resolution/expiry, authenticated same-origin HTTP routing, unchanged approval denials, interrupted/recovered history and scoped deletion. Question answers use a dedicated response route rather than creating another queued message. Waiting remains subject to the configured turn timeout.
- All 113 production-bundle browser checks passed in one complete run. The four new cases cover preservation across completion without duplicate final output, navigation/new-bubble draft retention, prototype-named question IDs and independent pending/error feedback with duplicate-submit guards across page navigation. Desktop/phone synthetic screenshots were inspected.
- Independent review identified loss of drafts when a card moved/unmounted. Its regression failed before moving draft/pending/error state into the session provider keyed by conversation/request, then passed. Logout invalidates old asynchronous leases. Own-property lookups cover both pending and historical answers. An additional author regression reproduced the interrupted trailing-item duplication and passed after flushing that item.
- Final strict TypeScript/Vite and release validation passed (86 JavaScript modules, 3 JSON resources). All 269 isolated Linux project tests plus both host Compose checks passed (271 total). As in the preceding section, the Linux package test command was executed directly through Node because the validation image npm wrapper exits before running tests; the host Windows npm run is not claimed green.
- All four isolated Docker packaging targets passed; the non-root, read-only, network-disabled packaged test image passed 264 checks. The same documented reused dependency layer/system CA accommodations apply. A fresh unmodified standard Docker build remains for CI/server verification. No real account/model tasks, credentials or local platform services were used. Logs/captures and clean staged source remain ignored under .tmp/.

## Logical deletion of plugins and schedules

Verified on 2026-10-24 with Node.js 24 and synthetic data:

- Nullable tombstones migrate existing plugin/schedule tables, hide deleted entries and prevent save/enable/startup seeding from resurrecting them. Plugin deletion disables its dependent task schedules atomically. Accepted task snapshots, completion after restart, optional callbacks, historical results and existing-key scoped task/artifact access remain intact; new admissions/retries and connection mutations are rejected.
- Schedule deletion stops future ticks and cancels unclaimed inspections while preserving past trigger records. Independent review reproduced a stale-list cancellation race. Manager now atomically claims before creating local work; regressions cover deletion winning the claim, claim winning deletion, lost acknowledgements and source-ID deduplication. The internal claim operation is absent from Agent contracts.
- All 275 isolated Linux project tests and both host Compose checks passed (277 total). The non-root, read-only, network-disabled packaged test image passed 270 checks; all four isolated packaging targets passed. Strict TypeScript/Vite and release validation passed (86 JavaScript modules, 3 JSON resources).
- The validation image's npm test wrapper still exits before executing tests; the identical package Node test command was run directly, with Compose checks run separately on the host. One host Windows module-isolation check also failed at its existing symlink permission requirement; the equivalent Linux checks passed. Docker verification reuses unchanged dependencies/system CA as documented above, rather than claiming a fresh unmodified apt/npm image build.
- Delete actions require a human confirmation and keep independent pending/error states. A browser check exposed a loading icon changing the accessible confirmation-button name; the button now retains its explicit name. No account/model tasks, real credentials or platform deployment were used; all temporary logs and staged sources remain ignored under .tmp/.
- All 115 browser cases have passing results: the full run passed 113, with one outdated schedule-guidance assertion and one phone documentation-tab timeout. The assertion was updated to include logical deletion; a four-case targeted rerun passed both cases and both new delete flows. The phone timeout did not reproduce. Existing long-content responsive checks passed and desktop/phone captures were inspected.

## Live HTTP targets in Admin and management chat

Verified on 2026-10-24 with Node.js 24 and synthetic data:

- Added the separate persistent `http_targets` scope and a dedicated Admin tab with target list, create/edit modal and confirmed deletion. The management Agent uses existing preset configuration operations with a current revision; no shell or source access was added. Token reads are masked, omissions retain them and explicit empty strings clear them. Local HTTP sink tests verify injected credentials, changed URLs, removal and immediate next-call application; save itself sends no request.
- Six new backend regressions cover production discovery, revision conflicts, real local tool calls, bootstrap/persistence precedence, ignored retired HTTP data, invalid edits without credential disclosure and a real MCP configuration interaction. The final production-startup regression reproduced an eager bootstrap JSON failure before lazy defaults were introduced: valid saved targets now take precedence even over malformed environment JSON; a fresh installation still rejects invalid bootstrap data. Independent review confirmed the correction and fresh-install scope assertion update with no remaining findings.
- All 281 isolated Linux project tests and both host Compose checks passed (283 total). Strict TypeScript/Vite and release validation passed (84 JavaScript modules, 3 JSON resources). Four Docker packaging targets passed; the non-root, read-only, network-disabled packaged test image passed 276 checks. Packaging retains the previously documented reused dependency/system CA accommodations; a fresh standard apt/npm image build is not claimed.
- All 118 browser cases have passing results: the complete run passed 117 and sampled the old width immediately after switching to a phone viewport in one new check. Waiting for settled responsive layout resolved that check; a targeted three-case run and an additional phone-modal visibility/geometry check passed. Coverage includes create/edit/delete, masked/retained/cleared tokens, reload, stale Agent/page conflicts, local validation, duplicate-submit locks, retained failure drafts and English phone layouts. Synthetic desktop and phone screenshots were inspected with secret fields empty.
- Host Windows configuration reopening and Runner execution-snapshot checks hit existing SQLite cleanup/fsync restrictions; Linux equivalents passed. The validation-image npm test wrapper still exits before running tests, so its equivalent package Node command was run directly, with Compose checks separate. No actual websites, account/model tasks, login credentials or platform services were used. Logs, staged sources and screenshots remain ignored under .tmp/.


## Compact mobile console

Verified on 2026-10-25 with Node.js 24 and synthetic local fixtures:

- The top bar uses the platform title. Below 992px, navigation opens downward from a menu button and repository, language and sign-out controls use icons with accessible names. Menu choices settle at a 44px touch height. Desktop sidebar navigation remains available.
- Model, reasoning, image upload and send share one phone toolbar row. Phone-only hints are hidden; character-limit errors and model-save feedback remain accessible. Drafts, full picker options, image controls and sign-out behavior are covered.
- VisualViewport resize/scroll events adjust the normal-scale mobile shell and preserve browser pinch zoom. Checks include offset, keyboard-height reduction down to 240px, restoration and draft retention. The compact transcript minimum scales down only in short visible areas. Physical iOS/Android keyboard behavior was not exercised.
- Mobile menus load on demand; the existing cold-login compressed-script budget remains unchanged and passes. Stable history-action labels exclude exiting loading-spinner text; the delayed-page regression passed 10 isolated repetitions.
- Final application suite: 293 passed. Final Chromium suite: 148 passed, including locales, phone/desktop geometry, loading/modal alignment and existing media/cache/race behavior. TypeScript/production build and release validation passed (88 modules, 3 JSON resources). Independent review and `git diff --check` found no remaining issues.

No production credentials, real-account model tasks or production deployment were used. Build outputs, screenshots, probe scripts and logs remain under ignored directories.

## Operations overview cards

The approved operations overview is implemented in the actual Admin frontend, using synthetic local API fixtures for visual acceptance. The six resource cards distinguish host metrics, Manager cgroup metrics, process RSS and the Manager data filesystem. Tests cover reserved disk blocks (`bfree` versus `bavail`), malformed/missing cgroup fields, explicit unlimited quotas, partial host samples and CPU warm-up.

Browser checks cover resource filters, correct capacity ratios, readiness/paused/unknown states, preserved concurrency drafts during polling, integer validation, a running count above a lowered limit, restart confirmation, refresh failure/recovery, slow reads, editor write locks and stale response ordering. Responsive geometry covers Chinese and English at 320, 390, 768, 1440 and 1920 pixels; the existing broader Admin regressions also exercise the page.

Actual Chromium screenshots were opened and reviewed, including normal, high usage, unlimited, missing, paused and blocked states. Desktop resource cards measured 196px high and phone cards 184px high; service and task cards were consistent within their groups. Scheduling buttons measured 36px and compact service actions 32px. No card overflow was observed in the sampled desktop/phone layouts. The phone empty-table placeholder was corrected to remain centered, and the mobile restart confirmation was visually checked after its opening animation.

Captures and inspection logs remain under ignored `.tmp/overview-implementation/`. The visual checks use synthetic values, not a production server. No real Runner restart or account-backed task was executed, and this follow-up does not add network traffic, history charts or all-disk enumeration. Existing deployment volume mounts must expose the relevant host/cgroup metrics; unavailable sources remain explicitly unknown.

Final verification for this follow-up: `npm test` passed 294 tests; `npm run test:browser` passed 157 tests (6.8 minutes); TypeScript/Admin production build passed; `npm run check:release` passed with 88 modules and 3 JSON resources; `git diff --check` passed. Independent review findings were resolved and covered by the final suite. No Docker image rebuild or production deployment was performed in this follow-up.

### Overview viewport CI timing

The `227cc78` push workflow failed one overview geometry assertion while the same commit's PR workflow passed. Frame-level diagnostics reproduced the cause: resizing to 320px immediately after choosing a locale left the closing desktop language popup at its old coordinates, briefly making document width 1333px (1793px from the wider desktop case). The test now waits for the popup to become hidden and polls document width after resizing before measuring cards. Existing width limits, card-height checks and empty-state centering remain unchanged; production code is unchanged. Local verification passed 294 application tests, release validation and ten consecutive executions of the affected bilingual, five-viewport browser test.

## Manager memory bounds

Verified on 2026-10-29 with Node.js 24 and pinned Codex 0.159.2. The clean-checkout comparison is reproducible with `python3 tests/benchmarks/manager-memory/run.py`; its README describes isolated workers, baseline extraction, synthetic seeds and scope. No actual account credentials, external model tasks or production data were used.

The benchmark runs the full `ManagementAgent`/`ManagerStore` execution path against baseline `8db12f7`, with the model fixture in a separate process and identical disk-backed seeds for both versions. It measures the management execution worker and native Codex separately, not the complete HTTP Manager container. The native binary is invoked directly; the production npm launcher has additional per-slot overhead. Peaks are approximate, sampled at a target 25 ms, and include process high-water readings; RSS sums can count shared executable pages more than once.

| Synthetic workload | Baseline | Optimized | Measurement |
| --- | ---: | ---: | --- |
| Resume 32 saved turns, about 256 KiB output per turn | 8,405,402 B | 2,693 B | Native resume result, without the small RPC envelope |
| Execute continuation of that 32-turn thread | 168.2 MiB | 63.0 MiB | Peak management worker RSS |
| Hold 2,000 queued conversations using stub turns | 261.7 MiB / 2,000 clients | 61.4 MiB / 2 clients | Peak management worker RSS and created clients |
| Execute six conversations using real native Codex | 566.9 MiB / 6 active | 226.4 MiB / 2 active | Maximum simultaneous worker/native RSS sum |

Current 4→32 saved turns kept worker RSS near 63 MiB, while native Codex RSS still grew from about 93 to 177 MiB. Current 2→2,000 queued stub conversations increased worker RSS from about 55 to 61 MiB and post-GC heap from 8.8 to 9.1 MiB. Neither result establishes constant complete-container RAM for arbitrary context, queued input size, large images or traffic. Codex's normal compaction policy is unchanged. Separate three-run prepared-statement experiments isolated roughly 40 MiB of native allocation high-water at 2,000 queued conversations; the production bounded statement cache reproduced the improvement without the experimental wrapper.

- Full backend verification passed 383 checks, including TypeScript/production build; release validation passed 90 modules and 3 JSON resources. Regression coverage includes bounded scheduling, fairness, resize, legacy settings, restart/wake/idle behavior, no-replay malformed/unavailable history, unknown-operation retention/overflow, real cursor paging and retained context, large final text, split credentials, image admission and binding/cache bounds.
- All four unmodified Docker targets built. The non-root, read-only, network-disabled container suite passed 376 checks, excluding host deployment checks. Tests use writable OS temporary directories, not the read-only application root.
- 78 focused production-bundle browser checks passed across Admin/layout/settings, summary-only sidebars, native streaming/deletion, queues, questions and image caching. The final new concurrency check was rerun after fixing its login-wait fixture race; 77 other checks passed in the broader run. This was not the complete browser suite.
- A real isolated three-container deployment admitted six synthetic management conversations as two running/four queued. All six completed, the ready queue emptied and every Codex child exited. Idle working-set samples were about 62/34/72 MiB for Gateway/Runner/Manager; held short turns put Manager near 174 MiB. These samples use an internal-only network and temporary data, and are reference measurements rather than predictions for an existing server.
- Independent review found malformed-history replay risk, backpressured-response retention during deletion and silently omitted uncertain action context. Each issue received a failing regression and a verified fix. No remaining Critical or Important findings were identified. A suspected SSE initial-snapshot closure leak was rejected after a WeakRef/GC probe demonstrated collection while the stream remained open.

Raw scratch measurements additionally distinguish cgroup file/anonymous pages from process RSS/PSS and JS heap. The versioned benchmark emits source hashes, seed SHA-256 manifests, protocol result bytes and child-process cleanup checks. It does not read real login files or enable production cleanup/retention.

### Integration with model/source access and history retention

After merging the model-settings/read-only-source and automatic-retention changes, the combined branch passed 446 backend checks, 439 checks in the non-root/read-only/network-disabled test container, and 21 focused browser checks covering plugin model settings, retention, management concurrency, summary-only sidebars, streaming/deletion and the shell. All four Docker targets built, including Manager's packaged-source validation; release validation passed 96 modules and 3 JSON resources. The plugin-specific dictionary now loads with the plugin page, preserving the existing cold-login transfer budget. The combined cleanup path retains transactional expiry/busy checks and durable file retries while removing scheduling/queue-version rows. Independent integration review found no blocking issue.


## Admin configuration and optional host upgrades (released as v1.0.1)

`npm test` passed 463 checks, including running-version/auth/origin/IPC metadata tests, 19 existing updater scenarios and 17 host-service scenarios through host-only wrappers. Release validation and Manager packaged-source validation passed 100 modules / 3 JSON resources. Host tests use real temporary Unix HTTP sockets and a detached synthetic worker; systemd unit syntax is checked against a synthetic Docker prerequisite. They do not install a system service or read real account state.

Focused Playwright validation passed 50 cases covering plugin model tabs/draft isolation, icon accessibility, connection/entry-key flows, integration docs, HTTP targets, chat run status, mobile shell and version upgrade lifecycle. A final 8-case run verified upgrade completion/reload, terminal-state version refresh, reconnect/cleanup and cold-login behavior. The unchanged cold-login budget remains 260,000 compressed bytes; measured 259,920 before the final reload label (final browser budget check also passed). Chinese/English 320px version dialogs and phone plugin icons were visually inspected using synthetic data. Backend fixtures now include the package metadata needed to identify the actual running Manager version.

Final review found no new blocking boundary issue. An inherited backup-failure message was corrected to report attempted restart rather than claiming recovery succeeded when restart itself fails; the regression was observed failing before the fix. Full packaged Docker/real Compose validation remains part of CI. The optional systemd service has not been installed on a production host in this session; deployment-specific Docker/systemd permissions and network access remain operator checks. Published v1.0.0 assets/tags are unchanged.

The GitHub runner uses UID1001. The Unix HTTP transport fixture explicitly bypasses peer authorization in its test-only server, while separate SO_PEERCRED assertions verify production accepts only root/UID1000 and rejects UID1001/65534. This preserves the production boundary and makes transport validation independent of the developer or CI account.

The connection-loading regression introduced by the third tab is covered by the original loading-center matrix and a new interaction test: tabs and the indicator share a bounded grid area, including narrow English layouts, and Model settings remains usable while the entry request is pending. Nine focused layout/model/cold-login checks passed after the fix without weakening assertions.
