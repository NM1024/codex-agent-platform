# Contributing

Contributions are welcome, including bug reports, documentation fixes, tests and improvements to the platform. This guide explains how to prepare a change and submit it for review.

## Report a problem or suggest a change

Search the repository's [issues](https://github.com/NM1024/codex-agent-platform/issues) and [pull requests](https://github.com/NM1024/codex-agent-platform/pulls) first.

For a bug, include the source commit or version, relevant Node.js/Docker/Codex versions, steps to reproduce, expected behavior and actual behavior. Use a small synthetic input and sanitized error output where possible. For a feature, describe the problem it solves and the behavior you want. Discuss larger architecture or capability changes in an issue before implementing them so maintainers can check the scope.

Small documentation corrections can go directly to a pull request. Report vulnerabilities privately using [SECURITY.md](SECURITY.md), rather than posting exploit details in a public issue.

## Set up a development checkout

Use Node.js **24**, Git and npm. The full host suite also needs Bash, Docker Engine and Docker Compose v2 because it includes deployment checks. A Linux development environment matches the supported deployment environment. Tests use synthetic inputs and fake model transports; you do not need a ChatGPT login to run them.

1. Fork this repository on GitHub.
2. Clone your fork, install the locked dependencies and create a branch. Replace `YOUR-USERNAME` with your GitHub username:

```bash
git clone https://github.com/YOUR-USERNAME/codex-agent-platform.git
cd codex-agent-platform
git remote add upstream https://github.com/NM1024/codex-agent-platform.git
npm ci --ignore-scripts
git switch -c fix/describe-your-change
```

Keep runtime data separate from source. If you need to try real model work, follow the [installation guide](README.md#install-and-authorize-codex) with your own account; real tasks use account allowance. Automated tests must not sign in, submit paid/model tasks or contact production business systems.

## Make and verify a focused change

Read [AGENTS.md](AGENTS.md) and the [architecture guide](docs/ARCHITECTURE.md) before changing runtime behavior. Follow the style of the module you touch and avoid unrelated formatting changes. Update `package-lock.json` when changing dependencies.

Keep task lifecycle, capabilities, plugin contracts, delivery and management separate. Business rules belong in plugin configuration; do not add a customer's workflow to the platform scheduler. Each normal task gets one complete initial message in an independent Codex conversation. Recovery may continue its existing incomplete conversation; terminal tasks require an explicit new request or retry.

For runtime changes, add or update meaningful tests for the affected behavior and run:

```bash
npm test
npm run check:release
```

For documentation-only changes, check links, anchors and example commands, and keep shared instructions consistent between the English and Chinese READMEs. CI still runs the standard suite. Do not add tests that only repeat documentation text.

### Console changes

Check the English and Chinese interfaces on desktop and at 390px mobile width. The interface catalog is `src/manager/web/i18n.js`; translate interface copy while preserving user-entered prompts, plugin definitions, task content and Agent messages. Form drafts must survive language changes.

Run the isolated browser suite:

```bash
npx playwright install --with-deps chromium
npm run test:browser
```

The suite starts a local server with synthetic SQLite data and a fake Agent. If Chromium is already installed, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium` instead of downloading a browser. Reports go to `.tmp/browser-report/`. Production images omit browser test dependencies.

### Prompt and plugin changes

Platform-owned prompt wording belongs in the root [`prompts/`](prompts/README.md) directory; `src/prompts.mjs` supplies message data. Keep one version of each system prompt, preserve placeholders and tool identifiers, and verify that inserted user data remains literal. Saved Manager instructions take precedence over the file default.

Business plugin instructions remain user-controlled JSON configuration. Keep them separate from platform system prompts. Use existing tools to define a workflow; implement a new capability in its own module when the required tool does not exist. See the [plugin guide](docs/PLUGINS.md).

### Distribution changes

For changes to runtime code or shipped resources, verify the release files from a clean checkout and build the affected Docker targets. CI builds all four targets and runs the test image without network access:

```bash
for target in gateway runner manager test; do
  docker build --target "$target" -t "codex-agent-platform-$target" .
done
docker run --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,exec,size=512m,mode=1777 \
  -e HOME=/tmp codex-agent-platform-test
```

New source modules, prompt files and other runtime resources must be included by both Git and Docker's build allowlist. A working local directory alone does not prove that a clean distribution is complete.

## Submit a pull request

Push your branch to your fork and open a pull request against this repository's `main` branch. Keep the PR focused, give it a descriptive title and explain:

- The problem and the resulting user-visible behavior.
- Any relevant API, configuration or deployment changes.
- The checks you ran, including any checks you could not run and why.
- For visual changes, screenshots using synthetic data to help reviewers compare the result.

Check the diff before publishing. Let CI finish and address review feedback with follow-up commits. Maintainers review the change and decide when to merge; CI success alone is not a review.

## Keep private data out of contributions

Keep temporary logs, probes and screenshots in `.tmp/`. Never commit account authentication, deployment `.env` files, certificates, runtime databases, passwords or production request/output data. Sanitize examples and attachments too. Use loopback callback endpoints and synthetic fixtures for tests.

The project is [MIT-licensed](LICENSE). Check dependency and asset licenses before including third-party material, and update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when appropriate.
