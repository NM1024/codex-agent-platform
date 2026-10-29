import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProjectSourceReader} from '../src/manager/project-source.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'manager-source-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const dir of ['src/manager','frontend/src','prompts','docs','src/manager/web-dist','src/manager/.private'])await mkdir(join(root,dir),{recursive:true});
  for(const [path,text] of Object.entries({
    'src/manager/server.mjs':'// Synthetic 管理端\nexport const enabled = true;\n',
    'frontend/src/Console.tsx':'export const view = "synthetic";\n',
    'prompts/manager-project.md':'Synthetic current rules\n',
    'docs/ARCHITECTURE.md':'Synthetic architecture\n',
    '.env':'SECRET_ENV_SENTINEL',
    'src/manager/auth.json':'SECRET_AUTH_SENTINEL',
    'src/manager/.private/hidden.mjs':'SECRET_HIDDEN_SENTINEL',
    'src/manager/web-dist/bundle.mjs':'SECRET_GENERATED_SENTINEL',
    'src/manager/state.sqlite':'SECRET_DATABASE_SENTINEL',
  }))await writeFile(join(root,path),text);
  const outside=join(root,'private.mjs');await writeFile(outside,'SECRET_SYMLINK_SENTINEL');
  await symlink(outside,join(root,'src/manager/link.mjs'));
  await symlink(join(root,'docs'),join(root,'src/manager/linked-dir'));
  return {root,read:createProjectSourceReader(root)};
}

test('source list/read/search use deployed files, line numbers and content revisions',async t=>{
  const {root,read}=await fixture(t);
  const first=await read({mode:'list',limit:2});
  const second=await read({mode:'list',offset:first.next_offset,limit:2});
  assert.equal(first.revision,second.revision);
  assert.deepEqual([...first.files,...second.files].map(f=>f.path),['docs/ARCHITECTURE.md','frontend/src/Console.tsx','prompts/manager-project.md','src/manager/server.mjs']);
  const file=await read({mode:'read',path:'src/manager/server.mjs',offset:1,limit:1});
  assert.equal(file.content,'2: export const enabled = true;');
  assert.equal(file.start_line,2);assert.equal(file.revision,first.revision);
  const matches=await read({mode:'search',query:'管理端'});
  assert.deepEqual(matches.matches,[{path:'src/manager/server.mjs',line:1,text:'// Synthetic 管理端'}]);
  assert.deepEqual((await read({mode:'search',query:'[a-z]+'})).matches,[],'search treats query as literal text');
  await writeFile(join(root,'src/manager/server.mjs'),'// Updated deployed source\n');
  assert.notEqual((await read({mode:'list'})).revision,first.revision);
});

test('source queries deny traversal, secrets, generated assets and symlink files or directories',async t=>{
  const {read}=await fixture(t);
  for(const path of ['.env','/etc/passwd','../private.mjs','src/manager/../../private.mjs','src\\manager\\server.mjs','src/manager/auth.json','src/manager/state.sqlite','src/manager/.private/hidden.mjs','src/manager/web-dist/bundle.mjs','src/manager/link.mjs','src/manager/linked-dir/ARCHITECTURE.md'])
    await assert.rejects(read({mode:'read',path}),error=>['SOURCE_PATH_DENIED','SOURCE_FILE_NOT_FOUND'].includes(error.code),path);
  assert.ok(!JSON.stringify(await read({mode:'search',query:'SECRET_'})).includes('SENTINEL'));
  assert.deepEqual((await read({mode:'search',query:'SECRET_'})).matches,[]);
});

test('source output is bounded and queries never write or execute source',async t=>{
  const {root,read}=await fixture(t);
  await writeFile(join(root,'src/manager/large.mjs'),'x'.repeat(300000));
  await assert.rejects(read({mode:'read',path:'src/manager/large.mjs'}),{code:'SOURCE_FILE_TOO_LARGE'});
  await writeFile(join(root,'src/manager/lines.mjs'),Array.from({length:500},(_,n)=>`line ${n} ${'汉'.repeat(1000)}`).join('\n'));
  await assert.rejects(read({mode:'read',path:'src/manager/lines.mjs'}),{code:'SOURCE_FILE_TOO_LARGE'});
  await writeFile(join(root,'src/manager/lines.mjs'),Array.from({length:500},(_,n)=>`line ${n}`).join('\n'));
  const page=await read({mode:'read',path:'src/manager/lines.mjs',limit:200});
  assert.equal(page.next_offset,200);assert.equal(page.content.split('\n').length,200);
  const matches=await read({mode:'search',query:'line',limit:2});
  assert.equal(matches.matches.length,2);assert.equal(matches.next_offset,2);
  await assert.rejects(read({mode:'write',path:'src/manager/server.mjs'}),{code:'INVALID_SOURCE_QUERY'});
  await assert.rejects(read({mode:'search',query:''}),{code:'INVALID_SOURCE_QUERY'});
});
