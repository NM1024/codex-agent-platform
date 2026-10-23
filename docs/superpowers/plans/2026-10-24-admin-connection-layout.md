# Admin connection layout implementation plan

> **For agentic workers:** Use superpowers:executing-plans for implementation and a fresh final review.

**Goal:** Apply the approved Pages connection layout and responsive table sizing to PR #6 without merging.

**Architecture:** Keep connection requests, secret handling and revision guards intact. Restructure the existing React modal into retained entry/callback tabs with concise help and one entry-secret field; use the existing integration drawer for examples. Give list tables flexible text columns and content-sized status/action columns, with compact rows on small screens.

**Tech stack:** React, TypeScript, Ant Design; Node.js 24; Playwright synthetic fixture.

**Spec:** https://chatgpt.com/space/page_7c25080799288191b02cbe98565a9689, approved by the user's implementation request.

## Constraints and review focus

- Stay on the existing PR branch; do not merge or use real account work.
- Preserve unsaved drafts across tabs, single-use claim semantics, stale response guards and per-plugin isolation.
- Hidden fields must not prevent save or hide validation failures; show the relevant tab on invalid input.
- Callback disabling must clearly explain deletion on save, while switching tabs never deletes values.
- Check Chinese/English, long names/identifiers and errors, 390px phone, tablet and desktop widths.
- Normal desktop configuration should not need scrolling; small heights and expanded help may scroll within a bounded body with accessible footer.

## Tasks

- [x] Add browser regression coverage for tab drafts, single claimed-key field, desktop modal height and long table content; run against the old UI to confirm failure.
- [x] Update PluginConnectionModal, localized copy and PluginsPage document wiring. Preserve existing backend contracts; adapt existing browser assertions to the new organization.
- [x] Adjust Plugins, Schedules, Tasks and Overview tables and shared CSS; retain contained horizontal scrolling for protocol/schema Markdown tables.
- [x] Run targeted/full browser checks, npm test and npm run check:release; inspect synthetic screenshots and release artifacts.
- [x] Review the diff, address material findings, commit and push to the current PR; update its description and leave it open.

Verification and review receipts are recorded in docs/VALIDATION.md. Current PR remains open and unmerged.
