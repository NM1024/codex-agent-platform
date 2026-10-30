# Model Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose four model parameters with reasonable defaults and safe autonomous management.

**Architecture:** Share schema/default/native mapping; extend the existing configuration, snapshot and runtime pipeline. Reuse model selectors with a collapsed advanced editor, and add a current-conversation management operation bound to trusted MCP context.

**Tech Stack:** Node.js 24, SQLite, fixed Codex 0.159.2, React/TypeScript/Ant Design, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-model-options-design.md`

## Global Constraints

- Preserve Standard speed defaults and the removed composer status strip.
- Fields: verbosity, reasoningSummary, autoCompactTokenLimit, toolOutputTokenLimit. Native automatic budgets are omitted, not JSON null.
- Manager summary defaults concise; execution summary auto; verbosity medium; both budgets null/automatic.
- No real accounts, remote model work, new dependencies, arbitrary config passthrough, releases or deployments.

## Review Focus

- Explicit automatic budget must override a manual global value and clear on resumed processes.
- Model changes preserve independent parameters; opening an editor never saves inherited overrides.
- All four settings survive both Manager messages and business execution metadata.
- Current-conversation configuration cannot target another conversation or overwrite stale revisions.
- Agent updates apply to the next turn; existing active and interrupted execution snapshots remain stable.

### Task 1: Shared model options and both execution paths

**Files:** create src/configuration/model-options.mjs; extend agent-settings, execution, manager configuration, core store, runtime server, Codex config and both Agent runtime callers; tests/model-options.test.mjs and pinned Codex fixture.

**Interfaces:** modelOptionProperties, modelOptionDefaults(summary='auto'), codexModelOptions(settings) provide shared schema, defaults and fixed native config projection.

- [x] Add failing tests for schemas, defaults, inheritance/automatic, snapshot persistence and runtime mapping.
- [x] Run tests and observe feature failures.
- [x] Implement four fields end to end and role defaults; preserve old saved settings; pass explicit summary per turn.
- [x] Verify configuration and both real platform launch parameter paths; prove pinned local requests change verbosity/summary across new-process resumes.
- [x] Commit backend support.

### Task 2: Autonomous management and scoped conversation updates

**Files:** contracts/management, manager/mcp, manager/operations, prompts/manager-project; tests/manager-model-options.test.mjs.

**Interfaces:** conversation_execution({execution?,revision?}) gets trusted conversationId via MCP, returning execution/effective/revision and next-turn applicability.

- [x] Write failing real MCP tests for self-read/update, stale revision, foreign ID rejection, unavailable context and independent global/plugin changes.
- [x] Add scoped operation, context forwarding and optional revision checks; update schema/tool guidance and verify before/after readbacks.
- [x] Verify current message snapshot remains unchanged while next message consumes the new values.
- [x] Commit management support.

### Task 3: Existing configuration editors

**Files:** frontend types, new ModelOptionsFields/modelOptions helpers, generic/chat selectors and default/save projections; relevant CSS/i18n; tests/browser/model-options.spec.mjs.

- [x] Add failing browser tests for all four entry points, automatic/inherit/manual distinction, model change preservation, collapse and mobile layout.
- [x] Implement shared advanced fields and folded sections, persisting complete overrides while keeping current model/effort/fast controls.
- [x] Build and run focused new/existing browser regressions serially with builds.
- [x] Commit editor support.

### Task 4: Documentation, complete verification and review

- [x] Update bilingual usage and architecture, exact field names, defaults, model limitations, budgets and effective timing.
- [x] Run npm test, npm run check:release, targeted browser suites and inspect all output.
- [x] Get one fresh read-only final code review; fix material findings with regression tests.
- [x] Commit final documentation/fixes and report actual evidence and limits.

## Implementation verification

The complete Node test suite passes (566 tests), including pinned Codex 0.159.2 against an auth-free loopback Responses fixture. The advanced editor and notification Admin integration browser cases pass, and the isolated notification component suite passes (14 cases). Release source checks pass with all deployed Manager sources. Independent review findings on inspection admission/completion crash windows, credential rotation, current-conversation updates, optimistic settings writes and inspection self-binding are fixed with regression coverage. No real account or external recipient was used.
