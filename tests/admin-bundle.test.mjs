import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerServer} from '../src/manager/server.mjs';
import {ManagerStore} from '../src/manager/store.mjs';

test('Manager serves only the React bundle, nonce styles and referenced immutable assets',async t=>{
  const store=new ManagerStore(':memory:');
  const server=createManagerServer({store,agent:{},operations:{},auth:{authorize:()=>false},metrics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const root=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(root+'/admin/'),html=await response.text();
  assert.equal(response.status,200);
  assert.match(html,/<div id="root"><\/div>/);
  const nonce=html.match(/name="csp-nonce" content="([^"]+)"/)?.[1];
  assert.ok(nonce && nonce!=='__CSP_NONCE__');
  assert.ok(response.headers.get('content-security-policy').includes(`'nonce-${nonce}'`));
  assert.notEqual((await (await fetch(root+'/admin/')).text()).match(/name="csp-nonce" content="([^"]+)"/)?.[1],nonce);
  const scripts=[...html.matchAll(/(?:src|href)="(\/admin\/assets\/[^" ]+)"/g)].map(match=>match[1]);
  assert.ok(scripts.some(path=>path.endsWith('.js')));assert.ok(scripts.some(path=>path.endsWith('.css')));
  for(const path of scripts){const asset=await fetch(root+path);assert.equal(asset.status,200);assert.match(asset.headers.get('cache-control'),/immutable/);}
  const notices=await fetch(root+'/admin/third-party-notices.md');assert.equal(notices.status,200);assert.match(await notices.text(),/react/i);
  for(const path of ['/admin/app.js','/admin/style.css','/admin/i18n.js','/admin/agent-picker.js','/admin/assets/missing.js','/admin/assets/%2e%2e%2fserver.mjs'])assert.equal((await fetch(root+path)).status,404,path);
});
