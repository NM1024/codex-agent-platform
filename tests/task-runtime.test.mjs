import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../src/runtime/codex.mjs";

class Rpc {
  calls = [];
  listeners = new Set();
  closed = false;
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "root" } };
    if (method === "turn/start") return { turn: { id: "initial" } };
    return {};
  }
  notify() {}
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(method, params) {
    for (const fn of this.listeners) fn({ method, params });
  }
  async close() {
    this.closed = true;
  }
}
async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "task-runtime-"));
  const rpc = new Rpc();
  let clientOptions, finish;
  const events = [];
  const exited = new Promise((r) => (finish = r));
  const runtime = new AgentRuntime({
    workspace: join(root, "workspace"),
    codexHome: join(root, "codex"),
    mcpUrl: "http://gateway:3006/mcp",
    model: "gpt-6.1-sol",
    taskTimeoutMs: 1000,
    closingTimeoutMs: 15,
    // Slot-reservation scenarios below intentionally use one slot; platform defaults have separate coverage.
    concurrency: 1,
    createClient: (options) => {
      clientOptions = options;
      return rpc;
    },
    onExit: (id, code, details) => {
      events.push({ id, code, details });
      finish();
    },
    ...overrides,
  });
  t.after(async () => {
    await runtime.stop();
    await rm(root, { force: true, recursive: true });
  });
  const run = {
    run_id: "00000000-0000-4000-8000-000000000001",
    task_id: "00000000-0000-4000-8000-000000000002",
    token: "task-only-secret",
    type: "test.review",
    package: {
      prompt: "Complete the entire batch and submit using MCP.",
      native: { imageGeneration: false, webSearch: false },
      tools: ["complete_task"],
    },
  };
  return {
    root,
    rpc,
    runtime,
    run,
    events,
    exited,
    options: () => clientOptions,
  };
}
test("one request starts exactly one root thread and one initial turn, subagents remain native", async (t) => {
  const { runtime, run, rpc, options } = await setup(t);
  await runtime.launch(run);
  const start = rpc.calls.find((x) => x.method === "thread/start").params;
  assert.equal(rpc.calls.filter((x) => x.method === "thread/start").length, 1);
  assert.equal(rpc.calls.filter((x) => x.method === "turn/start").length, 1);
  assert.equal(start.ephemeral, false);
  assert.equal(start.model, "gpt-6.1-sol");
  assert.equal(start.config["features.multi_agent"], true);
  assert.equal(start.config["features.shell_tool"], false);
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.config.mcp_servers.agent_task.default_tools_approval_mode, "approve");
  assert.equal(options().env.AGENT_TASK_MCP_TOKEN, run.token);
  assert.equal(options().env.RUNNER_TOKEN, undefined);
  assert.equal(options().env.PLATFORM_HTTP_TARGETS_JSON, undefined);
  assert.ok(!JSON.stringify(start).includes(run.token));
  await runtime.launch(run);
  assert.equal(rpc.calls.filter((x) => x.method === "turn/start").length, 1);
});

