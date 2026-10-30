import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {NotificationStore} from '../src/notifications/store.mjs';

function setup(t,fetchImpl=async()=>new Response('ok')) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const store=new NotificationStore({db,fetchImpl});
  const create=(name='Synthetic',extra={})=>store.saveChannel({name,provider:'custom',url:'https://example.invalid/hook?key=synthetic-url-secret',...extra});
  return {db,store,create};
}
const owner={kind:'task',id:'synthetic-task'};
const payload=(channels,key='event',body={text:'synthetic message'})=>({notification_key:key,deliveries:channels.map(channel=>({channel_id:channel.id,body}))});

test('channels are write-only, revision checked, stable tombstones; save performs no send',t=>{
  let sends=0;const {store,create}=setup(t,async()=>{sends++;return new Response('ok');});
  const c=create('Synthetic',{token:'synthetic-token',headers:{'X-Key':'synthetic-header'},signingSecret:'synthetic-signing'});
  assert.match(c.id,/^[a-f\d-]{36}$/);assert.equal(c.revision,1);assert.deepEqual(c.configured,{url:true,token:true,headers:true,signingSecret:true});
  assert.ok(!JSON.stringify(store.listChannels()).includes('synthetic-token'));assert.ok(!JSON.stringify(c).includes('example.invalid'));
  assert.throws(()=>store.saveChannel({id:c.id,name:'New'}),{status:409});
  const updated=store.saveChannel({id:c.id,name:'New',token:'',headers:{}},{revision:1});
  assert.equal(updated.revision,2);assert.equal(updated.configured.token,false);assert.equal(updated.configured.signingSecret,true);
  assert.throws(()=>store.saveChannel({id:c.id,provider:'slack'},{revision:2}),{status:400});
  assert.throws(()=>store.setChannelEnabled(c.id,false,{revision:1}),{status:409});
  store.deleteChannel(c.id,{revision:2});assert.equal(store.listChannels().length,0);assert.equal(store.channel(c.id).deleted,true);
  assert.throws(()=>store.saveChannel({id:c.id,name:'Restored'},{revision:3}),{status:409});assert.equal(sends,0);
});

test('bindings preserve existing unavailable channels and compose inside caller transactions',t=>{
  const {db,store,create}=setup(t),a=create(),b=create('B');
  assert.deepEqual(store.getBinding(owner).notification_channels,[]);
  db.exec('BEGIN');store.setBinding(owner,[a.id]);db.exec('ROLLBACK');assert.equal(store.getBinding(owner).notification_revision,0);
  let binding=store.setBinding(owner,[a.id]);assert.equal(binding.notification_revision,1);
  store.setChannelEnabled(a.id,false,{revision:1});binding=store.setBinding(owner,[a.id,b.id],{revision:1});assert.equal(binding.notification_revision,2);
  assert.throws(()=>store.setBinding(owner,[b.id],{revision:1}),{status:409});
  assert.throws(()=>store.setBinding({kind:'task',id:'other'},[a.id]),{status:400});
  assert.throws(()=>store.setBinding(owner,[b.id,b.id]),{status:400});
  assert.equal(store.setBinding({kind:'inspection',id:'past'},['missing'],{allowUnavailable:true}).channels[0].deleted,true);
});

test('whole-batch preflight prevents effects for malformed or unbound deliveries',async t=>{
  let calls=0;const {store,create}=setup(t,async()=>{calls++;return new Response('ok');}),a=create(),b=create('B');store.setBinding(owner,[a.id]);
  await assert.rejects(store.send(owner,payload([a,b])),{status:403});
  await assert.rejects(store.send(owner,{notification_key:'bad',deliveries:[{channel_id:a.id,body:{ok:true}},{channel_id:a.id,body:{ok:true}}]}),{status:400});
  await assert.rejects(store.send(owner,payload([a]),{validate:()=>{throw Object.assign(new Error('Not running'),{status:403});}}),{status:403});
  await assert.rejects(store.send({kind:'schedule',id:'p'},payload([a])),{status:403});assert.equal(calls,0);assert.equal(store.history(owner).items.length,0);
});

