# Management chat queue controls

Queued requests belong above the composer and must not appear as sent transcript bubbles until execution or native steering begins. Each queued row offers withdraw/edit, delete and immediate guidance of the active turn. The user explicitly selected immediate guidance rather than priority for the next turn.

Retain the existing durable server queue. A browser-only queue loses cross-tab/restart ownership; priority-only scheduling does not implement the selected guidance behavior. Use the pinned Codex native `turn/steer` with exact thread and expected active turn IDs, preserving the active turn and remaining FIFO requests.

Withdrawal atomically changes an unstarted request to a draft. Edit that row above the composer, preserving the composer's unrelated draft and existing attachments. Resubmitting places the edited request at the queue tail. Delete removes an unstarted queued/draft request and its images. Requests already claimed by execution reject these operations.

Steering atomically reserves a queued request, sends it once, and records its parent request and native turn. Accepted guidance appears as a user bubble labelled as guidance and never gets its own extra execution. Explicit upstream rejection restores the queue entry. Ambiguous transport failure is visibly unconfirmed and never automatically resent; native recorded input markers reconcile it on parent recovery/completion. Queue snapshots are authoritative independently of paged history, and patches carry the current queue so deletions and withdrawals propagate across tabs.

Keep existing Node.js 24, React, TypeScript, Ant Design, SQLite and authenticated same-origin routes. No new dependencies or business runtime changes. Synthetic protocol and browser fixtures only; no production credentials or real-account turns.

Validate queue state transitions, ownership, attachment retention/removal, execution races, exact native steer payloads, duplicate and ambiguous sends, restart reconciliation, authoritative queue updates, draft survival and desktop/mobile controls. Retain the preceding caret fix.
