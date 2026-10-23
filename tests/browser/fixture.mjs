import { createApplication } from "../../src/application.mjs";
import { RequestStore } from "../../src/core/store.mjs";
import { OperationsService } from "../../src/operations/service.mjs";
import { ManagerStore } from "../../src/manager/store.mjs";
import { AdminAuth } from "../../src/manager/auth.mjs";
import { createManagerConfiguration } from "../../src/manager/configuration.mjs";
import { createManagerOperations } from "../../src/manager/operations.mjs";
import { createManagerServer } from "../../src/manager/server.mjs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
const workspace = await mkdtemp(join(tmpdir(), "console-browser-"));
const app = createApplication("gateway", {
  INGRESS_TOKEN: "local-fixture-ingress",
  RUNNER_TOKEN: "local-fixture-internal",
  WORKSPACE_DIR: workspace,
});
const business = new RequestStore(":memory:", { registry: app.registry }),
  configuration = app.configuration(business);
configuration.update("execution", { paused: true });
const dispatcher = { drain: async () => {}, blocked: new Map() },
  runner = {
    ready: async () => ({ ready: false, reason: "CHATGPT_LOGIN_REQUIRED" }),
    configure: async (value) => value,
  };
const platform = new OperationsService({
  ...app,
  store: business,
  configuration,
  runner,
  dispatcher,
});
const completed = business.accept("default", {
  type: "content.review",
  request_id: "article-review-2026-001",
  input: { content: "A sample article for the acceptance test." },
});
const active = business.claim(completed.task_id);
const state = {
  run: active,
  owned: join(workspace, ".agent-runs", active.run_id),
  workDir: join(workspace, "work"),
  home: join(workspace, "home"),
};
await mkdir(state.workDir, { recursive: true });
const processArtifact = (body) =>
  app.registry.catalog.processors[body.name](body, { state, workspace });
const context = {
  store: business,
  runId: active.run_id,
  taskId: active.task_id,
  process: processArtifact,
};
await app.registry.catalog.tools.write_text_artifact.execute(
  { filename: "review.txt", text: "Synthetic downloadable review." },
  context,
);
const source = join(state.workDir, "fixture.png");
await sharp({
  create: { width: 320, height: 180, channels: 3, background: "#a2bdad" },
})
  .png()
  .toFile(source);
await app.registry.catalog.tools.register_image.execute(
  { source_path: source },
  context,
);
await business.complete(active.run_id, {
  approved: true,
  reasons: ["内容清晰，未发现需要修改的问题。"],
});
const failed = business.accept("default", {
  type: "content.review",
  request_id: "article-review-2026-002",
  input: { content: "A synthetic failure sample." },
});
business.fail(business.claim(failed.task_id).run_id, "CODEX_TURN_FAILED");
for (let n = 0; n < 3; n++)
  business.accept("default", {
    type: "content.review",
    request_id: "queued-" + n,
    input: { content: "Synthetic queued article " + n },
  });
const schedule = platform.schedules.save({
  name: "每日运行巡检",
  kind: "inspection",
  cron: "0 9 * * *",
  timezone: "Asia/Shanghai",
  message: "检查队列和失败记录",
  enabled: false,
});
const store = new ManagerStore(":memory:"),
  auth = new AdminAuth(store.db);
await auth.initialize("local-browser-password");
const agent = {
  model: "gpt-6.1-sol",
  timeoutMs: 2400000,
  toolTimeoutMs: 180000,
  enqueue(id, text) {
    const m = store.enqueue(id, text);
    store.markRunning(m.id);
    store.finish(
      m,
      null,
      '# 运行报告\n\n**队列**\n\n本地验收：系统中有 3 个任务等待处理，1 个历史失败。\n\n```js\nconst count = 3;\n```\n\n| 等待 |\n| --- |\n| 3 |\n\n[文档](https://example.com/docs) [危险](javascript:alert(1))\n\n![远程图片](https://example.com/tracking.png)\n\n<img src=x onerror="window.injected=true">',
    );
    return m;
  },
};
const settings = createManagerConfiguration({ store, agent, auth }),
  metrics = {
    sample: async () => ({
      sampled_at: Date.now(),
      host: { available: false },
      container: {},
      disk: {},
    }),
  };
const operations = createManagerOperations({
  models:async()=>({models:[{model:'gpt-6.1-sol',displayName:'Fixture Default',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},{model:'fixture-fast',displayName:'Fixture Fast',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}),
  client: {
    execute: (...args) => platform.execute(...args),
    async artifact(taskId, id) {
      const file = await app.registry.catalog.readArtifact(
        business,
        taskId,
        id,
      );
      return new Response(file.data, {
        headers: { "content-type": file.mime },
      });
    },
  },
  store,
  metrics,
  configuration: settings,
  auth,
});
const server = createManagerServer({ store, agent, auth, operations, metrics });
await new Promise((r) =>
  server.listen(Number(process.env.CONSOLE_TEST_PORT ?? 4317), "127.0.0.1", r),
);
console.log("Synthetic browser test server ready");
process.on("SIGTERM", () =>
  server.close(async () => {
    store.close();
    business.close();
    await rm(workspace, { recursive: true, force: true });
    process.exit(0);
  }),
);