test('durable idempotency returns recorded results and conflicts bind the original body',async t=>{
  let calls=0;const {store,create}=setup(t,async()=>{calls++;return new Response('received');}),a=create();store.setBinding(owner,[a.id]);
  const result=await store.send(owner,payload([a]));assert.equal(result.deliveries[0].status,'accepted');assert.equal(result.status,'accepted');
  assert.deepEqual(await store.send(owner,payload([a])),result);assert.equal(calls,1);
  await assert.rejects(store.send(owner,payload([a],'event',{text:'different'})),{status:409});
  assert.equal(store.history(owner).items[0].batch_id,result.batch_id);
});

test('same-key concurrent sends share the active attempt and protect retention',async t=>{
  let release,entered;const start=new Promise(r=>entered=r);let calls=0;
  const {store,create}=setup(t,async()=>{calls++;entered();await new Promise(r=>release=r);return new Response('ok');}),a=create();store.setBinding(owner,[a.id]);
  const first=store.send(owner,payload([a]));await start;assert.equal(store.hasActive(owner),true);assert.throws(()=>store.purgeOwner(owner),{status:409});
  const second=store.send(owner,payload([a]));release();const [one,two]=await Promise.all([first,second]);assert.deepEqual(one,two);assert.equal(calls,1);assert.equal(store.hasActive(owner),false);
  store.purgeOwner(owner);store.purgeOwner(owner);assert.deepEqual(store.getBinding(owner).notification_channels,[]);assert.equal(store.history(owner).items.length,0);
});

test('runtime binding changes prevent later targets and continue independent channels',async t=>{
  let count=0;const {store,create}=setup(t,async()=>{count++;if(count===1)store.setBinding(owner,[a.id,c.id]);return new Response('ok');}),a=create('A'),b=create('B'),c=create('C');store.setBinding(owner,[a.id,b.id,c.id]);
  const result=await store.send(owner,payload([a,b,c]));assert.deepEqual(result.deliveries.map(x=>x.status),['accepted','unavailable','accepted']);assert.equal(count,2);
});

test('stopped authorization leaves pending entries resumable, accepted entries never replay',async t=>{
  let authorized=true,calls=0;const {store,create}=setup(t,async()=>{calls++;authorized=false;return new Response('ok');}),a=create('A'),b=create('B');store.setBinding(owner,[a.id,b.id]);
  const validate=()=>{if(!authorized)throw Object.assign(new Error('Stopped'),{status:403});};
  await assert.rejects(store.send(owner,payload([a,b]),{validate}),{status:403});assert.deepEqual(store.history(owner).items[0].deliveries.map(x=>x.status),['accepted','pending']);
  authorized=true;const result=await store.send(owner,payload([a,b]),{validate});assert.deepEqual(result.deliveries.map(x=>x.status),['accepted','accepted']);assert.equal(calls,2);
});

test('transport uncertainty, rejection and secret echo are bounded and redacted',async t=>{
  let calls=0;const {db,store,create}=setup(t,async(url,options)=>{calls++;assert.equal(options.redirect,'manual');assert.ok(options.signal);if(calls===1)throw new Error(url+' synthetic-token');return new Response('https://example.invalid/hook?key=synthetic-url-secret synthetic-token synthetic-header',{status:429});});
  const a=create('A',{token:'synthetic-token',headers:{'X-Auth':'synthetic-header'}}),b=create('B');store.setBinding(owner,[a.id,b.id]);
  const result=await store.send(owner,payload([a,b],'redact',{text:'synthetic-token https://example.invalid/hook?key=synthetic-url-secret'}));
  assert.deepEqual(result.deliveries.map(x=>x.status),['unknown','rejected']);const stored=JSON.stringify(db.prepare('SELECT * FROM notification_attempts').all());
  for(const value of ['synthetic-token','synthetic-url-secret','synthetic-header','https://example.invalid/hook']){assert.ok(!JSON.stringify(result).includes(value));assert.ok(!stored.includes(value));}
  await store.send(owner,payload([a,b],'redact',{text:'synthetic-token https://example.invalid/hook?key=synthetic-url-secret'}));assert.equal(calls,2);
});

test('restart converts reserved sends to unknown without replay, preserving pending work',async t=>{
  let calls=0;const {db,store,create}=setup(t,async()=>{calls++;return new Response('ok');}),a=create();store.setBinding(owner,[a.id]);
  await store.send(owner,payload([a]));db.prepare("UPDATE notification_attempts SET status='sending'").run();
  const reopened=new NotificationStore({db,fetchImpl:async()=>{calls++;return new Response('ok');}});
  const result=await reopened.send(owner,payload([a]));assert.equal(result.deliveries[0].status,'unknown');assert.equal(calls,1);
});

