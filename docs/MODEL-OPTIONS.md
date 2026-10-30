# Model options / 模型参数

## Values and defaults / 取值与默认值

| Platform field / 平台字段 | Values / 取值 | Default / 默认 |
| --- | --- | --- |
| `verbosity` | `low`, `medium`, `high` | `medium` |
| `reasoningSummary` | `auto`, `concise`, `detailed`, `none` | Manager / 管理：`concise`；business / 业务：`auto` |
| `autoCompactTokenLimit` | `null` or / 或 integer / 整数 1024–2147483647 | `null` |
| `toolOutputTokenLimit` | `null` or / 或 integer / 整数 256–2147483647 | `null` |

The default model is `gpt-6.1-sol`; existing saved model choices take precedence. Response speed remains independent: `serviceTier: "default"` is Standard, including legacy settings. Fast (`"priority"`) requires advertised model support and increases allowance consumption. Advanced options do not turn Fast on.

Verbosity expresses a preference, not a hard response-length limit. Reasoning summaries control public summaries, not reasoning effort or access to raw reasoning. A manual compaction threshold does not expand the model's context window. A small tool-output budget can truncate important result content.

默认模型为 `gpt-6.1-sol`，已有保存值优先。响应速度独立：`serviceTier: "default"` 为普通，旧配置也默认普通；`"priority"` 为快速，须有模型目录支持，并增加额度消耗。调整高级参数不会自动开启快速。详细程度不是硬长度限制；公开摘要不改变思考强度，也不提供原始思维链；手动压缩阈值不能扩大真实上下文上限；较小工具预算可能截断重要结果。

## Scope and inheritance / 作用域与继承

Settings has separate Management Agent and Task execution global groups. Each management conversation and business plugin can override its corresponding global values. Expand **Advanced model settings** in global settings, the chat model panel or plugin model settings; it starts collapsed. Changing models preserves speed and the four advanced options while resetting the model-dependent reasoning override.

Omit an override to inherit. For budgets, explicit `null` means the model's automatic budget, even when the global setting specifies a manual number. `null` does not mean zero. For example, if business global `toolOutputTokenLimit` is `4000`, plugin `execution: {}` inherits `4000`, while `execution: {"toolOutputTokenLimit": null}` selects automatic. Removing the property restores inheritance. A null `reasoningEffort` separately means the selected model's default effort.

Old global settings gain missing role defaults without replacing saved values or changing their revisions. Accepted tasks retain their plugin contracts. Each management message and business launch/resumption segment records its effective settings. Saving changes affects later turns or business segments, while current work keeps its snapshot.

四层设置分别是管理全局、当前管理对话、业务全局和业务插件。在相应页面展开默认收起的“高级模型参数”。覆盖省略字段时继承对应全局；预算显式 `null` 表示模型自动，可覆盖全局手动值，删除该属性才恢复继承。切换模型保留速度和四项参数，只重置与模型相关的思考覆盖。旧配置补角色默认且保留已有值及 revision；插件接单约定、管理消息和业务执行段保留快照，后续轮次或启动/恢复段使用新设置。

## Agent operations / 管理 Agent 操作

Choose the narrowest relevant scope. A request for the current conversation should use `conversation_execution`; a plugin-specific request should use `plugin_execution_update`. Change a global scope only for an explicit platform-wide goal. Read the schema, current values and model catalog before a change. Avoid unrelated model switches, budget reductions, hidden summaries or Fast routing.

`conversation_execution` with `{}` reads `execution`, `effective`, `revision` and `applies_to: "next_turn"`. Identity comes from the server's current MCP context; the tool accepts no conversation ID. A write must submit the complete desired override object and the latest revision. Preserve existing unrelated overrides: omitted fields are removed and return to inheritance. Read again after saving; the active message keeps its original execution snapshot.

For example, after reading current overrides `{"reasoningEffort":"high"}` and revision `R`, requesting a more detailed reply submits:

```json
{
  "execution": {"reasoningEffort": "high", "verbosity": "high"},
  "revision": "<latest 64-character content revision>"
}
```

The revision placeholder must be replaced with the exact returned value. Call `conversation_execution` with `{}` again to confirm the overrides and effective values. `execution: {}` deliberately clears all current overrides and also requires the latest revision. A conflict requires a fresh read and reconciliation with the user's request.

For a global change, use `configuration_get` on `manager` or `execution`, then `configuration_update` with a minimal `patch` and the returned revision, then read back. For a plugin, use `plugin_get`, submit the complete desired `execution` via `plugin_execution_update` with the plugin revision, then `plugin_get` again. Saving and reading back verifies stored configuration; it does not establish model effects, allowance or account entitlement.

管理 Agent 优先使用最小作用域：当前对话调用 `conversation_execution`，单个插件调用 `plugin_execution_update`，明确的平台级需求才修改全局。先读 schema、当前值和模型目录，再做必要修改并回读核对。当前对话工具不接收对话 ID，身份由服务端提供；不传 execution 时返回覆盖、有效值和内容 revision，修改时须带最新 revision 和完整覆盖对象，保留用户未要求改变的其他覆盖。省略属性会恢复继承，空对象会清空全部覆盖。当前消息不变，后续轮次生效。全局提交最小 patch，插件提交完整的新 execution；版本冲突先重读。保存成功不等于真实模型效果或账号资格已经验证。

## Codex mapping / Codex 映射

| Platform / 平台 | Fixed native config key / 固定 native 键 |
| --- | --- |
| `verbosity` | `model_verbosity` |
| `reasoningSummary` | `model_reasoning_summary`, plus explicit `turn/start.summary` / 并显式传入摘要 |
| `autoCompactTokenLimit` | `model_auto_compact_token_limit` |
| `toolOutputTokenLimit` | `tool_output_token_limit` |

Automatic budgets remain `null` in platform storage and APIs, but their native keys are omitted: pinned Codex **0.159.2 rejects native JSON null for these integer fields**. The platform starts a fresh Codex process per management turn or business execution segment, applying config at thread start/resume. Re-resuming an already-loaded thread in one process is not a supported config refresh. These options add no arbitrary config input or tool permissions.

The auth-free loopback tests in `tests/model-options-codex.test.mjs` use real Codex 0.159.2 processes. They verify verbosity `low → medium`, summaries `detailed → concise → none` (none omits the summary at the Responses boundary), successful automatic-budget resume and actual local MCP output truncation at a 256-token budget. They do not use an account or test live model behavior.

平台存储和 API 用 `null` 表示自动，传给固定 Codex 0.159.2 时省略预算 native 键，避免整数配置错误。管理每轮和业务每个执行段均用新进程，在 start/resume 应用配置；同进程重复恢复已加载线程不能作为刷新方式。这些参数不扩大任意配置或工具权限。固定版本的离线测试使用真实进程和无认证本地接收端，验证实际请求与工具截断；未使用真实账号，也不证明在线模型效果。
