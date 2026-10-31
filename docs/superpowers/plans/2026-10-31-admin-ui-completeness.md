# Admin UI completeness implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation. The user has already authorized checking all pages, correcting omissions, submitting and merging after verification.

**Goal:** Complete the compact layout and overlay interaction pattern across remaining old console surfaces.
**Architecture:** Reuse Ant Design and the existing shared overlay styles. Keep settings fields mounted while changing categories; use a mobile category selector and desktop tabs. Move long read-only configuration and schedule guidance into drawers. No backend or permission changes.
**Tech Stack:** Existing React/TypeScript, Ant Design, Node24 and Playwright synthetic fixtures.
**Spec:** User's accepted interface requirements from this conversation: simple lists, horizontal labels, compact short fields, and overlays for detail interaction; latest request requires checking omissions before submitting/merging.

## Global constraints
- Use synthetic data only. Preserve independent saves, credentials, runtime operations and notification histories.
- No dependencies, deployment or production account operations.
- Screenshots and test logs belong in ignored `.tmp/ui-completeness/`.

## Review focus
- Switching mobile categories must preserve unsaved fields and perform no writes.
- The mobile selector and desktop tabs share the same selected category across resizing and language changes.
- Long configuration drawers display untrusted strings as literal text and keep the underlying form draft.
- Schedule guidance is discoverable for empty lists and never changes a plan.
- Old confirmation dialogs retain explicit confirmation, errors and dismissal locks.

### Task1: Settings category navigation and configuration details
Files: `frontend/src/pages/SettingsPage.tsx`, `frontend/src/pages/settings.css`, `frontend/src/workflow-i18n.ts`; tests: `tests/browser/ui-completeness.spec.mjs`, shared `tests/browser/settings-navigation.mjs`.
- [x] Add and observe failing tests for mobile category switching/draft preservation and read-only configuration drawers.
- [x] Render a labeled category Select below992px using the existing category state; preserve mounted category panels and desktop tabs.
- [x] Replace inline complex-setting expansions with compact named view buttons and a shared drawer; closing the drawer retains form values.
- [x] Adapt existing browser interactions to a viewport-aware settings helper; verify desktop/mobile, English/Chinese and no configuration writes.

### Task2: Remaining layout and overlay omissions
Files: `frontend/src/RetentionPanel.tsx`, `frontend/src/pages/SchedulesPage.tsx`, `frontend/src/pages/OverviewPage.tsx`, `frontend/src/components.tsx`.
- [x] Observe a failing test for schedule guidance opening in an overlay with no mutation.
- [x] Replace the permanent schedule help panel with a named header action and drawer, retaining management Agent guidance.
- [x] Align retention controls to the compact horizontal/two-column form styles and stable save-button labels.
- [x] Apply existing shared styling to restart and logical-delete confirmations without changing their behavior.
- [x] Run affected retention, modal, overview, configuration and new interaction tests.

### Task3: Completeness review and integration
- [x] Capture and inspect fresh desktop/mobile states of every primary page and all settings categories; document checked surfaces and evidence limits.
- [x] Run Node, type/build/release checks, affected browser checks and independent review.
- [ ] Require current-head complete CI before merging.
- [ ] Submit a new PR and merge only after its checks pass; synchronize clean local main and deliver updated screenshots.

## Verification record

Fresh synthetic captures cover six primary pages, seven settings categories, desktop/mobile layouts, configuration inspection and confirmation dialogs. The first capture pass included unsettled states and clipped overflow tabs; those images were rejected and recaptured using verified active categories and settled overlays. Final screenshots are in ignored `.tmp/ui-completeness/after/`.

Local checks: Node639 passed with8 optional Docker/network skips; production TypeScript/build and release validation passed;22 focused browser cases and63 integration cases passed. Five new completeness cases pass, including the320px accessible-name and category-draft checks. Independent review found one Important320px English schedule-header collapse; a regression reproduced it RED, narrow header stacking fixed it GREEN, the5-case suite and whole Node suite passed again. No Critical findings or deferred concrete issues remain. Physical assistive technology and real customer environments are outside this synthetic regression run.

Full287-case browser/container CI and final merge verification remain required after PR submission.
