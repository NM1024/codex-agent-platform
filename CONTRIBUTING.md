# Contributing

Use Node.js 24. Install the locked dependencies with `npm ci --ignore-scripts`, run `npm test` and `npm run check:release`.

Keep generic task lifecycle, capabilities, plugin contracts, delivery and management separate. A JSON plugin should combine existing tools; do not add a customer's workflow to the platform scheduler. Use synthetic test data and loopback callback endpoints. Tests must not sign in, submit paid/model tasks or contact real business systems.

Keep temporary artifacts in `.tmp/`. Never commit account authentication, deployment environments, certificates, runtime databases or production request/output data. Changes to distribution files must work from a clean Git export, not only a local working directory. Docker targets are `gateway`, `runner`, `manager` and `test`.

For a code change, describe the user-visible problem, resulting behavior and relevant validation. Security issues should follow SECURITY.md.
