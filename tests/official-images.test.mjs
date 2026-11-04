import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

function python(source){const r=spawnSync('python3',['-B','-c',source],{cwd:process.cwd(),encoding:'utf8',timeout:30000,env:{...process.env,PYTHONPATH:'scripts',PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(r.status,0,r.stdout+r.stderr);}
const fixture=`
import copy,hashlib,io,json,tarfile,tempfile
from pathlib import Path
import official_images as m
version='1.2.3';revision='a'*40
components=('gateway','runner','manager','sandbox')
def bundle(root,extra_tag=False):
 path=root/'images.tar.gz';entries=[];files={};images={}
 for c in components:
  labels={'org.opencontainers.image.source':'https://github.com/NM1024/codex-agent-platform','org.opencontainers.image.version':version,'org.opencontainers.image.revision':revision,'io.codex-agent-platform.component':c,'io.codex-agent-platform.distribution':'official'}
  config=json.dumps({'architecture':'amd64','os':'linux','config':{'Labels':labels}}).encode();digest=hashlib.sha256(config).hexdigest();name=digest+'.json';files[name]=config
  tag='codex-agent-platform-'+c+':'+version
  entries.append({'Config':name,'RepoTags':[tag]+(['unrelated-app:latest'] if extra_tag and c=='manager' else []),'Layers':[]})
  images[c]={'local_tag':tag,'id':'sha256:'+digest,'registry':None}
 files['manifest.json']=json.dumps(entries).encode()
 with tarfile.open(path,'w:gz') as tar:
  for name,data in files.items():
   item=tarfile.TarInfo(name);item.size=len(data);tar.addfile(item,io.BytesIO(data))
 value={'schema_version':1,'version':version,'revision':revision,'platform':'linux/amd64','archive':{'name':'codex-agent-platform-images-v'+version+'-linux-amd64.tar.gz','size':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()},'images':images}
 return path,value
def deny(fn):
 try:fn()
 except (ValueError,m.ImageError):return
 raise AssertionError('untrusted input was accepted')
`;

test('official manifests reject substituted versions, platforms, repositories and extra components',()=>python(fixture+`
with tempfile.TemporaryDirectory() as d:
 path,value=bundle(Path(d));assert m.validate_manifest(value,version,revision)==value
 for key,val in [('version','9.9.9'),('revision','b'*40),('platform','linux/arm64')]:
  changed=copy.deepcopy(value);changed[key]=val;deny(lambda:m.validate_manifest(changed,version,revision))
 changed=copy.deepcopy(value);changed['images']['gateway']['registry']='ghcr.io/other/app@sha256:'+'b'*64;deny(lambda:m.validate_manifest(changed,version,revision))
 changed=copy.deepcopy(value);changed['images']['extra']=changed['images']['manager'];deny(lambda:m.validate_manifest(changed,version,revision))
`));
test('official archives verify real config digests and reject unrelated tags before Docker import',()=>python(fixture+`
with tempfile.TemporaryDirectory() as d:
 root=Path(d);path,value=bundle(root);m.verify_archive(path,value)
 changed=copy.deepcopy(value);changed['images']['gateway']['id']='sha256:'+'0'*64;deny(lambda:m.verify_archive(path,changed))
 path,value=bundle(root,extra_tag=True);deny(lambda:m.verify_archive(path,value))
`));
test('registry acquisition failure falls back to the verified official archive without source builds',()=>python(fixture+`
with tempfile.TemporaryDirectory() as d:
 root=Path(d);path,value=bundle(root);source=root/'source';source.mkdir();(source/'package.json').write_text(json.dumps({'version':version}));(source/'.release-revision').write_text(revision)
 for c in components:value['images'][c]['registry']='ghcr.io/nm1024/codex-agent-platform-'+c+'@sha256:'+'c'*64
 body=json.dumps(value).encode();sums=hashlib.sha256(body).hexdigest()+'  container-images.json\\n'+value['archive']['sha256']+'  '+value['archive']['name']+'\\n';calls=[]
 def download(url,dest,limit):
  if url.endswith('container-images.json'):dest.write_bytes(body)
  elif url.endswith('SHA256SUMS'):dest.write_text(sums)
  elif url.endswith(value['archive']['name']):dest.write_bytes(path.read_bytes())
  else:raise AssertionError(url)
 def run(args,capture=False,**kwargs):
  calls.append(args)
  if args[:2]==['docker','info']:return 'linux/x86_64'
  if args[:2]==['docker','pull']:raise m.ImageError('registry unavailable')
  if args[:3]==['docker','image','inspect']:
   image=next(x for x in value['images'].values() if x['id']==args[-1]);component=next(k for k,v in value['images'].items() if v==image)
   return json.dumps([{'Id':image['id'],'Architecture':'amd64','Os':'linux','Config':{'Labels':{'org.opencontainers.image.source':'https://github.com/NM1024/codex-agent-platform','org.opencontainers.image.version':version,'org.opencontainers.image.revision':revision,'io.codex-agent-platform.component':component,'io.codex-agent-platform.distribution':'official'}}}])
  return ''
 result=m.prepare(source,root,version,run=run,download=download)
 assert result['version']==version
 assert any(x[:2]==['docker','load'] for x in calls)
 assert len([x for x in calls if x[:2]==['docker','tag']])==4
 assert not any('build' in x for x in calls)
`));
test('tampered image downloads are rejected without importing or retagging anything',()=>python(fixture+`
with tempfile.TemporaryDirectory() as d:
 root=Path(d);path,value=bundle(root);source=root/'source';source.mkdir();(source/'package.json').write_text(json.dumps({'version':version}));(source/'.release-revision').write_text(revision);calls=[]
 body=json.dumps(value).encode();sums=hashlib.sha256(body).hexdigest()+'  container-images.json\\n'+value['archive']['sha256']+'  '+value['archive']['name']+'\\n'
 def download(url,dest,limit):dest.write_bytes(body if url.endswith('container-images.json') else sums.encode() if url.endswith('SHA256SUMS') else b'corrupted')
 def run(args,**kwargs):calls.append(args);return 'linux/x86_64' if args[:2]==['docker','info'] else ''
 deny(lambda:m.prepare(source,root,version,run=run,download=download));assert all(x[:2]==['docker','info'] for x in calls)
`));
test('dependency normalization changes only root application versions across releases',async()=>{
 const {dependencyManifests}=await import('../scripts/dependency-manifests.mjs');
 const pkg={name:'synthetic',version:'1.0.7',dependencies:{sample:'1.2.3'}},lock={version:'1.0.7',packages:{'':structuredClone(pkg),'node_modules/sample':{version:'1.2.3',integrity:'synthetic'}}};
 const a=dependencyManifests(pkg,lock);pkg.version='1.0.8';lock.version='1.0.8';lock.packages[''].version='1.0.8';
 assert.deepEqual(dependencyManifests(pkg,lock),a);assert.equal(a[0].version,'0.0.0');assert.deepEqual(a[1].packages['node_modules/sample'],lock.packages['node_modules/sample']);assert.equal(pkg.version,'1.0.8');
});

test('official bundle production records exact config IDs and binds archive and manifest checksums',()=>python(fixture+`
import gzip,importlib.util
spec=importlib.util.spec_from_file_location('publisher','scripts/container-release.py');publisher=importlib.util.module_from_spec(spec);spec.loader.exec_module(publisher)
with tempfile.TemporaryDirectory() as d:
 root=Path(d);original,value=bundle(root);source=root/'source';source.mkdir();(source/'package.json').write_text(json.dumps({'version':version}));output=root/'out'
 def run(args,capture=False,**kwargs):
  if args[:3]==['docker','image','inspect']:
   component=next(c for c,v in value['images'].items() if args[-1] in (v['local_tag'],v['id']));image=value['images'][component]
   return json.dumps([{'Id':image['id'],'Architecture':'amd64','Os':'linux','Config':{'Labels':m.labels_for(component,value)}}])
  if args[:2]==['docker','save']:Path(args[args.index('--output')+1]).write_bytes(gzip.decompress(original.read_bytes()));return ''
  raise AssertionError(args)
 path=publisher.create_bundle(source,output,revision,run=run)
 saved=m.validate_manifest(json.loads(path.read_text()),version,revision);m.verify_archive(output/saved['archive']['name'],saved)
 sums=m.checksums((output/'SHA256SUMS').read_text());assert sums['container-images.json']==m.sha256_file(path);assert sums[saved['archive']['name']]==saved['archive']['sha256']
`));

test('unsupported host architecture fails before downloading or importing official images',()=>python(fixture+`
with tempfile.TemporaryDirectory() as d:
 root=Path(d);source=root/'source';source.mkdir();(source/'package.json').write_text(json.dumps({'version':version}));(source/'.release-revision').write_text(revision);calls=[]
 def run(args,capture=False,**kwargs):calls.append(args);return 'linux/aarch64'
 def download(*args):raise AssertionError('unsupported host should not acquire images')
 deny(lambda:m.prepare(source,root,version,run=run,download=download));assert calls==[['docker','info','--format','{{.OSType}}/{{.Architecture}}']]
`));
