import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

test('ordinary build compiles source while legacy staged build prepares official images by default',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'official-deploy-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=join(dir,'source'),data=join(dir,'data'),bin=join(dir,'bin'),log=join(dir,'calls');
 for(const path of [source,join(source,'scripts'),data,bin])await mkdir(path,{recursive:true});
 await copyFile('deploy.sh',join(source,'deploy.sh'));await chmod(join(source,'deploy.sh'),0o700);await copyFile('package.json',join(source,'package.json'));
 await writeFile(join(source,'scripts/update-release.py'),'import sys\nfrom pathlib import Path\nprint(Path(__file__).resolve().parents[1]);print(sys.argv[sys.argv.index("--data")+1]);print("synthetic")\n');
 await writeFile(join(source,'scripts/container-release.py'),'import json,sys,os\nwith open(os.environ["CALL_LOG"],"a") as out:out.write(json.dumps({"image_helper":sys.argv[1:]})+"\\n")\nif sys.argv[1]=="revision":print("a"*40)\n');
 await writeFile(join(bin,'docker'),'#!/usr/bin/env python3\nimport json,sys,os\nwith open(os.environ["CALL_LOG"],"a") as out:out.write(json.dumps({"docker":sys.argv[1:]})+"\\n")\n',{mode:0o700});
 for(const [action,staged,method,compile] of [['build',false,'',true],['build',true,'',false],['build',true,'source',true],['pull',true,'',false]]){
  await writeFile(log,'');const env={...process.env,PATH:bin+':'+process.env.PATH,CALL_LOG:log,PLATFORM_PROJECT:'synthetic'};delete env.PLATFORM_UPDATE_STAGED;delete env.PLATFORM_UPDATE_METHOD;
  if(staged)env.PLATFORM_UPDATE_STAGED='1';if(method)env.PLATFORM_UPDATE_METHOD=method;
  const result=spawnSync('bash',[join(source,'deploy.sh'),action,data],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.some(x=>x.docker?.includes('build')),compile);assert.equal(calls.some(x=>x.image_helper?.[0]==='prepare'),!compile);
 }
});