test('history uses owner-bound keyset cursors and bounded pages',async t=>{
  const {store,create}=setup(t),a=create();store.setBinding(owner,[a.id]);for(let i=0;i<4;i++)await store.send(owner,payload([a],`event-${i}`));
  const first=store.history(owner,{limit:2});assert.equal(first.items.length,2);assert.ok(first.next_cursor);const second=store.history(owner,{limit:2,before:first.next_cursor});assert.equal(second.items.length,2);assert.equal(second.next_cursor,null);assert.ok(!second.items.some(x=>first.items.some(y=>x.batch_id===y.batch_id)));
  assert.throws(()=>store.history({kind:'task',id:'other'},{before:first.next_cursor}),{status:400});
});

test('testChannel sends a fixed native synthetic sample only when explicitly invoked',async t=>{
  let sent;const {store,create}=setup(t,async(_url,options)=>{sent=JSON.parse(options.body);return new Response('ok');}),a=create();assert.equal(sent,undefined);
  const result=await store.testChannel(a.id);assert.equal(result.deliveries[0].status,'accepted');assert.ok(JSON.stringify(sent).includes('test'));assert.equal(store.history(owner).items.length,0);
});

test('safe channel metadata retains configured timeout for human editing',t=>{
  const {create}=setup(t);assert.equal(create('Timeout',{timeoutMs:1234}).timeoutMs,1234);
});

test('long echoed credentials are redacted before response summaries are truncated',async t=>{
  const secret='synthetic-long-'+ 'x'.repeat(1000),{store,create}=setup(t,async()=>new Response(secret)),a=create('Long',{headers:{'X-Private':secret}});store.setBinding(owner,[a.id]);
  const result=await store.send(owner,payload([a]));assert.ok(!result.deliveries[0].summary.includes('synthetic-long-'));
});

test('credentials embedded in native URL paths are redacted from message history',async t=>{
  const {store}=setup(t,async()=>new Response('ok'));
  const a=store.saveChannel({name:'Synthetic Slack',provider:'slack',url:'https://hooks.slack.com/services/SYNTHETICGROUP/SYNTHETICBOT/synthetic-path-secret'});store.setBinding(owner,[a.id]);
  const result=await store.send(owner,payload([a],'path',{text:'Echo synthetic-path-secret'}));assert.ok(!JSON.stringify(result).includes('synthetic-path-secret'));
});

test('already delivered channels need no renewed binding when pending targets continue',async t=>{
  let authorized=true;const {store,create}=setup(t,async()=>{authorized=false;return new Response('ok');}),a=create('A'),b=create('B');store.setBinding(owner,[a.id,b.id]);
  const validate=()=>{if(!authorized)throw Object.assign(new Error('Stopped'),{status:403});};await assert.rejects(store.send(owner,payload([a,b]),{validate}));
  store.setBinding(owner,[b.id]);authorized=true;const result=await store.send(owner,payload([a,b]),{validate});assert.deepEqual(result.deliveries.map(x=>x.status),['accepted','accepted']);
});

test('malformed native payload and oversized JSON abort the entire preflight',async t=>{
  let calls=0;const {store,create}=setup(t,async()=>{calls++;return new Response('ok');}),a=create(),b=store.saveChannel({name:'Slack',provider:'slack',url:'https://hooks.slack.com/services/SYNTHETICGROUP/SYNTHETICBOT/synthetic-secret'});store.setBinding(owner,[a.id,b.id]);
  await assert.rejects(store.send(owner,{notification_key:'bad-native',deliveries:[{channel_id:a.id,body:{text:'Valid'}},{channel_id:b.id,body:{invalid:'Missing Slack text'}}]}),{status:400});
  await assert.rejects(store.send(owner,payload([a],'oversize',{text:'x'.repeat(131073)})),{status:400});assert.equal(calls,0);assert.equal(store.history(owner).items.length,0);
});

test('response size limits and timeouts remain unknown while other channels continue',async t=>{
  let calls=0;const {store,create}=setup(t,async(_url,options)=>{
    calls++;if(calls===1)return new Response('x'.repeat(65537));
    if(calls===2)return await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Abort')),{once:true}));
    return new Response('ok');
  }),a=create('Large'),b=create('Slow',{timeoutMs:100}),c=create('Fine');store.setBinding(owner,[a.id,b.id,c.id]);
  const result=await store.send(owner,payload([a,b,c]));assert.deepEqual(result.deliveries.map(x=>x.status),['unknown','unknown','accepted']);assert.equal(store.hasActive(owner),false);assert.equal(calls,3);
});

