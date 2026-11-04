import {execFileSync,spawnSync} from 'node:child_process';
import {readFile,readdir,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {planChecks,dependencyKey,findConsumers,findBrowserPages,browserArguments,pageRoots,validateLegacyCoverage} from './ci-policy.mjs';
const root=process.cwd(),file=resolve(root,'.tmp/ci-plan.json');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const specs=(await readdir('tests/browser')).filter(name=>name.endsWith('.spec.mjs')).sort().map(name=>'tests/browser/'+name);
if(process.argv[2]==='browser'){
 const plan=JSON.parse(await readFile(file,'utf8'));
 if(plan.browserFiles.some(spec=>!specs.includes(spec)))throw new Error('Unknown browser selection');
 if(!plan.browser)throw new Error('No browser verification selected');
 const inventory=spawnSync('npx',['playwright','test','tests/browser/console.spec.mjs','--list','--reporter=json'],{encoding:'utf8',stdio:['ignore','pipe','inherit']});
 if(inventory.error)throw inventory.error;if(inventory.status!==0)throw new Error('Browser inventory failed');
 validateLegacyCoverage(JSON.parse(inventory.stdout));
 const result=spawnSync('npx',browserArguments(plan),{stdio:'inherit'});if(result.error)throw result.error;process.exit(result.status??1);
}else if(process.argv[2]==='plan'){
 let mode=process.env.CI_MODE||'auto';if(process.env.GITHUB_EVENT_NAME==='schedule')mode='full';
 let base=process.env.CI_BASE_SHA,baseAvailable=false,files=[],dependencyChanged=false;
 if(!base&&mode==='release'){
  const head=git('rev-parse','HEAD').trim();
  for(const tag of git('tag','--merged','HEAD','--sort=-version:refname').trim().split('\n')){
   if(/^v\d+\.\d+\.\d+$/.test(tag)&&git('rev-parse',tag+'^{commit}').trim()!==head){base=git('rev-parse',tag+'^{commit}').trim();break;}
  }
 }
 if(/^[0-9a-f]{40}$/.test(base??'')&&!/^0+$/.test(base)){
  try{git('rev-parse','--verify',base+'^{commit}');files=git('diff','--name-only','--no-renames','-z',base,'HEAD').split('\0').filter(Boolean);baseAvailable=true;}catch{}
 }
 const lock=JSON.parse(await readFile('package-lock.json','utf8'));
 if(baseAvailable&&files.some(name=>name==='package.json'||name==='package-lock.json')){
  try{
   const previous=JSON.parse(git('show',base+':package-lock.json'));const pkg=JSON.parse(await readFile('package.json','utf8')),old=JSON.parse(git('show',base+':package.json'));delete pkg.version;delete old.version;
   dependencyChanged=dependencyKey(lock)!==dependencyKey(previous)||JSON.stringify(pkg)!==JSON.stringify(old);
  }catch{dependencyChanged=true;}
 }
 const frontendConsumers=await findConsumers(root,Object.fromEntries(Object.entries(pageRoots).map(([group,name])=>[group,'frontend/src/pages/'+name+'.tsx'])));
 const browserConsumers=await findConsumers(root,Object.fromEntries(specs.map(spec=>[spec,spec])));
 const browserPages=await findBrowserPages(root,specs);
 const testedSha=git('rev-parse','HEAD').trim();
 const plan={...planChecks({files,specs,baseAvailable,mode,dependencyChanged,frontendConsumers,browserConsumers,browserPages}),dependencyKey:dependencyKey(lock),testedSha};
 await mkdir('.tmp',{recursive:true});await writeFile(file,JSON.stringify(plan,null,2)+'\n');
 if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,['checks','browser','release'].map(key=>`${key}=${plan[key]}\n`).join('')+`dependency_key=${plan.dependencyKey}\ntested_sha=${testedSha}\n`);
 const summary=`## CI scope\n\nMode: **${plan.full?'full':plan.release?'release':'scoped'}**\n\n${plan.reasons.map(reason=>'- '+reason).join('\n')||'Documentation only; no runtime changes.'}\n\nBrowser groups: ${plan.groups.join(', ')||'core only'}\n\nBrowser files: ${plan.browserFiles.length}; container/upgrade verification: ${plan.release}.\n\nChanged files:\n\n${plan.files.map(name=>'    '+JSON.stringify(name)).join('\n')}\n`;
 console.log(summary);if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,summary);
}else throw new Error('Usage: node scripts/ci.mjs plan|browser');
