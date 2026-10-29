# Plugin configuration tabs implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution.

**Goal:** Put plugin models in the connection modal and compact row actions to icons.
**Architecture:** Extract execution state into an independent hook/panel, host it as the third existing modal tab, keep connection and execution saves separate. Reuse Icon and accessible tooltip buttons.
**Tech stack:** React, TypeScript, Ant Design, Playwright, Node 24.
**Spec:** docs/superpowers/specs/2026-10-29-plugin-config-tabs-design.md

## Review focus
- Drafts/one-time secrets survive tab switches; closing clears modal state.
- Model save must not submit credentials or invalid connection drafts.
- Revision-conflict reload, loading/failure and unavailable values remain usable.
- Icons have labels/tooltips, fit desktop/phone and preserve existing flows.
- Model loading remains independent from connection loading and no nested forms exist.

### Task 1: Modal integration
- [x] Change model browser tests to enter Configure connection → Model settings; observe missing tab failure.
- [x] Extract embedded state/panel and connect active-tab footer, independent saves/errors and draft retention.
- [x] Test persistence, conflicts, mixed drafts and failures.

### Task 2: Compact row actions and documentation
- [x] Write icon/accessible-name and desktop/phone/English assertions; observe text-action failure.
- [x] Replace actions with icons, adjust column, update source validation and bilingual navigation docs.
- [x] Run npm test/check:release and focused browser flows; review and push a new PR.
