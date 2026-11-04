# Continuous integration scope and retention

CI selects verification from the changed files, records its reasons in the Actions summary and `.tmp/ci-plan.json`, and follows relative imports to include consumers of shared frontend components and browser helpers. New or unclassified runtime paths and unavailable change bases expand to full verification. Changes are compared against the PR base or previous main commit; renames include both old and new paths.

| Change | Verification |
| --- | --- |
| Markdown documentation only | CI policy checks; no dependency install, browser or image build |
| Frontend page/component | Build, types, complete Node test suite, release-source checks, core browser entry checks and affected page suites |
| Shared shell navigation | Core login, seven-page navigation, reload/history, language and related shared-interface coverage |
| Authentication/session provider, shared translation logic, schema, dependency or unclassified runtime changes | Full browser and container/upgrade verification |
| Deployment, sandbox host helper or application version metadata | Container isolation/network, all release images, container tests, real Compose upgrade and relevant browser suites |
| Browser test/helper | Changed tests and indirect helper consumers, plus core entry checks |

The Node suite includes the frontend build/type check, so CI does not repeat that build before Playwright. Existing legacy console cases carry scope tags; the runner checks the real Playwright inventory and rejects unscoped legacy cases. New dedicated browser files are selected directly, and their actual page navigation supplements the ownership map. Dynamic navigation expands page consumers conservatively. Core entry coverage runs alongside scoped browser suites. Unknown frontend dependencies expand rather than silently dropping coverage.

## Triggers and manual verification

Pull requests run on creation and updates. Only pushes to `main` trigger push CI, avoiding the duplicate feature-branch push/PR pair. Tag pushes do not start another copy of an already-tested commit. A newer run cancels an older run for the same PR/ref. Full verification also runs every Monday at 03:17 UTC.

Manual workflows provide two modes:

```bash
gh workflow run ci.yml --ref <branch-or-tag> -f mode=full
gh workflow run ci.yml --ref <branch-or-tag> -f mode=release
```

`full` runs every browser suite and container/upgrade check. `release` compares against the previous reachable stable tag, selects related browser suites and always executes container/upgrade checks. If no safe base exists it expands to full verification.

## Release authorization

A green scoped CI is not sufficient to publish. The publisher requires a successful `test` job and a successful `Release verification (<tested SHA>)` job in the same successful CI run on the exact tagged commit. CI explicitly checks out the PR head or push commit; the proof job includes the actual checkout SHA, so a PR's synthetic merge revision cannot qualify a tag at a different commit. That second job only runs after required code, browser, isolation, image and both source/image Compose update checks succeed and the four tested official candidates have been preserved. Fork PRs cannot publish candidates or obtain this release proof. The publisher pulls those exact candidates, validates release OCI labels and config IDs, and never rebuilds release images. A skipped or failed job is not evidence. Normal application version-bump PRs request this verification automatically; otherwise run manual release verification on the tag before publishing. Published tags and release files remain immutable.

## Storage

Npm download caches are keyed by the dependency lock contents excluding the application's own version fields. Updating only the application version reuses the same cache. PRs restore caches but do not save them; successful main-branch runs may save a missing dependency cache. Cache operations are optional and do not block verification if GitHub storage is unavailable.

Browser screenshots and error contexts upload only when checks fail, expire after 3 days, and upload errors do not conceal the original failure. Successful runs retain no browser artifact uploads. Workflow run records and logs follow repository settings; this change does not delete historical records or change paid budgets. GitHub Actions retention is independent of the platform's runtime history policy. Weekly full checks are one audit run per week, not a model task or production operation.

Official images use GHCR packages, separate from Actions artifact storage. Each trusted release-verification run preserves immutable `COMPONENT-ci-SHA` candidates in one fixed project package; the stable publisher promotes them to version tags and includes the identical images in public Release assets. These candidates and version tags are retained for reproducibility and recovery, so GHCR history can accumulate; it is not covered by Actions artifact expiry. There are no automatic package deletions. Local dependency layers normalize only application version metadata and remove npm download caches within the install layer, reducing repeated layer growth without changing locked dependencies.
