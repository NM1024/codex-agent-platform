import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {SystemJournal} from '../src/observability/system-journal.mjs';
import {createSystemOperations,executeSystemOwner} from '../src/observability/system-operations.mjs';
import {NotificationStore} from '../src/notifications/store.mjs';
import {observeSystemUpgrade,observeSystemVersion,observeSystemApiError} from '../src/observability/system-report.mjs';

test('code-defect draft is bounded sanitized current evidence without changing execution state without external submission',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const j=new SystemJournal({db,service:'manager'}),w=j.work({id:'cleanup',module:'cleanup',state:'blocked',code:'EACCES',allowed_actions:['cleanup_retry']});
 const ops=createSystemOperations({local:()=>({journal:j}),version:'1.0.4'});
 const draft=await ops.execute('system_issue_draft',{id:w.id,revision:w.revision,diagnosis:'Bearer abcdef123456; token=private-token; "password":"quoted-private"; server=private-deployment; https://private.example.test/a?key=secret /data/deployment/secret user@example.test 192.0.2.8',expected:'Directory cleared',actual:'Still pending',reproduction:'Run the allowed cleanup',source_refs:['src/observability/system-journal.mjs:10','/etc/shadow','https://internal.example.test/secret','src/private-deployment/secret-token.mjs']},{actor:'agent'});
 assert.equal(draft.classification,'code_defect');assert.equal(draft.submitted,false);assert.equal(draft.repository_url,'https://github.com/NM1024/codex-agent-platform');
 for(const secret of ['abcdef123456','private-token','private.example.test','/data/deployment','user@example.test','192.0.2.8','/etc/shadow','internal.example.test','quoted-private','private-deployment','secret-token'])assert.ok(!draft.markdown.includes(secret),secret);
 for(const fact of ['1.0.4','EACCES','Directory cleared','Still pending','Run the allowed cleanup','Uncertainty','src/observability/system-journal.mjs:10'])assert.ok(draft.markdown.includes(fact),fact);
 assert.ok(draft.evidence_ids.includes(w.id));assert.deepEqual(j.detail(w.id),w);assert.equal(j.detail(w.id).resolved_at,null);j.work({...w,state:'unknown'});
 await assert.rejects(ops.execute('system_issue_draft',{id:w.id,revision:w.revision}),{code:'SYSTEM_REVISION_CONFLICT'});
 await assert.rejects(ops.execute('system_issue_draft',{id:w.id,revision:j.detail(w.id).revision,actual:'x'.repeat(2001)}));
});

test('actual safe observers record fixed API/version/upgrade facts without job identifiers or raw diagnostics',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const j=new SystemJournal({db,service:'manager'});
 observeSystemApiError(j,new Error('token=private-secret /runtime/private'),{status:500});observeSystemVersion(j,{current:'1.0.4',latest:'1.0.5',update_available:true});
 observeSystemUpgrade(j,{available:true,job:{id:'deployment-private-id',state:'running',phase:'building',started_at:1,updated_at:2}});
 assert.equal(j.detail('manager:work:host-upgrade').state,'running');
 observeSystemUpgrade(j,{available:true,job:{id:'deployment-private-id',state:'succeeded',phase:'completed',started_at:1,updated_at:3,installed_version:'1.0.5'}});
 assert.equal(j.detail('manager:work:host-upgrade').state,'completed');
 observeSystemUpgrade(j,{available:false,job:null,error_code:'PRIVATE_HOST_PATH'});
 assert.equal(j.detail('manager:work:host-access').state,'disabled');
 const all=JSON.stringify(j.logs().items);for(const text of ['private-secret','/runtime/private','deployment-private-id','PRIVATE_HOST_PATH'])assert.ok(!all.includes(text));
});

test('issue drafts redact short access_token client_secret and refresh_token assignments in JSON and prose',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const journal=new SystemJournal({db,service:'manager'});
 const work=journal.work({id:'credential-scrub',module:'api',state:'unknown'}),ops=createSystemOperations({local:()=>({journal}),version:'1.0.4'});
 const values={access_token:'at7',client_secret:'cs8',refresh_token:'rt9'};
 for(const format of ['json','assignment']){
  const assignments=format==='json'?JSON.stringify(values):Object.entries(values).map(([key,value])=>`${key}=${value}`).join('; ');
  const note='Useful diagnosis and reproduction. '+assignments;
  const result=await ops.execute('system_issue_draft',{id:work.id,revision:journal.detail(work.id).revision,diagnosis:note,expected:note,actual:note,reproduction:note});
  for(const value of Object.values(values))assert.ok(!result.markdown.includes(value),`${format}: ${value}`);
  assert.ok(result.markdown.includes('Useful diagnosis and reproduction.'));assert.equal(result.submitted,false);
 }
});

