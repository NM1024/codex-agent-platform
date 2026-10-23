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

## Per-plugin integration documentation

Each Admin business-plugin row has an **Integration docs** action, separate from connection setup and definition details. The read-only drawer provides overview, request, response/query, callback and error tabs, with code copy, full Markdown copy and download. It is available before a plugin is enabled or its human connection is ready, with setup guidance instead of automatically changing anything.

The human-authenticated `GET /admin/api/plugins/{type}/integration?locale=zh-CN|en` route reads the current saved definition and connection revisions on each request. Its document is generated from the actual platform HTTP protocol and that plugin's `input_schema`/`result_schema`; it does not use a model turn or submit a trial. There is no new Agent tool or public entry-key documentation endpoint. Operators may share the exported Markdown with callers.

Parameter tables include nested objects/arrays, local references, required flags, descriptions and constraints; the complete schemas remain authoritative for complex, conditional or recursive contracts. A synthesized example is shown only after validating against the complete schema. Unsupported examples are explicitly unavailable. Add business meaning through JSON Schema `description` and valid `examples` annotations using management chat; absent descriptions are labeled, not inferred. UI language changes translate protocol guidance, not business annotations.

The bundled example schemas include field annotations for fresh installations. Existing saved definitions are retained during upgrade; ask the management Agent to add any missing descriptions/examples to those definitions while preserving their business contracts.

Documents distinguish asynchronous HTTP202 admission from HTTP200 queries/final results, and explain scoped Bearer auth, request correlation without deduplication, task states, artifacts and optional callbacks. A relative entry path uses an explicit `https://<gateway-host>` placeholder; the Admin origin is never assumed to be the business host. Keys and callback credentials are placeholders. Actual callback URLs are omitted too because their query strings can contain credentials. Current plugin documents do not replace the contract saved when a historical task was accepted.

## Human connection configuration

After the Agent creates a plugin, open its **Configure connection** action in **Business plugins**. The entry address and entry key are mandatory. The initial path is the Agent's first `routes` suggestion, or `/hooks/` followed by the type with dots replaced by slashes. Humans may edit it to another `/hooks/...` path or an absolute HTTP(S) URL with such a path. Paths and keys must be unique across plugins; system paths, traversal, URL credentials, query strings and fragments are rejected for entry addresses. Saving a public URL does not configure a domain, TLS or reverse proxy.

Use the modal's cryptographic random button or supply an entry key of 24–1024 Bearer-safe characters. Copy manually generated values to your application's private configuration before saving; saved secrets are never displayed again. Alternatively, the management Agent may call plugin_connection_initialize for missing credentials. The backend generates the key without returning it to the Agent. A human uses Claim entry key in the modal to receive it once; it becomes effective upon claim, and configuration must still be enabled separately. Initialization does not rotate existing keys. If a claimed key is lost after the modal closes, only a human can generate and save a replacement; saving immediately revokes the old key and requires updating callers. Optional callback URL and receiver token fields configure final-result delivery. Receiver tokens may be 1–1024 characters without line breaks. Blank secret inputs preserve existing credentials; clearing the callback URL removes the callback and its credential.

Connection values live separately from business JSON and survive Agent edits. Entry keys are hashed in Gateway SQLite; pending generated keys also retain a private temporary plaintext copy for a one-time human claim, cleared atomically on claim or replacement. Callback tokens are stored privately. Runtime databases and backups must remain private. Neither enters task snapshots or Runner messages. The management Agent receives only readiness, entry address/path, claimable status, callback-configured status and missing field names. It can initialize missing entry credentials but cannot read, claim or reset keys or change human connection settings. Never put credentials in Agent instructions, chat or task input.

Save the connection, then enable the plugin separately. Missing entry configuration or an unclaimed generated key blocks enabling, API admission, trials, schedules and queued or recovered launches. Existing installations also require per-plugin human configuration; their old global ingress credential does not grant public access.

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
