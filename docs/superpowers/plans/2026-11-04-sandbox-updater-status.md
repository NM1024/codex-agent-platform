# Sandbox upgrade and system status correction

Fix the reproducible read-only namespace failure during web updates, preserve explicit opt-out and updater protection, and cover it with a real systemd integration check. Existing unit regression reproduces EROFS before first installation; trusted transient invocation is fixed and cannot recursively delegate.

Add periodic read-only health and one recovery retry per durable cleanup row. Never use destructive recovery as a periodic probe. Replace the fabricated unavailable updater startup record with the fixed bounded status endpoint in the existing maintenance lifecycle. Retention remains governed by global history policy.

Pages design was updated before UI implementation. Replace large statistics with compact filters whose result membership matches their counts; add an explicit recovery-time predicate. Match full-width list layout and omit stalled-age messaging for terminal/idle records. Validate matching counts across pages, wide/narrow layouts, English/Chinese views and unavailable sources.

Run the affected unit and browser suites, full repository checks required by AGENTS.md, distributable validation, independent code review, and release CI including protected systemd installation. Publish v1.0.7 only after successful verification of the exact source commit. Runtime recovery on a user's server must be verified after that server updates.
