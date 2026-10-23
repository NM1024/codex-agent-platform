import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CodexRpcClient, filteredCodexEnv } from "../src/codex/rpc.mjs";
import { probeCodex } from "../src/codex/session.mjs";
const fixture = fileURLToPath(
  new URL("./fixtures/rpc-child.mjs", import.meta.url),
);
test("RPC associates interleaved responses and split frames", async () => {
  const c = new CodexRpcClient({
    command: process.execPath,
    args: [fixture],
    timeoutMs: 1000,
  });
  try {
    assert.deepEqual(
      await Promise.all([
        c.request("slow", { a: 1 }),
        c.request("fast", { b: 2 }),
        c.request("fast", { c: 3 }),
      ]),
      [{ a: 1 }, { b: 2 }, { c: 3 }],
    );
  } finally {
    await c.close();
  }
});
test("RPC closes all pending requests on process exit", async () => {
  const c = new CodexRpcClient({ command: process.execPath, args: [fixture] });
  const a = c.request("hang", {});
  const b = c.request("exit", {});
  await Promise.all([
    assert.rejects(a, /CODEX_EXIT/),
    assert.rejects(b, /CODEX_EXIT/),
  ]);
  await c.close();
});
test("RPC timeout and close do not expose raw stderr", async () => {
  const c = new CodexRpcClient({
    command: process.execPath,
    args: [fixture],
    timeoutMs: 30,
  });
  await assert.rejects(c.request("hang", {}), /CODEX_TIMEOUT/);
  await c.close();
});
test("probe requires ChatGPT and image generation and sanitizes account", async () => {
  for (const [type, image, ready, reason] of [
    ["chatgpt", true, true, null],
    ["apiKey", true, false, "CHATGPT_LOGIN_REQUIRED"],
    [null, true, false, "CHATGPT_LOGIN_REQUIRED"],
    ["chatgpt", false, false, "IMAGE_GENERATION_UNAVAILABLE"],
  ]) {
    const calls = [];
    const client = {
      request: async (method) => {
        calls.push(method);
        return method === "account/read"
          ? { account: type ? { type, email: "private" } : null }
          : { imageGeneration: image };
      },
      notify: () => {},
    };
    const result = await probeCodex(client);
    assert.equal(result.ready, ready);
    assert.equal(result.reason, reason);
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.ok(calls.includes("initialize"));
  }
});
test("Codex environment excludes service credentials, API keys and injected config", () => {
  const env = filteredCodexEnv({
    PATH: "/bin",
    HOME: "/tmp",
    CODEX_HOME: "/codex",
    PLATFORM_HTTP_TARGETS_JSON: "secret",
    RUNNER_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    CODEX_CODE_MODE_HOST: "secret",
    HTTPS_PROXY: "http://proxy:8080",
  });
  assert.equal(env.CODEX_HOME, "/codex");
  assert.equal(env.HTTPS_PROXY, "http://proxy:8080");
  assert.equal(Object.values(env).includes("secret"), false);
});

test("explicit backend usage denial blocks readiness without guessing from percentages", async () => {
  const client = {
    notify: () => {},
    request: async (method) =>
      method === "account/read"
        ? { account: { type: "chatgpt" } }
        : method === "modelProvider/capabilities/read"
          ? { imageGeneration: true }
          : method === "account/rateLimits/read"
            ? { ordinaryUsageAllowed: false }
            : {},
  };
  const state = await probeCodex(client);
  assert.equal(state.ready, false);
  assert.equal(state.reason, "RATE_LIMITED");
});
