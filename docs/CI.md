# Local verification and release publishing

Verification normally runs in the development environment. Pull requests, ordinary pushes and weekly schedules do not automatically start GitHub tests. GitHub is used for the manually requested official image build, packaging and publication.

## Check the affected code locally

Run the required code checks:

```bash
npm test
npm run check:release
```

`npm test` includes the production frontend build and TypeScript checks. Run browser suites for directly and indirectly affected pages, adding shared login, navigation or responsive-layout checks when those paths change. Use synthetic data and mocked Codex transports; do not submit real production tasks. For example, a chat picker change should cover model settings, saved speed state and phone layout rather than unrelated plugin editors.

Run container, sandbox or upgrade checks locally when those paths change. Record actual passing commands and environment limitations in the PR. Complete checks on the final commit before publishing; changing code after verification requires checking the affected changes again.

## Publish the verified commit

Create the stable tag at that exact commit, then explicitly supply both the tag and full locally verified commit SHA:

```bash
gh workflow run release.yml --ref main -f tag=vX.Y.Z -f verified_sha=FULL_40_CHARACTER_COMMIT_SHA
```

The publisher checks the stable tag format, package version and exact checkout SHA before building or pushing images. The supplied SHA is the operator's confirmation of local verification; it does not require a GitHub test run. It builds four official Linux amd64 images from the tagged source, validates OCI version/component/revision labels, publishes immutable image tags and packages those same images. A retry may reuse candidates only after checking their exact revision and labels. Source, update script, image manifest and image archive checksums are verified after upload before the draft becomes the latest stable release. Published releases remain immutable.

## Optional remote verification

The broader verification workflow remains available only on explicit manual request:

```bash
gh workflow run ci.yml --ref <branch-or-tag> -f mode=full
gh workflow run ci.yml --ref <branch-or-tag> -f mode=release
```

It can select browser suites from changed files and shared imports, or run complete container and upgrade checks. It is not a release prerequisite and is never started automatically by a PR, push, tag or schedule.

## Storage

Normal releases do not upload browser artifacts or create Actions dependency caches. Optional manual verification retains its existing cache policy and failure-only browser evidence with a three-day expiry. Workflow logs and existing caches follow repository retention settings; disabling automatic runs does not delete historical storage.

Official images and immutable revision candidates are GHCR packages, separate from Actions artifact storage. Version tags and candidates can accumulate; there is no automatic package deletion. Public Release archives remain available without registry login. GitHub retention is independent of the platform's runtime history cleanup policy.
