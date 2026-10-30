# Model Service Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Standard/Fast mode to existing model settings, defaulting to Standard everywhere.

**Architecture:** Preserve current configuration inheritance and immutable execution snapshots. Model discovery reports speed capabilities; one validator resolves reasoning and speed; thread and turn requests explicitly set the resolved tier. Reuse existing selectors.

**Tech Stack:** Node.js 24, SQLite, Codex 0.159.2, React, TypeScript, Ant Design, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-model-service-tier-design.md`

## Global Constraints

- `serviceTier` accepts only `default` and `priority`; missing effective values use `default`.
- Overrides inherit global speed; explicit Standard overrides global Fast.
- No actual account credentials or remote model tasks; use synthetic data and local fixture servers.
- No new dependencies, model version change, production deployment or release.

## Review Focus

- Resumed threads must explicitly clear prior Fast mode when Standard is selected.
- Recovery of old execution snapshots without a tier must remain Standard.
- Unsupported or missing model capabilities must never silently claim Fast mode.
- Model changes must not discard an explicit mode while resetting reasoning overrides.
- Global settings, plugin overrides and conversation overrides must persist speed independently.

### Task 1: Configuration, capability discovery and execution routing

**Files:** `src/configuration/agent-settings.mjs`, `src/configuration/execution.mjs`, `src/manager/configuration.mjs`, `src/codex/models.mjs`, `src/manager/agent.mjs`, `src/runtime/codex.mjs`, `src/runtime/server.mjs`, `src/core/store.mjs`; tests in `tests/model-service-tier.test.mjs` plus pinned-runtime fixtures.

**Interfaces:** configuration property `serviceTier`; model metadata `serviceTiers`; `validateModelExecution(client,settings)` returns `{effort,serviceTier}`. Existing `validateModelEffort` remains compatible.

- [ ] Add tests asserting defaults, schema rejection, independent persistence, inheritance, plugin snapshots, Runner configuration transport, model capability checks and standard routing on old snapshots.
- [ ] Run tests and verify feature-related failures.
- [ ] Implement shared schema, explicit effective defaults, capability preservation and combined validation. Persist speed with execution metadata. Pass speed on thread start/resume and turn start in Manager and Runner.
- [ ] Run focused tests and local pinned-Codex transport test; verify Fast sends `priority` and Standard omits priority while reasoning stays unchanged, including resumes.
- [ ] Commit the verified backend behavior.

### Task 2: Existing model selectors

**Files:** `frontend/src/types.ts`, `frontend/src/components.tsx`, `frontend/src/ChatAgentPicker.tsx`, `frontend/src/pages/SettingsPage.tsx`, `frontend/src/pages/ChatPage.tsx`, `frontend/src/PluginExecutionSettings.tsx`, `frontend/src/i18n.ts`, `frontend/src/console.css`; `tests/browser/model-service-tier.spec.mjs`.

**Interfaces:** existing AgentSettings gains optional `serviceTier`; Model gains optional service-tier metadata. Existing onChange callbacks persist the complete selected settings.

- [ ] Add browser tests for Standard default, saving Fast then Standard, capability-disabled Fast, inheritance, preserving mode on model change, global/plugin persistence and mobile visibility.
- [ ] Build current frontend and run new tests to observe missing controls.
- [ ] Add speed controls and bilingual copy to existing selectors; keep model/reasoning reset behavior while preserving explicit speed. Carry global speed through all frontend default projections and save payloads.
- [ ] Run type checking and targeted existing/new Playwright tests; fix regressions against the spec.
- [ ] Commit the verified selector behavior.

### Task 3: Documentation and whole-change verification

**Files:** bilingual README, `docs/DEPLOYMENT.md`, `docs/PLUGINS.md`, `docs/ARCHITECTURE.md`, `prompts/manager-project.md`, management descriptions as necessary.

- [ ] Explain default Standard, optional Fast and increased usage, inheritance, account/model limits, start/resume behavior and `execution.serviceTier` values.
- [ ] Inspect installed protocol and current official docs for useful unexposed options; distinguish unsupported/deprecated parameters and existing functionality.
- [ ] Run `npm test`, `npm run check:release` and relevant Playwright suites; inspect every result.
- [ ] Request one fresh review of the complete change, resolve material findings with regression tests, then commit final docs/fixes and report evidence and limits.
