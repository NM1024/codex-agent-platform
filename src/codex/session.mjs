import { CodexRpcClient } from "./rpc.mjs";

const initialized = new WeakSet();
export async function initialize(client) {
  if (initialized.has(client)) return;
  await client.request("initialize", {
    clientInfo: { name: "codex_agent_platform", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized", {});
  initialized.add(client);
}
export async function probeCodex(client, { requireImage = true } = {}) {
  try {
    await initialize(client);
    const account = await client.request("account/read", {
      refreshToken: false,
    });
    const authType = account?.account?.type ?? null;
    if (authType !== "chatgpt")
      return {
        authType,
        imageGeneration: false,
        ready: false,
        reason: "CHATGPT_LOGIN_REQUIRED",
      };
    const caps = await client
      .request("modelProvider/capabilities/read", {})
      .catch((error) => {
        if (requireImage) throw error;
        return {};
      });
    const imageGeneration = caps?.imageGeneration === true;
    if (requireImage && !imageGeneration)
      return {
        authType,
        imageGeneration,
        ready: false,
        reason: "IMAGE_GENERATION_UNAVAILABLE",
      };
    let usageAllowed = null;
    try {
      const usage = await client.request("account/rateLimits/read", {});
      usageAllowed =
        typeof usage?.ordinaryUsageAllowed === "boolean"
          ? usage.ordinaryUsageAllowed
          : null;
      if (usage?.rateLimits?.spendControlReached === true) usageAllowed = false;
    } catch {}
    return {
      authType,
      imageGeneration,
      usageAllowed,
      ready: usageAllowed !== false,
      reason: usageAllowed === false ? "RATE_LIMITED" : null,
    };
  } catch (error) {
    return {
      authType: null,
      imageGeneration: false,
      ready: false,
      reason: ["CODEX_TIMEOUT", "CODEX_EXIT", "CODEX_START_FAILED"].includes(
        error.message,
      )
        ? error.message
        : "CODEX_PROBE_FAILED",
    };
  }
}
export async function probeWithProcess({
  requireImage = true,
  ...options
} = {}) {
  const client = new CodexRpcClient(options);
  try {
    return await probeCodex(client, { requireImage });
  } finally {
    await client.close();
  }
}
