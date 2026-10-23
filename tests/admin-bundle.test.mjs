import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerServer} from '../src/manager/server.mjs';
import {ManagerStore} from '../src/manager/store.mjs';
import {request} from 'node:http';
import {brotliDecompressSync,gunzipSync,gzipSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';

function raw(url,encoding,method='GET') {
  return new Promise((resolve,reject)=>{
    const req=request(url,{method,headers:{'accept-encoding':encoding}},res=>{
      const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts)}));
    });req.on('error',reject);req.end();
  });
}

test('Admin entry defers pages and keeps the initial gzip graph below 300 kB',async()=>{
  const root=new URL('../src/manager/web-dist/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('.vite/manifest.json',root),'utf8'));
  const entry=Object.values(manifest).find(item=>item.isEntry);
  assert.ok(entry.dynamicImports.length>=6,'all six pages load on demand');
  const seen=new Set();let bytes=0;
  async function visit(item){if(seen.has(item.file))return;seen.add(item.file);bytes+=gzipSync(await readFile(new URL(item.file,root))).length;for(const key of item.imports??[])await visit(manifest[key]);}
  await visit(entry);
  assert.ok(bytes<300_000,`initial JS gzip: ${bytes} bytes`);
});

test('Manager negotiates compressed static assets with exact HEAD lengths and identity fallback',async t=>{
  const store=new ManagerStore(':memory:');
  const server=createManagerServer({store,agent:{},operations:{},auth:{authorize:()=>false},metrics:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const root=`http://127.0.0.1:${server.address().port}`;
  const html=await (await fetch(root+'/admin/')).text();
  const path=html.match(/src="(\/admin\/assets\/[^" ]+\.js)"/)[1];
  const identity=await raw(root+path,'identity');
  for(const [encoding,decode] of [['gzip',gunzipSync],['br',brotliDecompressSync]]){
    const result=await raw(root+path,encoding);
    assert.equal(result.status,200);assert.equal(result.headers['content-encoding'],encoding);
    assert.equal(result.headers.vary,'Accept-Encoding');assert.match(result.headers['content-type'],/javascript/);
    assert.deepEqual(decode(result.body),identity.body);assert.ok(result.body.length<identity.body.length/2);
    assert.equal(Number(result.headers['content-length']),result.body.length);
    const head=await raw(root+path,encoding,'HEAD');assert.equal(head.body.length,0);assert.equal(head.headers['content-length'],result.headers['content-length']);assert.equal(head.headers['content-encoding'],encoding);
  }
  for(const [accept,expected] of [['br;q=0, gzip','gzip'],['gzip;q=1, br;q=0.5','gzip'],['gzip;q=0, br;q=0',undefined],['br;q=0, *;q=0.5','gzip'],['GZIP','gzip'],['identity;q=1, gzip;q=0.5',undefined]])assert.equal((await raw(root+path,accept)).headers['content-encoding'],expected,accept);
  assert.equal((await raw(root+path,'*;q=0')).status,406);
  assert.equal((await raw(root+'/admin/','br,gzip')).headers['content-encoding'],undefined);
  assert.equal((await raw(root+path+'.br','br')).status,404);
  assert.equal((await raw(root+'/admin/assets/missing.js','br')).status,404);
});

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
