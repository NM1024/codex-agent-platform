import { readFileSync } from "node:fs";

// Explicit resources keep deployment validation and editing locations predictable.
const files = {
  manager: new URL("../prompts/manager.md", import.meta.url),
  "manager-connections": new URL("../prompts/manager-connections.md", import.meta.url),
  task: new URL("../prompts/task.md", import.meta.url),
  "task-resume": new URL("../prompts/task-resume.md", import.meta.url),
  "manager-resume": new URL("../prompts/manager-resume.md", import.meta.url),
  "task-investigation": new URL(
    "../prompts/task-investigation.md",
    import.meta.url,
  ),
};
export function readSystemPrompt(name) {
  if (!Object.hasOwn(files, name))
    throw new Error(`Unknown system prompt: ${name}`);
  return readFileSync(files[name], "utf8");
}
export function renderSystemPrompt(name, values = {}) {
  // A single pass keeps placeholder-like text inside user input literal.
  return readSystemPrompt(name)
    .replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (!Object.hasOwn(values, key))
        throw new Error(`Missing system prompt variable: ${key} (${name})`);
      return String(values[key]);
    })
    .trimEnd();
}
