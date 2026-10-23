import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, access } from "node:fs/promises";
import { EventOutbox } from "../src/runtime/events.mjs";
import { probeCodex } from "../src/codex/session.mjs";
import { allowedTool } from "../src/codex/tool-policy.mjs";

test("native image viewing rejects other runs and symlinks outside owned image roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-view-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "image.jpg");
  await writeFile(file, "owned fixture");
  const elsewhere = await mkdtemp(join(tmpdir(), "agent-foreign-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await writeFile(join(elsewhere, "private.jpg"), "other task");
  await symlink(join(elsewhere, "private.jpg"), join(root, "escape.jpg"));
  assert.equal(
    allowedTool("view_image", { path: file }, { readRoots: [root] }),
    true,
  );
  assert.equal(
    allowedTool(
      "view_image",
      { path: join(elsewhere, "private.jpg") },
      { readRoots: [root] },
    ),
    false,
  );
  assert.equal(
    allowedTool(
      "view_image",
      { path: join(root, "escape.jpg") },
      { readRoots: [root] },
    ),
    false,
  );
  assert.equal(
    allowedTool("view_image", { path: "/workspace/artifacts/other-run/b.jpg" }),
    false,
  );
});
test("lifecycle outbox retries only durable events, not the Codex initial task", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let attempts = 0;
  const sent = [];
  const outbox = new EventOutbox({
    workspace: root,
    send: async (event) => {
      attempts++;
      if (attempts === 1) throw new Error("offline");
      sent.push(event);
    },
  });
  t.after(() => outbox.stop());
  await outbox.publish("00000000-0000-4000-8000-000000000001", "CODEX_EXIT");
  assert.equal(attempts, 1);
  assert.equal(sent.length, 0);
  await outbox.flush();
  assert.equal(sent.length, 1);
  await outbox.flush();
  assert.equal(sent.length, 1);
});
test("generic readiness does not require image generation capability", async () => {
  const client = {
    notify() {},
    async request(name) {
      if (name === "account/read") return { account: { type: "chatgpt" } };
      if (name === "modelProvider/capabilities/read")
        return { imageGeneration: false };
      if (name === "account/rateLimits/read")
        return { ordinaryUsageAllowed: true };
      return {};
    },
  };
  assert.equal((await probeCodex(client, { requireImage: false })).ready, true);
});
test("native tool policy denies shell, file edits and arbitrary external tools while allowing native collaboration", () => {
  for (const name of [
    "exec_command",
    "apply_patch",
    "read_file",
    "arbitrary_http",
    "mcp__foreign__post",
  ])
    assert.equal(allowedTool(name), false);
  for (const name of [
    "spawn_agent",
    "send_input",
    "wait",
    "close_agent",
    "mcp__agent_task__complete_task",
    "multi_agent_v1send_input",
    "multi_agent_v1wait_agent",
    "task_agentssend_message",
    "task_agentsfollowup_task",
  ])
    assert.equal(allowedTool(name), true, name);
});
test("lifecycle outbox durably forwards only allowed runtime details", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-event-details-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const sent = [];
  const outbox = new EventOutbox({workspace, send: async (event) => sent.push(event)});
  t.after(() => outbox.stop());
  await outbox.publish("00000000-0000-4000-8000-000000000001", "COMPLETED", {thread_id: "root", turn_id: "initial", completed: true, token: "secret", prompt: "private"});
  assert.deepEqual(sent[0].details, {thread_id: "root", turn_id: "initial", completed: true});
});
