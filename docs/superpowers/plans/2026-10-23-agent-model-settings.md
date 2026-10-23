# Agent Model Settings Implementation Plan

> **For agentic workers:** Execute inline with test-driven-development and verification-before-completion. Use synthetic transports only.

**Goal:** Select models and reasoning independently for global settings, conversations and plugins.

**Architecture:** A shared model catalog adapter reads Codex metadata. Optional execution overrides resolve against global configuration, flow through existing launch messages, and remain recorded per execution. Existing Admin pages share selector controls.

**Tech Stack:** Node.js 24, SQLite, JSON Schema/Ajv, Codex app-server, vanilla JS, Playwright.

**Spec:** ../specs/2026-10-23-agent-model-settings-design.md

## Global Constraints

- Preserve independent requests, accepted plugin snapshots and terminal-task behavior.
- No real credentials, real-account tasks, local deployment or arbitrary management tools.
- Temporary output belongs in .tmp; run npm test and npm run check:release.

## Review Focus

- Old SQLite settings without new fields remain valid.
- Switching models never silently retains incompatible reasoning.
- Unavailable catalog does not delete saved configuration or block unrelated edits.
- Recovery retains conversation message settings and accepted plugin overrides.
- UI selections survive locale changes and JSON edits.

## Tasks

- [x] Add failing tests for catalog pagination and execution override inheritance; implement shared metadata and settings helpers.
- [x] Add failing tests for plugin snapshots, task runtime parameters and recorded execution; implement business configuration flow.
- [x] Add failing tests for conversation overrides/migration and manager parameters; implement conversation endpoints and persistence.
- [x] Add authenticated catalog operations and shared selectors to global, plugin and chat pages; verify browser interactions.
- [x] Update documentation, run tests/release checks, review changes and report deployment steps.