test('latest saved target configuration is snapshotted immediately before each network send',async t=>{
  const requests=[];const {store,create}=setup(t,async(url,options)=>{
    requests.push({url,authorization:options.headers.authorization});
    if(requests.length===1)store.saveChannel({id:b.id,url:'https://example.invalid/new-synthetic-path',token:'synthetic-new-token'},{revision:1});
    return new Response('ok');
  }),a=create('A'),b=create('B',{token:'synthetic-old-token'});store.setBinding(owner,[a.id,b.id]);
  await store.send(owner,payload([a,b]));assert.equal(requests[1].url,'https://example.invalid/new-synthetic-path');assert.equal(requests[1].authorization,'Bearer synthetic-new-token');
});

test('real loopback fetch injects private credentials and never follows redirects',async t=>{
  const {createServer}=await import('node:http');let followed=0;const seen=[];
  const sink=createServer((req,res)=>{
    seen.push({url:req.url,token:req.headers.authorization,private:req.headers['x-private']});req.resume();
    if(req.url==='/redirect'){res.writeHead(302,{location:'/should-not-follow'});res.end();return;}
    if(req.url==='/should-not-follow')followed++;res.end('synthetic-local-credential');
  });await new Promise(resolve=>sink.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>sink.close(resolve)));
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const store=new NotificationStore({db}),base=`http://127.0.0.1:${sink.address().port}`;
  const a=store.saveChannel({name:'Local',provider:'custom',url:base+'/ok',token:'synthetic-local-credential',headers:{'X-Private':'synthetic-local-header'}}),b=store.saveChannel({name:'Redirect',provider:'custom',url:base+'/redirect'});store.setBinding(owner,[a.id,b.id]);
  const result=await store.send(owner,payload([a,b]));assert.deepEqual(result.deliveries.map(x=>x.status),['accepted','rejected']);assert.equal(followed,0);assert.equal(seen.length,2);assert.equal(seen[0].token,'Bearer synthetic-local-credential');assert.equal(seen[0].private,'synthetic-local-header');assert.ok(!JSON.stringify(result).includes('synthetic-local-credential'));
});

test('redaction uses one replacement pass even when a credential matches the marker text',async t=>{
  const {store,create}=setup(t),a=create('One pass',{token:'redacted',headers:{'X-Private':'synthetic-original-secret'}});store.setBinding(owner,[a.id]);
  const result=await store.send(owner,payload([a],'one-pass',{text:'synthetic-original-secret'}));assert.equal(result.deliveries[0].body.text,'[redacted]');
});

test('fresh database connection recovers uncertain sends and resumes only never-started targets',async t=>{
  const {mkdtempSync,mkdirSync,rmSync}=await import('node:fs');const {join}=await import('node:path');mkdirSync('.tmp',{recursive:true});const dir=mkdtempSync('.tmp/notification-store-');let db=new DatabaseSync(join(dir,'notifications.sqlite'));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  let authorized=true,calls=0,store=new NotificationStore({db,fetchImpl:async()=>{calls++;authorized=false;return new Response('ok');}});
  const a=store.saveChannel({name:'A',provider:'custom',url:'https://example.invalid/a'}),b=store.saveChannel({name:'B',provider:'custom',url:'https://example.invalid/b'});store.setBinding(owner,[a.id,b.id]);
  const validate=()=>{if(!authorized)throw new Error('Stopped');};await assert.rejects(store.send(owner,payload([a,b]),{validate}));db.prepare("UPDATE notification_attempts SET status='sending' WHERE channel_id=?").run(a.id);db.close();
  db=new DatabaseSync(join(dir,'notifications.sqlite'));store=new NotificationStore({db,fetchImpl:async()=>{calls++;return new Response('ok');}});const result=await store.send(owner,payload([a,b]));assert.deepEqual(result.deliveries.map(item=>item.status),['unknown','accepted']);assert.equal(calls,2);assert.equal(store.channel(a.id).revision,1);
});

