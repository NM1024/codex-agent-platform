import { createServer } from "node:http";
import { requireAuth, readJson, json, errorResponse } from "./http.mjs";
import { fault } from "./core/registry.mjs";
import { createMcpHandler } from "./mcp/server.mjs";
import {taskArtifacts} from "./core/task-results.mjs";

async function sendArtifact(res,store,registry,config,taskId,artifactId) {
  const row=store.raw(taskId);if(!row||!registry.catalog.readArtifact)throw fault('NOT_FOUND',404);
  const module=store.moduleFor(row);
  const artifact=module.readArtifact?await module.readArtifact(row,artifactId,{store,workspace:config.workspace}):await registry.catalog.readArtifact(store,taskId,artifactId);
  res.writeHead(200,{'content-type':artifact.mime,'content-disposition':`inline; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,'cache-control':'no-store','x-content-type-options':'nosniff'});
  return res.end(artifact.data);
}

export function createTaskApi({
  store,
  registry,
  dispatcher,
  config,
  runner = dispatcher.runner,
}) {
  const client = config.clientId ?? "default";
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://local");
      const path = url.pathname;
      if (req.method === "GET" && path === "/healthz")
        return json(res, 200, { alive: true });
      if (req.method === "GET" && path === "/readyz") {
        const state = await runner.ready();
        const requested = url.searchParams.get("type");
        const selected = requested
          ? (registry.get(requested).availability?.(state) ?? state)
          : state;
        const ready = store.ping() && selected.ready && !config.paused;
        return json(res, ready ? 200 : 503, {
          ready,
          reason: config.paused
            ? "EXECUTION_PAUSED"
            : (selected.reason ?? null),
          businesses: Object.fromEntries(
            [...registry.modules].map(([type, module]) => [
              type,
              module.availability?.(state) ?? state,
            ]),
          ),
        });
      }
      requireAuth(req, config.ingressToken);
      const artifactPath=path.match(/^\/v2\/tasks\/([a-f0-9-]{36})\/artifacts\/([a-f0-9-]{36})$/);
      if (req.method==='GET' && artifactPath) {
        if (!store.get(artifactPath[1],client) || !registry.catalog.readArtifact) throw fault('NOT_FOUND',404);
        return await sendArtifact(res,store,registry,config,artifactPath[1],artifactPath[2]);
      }
      if (req.method === "POST" && path === "/v2/tasks") {
        const task = store.accept(client, await readJson(req));
        void dispatcher.drain();
        return json(res, 202, task);
      }
      const routed=registry.routeFor(path);
      if (req.method==='POST' && routed) {
        const body=await readJson(req);
        if (!body || Object.keys(body).some(key=>!['request_id','input'].includes(key))) throw fault('INVALID_INPUT',400);
        const task=store.accept(client,{...body,type:routed.type});void dispatcher.drain();return json(res,202,task);
      }
      if (req.method === "GET" && /^\/v2\/tasks\/[a-f0-9-]{36}$/.test(path)) {
        const task = store.get(path.split("/").at(-1), client);
        if (!task) throw fault("NOT_FOUND", 404);
        const reason = dispatcher.blocked.get(task.task_id);
        return json(res, 200, {
          ...task,
          artifacts:taskArtifacts(store,store.raw(task.task_id)),
          ...(reason ? { blocked_reason: reason } : {}),
        });
      }
      for (const module of registry.modules.values())
        if (await module.routes?.({ req, res, url, store, dispatcher, config, client })) return;
      throw fault("NOT_FOUND", 404);
    } catch (error) {
      errorResponse(res, error);
    }
  });
}
export function createPrivateApi({
  store,
  registry,
  dispatcher,
  runner,
  config,
  operations,
}) {
  const mcp = createMcpHandler({
    store,
    registry,
    onComplete: (id) => dispatcher.completed(id),
    toolContext: { process: (body) => runner.process(body,store.executionSettings(body.run_id,body.generation)?.toolTimeoutMs) },
  });
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://private").pathname;
    if (path === "/mcp") return mcp(req, res);
    try {
      requireAuth(req, config.runnerToken);
      const artifact=path.match(/^\/internal\/artifacts\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/);
      if(req.method==='GET'&&artifact)return await sendArtifact(res,store,registry,config,artifact[1],artifact[2]);
      if (path==='/internal/admin' && req.method==='POST' && operations) {
        const body=await readJson(req);
        return json(res,200,await operations.execute(body.action,body.args));
      }
      if (path === "/internal/events" && req.method === "POST") {
        const event = await readJson(req);
        const codes = [
          "COMPLETED",
          "RESULT_NOT_SUBMITTED",
          "TASK_TIMEOUT",
          "INTERRUPTED",
          "CODEX_EXIT",
          "CODEX_TURN_FAILED",
          "CODEX_START_FAILED",
          "SUSPENDED",
          "CODEX_SESSION_UNAVAILABLE",
        ];
        if (typeof event.run_id !== "string" || !codes.includes(event.code))
          throw fault("INVALID_EVENT", 400);
        await dispatcher.event(event.run_id, event.code, event.details);
        return json(res, 200, { accepted: true });
      }
      throw fault("NOT_FOUND", 404);
    } catch (error) {
      errorResponse(res, error);
    }
  });
  server.requestTimeout = 200000;
  server.headersTimeout = 10000;
  return server;
}
