import { DEFAULT_TOOL_TIMEOUT_MS } from "../config.mjs";
import { fileURLToPath } from "node:url";
import {codexModelOptions} from '../configuration/model-options.mjs';

export function runtimeConfig(agentPackage, mcpUrl, { toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS, userInput = false, modelSettings = {} } = {}) {
  const hook = fileURLToPath(new URL("./tool-policy.mjs", import.meta.url));
  return {
    ...codexModelOptions(modelSettings),
    "features.shell_tool": false,
    "features.apply_patch_freeform": false,
    "features.js_repl": false,
    "features.apps": false,
    "features.plugins": false,
    "features.connectors": false,
    "features.browser_use": false,
    "features.multi_agent": true,
    "features.fast_mode": true,
    "features.hooks": true,
    "features.image_generation": agentPackage.native.imageGeneration === true,
    "multi_agent_v2.tool_namespace": "task_agents",
    "features.default_mode_request_user_input": userInput === true,
    web_search: agentPackage.native.webSearch ? "live" : "disabled",
    project_doc_max_bytes: 0,
    mcp_servers: {
      agent_task: {
        url: mcpUrl,
        bearer_token_env_var: "AGENT_TASK_MCP_TOKEN",
        enabled_tools: agentPackage.tools,
        // These are the caller-selected MCP tools, authorized by the task or
        // management request. "auto" would reject unannotated writes under approval=never.
        default_tools_approval_mode: "approve",
        required: true,
        tool_timeout_sec: Math.ceil(toolTimeoutMs / 1000),
      },
    },
    hooks: {
      PreToolUse: [
        {
          matcher: ".*",
          hooks: [
            {
              type: "command",
              command: `node ${JSON.stringify(hook)}`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}
