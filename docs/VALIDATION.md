# Snapshot validation

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
