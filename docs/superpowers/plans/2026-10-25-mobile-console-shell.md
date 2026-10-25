# Mobile console shell implementation plan

**Goal:** Keep the platform title, navigation and chat controls usable in a compact phone viewport.

**Design:** The user requested a menu button opening downward, icon-only repository/language/logout actions, a platform title in the top bar, fewer secondary descriptions and one row of composer controls. Reuse Ant Design Dropdown and the existing selectors; keep desktop sidebar navigation. Track the visual viewport so a software keyboard can reduce the chat area without covering the composer. Preserve pinch zoom.

**Files:** `frontend/src/App.tsx`, `Icon.tsx`, `components.tsx`, `console.css`, a focused viewport hook, `frontend/index.html`, browser tests and navigation helpers.

- [x] Reproduce the expanded navigation, two-row composer and keyboard viewport mismatch in browser tests.
- [x] Add the compact top bar and downward navigation; preserve accessible names, language switching, logout and active-page indication.
- [x] Keep both selectors, image upload and send on one row; reduce phone-only hints and retain errors and save feedback.
- [x] Follow visual viewport resize/scroll at normal zoom; verify keyboard-height changes, orientation, long drafts and restored height.
- [x] Adapt existing phone navigation tests to open the menu, run application/browser/release checks, inspect phone and desktop captures, review and commit to PR #7.

**Review focus:** 320px width and English labels; menu dismissal and draft preservation; queued messages and image drafts; keyboard viewport offsets; pinch zoom and event cleanup. Use synthetic fixtures only.

Verification: Node.js 24 application suite 293 passed; Chromium suite 148 passed; production build and release graph validation passed (88 modules, 3 JSON resources). The delayed history race test also passed 10 isolated repetitions after adding a stable accessible name. Independent review found no remaining actionable issues. Physical mobile keyboards remain a deployment check; automated coverage uses synthetic VisualViewport events.
