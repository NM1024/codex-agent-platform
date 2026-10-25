# Admin UI consistency

> **For agentic workers:** Use superpowers:executing-plans inline, preserving the earlier Manager web and column work.

**Goal:** Normalize controls and improve visual hierarchy throughout the existing Admin console.

**Spec:** User requires consistent, standardized buttons, tags, inputs and page presentation. The user selected retaining the green identity, unifying conventions and strengthening hierarchy.

**Approach:** Centralize Ant Design tokens in `frontend/src/theme.ts`; remove contradictory local dimensions; normalize status tags and application surfaces. Preserve behavior, page structure, native search and the prior responsive table improvements. No dependency additions, account work or deployment.

**Scope:** Standard 36px controls, 32px compact controls, 24px minimum tags, semantic status colors, consistent radii/spacing/focus, and clearer panel/navigation/metric hierarchy. See `docs/UI-GUIDELINES.md`.

- [x] Inspect live synthetic pages and record before screenshots/computed sizes in `.tmp/style-before/`.
- [x] Add shared theme and normalize local overrides; document the rules.
- [x] Apply consistent status/panel styling across desktop, phone, dialogs, settings and chat.
- [x] Build, inspect after screenshots and measure controls; run existing browser coverage for layout and interaction.
- [x] Run application tests and release checks; review the style-only change independently.

Baseline: the existing tree passed 291 application tests, 124 browser tests, release validation and all four Docker targets in the preceding task. Keep unrelated existing modifications intact. Style review baseline is `.tmp/admin-style-baseline/`.

## Verification

- Final Node.js 24 application suite: 291 passed, zero failures/skips. TypeScript/Admin build and release validation passed.
- Full Chromium browser regression: 124 passed. After the final header alignment fix, all seven affected header/form/phone/full-page layout cases passed again.
- Existing layout and chat tests now cover English metric text and four attachment controls at 320px; both regressions were observed failing before their fixes. Header alignment likewise failed at 28.84px before normalizing the select to 32px.
- Final computed-size captures across six pages at desktop/phone widths confirm standard buttons/inputs/selects 36px, compact buttons/selects 32px, and ordinary tags 24px.
- Tag text/background contrast ratios measured 4.95–6.28. This is a targeted text-color check, not a claim of complete accessibility compliance.
- Independent review feedback and verified clipping cases were resolved; no findings deferred.
- All four final Docker build targets passed. The isolated test image passed 284 application tests; the existing container runner excludes the seven host deployment tests.
- Only synthetic fixture data was used; no production credentials, account tasks, push or deployment.

## Final submission review

- The full combined change received an independent review before updating PR #7. Two additional chat races were reproduced and fixed: a delayed older page could discard a newer reconnect gap, and delayed reconciliation could revert an action-only stream update. Both have browser regressions observed failing before the fixes.
- Final combined tree: 291 application tests and 126 browser tests passed. TypeScript/Admin build, release validation and whitespace checks passed.
- All four final Docker targets built. The isolated test image passed 284 tests with the CI read-only, non-root, no-network and reduced-privilege settings; seven host deployment tests remain covered by the application suite.
- No review findings remain unresolved. Native search and image generation were verified with synthetic events and runtime configuration assertions, without real-account requests.