test('explicit model reasoning is forwarded to the task turn',async t=>{
  const {runtime,run,rpc}=await setup(t);
  const request=rpc.request.bind(rpc);
  rpc.request=async(method,params)=>method==='model/list'?{data:[{model:'fixture-model',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}:request(method,params);
  await runtime.launch({...run,execution:{model:'fixture-model',reasoningEffort:'high',taskTimeoutMs:1000,toolTimeoutMs:1000}});
  const turn=rpc.calls.find(call=>call.method==='turn/start').params;
  assert.equal(turn.effort,'high');
  assert.equal(turn.model,'fixture-model');
});
test("root exit without MCP completion reports missing result; child exit does not finish root", async (t) => {
  const { runtime, run, rpc, events, exited } = await setup(t);
  await runtime.launch(run);
  rpc.emit("turn/completed", {
    threadId: "child",
    turn: { id: "child-turn", status: "completed" },
  });
  assert.equal(events.length, 0);
  rpc.emit("turn/completed", {
    threadId: "root",
    turn: { id: "initial", status: "completed" },
  });
  await exited;
  assert.equal(events[0].id, run.run_id);
  assert.equal(events[0].code, "RESULT_NOT_SUBMITTED");
  assert.equal(rpc.closed, true);
});
test('failed turn persists its reason and final explanation with task credentials redacted',async t=>{
  const {runtime,run,rpc,events,exited}=await setup(t);await runtime.launch(run);
  rpc.emit('item/completed',{threadId:'root',item:{type:'agentMessage',text:'Could not finish the task.'}});
  rpc.emit('turn/completed',{threadId:'root',turn:{id:'initial',status:'failed',error:{message:'Connection rejected Bearer '+run.token}}});
  await exited;
  assert.equal(events[0].code,'CODEX_TURN_FAILED');
  assert.match(events[0].details.error_message,/Connection rejected/);
  assert.ok(!events[0].details.error_message.includes(run.token));
  assert.equal(events[0].details.last_agent_message,'Could not finish the task.');
});
test("completion signal lets current turn close and force reaps after bounded grace", {timeout: 2000}, async (t) => {
  const { runtime, run, rpc, events, exited } = await setup(t);
  await runtime.launch(run);
  runtime.completed(run.run_id);
  assert.equal(rpc.closed, false);
  await exited;
  assert.equal(rpc.closed, true);
  assert.equal(events[0].code, "COMPLETED");
  assert.equal(rpc.calls.filter((x) => x.method === "turn/start").length, 1);
});
test("launch intent survives transport retry without storing token or replaying a turn", async (t) => {
  const { runtime, run, rpc, root } = await setup(t);
  await runtime.launch(run);
  const marker = await readFile(
    join(root, "workspace", ".agent-runs", run.run_id, "launch.json"),
    "utf8",
  );
  assert.ok(!marker.includes(run.token));
  assert.ok(marker.includes("started"));
  await runtime.stop();
  const other = new AgentRuntime({
    workspace: join(root, "workspace"),
    codexHome: join(root, "codex"),
    createClient: () => rpc,
  });
  t.after(() => other.stop());
  const replay = await other.launch(run);
  assert.equal(replay.status, "suspended");
  assert.equal(rpc.calls.filter((x) => x.method === "turn/start").length, 1);
});

test("runner reserves its root slot before asynchronous process setup", async (t) => {
  const { runtime, run } = await setup(t);
  const starting = runtime.launch(run);
  await assert.rejects(
    runtime.launch({ ...run, run_id: "00000000-0000-4000-8000-000000000003" }),
    /RUNNER_BUSY/,
  );
  await starting;
});
test("startup recovery excludes launches and cannot delete an active run home", async (t) => {
  const { runtime, run } = await setup(t);
  const recovering = runtime.recover();
  await assert.rejects(runtime.launch(run), /RUNNER_RECOVERING/);
  await recovering;
  await runtime.launch(run);
  await assert.rejects(runtime.recover(), /RUNNER_ACTIVE/);
  assert.equal(runtime.active.has(run.run_id), true);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("pending readiness reserves capacity and duplicate launch shares one root slot", async (t) => {
  const { runtime, run, rpc } = await setup(t);
  const ready = deferred();
  const starting = runtime.launch(run, { beforeStart: () => ready.promise });
  assert.equal(runtime.launches.has(run.run_id), true);
  const duplicate = runtime.launch(run);
  await assert.rejects(runtime.launch({ ...run, run_id: "00000000-0000-4000-8000-000000000003" }), /RUNNER_BUSY/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(rpc.calls.length, 0);
  ready.resolve();
  const [first, second] = await Promise.all([starting, duplicate]);
  assert.deepEqual(second, first);
  assert.equal(rpc.calls.filter(({method}) => method === "turn/start").length, 1);
});

test("concurrent runs have independent clients and capacity counts active-launch union", async (t) => {
  const clients = [];
  const { runtime, run } = await setup(t, { concurrency: 2, createClient: () => {
    const rpc = new Rpc();
    const index = clients.push(rpc);
    const base = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      const result = await base(method, params);
      if (method === "thread/start") result.thread.id = "root-" + index;
      if (method === "turn/start") result.turn.id = "turn-" + index;
      return result;
    };
    return rpc;
  }});
  const secondRun = {...run, run_id: "00000000-0000-4000-8000-000000000003"};
  const [first, second] = await Promise.all([runtime.launch(run), runtime.launch(secondRun)]);
  assert.ok(first.thread_id.startsWith("root-"));
  assert.ok(second.thread_id.startsWith("root-"));
  assert.notEqual(first.thread_id, second.thread_id);
  assert.ok(first.turn_id.startsWith("turn-"));
  assert.notEqual(runtime.active.get(run.run_id).home, runtime.active.get(secondRun.run_id).home);
  await assert.rejects(runtime.launch({...run, run_id: "00000000-0000-4000-8000-000000000004"}), /RUNNER_BUSY/);
  const secondClient = runtime.active.get(secondRun.run_id).client;
  await runtime.end(run.run_id, "INTERRUPTED");
  assert.equal(secondClient.closed, false);
  assert.equal(runtime.active.has(secondRun.run_id), true);
  assert.equal(clients.every((rpc) => rpc.calls.filter(({method}) => method === "turn/start").length === 1), true);
});

test("launch lifecycle durably retains identifiers, completion and timestamps without credentials or prompts", async (t) => {
  const { runtime, run, root, rpc, events, exited } = await setup(t);
  const ack = await runtime.launch(run);
  const marker = join(root, "workspace", ".agent-runs", run.run_id, "launch.json");
  const started = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(ack.thread_id, "root");
  assert.equal(ack.turn_id, "initial");
  assert.equal(started.thread_id, "root");
  assert.equal(started.turn_id, "initial");
  assert.equal(started.completed, false);
  assert.ok(Date.parse(started.created_at));
  assert.ok(Date.parse(started.started_at));
  await runtime.completed(run.run_id);
  const closing = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(closing.completed, true);
  assert.equal(closing.status, "closing");
  rpc.emit("turn/completed", {threadId: "root", turn: {id: "initial", status: "completed"}});
  await exited;
  const endedText = await readFile(marker, "utf8");
  const ended = JSON.parse(endedText);
  assert.equal(ended.code, "COMPLETED");
  assert.equal(ended.completed, true);
  assert.equal(ended.thread_id, "root");
  assert.equal(ended.turn_id, "initial");
  assert.equal(ended.started_at, started.started_at);
  assert.ok(Date.parse(ended.ended_at));
  assert.equal(ended.updated_at, ended.ended_at);
  assert.equal(events[0].details.thread_id, "root");
  assert.equal(events[0].details.completed, true);
  assert.ok(!endedText.includes(run.token));
  assert.ok(!endedText.includes(run.package.prompt));
  assert.equal((await runtime.launch(run)).status, "completed");
});

test("recovery retains known root identifiers and completion evidence without replay", async (t) => {
  const { runtime, run, root, rpc } = await setup(t);
  await runtime.launch(run);
  // A separate runtime models restart; the old transport is closed first.
  await runtime.active.get(run.run_id).client.close();
  clearTimeout(runtime.active.get(run.run_id).timer);
  runtime.active.clear();
  const events = [];
  const restarted = new AgentRuntime({ workspace: join(root, "workspace"), codexHome: join(root, "codex"), onExit: (...args) => events.push(args) });
  t.after(() => restarted.stop());
  await restarted.recover();
  const saved = JSON.parse(await readFile(join(root, "workspace", ".agent-runs", run.run_id, "launch.json"), "utf8"));
  assert.equal(saved.thread_id, "root");
  assert.equal(saved.turn_id, "initial");
  assert.equal(saved.code, "SUSPENDED");
  assert.equal(saved.ended_at, null);
  assert.equal(events[0][2].thread_id, "root");
  assert.equal((await restarted.launch(run)).turn_id, "initial");
  assert.equal(rpc.calls.filter(({method}) => method === "turn/start").length, 1);
});

test("completion arriving during transport cleanup remains successful and leaves no closing timer", async (t) => {
  const closing = deferred();
  const entered = deferred();
  const rpc = new Rpc();
  rpc.close = async () => { entered.resolve(); await closing.promise; rpc.closed = true; };
  const { runtime, run, root, events } = await setup(t, {createClient: () => rpc});
  await runtime.launch(run);
  const state = runtime.active.get(run.run_id);
  const ending = runtime.end(run.run_id, "INTERRUPTED");
  await entered.promise;
  await runtime.completed(run.run_id);
  closing.resolve();
  await ending;
  assert.equal(events[0].code, "COMPLETED");
  assert.ok(state.timer._destroyed);
  const saved = JSON.parse(await readFile(join(root, "workspace", ".agent-runs", run.run_id, "launch.json"), "utf8"));
  assert.equal(saved.completed, true);
  assert.equal(saved.code, "COMPLETED");
});

test("a fast root completion retains turn id even when its event precedes turn-start response", async (t) => {
  const rpc = new Rpc();
  const base = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    const response = await base(method, params);
    if (method === "turn/start") rpc.emit("turn/completed", {threadId: "root", turn: {id: "initial", status: "completed"}});
    return response;
  };
  const { runtime, run, exited, events } = await setup(t, {createClient: () => rpc});
  await runtime.launch(run);
  await exited;
  assert.equal(events[0].details.turn_id, "initial");
});

test("an active run still awaiting launch ack occupies one capacity slot", async (t) => {
  const ack = deferred(), entered = deferred();
  const clients = [];
  const {runtime, run} = await setup(t, {concurrency: 2, createClient: () => {
    const rpc = new Rpc();
    const first = clients.length === 0;
    clients.push(rpc);
    const base = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      const response = await base(method, params);
      if (first && method === "turn/start") {entered.resolve(); await ack.promise;}
      return response;
    };
    return rpc;
  }});
  const first = runtime.launch(run);
  await entered.promise;
  assert.equal(runtime.active.has(run.run_id), true);
  assert.equal(runtime.launches.has(run.run_id), true);
  const second = await runtime.launch({...run, run_id: "00000000-0000-4000-8000-000000000003"});
  assert.equal(second.status, "running");
  await assert.rejects(runtime.launch({...run, run_id: "00000000-0000-4000-8000-000000000004"}), /RUNNER_BUSY/);
  ack.resolve();
  await first;
});

test("runtime HTTP reserves slots before readiness completes and reports busy explicitly", async (t) => {
  const {createRuntimeServer} = await import("../src/runtime/server.mjs");
  const {runtime, run} = await setup(t);
  const checking = deferred(), ready = deferred();
  let probes = 0;
  const registry = {forTask: () => ({version: "1", buildTask: () => run.package})};
  const server = createRuntimeServer({runtime, registry, config: {runnerToken: "internal", concurrency: 1}, probe: async () => {
    probes++;
    checking.resolve();
    await ready.promise;
    return {ready: true};
  }});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));});
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/internal/runs`, {method: "POST", headers: {authorization: "Bearer internal", "content-type": "application/json"}, body: JSON.stringify({...body, module_version: "1"})});
  const starting = post(run);
  await checking.promise;
  const busy = await post({...run, run_id: "00000000-0000-4000-8000-000000000003"});
  try {
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).error.code, "RUNNER_BUSY");
    assert.equal(probes, 1);
  } finally {
    ready.resolve();
    await starting;
  }
  const launched = await starting;
  assert.equal(launched.status, 202);
  assert.equal((await launched.json()).thread_id, "root");
});

test("cancellation while creating the root never sends an initial task afterwards", async (t) => {
  const thread = deferred(), entered = deferred();
  const rpc = new Rpc();
  const base = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    const response = await base(method, params);
    if (method === "thread/start") {entered.resolve(); await thread.promise;}
    return response;
  };
  const {runtime, run} = await setup(t, {createClient: () => rpc});
  const launch = runtime.launch(run);
  await entered.promise;
  await runtime.end(run.run_id, "INTERRUPTED");
  thread.resolve();
  await launch;
  assert.equal(rpc.calls.filter(({method}) => method === "turn/start").length, 0);
});

test("stop waits for an already-ending run to finish durable cleanup", async (t) => {
  const closing = deferred(), entered = deferred();
  const rpc = new Rpc();
  rpc.close = async () => {entered.resolve(); await closing.promise;};
  const {runtime, run} = await setup(t, {createClient: () => rpc});
  await runtime.launch(run);
  const ending = runtime.end(run.run_id, "INTERRUPTED");
  await entered.promise;
  let stopped = false;
  const stopping = runtime.stop().then(() => {stopped = true;});
  await new Promise((resolve) => setImmediate(resolve));
  try { assert.equal(stopped, false); } finally { closing.resolve(); await ending; await stopping; }
  assert.equal(runtime.active.size, 0);
});


test("failed final metadata write releases capacity and reports a safe flag without changing completion", async (t) => {
  const {runtime, run, root, events} = await setup(t, {closingTimeoutMs: 10000});
  await runtime.launch(run);
  await runtime.completed(run.run_id);
  await rm(join(root, "workspace", ".agent-runs", run.run_id), {recursive: true, force: true});
  await assert.doesNotReject(runtime.end(run.run_id, "COMPLETED"));
  assert.equal(runtime.active.size, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].code, "COMPLETED");
  assert.equal(events[0].details.completed, true);
  assert.equal(events[0].details.metadata_persisted, false);
  assert.equal(events[0].details.metadata_error, "RUNTIME_METADATA_WRITE_FAILED");
  assert.ok(!JSON.stringify(events).includes(root));
  await runtime.stop();
});

test("metadata writing recovers after an earlier write failed and retains known identifiers", async (t) => {
  const {runtime, run, root, events} = await setup(t, {closingTimeoutMs: 10000});
  await runtime.launch(run);
  const owned = join(root, "workspace", ".agent-runs", run.run_id);
  await rm(owned, {recursive: true, force: true});
  await assert.rejects(runtime.completed(run.run_id));
  await mkdir(owned, {recursive: true});
  await assert.doesNotReject(runtime.end(run.run_id, "COMPLETED"));
  const saved = JSON.parse(await readFile(join(owned, "launch.json"), "utf8"));
  assert.equal(saved.thread_id, "root");
  assert.equal(saved.turn_id, "initial");
  assert.equal(saved.completed, true);
  assert.equal(saved.metadata_persisted, true);
  assert.equal(saved.metadata_error, null);
  assert.equal(events[0].details.metadata_persisted, true);
});

async function runtimeHttp(t, runtime, module, config = {}) {
  const {createRuntimeServer} = await import("../src/runtime/server.mjs");
  const {RuntimeClient} = await import("../src/runtime/client.mjs");
  const server = createRuntimeServer({runtime, registry: {forTask: ({type}) => {
    assert.equal(type, "test.review");
    return module;
  }}, config: {runnerToken: "internal", ...config}, probe: async () => ({ready: true})});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));});
  return new RuntimeClient({url: `http://127.0.0.1:${server.address().port}`, token: "internal"});
}

