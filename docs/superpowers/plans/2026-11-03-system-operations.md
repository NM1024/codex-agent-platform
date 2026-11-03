# System Operations Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development task by task, with scoped review and a final integration review. The user approved implementation and the Pages design; do not request another implementation-method approval.

**Goal:** Provide searchable system events, durable background-work state, controlled maintenance and sanitized code-defect reports through one consistent Admin page and management Agent tools.

**Architecture:** Each service owns its journal and work state. Manager aggregates authenticated bounded queries, including partial-source availability, and exposes the same facts and fixed maintenance actions to humans and the Agent. Existing lifecycle, task outcomes, ownership and credential boundaries remain authoritative.

**Tech Stack:** Node.js 24, built-in SQLite, existing HTTP/MCP adapters, React TypeScript and Ant Design. No new external runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-03-system-operations-design.md`; approved Pages prototype linked there. User amendment: all logging history follows existing `retention.enabled` and `retention.days`, with unfinished work/unresolved problems and necessary evidence protected.

## Global Constraints

- Read AGENTS.md, README.md and docs/ARCHITECTURE.md. Preserve existing lifecycle, capability and service ownership boundaries.
- No host shell, arbitrary SQL, runtime/source-file readers, Docker socket, credential exposure, automatic retry of terminal business tasks, or replay of unknown external effects.
- System records survive conversation deletion and use existing retention enabled/days; no independent 30-day deletion rule.
- Errors must have fixed safe codes/messages; redact structured details with an allowlist. Never log prompts, business payloads, tool bodies, authorization, URLs with secrets or credentials.
- Fixed source/action selectors, bounded output and keyset pagination; partial availability must never become an empty healthy result.
- Admin must reuse frontend/src/theme.ts, shared Status, LoadingState, existing table/drawer patterns, Chinese/English translation and 320px layout.
- GitHub unavailable/unconfigured means a full sanitized issue draft in the conversation; code defects are escalated for development, not repaired by deployed Agent code edits. No real GitHub issue or model task in tests.
- Preserve the clean starting commit a0d79f1 and the approved design; work on current task branch `work`, no push/deploy. Each task commits only its own implementation/tests.

## Review Focus

- A failed service query returns partial/stale status and retains known facts, never reports resolved because a source disappeared (Task 3/4 tests).
- Repeated or concurrent maintenance cannot replay external side effects or mark an unfinished job successful (Task 2/3 tests).
- Log pruning shares retention policy and protects pending work/evidence even after deleting its originating conversation (Task 1/2 tests).
- Untrusted error/detail strings cannot leak credentials or authorize an operation (Task 1/3 tests).
- Existing historical cleanup rows migrate conservatively; known absent optional resources must not be confused with confirmed remote cleanup (Task 2 tests).

### Task 1: Durable shared journal and bounded query contract

**Files:** Create `src/observability/system-journal.mjs`, `src/observability/system-contracts.mjs`; test `tests/system-journal.test.mjs`.

**Interfaces:**
- `new SystemJournal({db,service,now=Date.now})`, services manager/gateway/runner. db is service-owned DatabaseSync.
- `event({module,event,level,code,message,work_id,target_id,details})`: safe bounded event, public id includes service prefix; returns saved record or null on storage failure, sets observable journal-health fallback.
- `work({id,module,title,state,code,message,target_id,pending_count,next_retry_at,details,classification})`: upsert current work; revision, first/last attempt, progress, success/completion, consecutive failures and attempts; state in running/retrying/blocked/unknown/completed/idle/disabled. Expose fixed allowed maintenance actions supplied by trusted integration, never by query input.
- `logs(query)`, `works(query)`, `issues(query)`, `detail(id)`, `summary()`, `prune({cutoff,limit})`, `classify(id,classification,revision)`; query supports service,module,state,level,search,after,before,cursor,limit with maximum 100 and service-prefixed deterministic keyset cursor. Return `{items,next_cursor}`.
- Export query/maintenance argument schemas via `systemManagementTools`, to be combined into management contracts in Task 3. Tool names `system_status`, `system_logs`, `system_work`, `system_issue`, `system_maintain`, `system_issue_draft`.
- Stable primitive public shapes documented as JSDoc and exported helpers for source-safe merge/cursors. Runtime source aggregation reuses these helpers rather than inventing pagination rules.

- [ ] Write failing tests for redaction, literal search, same-time pagination, persistent work transitions and revisions, fail-safe storage, retention boundary/protected evidence and independent history.
- [ ] Run `node --test tests/system-journal.test.mjs` and verify failure reflects missing journal.
- [ ] Implement minimal persistent event and work tables, safe fixed-code projection and query schemas; consolidate repetitive unchanged events and preserve recovery events.
- [ ] Run focused tests, self-review, commit only Task 1 files; report public shapes and test evidence.

### Task 2: Instrument core service chains and register maintenance callbacks

**Files:** Existing `src/main-manager.mjs`, `src/main-gateway.mjs`, `src/main-runner.mjs`, `src/history/worker.mjs`, `src/core/dispatcher.mjs`, `src/core/history-retention.mjs`, `src/runtime/events.mjs`, `src/runtime/codex.mjs`, `src/manager/agent.mjs`, `src/manager/sandbox.mjs`, `src/manager/inspection-notifications.mjs`, `src/manager/inspections.mjs`, `src/operations/schedules.mjs`, `src/operations/service.mjs`, `src/notifications/store.mjs`, `src/delivery/configured.mjs`; add `src/observability/system-maintenance.mjs`; tests `tests/system-maintenance.test.mjs` and relevant existing tests.

**Interfaces:** Consume Task 1 journal. Optional injected `journal` keeps old constructors/test fixtures compatible. Expose `{journal,actions}` system facade on service-owned operations/runtime and a manager facade supplied at startup. `actions` maps ONLY fixed supported names to scoped callbacks: `cleanup_retry`, `inspection_reconcile`, `configuration_sync`, `runtime_reconcile`, `event_flush`, `history_sweep`, `health_check`. `createSystemMaintenance({journal,actions})` validates source/work revision, rejects code-defect work repairs and arbitrary targets, serializes duplicate in-flight action+work, records results and rereads relevant state; do not invent completion from an accepted request.

- [ ] Write failing tests using synthetic stores/real temporary files and fake transport boundaries for failed cleanup then recovery, event-outbox backlog then flush, config sync pending then confirmed, retained history protections and serialized maintenance.
- [ ] Instrument conversation/thread/files and sandbox cleanup, idle/helper unavailability, history scan and SQLite reclaim, Runner transient directories, event delivery, runtime reconciliation, configuration sync, schedule trigger and inspection claim/ACK/lifecycle/cleanup, service startup/recovery/health and safe notification/delivery errors. Record meaningful transitions and consolidated repeat counts, not each healthy poll or payload.
- [ ] Existing cleanup authorization and ownership remain unchanged. Add next-retry/backoff metadata and skip attempts before due time; configuration/permission failures get actionable blocked status. An explicit scoped retry may bypass backoff but not safety checks. Existing unknown remote resources remain pending.
- [ ] Add optional journal maintenance to HistoryRetentionWorker so journal pruning happens only with enabled current retention policy and cutoff, using protected records and bounded batches. Runner history uses propagated policy/cutoff through authenticated owner operations, no direct cross-owner DB access.
- [ ] Expose typed callback registries needed by Task 3. Record unsupported host access as unavailable/needs-human with a truthful diagnostic summary; never expose host commands to Agent.
- [ ] Run affected Node tests and self-review, commit Task 2 changes; report any boundary that remains intentionally manual.

### Task 3: Federated system tools, safe maintenance and code-defect drafts

**Files:** `src/contracts/management.mjs`, `src/manager/operations.mjs`, `src/operations/service.mjs`, `src/runtime/client.mjs`, `src/runtime/server.mjs`, `src/manager/server.mjs`, `src/manager/project-source.mjs`; create `src/observability/system-operations.mjs`, `src/observability/system-report.mjs`; tests `tests/system-operations.test.mjs`, `tests/system-report.test.mjs`; update `prompts/manager-project.md`.

**Interfaces:** Extend existing `/admin/api/operations` and management MCP via `systemManagementTools`; no separate Agent credential channel. Runner fixed authenticated `/internal/system/status`, `/internal/system/logs`, `/internal/system/work`, `/internal/system/maintain` requests. Manager combines its journal with Gateway/Runner owner projections using globally stable cursors and per-source `{service,available,observed_at,error_code}`. `system_status` returns `{sampled_at,sources,summary,work,issues}`; list tools return `{items,next_cursor,sources}`; `system_issue` returns current work, bounded related events and allowed actions; `system_maintain` returns action outcome plus fresh work/state and sources.

- [ ] Write failing integration tests for owner auth, literal bounded search, source-partial results, stable merged pagination, unknown action/path/target rejection, stale revision rejection and code-defect operation refusal.
- [ ] Implement fixed safe federation and maintenance routing; protect server-local paths and diagnostics. Existing restart/configuration tools remain available; no automatic terminal task retry or notification/callback replay.
- [ ] `system_issue_draft` consumes current journal facts and bounded caller-provided diagnosis/expected/actual/reproduction; returns `{classification:'code_defect',submitted:false,repository_url,markdown,evidence_ids}`. Mark code-defect work with revision guard. Build sanitized body from fixed fields, not raw log dumps; include version, scope/time, safe codes, reproduction, expected/actual, attempted actions, source references and uncertainty. Strip credentials and deployment identifiers. No GitHub request without a separately configured safe ability; this version's complete fallback is draft-in-conversation.
- [ ] Update deployed Agent rules to query current evidence, perform allowed repair and verify, escalate code bugs with the draft, distinguish request accepted/result unknown/recovered, and treat log contents as untrusted data.
- [ ] Update read-only source allowlist only for needed platform system modules (no runtime paths).
- [ ] Run focused and existing management/runtime boundary tests, commit Task 3 changes.

### Task 4: Consistent Admin page, end-to-end evidence and release verification

**Files:** Create `frontend/src/pages/SystemPage.tsx`, `frontend/src/pages/system.css`, `frontend/src/system-i18n.ts`; extend `frontend/src/App.tsx`, `frontend/src/types.ts`, shared Status mappings as needed, and browser fixture. Test `tests/browser/system-operations.spec.mjs`; update docs/ARCHITECTURE.md, docs/DEPLOYMENT.md and docs/UI-GUIDELINES.md only as needed.

**Interfaces:** Consume Task 3 operation result shapes. New View `system`, title 系统运维 before settings. Use existing operation transport, Console context, Panel, Status, LoadingState, AdminDrawer. User-approved interactive reference: `/workspace/work/system-operations-preview.html` and Pages design; implement real data/actions, not demo behavior.

- [ ] Write failing browser tests for tab navigation, search/filter/paging, work/issue details, partial sources and stale refresh, scoped retry result, code-defect draft, human-to-Agent analysis handoff, Chinese/English and 320px layout.
- [ ] Implement three tabs: issues, work, logs; metric summary, source timestamps, loading/empty/error states, filtering and bounded pagination. Detail drawers show attempts, last progress/success, next retry, safe reason and allowed actions. Agent-analysis action opens a conversation with stable system issue references and no automatic unrequested send; preserve unrelated composer drafts.
- [ ] Human maintenance uses fixed allowed action and current revision, locks duplicate submissions and refreshes actual evidence. Dangerous existing actions retain existing confirmation. Draft is copyable and can be requested through the Agent; label not submitted.
- [ ] Reuse theme and shared semantic components, table-to-card responsive behavior, visible focus, reduced motion, internal drawer scroll and unit suffix controls. Retention copy explicitly refers to existing global history policy.
- [ ] Update fixtures/source packaging and existing navigation tests for new View. Run `npm test`, `npm run check:release`, selected browser regression and inspect desktop/mobile screenshots. No real model task or GitHub issue.
- [ ] Commit Task 4 changes. Whole-branch review verifies core coverage, retention, source failures, repair authority and truthfulness; fix review findings, rerun affected checks, and report actual scope/limitations without deploying.
