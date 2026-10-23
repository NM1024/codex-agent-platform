import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test('current project context renders the shared concurrency default and requires explicit deployment data',async()=>{
  const [{renderSystemPrompt},{DEFAULT_CONCURRENCY}]=await Promise.all([import('../src/prompts.mjs'),import('../src/config.mjs')]);
  const context=renderSystemPrompt('manager-project',{default_concurrency:DEFAULT_CONCURRENCY});
  assert.ok(context.includes(`默认业务并发为 ${DEFAULT_CONCURRENCY}`));
  assert.ok(context.includes('已经保存的并发'));
  assert.throws(()=>renderSystemPrompt('manager-project'),/Missing system prompt variable: default_concurrency/);
});

test("system templates preserve inserted business text and diagnose missing placeholders", async () => {
  const { renderSystemPrompt } = await import("../src/prompts.mjs");
  const { createConfiguredModule } = await import("../src/plugins/module.mjs");
  const instructions =
      "User-owned instructions: keep {{input_json}} and $& literally.",
    input = { content: "Keep {{plugin_instructions}} literally." },
    schema = { type: "object" };
  const definition = {
    type: "prompt.test",
    instructions,
    input_schema: { type: "object" },
    result_schema: schema,
    capabilities: { tools: [] },
    delivery: { mode: "none" },
  };
  const text = createConfiguredModule(definition).buildTask(input).prompt;
  assert.ok(text.startsWith(instructions + "\n\n"));
  assert.ok(
    text.includes("<task_data>\n" + JSON.stringify(input) + "\n</task_data>"),
  );
  assert.ok(
    text.endsWith("Required result JSON Schema:\n" + JSON.stringify(schema)),
  );
  assert.throws(
    () => renderSystemPrompt("task", {}),
    /Missing system prompt variable: plugin_instructions/,
  );
});
test("system prompt files can be edited in another language without changing JavaScript", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "system-prompts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await cp(
    new URL("../src/prompts.mjs", import.meta.url),
    join(root, "src", "prompts.mjs"),
  );
  await cp(new URL("../prompts/", import.meta.url), join(root, "prompts"), {
    recursive: true,
  });
  const { readSystemPrompt, renderSystemPrompt } = await import(
    pathToFileURL(join(root, "src", "prompts.mjs"))
  );
  assert.match(readSystemPrompt("manager"), /管理 Agent/);
  await writeFile(
    join(root, "prompts", "task-resume.md"),
    "Reprendre la tâche existante.\n",
  );
  assert.equal(
    renderSystemPrompt("task-resume"),
    "Reprendre la tâche existante.",
  );
  await writeFile(
    join(root, "prompts", "task-investigation.md"),
    "Investigate {{task_id}}. Keep existing actions.\n",
  );
  assert.equal(
    renderSystemPrompt("task-investigation", { task_id: "example-task" }),
    "Investigate example-task. Keep existing actions.",
  );
  assert.ok(
    (
      await readFile(new URL("../prompts/manager.md", import.meta.url), "utf8")
    ).includes("管理 Agent"),
  );
});