test("runner builds a fresh task without a version freeze and delegates a module processor", async (t) => {
  const {runtime, run, rpc, root} = await setup(t);
  const {package: ignored, ...identity} = run;
  const input = {value: "accepted before module edit"};
  const client = await runtimeHttp(t, runtime, {
    version: "new", buildTask: (received) => ({...run.package, prompt: received.value}),
    processors: {echo: (body, {state, workspace}) => {
      assert.equal(state.run.run_id, run.run_id);
      assert.equal(workspace, join(root, "workspace"));
      return {value: body.value};
    }},
  }, {workspace: join(root, "workspace")});
  assert.equal((await client.launch({...identity, input})).status, "running");
  assert.equal(rpc.calls.find(({method}) => method === "turn/start").params.input[0].text, input.value);
  assert.deepEqual(await client.process({run_id: run.run_id, name: "echo", value: 42}), {value: 42});
  await runtime.completed(run.run_id);
  await assert.rejects(client.process({run_id: run.run_id, name: "echo"}), {code: "TASK_CLOSED"});
});

test("native image notifications do not audit images or affect task lifecycle", async (t) => {
  const {runtime, run, rpc, root} = await setup(t, {taskTimeoutMs: 10000});
  await runtime.launch(run);
  const owned = join(root, "workspace", ".agent-runs", run.run_id);
  // A blocked legacy audit target must be irrelevant to native protocol events.
  await mkdir(join(owned, "images.json"));
  rpc.emit("item/completed", {threadId: "child", item: {type: "imageGeneration", id: "image", status: "completed", savedPath: "/private/image.png"}});
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runtime.active.has(run.run_id), true);
  assert.equal(runtime.active.get(run.run_id).images, undefined);
});

