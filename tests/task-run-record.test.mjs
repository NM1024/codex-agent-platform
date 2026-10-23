import test from "node:test";
import assert from "node:assert/strict";
import { RequestStore } from "../src/core/store.mjs";
import { BusinessRegistry } from "../src/core/registry.mjs";
import { Dispatcher } from "../src/core/dispatcher.mjs";

test("task query retains safe runtime identifiers and closing facts independently of its result", async (t) => {
  const registry = new BusinessRegistry([{
    type: "test.run", version: "1", prompt: "Submit true.",
    inputSchema: { type: "object" }, resultSchema: { type: "boolean" },
    normalizeInput: (x) => x, buildTask: () => ({ prompt: "Submit true." }),
  }]);
  const store = new RequestStore(":memory:", { registry });
  const dispatcher = new Dispatcher({ store, registry, config: { concurrency: 2 }, runner: {
    ready: async () => ({ ready: true }),
    launch: async () => ({ status: "running", thread_id: "thread-a", turn_id: "turn-a", started_at: 123, token: "must-not-persist" }),
    cancel: async () => {},
  } });
  t.after(async () => { await dispatcher.stop(); store.close(); });
  const task = store.accept("global", { type: "test.run", request_id: "same", input: {} });
  await dispatcher.drain();
  const runId = store.raw(task.task_id).run_id;
  const running = store.get(task.task_id).execution;
  assert.equal(running.thread_id, "thread-a");
  assert.equal(running.turn_id, "turn-a");
  assert.equal(running.token, undefined);
  await store.complete(runId, true);
  await dispatcher.event(runId, "COMPLETED", { status: "ended", ended_at: 456, thread_id: "thread-a", turn_id: "turn-a", code: "COMPLETED", metadata_persisted: false, metadata_error: "RUNTIME_METADATA_WRITE_FAILED" });
  const final = store.get(task.task_id);
  assert.equal(final.status, "completed");
  assert.equal(final.execution.status, "ended");
  assert.equal(final.execution.ended_at, 456);
  assert.equal(final.execution.code, "COMPLETED");
  assert.equal(final.execution.metadata_persisted, false);
  assert.equal(final.execution.metadata_error, "RUNTIME_METADATA_WRITE_FAILED");
});
