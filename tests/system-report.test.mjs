import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {SystemJournal} from '../src/observability/system-journal.mjs';
import {createSystemOperations} from '../src/observability/system-operations.mjs';
import {observeSystemUpgrade,observeSystemVersion,observeSystemApiError} from '../src/observability/system-report.mjs';

test('code-defect draft is bounded sanitized current evidence and guarded escalation without external submission',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const j=new SystemJournal({db,service:'manager'}),w=j.work({id:'cleanup',module:'cleanup',state:'blocked',code:'EACCES',allowed_actions:['cleanup_retry']});
 const ops=createSystemOperations({local:()=>({journal:j}),version:'1.0.4'});
 const draft=await ops.execute('system_issue_draft',{id:w.id,revision:w.revision,diagnosis:'Bearer abcdef123456; token=private-token; "password":"quoted-private"; server=private-deployment; https://private.example.test/a?key=secret /data/deployment/secret user@example.test 192.0.2.8',expected:'Directory cleared',actual:'Still pending',reproduction:'Run the allowed cleanup',source_refs:['src/observability/system-journal.mjs:10','/etc/shadow','https://internal.example.test/secret','src/private-deployment/secret-token.mjs']},{actor:'agent'});
 assert.equal(draft.classification,'code_defect');assert.equal(draft.submitted,false);assert.equal(draft.repository_url,'https://github.com/NM1024/codex-agent-platform');
 for(const secret of ['abcdef123456','private-token','private.example.test','/data/deployment','user@example.test','192.0.2.8','/etc/shadow','internal.example.test','quoted-private','private-deployment','secret-token'])assert.ok(!draft.markdown.includes(secret),secret);
 for(const fact of ['1.0.4','EACCES','Directory cleared','Still pending','Run the allowed cleanup','Uncertainty','src/observability/system-journal.mjs:10'])assert.ok(draft.markdown.includes(fact),fact);
 assert.ok(draft.evidence_ids.includes(w.id));assert.equal(j.detail(w.id).classification,'code_defect');assert.equal(j.detail(w.id).resolved_at,null);
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
