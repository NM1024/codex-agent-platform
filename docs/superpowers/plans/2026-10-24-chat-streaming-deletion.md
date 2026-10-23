# Management chat streaming and deletion implementation plan

**Goal:** Bring management chat closer to the requested familiar Agent interaction: live assistant bubbles and deletable history.

**Architecture:** Keep durable per-conversation FIFO and Codex event correlation unchanged. Manager exposes cookie-authenticated SSE with an initial conversation snapshot and coalesced message/metadata patches, rechecking authentication and bounding slow clients. Frontend reconnects through a fresh snapshot, falls back to polling when streaming is unavailable and ignores stale navigation results. Live public reply text has a separate bounded projection rather than the smaller activity budget. Deletion removes local conversation/message/image/activity/action data; pending work is rejected, and completed local Codex/work directories are cleaned without following credential symlinks. Business records stay separate.

**Tech stack:** Node24, SQLite, existing React/TypeScript/Ant Design; native EventSource, no new packages.

**Choices:** SSE matches one-way server output over existing authenticated HTTP; WebSocket adds unnecessary protocol state. Faster polling retains periodic delay and repeated reads. Upstream deltas drive output; no simulated typewriter or raw reasoning. Delete has confirmation and an independent row busy state. No branching, regeneration or cancellation is added to this request.

- [x] Backend RED/GREEN: authenticated SSE initial/update/final/reconnect, cross-conversation isolation, expired/revoked sessions, slow/disconnected clients; durable sanitized reply text beyond activity limits; deletion cleanup and busy protection. Ensure shutdown closes event streams.
- [x] Frontend RED/GREEN: live assistant bubble, completion without duplicate text, reconnect/fallback and stale stream cleanup; row deletion confirmation, success/failure/loading, current selection reset and mobile behavior. Full browser suite passed 78 checks; an additional delayed-admission ordering regression verifies the existing guard.
- [x] Update operational prompts and docs with actual streaming/deletion semantics; pass full npm/Compose (249), browser (78 full plus one focused), type/release and packaged Docker checks (242). Complete independent reviews and deliver through the existing unmerged [testing PR #6](https://github.com/NM1024/codex-agent-platform/pull/6).
