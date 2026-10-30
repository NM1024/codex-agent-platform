# Webhook notifications

Tasks and scheduled inspections can send messages through existing channels while they run. The Agent decides whether an event matches its instructions, when to send, which bound channels to use and how to compose each provider's native JSON. A binding authorizes destinations; it does not trigger a message or create an automatic completion notification. Notification outcomes, business task status and the optional final-result callback are recorded independently.

中文使用要点：先由人在“系统配置 → 通知渠道”保存接入信息，再为任务或定时计划选择 0–32 个不同渠道 UUID。业务插件必须同时授权 `notification_context` 和 `send_notification`；通知条件与原生消息格式写在提示词中，由 Agent 判断时机、次数和渠道子集。计划和已创建执行各自保存独立绑定，修改时读取最新版本。`unknown` 表示结果不确定，应先核查，不能自动重发。以下示例均为合成数据，不会自动执行。

## Providers and native bodies

| Provider ID | Channel | Native JSON example | Acceptance confirmation |
| --- | --- | --- | --- |
| `feishu` | Feishu, including Lark | `{"msg_type":"text","content":{"text":"Synthetic notification"}}` | HTTP success and a successful provider code |
| `wecom` | WeCom group robot | `{"msgtype":"text","text":{"content":"Synthetic notification"}}` | HTTP success and `errcode=0` |
| `dingtalk` | DingTalk custom robot | `{"msgtype":"text","text":{"content":"Synthetic notification"}}` | HTTP success and `errcode=0` |
| `slack` | Slack incoming Webhook | `{"text":"Synthetic notification"}` | HTTP success and plain-text `ok` |
| `discord` | Discord execute Webhook | `{"content":"Synthetic notification","allowed_mentions":{"parse":[]}}` | `wait=true` and a confirmed created-message response |
| `custom` | Custom JSON Webhook | `{"event":"synthetic-check","message":"Synthetic notification"}` | HTTP 2xx by default; inspect the bounded response summary for application-level meaning |

Native cards, rich text, blocks, embeds and other supported JSON fields may be used according to the provider's protocol. `notification_context` returns built-in examples and operator-supplied guidance. Guidance cannot grant additional destinations or change authentication. File uploads, arbitrary scripts and request-method overrides are outside this interface.

The platform POSTs JSON without following redirects. Native providers accept their official Webhook hosts and paths only. Custom targets use HTTPS, with HTTP allowed only for the existing exact loopback hosts `localhost`, `127.0.0.1` and `[::1]`. Feishu bodies are limited to 20 KiB; other bodies have a 256 KiB transport limit, and recipients may impose smaller limits. Requests and responses are bounded.

The optional Feishu/Lark signature uses seconds and HMAC-SHA256 over empty data with `timestamp + "\n" + secret` as the key. DingTalk uses milliseconds, the secret as the HMAC key and `timestamp + "\n" + secret` as the data, then appends encoded `timestamp`/`sign` URL parameters. The Agent does not supply or retrieve secrets or control platform signing fields.

## Human-managed configuration

Open **Settings → Notification channels**. Each channel has a stable UUID, name, fixed provider, description, extra format instructions, enabled state, timeout and configuration revision. Disabling blocks future sends; logical deletion preserves its identity and history. A recreated name does not transfer old bindings to a new destination.

Humans enter the full Webhook URL, private headers, optional Bearer token and supported signing secret in the dedicated form. A URL may itself contain credentials. Saved secrets are write-only: omitted fields preserve stored values; explicit empty token/signing-secret values or an empty headers map clear those fields. The URL cannot be empty. Edits, enable/disable and deletion require the latest channel configuration revision; reread after a conflict.

Agents see safe metadata and configured flags, without URL or authentication values. They cannot edit channel secrets, perform human test sends or override targets, TLS or transport headers. Header validation rejects line breaks and reserved transport fields. Keep credentials out of prompts, business inputs, shared examples and logs; runtime databases and backups contain private settings.

Saving a channel does not send. The explicitly labeled human **Test notification** action sends a fixed synthetic message to the saved destination and records separate test history. Invoke it only when a real test message is intended.

## Explicit business capabilities

Read live `capabilities` before editing a plugin. Add both tools while retaining other tools it needs:

