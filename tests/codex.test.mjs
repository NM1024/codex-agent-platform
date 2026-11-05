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
test("RPC retains safe upstream classification while preserving its public error code", async () => {
  const c = new CodexRpcClient({ command: process.execPath, args: [fixture] });
  try {
    for (const [code, category, reason] of [
      [-32700, "parse_error", "Upstream could not parse the RPC request."],
      [-32600, "invalid_request", "Upstream rejected the RPC request format."],
      [-32601, "method_not_found", "Upstream does not support this RPC method."],
      [-32602, "invalid_params", "Upstream rejected the RPC parameters."],
      [-32603, "internal_error", "Upstream encountered an internal RPC error."],
      [-32042, "server_error", "Upstream reported an RPC server error."],
      [-2147483648, "upstream_error", "Upstream RPC request failed."],
      [2147483647, "upstream_error", "Upstream RPC request failed."],
      [42, "upstream_error", "Upstream RPC request failed."],
    ]) {
      await assert.rejects(c.request("rpc/error", { error: { code, message: "private upstream text", data: { secret: "private data" } } }), error => {
        assert.equal(error.code, "CODEX_RPC_ERROR");
        assert.deepEqual(error.rpcError, { code, category, reason });
        assert.match(error.message, new RegExp(String(code)));
        assert.ok(error.message.includes(category));
        assert.ok(error.message.includes(reason));
        assert.ok(error.message.length <= 256);
        assert.doesNotMatch(error.message + JSON.stringify(error), /private upstream text|private data/);
        return true;
      });
    }
    assert.deepEqual(await c.request("fast", { still: "available" }), { still: "available" });
  } finally {
    await c.close();
  }
});
test("RPC explains allowlisted upstream failures without retaining arbitrary error details", async () => {
  const c = new CodexRpcClient({ command: process.execPath, args: [fixture] });
  try {
    for (const [message, category, reason] of [
      ["Thread not found", "thread_not_found", "The requested Codex thread was not found."],
      ["Rate limit exceeded", "rate_limited", "Upstream rate limit exceeded."],
      ["Authentication required", "authentication_required", "Upstream authentication is required."],
      ["Model not found", "model_not_found", "The requested model was not found."],
      ["Server is busy", "server_busy", "Upstream is busy."],
    ]) {
      await assert.rejects(c.request("rpc/error", { error: { code: -32000, message, data: { authorization: "Bearer private-fixture-token" } } }), error => {
        assert.deepEqual(error.rpcError, { code: -32000, category, reason });
        assert.ok(error.message.includes(reason));
        assert.doesNotMatch(JSON.stringify(error), /private-fixture-token|authorization|data/);
        return true;
      });
    }
  } finally {
    await c.close();
  }
});
test("RPC diagnostic projections exclude sensitive messages and stay bounded", async () => {
  const c = new CodexRpcClient({ command: process.execPath, args: [fixture] });
  try {
    for (const message of [
      "Authorization: Bearer fixture-bearer-secret password=fixture-password",
      "https://fixture-user:fixture-pass@example.invalid/path?token=fixture-query-secret",
      "Private prompt for fixture-person@example.invalid: use fixture-raw-api-key",
      "Thread not found; private prompt fixture-private-prompt",
      "fixture-private-prompt Rate limit exceeded",
      "x".repeat(200_000) + "fixture-secret-at-end",
    ]) {
      await assert.rejects(c.request("rpc/error", { error: { code: -32000, message, data: { raw: message } } }), error => {
        assert.deepEqual(error.rpcError, { code: -32000, category: "server_error", reason: "Upstream reported an RPC server error." });
        const serialized = error.message + error.stack + JSON.stringify(error);
        assert.ok(error.message.length <= 256);
        assert.ok(serialized.length < 3000);
        assert.doesNotMatch(serialized, /fixture-|example\.invalid|Private prompt|Authorization/);
        assert.equal(Object.hasOwn(error, "cause"), false);
        return true;
      });
    }
  } finally {
    await c.close();
  }
});
test("RPC malformed error responses reject with a bounded generic diagnostic", async () => {
  const c = new CodexRpcClient({ command: process.execPath, args: [fixture] });
  try {
    for (const upstream of [null, false, 0, "fixture-secret", [], {},
      { code: "-32601", message: "Thread not found" },
      { code: -32601.5, message: "Thread not found" },
      { code: 2 ** 40, message: "Thread not found" },
      { code: -2147483649, message: "Thread not found" },
      { code: -32601, message: { secret: "fixture-secret" } },
      { code: -32601 },
    ]) {
      await assert.rejects(c.request("rpc/error", { error: upstream }), error => {
        assert.equal(error.code, "CODEX_RPC_ERROR");
        assert.equal(error.message, "CODEX_RPC_ERROR");
        assert.deepEqual(error.rpcError, { category: "unknown", reason: "Upstream RPC request failed." });
        assert.doesNotMatch(JSON.stringify(error), /fixture-secret|Thread not found/);
        return true;
      });
    }
    assert.equal(c.pending.size, 0);
  } finally {
    await c.close();
  }
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
