# Management chat media and pagination implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate images directly in management chat, smooth new streamed replies, and load conversation history in bounded pages.

**Architecture:** Enable the existing Codex image capability for Manager. A separate media adapter accepts completed, correlated native image items, validates owned files, and stores private conversation images idempotently. REST and SSE use the same bounded history projection; the browser merges earlier pages with live updates. A display-only animation preserves the original reply text.

**Tech Stack:** Node.js 24, SQLite, sharp, React, TypeScript, existing SSE and Playwright.

**Spec:** User request in this conversation: integrate direct image generation and typewriter replies, and add pagination where missing. Continue implementation in the current checkout as authorized; no account work.

## Global constraints

- Preserve independent business task lifecycle and JSON plugin contracts.
- Manager retains preset MCP operations, image generation and clarification only; no shell/source/SQL access.
- Images require authenticated ownership checks and survive reopening; deleting history removes owned images.
- Use synthetic inputs, Node.js 24, and `.tmp/` for temporary output; run `npm test` and `npm run check:release`.

## Review focus

- Completed/recovered native events must not duplicate generated images or start another model turn.
- Foreign paths, symlinks, malformed image data and foreign conversation access must be rejected.
- Page boundaries must keep user requests and their replies together, including queued requests.
- SSE reconnect, fallback reads and live completion must preserve previously loaded history.
- Animation must handle Chinese/emoji, completed text, reduced motion and conversation changes.

### Task 1: Private generated media

- [x] Write and run failing tests for native event ingestion, ownership, idempotency, failure and recovery.
- [x] Add `src/manager/generated-images.mjs`; extend Manager store, authenticated image route and Agent event consumption. Drain pending media writes before marking a turn complete.
- [x] Verify synthetic media tests and existing Manager tests.

### Task 2: Bounded history

- [x] Write and run failing tests for stable conversation cursors and turn-based message pages, validation and bounded SSE snapshots/actions.
- [x] Add store projections and HTTP cursors (30 conversations, 20 request/reply groups by default; maximum 100). Keep runtime bookkeeping independent of browser pages.
- [x] Add sidebar load-more and earlier-history controls, preserving loaded pages across live updates and navigation.
- [x] Verify API and browser history scenarios.

### Task 3: Reply presentation and release verification

- [x] Write and run failing browser tests for gradual new replies, immediate historical replies and generated image previews/downloads.
- [x] Add smooth grapheme-safe display, reduced-motion support, authenticated media rendering, localized controls and documentation.
- [x] Run all unit tests, browser tests, release validation, distributable checks and Docker targets; record actual results and limitations.

## Verification and review

- Final Node.js 24 Linux application suite: 284 passed, no failures/skips. Final browser suite: 124 passed. TypeScript/Admin build and release validation passed (85 modules, 3 JSON resources).
- Deployment checks: four passed on Windows. The three platform-dependent cases (`init creates a private internal token and independent Admin password, retains configuration and data`, `init adds an initial Admin password to an existing installation without changing its env`, and `release validation rejects missing relative modules before building a runnable image`) passed separately on Linux. Windows `npm test` was attempted but could not complete: existing symbolic-link/Codex process tests hit Windows restrictions; deployment initialization lacked a working WSL Bash, and a path-format expectation assumes Linux separators. No production workaround was added for these environment limitations.
- Standard Docker build could not reach dependency repositories, including through the available local proxy. Offline verification compared the existing runtime's package lock byte-for-byte, replaced its source with the clean final distribution, validated all release files, and built gateway, runner, manager and test targets. The final test image passed all 284 application tests. This validates current files with matching locked dependencies, not a fresh network dependency installation.
- An independent read-only review identified four recovery/pagination issues. Fixed and added coverage for nonterminal recovered image ingestion, middle-history gaps across reconnects, revalidation of omitted active groups, and authoritative aggregate pending counts. `GET /admin/api/conversations/{id}/messages?ids=...` refreshes up to 100 owned request/reply groups without model work. Gap pages retain prior cursors and the visible-message scroll anchor.
- Only synthetic files, sessions and model events were used. No real account credentials were read and no real image generation request was made. Changes are left uncommitted for review; no running deployment was replaced.
