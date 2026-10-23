import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RequestStore } from "../src/core/store.mjs";
import { BusinessRegistry } from "../src/core/registry.mjs";
import { HttpError } from "../src/errors.mjs";
import { mcpError } from "../src/mcp/errors.mjs";
import { createMcpHandler } from "../src/mcp/server.mjs";

async function setup(t, options = {}) {
  let executions = 0;
  const completed = [];
  const registry = new BusinessRegistry([
    {
      type: "test.echo",
      version: "1",
      prompt: "Do the work.",
      describeError: options.describeError,
      normalizeInput: (x) => x,
      inputSchema: { type: "object" },
      resultSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      tools: {
        publish: {
          description: "Publish once",
          inputSchema: {
            type: "object",
            properties: {
              operation_id: { type: "string" },
              value: { type: "string" },
              channel: { type: "string" },
            },
            required: ["value"],
            additionalProperties: false,
          },
          execute: async (x, context) => {
            executions++;
            if (options.publishExecute) return options.publishExecute(x, context);
            return { published: x.value };
          },
        },
        local_check: {
          description: "Local deterministic validation",
          effect: "local",
          contentResult: options.localContentResult,
          inputSchema: {
            type: "object",
            properties: { operation_id: { type: "string" } },
            required: [],
            additionalProperties: false,
          },
          execute: async (args) => {
            if (options.localExecute) return options.localExecute(args);
            throw new Error("invalid local image");
          },
        },
      },
    },
  ]);
  const store = new RequestStore(":memory:", { registry });
  const server = createServer(
    createMcpHandler({ store, registry, onComplete: (r) => completed.push(r) }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  });
  const task = store.accept("caller", {
    type: "test.echo",
    request_id: "a",
    input: {},
  });
  const run = store.claim(task.task_id);
  const client = new Client({ name: "tests", version: "1" });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${run.token}` } },
    }),
  );
  t.after(() => client.close());
  return { client, store, run, executions: () => executions, completed, url, server, registry };
}
test("real Streamable HTTP MCP discovers scoped tools, validates input and records each write", async (t) => {
  const { client, executions } = await setup(t);
  assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), [
    "complete_task",
    "local_check",
    "publish",
  ]);
  assert.equal(
    (
      await client.callTool({
        name: "arbitrary_post",
        arguments: { url: "https://other.invalid" },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await client.callTool({
        name: "publish",
        arguments: { operation_id: "a", value: 1 },
      })
    ).isError,
    true,
  );
  const first = await client.callTool({
    name: "publish",
    arguments: { operation_id: "a", value: "done" },
  });
  assert.deepEqual(
    (
      await client.callTool({
        name: "publish",
        arguments: { operation_id: "a", value: "done" },
      })
    ).structuredContent,
    first.structuredContent,
  );
  assert.equal(executions(), 2);
});
test("local processing errors allow the Agent to submit a corrected final result", async (t) => {
  const { client } = await setup(t);
  assert.equal(
    (
      await client.callTool({
        name: "local_check",
        arguments: { operation_id: "bad-local-input" },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await client.callTool({
        name: "complete_task",
        arguments: { result: { value: "handled local error" } },
      })
    ).isError,
    undefined,
  );
});
test("only complete_task seals results and completed token can only replay receipt", async (t) => {
  const { client, store, run, completed, executions } = await setup(t);
  const statusBeforeInvalidResult = store.get(run.task_id).status;
  assert.equal(
    (
      await client.callTool({
        name: "complete_task",
        arguments: { result: { value: 3 } },
      })
    ).isError,
    true,
  );
  assert.equal(store.get(run.task_id).status, statusBeforeInvalidResult);
  const first = await client.callTool({
    name: "complete_task",
    arguments: { result: { value: "final" } },
  });
  assert.equal(first.isError, undefined);
  assert.equal(store.get(run.task_id).result.value, "final");
  assert.deepEqual(
    (
      await client.callTool({
        name: "complete_task",
        arguments: { result: { value: "final" } },
      })
    ).structuredContent,
    first.structuredContent,
  );
  assert.equal(
    (
      await client.callTool({
        name: "publish",
        arguments: { operation_id: "late", value: "bad" },
      })
    ).isError,
    true,
  );
  assert.equal(executions(), 0);
  assert.ok(completed.includes(run.run_id));
});
test("private MCP rejects absent credentials, origins and another run identifier", async (t) => {
  const { url, client } = await setup(t);
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  const result = await client.callTool({
    name: "complete_task",
    arguments: { task_id: "another", result: { value: "injected" } },
  });
  assert.equal(result.isError, true);
});

const toolError = (response) => {
  assert.equal(response.isError, true);
  const error = response.structuredContent.error;
  assert.equal(typeof error.code, "string");
  assert.equal(typeof error.message, "string");
  assert.ok(error.retryable === null || typeof error.retryable === "boolean");
  assert.equal(typeof error.operation_status, "string");
  assert.equal(typeof error.action, "string");
  return error;
};
test("unidentified writes preserve original arguments and receive unique recorded call IDs across handler recreation", async (t) => {
  const calls = [];
  const { client, executions, store, registry, server } = await setup(t, {
    publishExecute: (args, context) => { calls.push({ args, context }); return { published: args.value }; },
  });
  const args = { value: "same-action", channel: "same" };
  const first = await client.callTool({ name: "publish", arguments: args });
  assert.equal(first.isError, undefined);
  server.removeAllListeners("request");
  server.on("request", createMcpHandler({ store, registry }));
  const second = await client.callTool({ name: "publish", arguments: args });
  assert.equal(second.isError, undefined);
  assert.equal(executions(), 2);
  assert.deepEqual(calls.map((call) => call.args), [args, args]);
  assert.notEqual(calls[0].context.operationId, calls[1].context.operationId);
  assert.equal(calls[0].context.store, store);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_operations WHERE status='completed'").get().n, 2);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='agent_operation_aliases'").get(), undefined);
});
test("unknown external calls redact remote errors and allow the Agent to commit a failed result", async (t) => {
  const secret = "upstream token=private-secret-key stack trace";
  const { client, executions, store, run } = await setup(t, { publishExecute: () => { throw new Error(secret); } });
  const first = await client.callTool({ name: "publish", arguments: { value: "uncertain" } });
  const error = toolError(first);
  assert.equal(error.operation_status, "unknown");
  assert.equal(error.retryable, null);
  assert.doesNotMatch(error.action, /do not retry|outside this task/i);
  assert.doesNotMatch(JSON.stringify(first), /private-secret|stack trace/);
  assert.equal(executions(), 1);
  const completion = await client.callTool({ name: "complete_task", arguments: { result: { value: "failed: remote outcome unknown" } } });
  assert.equal(completion.isError, undefined);
  assert.equal(store.get(run.task_id).status, "completed");
});
test("local tool effects own repeated-payload behavior", async (t) => {
  let effects = 0;
  const { client } = await setup(t, { localExecute: () => ({ prepared: ++effects }) });
  const first = await client.callTool({ name: "local_check", arguments: {} });
  const second = await client.callTool({ name: "local_check", arguments: {} });
  assert.equal(first.structuredContent.prepared, 1);
  assert.equal(second.structuredContent.prepared, 2);
});
test("tool and result validation errors identify fields without echoing submitted values", async (t) => {
  const { client } = await setup(t);
  const invalid = toolError(await client.callTool({ name: "publish", arguments: { operation_id: "bad", value: 12345 } }));
  assert.equal(invalid.code, "INVALID_TOOL_INPUT");
  assert.equal(invalid.operation_status, "not_started");
  assert.equal(invalid.retryable, true);
  assert.ok(invalid.fields.some((field) => field.path === "/value" && field.rule === "type"));
  assert.match(invalid.action, /correct/i);
  const result = toolError(await client.callTool({ name: "complete_task", arguments: { result: { value: 12345 } } }));
  assert.equal(result.code, "INVALID_RESULT");
  assert.ok(result.fields.some((field) => field.path === "/result/value" && field.rule === "type"));
  assert.doesNotMatch(JSON.stringify({ invalid, result }), /12345/);
});
test("registry accepts schema-only external tools without fingerprints or business keys", () => {
  const registry = new BusinessRegistry([{ type: "plain.writer", version: "1", inputSchema: {}, resultSchema: {}, tools: { publish: { inputSchema: {}, execute: async () => ({}) } } }]);
  assert.equal(registry.get("plain.writer").fingerprint, undefined);
  assert.equal(typeof registry.get("plain.writer").tools.publish.check, "function");
});
test("platform forwards caller fields without interpreting business keys", async (t) => {
  const { client, executions } = await setup(t);
  for (const channel of ["first", "changed"])
    assert.equal((await client.callTool({ name: "publish", arguments: { operation_id: "caller-owned", value: "business-key", channel } })).isError, undefined);
  assert.equal(executions(), 2);
});
test("completion waits for every in-flight call while repeated payloads execute independently", async (t) => {
  let release, started;
  const entered = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  t.after(() => release({ published: "once" }));
  const { client, executions } = await setup(t, { publishExecute: () => { started(); return pending; } });
  const first = client.callTool({ name: "publish", arguments: { value: "once" } });
  await entered;
  const error = toolError(await client.callTool({ name: "complete_task", arguments: { result: { value: "final" } } }));
  assert.equal(error.code, "OPERATIONS_PENDING");
  const second = client.callTool({ name: "publish", arguments: { value: "once" } });
  // Both calls remain in flight until their real effect resolves.
  await new Promise((resolve) => setImmediate(resolve));
  release({ published: "once" });
  assert.equal((await first).isError, undefined);
  assert.equal((await second).isError, undefined);
  assert.equal(executions(), 2);
  assert.equal((await client.callTool({ name: "complete_task", arguments: { result: { value: "final" } } })).isError, undefined);
});
test("each repeated local failure remains a known failed call", async (t) => {
  const { client, store } = await setup(t);
  for (let call = 0; call < 2; call++) {
    const error = toolError(await client.callTool({ name: "local_check", arguments: {} }));
    assert.equal(error.operation_status, "failed");
    assert.equal(error.retryable, true);
  }
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_operations WHERE status='failed'").get().n, 2);
});

test("tool calls are recorded independently for each run", async (t) => {
  const { client, store, url, executions } = await setup(t);
  const otherTask = store.accept("caller", { type: "test.echo", request_id: "another-request", input: {} });
  const otherRun = store.claim(otherTask.task_id);
  const otherClient = new Client({ name: "other-run", version: "1" });
  await otherClient.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${otherRun.token}` } },
  }));
  t.after(() => otherClient.close());
  const call = { name: "publish", arguments: { operation_id: "same-call-id", value: "same-business-key" } };
  assert.equal((await client.callTool(call)).isError, undefined);
  assert.equal((await otherClient.callTool(call)).isError, undefined);
  assert.equal(executions(), 2);
});

