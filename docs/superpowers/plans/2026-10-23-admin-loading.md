# Admin loading implementation plan

**Goal:** Reduce the Admin console's initial download while preserving React, TypeScript and Ant Design.

**Architecture:** Lazy load each page behind a loading/error boundary. Generate gzip and Brotli variants of public hashed assets during the Vite build and negotiate them in Manager. Keep nonce HTML and authenticated API responses outside compression.

**Constraints:** Node 24; synthetic tests only; do not deploy locally or merge the testing PR. Preserve all existing management capabilities and UI behavior.

- [x] Add failing tests for compressed byte round trips, negotiation, HEAD and missing assets; record initial bundle size.
- [x] Lazy load pages with localized loading/error feedback. Add browser coverage for deferred requests and chunk failures.
- [x] Generate compressed public assets, serve them with Vary and Content-Length, validate every manifest resource in release checks.
- [x] Measure the initial dependency graph, run unit/browser/release/packaging checks and independent review.
- [x] Push to the existing testing PR without merging.