test("runtime scopes are module supplied and native attachments are sent once", async (t) => {
  const {runtime, run, rpc, options, root} = await setup(t);
  run.package.inputAttachments = [{type: "localImage", path: join(root, "reference.png")}];
  let supplied;
  await runtime.launch(run, {scope: async (context) => {
    supplied = context;
    const {stat} = await import("node:fs/promises");
    assert.equal((await stat(context.workDir)).isDirectory(), true);
    assert.equal((await stat(context.home)).isDirectory(), true);
    return {readRoots: [context.workDir, join(context.home, "outputs")], referenceFiles: [join(root, "reference.png")]};
  }});
  assert.equal(supplied.run.run_id, run.run_id);
  assert.deepEqual(JSON.parse(options().env.AGENT_TASK_READ_ROOTS), [supplied.workDir, join(supplied.home, "outputs")]);
  assert.deepEqual(JSON.parse(options().env.AGENT_TASK_REFERENCE_FILES), [join(root, "reference.png")]);
  assert.deepEqual(rpc.calls.find(({method}) => method === "turn/start").params.input.slice(1), run.package.inputAttachments);
});

test("default runtime file scope grants only the current working directory", async (t) => {
  const {runtime, run, options} = await setup(t);
  await runtime.launch(run);
  assert.deepEqual(JSON.parse(options().env.AGENT_TASK_READ_ROOTS), [runtime.active.get(run.run_id).workDir]);
  assert.deepEqual(JSON.parse(options().env.AGENT_TASK_REFERENCE_FILES), []);
});

