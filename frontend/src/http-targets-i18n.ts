import {registerEnglish} from './i18n.ts';

registerEnglish({
  '供 Agent 主动请求网站或接口使用，与插件入口和结果回调独立。保存后下一次工具调用立即使用新配置，不会自动发送请求。省略 token 保留凭证，空字符串清除凭证。':'For Agent requests to websites or APIs, separate from plugin entry settings and result callbacks. Changes apply to the next tool call; saving does not send a request. Omit token to retain the credential; an empty string clears it.',
  '新增 HTTP 目标':'Add HTTP target',
  '编辑 HTTP 目标':'Edit HTTP target',
  '编辑 HTTP 目标：{name}':'Edit HTTP target: {name}',
  '删除 HTTP 目标：{name}':'Delete HTTP target: {name}',
  '暂无 HTTP 目标':'No HTTP targets',
  '目标名称已存在，请使用其他名称。':'This target name already exists. Choose another name.',
  '请输入目标名称。':'Enter a target name.',
  '请输入目标地址。':'Enter a target URL.',
  '请输入超时时间。':'Enter a timeout.',
  '名称只能包含英文字母、数字、下划线和短横线。':'Use letters, digits, underscores and hyphens only.',
  '请填写完整的 HTTPS 地址，或本机 HTTP 地址。':'Enter a full HTTPS URL, or a loopback HTTP URL.',
  'HTTP 目标已保存，下一次工具调用立即生效。':'HTTP target saved. The next tool call uses this configuration.',
  '例如将 health_check 指向 https://example.invalid/health，业务 Agent 可通过该名称调用 HTTP 工具。凭证请在此填写，不要发送到管理对话。':'For example, point health_check at https://example.invalid/health so business Agents can call the HTTP tool by that name. Enter credentials here, not in management chat.',
  '删除后 Agent 无法再通过该名称发起请求。已发出的请求和插件结果回调不受影响。':'Agents can no longer request this named target. Requests already sent and plugin result callbacks are unaffected.',
  '选填。请求时由平台通过 Authorization: Bearer 注入；已保存凭证不会回显，留空保留原值。':'Optional. The platform injects Authorization: Bearer when requesting. Saved credentials are never returned; leave blank to keep the current value.',
  '请关闭此窗口后重新打开，读取最新目标配置再修改。':'Close and reopen this window to edit the latest target configuration.',
  "HTTP 目标": "HTTP targets",
  "超时（毫秒）": "Timeout (ms)",
});
