import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {dirname,resolve,relative} from 'node:path';

export const pageRoots={overview:'OverviewPage',chat:'ChatPage',tasks:'TasksPage',plugins:'PluginsPage',schedules:'SchedulesPage',system:'SystemPage',settings:'SettingsPage'};
const suites={
 shell:['mobile-shell','loading-layout','ui-feedback','ui-completeness','chat-navigation-send','chat-queue','version-upgrade'],
 layout:['mobile-shell','loading-layout','modal-layout','connection-layout','ui-feedback','ui-completeness'],
 overview:['overview-controls','overview-resources'],
 chat:['chat-*','manager-concurrency','reasoning-inheritance','model-options','model-service-tier','sandbox-chat'],
 tasks:['admin-records','schedule-history','execution-notifications'],
 plugins:['admin-plugins','plugin-*','entry-key-claim','connection-layout'],
 schedules:['admin-schedules','cron-picker','schedule-history'],
 settings:['admin-settings','http-targets','history-retention','admin-notifications','model-options','model-service-tier'],
 system:['system-operations'],versions:['version-upgrade'],sandbox:['sandbox-chat'],
 notifications:['admin-notifications','execution-notifications','notification-integration'],
 models:['model-options','model-service-tier','chat-agent-picker','reasoning-inheritance'],i18n:[],
};
const pageGroups=Object.fromEntries(Object.entries(pageRoots).map(([group,name])=>['frontend/src/pages/'+name+'.tsx',group]));
export function dependencyKey(lock){
 const value=structuredClone(lock);delete value.version;if(value.packages?.[''])delete value.packages[''].version;
 return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function planChecks({files,specs,baseAvailable=true,mode='auto',dependencyChanged=false,frontendConsumers={},browserConsumers={},browserPages={}}){
 if(!['auto','release','full'].includes(mode))throw new Error('Unknown CI mode');
 const groups=new Set(),selected=new Set(),reasons=[];let checks=false,core=false,full=false,release=false;
 const add=(group,reason)=>{checks=true;core=true;groups.add(group);reasons.push(reason);};
 const expand=reason=>{checks=core=full=release=true;reasons.push(reason);};
 if(!baseAvailable)expand('Change base unavailable: run all verification');
 if(mode==='full')expand('Full verification requested');
 if(mode==='release'){checks=core=release=true;reasons.push('Release verification requested');}
 for(const file of files){
  if(/^(?:README(?:\.zh-CN)?\.md|LICENSE)$/.test(file)||file.startsWith('docs/')&&file.endsWith('.md'))continue;
  checks=true;
  if(file==='package.json'||file==='package-lock.json'){
   if(dependencyChanged)expand('Dependency or package configuration changed');else{add('versions','Application version metadata changed');release=true;}continue;
  }
  if(file==='.github/workflows/ci.yml'||file==='.github/workflows/release.yml'||/^scripts\/(?:ci(?:-policy)?|verify-release-ci)\.mjs$/.test(file)||file==='tests/ci-plan.test.mjs'){
   add('shell','CI policy changed: verify policy and browser entry');continue;
  }
  if(/^tests\/browser\/.*\.spec\.mjs$/.test(file)&&specs.includes(file)){core=true;selected.add(file);continue;}
  if(file.startsWith('tests/browser/')){
   const consumers=browserConsumers[file]??[];
   if(consumers.length){core=true;for(const spec of consumers)selected.add(spec);}else expand('Unclassified browser fixture: '+file);continue;
  }
  if(file.startsWith('tests/integration/')||file.startsWith('tests/helpers/')||/^tests\/sandbox-/.test(file)){add('versions','Container, host fixture or upgrade integration changed');release=true;continue;}
  if(file.startsWith('tests/'))continue;
  if(/^(Dockerfile(?:\.sandbox)?|compose\.yaml|deploy\.sh|\.dockerignore|\.env\.example)$/.test(file)||file==='scripts/update-release.py'||file==='scripts/host-updater.py'||file==='scripts/package-release.py'){
   add('versions','Deployment or release packaging changed');release=true;continue;
  }
  if(/^scripts\/(?:host-sandbox|sandbox[_-]).*/.test(file)){
   add('sandbox','Host sandbox changed');release=true;continue;
  }
  if(file==='src/manager/auth.mjs'||file==='frontend/src/context.tsx'||file==='frontend/src/i18n.ts'||/^(src\/.*(?:migration|schema)|prompts\/|playwright\.config\.mjs)/.test(file)){expand('Shared authentication, translation logic, schema or test foundation changed: '+file);continue;}
  if(file==='frontend/src/App.tsx'||file==='frontend/src/main.tsx'){
   add('shell','Shared navigation/session entry changed');continue;
  }
  if(file==='frontend/src/theme.ts'||file==='frontend/src/console.css'||file==='frontend/src/useVisualViewport.ts'){
   add('layout','Shared responsive layout changed');continue;
  }
  if(/^frontend\/src\/Version|^frontend\/src\/version[.-]/.test(file)||file==='src/manager/version.mjs'){
   add('versions','Version interface changed');continue;
  }
  if(file.startsWith('frontend/')){
   const consumers=pageGroups[file]?[pageGroups[file]]:frontendConsumers[file]??[];
   if(consumers.length)for(const group of consumers)add(group,'Frontend consumer '+group+': '+file);
   else expand('Unclassified frontend dependency: '+file);
   if(/Notification|notification/.test(file))add('notifications','Shared notification interface changed');
   if(/Model|model|AgentPicker/.test(file))add('models','Shared model interface changed');
   continue;
  }
  if(file.startsWith('src/observability/')){add('system','System operations changed');continue;}
  if(/^src\/(?:sandbox\/|manager\/sandbox)/.test(file)){add('sandbox','Sandbox interface changed');release=true;continue;}
  if(file.startsWith('src/manager/chat-')||file==='src/manager/questions.mjs'){add('chat','Management chat changed');continue;}
  expand('Unclassified shared/runtime change: '+file);
 }
 const matches=(name,patterns)=>patterns.some(pattern=>pattern.endsWith('*')?name.startsWith(pattern.slice(0,-1)):name===pattern);
 if(core&&specs.some(spec=>!files.includes(spec)&&!['tests/browser/console.spec.mjs','tests/browser/page-routing.spec.mjs'].includes(spec)&&!(browserPages[spec]??[]).length&&!matches(spec.split('/').at(-1).replace('.spec.mjs',''),Object.values(suites).flat()))){
  full=true;reasons.push('Unmapped existing browser suite: expand browser verification');
 }
 for(const spec of specs){
  const name=spec.split('/').at(-1).replace('.spec.mjs','');
  if([...groups].some(group=>(browserPages[spec]??[]).includes(group)||matches(name,suites[group]??[])))selected.add(spec);
 }
 const browserFiles=full?[...specs]:specs.filter(spec=>selected.has(spec));
 return {version:1,files:[...files],checks,core,browser:core||browserFiles.length>0,full,release,groups:[...groups].sort(),browserFiles,reasons:[...new Set(reasons)]};
}
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function browserArguments(plan){
 if(plan.browserFiles.some(file=>!/^tests\/browser\/[a-z0-9-]+\.spec\.mjs$/.test(file)))throw new Error('Invalid browser file');
 const files=[...new Set([...(plan.core?['tests/browser/console.spec.mjs','tests/browser/page-routing.spec.mjs']:[]),...plan.browserFiles])];
 if(plan.full)return ['playwright','test',...files];
 const patterns=[...(plan.core?['@ci-core','page-routing\\.spec\\.mjs']:[]),...plan.groups.map(group=>'@ci-'+group+'(?:\\s|$)'),...plan.browserFiles.map(file=>escape(file.split('/').at(-1)))];
 return ['playwright','test',...files,'--grep',patterns.join('|')];
}
/** Reverse transitive imports, including CSS, re-exports and dynamic imports. */
export async function findConsumers(root,entries){
 const result={},cache=new Map();
 async function imports(file){
  if(cache.has(file))return cache.get(file);
  const values=[];cache.set(file,values);let source;try{source=await readFile(resolve(root,file),'utf8');}catch{return values;}
  for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)){
   const base=resolve(root,dirname(file),match[1]);
   if(!base.startsWith(resolve(root)+'/'))continue;
   for(const suffix of ['', '.tsx','.ts','.mjs','.js','.css','/index.tsx','/index.ts']){
    const candidate=base+suffix;if(await stat(candidate).then(s=>s.isFile()).catch(()=>false)){values.push(relative(root,candidate).replaceAll('\\','/'));break;}
   }
  }
  return values;
 }
 for(const [consumer,entry] of Object.entries(entries)){
  const visited=new Set();async function visit(file){if(visited.has(file))return;visited.add(file);(result[file]??=[]).push(consumer);for(const child of await imports(file))await visit(child);}await visit(entry);
 }
 return result;
}
/** Include suites for every page they actually navigate through, not only their name. */
export async function findBrowserPages(root,specs){
 const result={};
 for(const spec of specs){
  if(spec==='tests/browser/console.spec.mjs')continue; // Individual scope tags split this legacy multi-page file.
  const source=await readFile(resolve(root,spec),'utf8'),pages=new Set();
  for(const match of source.matchAll(/\bnavigate\(\s*\w+\s*,\s*['"](\w+)['"]|\/admin\/(overview|chat|tasks|plugins|schedules|system|settings)(?:['"/?])|data-view=\\?['"](\w+)/g)){
   const page=match[1]??match[2]??match[3];if(Object.hasOwn(pageRoots,page))pages.add(page);
  }
  if(/\bnavigate\(\s*\w+\s*,\s*[A-Za-z_$]/.test(source))for(const page of Object.keys(pageRoots))pages.add(page);
  result[spec]=[...pages];
 }
 return result;
}
export function releaseEvidence(run,jobs,sha){
 return run.head_sha===sha&&run.conclusion==='success'&&['test',`Release verification (${sha})`].every(name=>jobs.some(job=>job.name===name&&job.conclusion==='success'));
}
export function validateLegacyCoverage(report){
 let found=0;const known=new Set(['core',...Object.keys(suites)]);
 function visit(suite){
  for(const spec of suite.specs??[]){
   if((spec.file??'').replaceAll('\\','/').split('/').at(-1)!=='console.spec.mjs')continue;found++;
   if(!(spec.tags??[]).some(tag=>typeof tag==='string'&&/^@?ci-/.test(tag)&&known.has(tag.replace(/^@?ci-/,''))))throw new Error('Assign a CI scope to legacy browser case: '+spec.title);
  }
  for(const child of suite.suites??[])visit(child);
 }
 for(const suite of report.suites??[])visit(suite);
 if(!found)throw new Error('Legacy browser inventory missing');
}