test("business error descriptions belong to the registered module and never expose exception text", async (t) => {
  const { client } = await setup(t, {
    localExecute: () => { throw new HttpError(400, "MODULE_INVALID_DOCUMENT", "upstream secret"); },
    describeError: (error) => error.code === "MODULE_INVALID_DOCUMENT" ? {
      code: error.code, message: "The document is invalid.", action: "Choose a valid document.", retryable: true,
      upstream: "must-not-forward",
    } : undefined,
  });
  const response = await client.callTool({ name: "local_check", arguments: {} });
  const error = toolError(response);
  assert.equal(error.code, "MODULE_INVALID_DOCUMENT");
  assert.equal(error.message, "The document is invalid.");
  assert.equal(error.action, "Choose a valid document.");
  assert.equal(error.operation_status, "failed");
  assert.doesNotMatch(JSON.stringify(response), /upstream secret|must-not-forward/);
});
test("safe runtime processor descriptions traverse MCP without a business error catalog", async (t) => {
  const { client } = await setup(t, {
    localExecute: () => {
      const error = new Error("private runtime response");
      error.publicToolError = { code: "CUSTOM_PROCESSOR_FAILURE", message: "Cannot process this document.", action: "Choose another document.", retryable: true };
      throw error;
    },
  });
  const response = await client.callTool({ name: "local_check", arguments: {} });
  assert.equal(toolError(response).code, "CUSTOM_PROCESSOR_FAILURE");
  assert.doesNotMatch(JSON.stringify(response), /private runtime/);
});
test("global errors do not recognize business-specific image codes", () => {
  const error = mcpError(new HttpError(400, "INVALID_IMAGE"));
  assert.equal(error.code, "TOOL_EXECUTION_FAILED");
  assert.doesNotMatch(JSON.stringify(error), /cover|image|word/i);
});
test("write tools may return module-owned MCP image content directly", async (t) => {
  const result = { content: [{ type: "image", mimeType: "image/jpeg", data: Buffer.from("fixture").toString("base64") }] };
  const { client, store } = await setup(t, { localContentResult: true, localExecute: () => result });
  const response = await client.callTool({ name: "local_check", arguments: {} });
  assert.deepEqual(response.content, result.content);
  assert.equal(store.db.prepare("SELECT status FROM agent_operations").get().status, "completed");
});

