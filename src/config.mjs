// Node timers accept at most a signed 32-bit delay; this is a runtime limit.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const DEFAULT_TOOL_TIMEOUT_MS = 180000;
import { resolve } from "node:path";
function required(env, name) {
  if (
    typeof env[name] !== "string" ||
    !env[name].trim() ||
    /[\r\n]/.test(env[name])
  )
    throw new Error(`Missing or invalid configuration: ${name}`);
  return env[name];
}
function integer(env, name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid configuration: ${name}`);
  return value;
}
export function validateUrl(raw, name, { internal = false } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid configuration: ${name}`);
  }
  if (
    u.username ||
    u.password ||
    u.hash ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        (internal || ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
    )
  )
    throw new Error(`Invalid configuration: ${name}`);
  return raw;
}
export function loadConfig(role, env = process.env) {
  const runnerToken = required(env, "RUNNER_TOKEN");
  const config = {
    role,
    runnerToken,
    workspace: resolve(env.WORKSPACE_DIR ?? "/workspace"),
    port: integer(env, "PORT", role === "gateway" ? 3004 : 3005, 1, 65535),
    concurrency: integer(env, "CONCURRENCY", 1, 1),
    taskTimeoutMs: integer(env, "TASK_TIMEOUT_MS", 2400000, 1, MAX_TIMER_DELAY_MS - 5000),
    toolTimeoutMs: integer(env, "TOOL_TIMEOUT_MS", DEFAULT_TOOL_TIMEOUT_MS, 1, MAX_TIMER_DELAY_MS),
    gatewayInternalUrl: validateUrl(
      env.GATEWAY_INTERNAL_URL ?? "http://gateway:3006",
      "GATEWAY_INTERNAL_URL",
      { internal: true },
    ),
    model: env.CODEX_MODEL?.trim() || "gpt-6.1-sol",
  };
  if (role === "gateway") {
    config.ingressToken = required(env, "INGRESS_TOKEN");
    if (config.ingressToken === runnerToken)
      throw new Error("Configuration tokens must be distinct");
    config.runnerUrl = validateUrl(
      env.RUNNER_URL ?? "http://runner:3005",
      "RUNNER_URL",
      { internal: true },
    );
    config.dbPath = env.TASK_DB_PATH ?? "/data/tasks.sqlite";
    config.queueLimit = integer(env, "QUEUE_LIMIT", 10000, 1);
    config.paused = env.EXECUTION_PAUSED === "true";
    config.mcpPort = integer(env, "MCP_PORT", 3006, 1, 65535);
  } else if (role === "runner") {
    config.model = env.CODEX_MODEL?.trim() || "gpt-6.1-sol";
  } else throw new Error("Invalid service role");
  return config;
}
