import { createApplication } from "./application.mjs";
import { safeDirectory } from "./files.mjs";
import { probeWithProcess } from "./codex/session.mjs";
import { AgentRuntime } from "./runtime/codex.mjs";
import { createRuntimeServer } from "./runtime/server.mjs";
import { EventOutbox } from "./runtime/events.mjs";

try {
  const { config, registry } = createApplication("runner");
  const codexHome = process.env.CODEX_HOME ?? "/codex";
  await safeDirectory(codexHome);
  await safeDirectory(config.workspace);
  const outbox = new EventOutbox({
    workspace: config.workspace,
    send: async (event) => {
      const res = await fetch(
        new URL("/internal/events", config.gatewayInternalUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.runnerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        },
      );
      await res.body?.cancel();
      if (!res.ok) throw new Error("EVENT_DELIVERY_FAILED");
    },
  });
  const runtime = new AgentRuntime({
    workspace: config.workspace,
    codexHome,
    model: config.model,
    taskTimeoutMs: config.taskTimeoutMs,
    toolTimeoutMs: config.toolTimeoutMs,
    concurrency: config.concurrency,
    mcpUrl: new URL("/mcp", config.gatewayInternalUrl).href,
    onExit: (id, code, details) => outbox.publish(id, code, details),
  });
  let cached,
    expires = 0,
    inflight;
  const probe = async () => {
    if (runtime.active.size && cached) return cached;
    if (cached && Date.now() < expires) return cached;
    if (!inflight)
      inflight = probeWithProcess({ requireImage: false, timeoutMs: 10000 })
        .then((value) => {
          cached = value;
          expires = Date.now() + 15000;
          return value;
        })
        .finally(() => {
          inflight = null;
        });
    return inflight;
  };
  await runtime.recover();
  const server = createRuntimeServer({ runtime, registry, config, probe, onRestart:()=>void stop().then(()=>process.exit(0)) });
  await new Promise((r) => server.listen(config.port, "0.0.0.0", r));
  console.log(
    JSON.stringify({
      service: "runner",
      event: "listening",
      port: config.port,
    }),
  );
  void outbox.flush();
  let closing = false;
  async function stop() {
    if (closing) return;
    closing = true;
    await runtime.stop();
    await outbox.stop();
    await new Promise((r) => server.close(r));
  }
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
} catch (error) {
  console.error(
    JSON.stringify({
      service: "runner",
      event: "startup_failed",
      reason:
        /^(Missing or invalid configuration:|Invalid configuration:)/.test(
          error.message,
        )
          ? error.message
          : "STORAGE_OR_CONFIGURATION_FAILURE",
    }),
  );
  process.exitCode = 1;
}
