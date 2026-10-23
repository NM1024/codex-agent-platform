import test from "node:test";
import assert from "node:assert/strict";
import { RequestStore } from "../src/core/store.mjs";
import { BusinessRegistry } from "../src/core/registry.mjs";
import { Dispatcher } from "../src/core/dispatcher.mjs";
import { createTaskApi, createPrivateApi } from "../src/api.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const module = {
  type: "test.review",
  version: "1",
  prompt: "Review everything and submit once.",
  normalizeInput: (x) => x,
  inputSchema: { type: "object" },
  resultSchema: {
    type: "object",
    properties: { passed: { type: "boolean" } },
    required: ["passed"],
    additionalProperties: false,
  },
  tools: {},
  buildTask: (input) => ({
    prompt: `Review ${JSON.stringify(input)} and call complete_task.`,
    tools: ["complete_task"],
    native: { imageGeneration: false, webSearch: false },
  }),
};
async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, { availability } = {}) {
  const registry = new BusinessRegistry([
    { ...module, ...(availability ? { availability } : {}) },
  ]);
  const store = new RequestStore(":memory:", { registry });
  const launches = [],
    finished = [];
  let privateUrl;
  const runner = {
    ready: async () => ({ ready: true, imageGeneration: false }),
    launch: async (run) => {
      launches.push(run);
      return { status: "running" };
    },
    completed: async (id) => finished.push(id),
    cancel: async () => {},
  };
  const config = {
    ingressToken: "ingress-test",
    runnerToken: "runner-test",
    concurrency: 1,
    paused: false,
  };
  const dispatcher = new Dispatcher({ store, registry, runner, config });
  const api = createTaskApi({ store, registry, dispatcher, config });
  const privateApi = createPrivateApi({
    store,
    registry,
    dispatcher,
    runner,
    config,
  });
  const publicUrl = await listen(api);
  privateUrl = await listen(privateApi);
  t.after(async () => {
    await dispatcher.stop();
    api.closeAllConnections();
    privateApi.closeAllConnections();
    await Promise.all([
      new Promise((r) => api.close(r)),
      new Promise((r) => privateApi.close(r)),
    ]);
    store.close();
  });
  const submit = async (id = "one") => {
    const res = await fetch(publicUrl + "/v2/tasks", {
      method: "POST",
      headers: {
        authorization: "Bearer ingress-test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: module.type,
        request_id: id,
        input: { content: "example" },
      }),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    store,
    dispatcher,
    runner,
    launches,
    finished,
    privateUrl,
    publicUrl,
    submit,
  };
}
test("API -> one launch -> real MCP completion -> durable query, without business polling", async (t) => {
  const { submit, dispatcher, launches, privateUrl, store, finished } =
    await setup(t);
  const accepted = await submit();
  assert.equal(accepted.status, 202);
  await dispatcher.drain();
  assert.equal(launches.length, 1);
  const client = new Client({ name: "test-agent", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(privateUrl + "/mcp"), {
      requestInit: {
        headers: { Authorization: `Bearer ${launches[0].token}` },
      },
    }),
  );
  const result = await client.callTool({
    name: "complete_task",
    arguments: { result: { passed: true } },
  });
  assert.equal(result.isError, undefined);
  assert.equal(store.get(accepted.body.task_id).status, "completed");
  assert.ok(finished.includes(launches[0].run_id));
  const replay = await submit();
  assert.equal(replay.body.status, "queued");
  assert.notEqual(replay.body.task_id, accepted.body.task_id);
  await dispatcher.drain();
  assert.equal(launches.length, 1);
  await dispatcher.event(launches[0].run_id, "COMPLETED");
  await dispatcher.drain();
  assert.equal(launches.length, 2);
});


test("unsupported module capability queues with an explicit reason and starts no dialogue", async (t) => {
  const { submit, dispatcher, launches, publicUrl } = await setup(t, {
    availability: () => ({
      ready: false,
      reason: "NATIVE_IMAGE_ATTEMPT_GATE_UNAVAILABLE",
    }),
  });
  const accepted = await submit();
  await dispatcher.drain();
  assert.equal(launches.length, 0);
  const res = await fetch(publicUrl + "/v2/tasks/" + accepted.body.task_id, {
    headers: { authorization: "Bearer ingress-test" },
  });
  assert.equal(
    (await res.json()).blocked_reason,
    "NATIVE_IMAGE_ATTEMPT_GATE_UNAVAILABLE",
  );
});
test("ambiguous launch failure waits for runtime reconciliation without creating a new conversation", async (t) => {
  const { submit, dispatcher, runner, launches, store } = await setup(t);
  runner.launch = async (run) => {
    launches.push(run);
    throw new Error("transport lost after send");
  };
  const accepted = await submit();
  await dispatcher.drain();
  assert.equal(store.get(accepted.body.task_id).status, "suspended");
  assert.equal(store.get(accepted.body.task_id).error, null);
  await dispatcher.drain();
  assert.equal(launches.length, 1);
});

test("independent requests start concurrently up to the configured root capacity", async (t) => {
  const { submit, dispatcher, runner, launches } = await setup(t);
  dispatcher.config.paused = true;
  dispatcher.config.concurrency = 2;
  let release;
  const gate = new Promise((r) => (release = r));
  let started;
  const bothStarted = new Promise((r) => (started = r));
  runner.launch = async (run) => {
    launches.push(run);
    if (launches.length === 2) started();
    await gate;
    return { status: "running" };
  };
  await submit("identical");
  await submit("identical");
  await submit("identical");
  dispatcher.config.paused = false;
  const drain = dispatcher.drain();
  try {
    await Promise.race([
      bothStarted,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Concurrent launches did not start")), 2000);
        timer.unref();
      }),
    ]);
    assert.equal(launches.length, 2);
    assert.equal(new Set(launches.map((run) => run.run_id)).size, 2);
    assert.equal(dispatcher.active.size, 2);
  } finally {
    release();
    await drain;
  }
});
