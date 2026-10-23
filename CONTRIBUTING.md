# Contributing

Use Node.js 24. Install the locked dependencies with `npm ci --ignore-scripts`, run `npm test` and `npm run check:release`.

Console changes also require the isolated browser suite:

```bash
npx playwright install --with-deps chromium
npm run test:browser
```

The suite starts its own local server with synthetic SQLite data and a fake Agent; it never uses an account or invokes Codex. If Chromium is already installed, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium` instead of downloading a browser. Reports go to `.tmp/browser-report/`. Production images omit browser test dependencies.

The interface language catalog is `src/manager/web/i18n.js`. Translate interface labels and notifications; preserve user-entered prompts, plugin definitions, task content and Agent messages. Check both desktop and 390px mobile layouts, and preserve form drafts when changing language.

Keep generic task lifecycle, capabilities, plugin contracts, delivery and management separate. A JSON plugin should combine existing tools; do not add a customer's workflow to the platform scheduler. Use synthetic test data and loopback callback endpoints. Tests must not sign in, submit paid/model tasks or contact real business systems.

Keep temporary artifacts in `.tmp/`. Never commit account authentication, deployment environments, certificates, runtime databases or production request/output data. Changes to distribution files must work from a clean Git export, not only a local working directory. Docker targets are `gateway`, `runner`, `manager` and `test`.

For a code change, describe the user-visible problem, resulting behavior and relevant validation. Security issues should follow SECURITY.md.

Keep platform-owned prompt wording in the root [`prompts/`](prompts/README.md) directory and supply message data through `src/prompts.mjs`. Do not put business plugin instructions there or maintain duplicate language copies. Preserve template placeholders and tool identifiers, verify that user data is inserted literally, and include these resources in clean-export and Docker checks.
