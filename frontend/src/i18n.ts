// Interface copy only. Plugin definitions, prompts, task data and Agent replies
// remain untouched. The preference is local to this browser, not server config.
const english: Record<string, string> = {
  '请通过管理 Agent 修改复杂配置。':'Ask the management Agent to change complex configuration.',
  '定时计划配置':'Schedule configuration',
  '业务插件配置':'Business plugin configuration',
  '可在此启用或停用。新增和编辑定时任务，请通过管理 Agent 操作。':'Enable or disable schedules here. Ask the management Agent to create or edit them.',
  '可在此启用或停用。新增、编辑和试运行请通过管理 Agent 操作。':'Enable or disable plugins here. Ask the management Agent to create, edit or test them.',
  '启停业务插件：{name}':'Enable or disable plugin: {name}',
  '启停定时计划：{name}':'Enable or disable schedule: {name}',
  '触发受阻':'Trigger blocked',
  '计划详情':'Schedule details',
  '运行说明':'How schedules work',
  '下次触发':'Next run',
  '时间按每个计划设置的时区显示；新增或编辑请在管理对话中说明。':'Times use each schedule’s configured time zone. Ask in management chat to create or edit a schedule.',
  '前往管理对话':'Open management chat',
  '查看详情':'View details',
  '无效插件':'Invalid plugins',
  '继承默认设置':'Inherited defaults',
  '消息时间按此浏览器的本地时区显示。':'Message times use this browser’s local time zone.',
  '定时任务按 Cron 周期自动执行：业务任务调用指定插件处理固定输入；管理巡检把巡检要求交给管理 Agent，并在管理对话中保存结果。':'Schedules run automatically on a Cron cycle. Business tasks invoke a plugin with fixed input; inspections send instructions to the management Agent and save the results in management chat.',
  '例如：每天 09:00 检查队列与失败任务，Cron 为 0 9 * * *。触发时间以计划填写的时区为准；启用后实际执行会使用模型额度。':'For example, use 0 9 * * * to check queues and failed tasks daily at 09:00. The schedule’s configured time zone determines when it runs. Executions use model quota.',
  '部分产物暂时无法读取。':'Some artifacts are temporarily unavailable.',
  "Agent · 运行工作台": "Agent · Operations console",
  "从这里，了解并管理运行。": "Understand and manage your system.",
  "使用独立 Admin 密码登录，初始密码由部署时生成。":
    "Sign in with your separate Admin password, generated during deployment.",
  "Admin 密码": "Admin password",
  "输入 Admin 密码": "Enter Admin password",
  登录工作台: "Sign in",
  运行工作台: "Operations console",
  运行概览: "Overview",
  管理对话: "Management chat",
  任务记录: "Task history",
  业务插件: "Business plugins",
  定时计划: "Schedules",
  系统配置: "Settings",
  退出: "Sign out",
  刷新: "Refresh",
  界面语言: "Interface language",
  已连接: "Connected",
  管理服务已连接: "Manager connected",
  连接已断开: "Disconnected",
  请求失败: "Request failed",
  暂无记录: "No records yet",
  "正在读取…": "Loading…",
  "暂时无法读取，请查看提示或刷新。":
    "Unable to load. Check the message above or refresh.",
  排队中: "Queued",
  启动中: "Starting",
  运行中: "Running",
  提交中: "Submitting",
  等待恢复: "Awaiting recovery",
  执行完成: "Completed",
  执行失败: "Failed",
  接口已接收: "Endpoint accepted",
  结果未知: "Outcome unknown",
  无需交付: "No delivery required",
  等待交付: "Awaiting delivery",
  等待继续: "Awaiting continuation",
  操作中: "In progress",
  程序可用: "Available",
  已就绪: "Ready",
  未就绪: "Not ready",
  已启用: "Enabled",
  已停用: "Disabled",
  "采样于 {time}": "Sampled at {time} (UTC+8)",
  历史记录未保存详情: "No details saved in this historical record",
  查看调查: "View investigation",
  "让 Agent 调查": "Ask Agent to investigate",
  恢复领取: "Resume dispatch",
  暂停领取: "Pause dispatch",
  业务并发: "Task concurrency",
  保存: "Save",
  "并发设置已保存。": "Concurrency saved.",
  "重启 Runner": "Restart Runner",
  "已请求重启 Runner，请稍后刷新确认。":
    "Runner restart requested. Refresh shortly to check its status.",
  "状态来自实时采集与执行记录。点击异常，即可让管理 Agent 带着上下文调查。":
    "Live metrics and execution records. Ask the management Agent to investigate an error with its context.",
  "宿主 CPU": "Host CPU",
  采样中: "Sampling",
  不可用: "Unavailable",
  "宿主机 /proc · 整机占用": "Host /proc · whole-machine usage",
  未挂载或无法读取宿主指标: "Host metrics are not mounted or cannot be read",
  宿主内存: "Host memory",
  "总量 ": "Total ",
  正在执行: "Active tasks",
  "排队 ": "Queued ",
  " · 等待恢复 ": " · Awaiting recovery ",
  累计执行失败: "Failed executions",
  "执行完成 ": "Completed ",
  " · 业务结果单独查看": " · Check business outcomes separately",
  服务状态: "Service status",
  "业务执行和 HTTP 交付分别记录。":
    "Task execution and HTTP delivery are tracked separately.",
  "Manager 容器内存 ": "Manager container memory ",
  " · 数据磁盘可用 ": " · Data disk available ",
  最近执行异常: "Recent execution errors",
  "业务 / 任务": "Type / Task",
  原因: "Reason",
  "时间（北京时间）": "Time (UTC+8)",
  操作: "Actions",
  调度设置: "Dispatch settings",
  "Gateway 暂时不可用，管理服务仍在运行。":
    "Gateway is unavailable. Manager is still running.",
  "Runner 尚未登录 ChatGPT，请按安装文档完成 Codex 登录。":
    "Runner is not signed in to ChatGPT. Follow the installation guide to sign in to Codex.",
  "Codex 暂不可用，请检查 Runner 日志。":
    "Codex is unavailable. Check the Runner logs.",
  "调查 ": "Investigate ",
  "＋ 新对话": "+ New chat",
  新对话: "New chat",
  "告诉我你想了解或处理什么，例如：查询失败任务并说明原因。":
    "Describe what you want to know or do, such as finding failed tasks and explaining their causes.",
  消息: "Message",
  发送: "Send",
  "可以自由提问，也可以让 Agent 创建插件、试运行、管理计划或处理指定任务。Ctrl / ⌘ + Enter 发送。":
    "Ask questions or have the Agent create plugins, run trials, manage schedules or handle a task. Press Ctrl / ⌘ + Enter to send.",
  "你 · ": "You · ",
  "管理 AGENT": "MANAGEMENT AGENT",
  "从一个问题开始。状态、异常和业务插件，都可以在这里管理。":
    "Start with a question. Manage status, errors and business plugins here.",
  任务状态: "Task status",
  全部状态: "All statuses",
  搜索请求编号或输入内容: "Search request ID or input content",
  搜索任务: "Search tasks",
  查询: "Search",
  "请求编号：{id}": "Request ID: {id}",
  详情: "Details",
  调查: "Investigate",
  上一页: "Previous",
  下一页: "Next",
  "从第 {start} 条开始 · 本页 {count} 条":
    "Starting at {start} · {count} on this page",
  "执行完成不等于所有业务项都成功。查看详情可区分最终结果、具体错误与交付状态。":
    "A completed execution may contain unsuccessful business items. Open details to check results, errors and delivery status.",
  执行记录: "Execution history",
  执行状态: "Execution status",
  错误: "Error",
  创建时间: "Created",
  "让 Agent 查看": "Ask Agent to inspect",
  重新执行任务: "Run a new task",
  "已创建新任务 ": "Created new task ",
  "，原记录保留。": ". The original record is retained.",
  任务详情: "Task details",
  "HTTP accepted 表示接口接收；业务端异步保存是否成功，以业务端记录为准。":
    "HTTP accepted means the endpoint received the request. Check the receiving system to confirm any asynchronous save.",
  任务图片: "Task image",
  下载文本产物: "Download text artifact",
  编辑: "Edit",
  停用: "Disable",
  启用: "Enable",
  已注册业务: "Registered plugins",
  业务: "Business",
  状态: "Status",
  说明: "Description",
  插件定义: "Plugin definition",
  "兼容模块：": "Compatibility modules: ",
  管理巡检: "Management inspection",
  业务任务: "Business task",
  业务类型: "Task type",
  "业务输入 JSON": "Task input JSON",
  巡检要求: "Inspection instructions",
  计划名称: "Schedule name",
  触发对象: "Trigger type",
  时区: "Time zone",
  "停机期间错过的计划在恢复后执行一次，再进入下个正常时刻。每次触发都是独立任务，执行受统一并发设置控制。":
    "A schedule missed during downtime runs once on recovery, then returns to its normal timetable. Each trigger is an independent task subject to the shared concurrency setting.",
  计划: "Schedule",
  规则: "Rule",
  "已配置，留空保持原值": "Configured; leave blank to keep",
  尚未配置: "Not configured",
  "清除 ": "Clear ",
  " 清除已保存凭证": " Clear saved credential",
  保存配置: "Save settings",
  "已配置凭证：": "Configured credentials: ",
  "。省略字段保留原值，显式空值表示清除。":
    ". Omit a field to keep its value; explicitly empty values clear it.",
  "没有需要保存的修改。": "No changes to save.",
  "已保存，Runner 暂时不可用，恢复后自动同步。":
    "Saved. Runner is unavailable; settings will sync when it returns.",
  "已保存，配置按本组说明生效。":
    "Saved. Changes take effect as described for this group.",
  "修改 Admin 密码": "Change Admin password",
  "修改后所有网页会话退出，请使用新密码重新登录。业务入口密钥保持独立。":
    "Changing the password signs out all browser sessions. Sign in again with the new password. The API ingress key is separate.",
  "新密码（至少12个字符）": "New password (at least 12 characters)",
  再次输入新密码: "Confirm new password",
  "两次密码不一致。": "The passwords do not match.",
  "密码已修改，请重新登录。": "Password changed. Please sign in again.",
  "配置持久保存在服务端，页面和管理 Agent 使用相同接口。修改无需重启，正在执行的任务保留自己的参数。密钥只写不读。":
    "Settings are stored on the server. This console and the management Agent use the same API. Live changes need no restart; active tasks keep their parameters. Secrets are write-only.",
  "Gateway 暂时不可用，仍可调整管理 Agent 和 Admin 配置。":
    "Gateway is unavailable. You can still change Manager and Admin settings.",
  部署配置: "Deployment settings",
  业务执行: "Task execution",
  业务模型: "Task model",
  队列上限: "Queue limit",
  "任务超时（毫秒）": "Task timeout (ms)",
  "工具超时（毫秒）": "Tool timeout (ms)",
  "调度设置立即生效。模型和超时用于下一次启动/恢复，不中断当前执行。":
    "Dispatch changes take effect immediately. Model and timeout changes apply at the next start or recovery without interrupting active tasks.",
  "外部 API 鉴权": "External API authentication",
  "新密钥立即用于外部 API；Admin 使用独立密码。":
    "New keys apply immediately to the external API. Admin uses a separate password.",
  入口密钥: "Ingress key",
  "HTTP 目标": "HTTP targets",
  目标地址: "Target URL",
  凭证: "Credential",
  "超时（毫秒）": "Timeout (ms)",
  "下一工具调用或尚未发送的交付使用新目标；省略已有目标的 token 保留凭证，删除目标名称则移除目标。":
    "New targets apply to the next tool call or unsent delivery. Omit an existing target token to keep it; remove the target name to delete the target.",
  "管理 Agent": "Management Agent",
  管理模型: "Manager model",
  "管理轮次超时（毫秒）": "Manager turn timeout (ms)",
  "管理工具超时（毫秒）": "Manager tool timeout (ms)",
  管理提示词: "Manager instructions",
  "巡检轮询间隔（毫秒）": "Inspection polling interval (ms)",
  "模型、提示词和超时用于下一轮。巡检轮询间隔动态生效，不打断当前对话。":
    "Model, instructions and timeouts apply to the next turn. Inspection polling changes apply immediately without interrupting the current conversation.",
  "Admin 会话": "Admin sessions",
  "登录有效期（毫秒）": "Session lifetime (ms)",
  "登录会话有效期用于下一次登录；修改密码通过独立密码操作。":
    "The session lifetime applies to the next sign-in. Use the separate password action to change your password.",
  "服务监听及容器端口映射，修改后需重新部署。":
    "Service listening ports and container port mappings require redeployment.",
  "数据库、卷、认证及已安装资料路径；涉及挂载或迁移，需部署调整。插件可热选择已注册资源。":
    "Database, volume, authentication and installed resource paths require deployment changes or migration. Plugins can select registered resources live.",
  "服务间连接与引导凭证，需要协调部署；不通过配置接口返回凭证。":
    "Service connections and bootstrap credentials require coordinated deployment. Credentials are never returned by the configuration API.",
  "请提供有效的五字段 cron 和 IANA 时区。":
    "Provide a valid five-field cron expression and IANA time zone.",
  "找不到定时计划。": "Schedule not found.",
  "name 和 kind 不正确。": "Provide a valid schedule name and kind.",
  "id 不正确。": "Invalid ID.",
  "enabled 必须为布尔值。": "The enabled field must be a boolean.",
  "业务输入不符合插件 input_schema。":
    "Task input does not match the plugin input_schema.",
  "巡检需要 message。": "Inspection schedules require a message.",
  "巡检记录和管理会话编号不正确。":
    "Invalid inspection or management conversation ID.",
  "无法连接 Gateway，操作结果可能未知，请查询记录。":
    "Cannot connect to Gateway. The operation outcome may be unknown; inspect current records before retrying.",
  "管理操作失败。": "Management operation failed.",
  "管理操作或参数不正确。": "Invalid management operation or parameters.",
  "找不到配置组。": "Settings group not found.",
  "配置修改须为 JSON 对象。": "Settings changes must be a JSON object.",
  "密码服务不可用。": "Password service is unavailable.",
  认证失败: "Authentication failed",
  请求过大: "Request is too large",
  "JSON 格式不正确": "Invalid JSON",
  服务暂不可用: "Service is temporarily unavailable",
  请求字段不正确: "Invalid request fields",
  "该插件使用通用任务结果，请通过 tasks/task 查询结构化结果。":
    "This plugin uses generic task results. Query structured results through tasks/task.",
  "密码不正确或登录已过期。": "Incorrect password or expired session.",
  "密码须为12至1024个字符。": "Use a password with 12 to 1024 characters.",
  "请使用 Admin 密码登录。": "Please sign in with your Admin password.",
  "找不到接口。": "Endpoint not found.",
  "拒绝跨来源管理操作。": "Cross-origin management operations are not allowed.",
  "任务编号不正确。": "Invalid task ID.",
  "未知管理操作。": "Unknown management operation.",
  "找不到管理会话。": "Management conversation not found.",
  "消息不能为空。": "Enter a message.",
  "找不到业务插件。": "Business plugin not found.",
  "该类型由现有兼容模块提供。":
    "This type is reserved by a compatibility module.",
  '模型':'Model',
  '思考程度':'Reasoning effort',
  '继承全局设置':'Inherit global settings',
  '模型默认':'Model default',
  '所选模型默认':'Selected model default',
  '当前保存值：{value}':'Saved value: {value}',
  '保存对话配置':'Save conversation settings',
  '对话配置已保存':'Conversation settings saved',
  '模型列表暂不可用，保留当前配置。请检查 Codex 登录和服务连接后刷新。':'Model list unavailable. Current settings are preserved. Check Codex login and connectivity, then refresh.',
};
let locale = "zh-CN";
try {
  if (localStorage.getItem("agent-console-language") === "en") locale = "en";
} catch {}
export function getLocale() {
  return locale;
}
export function setLocale(value: string) {
  locale = value === "en" ? "en" : "zh-CN";
  try {
    localStorage.setItem("agent-console-language", locale);
  } catch {}
  return locale;
}
export function t(key: string, parameters: Record<string, string | number> = {}) {
  const prefixed =
    typeof key === "string" ? key.match(/^([A-Z_]+): (.*)$/s) : null;
  const text =
    locale === "en"
      ? (english[key] ??
        (prefixed && english[prefixed[2]]
          ? prefixed[1] + ": " + english[prefixed[2]]
          : key))
      : key;
  return typeof text === "string"
    ? text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.hasOwn(parameters, name) ? String(parameters[name]) : match,
      )
    : text;
}
