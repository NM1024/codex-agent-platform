# Chat Run Status Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Steps use checkbox syntax.

**Goal:** Make actual work, waiting and terminal outcomes immediately distinguishable, and show only timestamps above user bubbles.
**Architecture:** Shared presentation helpers derive phase and timing from existing Message data. A composer status component chooses the active request or latest outcome, while MessageProgress reuses its indicator/phase. ChatPage owns connection/read failure state and integrates the strip without changing runtime behavior.
**Tech Stack:** Node.js 24, React, TypeScript, Ant Design, Playwright.
**Spec:** `docs/superpowers/specs/2026-10-25-chat-run-status-design.md`

## Global Constraints
- Work on PR #7 and preserve its existing queue/caret/model fixes. Publish tested changes to that same PR as requested in the ongoing task.
- No backend contract changes, dependencies, production credentials or real-account tasks.
- Run npm test, npm run check:release and relevant browser suites; use only .tmp for captures/logs.

## Review Focus
- Completed tool/old reply activity must not claim a currently running phase or override terminal states.
- Connection heartbeats and successful reads must not reset task-progress age; failed reads must visibly qualify stale state.
- Queued/steered/draft messages and older loaded history must not replace the actual active/latest request.
- Timers/spinners must not alter layout or churn screen-reader announcements every second.
- Phone landscape/240px visual viewport must retain send controls, drafts and manual history scrollback.

### Task 1: Running status, integration and validation
**Files:** Create `frontend/src/ChatRunStatus.tsx`, `tests/browser/chat-run-status.spec.mjs`; modify `frontend/src/ChatActivity.tsx`, `frontend/src/pages/ChatPage.tsx`, `frontend/src/console.css`, `frontend/src/i18n.ts`, README and architecture.
**Interfaces:** Components consume Message/activity/questions, running/queued counts, stream status and a guarded read-failure flag. No new server data.
- [x] Write browser tests for actual phase/timing transitions, waiting/terminal precedence, stale reads/recovery, queue/history selection and timestamp-only user headers. Run and observe missing-strip failure.
- [x] Implement shared status presentation and fixed composer strip; integrate guarded read health, timestamp-only user metadata and responsive/reduced-motion styles.
- [x] Run new and existing chat/mobile/browser checks, npm test and release validation; inspect actual desktop/phone running/waiting/completed screenshots and correct findings.
- [x] Obtain a fresh independent review; reproduce and fix material findings, then complete final verification.
- [x] Commit, push PR #7, verify its remote head and provide actual screenshots.

Validation: 305 application tests passed; the full browser pass covered 199 scenarios (196 passed, three legacy assertions affected by the requested user-header/status presentation were updated and all three passed in a focused rerun). All nine new status cases passed, including independent-review and tiny-viewport regressions. Release validation and diff checks passed. Actual desktop/phone/keyboard and waiting/completed screenshots inspected.