test('final issue drafts scrub complete short credential assignments across naming conventions in every note',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const journal=new SystemJournal({db,service:'manager'});
 const work=journal.work({id:'ordinary-credentials',module:'api',state:'unknown'}),ops=createSystemOperations({local:()=>({journal})});
 const values={RUNNER_TOKEN:'rt1',signing_secret:'ss2',entry_key:'ek3',private_key:'pk4','webhook-signing-secret':'ws5',privateKey:'pc6',serviceApiKey:'ak7',APP_CLIENT_PASSWORD:'pw8',authorization:'au9',cookie:'co0',entrykey:'ek0',signingsecret:'ss0',密码:'密1',令牌:'令2',密钥:'钥3'};
 const formats=[JSON.stringify(values),Object.entries(values).map(([key,value])=>`${key}=${value}`).join('; '),'APP_AUTH_TOKEN="short secret, with spaces and \\"escaped\\" tail"; private-key=\'entire short value\''];
 for(const assignments of formats){
  const note='Useful reproduction. '+assignments+'; attempts=2; retry was observed.';
  const result=await ops.execute('system_issue_draft',{id:work.id,revision:journal.detail(work.id).revision,...Object.fromEntries(['diagnosis','expected','actual','reproduction'].map(key=>[key,note]))});
  for(const value of [...Object.values(values),'short secret','with spaces','escaped','tail','entire short value'])assert.ok(!result.markdown.includes(value),`leaked ${value}`);
  for(const text of ['Useful reproduction.','attempts=2','retry was observed.'])assert.equal(result.markdown.split(text).length-1,4,text);
 }
});

test('drafting during notification delivery does not change work or delay completed evidence retention',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let now=100,entered,release,sends=0;
 const started=new Promise(resolve=>entered=resolve),journal=new SystemJournal({db,service:'gateway',now:()=>now});
 const store=new NotificationStore({db,journal,now:()=>now,fetchImpl:async()=>{sends++;entered();await new Promise(resolve=>release=resolve);return new Response('ok');}});
 const channel=store.saveChannel({name:'Synthetic race',provider:'custom',url:'https://example.invalid/synthetic'}),owner={kind:'task',id:'synthetic-race'};
 store.setBinding(owner,[channel.id]);const sending=store.send(owner,{notification_key:'synthetic-race',deliveries:[{channel_id:channel.id,body:{text:'synthetic'}}]});await started;
 const ops=createSystemOperations({remote:(service,operation,args,context)=>executeSystemOwner({journal},operation,args,context)});
 const before=journal.works().items[0],evidence=journal.logs({work_id:before.id}).items[0];assert.equal(before.state,'unknown');
 try{await ops.execute('system_issue_draft',{id:before.id,revision:before.revision});assert.deepEqual(journal.detail(before.id),before);}
 finally{now=200;release();await sending;}
 const completed=journal.detail(before.id);assert.equal(store.history(owner).items[0].status,'accepted');assert.equal(sends,1);
 assert.equal(completed.classification,before.classification);assert.equal(completed.state,'completed');assert.equal(completed.completed_at,200);assert.equal(completed.resolved_at,200);
 now=1000;journal.prune({cutoff:500,limit:100});assert.equal(journal.detail(before.id),null);assert.equal(journal.detail(evidence.id),null);assert.equal(sends,1);
});

test('final drafts inspect credential assignments inside harmless labels and nested diagnostic strings in every note',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const journal=new SystemJournal({db,service:'manager'});
 const work=journal.work({id:'nested-credentials',module:'api',state:'unknown'}),ops=createSystemOperations({local:()=>({journal})});
 const cases=[
  {name:'configuration label',input:'Configuration: RUNNER_TOKEN=rt1',secrets:['rt1'],context:'Configuration:'},
  {name:'observation label',input:'Observed: signing_secret=ss2',secrets:['ss2'],context:'Observed:'},
  {name:'diagnostic string',input:JSON.stringify({error:'RUNNER_TOKEN=rt1; Useful inner context.'}),secrets:['rt1'],context:'Useful inner context.'},
  {name:'quoted labelled value',input:'Observed: signing_secret="ss2 whole value, with \\"quoted\\" tail"; Useful inner context.',secrets:['ss2','whole value','quoted','tail'],context:'Useful inner context.'},
  {name:'quoted credential with bearer content',input:'Observed: private_key="Bearer bt5"; Useful inner context.',secrets:['bt5'],context:'Useful inner context.'},
  {name:'escaped nested diagnostic',input:JSON.stringify({payload:JSON.stringify({error:'Observed: private_key="pk4 whole value, with \\"quoted\\" tail"; Useful inner context.'})}),secrets:['pk4','whole value','quoted','tail'],context:'Useful inner context.'},
  {name:'escaped nested structured assignment',input:JSON.stringify({payload:JSON.stringify({error:JSON.stringify({entry_key:'ek3 whole value, with "quoted" tail'})})}),secrets:['ek3','whole value','quoted','tail'],context:'payload'},
 ];
 for(const scenario of cases){
  const note=`Useful outer context. ${scenario.input}; attempts=2; Safe ending.`;
  const result=await ops.execute('system_issue_draft',{id:work.id,revision:journal.detail(work.id).revision,...Object.fromEntries(['diagnosis','expected','actual','reproduction'].map(key=>[key,note]))});
  for(const secret of scenario.secrets)assert.ok(!result.markdown.includes(secret),`${scenario.name}: credential value was retained`);
  for(const text of ['Useful outer context.','attempts=2','Safe ending.'])assert.equal(result.markdown.split(text).length-1,4,`${scenario.name}: useful context was lost`);
  assert.ok(result.markdown.split(scenario.context).length-1>=4,`${scenario.name}: useful inner context was lost`);
 }
});