test("module processor errors cross HTTP as module supplied safe descriptions", async (t) => {
  const {runtime, run} = await setup(t);
  const description = {code: "CUSTOM_INPUT_REJECTED", message: "The selected input is unavailable.", action: "Choose another input.", retryable: false, fields: ["selection"]};
  const client = await runtimeHttp(t, runtime, {
    buildTask: () => run.package,
    processors: {fail: () => {throw new Error("secret /private/service-token");}},
    describeError: () => description,
  });
  await client.launch(run);
  await assert.rejects(client.process({run_id: run.run_id, name: "fail"}), (error) => {
    assert.deepEqual(error.publicToolError, description);
    assert.equal(error.message, description.message);
    assert.equal(error.effectUnknown, undefined);
    assert.equal(error.responseSettled, true);
    return true;
  });
  assert.equal(client.inspect, undefined);
});

test("task package edits do not freeze a previously launched identity or replay its turn", async (t) => {
  const {runtime, run, rpc} = await setup(t);
  await runtime.launch(run);
  const ack = await runtime.launch({...run, package: {...run.package, prompt: "Edited module prompt"}});
  assert.equal(ack.status, "running");
  assert.equal(rpc.calls.filter(({method}) => method === "turn/start").length, 1);
});

test("module scope failure releases the run home and records a terminal lifecycle", async (t) => {
  const {runtime, run, root, rpc} = await setup(t);
  await assert.rejects(runtime.launch(run, {scope: () => {throw new Error("SCOPE_UNAVAILABLE");}}), /SCOPE_UNAVAILABLE/);
  const {stat} = await import("node:fs/promises");
  await assert.rejects(stat(join(root, "codex", "runs", run.run_id)), {code: "ENOENT"});
  const saved = JSON.parse(await readFile(join(root, "workspace", ".agent-runs", run.run_id, "launch.json"), "utf8"));
  assert.equal(saved.status, "ended");
  assert.equal(saved.code, "CODEX_START_FAILED");
  assert.equal(runtime.active.size, 0);
  assert.equal(runtime.launches.size, 0);
  assert.equal(rpc.calls.length, 0);
});

test("tool file access follows generic read roots and exact reference files", async (t) => {
  const {allowedTool} = await import("../src/codex/tool-policy.mjs");
  const {writeFile, symlink} = await import("node:fs/promises");
  const {root} = await setup(t);
  const scopeRoot = join(root, "scope");
  await mkdir(scopeRoot);
  const local = join(scopeRoot, "image.png"), reference = join(root, "reference.png"), secret = join(root, "secret.png");
  await Promise.all([local, reference, secret].map((path) => writeFile(path, "image")));
  await symlink(secret, join(scopeRoot, "escape.png"));
  const scope = {readRoots: [scopeRoot], referenceFiles: [reference]};
  assert.equal(allowedTool("view_image", {path: local}, scope), true);
  assert.equal(allowedTool("view_image", {path: reference}, scope), true);
  assert.equal(allowedTool("view_image", {path: secret}, scope), false);
  assert.equal(allowedTool("view_image", {path: join(scopeRoot, "escape.png")}, scope), false);
  assert.equal(allowedTool("view_image", {path: local, environment_id: "other"}, scope), false);
});
