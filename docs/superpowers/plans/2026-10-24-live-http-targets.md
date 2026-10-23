# Live HTTP targets implementation plan

> **For agentic workers:** use superpowers:executing-plans inline. The user has requested implementation in the current PR; do not merge.

**Goal:** configure ordinary HTTP capability targets from management chat and an Admin tab, applying changes immediately.

**Architecture:** install a new module-owned `http_targets` configuration scope, expose it through existing preset operations, and render a dedicated target-list/editor component. Preserve the retired scope and plugin connection boundaries.

**Tech stack:** Node.js 24, SQLite, React, TypeScript, Ant Design.

**Spec:** `docs/superpowers/specs/2026-10-24-live-http-targets-design.md`.

## Tasks

- [x] Add failing backend tests for production scope discovery, hot HTTP calls with a synthetic local sink, token masking/preservation/removal, persistence/bootstrap precedence, ignored retired data and revision conflicts.
- [x] Install the descriptor in application configuration; add conditional revision updates to ConfigurationStore and require a revision for HTTP target writes through the shared management contract. Update prompt guidance and documentation.
- [x] Add browser regressions, then implement the dedicated HTTP target tab/list/editor with local validation, optional password field/clear control, revision conflicts, independent loading, cancellation and retained drafts after validation/conflicts. The modal blocks background tab changes until saved or cancelled.
- [x] Run targeted and complete Node/browser checks, release/build and isolated Docker packaging checks. Obtain a fresh review and fix actionable findings.
- [x] Push the current PR and leave it unmerged.

## Review focus

- Never return stored tokens through configuration, MCP, UI lists or errors.
- Do not resurrect retired HTTP configuration or replace persisted targets with new environment defaults.
- Concurrent edits fail visibly rather than deleting another target or overwriting credentials.
- No automatic remote requests on save, no arbitrary Agent shell access, and no changes to callbacks or plugin entry settings.
- Chinese/English phone and desktop forms fit; tab changes retain edits; success clears secret drafts.
