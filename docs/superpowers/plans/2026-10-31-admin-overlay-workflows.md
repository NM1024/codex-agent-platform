# Admin overlay workflows implementation plan

> Use the existing feature branch and disjoint parallel tasks. User explicitly requests implementation of these presentation and interaction corrections; earlier authorization to submit and merge completed PRs remains active.

**Goal:** Replace long inline detail/configuration sections with consistent overlays, compact tabbed forms and live channel dropdowns.
**Architecture:** Reuse existing Ant Design and authenticated operations. Use right-hand drawers for record inspection, centered tabbed modals for creation/editing, existing confirmation modals for destructive actions. Preserve backend identity, permissions, task lifecycle and separate notification histories.
**Tech stack:** React/TypeScript, Ant Design 6, existing Node/SQLite operations, Playwright.
**Spec:** Latest user request and screenshots: plugin-style compact icon actions; all add/edit/details open overlays; long forms use tabs, horizontal labels and two-column short fields; notification bindings use dynamic dropdowns.

## Shared interfaces
- `AdminDrawer` from `frontend/src/AdminOverlays.tsx`: `{open:boolean,title:ReactNode,subtitle?:ReactNode,onClose:()=>void,children:ReactNode,extra?:ReactNode,width?:number}`. Defaults to960px, full available width on phones; bounded header and scrolling body.
- `AdminModal` same module: `{open:boolean,title:ReactNode,subtitle?:ReactNode,onCancel:()=>void,children:ReactNode,footer?:ReactNode,width?:number,busy?:boolean}`. Default880px; all close paths lock during busy saves, body scroll only.
- `NotificationChannelSelect` from `frontend/src/NotificationChannelSelect.tsx`: `{value:string[],onChange:(ids:string[])=>void,disabled?:boolean,knownChannels?:NotificationChannel[],id?:string}`. Retrieves safe channel metadata on mount/open; preserves selected unavailable IDs and labels; provider is informational, UUID is identity; no configuration or test sends. Parent owns binding revision/save.
- Shared CSS classes: `admin-overlay`, `admin-editor-form`, `admin-form-grid`, `admin-form-wide`, `admin-row-actions`.
- Root owns shared overlays, styles, i18n wiring and channel selectors. Children never edit shared files. New translation keys go in task reports for root integration.

## Tasks
1. Root: shared overlay presentation; tabbed notification editor (basic/auth/format), horizontal labels, two-column short fields; live multi-select for bindings and retry. Preserve private-field omission/clear, stale-write protection and explicit test confirmation. Update notification tests to actual dropdown interaction.
2. Schedules: plugin-style icon actions, direct new/edit tabbed modal using existing schedule_save, detail drawer tabs for overview/channels/executions. Reuse channel selector. Never trigger a plan merely from opening/saving unrelated bindings. New schedules default disabled. Keep management Agent route available. Validate cron/timezone and task JSON, preserve form drafts and keep errors in overlay.
3. Records: task detail drawer with summary/result/notification/artifact tabs, retaining authenticated artifacts/retry/investigation; plugin definition and invalid plugin records in drawers; schedule execution history owner detail in nested overlay. Remove inline detail sections. Guard late reads and modal dismissal.
4. Plugin definitions: provide new/edit tabbed modal in plugin list through existing JSON definition operations, preserving private connection/model settings, disabled-by-default creation and explicit capability boundaries. Coordinate page edits with Records task (Records owns PluginsPage until handoff).
5. Integrate: desktop/mobile and bilingual regressions, stale reads/save failure/draft retention, empty and multiple same-provider choices. Review changes, build/type/release/full Node checks and targeted/full browser checks; capture fresh synthetic screenshots; submit PR and merge only after CI passes.

## Review focus
- Dialog and dropdown portals have correct stacking and focus return; nested execution drawer closes independently.
- Selected unavailable channels remain explicit; dynamic list failure does not silently clear selections or send.
- Closing a pending request cannot resurrect a drawer; switching records cannot show prior artifacts.
- Tab switches preserve unsaved credential/model/schema drafts and show validation on its owning tab.
- Width320px and landscape phone retain close/save actions and contain JSON/table overflow.

## Scope rulings
The user has specified overlay interaction and compact layouts; implement those directly using existing components and APIs. Use a feature branch in this checkout to preserve the existing environment and generated screenshot artifacts; no additional worktree is required. No runtime deployment or real account work.

## Implementation and verification

All implementation tasks are complete, including existing overview/settings pages. Independent review found two additional races: stale schedule drafts could re-enable stopped plans, and a late notification reload could reopen a dismissed editor. Atomic definition revisions and editor-session guards now cover those cases. Selected unavailable channels are individually removable without clearing valid selections. Save controls retain stable accessible names while busy.

Final local checks: full Node suite647 cases (639 passed,8 optional Docker/network skips); TypeScript production build; release-source validation; diff whitespace check. Browser verification includes the initial full282-case run, correction of its seven findings,60-case workflow coverage with its remaining plugin-button accessibility finding corrected and a20-case clean rerun, and a clean cold-login regression. Comprehensive current-head browser/container verification remains a required CI merge gate.

Eighteen synthetic desktop/mobile screenshots are packaged under ignored `.tmp/admin-overlays/`; no real provider sends, model accounts, deployment, or user data are involved. Deliver through a new PR targeting `main`, and merge after current-head CI passes, as explicitly requested by the user.
