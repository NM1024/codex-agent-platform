import { createServer } from "node:http";
import { requireAuth, readJson, json, errorResponse } from "../http.mjs";
import { fault } from "../core/registry.mjs";
import { ResourceSampler } from '../observability/resources.mjs';
import Ajv from 'ajv';
import {executionProperties} from '../configuration/execution.mjs';
const settingsProperties=Object.fromEntries(['concurrency','model','taskTimeoutMs','toolTimeoutMs'].map(key=>[key,executionProperties[key]]));
const checkSettings=new Ajv({strict:true}).compile({type:'object',properties:settingsProperties,additionalProperties:false});

export function createRuntimeServer({ runtime, registry, config, probe, onRestart }) {
  const metrics=new ResourceSampler({diskPath:config.workspace ?? '/workspace'});
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://runner").pathname;
      if (req.method === "GET" && path === "/healthz")
        return json(res, 200, { alive: true });
      requireAuth(req, config.runnerToken);
      if(req.method==='GET'&&path==='/internal/metrics')return json(res,200,await metrics.sample());
      if (req.method === "GET" && path === "/readyz")
        return json(res, 200, runtime.closed || runtime.recovering ? {ready: false, reason: runtime.closed ? "RUNNER_STOPPING" : "RUNNER_RECOVERING"} : await probe());
      if (req.method === "GET" && path === "/internal/active")
        return json(res, 200, {
          details: [...new Set([...runtime.active.keys(), ...runtime.launches.keys()])].map(id => {
            const state = runtime.active.get(id);
            const pending = runtime.launches.get(id);
            const {generation,status,thread_id,turn_id,started_at,completed,execution} = state?.record ?? {};
            return {run_id:id,generation:generation ?? pending?.generation ?? 0,status,thread_id,turn_id,started_at,completed,execution:execution ?? pending?.execution};
          }),
          runs: [
            ...new Set([...runtime.active.keys(), ...runtime.launches.keys()]),
          ],
        });
      if (req.method !== "POST") throw fault("NOT_FOUND", 404);
      const body = await readJson(req);
      if (path==='/internal/config') {
        if(!checkSettings(body))throw fault('INVALID_CONFIG',400);
        Object.assign(runtime,body);return json(res,200,Object.fromEntries(Object.keys(settingsProperties).map(key=>[key,runtime[key]])));
      }
      if (path==='/internal/restart') {
        if (!onRestart) throw fault('RESTART_UNAVAILABLE',503);
        res.once('finish',()=>setTimeout(()=>onRestart(),100));
        return json(res,200,{accepted:true,status:'restart_requested'});
      }
      if (path === "/internal/runs") {
        const module = registry.forTask(body);
        const expected = await module.buildTask(body.input);
        const {run_id, task_id, type, input, token, definition, execution, generation = 0, resume = false} = body;
        if(execution!==undefined&&(!checkSettings(execution)||Object.hasOwn(execution,'concurrency')))throw fault('INVALID_CONFIG',400);
        const run = {run_id, task_id, type, input, token, definition, generation, resume,execution};
        const launched = await runtime.launch({ ...run, package: expected }, {
          scope: module.runtimeScope?.bind(module),
          beforeStart: async () => {
            const state = await probe();
            const available = module.availability?.(state, config) ?? state;
            if (!available.ready)
              throw fault(available.reason ?? "RUNTIME_NOT_READY", 503);
          },
        });
        return json(res, 202, launched);
      }
      if (path === "/internal/completed") {
        await runtime.completed(body.run_id);
        return json(res, 200, { accepted: true });
      }
      if (path === "/internal/suspend") {
        await runtime.end(body.run_id, "SUSPENDED");
        return json(res, 200, { accepted: true });
      }
      if (path === "/internal/cancel") {
        await runtime.end(body.run_id, "INTERRUPTED");
        return json(res, 200, { accepted: true });
      }
      if (path === "/internal/processor") {
        const state = runtime.active.get(body.run_id);
        if (!state || state.completed || state.ending || (body.generation ?? 0) !== (state.run.generation ?? 0))
          throw fault("TASK_CLOSED");
        const module = registry.forTask(state.run);
        const processor = Object.hasOwn(module.processors ?? {}, body.name)
          ? module.processors[body.name] : null;
        if (typeof processor !== "function") throw fault("PROCESSOR_NOT_ALLOWED", 403);
        const pending = Promise.resolve().then(() => processor(body, {state, workspace: config.workspace}));
        state.processors ??= new Set();
        state.processors.add(pending);
        try {
          return json(res, 200, await pending);
        } catch (error) {
          const description = module.describeError?.(error);
          if (description) return json(res, 400, {error: description});
          throw error;
        } finally { state.processors.delete(pending); }
      }
      throw fault("NOT_FOUND", 404);
    } catch (error) {
      if (["RUNNER_BUSY", "RUNNER_RECOVERING", "RUNNER_STOPPING", "CODEX_SESSION_UNAVAILABLE", "CODEX_RESUME_FAILED"].includes(error.message))
        error = fault(error.message, 503);
      else if (error.message === "RUN_CONFLICT") error = fault("RUN_CONFLICT");
      else if (error.message === "INVALID_RUN") error = fault("INVALID_RUN", 400);
      errorResponse(res, error);
    }
  });
}
