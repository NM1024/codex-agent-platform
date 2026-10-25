# Chat Model Picker Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Track completed steps below.

**Goal:** Implement selected A with one compact model entry and an accessible reasoning slider.
**Architecture:** A dedicated chat picker consumes the existing catalog/settings and automatic-save callbacks. The global settings picker stays separate. A pure settings projection centralizes default inheritance and supported effort labels; presentation adapts between popover and bottom drawer.
**Tech Stack:** Node.js 24, React, TypeScript, Ant Design, Playwright.
**Spec:** `docs/superpowers/specs/2026-10-25-chat-model-picker-design.md`

## Global Constraints

- Preserve prior uncommitted queue/caret/code-copy work on pr-7.
- No new dependencies, real-account requests, credential reads or runtime contract changes.
- Run npm test and npm run check:release, plus relevant browser suites.

## Review Focus

- Inheritance, explicit null and unsupported saved efforts must never be silently conflated.
- Slider gestures must not generate intermediate duplicate writes or save stale model settings.
- Delayed saves/failures/navigation must retain the latest choice and unrelated drafts.
- Popover/drawer must remain usable and readable on narrow/short visual viewports in both locales.
- Search, keyboard controls and Escape/outside dismissal must work without trapping or losing focus.

### Task 1: Picker behavior and implementation

**Files:** `frontend/src/ChatAgentPicker.tsx`, `frontend/src/pages/ChatPage.tsx`, `frontend/src/console.css`, `frontend/src/Icon.tsx`, `frontend/src/i18n.ts`, `tests/browser/chat-agent-picker.spec.mjs`.
**Interfaces:** ChatAgentPicker receives value/defaults/onChange/disabled/saving/saveError/onRetry and uses existing catalog and serializeConversation behavior.

- [x] Write and run failing behavior tests for selection, inheritance/default, slider gesture commits, unsupported catalog values, search, retries and responsive keyboard usability.
- [x] Implement compact trigger, model list, stepped slider, visible save state and adaptive panel.
- [x] Build and run targeted tests to green.

### Task 2: Integration and actual visual inspection

**Files:** Existing chat/mobile/console/reasoning browser cases and documentation.

- [x] Adapt tests to the actual new controls while retaining their persistence/race/draft assertions.
- [x] Run the production UI, capture and inspect desktop/phone screenshots, and exercise drag/click/keyboard/error flows in both locales.
- [x] Correct findings and document final behavior.

### Task 3: Final checks and independent review

- [x] Run npm test, release validation, git diff --check and related browser suites.
- [x] Request a fresh review, reproduce/fix material findings and verify them.
- [x] Leave work local without commit/push/deployment unless requested.
