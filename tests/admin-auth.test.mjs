import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagerStore} from '../src/manager/store.mjs';
const password='initial-admin-password',replacement='replacement-admin-password';
async function authType(){const module=await import('../src/manager/auth.mjs').catch(()=>({}));assert.equal(typeof module.AdminAuth,'function','independent Admin password authentication exists');return module.AdminAuth;}
const request=token=>({headers:{cookie:'agent_admin='+token}});
test('Admin password hashes and sessions survive restart without resetting a changed password',async t=>{
  const AdminAuth=await authType(),root=await mkdtemp(join(tmpdir(),'admin-auth-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'manager.sqlite');
  let store=new ManagerStore(path),auth=new AdminAuth(store.db);await auth.initialize(password);
  const login=await auth.login(password);assert.equal(auth.authorize(request(login.token)),true);
  await auth.setPassword(replacement);assert.equal(auth.authorize(request(login.token)),false);store.close();
  store=new ManagerStore(path);t.after(()=>store.close());auth=new AdminAuth(store.db);await auth.initialize(password);
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
  assert.equal((await post('/admin/api/password',{password:replacement},headers)).status,200);
  assert.equal((await fetch(base+'/admin/api/overview',{headers})).status,401);
  assert.equal((await post('/admin/api/login',{password})).status,401);
  const next=await post('/admin/api/login',{password:replacement});assert.equal(next.status,200);
  const nextHeaders={cookie:next.headers.get('set-cookie').split(';')[0]};assert.equal((await post('/admin/api/logout',{},nextHeaders)).status,200);assert.equal((await fetch(base+'/admin/api/overview',{headers:nextHeaders})).status,401);
});
test('local password recovery reads stdin and changes only Admin authentication',async t=>{
  const AdminAuth=await authType(),{spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
  const root=await mkdtemp(join(tmpdir(),'admin-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new ManagerStore(join(root,'manager.sqlite'));t.after(()=>store.close());
  const auth=new AdminAuth(store.db);await auth.initialize(password);const conversation=store.createConversation('保留历史');
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/admin-password.mjs',import.meta.url))],{env:{...process.env,MANAGER_DATA_DIR:root},input:replacement,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.ok(!result.stdout.includes(replacement));assert.ok(await auth.login(replacement));assert.equal(store.getConversation(conversation.id).title,'保留历史');
});
