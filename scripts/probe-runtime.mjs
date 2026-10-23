// Protocol-only preflight. Creates an empty ephemeral thread and discovers a
// loopback MCP; never sends turn/start, generates images, or contacts callbacks.
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CodexRpcClient, filteredCodexEnv } from "../src/codex/rpc.mjs";
import { initialize } from "../src/codex/session.mjs";
import { runtimeConfig } from "../src/codex/config.mjs";

const directory = await mkdtemp(join(tmpdir(), "agent-runtime-probe-"));
const token = randomBytes(32).toString("hex");
let client;
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401);
    res.end();
    return;
  }
  const mcp = new Server(
    { name: "runtime-probe", version: "1" },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "probe",
        description: "Protocol discovery only.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  }));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.once("finish", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
});
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  client = new CodexRpcClient({
    env: {
      ...filteredCodexEnv(),
      CODEX_HOME: directory,
      HOME: directory,
      AGENT_TASK_MCP_TOKEN: token,
    },
    timeoutMs: 15000,
  });
  await initialize(client);
  const config = runtimeConfig(
    { native: { imageGeneration: false, webSearch: false }, tools: ["probe"] },
    `http://127.0.0.1:${server.address().port}/mcp`,
  );
  const thread = await client.request("thread/start", {
    model: process.env.CODEX_MODEL || "gpt-6.1-sol",
    cwd: directory,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    config,
  });
  const status = await client.request("mcpServerStatus/list", {
    threadId: thread.thread.id,
    serverName: "agent_task",
    detail: "toolsAndAuthOnly",
  });
  const discovered =
    status.data?.some((server) =>
      Object.values(server.tools ?? {}).some((tool) => tool.name === "probe"),
    ) === true;
  console.log(
    JSON.stringify({
      validation: "pinned-app-server-mcp",
      mcpDiscovered: discovered,
      modelTurns: 0,
    }),
  );
  if (!discovered) process.exitCode = 1;
} catch (error) {
  console.log(
    JSON.stringify({
      validation: "pinned-app-server-mcp",
      mcpDiscovered: false,
      modelTurns: 0,
      reason: error.message.startsWith("CODEX_")
        ? error.message
        : "PROTOCOL_PREFLIGHT_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  await client?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(directory, { force: true, recursive: true });
}
