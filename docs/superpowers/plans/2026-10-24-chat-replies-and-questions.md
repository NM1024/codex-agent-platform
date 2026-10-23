# Preserve chat replies and support clarification questions

> **For agentic workers:** Use superpowers:executing-plans and a fresh final review.

**Goal:** Keep each public Agent message when a final result arrives and let humans answer native clarification questions in the existing chat.

**Architecture:** Persist bounded public reply items independently of activity; keep the final reply record and old partial_text for compatibility. Manager-only native request_user_input gets a deferred RPC handler and authenticated human answer route, with durable question cards and explicit expired/answered states. Business task execution and all approval denials remain unchanged.

**Sources:** The project's pinned 0.159.2 generated ToolRequestUserInputParams/Response schemas and https://learn.chatgpt.com/docs/app-server#toolrequestuserinput . Official docs use a shorthand heading; the pinned wire method is item/tool/requestUserInput.

## Constraints / review focus

- Public assistant output only; no raw reasoning, tool payloads or credentials.
- Questions bind to the exact active conversation/message/thread/turn and can be answered once, never as a new queued task. Do not auto-select or auto-submit answers.
- Support up to three short questions with choices and protocol-authorized free text; reject secret questions and bound input size. Credentials stay in plugin connection settings.
- Keep existing execution timeout, FIFO and busy deletion guards. Ended/interrupted/disconnected prompts expire; restart recovery can ask again, never apply stale RPC IDs. No promise of indefinite waiting.
- Keep shell/file/network/permission approvals denied; only management receives the question feature and hook allowance.
- UI retains local answer drafts while a question is active, with independent submitting/error feedback and answered/expired history. Switching chat cannot send an answer to another conversation.

## Tasks

- [x] Reproduce multi-item overwrite and add public reply item persistence/rendering regressions.
- [x] Add bounded question storage/validation, deferred RPC handling and exact active turn/human answer routing; test correlation, duplicate answers, failures, recovery and auth.
- [x] Add localized question cards and stable per-item bubbles; verify completion, SSE/reopen, choices/free text, loading, stale navigation and phone layout.
- [x] Run project/browser/release and packaged Linux checks, review, then update the same PR without merging.

Final verification: 269 Linux project tests + 2 Compose checks, 113 browser checks, 264 packaged container checks; all four temporary packaging targets and release/type/build checks passed. Review findings and environment limitations are recorded in docs/VALIDATION.md. Publish only to current PR #6; do not merge.
