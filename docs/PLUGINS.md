# JSON plugins

A plugin defines a business contract, not executable code. Admin shows definitions and offers a simple enable/disable switch. Ask the management Agent to read capabilities and create, edit or trial a validated definition; it can enable a plugin after a human configures its connection. Installed example definitions live in `src/plugins/examples/` and seed a fresh database; subsequent edits are persistent database settings. New plugins are saved disabled until their mandatory connection fields are complete.

```json
{
  "type": "text.summarize",
  "name": "Summarize text",
  "enabled": false,
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

Standard submission: `POST /v2/tasks` with `{type, request_id, input}` and `Authorization: Bearer <that-plugin-entry-key>`. The body type must match the plugin identified by the key. A human-configured `/hooks/...` route accepts `{request_id, input}` and determines the type from that route; its key must identify the same plugin. Use this key for queries and artifact downloads too; it cannot access another plugin's tasks or files.

## Human connection configuration

After the Agent creates a plugin, open its **Configure connection** action in **Business plugins**. The entry address and entry key are mandatory. The initial path is the Agent's first `routes` suggestion, or `/hooks/` followed by the type with dots replaced by slashes. Humans may edit it to another `/hooks/...` path or an absolute HTTP(S) URL with such a path. Paths and keys must be unique across plugins; system paths, traversal, URL credentials, query strings and fragments are rejected for entry addresses. Saving a public URL does not configure a domain, TLS or reverse proxy.

Use the modal's cryptographic random button or supply an entry key of 24–1024 Bearer-safe characters. Copy generated values to your application's private configuration before saving; saved secrets are never displayed again. Optional callback URL and receiver token fields configure final-result delivery. Receiver tokens may be 1–1024 characters without line breaks. Blank secret inputs preserve existing credentials; clearing the callback URL removes the callback and its credential.

Connection values live separately from business JSON and survive Agent edits. Entry keys are hashed in Gateway SQLite; callback tokens are stored privately. Neither enters task snapshots or Runner messages. The management Agent receives only readiness, entry path, callback-configured status and missing field names; it cannot read or change the human connection. Never put credentials in Agent instructions, chat or task input.

Save the connection, then enable the plugin separately. Missing entry configuration blocks enabling, API admission, trials, schedules and queued or recovered launches. Existing installations also require per-plugin human configuration; their old global ingress credential does not grant public access.

## Capabilities

The management `capabilities` operation returns the current plugin schema, tool schemas and available resource/target names. In the deployed platform it also returns `connection_policy` describing human-owned fields and activation requirements, and advertises only delivery mode `none` for Agent-authored definitions. A final callback still comes exclusively from the human connection dialog.

- `register_image`: store an image generated in the current task; optionally convert/resize it and return an image preview and `artifact_id`.
- `write_text_artifact`: save supplied UTF-8 text under a task-owned artifact identity.
- `read_artifact`: read metadata for an artifact belonging to this task.
- `http_request`: GET/POST JSON to a named destination configured on the Gateway through deployment bootstrap `PLATFORM_HTTP_TARGETS_JSON`. The Agent chooses when to invoke it; URLs and credentials are not editable through global Admin settings or management operations. These targets are separate from final-result callbacks.
- Native `image_generation` and `web_search` are selected in the plugin. Availability depends on the installed Codex version and signed-in account.
- `complete_task` is added automatically. Its result must satisfy the plugin's result schema. Artifact IDs referenced in results must belong to the task and point to readable files.

No private reference assets or resource IDs are installed by default. `resources` may select resources explicitly registered by a deployment's capability catalog. Adding an entirely new tool integration or resource provider still requires implementation; a JSON plugin combines capabilities that already exist.

## Result and delivery

Query `GET /v2/tasks/{task_id}` for execution, structured result, error, artifact metadata and delivery status. Download artifacts through `GET /v2/tasks/{task_id}/artifacts/{artifact_id}`. Both require the task's plugin entry key as a Bearer credential.

For one final-result callback, a human enters that plugin's callback HTTP(S) URL and optional receiver Bearer token in **Configure connection**. This applies independently of `delivery` in Agent-editable business JSON; new definitions can keep `{"mode":"none"}`. Legacy JSON callback target names do not select the production receiver. Without a human callback URL, delivery is `not_required`.

The callback credential is supplied as a Bearer header; it is never part of the plugin or task prompt. Callback payloads contain task identity, request ID, type, status, result/error and artifact metadata. Artifact bytes are downloaded from the authenticated artifact API. The callback receiver must return a 2xx response. Pending callbacks use current human connection values. The platform reserves an attempt before sending; ambiguous network outcomes remain `unknown` and are not automatically retried. Callback attempts are separate from task completion.

The platform does not limit a business's image attempts or impose a review sequence. Put such business rules in its instructions. Unavailable tools, invalid schemas and unauthorized artifact references produce readable errors for the Agent to correct.
# Model and reasoning overrides

A plugin may include an optional execution configuration:

```json
"execution": {
  "model": "your-account-model-id",
  "reasoningEffort": "high"
}
```

Select actual model IDs and supported reasoning efforts from Admin's selectors or the preset `models` management operation. Omit `execution` to inherit the global business settings. Omit an individual field to inherit it; when selecting a different model without an effort override, its own default applies. Set `reasoningEffort` to `null` to explicitly request the model default. No model or reasoning field is added to business input schemas.

Overrides are stored in each accepted plugin contract and resolved with global settings when that task starts or resumes. Active execution retains its recorded configuration. A catalog read starts no model turn, while an actual trial consumes account allowance.
