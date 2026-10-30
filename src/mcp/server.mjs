import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readJson, errorResponse, json } from "../http.mjs";
import { fault } from "../core/registry.mjs";

import { mcpError, validationFields } from "./errors.mjs";

const output = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
export function createMcpHandler({
  store,
  registry,
  onComplete = () => {},
  toolContext = {},
}) {
  return async (req, res) => {
    let server, transport, completedRun;
    const afterFlush = [];
    try {
      if (new URL(req.url, "http://internal").pathname !== "/mcp")
        return json(res, 404, { error: { code: "NOT_FOUND" } });
      const credentials = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        if (req.rawHeaders[i].toLowerCase() === "authorization")
          credentials.push(req.rawHeaders[i + 1]);
      if (credentials.length !== 1 || !credentials[0].startsWith("Bearer "))
        throw fault("UNAUTHORIZED", 401);
      const run = store.authenticate(credentials[0].slice(7));
      if (req.headers.origin) throw fault("ORIGIN_DENIED", 403);
      if (req.method !== "POST")
        return json(res, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
      const body = await readJson(req);
      const module = store.moduleFor(run);
      server = new Server(
        { name: "agent-task-business", version: "2.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          ...(!run.receiptOnly
            ? Object.entries(module.tools).map(([name, tool]) => ({
                name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              }))
            : []),
          {
            name: "complete_task",
            description:
              "Validate and commit the complete final business result. Correct validation errors yourself and call again. Only a successful receipt completes this task.",
            inputSchema: {
              type: "object",
              properties: { result: module.resultSchema },
              required: ["result"],
              additionalProperties: false,
            },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        let operationStatus = "not_started", fields;
        try {
          const current = store.authenticate(credentials[0].slice(7));
          const { name, arguments: args = {} } = request.params;
          if (name === "complete_task") {
            if (
              !args ||
              Array.isArray(args) ||
              Object.keys(args).length !== 1 ||
              !Object.hasOwn(args, "result")
            )
              throw fault("INVALID_RESULT", 400);
            if (!current.receiptOnly && !module.checkResult(args.result)) {
              fields = validationFields(module.checkResult.errors, "/result");
              throw fault("INVALID_RESULT", 400);
            }
            const receipt = await store.complete(current.run_id, args.result, current.generation);
            completedRun = current.run_id;
            return output(receipt);
          }
          if (
            current.receiptOnly ||
            !["dispatching", "running"].includes(current.status)
          )
            throw fault("TASK_CLOSED");
          const tool = module.tools[name];
          if (!Object.hasOwn(module.tools, name) || !tool)
            throw fault("TOOL_NOT_ALLOWED", 403);
          if (!tool.check(args)) {
            fields = validationFields(tool.check.errors);
            throw fault("INVALID_TOOL_INPUT", 400);
          }
          const context = {
            ...store.context,
            ...toolContext,
            afterFlush: (callback) => afterFlush.push(callback),
            store,
            runId: current.run_id,
            generation:current.generation,
            taskId: current.task_id,
            input: JSON.parse(current.execution_input),
          };
          if (context.process) {
            const process = context.process;
            context.process = body => process({...body,generation:current.generation});
          }
          if (tool.readOnly) {
            const result = await tool.execute(args, context);
            return tool.contentResult ? result : output(result);
          }
          // Each transport call is an independent platform invocation. Modules own
          // any business-level idempotency at the actual effect boundary.
          const operation = store.beginOperation(current.run_id, name);
          try {
            const result = await tool.execute(args, {
              ...context,
              operationId: operation.operation_id,
            });
            store.finishOperation(operation.operation_id);
            return tool.contentResult ? result : output(result);
          } catch (error) {
            if (tool.effect === "local" && error?.effectUnknown !== true) {
              operationStatus = "failed";
              store.failLocalOperation(operation.operation_id);
            } else {
              operationStatus = "unknown";
              store.unknownOperation(operation.operation_id);
            }
            throw error;
          }
        } catch (error) {
          const description=mcpError(error, { module, operationStatus, fields });
          store.recordToolError(run,request.params.name,description);
          return { ...output({ error: description }), isError: true };
        }
      });
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.once("finish", () => {
        for (const callback of afterFlush) {
          try {
            callback();
          } catch {}
        }
        // Never interrupt the Agent before its successful MCP receipt was flushed.
        if (completedRun)
          Promise.resolve(onComplete(completedRun)).catch(() => {});
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      res.once("close", () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) errorResponse(res, error);
      else res.destroy();
      await transport?.close().catch(() => {});
      await server?.close().catch(() => {});
    }
  };
}
