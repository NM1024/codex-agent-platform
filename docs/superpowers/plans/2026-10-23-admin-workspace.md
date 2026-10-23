# Admin workspace revision

**Goal:** Make all Admin pages usable at common desktop, tablet and phone sizes, with a familiar chat workspace and separate settings categories.

**Design:** Retain React, TypeScript and Ant Design. Use a compact application header and stable navigation. Chat uses a viewport-height workspace, a desktop conversation sidebar/mobile drawer, separate left/right message bubbles, one scrolling transcript and a bottom composer with compact model/effort controls. Settings use independent category tabs, retaining drafts across tab/language changes, with security/password and read-only deployment tabs. Public assets remain lazy loaded and compressed.

**Authentication:** Password changes through HTTP require the current password, checked on the server. Rejection keeps the existing session; success revokes all sessions. Preserve trusted local password recovery.

- [x] Add failing browser tests for tab isolation/draft persistence, old-password rejection, chat alignment, composer visibility and scroll behavior.
- [x] Implement verified password changes and backend regression tests.
- [x] Rebuild chat and compact model controls; restructure the application shell and shared layout styles.
- [x] Split configuration into tabs, group security controls and preserve drafts.
- [x] Verify all six views in Chinese/English at phone/tablet/desktop/wide desktop sizes; inspect fresh screenshots, run Node24 unit/browser/release checks and Docker packaging. Fix phone task/overview action columns identified during screenshot review.
- [x] Independent review and fixes verified, including cross-page save ordering and short-screen controls. Push to the existing testing PR; keep it unmerged.
