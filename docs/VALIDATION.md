# Validation

## Initial standalone snapshot

The initial standalone preview was checked with synthetic data and local services:

- Host: `npm test` — 181 passed, no skipped tests.
- Clean staged source export: `npm run check:release` — 58 modules and 2 JSON resources.
- Docker: `test`, `gateway`, `runner` and `manager` targets built from that export.
- Test container: non-root, read-only filesystem, no network — 175 passed. Six host deployment tests require Docker/Git and run in the host suite.
- Isolated Compose: three healthy services, generated independent Admin password, two generic plugins, five live configuration groups, paused queue submission, password/session revocation.
- Chromium: desktop and 390px mobile checks for login, live configuration, write-only credentials, ingress rotation, persisted settings, safe text rendering, password change and logout.
- Callback plugin restart: both a custom plugin and a bundled example edited to use a persisted HTTP destination remain usable after reopening storage.
- Gitleaks 8.24.3: no findings in the staged source distribution.
- `npm audit --omit=dev`: no reported advisories for the locked dependencies at validation time.

No real account authentication, model/image generation or production callback was used. Tests prove transport and platform behavior with fixtures; real-account capability availability and generated content quality still require verification in the operator's deployment. Scan results describe this snapshot, not a guarantee about future changes or every possible vulnerability.


## Bilingual console and workflow checks

The console follow-up was validated with the same account-free boundary:

- Host: `npm test` — 182 passed; no failures or skips.
- Browser: `npm run test:browser` — 14 passed in Chromium against a synthetic local server. Coverage includes plugin save/trial continuity, disabled schedule editing, settings drafts across group saves, Enter search and caller request IDs, image preview/text download, safe chat rendering and polling, session reload/logout, Chinese/English switching and persistence, mobile navigation, typing during a slow language refresh, and English service validation errors.
- UI review: 18 fresh screenshots across Chinese/English, desktop and 390px mobile. Navigation stays visible on phones; keyboard focus, field labels and secondary text contrast were improved. User-entered plugin definitions, prompts and task data are preserved when changing language.
- Clean Git-index export: release validation passed with 59 modules and 2 JSON resources. All four Docker targets built from the export; the non-root, read-only, network-disabled test container passed 176 tests with no skips.
- Locked dependency audit, including development dependencies: no reported advisories. Gitleaks 8.24.3 found no secrets in the clean source export.
- Independent review reproduced two additional issues (edits made while a language request was pending and untranslated schedule validation errors). Both were fixed and their targeted browser regressions passed on re-review.

Run the browser suite with the commands in [CONTRIBUTING.md](../CONTRIBUTING.md). Screenshots and test reports are temporary local evidence under `.tmp/`; they are not shipped as product data. Browser and transport tests use synthetic metrics, tasks and Agent messages. They do not verify production networking, actual account permissions, model output quality or the accuracy of a real management Agent's investigations.
