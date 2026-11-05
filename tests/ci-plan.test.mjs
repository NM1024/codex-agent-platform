import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planChecks,dependencyKey,findConsumers,findBrowserPages,browserArguments,releaseEvidence,validateLegacyCoverage} from '../scripts/ci-policy.mjs';

const specs=['console','page-routing','admin-records','schedule-history','execution-notifications','admin-plugins','version-upgrade','system-operations','mobile-shell'].map(x=>'tests/browser/'+x+'.spec.mjs');
const plan=(files,extra={})=>planChecks({files,specs,baseAvailable:true,...extra});
test('documentation does not build images, install browsers or qualify a release',()=>{
 const p=plan(['README.md','docs/DEPLOYMENT.md']);assert.equal(p.checks,false);assert.equal(p.browser,false);assert.equal(p.release,false);
});
test('task-page changes select task coverage and core navigation without unrelated plugin tests',()=>{
 const p=plan(['frontend/src/pages/TasksPage.tsx']);assert.equal(p.checks,true);assert.equal(p.browser,true);assert.equal(p.full,false);assert.equal(p.release,false);
 assert.ok(p.browserFiles.includes('tests/browser/admin-records.spec.mjs'));assert.ok(p.browserFiles.includes('tests/browser/schedule-history.spec.mjs'));assert.ok(!p.browserFiles.includes('tests/browser/admin-plugins.spec.mjs'));
 const args=browserArguments(p);assert.ok(args.includes('--grep'));assert.match(args.at(-1),/@ci-core/);assert.match(args.at(-1),/@ci-tasks/);
});
test('shared component changes reach every consuming page',()=>{
 const p=plan(['frontend/src/Shared.tsx'],{frontendConsumers:{'frontend/src/Shared.tsx':['tasks','plugins']}});
 assert.ok(p.browserFiles.includes('tests/browser/admin-records.spec.mjs'));assert.ok(p.browserFiles.includes('tests/browser/admin-plugins.spec.mjs'));assert.equal(p.full,false);
});
test('navigation changes run shared entry coverage without every business editor',()=>{
 const p=plan(['frontend/src/App.tsx']);assert.equal(p.full,false);assert.equal(p.release,false);assert.ok(p.groups.includes('shell'));assert.ok(!p.browserFiles.includes('tests/browser/admin-plugins.spec.mjs'));
 assert.equal(plan(['frontend/src/context.tsx']).full,true,'shared authentication/upload/question state must cover all consumers');
});
test('deployment changes require image and upgrade verification but only relevant browser flows',()=>{
 const p=plan(['deploy.sh','scripts/host-sandbox.py']);assert.equal(p.release,true);assert.equal(p.browser,true);assert.equal(p.full,false);assert.ok(p.groups.includes('sandbox'));assert.ok(p.browserFiles.includes('tests/browser/version-upgrade.spec.mjs'));
});
test('dependency, authentication, unknown and unavailable-base changes expand conservatively',()=>{
 for(const p of [plan(['package-lock.json'],{dependencyChanged:true}),plan(['src/manager/auth.mjs']),plan(['new-runtime-entry.mjs']),plan([],{baseAvailable:false})]){
  assert.equal(p.full,true);assert.equal(p.release,true);assert.deepEqual(p.browserFiles,specs);
 }
});
test('an application version bump does not invalidate npm dependency cache or force unrelated browser cases',()=>{
 const old={version:'1.0.6',packages:{'':{version:'1.0.6',dependencies:{sample:'1.2.3'}},'node_modules/sample':{version:'1.2.3',integrity:'synthetic'}}};
 const changed=structuredClone(old);changed.version='1.0.7';changed.packages[''].version='1.0.7';assert.equal(dependencyKey(old),dependencyKey(changed));
 changed.packages['node_modules/sample'].version='1.2.4';assert.notEqual(dependencyKey(old),dependencyKey(changed));
 const p=plan(['package.json','package-lock.json'],{dependencyChanged:false});assert.equal(p.release,true);assert.equal(p.full,false);
});
test('new tests are selected directly and changed helpers include indirect consumers',()=>{
 const p=plan(['tests/browser/new-flow.spec.mjs','tests/browser/helper.mjs'],{specs:[...specs,'tests/browser/new-flow.spec.mjs'],browserConsumers:{'tests/browser/helper.mjs':['tests/browser/admin-plugins.spec.mjs']}});
 assert.ok(p.browserFiles.includes('tests/browser/new-flow.spec.mjs'));assert.ok(p.browserFiles.includes('tests/browser/admin-plugins.spec.mjs'));assert.equal(p.full,false);
});
test('an unmapped existing browser suite expands page verification instead of disappearing',()=>{
 const p=plan(['frontend/src/pages/TasksPage.tsx'],{specs:[...specs,'tests/browser/new-flow.spec.mjs']});
 assert.equal(p.full,true);assert.ok(p.browserFiles.includes('tests/browser/new-flow.spec.mjs'));
});
test('full and release verification can be explicitly requested',()=>{
 const full=plan(['README.md'],{mode:'full'});assert.equal(full.full,true);assert.equal(full.release,true);assert.deepEqual(full.browserFiles,specs);
 const release=plan(['README.md'],{mode:'release'});assert.equal(release.release,true);assert.equal(release.browser,true);assert.equal(release.full,false);
});
test('dependency traversal follows indirect and cyclic imports using real files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ci-dependencies-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'src'));
 for(const [name,text] of [['page.tsx',"import './a';"],['a.ts',"export {x} from './b';"],['b.ts',"import './a';export const x=1;"]])await writeFile(join(root,'src',name),text);
 const consumers=await findConsumers(root,{tasks:'src/page.tsx'});assert.deepEqual(consumers['src/b.ts'],['tasks']);
});
test('browser arguments preserve file names as arguments and reject a tampered plan',()=>{
 const p=plan(['frontend/src/pages/TasksPage.tsx']);assert.equal(browserArguments(p).filter(x=>x==='tests/browser/console.spec.mjs').length,1);
 assert.throws(()=>browserArguments({...p,browserFiles:['--config=untrusted']}),/Invalid browser file/);
});
test('a successful scoped CI or skipped release job cannot authorize publishing',()=>{
 const sha='a'.repeat(40),run={id:1,head_sha:sha,event:'pull_request',conclusion:'success'},checks={name:'test',conclusion:'success'},release={name:'Release verification ('+sha+')',conclusion:'success'};
 assert.equal(releaseEvidence(run,[checks],sha),false);assert.equal(releaseEvidence(run,[checks,{...release,conclusion:'skipped'}],sha),false);
 assert.equal(releaseEvidence({...run,head_sha:'b'.repeat(40)},[checks,release],sha),false);assert.equal(releaseEvidence(run,[{...checks,conclusion:'failure'},release],sha),false);
 assert.equal(releaseEvidence(run,[checks,release],sha),true);
 assert.equal(releaseEvidence(run,[checks,{...release,name:'Release verification ('+'b'.repeat(40)+')'}],sha),false,'a PR merge checkout must not qualify the PR tip');
});
test('browser files are selected for every page their navigation actually exercises',async()=>{
 const names=['tests/browser/soft-deletion.spec.mjs','tests/browser/notification-integration.spec.mjs'];
 const browserPages=await findBrowserPages(process.cwd(),names);
 for(const view of ['plugins','schedules']){
  const p=plan(['frontend/src/pages/'+(view==='plugins'?'Plugins':'Schedules')+'Page.tsx'],{specs:[...specs,...names],browserPages});
  for(const name of names)assert.ok(p.browserFiles.includes(name),view+' omitted '+name);
 }
});
test('Docker-only tests and host fixtures execute their enabled integration path',()=>{
 for(const file of ['tests/sandbox-docker-integration.test.mjs','tests/sandbox-runtime.test.mjs','tests/helpers/sandbox-host-fixture.py'])assert.equal(plan([file]).release,true,file);
});
test('new unscoped legacy cases cannot silently disappear from future selected runs',()=>{
 const spec={file:'console.spec.mjs',title:'Synthetic legacy case',tags:['ci-tasks']};
 validateLegacyCoverage({suites:[{specs:[spec]}]});
 validateLegacyCoverage({suites:[{specs:[{...spec,file:'tests/browser/console.spec.mjs'}]}]});
 for(const tags of [[],['ci-unknown'],['tasks']])assert.throws(()=>validateLegacyCoverage({suites:[{specs:[{...spec,tags}]}]}),/Assign a CI scope/);
 assert.throws(()=>validateLegacyCoverage({suites:[]}),/inventory missing/);
});
test('the real Git planner includes both sides of renames and writes safe Actions outputs',async t=>{
 if(spawnSync('git',['--version']).error?.code==='ENOENT'){t.skip('Host Git integration runs on the CI host');return;}
 const root=await mkdtemp(join(tmpdir(),'ci-git-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const run=(command,args,env={})=>execFileSync(command,args,{cwd:root,encoding:'utf8',env:{...process.env,GITHUB_OUTPUT:'',GITHUB_STEP_SUMMARY:'',...env},stdio:['ignore','pipe','pipe']});
 for(const folder of ['scripts','frontend/src/pages','tests/browser'])await mkdir(join(root,folder),{recursive:true});
 for(const name of ['ci.mjs','ci-policy.mjs'])await copyFile(new URL('../scripts/'+name,import.meta.url),join(root,'scripts',name));
 await writeFile(join(root,'package.json'),'{"version":"1.0.6"}');await writeFile(join(root,'package-lock.json'),'{"version":"1.0.6","packages":{"":{"version":"1.0.6"}}}');
 await writeFile(join(root,'frontend/src/pages/TasksPage.tsx'),'// synthetic task page');
 for(const file of ['console','page-routing','admin-records'])await writeFile(join(root,'tests/browser',file+'.spec.mjs'),'// synthetic test inventory');
 run('git',['init','--quiet']);run('git',['config','user.name','Synthetic CI']);run('git',['config','user.email','ci@example.invalid']);run('git',['add','.']);run('git',['commit','--quiet','-m','baseline']);const base=run('git',['rev-parse','HEAD']).trim();
 await writeFile(join(root,'frontend/src/pages/TasksPage.tsx'),'// updated synthetic task page');run('git',['add','.']);run('git',['commit','--quiet','-m','task update']);
 const output=join(root,'outputs');run(process.execPath,['scripts/ci.mjs','plan'],{CI_BASE_SHA:base,CI_MODE:'auto',GITHUB_EVENT_NAME:'pull_request',GITHUB_OUTPUT:output});
 let p=JSON.parse(await readFile(join(root,'.tmp/ci-plan.json'),'utf8'));assert.deepEqual(p.groups,['tasks']);assert.equal(p.release,false);assert.ok((await readFile(output,'utf8')).includes('release=false\n'));
 run('git',['mv','frontend/src/pages/TasksPage.tsx','frontend/src/pages/Renamed.tsx']);run('git',['commit','--quiet','-m','rename']);
 run(process.execPath,['scripts/ci.mjs','plan'],{CI_BASE_SHA:base,CI_MODE:'auto',GITHUB_EVENT_NAME:'pull_request'});p=JSON.parse(await readFile(join(root,'.tmp/ci-plan.json'),'utf8'));assert.ok(p.files.includes('frontend/src/pages/TasksPage.tsx'));assert.ok(p.files.includes('frontend/src/pages/Renamed.tsx'));assert.equal(p.full,true);
});

test('optional CI retains container verification while releases use local revision verification',async t=>{
 for(const file of ['scripts/official_images.py','scripts/container-release.py','scripts/dependency-manifests.mjs'])assert.equal(plan([file]).release,true,file);
 let workflow;
 try{workflow=await readFile('.github/workflows/ci.yml','utf8');}catch(error){if(error.code==='ENOENT'){t.skip('Workflow files are validated on the CI host, outside the distributable image');return;}throw error;}
 assert.match(workflow,/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
 assert.match(workflow,/needs\.test\.outputs\.images_published == 'true'/);
 assert.ok(workflow.indexOf('Preserve successfully tested official image candidates')>workflow.indexOf('Verify real Compose source and image updates'));
 assert.ok(workflow.indexOf('Preserve successfully tested official image candidates')<workflow.indexOf('Run selected browser verification'));
 assert.equal(releaseEvidence({head_sha:'a'.repeat(40),conclusion:'failure'},[{name:'test',conclusion:'failure'},{name:'Release verification ('+'a'.repeat(40)+')',conclusion:'success'}],'a'.repeat(40)),false,'saved candidates cannot authorize a failed browser run');
 assert.match(workflow,/^  workflow_dispatch:/m);
 assert.doesNotMatch(workflow,/^  (?:pull_request|push|schedule):/m,'ordinary GitHub activity must not run tests');
 const release=await readFile('.github/workflows/release.yml','utf8');
 assert.match(release,/verified_sha:/);assert.match(release,/verify_release_identity/);
 assert.match(release,/docker build/);assert.match(release,/container-release\.py promote/);
 assert.ok(release.indexOf('verify_release_identity')<release.indexOf('docker build'),'identity must be checked before builds or publication');
 assert.doesNotMatch(release,/verify-release-ci|npm test|playwright|ci\.mjs/,'publishing must not repeat local tests');
});
