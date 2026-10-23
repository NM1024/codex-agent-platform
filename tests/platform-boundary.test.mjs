import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readRegular } from "../src/files.mjs";
import { join, dirname, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const service = fileURLToPath(new URL("..", import.meta.url));
const source = join(service, "src");
const entries = ["api.mjs", "config.mjs", "core/store.mjs", "core/dispatcher.mjs", "mcp/server.mjs", "runtime/server.mjs", "runtime/codex.mjs", "runtime/client.mjs", "delivery/worker.mjs"];

test("generic bounded file reader reports a file error without image business semantics", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-generic-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "empty.txt"), "");
  await assert.rejects(readRegular(directory, join(directory, "empty.txt")), { message: "INVALID_FILE" });
});

test("foundation dependency graph has no concrete business or image processor dependency", async () => {
  const seen = new Set();
  async function visit(path) {
    if (seen.has(path)) return;
    seen.add(path);
    const name = relative(source, path);
    assert.ok(!/^(business\/|processors\/|image\.mjs$|application\.mjs$)/.test(name), `Foundation imports concrete implementation: ${name}`);
    const text = await readFile(path, "utf8");
    for (const [, specifier] of text.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g))
      await visit(resolve(dirname(path), specifier));
  }
  for (const entry of entries) await visit(join(source, entry));
});

test("a foundation-only installation runs an independent text task through Codex transport and MCP", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-foundation-only-"));
  let store, runtime, dispatcher;
  const servers = [];
  t.after(async () => {
    await dispatcher?.stop(); await runtime?.stop();
    for (const server of servers) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    store?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const isolated = join(directory, "src");
  await cp(source, isolated, { recursive: true, filter: (path) => {
    const name = relative(source, path);
    return !/^(business(?:\/|$)|processors(?:\/|$)|image\.mjs$|application\.mjs$|main-)/.test(name);
  } });
  await symlink(join(service, "node_modules"), join(directory, "node_modules"), "dir");
  const load = (path) => import(pathToFileURL(join(isolated, path)).href);
  const [{ RequestStore }, { BusinessRegistry }, { Dispatcher }, { createTaskApi, createPrivateApi }, { AgentRuntime }, { createRuntimeServer }, { RuntimeClient }] = await Promise.all([
    load("core/store.mjs"), load("core/registry.mjs"), load("core/dispatcher.mjs"), load("api.mjs"), load("runtime/codex.mjs"), load("runtime/server.mjs"), load("runtime/client.mjs"),
  ]);
  const module = {
    type: "test.text", version: "1", inputSchema: { type: "object" }, resultSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, normalizeInput: (x) => x,
    buildTask: () => ({ prompt: "Uppercase the supplied text using its tool, then submit it.", native: {}, tools: ["uppercase", "complete_task"], inputAttachments: [] }),
    processors: { uppercase: async (body, { state }) => { assert.equal(state.run.type, "test.text"); return { value: body.text.toUpperCase() }; } },
    tools: { uppercase: { description: "Uppercase task text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, execute: (args, ctx) => ctx.process({ run_id: ctx.runId, name: "uppercase", text: args.text }) } },
  };
  const registry = new BusinessRegistry([module]);
  const config = { runnerToken: "local-runner", ingressToken: "local-ingress", workspace: directory, concurrency: 2, taskTimeoutMs: 5000 };
  store = new RequestStore(":memory:", { registry });
  const calls = [];
  let done, failure;
  const finished = new Promise((resolve, reject) => { done = resolve; failure = reject; });
  runtime = new AgentRuntime({ workspace: directory, codexHome: join(directory, "empty-auth"), concurrency: 2,
    onExit: (id, code, details) => dispatcher.event(id, code, details),
    createClient: ({ env }) => {
      const listeners = new Set();
      let mcpUrl;
      return { notify() {}, async close() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, async request(method, params) {
        calls.push(method);
        if (method === "thread/start") { mcpUrl = params.config.mcp_servers.agent_task.url; return { thread: { id: "text-root" } }; }
        if (method === "turn/start") {
          setImmediate(async () => {
            const client = new Client({ name: "text-agent", version: "1" });
            try {
              await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${env.AGENT_TASK_MCP_TOKEN}` } } }));
              const upper = await client.callTool({ name: "uppercase", arguments: { text: "hello" } });
              assert.ok(!upper.isError, JSON.stringify(upper));
              const value = upper.structuredContent ?? JSON.parse(upper.content[0].text);
              const receipt = await client.callTool({ name: "complete_task", arguments: { result: value } });
              assert.ok(!receipt.isError, JSON.stringify(receipt));
              for (const listener of listeners) listener({ method: "turn/completed", params: { threadId: "text-root", turn: { id: "text-turn", status: "completed" } } });
              done();
            } catch (error) { failure(error); } finally { await client.close(); }
          });
          return { turn: { id: "text-turn" } };
        }
        return {};
      } };
    },
  });
  async function listen(server) { servers.push(server); await new Promise((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${server.address().port}`; }
  const runner = new RuntimeClient({ url: await listen(createRuntimeServer({ runtime, registry, config, probe: async () => ({ ready: true }) })), token: config.runnerToken });
  store.context = { workspace: directory, process: (body) => runner.process(body) };
  dispatcher = new Dispatcher({ store, registry, runner, config });
  runtime.mcpUrl = await listen(createPrivateApi({ store, registry, dispatcher, runner, config })) + "/mcp";
  const url = await listen(createTaskApi({ store, registry, dispatcher, runner, config }));
  const response = await fetch(url + "/v2/tasks", { method: "POST", headers: { authorization: "Bearer local-ingress", "content-type": "application/json" }, body: JSON.stringify({ type: module.type, request_id: "repeatable", input: { text: "hello" } }) });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  await dispatcher.drain();
  await Promise.race([finished, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Text task did not finish")), 5000); timer.unref(); })]);
  assert.deepEqual(store.get(accepted.task_id).result, { value: "HELLO" });
  assert.equal(calls.filter((x) => x === "thread/start").length, 1);
  assert.equal(calls.filter((x) => x === "turn/start").length, 1);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  assert.ok(!tables.some((name) => /preview|artifact|generation|^tasks$/.test(name)));
});
