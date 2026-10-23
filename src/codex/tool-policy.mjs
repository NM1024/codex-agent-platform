import { realpathSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
// Executed only by the pinned Codex PreToolUse hook. The model cannot edit this
// script (image is read-only) or select another command.
export function allowedTool(name, input = {}, scope = {}) {
  if (/^mcp__agent_task__/.test(name ?? "")) return true;
  const native = (name ?? "").replace(/^(?:multi_agent_v1|task_agents)/, "");
  if (native === "view_image") {
    try {
      if (typeof input.path !== "string" || input.environment_id) return false;
      const path = realpathSync(
        resolve(scope.cwd ?? process.cwd(), input.path),
      );
      if (!statSync(path).isFile()) return false;
      if ((scope.referenceFiles ?? []).some((ref) => realpathSync(ref) === path))
        return true;
      return (scope.readRoots ?? []).some((root) => {
        try {
          const rel = relative(realpathSync(root), path);
          return (
            rel !== "" &&
            rel !== ".." &&
            !rel.startsWith(".." + sep) &&
            !rel.startsWith(sep)
          );
        } catch { return false; }
      });
    } catch {
      return false;
    }
  }
  return new Set([
    "spawn_agent",
    "send_input",
    "wait",
    "close_agent",
    "resume_agent",
    "wait_agent",
    "send_message",
    "followup_task",
    "interrupt_agent",
    "list_agents",
    "web_search",
    // Codex 0.159.2 flattens native namespaces without a separator.
    "webrun",
    "image_genimagegen",
  ]).has(native);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (Buffer.byteLength(data) > 1048576) process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(data);
  } catch {
    process.exit(2);
  }
  let scope;
  try {
    scope = {
      cwd: process.env.AGENT_TASK_WORK_DIR,
      readRoots: JSON.parse(process.env.AGENT_TASK_READ_ROOTS ?? "[]"),
      referenceFiles: JSON.parse(process.env.AGENT_TASK_REFERENCE_FILES ?? "[]"),
    };
  } catch {
    process.exit(2);
  }
  const allowed = allowedTool(input.tool_name, input.tool_input, scope);
  // In Codex 0.159.2 an empty response means continue. "allow" without
  // updatedInput is an unsupported hook result (it is not needed to continue).
  process.stdout.write(JSON.stringify(allowed ? {} : {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "This agent only grants its configured MCP and selected native capabilities.",
    },
  }));
}
