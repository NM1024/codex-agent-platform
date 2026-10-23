# Platform system prompts

Start here if you want to adapt the platform's built-in instructions to your language or operating style. Each prompt is a plain UTF-8 Markdown file. Edit the text directly; you do not need to find strings inside JavaScript.

These files contain platform-owned instructions and message templates. They have one version each, keep their original language, and are independent of the Admin interface language. Changing the UI language does not translate or overwrite them.

## Which file should I edit?

| File | Purpose | Variables supplied by the platform |
| --- | --- | --- |
| [manager.md](manager.md) | Default system instructions for the management Agent: its role, tool boundaries, configuration, investigations and reporting. Passed as Codex developer instructions. | None |
| [task.md](task.md) | Platform wrapper for a task's initial message. Includes the plugin's own instructions, request data and required result schema. | `{{plugin_instructions}}`, `{{input_json}}`, `{{result_schema_json}}` |
| [task-resume.md](task-resume.md) | Continue an unfinished task after a service restart in its existing Codex conversation. | None |
| [manager-resume.md](manager-resume.md) | Continue an interrupted management turn with the recorded actions, so the Agent can inspect their outcomes. | `{{recorded_actions_json}}` |
| [task-investigation.md](task-investigation.md) | Initial message generated when an operator asks the management Agent to investigate a task from Admin. | `{{task_id}}` |

`src/prompts.mjs` loads these files. Application code supplies the data; the Markdown files own the wording. Tool names, JSON schemas and capability permissions stay with their implementation, because changing prose does not change what a tool can do.

## Editing and applying changes

### Management Agent instructions

For an **existing installation**, ask the management Agent to save the desired instructions through `configuration_update` (scope `manager`, patch field `instructions`). Admin Settings shows the current value without a prompt editor. You can supply the contents of `manager.md`, translated or adapted as needed. The next management turn uses the saved instructions; no image rebuild or service restart is needed. The same change is available through `configuration_update` with scope `manager` and patch field `instructions`.

`manager.md` supplies the first-install default and the fallback when an Agent is used without saved configuration. The platform persists that initial default too. Editing the file or upgrading the image **does not replace instructions already stored in the Manager database**, even if you never changed them yourself. This protects operator changes; use Admin to apply a revised prompt to an existing installation.

### Other platform message templates

Edit the appropriate Markdown file, rebuild the service images and redeploy using the [deployment guide](../docs/DEPLOYMENT.md). Docker images include the whole `prompts/` directory; changing a file in your source checkout does not change an already running image. During direct Node.js development, the files are read when a message is built.

A new initial task uses `task.md`. An incomplete conversation resumed after an interruption uses its recovery template. A task investigation uses its template when the linked management conversation has no messages yet. Already-sent conversation messages are not rewritten.

## Keep these parts intact

- Keep each `{{variable_name}}` exactly as shown in the table. You may move it within the text, but changing its name produces a readable missing-variable error. Inserted user data is treated literally; it is not evaluated as another template.
- Preserve tool identifiers such as `complete_task`, `configuration_update` and `register_image`. Translating a tool name does not rename the tool.
- Keep the distinction between task input, plugin instructions and the result schema. In `task.md`, retain the input boundaries and schema placeholder; task data is not a new source of platform instructions.
- Preserve the completion and recovery requirements: task Agents submit through `complete_task`; the management Agent replies normally; recovery continues existing work and checks uncertain actions before repeating them.
- Keep credentials out of prompts. Changing prompt text does not add tools, grant filesystem access or alter the configured permission policy.

## Business plugin instructions belong elsewhere

A plugin's `instructions` describe the actual business work, such as how to review content or write a story. Create and change those through **Business plugins** or ask the management Agent to configure them. They are user-controlled JSON configuration and are not stored in this directory. The bundled plugin examples remain under `src/plugins/examples/`.

Likewise, an operator's chat messages and a schedule's inspection requirements remain conversation or schedule data. The default text in their editable forms is a starting point, not a separate system policy.
