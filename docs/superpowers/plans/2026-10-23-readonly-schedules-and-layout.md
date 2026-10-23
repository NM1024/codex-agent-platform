# Read-only schedules and Admin layout cleanup

User direction: manage schedules through the management Agent, matching the read-only business plugins page. Keep the React/TypeScript/Ant Design frontend complete, well laid out, responsive and free of obsolete frontend code/styles.

Approach: retain the existing Ant Design visual language. Schedule and plugin pages share a clear management-Agent guidance panel, a read-only list and details. Remove schedule form/draft/mutation handlers, keep management MCP operations intact. Show next-run timestamps with an explicit time zone. Consolidate the stylesheet, remove unused classes, obsolete translations and duplicate overrides. Preserve working settings/tasks/chat flows.

1. Capture current desktop/mobile screens and identify concrete spacing/overflow problems.
2. Change browser coverage to require read-only schedule controls, inspection/task details, localized copy and the management-chat shortcut. Confirm expected failures.
3. Implement read-only schedules, shared guidance/details layout and CSS cleanup. Add only necessary regression checks for legacy assets and responsive layout.
4. Verify all six pages in Chinese/English at desktop, tablet and phone widths, checking overflow, clipping, CSP and interactions; inspect fresh screenshots.
5. Run Node 24 tests, build/typecheck, release validation and packaging checks, update docs and request independent review.

Ruling: no new visual direction or framework is needed; preserve the already requested Ant Design stack and improve consistency. “Same as plugins” removes all schedule mutation controls from Admin pages, with the existing Agent API retained.

Updated user ruling: keep simple enable/disable/pause/resume and scalar/model/password controls for humans. Complex creation/editing, trials, JSON/HTTP targets and manager instructions have no editor UI; management Agent retains every preset capability. This supersedes the initial request to remove every mutation control.

Completed: shared Agent guidance, plugin/schedule single-operation switches, read-only definitions/details and complex settings, consolidated CSS without duplicate/unused editor styles, responsive columns and minmax grid sizing, full legacy-directory release guard. Verified 203 platform/deployment checks, 32 browser checks across six pages/two languages/three widths, strict build and release validation, four isolated Docker packaging targets and 197 container checks. Review finding fixed and re-reviewed. Docker environment limitations documented in docs/VALIDATION.md. No commit, push, real-account execution or local deployment.
