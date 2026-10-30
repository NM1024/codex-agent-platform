# Manager Local Code Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development; disjoint adapter, network, service, frontend and deployment tasks may use superpowers:dispatching-parallel-agents with the root-owned interface contract.

**Goal:** Ship the approved local management sandbox with conversation file upload, isolated Python/Node execution, safe result delivery and scoped human approvals.

**Architecture:** Manager keeps identity, attachments and approvals. A narrow installation-owned Unix endpoint controls fixed local Docker containers and approved egress; neither Manager nor workload receives Docker socket or platform credentials. Existing conversation/MCP/cleanup paths compose the capability without a new job platform.

**Tech Stack:** Node.js 24, SQLite, existing React/TypeScript/Ant Design, Python standard library host adapter, Docker, fixed Python/Node image.

**Spec:** docs/superpowers/specs/2026-10-30-manager-code-sandbox-design.md (user explicitly approved implementation).

## Global Constraints

- Current conversation identities only; no host paths, Docker flags or credentials in model arguments.
- Nonroot readonly code containers, cap-drop-all, no-new-privileges, 1CPU/1GiB/128PIDs, workspace256MiB/tmp64MiB; ordinary60s/max120s, approved deployment max600s/2GiB.
- Default no network; approved canonical domains enforced by a local proxy and independent network rules. Refuse networking if the boundary cannot be enforced.
- Upload20MiB/file, <=5/100MiB per message, publish20MiB; persistent authenticated conversation attachments separate from temporary tmpfs files.
- One active command per conversation, at most2 containers, idle30min recycling, cancellation/timeout/OOM removes container, no restart replay.
- Real authenticated decision cards; default one operation/start within10min, bind instance/revision/command and no implicit grant through text.
- Synthetic/local fixtures only. Full npm test/build before browser suites, not concurrently with browser fixtures.

## Review Focus

- A sandbox restart or concurrent edit must invalidate unused approval, including uploaded script changes.
- A lost execute/approval response must not enqueue duplicate continuation or run a command twice.
- Host/network cancellation must kill all descendants and close existing proxy connections before claiming completion.
- File publication/upload cannot follow symlinks, escape owner scope or become Admin-origin active content.
- Newly scoped tools must not grant ordinary chats inspection notification scope or allow native host Shell.

### Task 1: Local container runtime and safe file operations
**Files:** scripts/sandbox_runtime.py, scripts/sandbox_files.py, tests/sandbox-runtime.test.mjs.
**Interfaces:** fixed host protocol and SandboxRuntime.dispatch/recover/sweep/close from .tmp/sandbox/contracts.md; consumes network module from Task2.
- [ ] Write failing tests for actual container isolation, resource/byte bounds, file path/link denial, LRU/idle cleanup, scope, repeat keys and full-tree cancellation.
- [ ] Implement fixed Docker argument lists, bounded process output and private tmpfs workspace. Never run request text in host Shell.
- [ ] Prove Python and Node work in actual fixed-image containers; timeout and descendant cleanup return honest terminal records.

### Task 2: Approved-only egress
**Files:** scripts/sandbox_network.py, tests/sandbox-network.test.mjs.
**Interfaces:** SandboxNetwork.available/enable/disable/recover/close, per-job peer identity and deadline.
- [ ] Write failing proxy tests for allowed host, private/IPv6/rebinding/redirect/new-domain rejection, and connection close on revoke.
- [ ] Implement internal per-container networking with direct egress blocked and host access denied except guarded proxy; fail closed if firewall unavailable.
- [ ] Verify no shared platform network and no credentials injected into code. Preserve managed upstream proxy/trust when applicable.

### Task 3: Manager sandbox service and scoped contracts
**Files:** src/sandbox/contracts.mjs/client.mjs, src/manager/sandbox.mjs, focused tests.
**Interfaces:** ManagerSandbox execute/context/upload/attach/filesForMessage/readFile/decide/queueCleanup/cleanup/recover/cancelMessage as fixed contract.
- [ ] Test owning active-message authorization, file upload/import/publication, untrusted preview, invalid grant, expiry/revision mismatch, duplicate decision/exec and cleanup recovery.
- [ ] Implement authenticated Unix client with bounded JSON and unknown-effect errors; keep user approval decisions outside MCP execute.
- [ ] Persist attachments and small approval/operation records in Manager storage, stable file bytes outside DB; no extra job platform.

### Task 4: Existing Manager integration
**Files:** manager agent/store/server/operations/mcp/main, contracts/management, prompts, AGENTS, release/source checks and new real integration tests.
- [ ] Add file_ids admission and public message file metadata through safe injectable hooks; attach and enqueue atomically.
- [ ] Forward trusted execution context to sandbox tools; add same-origin upload/download/context/decision/cancel routes.
- [ ] Wire callbacks for deletion, retention, restart and inspection terminal cancellation; include safe input file IDs in every start/resume.
- [ ] Verify real MCP + authenticated HTTP loop for upload→script→execution→publication→download and denial of foreign/plain-chat approvals.

### Task 5: Chat UI
**Files:** ChatPage/context/types, new Sandbox components/styles/translations, browser tests.
**Interfaces:** raw upload, file_ids messages, authenticated attachment URLs, context polling and decision/cancel APIs in contract.
- [ ] Observe failing integrated tests for file-only sends and pending approval cards.
- [ ] Add generic file selection/upload retention, input/output attachments, lightweight execution cards and explicit allow/deny/revoke controls.
- [ ] Verify draft preservation, duplicate click lock, logout/navigation invalidation, mobile and English copy.

### Task 6: Fixed image and deployment
**Files:** Dockerfile.sandbox, sandbox requirements, host wrapper, compose/deploy/docs and deployment tests.
**Interfaces:** host wrapper imports runtime/network and exposes fixed peer-authenticated Unix protocol; image codex-agent-platform-sandbox:1.0.2.
- [ ] Test install config, endpoint ownership, strict request controls, no Docker socket mount and safe unavailable/manual setup behavior.
- [ ] Build fixed Python+Node+pytest/numpy/pandas/matplotlib/Pillow image with pinned dependencies and inherited build proxy/CA trust.
- [ ] Integrate optional host helper installation/status/disable and Manager socket channel; never start real production service from tests.

### Task 7: Verification, review and publication
- [ ] Run focused tests, npm test, release validation, actual Docker isolation and approved network checks, then serial relevant browser suites.
- [ ] Independently review module changes and whole feature; fix material findings with regression coverage.
- [ ] Document actual installation/limits, update design implementation status, commit all changes and open a new PR as requested earlier; no merge/deploy.
