# Operations Overview Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement the approved design, then request an independent review.

**Goal:** Implement the approved resource-card operations overview and verify its actual desktop/mobile presentation.
**Architecture:** Extend ResourceSampler disk capacity fields without changing execution policy; project each metric independently into six cards. Keep operations in the existing authenticated API, with explicit scheduling readiness, guarded concurrency editing and confirmed Runner restart.
**Tech Stack:** Node 24, React, TypeScript, Ant Design, CSS, Playwright.
**Spec:** https://chatgpt.com/space/page_616cbf2dff1c8191a2527da12cddcff0 (approved by user 2026-10-25).

## Constraints and review focus
- Retain green theme, compact mobile shell, localized interface and current investigation flow.
- Missing metrics never imply zero. Null container limits mean unlimited; absent limits mean unavailable. CPU usage and quota have distinct denominators.
- Disk used = (blocks - bfree) * bsize; available = bavail * bsize. Reserved blocks are not used.
- Unknown or stale platform state cannot enable guessed pause/resume. Paused, blocked and ready are distinct.
- Polling must preserve concurrency drafts; concurrent writes and late refreshes cannot overwrite fresh state.
- Check 320/390/768/1440/1920 widths, both languages, equal card row heights, aligned controls, overflow, error and unlimited states.

## Task 1: Resource data
- [x] Add failing sampler checks for reserved disk capacity, unavailable fields and unlimited cgroup limits.
- [x] Add free/used disk fields and memory available; validate numeric values independently.
- [x] Run targeted Node tests.

## Task 2: Overview implementation
- [x] Add browser tests for accurate cards, partial/missing data, readiness, concurrency and restart behavior.
- [x] Extend frontend types and add focused overview resource rendering/CSS.
- [x] Implement six resource cards, filters, scheduling state, five counters, three service cards and existing error table.
- [x] Preserve drafts, guard mutations and stale refreshes, add accessible loading/error handling and translations.
- [x] Run targeted browser and build checks.

## Task 3: Visual verification and release
- [x] Open the actual rendered page with synthetic fixtures; inspect screenshots and geometry at desktop/tablet/phone widths in Chinese and English.
- [x] Correct visual issues and verify normal, warning, missing, unlimited, paused and blocked states.
- [x] Independent code review; resolve actionable findings.
- [x] Run npm test, npm run check:release, npm run test:browser and git diff --check.
- [x] Update documentation, commit and push to PR #7 (already authorized). Record limits and update instructions.

## Execution ledger
- Existing clean managed checkout on work at 33fd7ac is the ongoing PR workspace; continue in place.
- Approved Pages design read in full. No new design approval needed.
- Task interfaces: sampler -> frontend Resources uses optional fields and explicit null for unlimited; no conflicts.

- Task 1 complete: disk reserved-space and malformed/unlimited cgroup checks failed before implementation and passed after it (3 targeted Node tests).
- Task 2 complete: eight targeted overview browser checks passed. Cold-login compressed JS budget remains below 260 KB.
- Actual rendered screenshots reviewed at 1440px desktop and 320px phone, both languages; service/card/control geometry inspected. The phone empty table needed a full-width placeholder adjustment, now covered by a centering assertion.
- Independent review found slow polling starvation, editor remount bypassing the save lock, and a Runner disclosure mismatch. Fixed with non-overlapping ordinary reads, a page-level editor lock, and consistent disclosure visibility/ARIA. Post-operation reads still supersede older reads.

- Final gate passed: 294 application tests, 157 browser tests, production Admin build, release validation (88 modules / 3 JSON resources), and whitespace checks. Explicit post-save/late-poll regression and Runner disclosure close behavior passed.
- Integration target remains existing PR #7 head branch feat/manager-chat-media-pagination; no merge or production deployment requested.
