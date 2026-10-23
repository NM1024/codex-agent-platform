# Admin conversation and plugin display

User scope: render management Agent replies as Markdown, display message times in the browser's locale/timezone, prefer Codex thread names when available, and make the Admin business plugin page read-only with guidance to use the management Agent. Explain schedules without changing their execution semantics.

1. Add browser coverage for Markdown (including unsafe HTML/URLs), timestamps in multiple timezones, title refresh, and read-only plugin details.
2. Use React Markdown + GFM without raw HTML; display fenced code, lists and tables. Permit safe web links, render images as links to avoid automatic external requests.
3. Display message timestamps using browser Intl defaults, with ISO datetime values. Keep schedule rule timezone explicit.
4. Persist nonempty Codex thread names from thread responses/notifications, including recovery; use existing titles if absent. No extra generation turn.
5. Replace the plugin editor/create/toggle/trial controls with a read-only details view and a management conversation link. Keep Agent plugin operations available.
6. Update interface translations/docs, run type/build, unit/browser suites and release verification, then review the changes.

Ruling: App-server exposes persisted names but does not promise automatic naming. Synchronize names when supplied and retain the existing title otherwise; no additional model cost.
Ruling: “Admin plugin page has no create/edit capability” applies to the page controls. The authenticated management Agent operations remain available as requested.

Completed: all six steps implemented and reviewed. Verification: 203 platform/deployment checks (202 Linux npm tests + 1 host Compose check), 27 browser tests, strict TypeScript/production build/release validation, four isolated packaging targets and 197 final container tests. See docs/VALIDATION.md for dependency-layer reuse and network/apt limitations. All runtime/model/browser work used synthetic data. No local deployment, real account tasks, commit or push.