test('original delivery digest conflicts even if both private bodies redact identically',async t=>{
  const {store,create}=setup(t),a=create('Private digest',{token:'synthetic-secret-A',headers:{'X-Secret':'synthetic-secret-B'}});store.setBinding(owner,[a.id]);
  const first=await store.send(owner,payload([a],'private-digest',{text:'synthetic-secret-A'}));assert.equal(first.deliveries[0].body.text,'[redacted]');await assert.rejects(store.send(owner,payload([a],'private-digest',{text:'synthetic-secret-B'})),{status:409});
});

test('test history pruning is bounded, transactional and preserves recent and business records',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let now=100;const store=new NotificationStore({db,now:()=>now,fetchImpl:async()=>new Response('ok')});
  const channel=store.saveChannel({name:'Retention',provider:'custom',url:'https://example.invalid/synthetic-test'});
  const old=[];for(let i=0;i<3;i++){now=100+i;old.push(await store.testChannel(channel.id));}
  store.setBinding(owner,[channel.id]);await store.send(owner,payload([channel],'business-record'));now=200;const recent=await store.testChannel(channel.id);
  db.exec('BEGIN');assert.deepEqual(store.pruneTestHistory({cutoff:150,limit:1}),{deleted:1});db.exec('ROLLBACK');assert.equal(db.prepare("SELECT count(*) count FROM notification_batches WHERE owner_kind='test'").get().count,4);
  assert.deepEqual(store.pruneTestHistory({cutoff:150,limit:2}),{deleted:2});assert.equal(db.prepare("SELECT count(*) count FROM notification_batches WHERE owner_kind='test'").get().count,2);
  assert.deepEqual(store.pruneTestHistory({cutoff:150}),{deleted:1});assert.deepEqual(store.pruneTestHistory({cutoff:150}),{deleted:0});
  assert.ok(db.prepare('SELECT 1 FROM notification_batches WHERE id=?').get(recent.batch_id));assert.equal(store.history(owner).items.length,1);
  assert.equal(db.prepare("SELECT count(*) count FROM notification_bindings WHERE owner_kind='test'").get().count,1);assert.equal(db.prepare('SELECT count(*) count FROM notification_attempts').get().count,2);
  for(const invalid of [{cutoff:NaN},{cutoff:150,limit:0},{cutoff:150,limit:101}])assert.throws(()=>store.pruneTestHistory(invalid),{status:400});
});

test('test history pruning skips in-flight synthetic sends and cleans them after settlement',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let entered,release;const started=new Promise(resolve=>entered=resolve);const store=new NotificationStore({db,now:()=>100,fetchImpl:async()=>{entered();await new Promise(resolve=>release=resolve);return new Response('ok');}});
  const channel=store.saveChannel({name:'Active retention',provider:'custom',url:'https://example.invalid/synthetic-active'}),sending=store.testChannel(channel.id);await started;
  try{assert.deepEqual(store.pruneTestHistory({cutoff:200}),{deleted:0});assert.equal(db.prepare("SELECT count(*) count FROM notification_batches WHERE owner_kind='test'").get().count,1);}finally{release();await sending;}
  assert.deepEqual(store.pruneTestHistory({cutoff:200}),{deleted:1});assert.equal(db.prepare('SELECT count(*) count FROM notification_attempts').get().count,0);assert.equal(db.prepare('SELECT count(*) count FROM notification_bindings').get().count,0);
});

test('credential rotation during an active request never exposes the old transport snapshot',async t=>{
  const old={url:'https://example.invalid/old-synthetic-url?key=old-synthetic-query',token:'old-synthetic-token',headers:{'X-Private':'old-synthetic-header'},signingSecret:'old-synthetic-signing'};
  const {db,store,create}=setup(t,async()=>{
    store.saveChannel({id:channel.id,url:'https://example.invalid/new-synthetic-url',token:'new-synthetic-token',headers:{'X-Private':'new-synthetic-header'},signingSecret:'new-synthetic-signing'},{revision:1});
    return new Response([old.url,old.token,old.headers['X-Private'],old.signingSecret].join(' '));
  }),channel=create('Rotating',old);store.setBinding(owner,[channel.id]);const result=await store.send(owner,payload([channel],'rotation'));
  const persisted=JSON.stringify(db.prepare('SELECT * FROM notification_attempts').all());
  for(const value of [old.url,old.token,old.headers['X-Private'],old.signingSecret,'old-synthetic-query']){assert.ok(!JSON.stringify(result).includes(value),`result leaked ${value}`);assert.ok(!persisted.includes(value),`history leaked ${value}`);}
});