```json
{
  "capabilities": {
    "tools": ["notification_context", "send_notification"],
    "image_generation": false,
    "web_search": false
  }
}
```

This is a plugin-definition fragment. Put event conditions and message requirements in `instructions`. For example: “If the supplied synthetic check needs attention, read notification_context, compose the destination's native JSON, and notify the selected bound channels. Use a stable key per logical event. Check previous records before acting on an unknown outcome.” The platform imposes no business trigger, review sequence or mandatory send count.

Nonempty bindings require both tools in the task's saved plugin contract. A business input field or later plugin edit cannot grant an existing task capabilities it did not receive at admission. Old plugins, tasks and schedules start without bindings or automatic effects.

## Task creation and binding changes

Using the plugin's entry Bearer key, submit through `POST /v2/tasks`:

```json
{
  "type": "synthetic.check",
  "request_id": "synthetic-notification-example-1",
  "input": {"condition": "needs-attention"},
  "notification_channels": ["00000000-0000-4000-8000-000000000003"]
}
```

Replace the synthetic type/input with a configured plugin's contract and the UUID with an existing channel. The plugin's `/hooks/...` route accepts the same envelope without `type`. `notification_channels` belongs outside `input`; omission or `[]` binds none. It accepts 0–32 distinct existing IDs. Unavailable new selections and malformed bindings are rejected, without silently clearing them. Each task POST creates independent work; `request_id` is not an idempotency key.

Administrators provide channel UUIDs to callers. The business API does not enumerate all channels or reveal other plugins' bindings. With the same plugin entry key:

| Method | Endpoint | Meaning |
| --- | --- | --- |
| GET | `/v2/tasks/{task_id}/notifications` | Current binding, safe bound-channel metadata and paginated history |
| POST | `/v2/tasks/{task_id}/notifications` | Replace a nonterminal task's binding |

GET returns `notification_channels`, `notification_revision`, `channels` and `history:{items,next_cursor}`. Paginate history with `limit` (1–100) and `before`. Then POST the revision just read:

```json
{
  "notification_channels": ["00000000-0000-4000-8000-000000000003"],
  "revision": 1
}
```

Use the actual `notification_revision`, rather than this example's `1`. HTTP 409 `NOTIFICATION_BINDING_REVISION_CONFLICT` requires rereading and reconciling the selection. `[]` clears future destinations. Ended tasks reject binding changes. Existing unavailable references may remain visible; new selections must be available.

Changes affect requests started afterward. They do not retract messages, replay events or modify the task's plugin snapshot. The backend checks live binding/channel state before each request; already-started requests use that attempt's saved configuration. The business Agent can refresh context but cannot edit its own binding.

Management `submit_task` also accepts `notification_channels`. Management `retry` creates a new task: omission inherits the original task's current binding, `[]` clears it, and a supplied nonempty array replaces it. Inherited channels and the new plugin contract are revalidated; unavailable channels require an explicit new choice rather than silently disappearing.

## Schedules and inspections

Both schedule kinds accept `notification_channels` inside `schedule_save`'s `schedule` object. A synthetic inspection example:

```json
{
  "schedule": {
    "name": "Synthetic inspection example",
    "kind": "inspection",
    "cron": "0 9 * * *",
    "timezone": "Asia/Shanghai",
    "enabled": false,
    "message": "Check configured platform state. Notify bound channels only if the prompt conditions require attention; inspect unknown notification history before further action.",
    "notification_channels": ["00000000-0000-4000-8000-000000000003"]
  }
}
```

A `kind:"task"` plan instead supplies the business plugin's `type` and schema-valid `input`; that plugin must grant both tools. Each trigger copies its plan binding into the new task or inspection execution. Plan edits affect subsequent triggers; execution edits do not alter the plan or other executions. If a saved channel later becomes unavailable, scheduled work can still run and its notification reports unavailable. The plan can still be disabled.

Use binding-only operations to preserve cron and `next_run_at`:

| Read | Update | Identity field |
| --- | --- | --- |
| `task_notifications_get` | `task_notifications_update` | `task_id` |
| `schedule_notifications_get` | `schedule_notifications_update` | `id` |
| `inspection_notifications_get` | `inspection_notifications_update` | `id` |

