# Plugin configuration tabs and compact actions

The user's screenshots request moving the separate plugin model-settings action into the existing connection modal as its third tab, after entry settings and optional result callback. The follow-up asks for suitable icon-only row actions like Delete. Sync from main before editing and open a new PR.

Use one modal with entry/callback/model tabs. Retain per-tab drafts while switching. Model settings lazily load on first visit, use the existing execution-only revision-checked operation, and save independently of connection credentials. Saving models stays in the modal with a success message, preserving unsaved connection drafts. Existing connection save and close semantics remain. Independent loading/errors prevent a connection read failure from blocking the model tab. Disable switching during a pending save/claim to prevent conflicting concurrent form actions.

Replace remaining row action text with settings sliders, document, eye and existing trash icons. Each has a translated accessible name and hover/focus tooltip. Reduce the action column to fit the four controls on one row, preserving responsive tables. Keep existing accessible labels to preserve keyboard/screen-reader operation.

Reuse AgentPicker, model defaults/unavailable-value handling, API ownership and revision conflicts. No backend API change, automatic model call or release/tag replacement. Update bilingual navigation docs and the Manager packaged-source validation resource after renaming the former modal to embedded settings.
