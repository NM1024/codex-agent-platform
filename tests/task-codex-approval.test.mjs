import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CodexRpcClient, filteredCodexEnv } from "../src/codex/rpc.mjs";
import { initialize } from "../src/codex/session.mjs";
import { runtimeConfig } from "../src/codex/config.mjs";

// Actual pinned Codex approval engine, local fake Responses API, and real MCP.
// No ChatGPT auth, OpenAI requests, real model, images, or business callbacks.
test("pinned Codex executes task MCP writes under never approval without prompts", { timeout: 30000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "codex-mcp-approval-"));
  const calls = [], requests = [], approvalRequests = [];
  const tools = ["prepare_cover", "complete_task"];
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/responses") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      const index = requests.length - 1;
      const events = index < tools.length ? [{
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call-" + index,
          namespace: "mcp__agent_task", name: tools[index], arguments: "{}" },
      }] : [];
      events.push({ type: "response.completed", response: { id: "response-" + index,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""));
      return;
    }
    if (req.url !== "/mcp" || req.headers.authorization !== "Bearer local-fixture-token") {
      res.writeHead(404); res.end(); return;
    }
    const mcp = new Server({ name: "approval-fixture", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(name => ({
      name, description: "Fixture write tool with no read-only annotations.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    })) }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      calls.push(request.params.name);
      return { content: [{ type: "text", text: "fixture write accepted" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once("finish", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  let client;
  t.after(async () => {
    await client?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  client = new CodexRpcClient({
    command: fileURLToPath(new URL("../node_modules/.bin/codex", import.meta.url)), cwd: home,
    env: { ...filteredCodexEnv(), HOME: home, CODEX_HOME: home, NO_PROXY: "127.0.0.1,localhost",
      AGENT_TASK_MCP_TOKEN: "local-fixture-token" },
  });
  await initialize(client);
  const config = runtimeConfig({ native: {}, tools }, base + "/mcp");
  const thread = await client.request("thread/start", {
    model: "gpt-6.1-sol", cwd: home, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
    config: { ...config, model_provider: "local_fixture", model_providers: { local_fixture: {
      name: "Local offline test", base_url: base + "/v1", wire_api: "responses",
      requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0,
    } } },
  });
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  client.subscribe(message => {
    if (message.id !== undefined) approvalRequests.push(message.method);
    if (message.method === "turn/completed" && message.params.threadId === thread.thread.id) finish();
  });
  await client.request("turn/start", { threadId: thread.thread.id,
    input: [{ type: "text", text: "Execute the local fixture writes, then finish." }] });
  await ended;
  assert.deepEqual(calls, tools, JSON.stringify(requests.flatMap(request => request.input ?? [])
    .filter(item => item.type === "function_call_output")));
  assert.deepEqual(approvalRequests, []);
  assert.equal(requests.length, 3);
});
