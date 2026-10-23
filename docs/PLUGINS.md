# JSON plugins

A plugin defines a business contract, not executable code. Create or edit it in Admin, or ask the management Agent to read capabilities and save a validated definition. Installed example definitions live in `src/plugins/examples/` and seed a fresh database; subsequent edits are persistent database settings.

```json
{
  "type": "text.summarize",
  "name": "Summarize text",
  "enabled": true,
  "input_schema": {
    "type": "object",
    "properties": {"text": {"type": "string"}},
    "required": ["text"],
    "additionalProperties": false
  },
  "instructions": "Summarize the supplied text. Submit {summary: string} through complete_task.",
  "result_schema": {
    "type": "object",
    "properties": {"summary": {"type": "string"}},
    "required": ["summary"],
    "additionalProperties": false
  },
  "capabilities": {"tools": [], "image_generation": false, "web_search": false},
  "resources": [],
  "routes": ["/hooks/summarize"],
  "delivery": {"mode": "none"}
}
```

Standard submission: `POST /v2/tasks` with `{type, request_id, input}`. A configured `/hooks/...` alias accepts `{request_id, input}` and determines the type from the route. Both use Bearer API authentication. System routes and conflicting aliases cannot be used as plugin routes.

## Capabilities

- `register_image`: store an image generated in the current task; optionally convert/resize it and return an image preview and `artifact_id`.
- `write_text_artifact`: save supplied UTF-8 text under a task-owned artifact identity.
- `read_artifact`: read metadata for an artifact belonging to this task.
- `http_request`: GET/POST JSON to a named destination configured on the Gateway. The Agent chooses when to invoke it; URLs and credentials are managed separately.
- Native `image_generation` and `web_search` are selected in the plugin. Availability depends on the installed Codex version and signed-in account.
- `complete_task` is added automatically. Its result must satisfy the plugin's result schema. Artifact IDs referenced in results must belong to the task and point to readable files.

No private reference assets or resource IDs are installed by default. `resources` may select resources explicitly registered by a deployment's capability catalog. Adding an entirely new tool integration or resource provider still requires implementation; a JSON plugin combines capabilities that already exist.

## Result and delivery

Query `GET /v2/tasks/{task_id}` for execution, structured result, error, artifact metadata and delivery status. Download artifacts through `GET /v2/tasks/{task_id}/artifacts/{artifact_id}` with API authentication.

For one final-result callback, configure a named HTTPS destination in the `http` settings group, then use:

```json
{"mode": "callback_once", "target": "my_callback"}
```

The destination token is supplied as a Bearer header; it is never part of the plugin or task prompt. Callback payloads contain task identity, request ID, type, status, result/error and artifact metadata. Artifact bytes are downloaded from the authenticated artifact API. The callback receiver must return a 2xx response. Pending callbacks use current target configuration. Callback attempts are separate from task completion and are not automatically retried after ambiguous network errors.

The platform does not limit a business's image attempts or impose a review sequence. Put such business rules in its instructions. Unavailable tools, invalid schemas and unauthorized artifact references produce readable errors for the Agent to correct.
