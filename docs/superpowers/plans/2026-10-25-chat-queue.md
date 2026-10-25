# Chat Queue Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Steps use checkbox syntax for tracking.

**Goal:** Unsent queue rows with withdrawal/editing, deletion and native immediate guidance.
**Architecture:** Durable queue transitions in ManagerStore; ManagementAgent owns native turn steering; authenticated routes and SSE expose authoritative queue projections; React displays editable queue rows separately from transcript bubbles.
**Tech Stack:** Node.js 24, SQLite, React, TypeScript, Ant Design, Playwright.
**Spec:** `docs/superpowers/specs/2026-10-25-chat-queue-design.md`

## Global Constraints

- Preserve the existing caret fix and work on the user-selected PR #7 checkout.
- No new dependencies, real-account work, credentials, business runtime changes or automatic resubmission of uncertain native inputs.
- Run npm test, relevant browser checks and npm run check:release.

## Review Focus

- Withdrawal/delete racing execution must reject without affecting active work.
- Accepted steering must never run again as a separate queued turn.
- Timeout/restart must not replay an input that Codex may have accepted.
- Queue state must converge after reconnect and delayed paged reads.
- Editing/navigation must retain text, attachments and unrelated composer drafts.

### Task 1: Durable queue controls and native steering

**Files:** `src/manager/store.mjs`, `src/manager/agent.mjs`, `src/manager/server.mjs`, `src/manager/events.mjs`, `tests/manager-queue.test.mjs`.
**Interfaces:** store.queue(id), store.withdrawQueued(conversationId,messageId), store.removeQueued(conversationId,messageId), store.requeue(conversationId,messageId,text); agent.steerQueued(conversationId,messageId); authenticated message action routes and snapshot/patch queue arrays.

- [x] Write and run failing state, protocol, HTTP/SSE and recovery tests.
- [x] Implement guarded transitions, queue timestamps, durable steering identity and reconciliation.
- [x] Run targeted tests and inspect results.

### Task 2: Composer queue UI

**Files:** `frontend/src/ChatQueue.tsx`, `frontend/src/pages/ChatPage.tsx`, `frontend/src/context.tsx`, `frontend/src/types.ts`, `frontend/src/ChatActivity.tsx`, `frontend/src/console.css`, `frontend/src/i18n.ts`, `tests/browser/chat-queue.spec.mjs`.
**Interfaces:** Conversation.queue: Message[]; session-owned queue edit drafts keyed by conversation/message; queue actions consume Task 1 routes. Pending messages are excluded from the transcript until sent.

- [x] Write/run failing queue visibility, edit/delete/steer, reconnect and responsive tests.
- [x] Implement compact labelled rows, inline withdrawn editor and guarded asynchronous actions.
- [x] Build and run relevant browser tests; inspect desktop/mobile screenshots.

### Task 3: Verification and review

- [x] Update README and architecture to document actual queue behavior and uncertain delivery.
- [x] Run npm test, npm run check:release, git diff --check and related browser suites. Final results: 305 application checks and 114 chat/console/mobile browser checks passed. Release validation passed (88 modules, 3 JSON resources).
- [x] Request an independent review and resolve material findings with regressions.
- [x] Leave changes local for review; do not publish or push without instruction.
