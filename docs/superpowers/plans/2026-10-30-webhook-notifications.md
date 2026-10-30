# Webhook Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; independent provider/store/UI modules may use superpowers:dispatching-parallel-agents with the root-owned interface contract.

**Goal:** Implement six independently configured channels, live task/plan bindings and Agent-chosen notifications during business execution and scheduled inspections.

**Architecture:** A notification provider owns protocols/signing, a durable service owns private channels and per-owner bindings/attempts, and existing MCP/API layers derive task or inspection identity. Human Admin owns secrets and test sends; Agents discover safe metadata and send only through explicit bindings.

**Tech Stack:** Node.js 24, SQLite, fetch/crypto, React/TypeScript/Ant Design, fixed Codex 0.159.2, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-webhook-notifications-design.md` (user explicitly authorized continuing this agreed design).

## Global Constraints

- Feishu/Lark, WeCom, DingTalk, Slack, Discord, custom JSON Webhook.
- Business tasks and both task/inspection schedule kinds; 0–N bindings, editable, no fixed completion-only condition.
- Explicit plugin tools for business notification; original admitted inspection message only for Manager sends.
- No secrets in Agent context/logs; no automatic replay of uncertain side effects; no real account or production sends in tests.
- Distinct task lifecycle, callbacks, notification outcomes and business rules.

## Review Focus

- Running-task changes take effect on next send without undoing already-issued requests.
- A partial batch never hides a failed/unknown channel or replays a successful one.
- Manager inspection dispatch cannot race mapping acknowledgement or borrow another message's identity.
- Deleted/disabled channels preserve history and do not block ordinary business work or disabling plans.
- Old installations, explicit retries, retention and in-flight effects must remain compatible.

### Task 1: Protocol adapters

**Files:** new src/notifications/providers.mjs and tests/notification-providers.test.mjs.
- [x] Write failing tests for six payloads, Feishu/Ding known signing vectors, host/path validation, business success/rejection and raw body preservation.
- [x] Implement fixed helpers in root integration contract; run focused tests with synthetic endpoints/requests only.

### Task 2: Durable channel/binding/send service

**Files:** new src/notifications/store.mjs and tests/notification-store.test.mjs.
- [x] Test metadata privacy, optimistic updates, live binding checks, batch idempotency/concurrency, per-channel outcomes and restart unknown behavior.
- [x] Implement NotificationStore using composable savepoints, bounded network I/O and safe private configuration.
- [x] Verify synthetic fetch fixtures and local callback sinks; test history/cleanup during sends.

### Task 3: Business/API/schedule composition

**Files:** platform catalog, application/core/registry/store, api, operations/service/schedules and management contracts; focused API and schedule tests.
- [x] Write failing admission/scope/binding and scheduled inheritance tests.
- [x] Add explicit tools, optional create/retry binding fields, live revision-checked editing and safe metadata/history.
- [x] Add browser-only channel administration routes and internal transport; preserve current task/callback behavior.
- [x] Copy bindings on each task or inspection schedule trigger, allowing later unavailable historical refs to remain visible.

### Task 4: Manager inspections and autonomous configuration

**Files:** Manager agent/store/mcp/intake/main wiring/new bridge; root manager operations and Gateway internal lifecycle.
- [x] Test original-message scope, mapping acknowledgement before dispatch, restart dedup, lifecycle and denied foreign/followup context.
- [x] Integrate trusted execution context and original-message bindings with shared notification service.
- [x] Queue cross-service cleanup durably and test interrupted cleanup recovery.
- [x] Integrate current-conversation model options tool and safe global/plugin configuration guidance from the model-options plan.

### Task 5: Channel and binding Admin UI

**Files:** new notification panels/types/css/i18n, root settings/task/schedule embedding; focused browser tests.
- [x] Test create/edit flags, explicit test action, enabled/disabled binding choices, conflicts and per-channel history.
- [x] Implement independently configured channels and revision-checked bindings without a separate task creation workflow.
- [x] Verify mobile layout, loading/error behavior and retained drafts with the model advanced editor.

### Task 6: Documentation, verification, review and new PR

- [x] Update bilingual docs, generated integration docs and Manager operating rules.
- [x] Run complete npm test, check:release and relevant browser tests serially with builds.
- [x] Review the whole change independently, resolve material findings with regression tests.
- [x] Commit all agreed changes, push the new feature branch and create a new PR targeting origin/main; do not merge or deploy.

## Implementation verification

The complete Node test suite passes (566 tests), including pinned Codex 0.159.2 against an auth-free loopback Responses fixture. The advanced editor and notification Admin integration browser cases pass, and the isolated notification component suite passes (14 cases). Release source checks pass with all deployed Manager sources. Independent review findings on inspection admission/completion crash windows, credential rotation, current-conversation updates, optimistic settings writes and inspection self-binding are fixed with regression coverage. No real account or external recipient was used.
