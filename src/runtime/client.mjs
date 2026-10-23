import { DEFAULT_TOOL_TIMEOUT_MS } from "../config.mjs";
import { publicDescription } from "../mcp/errors.mjs";
import { HttpError } from "../errors.mjs";

export class RuntimeClient {
  constructor({ url, token, toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS }) {
    this.url = url;
    this.token = token;
    this.toolTimeoutMs = toolTimeoutMs;
  }
  async request(path, body, timeoutMs = 15000) {
    const response = await fetch(new URL(path, this.url), {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) {
      let description, code = "RUNNER_UNAVAILABLE";
      try {
        const body = await response.json();
        description = publicDescription(body?.error);
        // An authenticated Runner owns its transport codes; business messages
        // cross only through the module's explicit safe description contract.
        if (typeof body?.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(body.error.code)) code = body.error.code;
      } catch {
        // An unreadable error body still represents a received HTTP rejection.
      }
      throw Object.assign(
        new HttpError(response.status, description?.code ?? code, description?.message ?? "Runner rejected the request."),
        { responseSettled: true, ...(description ? {publicToolError: description} : {}) },
      );
    }
    return response.json();
  }
  ready() {
    return this.request("/readyz");
  }
  models() {return this.request('/internal/models',undefined,30000);}
  configure(settings) {return this.request('/internal/config',settings);}
  metrics() {return this.request('/internal/metrics');}
  restart() {return this.request('/internal/restart',{});}
  active() {
    return this.request("/internal/active");
  }
  launch(run) {
    return this.request("/internal/runs", run, 45000);
  }
  async process(body,timeoutMs=this.toolTimeoutMs) {
    try {
      return await this.request("/internal/processor", body, timeoutMs);
    } catch (error) {
      if (!error.responseSettled) error.effectUnknown = true;
      throw error;
    }
  }
  completed(run_id) {
    return this.request("/internal/completed", { run_id });
  }
  suspend(run_id) {
    return this.request("/internal/suspend", { run_id });
  }
  cancel(run_id) {
    return this.request("/internal/cancel", { run_id });
  }
}
