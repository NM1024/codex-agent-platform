const state={authenticated:false,view:'overview',chatId:null,draft:'',urls:[],taskOffset:0,taskFilter:{},conversationSignature:''};
const $=selector=>document.querySelector(selector);
const titles={overview:'运行概览',chat:'管理对话',tasks:'任务记录',plugins:'业务插件',schedules:'定时计划',settings:'系统配置'};
const labels={queued:'排队中',dispatching:'启动中',running:'运行中',completing:'提交中',suspended:'等待恢复',completed:'执行完成',failed:'执行失败',accepted:'接口已接收',unknown:'结果未知',not_required:'无需交付',pending:'等待交付',interrupted:'等待继续',executing:'操作中'};
function node(tag,attrs={},...children){const element=document.createElement(tag);for(const [key,value]of Object.entries(attrs)){if(key.startsWith('on'))element.addEventListener(key.slice(2),value);else if(key==='class')element.className=value;else if(key==='text')element.textContent=value;else if(key==='value')element.value=value;else if(value!==undefined&&value!==false)element.setAttribute(key,value===true?'':value);}for(const child of children.flat(Infinity))if(child!==null&&child!==undefined)element.append(child instanceof Node?child:document.createTextNode(String(child)));return element;}
const time=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value)):'—';
const bytes=value=>value===undefined||value===null?'—':value>=1073741824?(value/1073741824).toFixed(1)+' GB':value>=1048576?(value/1048576).toFixed(0)+' MB':value+' B';
const pretty=value=>JSON.stringify(value,null,2);
function badge(status){return node('span',{class:'badge '+(['failed','unknown'].includes(status)?'error':['queued','suspended','pending','interrupted','未就绪'].includes(status)?'warn':'')},labels[status]??status);}
function notice(text){$('#notice').textContent=text;$('#notice').classList.toggle('hidden',!text);}
function resetLogin(){state.authenticated=false;$('#workspace').classList.add('hidden');$('#login').classList.remove('hidden');$('#password').value='';}
async function logout(){try{await api('/logout',{});}finally{resetLogin();}}
async function api(path,body){const response=await fetch('/admin/api'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok){if(response.status===401)resetLogin();throw new Error(value.error?.message??value.error?.code??'请求失败');}return value;}
const operation=(action,args={})=>api('/operations',{action,args});
async function busy(button,fn){button.disabled=true;try{return await fn();}catch(error){notice(error.message);}finally{button.disabled=false;}}
function panel(title,content,action){return node('div',{class:'panel'},node('div',{class:'panel-head'},node('h2',{},title),action??null),content);}
function table(heads,rows){return node('div',{class:'table-wrap'},node('table',{},node('thead',{},node('tr',{},heads.map(text=>node('th',{},text)))),node('tbody',{},rows.length?rows:node('tr',{},node('td',{colspan:heads.length,class:'empty'},'暂无记录')))));}
function button(text,fn,secondary=false){return node('button',{class:secondary?'secondary':'',onclick:event=>busy(event.currentTarget,fn)},text);}
async function switchView(view){state.view=view;state.urls.forEach(URL.revokeObjectURL);state.urls=[];$('#page-title').textContent=titles[view];document.querySelectorAll('[data-view]').forEach(item=>item.classList.toggle('selected',item.dataset.view===view));notice('');$('#view').replaceChildren(node('div',{class:'empty'},'正在读取…'));try{await renderers[view]();}catch(error){notice(error.message);$('#view').replaceChildren(node('div',{class:'empty'},'暂时无法读取，请查看提示或刷新。'));}}
async function overview(){
  const data=await api('/overview');if(state.view!=='overview')return;$('#updated').textContent='采样于 '+time(data.resources.sampled_at??data.sampled_at);
  const platform=data.platform,resources=data.resources,host=resources.host??{},counts=platform.tasks??{},active=(counts.running??0)+(counts.dispatching??0)+(counts.completing??0);
  const card=(label,value,note)=>node('div',{class:'card'},node('div',{class:'card-label'},label),node('div',{class:'card-value'},value),node('div',{class:'card-note'},note));
  const services=node('div',{class:'service-grid'},node('div',{class:'service'},'Manager',badge('程序可用')),node('div',{class:'service'},'Gateway',badge(platform.unavailable?'failed':'程序可用')),node('div',{class:'service'},'Codex Runner',badge(platform.unavailable?'unknown':platform.runner?.ready?'已就绪':'未就绪')));
  const errors=(platform.recent_errors??[]).map(row=>node('tr',{},node('td',{},row.type,node('br'),node('code',{},row.task_id)),node('td',{},row.error?.message??row.error?.code??'历史记录未保存详情'),node('td',{},time(row.updated_at)),node('td',{},button((data.investigations??[]).some(item=>item.task_id===row.task_id)?'查看调查':'让 Agent 调查',()=>investigate(row.task_id),true))));
  const control=node('div',{class:'toolbar'},button(platform.runtime?.paused?'恢复领取':'暂停领取',async()=>{await operation('runtime_update',{paused:!platform.runtime?.paused});await overview();},true),node('span',{class:'subtle'},'业务并发'),node('input',{id:'concurrency',type:'number',min:1,value:platform.runtime?.concurrency??1,'aria-label':'业务并发'}),button('保存',async()=>{await operation('runtime_update',{concurrency:Number($('#concurrency').value)});notice('并发设置已保存。');}),button('重启 Runner',async()=>{await operation('service_restart',{service:'runner'});notice('已请求重启 Runner，请稍后刷新确认。');},true));
  const content=[node('p',{class:'section-note'},'状态来自实时采集与执行记录。点击异常，即可让管理 Agent 带着上下文调查。'),node('div',{class:'cards'},card('宿主 CPU',host.available?(host.cpu_percent===null||host.cpu_percent===undefined?'采样中':host.cpu_percent+'%'):'不可用',host.available?'宿主机 /proc · 整机占用':'未挂载或无法读取宿主指标'),card('宿主内存',host.memory_used_bytes!==undefined?bytes(host.memory_used_bytes):'不可用','总量 '+bytes(host.memory_total_bytes)),card('正在执行',active,'排队 '+(counts.queued??0)+' · 等待恢复 '+(counts.suspended??0)),card('累计执行失败',counts.failed??'—','执行完成 '+(counts.completed??0)+' · 业务结果单独查看')),panel('服务状态',node('div',{},services,node('p',{class:'subtle'},platform.runner?.reason??'业务执行和 HTTP 交付分别记录。'),node('p',{class:'subtle'},'Manager 容器内存 '+bytes(resources.container?.memory_used_bytes)+' · 数据磁盘可用 '+bytes(resources.disk?.available_bytes)))),panel('最近执行异常',table(['业务 / 任务','原因','时间（北京时间）','操作'],errors)),panel('调度设置',control)];
  $('#view').replaceChildren(...content);if(platform.unavailable)notice(platform.error?.message??'Gateway 暂时不可用，管理服务仍在运行。');
}
async function investigate(id){const conversation=await api('/conversations',{title:'调查 '+id.slice(0,8),task_id:id});state.chatId=conversation.id;if(!conversation.messages.length)await api(`/conversations/${conversation.id}/messages`,{text:`调查任务 ${id} 的执行和交付情况，查明已有证据能够支持的失败原因。先查询具体记录，不猜测，不重新提交任务。`});await switchView('chat');}
async function chat(){
  const conversations=await api('/conversations');if(state.view!=='chat')return;
  if(!state.chatId&&conversations.length)state.chatId=conversations[0].id;
  const list=node('div',{class:'conversation-list'},button('＋ 新对话',async()=>{const created=await api('/conversations',{title:'新对话'});state.chatId=created.id;await chat();},true),...conversations.map(item=>node('button',{class:item.id===state.chatId?'selected':'',onclick:()=>{state.chatId=item.id;void chat().catch(error=>notice(error.message));}},item.title)));
  const messages=node('div',{id:'messages',class:'messages'}),actions=node('div',{id:'actions',class:'actions'});
  const input=node('textarea',{id:'message-input',placeholder:'告诉我你想了解或处理什么，例如：查询失败任务并说明原因。','aria-label':'消息',value:state.draft,oninput:event=>{state.draft=event.target.value;}});
  const send=button('发送',async()=>{if(!input.value.trim())return;if(!state.chatId){const created=await api('/conversations',{title:input.value.slice(0,30)});state.chatId=created.id;}await api(`/conversations/${state.chatId}/messages`,{text:input.value});state.draft='';input.value='';await chat();});
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();send.click();}});
  $('#view').replaceChildren(node('p',{class:'section-note'},'可以自由提问，也可以让 Agent 创建插件、试运行、管理计划或处理指定任务。Ctrl / ⌘ + Enter 发送。'),node('div',{class:'split'},list,node('div',{class:'panel chat'},messages,actions,node('div',{class:'compose'},input,send))));
  state.conversationSignature='';await updateChat();
}
async function updateChat(){
  const id=state.chatId;if(state.view!=='chat'||!id)return;
  const data=await api('/conversations/'+id);if(state.view!=='chat'||state.chatId!==id)return;
  const signature=JSON.stringify([data.messages,data.actions]);if(signature===state.conversationSignature)return;state.conversationSignature=signature;
  const messages=$('#messages'),nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<100;
  messages.replaceChildren(...data.messages.map(message=>node('div',{class:'message '+message.role},node('div',{class:'message-label'},message.role==='user'?'你 · '+(labels[message.status]??message.status):'管理 AGENT'),node('div',{},message.text),message.error?node('div',{class:'danger-text'},message.error.code):null)));
  if(!data.messages.length)messages.append(node('div',{class:'empty'},'从一个问题开始。状态、异常和业务插件，都可以在这里管理。'));
  if(nearBottom)messages.scrollTop=messages.scrollHeight;
  $('#actions').replaceChildren(...data.actions.slice(-8).map(action=>node('div',{},badge(action.status),' ',action.name,action.target?' · '+action.target:'',action.summary?.task_id?' → '+action.summary.task_id:'',action.error?' · '+action.error.message:'')));
}
async function tasks(){
  const filter=state.taskFilter,query=new URLSearchParams({...filter,offset:state.taskOffset,limit:50}),rows=await api('/tasks?'+query);if(state.view!=='tasks')return;
  const select=node('select',{'aria-label':'任务状态'},node('option',{value:''},'全部状态'),...['queued','running','suspended','completed','failed'].map(value=>node('option',{value},labels[value])));select.value=filter.status??'';
  const search=node('input',{placeholder:'搜索请求编号、单词或输入内容',value:filter.search??'','aria-label':'搜索任务'});
  const toolbar=node('div',{class:'toolbar'},select,search,button('查询',async()=>{state.taskFilter={...(select.value?{status:select.value}:{}),...(search.value?{search:search.value}:{})};state.taskOffset=0;await tasks();}));
  const body=rows.map(row=>node('tr',{},node('td',{},row.type,node('br'),node('code',{},row.task_id)),node('td',{},badge(row.status)),node('td',{},row.error?.message??row.error?.code??'—'),node('td',{},time(row.created_at)),node('td',{},node('div',{class:'row-actions'},button('详情',()=>taskDetail(row.task_id),true),button('调查',()=>investigate(row.task_id),true)))));
  const pages=node('div',{class:'toolbar'},button('上一页',async()=>{state.taskOffset=Math.max(0,state.taskOffset-50);await tasks();},true),node('span',{class:'subtle'},'从第 '+(state.taskOffset+1)+' 条开始 · 本页 '+rows.length+' 条'),button('下一页',async()=>{if(rows.length===50){state.taskOffset+=50;await tasks();}},true));
  $('#view').replaceChildren(node('p',{class:'section-note'},'执行完成不等于所有业务项都成功。查看详情可区分最终结果、具体错误与交付状态。'),toolbar,panel('执行记录',table(['业务 / 任务','执行状态','错误','创建时间','操作'],body)),pages,node('div',{id:'task-details'}));
}
async function taskDetail(id){
  const value=await api('/tasks/'+id);if(state.view!=='tasks')return;
  const actions=node('div',{class:'row-actions'},button('让 Agent 查看',()=>investigate(id),true));
  if(['completed','failed'].includes(value.status))actions.append(button('重新执行整批',async()=>{const next=await operation('retry',{task_id:id});notice('已创建新任务 '+next.task_id+'，原记录保留。');await tasks();}));
  const previews=node('div',{class:'previews'}),detail=panel('任务详情',node('div',{},actions,node('p',{class:'subtle'},'HTTP accepted 表示接口接收；业务端异步保存是否成功，以业务端记录为准。'),node('pre',{class:'details'},pretty(value)),previews));
  $('#task-details').replaceChildren(detail);
  for(const artifact of value.artifacts??[]) {
    const response=await fetch(`/admin/api/artifacts/${id}/${artifact.artifact_id}`,{credentials:'same-origin'});
    if(!response.ok)continue;const url=URL.createObjectURL(await response.blob());state.urls.push(url);
    previews.append(artifact.mime?.startsWith('image/')?node('img',{src:url,alt:artifact.filename??'任务图片'}):node('a',{href:url,download:artifact.filename??'artifact.txt'},artifact.filename??'下载文本产物'));
  }
}
const newPlugin=()=>({type:'custom.review',name:'新业务',description:'',enabled:true,input_schema:{type:'object',properties:{content:{type:'string'}},required:['content'],additionalProperties:false},instructions:'根据输入完成业务，并通过 complete_task 提交最终结果。',result_schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},capabilities:{tools:[],image_generation:false,web_search:false},resources:[],delivery:{mode:'none'}});
async function plugins(){
  const data=await api('/plugins');if(state.view!=='plugins')return;
  const editor=node('textarea',{id:'plugin-editor',class:'editor',spellcheck:'false','aria-label':'插件 JSON 定义',value:pretty(newPlugin())});
  const selectDefinition=definition=>{const {revision,updated_at,...editable}=definition;editor.value=pretty(editable);};
  const rows=data.configured.map(item=>node('tr',{},node('td',{},item.name,node('br'),node('code',{},item.type)),node('td',{},badge(item.enabled?'已启用':'已停用')),node('td',{},item.description??''),node('td',{},node('div',{class:'row-actions'},button('编辑',async()=>selectDefinition(item),true),button(item.enabled?'停用':'启用',async()=>{await operation('plugin_enable',{type:item.type,enabled:!item.enabled});await plugins();},true)))));
  const input=node('textarea',{id:'trial-input',rows:4,value:'{}','aria-label':'试运行输入'}),tools=node('pre',{class:'details hidden',id:'capability-detail'});
  const save=button('校验并保存',async()=>{const definition=JSON.parse(editor.value);await operation('plugin_validate',{definition});await operation('plugin_save',{definition});await plugins();notice('插件已保存。已接收的任务继续使用原定义。');});
  const inspect=button('查看可用能力',async()=>{tools.textContent=pretty(await api('/capabilities'));tools.classList.toggle('hidden');},true);
  const trial=button('提交试运行',async()=>{const definition=JSON.parse(editor.value),task=await operation('submit_task',{type:definition.type,input:JSON.parse(input.value)});notice('已提交试运行：'+task.task_id);});
  $('#view').replaceChildren(node('p',{class:'section-note'},'每个插件定义输入、完整任务要求、可用能力和最终输出。也可以直接在管理对话中描述需求，让 Agent 创建配置。'),panel('已注册业务',table(['业务','状态','说明','操作'],rows),button('新建插件',async()=>{editor.value=pretty(newPlugin());},true)),panel('插件定义',node('div',{},editor,node('div',{class:'toolbar'},save,inspect),tools,node('label',{},'试运行输入 JSON'),input,node('div',{class:'toolbar'},trial))),...(data.builtin?.length?[node('p',{class:'subtle'},'兼容模块：'+data.builtin.map(item=>item.type).join('、'))]:[]));
}
async function schedules(){
  const plans=await api('/schedules'),pluginData=await api('/plugins');if(state.view!=='schedules')return;
  let editing=null;const form=node('form',{}),name=node('input',{required:true,placeholder:'例如：每天检查运行情况'}),kind=node('select',{},node('option',{value:'inspection'},'管理巡检'),node('option',{value:'task'},'业务任务')),
    cron=node('input',{required:true,value:'0 9 * * *'}),timezone=node('input',{required:true,value:'Asia/Shanghai'}),type=node('select',{},...[...pluginData.configured,...(pluginData.builtin??[])].map(item=>node('option',{value:item.type},item.name??item.type))),input=node('textarea',{rows:4,value:'{}'}),message=node('textarea',{rows:3,value:'检查服务健康、任务积压、执行错误和交付情况，给出有证据的报告。'});
  const field=(title,control,full=false)=>node('div',{class:full?'full':''},node('label',{},title),control);
  const fields=node('div',{class:'form-grid'},field('计划名称',name),field('触发对象',kind),field('Cron（分 时 日 月 周）',cron),field('时区',timezone),field('业务类型',type),field('业务输入 JSON',input),field('巡检要求',message,true));
  const submit=node('button',{type:'submit'},'保存计划');form.append(fields,node('div',{class:'toolbar'},submit));form.addEventListener('submit',event=>{event.preventDefault();void busy(submit,async()=>{await operation('schedule_save',{schedule:{...(editing?{id:editing}:{}),name:name.value,kind:kind.value,cron:cron.value,timezone:timezone.value,enabled:true,...(kind.value==='task'?{type:type.value,input:JSON.parse(input.value)}:{message:message.value})}});await schedules();notice('定时计划已保存。');});});
  const rows=plans.map(plan=>node('tr',{},node('td',{},plan.name,node('br'),node('span',{class:'subtle'},plan.kind==='inspection'?'管理巡检':plan.type)),node('td',{},node('code',{},plan.cron),node('br'),node('span',{class:'subtle'},plan.timezone)),node('td',{},time(plan.next_run_at)),node('td',{},badge(plan.enabled?'已启用':'已停用'),plan.blocked_reason?node('div',{class:'danger-text'},plan.blocked_reason):null),node('td',{},node('div',{class:'row-actions'},button('编辑',async()=>{editing=plan.id;name.value=plan.name;kind.value=plan.kind;cron.value=plan.cron;timezone.value=plan.timezone;if(plan.kind==='task'){type.value=plan.type;input.value=pretty(plan.input);}else message.value=plan.message;},true),button(plan.enabled?'停用':'启用',async()=>{await operation('schedule_enable',{id:plan.id,enabled:!plan.enabled});await schedules();},true)))));
  $('#view').replaceChildren(node('p',{class:'section-note'},'停机期间错过的计划在恢复后执行一次，再进入下个正常时刻。每次触发都是独立任务，执行受统一并发设置控制。'),panel('定时计划',table(['计划','规则','下次触发（北京时间）','状态','操作'],rows)),panel('创建或调整计划',form));
}
async function settings(){
  const data=await operation('configuration_list');if(state.view!=='settings')return;
  const groups=data.groups.map(group=>{
    const form=node('form',{id:'configuration-'+group.scope}),fields=node('div',{class:'form-grid'}),readers=[];
    for(const [key,schema]of Object.entries(group.schema.properties??{})){
      const initial=group.values[key],id=`setting-${group.scope}-${key}`;
      const control=schema.type==='object'||schema.type==='array'?node('textarea',{id,class:'configuration-json',rows:8,value:pretty(initial??{}),spellcheck:'false'}):schema.type==='boolean'?node('input',{id,type:'checkbox',checked:initial===true}):schema.type==='string'&&key==='instructions'?node('textarea',{id,rows:9,value:initial??''}):node('input',{id,type:schema.writeOnly?'password':schema.type==='integer'?'number':'text',value:schema.writeOnly?'':initial??'',...(schema.writeOnly?{autocomplete:'new-password',placeholder:group.configured_secrets.includes('/'+key)?'已配置，留空保持原值':'尚未配置'}:{}),...(schema.minimum!==undefined?{min:schema.minimum}:{}),...(schema.maximum!==undefined?{max:schema.maximum}:{})});
      const wrapper=node('div',{class:schema.type==='object'||key==='instructions'?'full':''},node('label',{for:id},schema.title??key),control);
      let clear;if(schema.writeOnly&&!schema.minLength){clear=node('input',{type:'checkbox','aria-label':'清除 '+(schema.title??key)});wrapper.append(node('label',{class:'inline-label'},clear,' 清除已保存凭证'));}
      fields.append(wrapper);
      readers.push(patch=>{
        if(schema.writeOnly){if(clear?.checked)patch[key]='';else if(control.value)patch[key]=control.value;return;}
        const value=schema.type==='boolean'?control.checked:schema.type==='integer'?Number(control.value):schema.type==='object'||schema.type==='array'?JSON.parse(control.value):control.value;
        if(JSON.stringify(value)!==JSON.stringify(initial))patch[key]=value;
      });
    }
    const save=node('button',{type:'submit'},'保存配置');
    form.append(node('p',{class:'section-note'},group.description),...(group.error?[node('p',{class:'danger-text'},group.error.message)]:[]),fields,...(group.configured_secrets.length?[node('p',{class:'subtle secret-status'},'已配置凭证：'+group.configured_secrets.join('、')+'。省略字段保留原值，显式空值表示清除。')]:[]),node('div',{class:'toolbar'},save));
    form.addEventListener('submit',event=>{event.preventDefault();void busy(save,async()=>{const patch={};readers.forEach(read=>read(patch));if(!Object.keys(patch).length){notice('没有需要保存的修改。');return;}const result=await operation('configuration_update',{scope:group.scope,patch});await settings();notice(result.synchronization?.runner==='pending'?'已保存，Runner 暂时不可用，恢复后自动同步。':'已保存，配置按本组说明生效。');});});
    return panel(group.title,form);
  });
  const password=node('input',{id:'new-admin-password',type:'password',autocomplete:'new-password',minlength:12,maxlength:1024,required:true}),confirm=node('input',{id:'confirm-admin-password',type:'password',autocomplete:'new-password',required:true}),change=node('button',{type:'submit'},'修改 Admin 密码');
  const form=node('form',{},node('p',{class:'section-note'},'修改后所有网页会话退出，请使用新密码重新登录。业务入口密钥保持独立。'),node('label',{for:'new-admin-password'},'新密码（至少12个字符）'),password,node('label',{for:'confirm-admin-password'},'再次输入新密码'),confirm,node('div',{class:'toolbar'},change));
  form.addEventListener('submit',event=>{event.preventDefault();void busy(change,async()=>{if(password.value!==confirm.value)throw new Error('两次密码不一致。');await api('/password',{password:password.value});resetLogin();$('#login-error').textContent='密码已修改，请重新登录。';});});
  $('#view').replaceChildren(node('p',{class:'section-note'},'配置持久保存在服务端，页面和管理 Agent 使用相同接口。修改无需重启，正在执行的任务保留自己的参数。密钥只写不读。'),...(data.gateway_unavailable?[node('p',{class:'notice'},'Gateway 暂时不可用，仍可调整管理 Agent 和 Admin 配置。')]:[]),...groups,panel('Admin 密码',form),panel('部署配置',node('div',{},...(data.bootstrap??[]).map(item=>node('p',{class:'section-note'},node('code',{},item.names.join(' / ')),node('br'),item.description)))));
}
const renderers={overview,chat,tasks,plugins,schedules,settings};
async function connected(){state.authenticated=true;$('#password').value='';$('#login').classList.add('hidden');$('#workspace').classList.remove('hidden');await switchView('overview');}
$('#login-form').addEventListener('submit',event=>{event.preventDefault();$('#login-error').textContent='';const submit=event.currentTarget.querySelector('button');void busy(submit,async()=>{try{await api('/login',{password:$('#password').value});await connected();}catch(error){$('#login-error').textContent=error.message;}});});
$('#logout').addEventListener('click',()=>void logout().catch(error=>notice(error.message)));$('#navigation').addEventListener('click',event=>{const target=event.target.closest('[data-view]');if(target)void switchView(target.dataset.view);});$('#refresh').addEventListener('click',()=>void(state.view==='chat'?updateChat():switchView(state.view)).catch(error=>notice(error.message)));
setInterval(()=>{if(state.authenticated&&state.view==='chat')void updateChat().catch(error=>notice(error.message));},2000);
setInterval(()=>{if(state.authenticated&&state.view==='overview'&&!$('#view input:focus'))void overview().catch(error=>notice(error.message));},10000);
void api('/session').then(connected).catch(()=>{});