test("module error fields are copied as safe guidance without private properties", () => {
  const error = mcpError(new Error("private"), { module: { describeError: () => ({
    code: "DOCUMENT_FIELD_REQUIRED", message: "A field is missing.", action: "Correct the document.", retryable: true,
    fields: [{ path: "/title", rule: "required", message: "Provide a title.", value: "private submitted title" }],
  }) } });
  assert.deepEqual(error.fields, [{ path: "/title", rule: "required", message: "Provide a title." }]);
  assert.doesNotMatch(JSON.stringify(error), /private/);
});
test("malformed business descriptions fall back to fixed safe errors", () => {
  const error = mcpError(new Error("private"), { module: { describeError: () => ({ code: "BAD", message: "private", action: "bad", retryable: "yes" }) } });
  assert.equal(error.code, "TOOL_EXECUTION_FAILED");
  assert.doesNotMatch(JSON.stringify(error), /private/);
});


test("unknown outcomes preserve the module's retry and recovery guidance", async t => {
  for (const retryable of [true, false]) {
    const {client}=await setup(t, {
      publishExecute: () => { throw new Error("lost response"); },
      describeError: () => ({code:"MODULE_OUTCOME_UNKNOWN",message:"The operation response was lost.",retryable,
        action: retryable ? "This conversion is repeatable; call it again." : "Check the receipt with the lookup tool before another write."}),
    });
    const error=toolError(await client.callTool({name:"publish",arguments:{value:"document"}}));
    assert.equal(error.operation_status,"unknown");
    assert.equal(error.retryable,retryable);
    assert.equal(error.action,retryable ? "This conversion is repeatable; call it again." : "Check the receipt with the lookup tool before another write.");
  }
});
