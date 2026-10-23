import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestStore } from "../src/core/store.mjs";
import { BusinessRegistry } from "../src/core/registry.mjs";
import { createDeliveryWorker } from "../src/delivery/worker.mjs";

const definition = {
  type: "test.review",
  version: "1.0.0",
  prompt: "Review the supplied text and submit the final result.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  resultSchema: {
    type: "object",
    properties: { passed: { type: "boolean" } },
    required: ["passed"],
    additionalProperties: false,
  },
  normalizeInput: (x) => x,
  tools: {},
};
function setup(t, override = {}) {
  const registry = new BusinessRegistry([{ ...definition, ...override }]);
  const store = new RequestStore(":memory:", { registry });
  t.after(() => store.close());
  const accept = (request_id = "one", input = { text: "example" }) =>
    store.accept("client", { type: definition.type, request_id, input });
  return { store, registry, accept };
}
test("each accepted API request creates new work even with identical request id and input", async (t) => {
  const { store, accept } = setup(t);
  const task = accept();
  const run = store.claim(task.task_id);
  await store.complete(run.run_id, { passed: true });
  const same = accept();
  assert.equal(same.status, "queued");
  assert.notEqual(same.task_id, task.task_id);
  assert.notEqual(accept("one", { text: "changed" }).task_id, same.task_id);
  assert.equal(store.get(task.task_id).status, "completed");
});
test("module schemas reject invalid input before persisting a request", (t) => {
  const { store, accept } = setup(t);
  assert.throws(() => accept("bad", { text: 12 }), { code: "INVALID_INPUT" });
  assert.equal(store.queued().length, 0);
});
test("tool calls only track activity and repeated calls receive new identities", async t => {
  const {store,accept}=setup(t);
  const run=store.claim(accept().task_id);
  const first=store.beginOperation(run.run_id,"publish");
  await assert.rejects(store.complete(run.run_id,{passed:true}),{code:"OPERATIONS_PENDING"});
  store.finishOperation(first.operation_id);
  const second=store.beginOperation(run.run_id,"publish");
  assert.notEqual(first.operation_id,second.operation_id);
  store.finishOperation(second.operation_id);
  await store.complete(run.run_id,{passed:true});
  assert.throws(()=>store.beginOperation(run.run_id,"publish"),{code:"TASK_CLOSED"});
});
test("completion freezes writes, invalid result releases barrier, same receipt replays", async (t) => {
  let release;
  let started;
  const ready = new Promise((r) => (started = r));
  const { store, accept } = setup(t, {
    validateResult: async (result) => {
      started();
      await new Promise((r) => (release = r));
      return result;
    },
  });
  const run = store.claim(accept().task_id);
  await assert.rejects(store.complete(run.run_id, { passed: "bad" }), {
    code: "INVALID_RESULT",
  });
  assert.equal(store.get(run.task_id).status, "running");
  const pending = store.complete(run.run_id, { passed: true });
  await ready;
  assert.throws(() => store.beginOperation(run.run_id, "publish"), {
    code: "TASK_CLOSED",
  });
  release();
  const receipt = await pending;
  assert.deepEqual(await store.complete(run.run_id, { passed: true }), receipt);
  await assert.rejects(store.complete(run.run_id, { passed: false }), {
    code: "COMPLETION_CONFLICT",
  });
});
test("timeout racing validation wins once and cannot be overwritten by completion", async (t) => {
  let release, started;
  const ready = new Promise((r) => (started = r));
  const { store, accept } = setup(t, {
    validateResult: async (r) => {
      started();
      await new Promise((r) => (release = r));
      return r;
    },
  });
  const run = store.claim(accept().task_id);
  const completing = store.complete(run.run_id, { passed: true });
  await ready;
  assert.equal(store.fail(run.run_id, "TASK_TIMEOUT"), true);
  release();
  await assert.rejects(completing, { code: "TASK_CLOSED" });
  assert.equal(store.get(run.task_id).status, "failed");
});
test("task credentials authorize their own run and expire after receipt grace", async (t) => {
  const { store, accept } = setup(t);
  const first = store.claim(accept().task_id);
  const second = store.claim(accept("two").task_id);
  assert.equal(store.authenticate(first.token).run_id, first.run_id);
  assert.notEqual(store.authenticate(first.token).run_id, second.run_id);
  assert.throws(() => store.authenticate("invalid"), { code: "UNAUTHORIZED" });
  await store.complete(first.run_id, { passed: true });
  assert.equal(store.authenticate(first.token).receiptOnly, true);
  store.db
    .prepare("UPDATE agent_runs SET receipt_until=0 WHERE run_id=?")
    .run(first.run_id);
  assert.throws(() => store.authenticate(first.token), {
    code: "UNAUTHORIZED",
  });
});
test("reconciliation suspends ambiguous launches while retaining their identities", (t) => {
  const { store, accept } = setup(t);
  const run = store.claim(accept().task_id);
  store.beginOperation(run.run_id, "publish");
  store.reconcile();
  assert.equal(store.get(run.task_id).status, "suspended");
  assert.equal(store.get(run.task_id).error, null);
  assert.equal(store.queued().length, 1);
  assert.throws(() => store.authenticate(run.token), { code: "UNAUTHORIZED" });
  assert.equal(
    store.db.prepare("SELECT status FROM agent_operations").get().status,
    "unknown",
  );
});
test("queued requests use current implementation and configuration while retaining accepted version", (t) => {
  const { store, accept, registry } = setup(t);
  const task = accept();
  registry.get(definition.type).version = "2";
  registry.get(definition.type).prompt = "Changed prompt";
  store.configuration = { model: "different-model" };
  const run = store.claim(task.task_id);
  assert.ok(run.run_id);
  assert.equal(store.get(task.task_id).module_version, "1.0.0");
  assert.equal(run.fingerprint, undefined);
});
test("platform creates no image tables or image storage methods", (t) => {
  const { store } = setup(t);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  assert.equal(tables.includes("agent_artifacts"), false);
  assert.equal(tables.includes("agent_previews"), false);
  for (const method of ["addArtifact", "artifact", "createPreview", "previewSent", "hasPreview"])
    assert.equal(store[method], undefined);
});
test("unknown calls allow a final failed result while executing calls retain their barrier", async (t) => {
  const { store, accept } = setup(t);
  const run = store.claim(accept().task_id);
  const operation = store.beginOperation(run.run_id, "remote");
  await assert.rejects(store.complete(run.run_id, { passed: false }), { code: "OPERATIONS_PENDING" });
  store.unknownOperation(operation.operation_id);
  const receipt = await store.complete(run.run_id, { passed: false });
  assert.equal(receipt.accepted, true);
  assert.equal(store.get(run.task_id).result.passed, false);
});
test("delivery uses current module configuration and resumes legacy configuration-blocked rows", async (t) => {
  let calls = 0;
  const { store, accept } = setup(t, { delivery: { execute: async () => { calls++; return { status: "accepted" }; } } });
  const run = store.claim(accept().task_id);
  await store.complete(run.run_id, { passed: true });
  store.configuration = { model: "changed-after-completion" };
  store.db.prepare("UPDATE agent_deliveries SET status='blocked_configuration'").run();
  await createDeliveryWorker({ store, config: {} })();
  assert.equal(calls, 1);
  assert.equal(store.get(run.task_id).delivery.status, "accepted");
});
test("opening legacy storage retains image history and writes empty compatibility digest fields", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "agent-core-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "legacy.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE agent_artifacts(artifact_id TEXT PRIMARY KEY,metadata TEXT NOT NULL);
    CREATE TABLE agent_previews(preview_id TEXT PRIMARY KEY,served INTEGER);
    INSERT INTO agent_artifacts VALUES('historic','{"path":"old.jpg"}');
    INSERT INTO agent_previews VALUES('historic-preview',1);
    CREATE TABLE agent_requests(task_id TEXT PRIMARY KEY,client_id TEXT NOT NULL,request_id TEXT NOT NULL,type TEXT NOT NULL,module_version TEXT NOT NULL,fingerprint TEXT NOT NULL,input TEXT NOT NULL,execution_input TEXT NOT NULL,request_digest TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,config_digest TEXT NOT NULL);`);
  db.close();
  const registry = new BusinessRegistry([definition]);
  const store = new RequestStore(path, { registry });
  t.after(() => store.close());
  const task = store.accept("legacy", { type: definition.type, request_id: "new", input: { text: "new" } });
  assert.equal(store.raw(task.task_id).fingerprint, "");
  assert.equal(store.raw(task.task_id).config_digest, "");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_artifacts").get().n, 1);
  assert.equal(store.db.prepare("SELECT served FROM agent_previews").get().served, 1);
  assert.ok(store.claim(task.task_id));
});
test("generic delivery invokes its module once and never retries an unknown effect", async (t) => {
  let calls = 0;
  const { store, accept } = setup(t, {
    delivery: {
      execute: async () => {
        calls++;
        throw new Error("lost remote response");
      },
    },
  });
  const run = store.claim(accept().task_id);
  await store.complete(run.run_id, { passed: true });
  const deliver = createDeliveryWorker({ store, config: {} });
  await deliver();
  await deliver();
  assert.equal(calls, 1);
  assert.equal(store.get(run.task_id).delivery.status, "unknown");
});

test("completion receipt confirms acceptance and its durable delivery state", async (t) => {
  for (const delivery of [undefined, { execute: async () => ({ status: "accepted" }) }]) {
    const { store, accept } = setup(t, { delivery });
    const run = store.claim(accept().task_id);
    const receipt = await store.complete(run.run_id, { passed: true });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.task_status, "completed");
    assert.equal(receipt.delivery_status, delivery ? "pending" : "not_required");
    assert.equal(store.get(run.task_id).delivery.status, receipt.delivery_status);
    assert.deepEqual(await store.complete(run.run_id, { passed: true }), receipt);
  }
});
test("generic storage initializes only registered module adapters within core transactions", (t) => {
  const { store, accept } = setup(t, {
    initializeStorage({ db, transaction }) {
      db.exec("CREATE TABLE module_facts(value TEXT)");
      return { write: (value) => transaction(() => db.prepare("INSERT INTO module_facts VALUES(?)").run(value)) };
    },
    prepareRequest(input, { store }) {
      store.storageFor(definition.type).write(input.text);
      throw new Error("reject input");
    },
  });
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get(), undefined);
  assert.throws(() => accept(), /reject input/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM module_facts").get().n, 0);
});


test("fresh storage contains no unused request digests or operation replay fields", t=>{
  const {store,accept}=setup(t);const task=accept();
  assert.equal(Object.hasOwn(store.raw(task.task_id),"request_digest"),false);
  const columns=store.db.prepare("PRAGMA table_info(agent_operations)").all().map(x=>x.name);
  for(const name of ["operation_key","input_digest","result"])assert.equal(columns.includes(name),false,name);
});
test("a delivery module can request another wake without a special platform policy flag",async t=>{
  let calls=0;
  const {store,accept}=setup(t,{delivery:{execute:async()=>({status:++calls===1?"pending":"accepted"})}});
  const run=store.claim(accept().task_id);await store.complete(run.run_id,{passed:true});
  const deliver=createDeliveryWorker({store,config:{}});
  await deliver();assert.equal(store.get(run.task_id).delivery.status,"pending");
  await deliver();assert.equal(calls,2);assert.equal(store.get(run.task_id).delivery.status,"accepted");
  await deliver();assert.equal(calls,2);
});
