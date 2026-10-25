# Centered loading states

**Goal:** Center and standardize initial loading across Admin pages, chat regions and panels, as requested while image preview/cache work was in progress.

**Approach:** Share a `LoadingState` with a stacked indicator and localized status label. Fill the available content region instead of positioning relative to the entire browser window. Initial data loading in overview/plugins/schedules/tasks/settings and lazy page imports uses the page region; sidebar and transcript use their own areas; connection dialogs and documentation drawers use their bodies. Retain populated views and their existing refresh/button progress indicators.

## Verification

- [x] Reproduce visible loading-content offsets in delayed overview/lazy/sidebar reads. Baseline errors were 482.5px on the page and 394px in the sidebar.
- [x] Apply shared presentation and layout rules without changing task or management operations.
- [x] Verify visible indicator/label bounds against each region in Chinese/English and desktop/phone/landscape sizes, including delayed responses. All nine targeted layout tests passed. Tests wait for responsive navigation and drawer close/focus restoration before further interactions.
- [x] Run combined application/browser/release checks with the image caching and preview work and prepare the PR #7 update. Final results: 293 application tests and 144 browser tests passed, along with TypeScript/Admin build, release validation and whitespace checks. Independent review found no remaining loading regressions.

Keep probes, fixtures and captures synthetic and under `.tmp/`; no real account calls or deployed services are involved.
