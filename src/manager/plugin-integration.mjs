import {schemaDocumentation} from './schema-documentation.mjs';

const md=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replace(/[\\`*_[\]{}|#]/g,'\\$&').replace(/\r?\n/g,' ');
const json=value=>JSON.stringify(value,null,2);
const code=(value,language='json')=>{const text=String(value),fence='`'.repeat(Math.max(3,...[...text.matchAll(/`+/g)].map(match=>match[0].length+1)));return `${fence}${language}\n${text}\n${fence}`;};
const shell=value=>"'"+String(value).replaceAll("'","'\\''")+"'";

// Manager-owned human presentation: whitelist public metadata, independent of the plugin compiler.
export function buildPluginIntegration(definition,connection,{locale='zh-CN'}={}) {
  locale=locale==='en'?'en':'zh-CN';const text=(zh,en)=>locale==='en'?en:zh;
  const table=rows=>[`| ${text('字段','Field')} | ${text('类型','Type')} | ${text('说明','Meaning')} |`,'| --- | --- | --- |',...rows.map(row=>'| '+row.map(md).join(' | ')+' |')].join('\n');
  const input=schemaDocumentation(definition.input_schema),result=schemaDocumentation(definition.result_schema);
  const address=connection.entryAddress??connection.entryPath;
  let origin='https://<gateway-host>',entry=address?origin+address:'https://<gateway-host>/<entry-path>';
  if(address&&/^https?:\/\//i.test(address)){const url=new URL(address);origin=url.origin;entry=address;}
  const request={request_id:'integration-example-1',input:input.example.value},standard={type:definition.type,...request};
  const taskId='00000000-0000-4000-8000-000000000001',timestamp=1700000000000;
  const accepted={task_id:taskId,type:definition.type,module_version:'configuration-v1',retry_of:null,created_at:timestamp,updated_at:timestamp,status:'queued',result:null,error:null,errors:[],execution:null,delivery:{status:'not_required'},duplicate:false};
  const complete={...accepted,status:'completed',result:result.example.value,execution:{run_id:'00000000-0000-4000-8000-000000000002'},artifacts:[]};delete complete.duplicate;
  const callback={task_id:taskId,request_id:request.request_id,type:definition.type,status:'completed',result:result.example.value,error:null,artifacts:[]};
  const fields=(schemaDoc)=>[
    `| ${text('字段路径','Field path')} | ${text('类型','Type')} | ${text('必填','Required')} | ${text('说明','Description')} | ${text('约束','Constraints')} |`,
    '| --- | --- | --- | --- | --- |',
    ...schemaDoc.rows.map(row=>`| ${md(row.path||'$')} | ${md(row.type)} | ${row.required===null?'—':row.required?text('是','Yes'):text('否','No')} | ${md(row.description||text('未提供说明','No description supplied'))} | ${md(json(row.constraints).slice(0,600))} |`),
    '',text('必填相对于所在对象；父对象可选时，内部必填字段仅在该对象存在时适用。复杂组合、条件和递归约束以完整 JSON Schema 为准。字段表为有界摘要，较长约束请看完整 Schema。','Required is relative to the containing object; required children of an optional parent apply when that parent is present. Complete JSON Schema is authoritative for combinations, conditions and recursion. The field table is a bounded summary; inspect the full schema for long constraints.'),
    '',code(json(schemaDoc.schema)),
  ].join('\n');
  const curl=(url,body)=>`curl --request POST ${shell(url)} \\\n  --header "Authorization: Bearer \${PLUGIN_ENTRY_KEY}" \\\n  --header 'Content-Type: application/json' \\\n  --data-raw ${shell(json(body))}`;
  const exampleNote=text('以下仅为合成示例，不会自动执行。实际调用会创建任务并消耗账户额度。用配置接入中人工保存的入口密钥设置 PLUGIN_ENTRY_KEY；请勿把密钥发给管理 Agent。','These are synthetic examples and are never executed automatically. A real call creates work and uses account allowance. Set PLUGIN_ENTRY_KEY to the human-configured entry key; do not send credentials to the management Agent.');
  const unavailable=text('无法自动生成符合完整 Schema 的示例，请按 Schema 手动构造，或通过管理 Agent 补充可校验的 examples。','A schema-valid example is unavailable; construct it from the complete schema or ask the management Agent to supply valid examples.');
  const sections=[
    {key:'overview',title:text('对接概览','Overview'),markdown:[
      `# ${md(definition.name)} · ${md(definition.type)}`,
      md(definition.description),
      text('## 通信协议','## Protocol'),
      text('HTTP(S) + UTF-8 JSON；异步任务协议。提交成功返回 HTTP 202 和任务编号，不是同步返回 AI 最终结果。业务 API 没有聊天流式协议；请查询任务或接收可选最终回调。','HTTP(S) + UTF-8 JSON with asynchronous tasks. HTTP 202 returns task metadata, not the final AI result. The business API is not the chat streaming protocol; query the task or receive an optional final callback.'),
      [`| ${text('用途','Purpose')} | ${text('方法','Method')} | URL |`, '| --- | --- | --- |',
      `| ${text('插件入口','Plugin entry')} | POST | ${md(entry)} |`,
      `| ${text('统一入口（需 type）','Standard entry (type required)')} | POST | ${md(origin+'/v2/tasks')} |`,
      `| ${text('查询任务','Query task')} | GET | ${md(origin+'/v2/tasks/{task_id}')} |`,
      `| ${text('下载产物','Download artifact')} | GET | ${md(origin+'/v2/tasks/{task_id}/artifacts/{artifact_id}')} |`].join('\n'),
      address?.startsWith('/')?text('目前仅保存了相对入口路径。请将 <gateway-host> 替换为真实业务 Gateway 域名或地址；Admin 域名/端口不一定是业务入口。保存 URL 不会自动配置 DNS、TLS 或反向代理。','Only a relative entry path is saved. Replace <gateway-host> with the actual business Gateway host; the Admin host/port may differ. Saving a URL does not provision DNS, TLS or a reverse proxy.'):'',
      connection.ready?text('接入必填项已配置。','Required connection fields are configured.'):text('接入尚未完成：请到「配置接入」由人填写入口地址和入口密钥，再单独启用；未就绪时不能提交任务。','Connection setup is incomplete: a human must configure the entry address/key in Configure connection, then enable the plugin separately. Admission is blocked until setup is ready.'),
      definition.enabled===false?text('当前插件已停用，启用后才能接收新请求。','This plugin is disabled; enable it to admit new requests.'):text('插件当前已启用；实际执行仍受暂停、队列、并发及 Runner 就绪状态约束。','This plugin is enabled; execution still depends on pause, queue/capacity and Runner readiness.'),
      text('所有上述业务接口使用当前插件的 Authorization: Bearer <PLUGIN_ENTRY_KEY>。该密钥只能提交和查询本插件任务、下载本插件产物；与 Admin 密码、其他插件密钥和可选回调凭证分别独立。','All listed business endpoints require this plugin\'s current Authorization: Bearer <PLUGIN_ENTRY_KEY>. The key is scoped to its tasks and artifacts, separate from the Admin password, other plugins and optional callback credentials.'),
      text('请求头 Content-Type: application/json；JSON 请求体上限 1 MiB，反向代理可能有更低限制。正式公网接入应使用 HTTPS。','Use Content-Type: application/json. JSON bodies are limited to 1 MiB; a proxy may impose a lower limit. Use HTTPS for public integrations.'),
    ].filter(Boolean).join('\n\n')},
    {key:'request',title:text('请求参数','Request'),markdown:[
      text('## 请求封装','## Request envelope'),
      text('插件入口只接收 request_id 和 input；统一 /v2/tasks 入口还必须提供 type。request_id 为调用方关联编号（非空字符串，最多 128 字符），不是去重键。每次 POST 都创建独立任务，重复 request_id 也不去重；网络超时后盲目重发可能产生重复业务。input 是插件 Schema 定义的 JSON 值，可以是对象、数组或标量。','The plugin entry accepts only request_id and input; /v2/tasks also requires type. request_id is a caller correlation ID (nonempty string, at most 128 characters), not a deduplication key. Every POST creates independent work even with the same request_id; blind retries after a timeout can duplicate business effects. input is the JSON value defined by the plugin schema, including objects, arrays or scalars.'),
      table([
        ['request_id','string',text('必填；调用方关联编号，非空且最多 128 字符，不去重。','Required; nonempty caller correlation ID up to 128 characters; no deduplication.')],
        ['input','JSON',text('按下方插件输入 Schema 提供。','Supply the plugin input defined by the schema below.')],
        ['type','string',text('仅统一入口 /v2/tasks 必填，必须等于 '+definition.type+'；插件入口不接受此字段。','Required only for /v2/tasks; must equal '+definition.type+'. The plugin-specific entry does not accept it.')],
      ]),
      text('## input 字段','## input fields'),fields(input),exampleNote,
      input.example.available?code(curl(entry,request),'bash'):unavailable,
      input.example.available?text('统一入口示例：','Standard-entry example:'):'',
      input.example.available?code(curl(origin+'/v2/tasks',standard),'bash'):'',
      text('没有业务字段说明时，请让管理 Agent 补充 input_schema / result_schema 中的 description 和 examples；文档不会凭空解释业务含义。','Ask the management Agent to add description and examples annotations to input_schema/result_schema when meaning is missing; the document does not invent business semantics.'),
    ].filter(Boolean).join('\n\n')},
    {key:'response',title:text('响应与查询','Response and query'),markdown:[
      text('## HTTP 202：已接单','## HTTP 202: admission'),code(json(accepted)),
      text('task_id 是后续查询依据，示例 UUID 和时间均为合成值，请保存真实响应中的编号。duplicate:false 不表示幂等保证。created_at/updated_at 是 Unix 毫秒时间。首次接单通常 queued，result/error 可能为 null；不要把已接单当成已完成。','Save the real response task_id for subsequent queries; example UUIDs/timestamps are synthetic. duplicate:false does not provide idempotency. created_at/updated_at are Unix milliseconds. New work is normally queued with null result/error; acceptance is not completion.'),
      table([
        ['task_id','string (UUID)',text('本次独立任务编号，用于查询和下载。','Unique independent task identity for queries/downloads.')],
        ['type','string',text('所属业务插件类型。','Business plugin type.')],
        ['module_version','string',text('执行实现的版本标识，与文档显示的插件定义修订号不同。','Execution implementation version, distinct from the plugin definition revision.')],
        ['retry_of','string (UUID) | null',text('显式重试关联的原任务；普通新请求为 null。','Original task for an explicit related retry; null for ordinary new requests.')],
        ['created_at / updated_at','number',text('Unix 毫秒时间戳。','Unix timestamps in milliseconds.')],
        ['status','string',text('任务生命周期状态，见下方状态说明。','Task lifecycle state; see below.')],
        ['result','JSON | null',text('业务输出，按 result_schema 解释；未产生结果时通常为 null。','Business output governed by result_schema; usually null before a result exists.')],
        ['error','object | null',text('任务错误；对象可包含 code、message。','Task failure; object may include code and message.')],
        ['errors','array',text('运行/工具错误历史，历史错误不表示最终业务一定失败。','Execution/tool error history; historical errors do not necessarily mean final failure.')],
        ['execution','object | null',text('执行编号及可用的运行状态信息。','Run identity and available execution metadata.')],
        ['delivery','object',text('交付状态；status 可为 not_required、pending、accepted、failed、unknown、blocked_configuration，可附带 http_status/error_code。','Delivery status: not_required, pending, accepted, failed, unknown or blocked_configuration, with optional http_status/error_code.')],
        ['duplicate','boolean',text('仅接单响应；当前为 false，每次请求独立。','Admission only; currently false because each request is independent.')],
        ['artifacts','array',text('查询响应附带的产物元数据；接单响应不包含此字段。','Artifact metadata on query responses; not included in admission responses.')],
        ['blocked_reason','string',text('查询时可选的排队阻塞原因。','Optional queue blocking reason on queries.')],
      ]),
      text('## 查询和状态','## Query and lifecycle'),
      code(`curl ${shell(origin+'/v2/tasks/')}"\${TASK_ID}" --header "Authorization: Bearer \${PLUGIN_ENTRY_KEY}"`,'bash'),
      text('将 TASK_ID 设置为提交响应中的 task_id。查询成功返回 HTTP 200；状态包括 queued、dispatching、running、completing、suspended、completed、failed。completed/failed 是执行终态，不会自动重新执行；completed 不代表业务结论一定成功。result 仅按当前任务接单时保存的 result_schema 解释，可能是合法的 null。error/errors 说明运行或工具错误，delivery 说明独立的回调交付状态。queued 可能返回 blocked_reason。查询接口不返回 request_id，请由调用方保存 task_id 与原请求的关联。','Set TASK_ID to the admission response task_id. Successful queries return HTTP 200. States are queued, dispatching, running, completing, suspended, completed and failed. completed/failed are terminal and do not automatically rerun; completed does not guarantee a positive business conclusion. Interpret result using the schema saved at task admission; null can be a valid result. error/errors describe execution/tool failures, delivery is independent callback delivery, and queued work may have blocked_reason. The query API does not return request_id; retain your task-to-request mapping.'),
      result.example.available?code(json(complete)):unavailable,
      text('## result 字段','## result fields'),fields(result),
      text('## 产物下载','## Artifact download'),
      text('artifacts 返回产物元数据（如 artifact_id、filename、mime）；正文/图片字节通过下方接口取得，响应 Content-Type 取决于文件类型。使用真实查询/回调返回的 artifact_id，不使用示例或猜测的编号。','artifacts contains metadata such as artifact_id, filename and mime. Download bytes from the endpoint below; Content-Type depends on the file. Use actual returned artifact IDs, never guessed or example IDs.'),
      code(`GET ${origin}/v2/tasks/{task_id}/artifacts/{artifact_id}\nAuthorization: Bearer <PLUGIN_ENTRY_KEY>`,'http'),
    ].join('\n\n')},
    {key:'callback',title:text('回调协议','Callback'),markdown:[
      text('## 可选的最终回调','## Optional final callback'),
      connection.callbackUrl?text('本插件已配置回调地址。地址和凭证不写入可分享文档，请在「配置接入」查看或修改。','A callback receiver is configured. Its address and credentials are omitted from this shareable document; inspect/edit them in Configure connection.'):text('本插件未配置回调。回调可以不配置，调用方可轮询查询任务；无回调时 delivery.status 为 not_required。','No callback is configured. It is optional; poll the task instead. Without a callback, delivery.status is not_required.'),
      text('入口密钥和回调凭证用途不同：入口密钥由调用方访问平台；回调凭证由平台访问你的接收端。由人按插件分别配置，不经 Agent。','Entry keys authorize callers to the platform; callback credentials authorize the platform to your receiver. Humans configure these separately per plugin, outside Agent chat.'),
      code(`POST <YOUR_CALLBACK_RECEIVER>\nContent-Type: application/json${connection.callbackTokenConfigured?'\nAuthorization: Bearer <CALLBACK_CREDENTIAL>':''}`,'http'),
      text('仅在人工配置回调凭证时发送 Authorization Bearer 头；未配置时不发送。当前协议没有 HMAC 签名头，也不是双向 WebSocket 或流式聊天协议。','The Authorization Bearer header is sent only when a human configured a callback credential. Otherwise it is omitted. There is no HMAC signature header, bidirectional WebSocket or chat streaming protocol.'),
      result.example.available?code(json(callback)):text('回调 JSON 字段：task_id、request_id、type、status、result、error、artifacts。result 严格按上方 Schema；当前无法生成完整业务结果示例。','Callback JSON fields: task_id, request_id, type, status, result, error, artifacts. result follows the schema above; a complete result example cannot be generated.'),
      text('接收端应尽快返回 HTTP 2xx；平台只依据 HTTP 状态判定 accepted，不解析成功响应体，也不保证对方已入库。非 2xx（含重定向）记为 failed，网络结果不明确记为 unknown；不会自动重发未知回调，不能保证远端恰好处理一次。接收端建议按 task_id 幂等处理，request_id 可能在不同任务之间重复。交付与业务执行状态独立；可从任务查询的 delivery 中检查。','Return HTTP 2xx promptly. accepted means only an HTTP acceptance; no success response-body schema is required and storage is not guaranteed. Non-2xx responses, including redirects, are failed; ambiguous network outcomes are unknown and are not automatically replayed. Exactly-once remote effects are not guaranteed. Make the receiver idempotent by task_id; request_id may repeat across distinct tasks. Delivery is independent of execution; inspect delivery on task queries.'),
      text('回调仅包含产物元数据，不携带文件字节；仍需使用本插件入口密钥下载产物。尚未发送的回调读取当前人工配置。','Callbacks include artifact metadata, not file bytes; downloads still require this plugin\'s entry key. Pending callbacks resolve the current human connection settings.'),
    ].join('\n\n')},
    {key:'errors',title:text('错误与约定','Errors and conventions'),markdown:[
      text('## HTTP 错误','## HTTP errors'),
      [`| HTTP | code | ${text('含义','Meaning')} |`, '| --- | --- | --- |',
      `| 400 | INVALID_INPUT / INVALID_JSON | ${text('字段或 JSON 不符合约定','Invalid fields/schema or malformed JSON')} |`,
      `| 401 | UNAUTHORIZED | ${text('缺少、失效或错误的插件入口密钥','Missing, rotated or invalid plugin entry key')} |`,
      `| 403 | PLUGIN_SCOPE_DENIED | ${text('该密钥不属于目标插件','Key does not belong to the target plugin')} |`,
      `| 404 | NOT_FOUND | ${text('路径、任务或产物不存在，或不属于该插件','Unknown path/task/artifact or outside the plugin scope')} |`,
      `| 409 | PLUGIN_DISABLED / PLUGIN_CONNECTION_NOT_READY | ${text('插件未启用或未完成人工接入','Plugin disabled or human connection setup incomplete')} |`,
      `| 413 / 415 | PAYLOAD_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE | ${text('请求过大或未使用 application/json','Body too large or Content-Type is not application/json')} |`,
      `| 503 | QUEUE_FULL / SERVICE_UNAVAILABLE | ${text('队列满或服务暂不可用','Queue full or service unavailable')} |`].join('\n'),
      code(json({error:{code:'INVALID_INPUT',message:text('请求字段不正确','Invalid request fields')}})),
      text('字段及示例来自当前插件定义；修改插件后，重新打开文档取得最新版本。已接单任务保留当时约定，不应按后来更新的 Schema 重新解释历史结果。文档不会自动执行请求、生成密钥或修改接入配置。','Fields/examples come from the current plugin definition; reopen after edits for a fresh version. Accepted tasks retain their admission contract; do not reinterpret historical results using later schemas. Reading documentation does not submit tasks, generate keys or edit connections.'),
    ].join('\n\n')},
  ];
  return {type:definition.type,name:definition.name,revision:definition.revision,connectionRevision:connection.revision,locale,generated_at:Date.now(),ready:!!connection.ready,sections,markdown:sections.map(section=>section.markdown).join('\n\n---\n\n'),examples:{input:input.example.value,result:result.example.value},exampleAvailability:{input:input.example.available,result:result.example.available}};
}
