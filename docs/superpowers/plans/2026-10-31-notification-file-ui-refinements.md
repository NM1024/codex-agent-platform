# Notification and file UI refinements implementation plan

> **For agentic workers:** Use superpowers:executing-plans. Implement within the existing feature branch and preserve its unrelated work.

**Goal:** Apply the operator's five concrete UI corrections and complete notification configuration ownership.
**Architecture:** Reuse Gateway-owned channel records and revision-checked bindings. Each binding selects concrete channel UUIDs; provider type is only the protocol adapter. Keep sandbox attachment ownership and authenticated downloads unchanged.
**Tech Stack:** Node.js 24, SQLite, React, Ant Design, React Markdown/GFM, Playwright.
**Spec:** User corrections on 2026-10-31: compact saved-channel list; Agent maintenance; ended execution outcomes only; concrete task/plugin/schedule channel bindings including duplicate providers; typed drawer previews; Agent-owned permission cards.

## Global constraints
- Synthetic data and loopback sinks only; no real task or provider sends.
- Secrets remain write-only. Scheduled inspection conversations cannot change global channel targets.
- No host shell or native filesystem privileges are added to runtime Agents.

## Review focus
- Two channels of the same provider must remain independently selectable by UUID.
- Explicit empty bindings in schedules, tasks and retries must never inherit plugin defaults.
- Existing task bindings must stay unchanged after plugin defaults change.
- Preview Markdown cannot execute raw HTML or fetch external images.
- Permission cards must belong to the Agent even if a reply record is missing.

### Task 1: Channel ownership and completed task display
- [x] Reproduce card-list and ended-task binding UI in focused browser tests.
- [x] Add Agent channel save/delete tests for revision checks, credential redaction, no sends and inspection denial; observe RED then GREEN.
- [x] Implement compact Table and type-first editor; move message-format details to editor.
- [x] Read-only execution panels render history only.
- [x] Verify focused browser tests (16/16), full Node checks (635 pass, 8 optional skips), type/release checks; prepare commit.

### Task 2: Concrete plugin default bindings
- [x] Write tests for two Feishu instances, new task defaults, explicit empty/override, unchanged old tasks, retry and schedule empty selection; observe RED.
- [x] Add plugin_notifications_get/update, plugin binding owner, authenticated Admin route and plugin modal tab.
- [x] Copy defaults only when a direct new request omits notification_channels; preserve explicit schedule/retry selections.
- [x] Verify API and browser integration, update prompts/docs.

### Task 3: Typed attachment preview and Agent permission placement
- [x] Write Markdown drawer tests for legacy text/plain and text/markdown; observe RED.
- [x] Implement right Drawer, safe GFM rendering, source toggle and download.
- [x] Add Agent bubble ownership regression tests for running and completed source requests.
- [x] Implement assistant fallback for orphan sandbox activity, broaden safe code/text extensions and verify.
- [x] Capture 12 desktop/mobile examples and run full checks.

### Task 4: Conversation model controls
- [x] User refinement: retain model, reasoning and speed only in the chat picker; advanced parameters remain in global and plugin settings.
- [x] Reproduce unwanted chat advanced controls with a browser regression before removing the shared field component.
- [x] Verify existing hidden overrides survive model switches, subsequent sends and language changes.

### Completion
- [x] Independent whole-change code review and address material findings: task-investigation source classification and generated integration documentation.
- [x] Prepare verified changes and fresh screenshot artifacts for existing PR #16. No merge or deployment.

## Verification record

- Full Node suite: 643 total, 635 passed, eight optional environment skips; no failures.
- Focused notification panels: 16/16 passed.
- Real Admin notification/sandbox browser integration: 22/22 passed.
- Model options including simplified chat: 6/6 passed.
- Full browser run: 253 passed; one existing test still asserted the previous three-tab plugin modal. Updated it to include Notification channels and explicitly exercised navigation through that tab; all 7 plugin configuration tests then passed. All 254 browser cases have successful final coverage without a production-code change after the full run.
- Independent review identified two P2 issues: task-investigation chats were initially misclassified as inspection-origin, and generated integration docs initially retained old omission semantics. Both received RED-to-GREEN regression coverage and are fixed.
- Type checks, Admin build, release-source validation and whitespace checks passed. Screenshots use synthetic data; no production deployment or real provider notification.
