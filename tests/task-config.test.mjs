import { runtimeConfig } from "../src/codex/config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import { BusinessRegistry } from "../src/core/registry.mjs";
import { RequestStore } from "../src/core/store.mjs";
import { createDeliveryWorker } from "../src/delivery/worker.mjs";

test("multiple independent root agents can be configured without stage timeout settings", () => {
  const config = loadConfig("runner", { RUNNER_TOKEN: "test-runner", CONCURRENCY: "3" });
  assert.equal(config.concurrency, 3);
  assert.equal(config.generationTimeoutMs, undefined);
  assert.equal(config.reviewTimeoutMs, undefined);
});

test("only the task-scoped business MCP is preapproved for unattended execution", () => {
  const config = runtimeConfig({ native: {}, tools: ["prepare_cover", "complete_task"] }, "http://gateway:3006/mcp");
  assert.equal(config.mcp_servers.agent_task.default_tools_approval_mode, "approve");
  assert.deepEqual(Object.keys(config.mcp_servers), ["agent_task"]);
  assert.deepEqual(config.mcp_servers.agent_task.enabled_tools, ["prepare_cover", "complete_task"]);
  assert.equal(config["features.shell_tool"], false);
  assert.equal(config["features.apply_patch_freeform"], false);
});

test("foundation gateway configuration needs only internal credentials; entry keys belong to plugins", () => {
  const config = loadConfig("gateway", { RUNNER_TOKEN: "test-runner" });
  assert.equal(config.ingressToken, undefined);
  assert.equal(config.callbackUrl, undefined);
  assert.equal(config.callbackToken, undefined);
  assert.equal(config.reference, undefined);
});

test("unrelated module configuration changes do not block queued work or its delivery", async (t) => {
  let deliveries = 0;
  const module = {
    type: "test.config", version: "1", prompt: "Submit a boolean result.",
    inputSchema: { type: "object" }, resultSchema: { type: "boolean" },
    normalizeInput: (input) => input,
    configuration: (config) => ({ model: config.model, target: config.reviewTarget }),
    delivery: { execute: async () => { deliveries++; return { status: "accepted" }; } },
  };
  const configuration = { model: "gpt-6.1-sol", reviewTarget: "review-v1", callbackUrl: "cover-v1" };
  const registry = new BusinessRegistry([module]);
  const store = new RequestStore(":memory:", { registry, configuration });
  t.after(() => store.close());
  const request = (id) => store.accept("global", { type: module.type, request_id: id, input: {} });
  const queued = request("queued");
  configuration.callbackUrl = "cover-v2";
  const run = store.claim(queued.task_id);
  assert.ok(run);
  await store.complete(run.run_id, true);
  configuration.callbackUrl = "cover-v3";
  await createDeliveryWorker({ store, config: configuration })();
  assert.equal(deliveries, 1);
  assert.equal(store.get(queued.task_id).delivery.status, "accepted");
  const changed = request("own-change");
  configuration.reviewTarget = "review-v2";
  assert.ok(store.claim(changed.task_id));
});


test("operators can configure concurrency above 32 and tasks beyond four hours",()=>{
  const config=loadConfig("runner",{RUNNER_TOKEN:"fixture",CONCURRENCY:"64",TASK_TIMEOUT_MS:"43200000",TOOL_TIMEOUT_MS:"600000"});
  assert.equal(config.concurrency,64);assert.equal(config.taskTimeoutMs,43200000);assert.equal(config.toolTimeoutMs,600000);
  const rpc=runtimeConfig({native:{},tools:["complete_task"]},"http://localhost/mcp",{toolTimeoutMs:config.toolTimeoutMs});
  assert.equal(rpc.mcp_servers.agent_task.tool_timeout_sec,600);
});