Updates take `notification_channels` and the latest `notification_revision`. Admin task/schedule detail provides corresponding editors; schedule execution history lets operators inspect a particular execution. Editing an unfinished inspection changes only its later sends.

Scheduled inspections use the same notification tools as business tasks. The backend derives the trusted original inspection/message identity. Only that active original execution, including valid recovery, may send. Ordinary management conversations, later followups and completed executions cannot borrow its scope. Built-in inspections do not need a business plugin wrapper.

## Sending and outcomes

Call `notification_context` with `{}` or optional `limit`/`before` for live bindings, native format guidance and history. Then call `send_notification`:

```json
{
  "notification_key": "synthetic-check-attention-1",
  "deliveries": [
    {
      "channel_id": "00000000-0000-4000-8000-000000000003",
      "body": {"msg_type":"text","content":{"text":"Synthetic check needs attention."}}
    }
  ]
}
```

The body assumes a Feishu channel; other providers need their own native JSON. Each invocation includes 1–32 distinct bound channels. Tools do not accept an owner task, inspection or conversation identity from the model. Whole-batch structure, authorization and binding checks happen before sending anything. During sending, one unavailable/rejected channel does not hide other outcomes.

A batch returns `batch_id`, `notification_key`, aggregate `status`, timestamps and `deliveries`. Each delivery includes `channel_id`, safe channel name/provider, `status`, `http_status`, `provider_code`, bounded/redacted `summary`, original message body and timestamps. Inspect each channel, especially for partial success:

| Status | Meaning |
| --- | --- |
| `pending` | No network attempt has started; current authorization is checked again before starting. |
| `sending` | An attempt has been reserved and is in progress. |
| `accepted` | The receiver confirmed acceptance; it does not mean a person read the message. |
| `rejected` | Explicit HTTP/protocol rejection. Correcting the message with a new key is a task-level decision. |
| `unavailable` | A channel is disabled, deleted or cannot currently be used. |
| `unknown` | Acceptance is uncertain after timeout, connection loss, an unrecognized response or restart during an attempt. Check history and external evidence before further action. |

Within one task/inspection execution, the logical key is durable. Same key plus identical original deliveries returns existing records; different contents under that key conflict. Recorded terminal attempts, including accepted and unknown, are not resent. Unstarted entries may continue only after live reauthorization. Use a different key for a different logical event. This does not deduplicate task creation itself.

There is no automatic notification retry queue or remote exactly-once guarantee. Do not turn unknown into a new-key resend merely because the platform restarted or a tool timed out. Notification failures do not automatically fail/complete a task; its prompt defines business consequences. History follows task/inspection retention and cleanup policies.

## Admin routes and validation

Human-authenticated, same-origin Admin writes use these routes:

| Method | Route | Body |
| --- | --- | --- |
| GET | `/admin/api/notification-channels` | — |
| POST | `/admin/api/notification-channels` | `{channel:{...},revision?}`; updates include channel `id` and latest revision |
| POST | `/admin/api/notification-channels/{id}/enable` | `{enabled,revision}` |
| DELETE | `/admin/api/notification-channels/{id}` | `{revision}` |
| POST | `/admin/api/notification-channels/{id}/test` | `{}`; intentionally sends a fixed synthetic message |
| GET / POST | `/admin/api/tasks/{id}/notifications` | POST: `{notification_channels,revision}` |
| GET / POST | `/admin/api/schedules/{id}/notifications` | POST: `{notification_channels,revision}` |
| GET / POST | `/admin/api/inspections/{id}/notifications` | POST: `{notification_channels,revision}` |

Management `notification_channels` lists safe metadata only. Private channel writes and test sends are not management Agent tools. Binding revisions are independent of channel configuration and plugin definition revisions.

Development checks use synthetic data, injected fake transports and local callback sinks. They do not read login credentials, submit real account tasks or send to real provider destinations. Focused checks include `node --test tests/notification-providers.test.mjs tests/notification-store.test.mjs`. Run full project/release checks before integration as described in [contribution guidance](../CONTRIBUTING.md).

Human channel-test records are isolated from task and inspection histories. Gateway maintenance removes test records older than seven days in bounded batches, skipping active sends.
