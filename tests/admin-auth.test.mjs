import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ManagerStore} from '../src/manager/store.mjs';
const password='initial-admin-password',replacement='replacement-admin-password';
async function authType(){const module=await import('../src/manager/auth.mjs').catch(()=>({}));assert.equal(typeof module.AdminAuth,'function','independent Admin password authentication exists');return module.AdminAuth;}
const request=token=>({headers:{cookie:'agent_admin='+token}});
async function temporaryRoot(prefix){const root=process.platform==='win32'?join(process.cwd(),'.tmp','chat-layout'):tmpdir();await mkdir(root,{recursive:true});return mkdtemp(join(root,prefix));}
test('Admin password hashes and sessions survive restart without resetting a changed password',async t=>{
  const AdminAuth=await authType(),root=await temporaryRoot('admin-auth-'),path=join(root,'manager.sqlite');
  let store=new ManagerStore(path),auth=new AdminAuth(store.db);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});await auth.initialize(password);
  const login=await auth.login(password);assert.equal(auth.authorize(request(login.token)),true);
  await auth.setPassword(replacement);assert.equal(auth.authorize(request(login.token)),false);store.close();
  store=new ManagerStore(path);auth=new AdminAuth(store.db);await auth.initialize(password);
  await assert.rejects(auth.login(password),error=>error.code==='UNAUTHORIZED');
  const next=await auth.login(replacement);assert.equal(auth.authorize(request(next.token)),true);
  const stored=JSON.stringify(store.db.prepare('SELECT * FROM manager_auth').all());assert.ok(!stored.includes(password));assert.ok(!stored.includes(replacement));assert.ok(!stored.includes(next.token));
});
test('Admin logout and expiration reject the session and invalid passwords cannot overwrite state',async t=>{
  const AdminAuth=await authType(),store=new ManagerStore(':memory:');t.after(()=>store.close());const auth=new AdminAuth(store.db);await auth.initialize(password);
  const login=await auth.login(password);assert.equal(auth.authorize(request(login.token),login.expires_at+1),false);
  const active=await auth.login(password);auth.logout(request(active.token));assert.equal(auth.authorize(request(active.token)),false);
  await assert.rejects(auth.setPassword('short'),error=>error.code==='INVALID_PASSWORD');assert.ok(await auth.login(password));
});
test('Admin HTTP login uses independent cookies, rejects cross-origin writes and revokes old sessions on password change',async t=>{
  const AdminAuth=await authType(),{createManagerServer}=await import('../src/manager/server.mjs');
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const auth=new AdminAuth(store.db);await auth.initialize(password);
  const server=createManagerServer({store,auth,agent:{},operations:{execute:async()=>({})},metrics:{sample:async()=>({})},token:'legacy-ingress'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/admin/api/overview',{headers:{authorization:'Bearer legacy-ingress'}})).status,401);
  assert.equal((await post('/admin/api/login',{password},{origin:'https://another.invalid'})).status,403);
  const login=await post('/admin/api/login',{password},{'x-forwarded-proto':'https'});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Secure/);assert.ok(!(await login.text()).includes(password));
  const headers={cookie:cookie.split(';')[0]};assert.equal((await fetch(base+'/admin/api/overview',{headers})).status,200);
  const other=await auth.login(password);
  for(const currentPassword of [undefined,'wrong-admin-password',null,42,'x'.repeat(1025)]) {
    const rejected=await post('/admin/api/password',{currentPassword,password:replacement},headers);
    assert.equal(rejected.status,403);
    assert.deepEqual(await rejected.json(),{error:{code:'CURRENT_PASSWORD_INVALID',message:'当前密码不正确。'}});
    assert.equal(rejected.headers.get('set-cookie'),null);
    assert.equal((await fetch(base+'/admin/api/session',{headers})).status,200);
    assert.equal(auth.authorize(request(other.token)),true);
  }
  for(const invalidPassword of ['short','x'.repeat(1025)]) {
    const rejected=await post('/admin/api/password',{currentPassword:password,password:invalidPassword},headers);
    assert.equal(rejected.status,400);assert.equal((await rejected.json()).error.code,'INVALID_PASSWORD');
    assert.equal((await fetch(base+'/admin/api/session',{headers})).status,200);
  }
  const changed=await post('/admin/api/password',{currentPassword:password,password:replacement},headers);
  assert.equal(changed.status,200);assert.deepEqual(await changed.json(),{updated:true,sessions_revoked:true});
  assert.match(changed.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal(auth.authorize(request(other.token)),false);
  assert.equal((await fetch(base+'/admin/api/overview',{headers})).status,401);
  assert.equal((await post('/admin/api/login',{password})).status,401);
  const next=await post('/admin/api/login',{password:replacement});assert.equal(next.status,200);
  const nextHeaders={cookie:next.headers.get('set-cookie').split(';')[0]};assert.equal((await post('/admin/api/logout',{},nextHeaders)).status,200);assert.equal((await fetch(base+'/admin/api/overview',{headers:nextHeaders})).status,401);
});

test('concurrent Admin password changes cannot both accept the same old password',async t=>{
  const AdminAuth=await authType(),store=new ManagerStore(':memory:');t.after(()=>store.close());
  const auth=new AdminAuth(store.db);await auth.initialize(password);
  const session=await auth.login(password),alternative='another-replacement-password';
  const results=await Promise.allSettled([auth.changePassword(password,replacement),auth.changePassword(password,alternative)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const rejected=results.find(result=>result.status==='rejected');assert.equal(rejected.reason.code,'CURRENT_PASSWORD_INVALID');
  const winner=results[0].status==='fulfilled'?replacement:alternative,loser=winner===replacement?alternative:replacement;
  assert.ok(await auth.login(winner));await assert.rejects(auth.login(loser),error=>error.code==='UNAUTHORIZED');
  await assert.rejects(auth.login(password),error=>error.code==='UNAUTHORIZED');assert.equal(auth.authorize(request(session.token)),false);
});

test('Admin HTTP operations cannot bypass current password verification or persist password arguments',async t=>{
  const [{AdminAuth},{createManagerServer},{createManagerOperations}]=await Promise.all([
    import('../src/manager/auth.mjs'),import('../src/manager/server.mjs'),import('../src/manager/operations.mjs')]);
  const store=new ManagerStore(':memory:');t.after(()=>store.close());const auth=new AdminAuth(store.db);await auth.initialize(password);
  const operations=createManagerOperations({store,auth}),server=createManagerServer({store,auth,operations});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const session=await auth.login(password),headers={'content-type':'application/json',cookie:'agent_admin='+session.token};
  const post=args=>fetch(`http://127.0.0.1:${server.address().port}/admin/api/operations`,{method:'POST',headers,body:JSON.stringify({action:'admin_password_set',args})});
  const missing=await post({password:replacement});assert.equal(missing.status,400);assert.equal((await missing.json()).error.code,'INVALID_MANAGEMENT_INPUT');
  const wrong=await post({currentPassword:'incorrect-old-password',password:replacement});assert.equal(wrong.status,403);assert.equal((await wrong.json()).error.code,'CURRENT_PASSWORD_INVALID');
  assert.equal(auth.authorize(request(session.token)),true);
  const changed=await post({currentPassword:password,password:replacement});assert.equal(changed.status,200);
  assert.equal(auth.authorize(request(session.token)),false);assert.ok(await auth.login(replacement));
  const history=JSON.stringify({actions:store.db.prepare('SELECT * FROM manager_actions').all(),messages:store.db.prepare('SELECT * FROM manager_messages').all()});
  for(const secret of [password,replacement,'incorrect-old-password'])assert.ok(!history.includes(secret));
});
test('local password recovery reads stdin and changes only Admin authentication',async t=>{
  const AdminAuth=await authType(),{spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
  const root=await temporaryRoot('admin-recovery-'),store=new ManagerStore(join(root,'manager.sqlite'));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const auth=new AdminAuth(store.db);await auth.initialize(password);const conversation=store.createConversation('保留历史');
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/admin-password.mjs',import.meta.url))],{env:{...process.env,MANAGER_DATA_DIR:root},input:replacement,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.ok(!result.stdout.includes(replacement));assert.ok(await auth.login(replacement));assert.equal(store.getConversation(conversation.id).title,'保留历史');
});
