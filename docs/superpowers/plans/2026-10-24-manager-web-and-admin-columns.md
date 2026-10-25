# Manager native web tools and Admin columns

> **For agentic workers:** Use superpowers:executing-plans to implement the following tasks inline.

**Goal:** Enable Manager to search/read public web pages through Codex, and make Admin lists use distinct columns and available desktop width.

**Architecture:** Build on PR #7 (`3832895548b585363007eb7a649be5db9db5f28f`, base `bcc4383`). Enable the existing native web capability without adding an HTTP proxy, crawler, MCP integration, or command permissions. Keep the existing narrow-container list layout while separating desktop fields.

**Tech Stack:** Node.js 24, Codex 0.159.2, React, TypeScript, Ant Design, Playwright.

**Spec:** User chose Codex native tools for search, and requested independent table fields and reduced unused horizontal space across Admin.

## Constraints and review focus

- Preserve #7 image generation, history pagination, recovery and streaming.
- Shell, source edits, SQL, browser automation and arbitrary filesystem tools remain disabled.
- Public web content is data; it cannot authorize management changes. Cite actual source URLs and explain unavailable pages honestly.
- Keep all IDs readable/copyable and actions usable with long data in Chinese and English at desktop/tablet/phone widths.
- Separate enablement from connection readiness; split schedule rule from timezone.
- Use only synthetic events and local fixture services; do not read login credentials or run real account work.

## Task 1: Native web capability

- [x] Extend the Manager native-tools regression to require live web search, retain image generation, and preserve read-only/disabled command tools.
- [x] Run it and confirm the failure is the missing web capability.
- [x] Enable `native.webSearch` in Manager start/resume configuration; document search/read scope, source links and untrusted-page behavior in the versioned project prompt and user guides.
- [x] Run Manager/native-tool regressions.

## Task 2: List columns and responsive width

- [x] Capture the existing fixture pages, then split task type/task ID/request ID; plugin name/type/enablement/readiness; schedule name/target/cron/timezone; overview task type/ID.
- [x] Remove the list-page desktop width cap while retaining spacing and form/chat widths. Give long IDs bounded readable cells and copy controls; keep labelled fields on narrow containers.
- [x] Update relevant browser expectations and verify long identifiers, action controls, responsive widths and both locales using the existing browser coverage.
- [x] Run `npm test`, `npm run check:release`, and affected browser suites; inspect final screenshots and review the diff.

## Execution record

- PR #7 baseline verified before this work: 291 application tests, 15 affected browser tests, Admin build and release checks passed.
- Work remains in the session's `work` checkout; PR #7 was applied from its reviewed GitHub patches. No branch merge, deployment, credential access or real model task is part of this work.

## Verified results

- Node.js 24 application suite: 291 passed, zero failures/skips.
- Complete Chromium browser suite: 124 passed; the expanded layout case covers both locales, four views and six viewport widths, including the narrow desktop boundary.
- Admin TypeScript/Vite build and release validation passed (85 modules, 3 JSON resources).
- Standard Docker builds passed for gateway, runner, manager and test targets using separate review tags; the isolated test image passed 284 application tests (the seven host deployment tests are intentionally excluded by the existing container test runner). No running service was replaced.
- Independent read-only review found one narrow-desktop error-column issue, corrected with a regression observed failing at 27.25px and passing with at least 110px readable content at the tested desktop widths. No review findings remain deferred.
- Generated previews use synthetic fixtures. No actual login credentials or production account requests were used.
