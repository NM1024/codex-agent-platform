import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
function python(code){
  const result=spawnSync('python3',['-B','-c',`import importlib.util,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('host_sandbox',Path('scripts/host-sandbox.py'))\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n${code}`],{cwd:root,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stdout+result.stderr);
}
test('fixed sandbox image has Python, Node24 and pinned data/test libraries without platform source',async()=>{
  const docker=await readFile(root+'/Dockerfile.sandbox','utf8');
  assert.match(docker,/node:24/);assert.match(docker,/python:3\.13\.8/);
  assert.match(docker,/USER 1000:1000/);assert.match(docker,/type=secret,id=proxy_ca/);
  assert.doesNotMatch(docker,/COPY .*src|COPY .*codex|insecure|trusted-host/);
  const deps=await readFile(root+'/scripts/sandbox-requirements.txt','utf8');
  for(const pkg of ['pytest','numpy','pandas','matplotlib','Pillow'])assert.match(deps,new RegExp('^'+pkg+'==[0-9.]+$','m'));
});
test('fixed Unix HTTP protocol rejects framing, identities, host controls and duplicate keys before dispatch',()=>python(`
import http.client,json,socket,struct,tempfile,threading
from unittest.mock import Mock
owner='11111111-1111-4111-8111-111111111111'
valid={'action':'context','conversation_id':owner,'args':{}}
assert m.request_body(json.dumps(valid).encode())==('context',owner,{})
assert m.request_body(b'{"action":"recover"}')==('recover',None,{})
cas={'action':'files','conversation_id':owner,'args':{'action':'write','path':'result.txt','text':'updated','expected_revision':3}}
assert m.request_body(json.dumps(cas).encode())==('files',owner,cas['args'])
for revision in [-1,1.5,True,'3',None]:
 try:m.request_body(json.dumps({**cas,'args':{**cas['args'],'expected_revision':revision}}).encode());raise AssertionError(revision)
 except ValueError:pass
try:m.request_body(json.dumps({**cas,'args':{**cas['args'],'docker_args':['--privileged']}}).encode());raise AssertionError('accepted Docker arguments')
except ValueError:pass
invalid=[{**valid,'image':'foreign'},{**valid,'action':'shell'},{**valid,'conversation_id':'OTHER'},
 {**valid,'args':{'docker_args':['--privileged']}},{'action':'recover','conversation_id':owner},
 {**valid,'args':[]},{'action':'context','conversation_id':owner,'args':{'text':'x'*m.CONTROL_BODY}}]
for request in invalid:
 try:m.request_body(json.dumps(request).encode());raise AssertionError(request)
 except ValueError:pass
for raw in [b'{"action":"recover","action":"exec"}',b'{"action":"recover","args":{"x":NaN}}']:
 try:m.request_body(raw);raise AssertionError(raw)
 except ValueError:pass
for uid,want in [(0,True),(1000,True),(1001,False),(65534,False)]:
 peer=Mock();peer.getsockopt.return_value=struct.pack('3i',99,uid,1000)
 assert m.Server.verify_request(None,peer,None)==want
class Failure(Exception):
 def __init__(self):self.status=409;self.code='SANDBOX_BUSY'
class Runtime:
 def __init__(self):self.calls=[]
 def dispatch(self,*args):
  self.calls.append(args)
  if args[0]=='destroy':raise Failure()
  return {'available':True}
# HTTP parsing tests must not depend on the CI runner's actual host UID. Keep
# production peer validation intact and exercise it with explicit kernel data.
class ProtocolServer(m.Server):
 peer_uid=1000
 def verify_request(self,request,address):
  peer=Mock();peer.getsockopt.return_value=struct.pack('3i',99,self.peer_uid,1000)
  return super().verify_request(peer,address)
with tempfile.TemporaryDirectory() as directory:
 path=directory+'/sandbox.sock';server=ProtocolServer(path,m.Handler);server.runtime=Runtime();server.sandbox_error=Failure
 thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 def request(body,path='/sandbox',method='POST',headers=None):
  conn=http.client.HTTPConnection('localhost');conn.sock=socket.socket(socket.AF_UNIX);conn.sock.connect(server.server_address)
  try:
   conn.request(method,path,body,headers or {'Content-Type':'application/json'})
   response=conn.getresponse();value=json.loads(response.read());return response.status,value
  finally:conn.close()
 try:
  server.peer_uid=1001
  try:request(json.dumps(valid));raise AssertionError('UID1001 accepted')
  except (ConnectionResetError,BrokenPipeError,http.client.RemoteDisconnected):pass
  assert not server.runtime.calls
  server.peer_uid=1000
  assert request(json.dumps(valid))[0]==200
  assert len(server.runtime.calls)==1
  assert request(json.dumps({**valid,'args':{'mount':'/etc'}}))[0]==400
  assert request(json.dumps(valid),path='/sandbox?x=1')[0]==404
  assert request('',method='GET')[0]==405
  assert request(json.dumps(valid),headers={'Content-Type':'text/plain'})[0]==400
  assert request(json.dumps(valid),headers={'Content-Type':'application/json','Content-Length':str(m.MAX_BODY+1)})[0]==400
  assert request(json.dumps(valid),headers={'Content-Type':'application/json','Transfer-Encoding':'chunked'})[0]==400
  assert len(server.runtime.calls)==1
  status,value=request(json.dumps({**valid,'action':'destroy'}));assert status==409 and value['error']['code']=='SANDBOX_BUSY'
  count=len(server.runtime.calls);server.enabled=lambda:False
  assert request(json.dumps(valid))[0]==503 and len(server.runtime.calls)==count
 finally:server.shutdown();server.server_close();thread.join()
`));
test('trusted helper installation stages fixed modules and root-only config without real host services',()=>python(`
import json,os,stat,tempfile
from unittest.mock import patch,Mock
with tempfile.TemporaryDirectory() as directory:
 root=Path(directory);source=root/'source';data=root/'data';(source/'scripts').mkdir(parents=True);data.mkdir()
 for name in m.MODULES:(source/'scripts'/name).write_text('# synthetic helper module\\n')
 m.HELPER_ROOT=root/'lib';m.CONFIG_ROOT=root/'etc';m.STATE_ROOT=root/'state';m.UNIT_ROOT=root/'units';m.UNIT_ROOT.mkdir()
 calls=[]
 def run(argv,**kwargs):calls.append((argv,kwargs));return Mock(returncode=0)
 with patch.object(m,'trusted'),patch.object(m.os,'geteuid',return_value=0),patch.object(m.os,'chown'),patch.object(m,'systemd_available',return_value=True),patch.object(m.subprocess,'run',side_effect=run),patch.dict(os.environ,{'HTTP_PROXY':'http://synthetic:secret@proxy.example.invalid:8080'}):
  assert m.setup('enable-sandbox',source,data)==0
  key=m.identity(data);base=m.HELPER_ROOT/key;config=m.CONFIG_ROOT/(key+'.json')
  assert {x.name for x in base.iterdir()}==set(m.MODULES)
  for path in [config,*base.iterdir()]:assert stat.S_IMODE(path.stat().st_mode)==0o600
  assert stat.S_IMODE((data/'sandbox').stat().st_mode)==0o750
  cfg=m.load_config(config);assert cfg['image']==m.IMAGE and cfg['installation']==key
  assert cfg['proxy_env']['HTTP_PROXY'].startswith('http://synthetic:secret@')
  unit=(m.UNIT_ROOT/m.unit_name(data)).read_text();assert 'User=root' in unit and 'host-sandbox.py' in unit
  assert 'synthetic:secret' not in unit and '/bin/sh' not in unit
  expected=[['systemctl','daemon-reload'],['systemctl','enable',m.unit_name(data)],['systemctl','restart',m.unit_name(data)]]
  assert [x[0] for x in calls]==expected
  assert m.setup('enable-sandbox',source,data)==0
  assert [x[0] for x in calls]==expected+expected
  cfg['image']='foreign:latest';config.write_text(json.dumps(cfg))
  try:m.load_config(config);raise AssertionError('accepted foreign image')
  except ValueError:pass
  assert m.setup('disable-sandbox',source,data)==0
  assert m.read_policy(data)==False
  assert calls[-1][0]==['systemctl','disable','--now',m.unit_name(data)]
  with patch.object(m,'systemd_available',return_value=False):
   before=len(calls)
   try:m.setup('enable-sandbox',source,data);raise AssertionError('enabled without systemd')
   except ValueError as error:assert 'sandbox-foreground' in str(error)
   assert len(calls)==before
   assert m.setup('sandbox-foreground',source,data)==0
   assert calls[-1][0][2:]==[str(base/'host-sandbox.py'),'serve','--config',str(config)]
   assert not any('systemctl' in call[0] for call in calls[before:])
 # Real trust checks remain active outside the synthetic installer fixture.
 target=root/'untrusted';target.write_text('x');target.chmod(0o666)
 try:m.trusted(target);raise AssertionError('accepted writable source')
 except ValueError:pass
 link=root/'link';link.symlink_to(target)
 try:m.trusted(link);raise AssertionError('accepted symlink')
 except ValueError:pass
`));
test('automatic sandbox setup installs once, refreshes changed modules and respects explicit disable',()=>python(`
import json,tempfile
from unittest.mock import patch,Mock
with tempfile.TemporaryDirectory() as directory:
 root=Path(directory);source=root/'source';data=root/'data';(source/'scripts').mkdir(parents=True);data.mkdir()
 for name in m.MODULES:(source/'scripts'/name).write_text('# synthetic helper module\\n')
 m.HELPER_ROOT=root/'lib';m.CONFIG_ROOT=root/'etc';m.STATE_ROOT=root/'state';m.UNIT_ROOT=root/'units';m.UNIT_ROOT.mkdir()
 calls=[]
 def run(argv,**kwargs):calls.append(argv);return Mock(returncode=0,stdout='enabled\\n')
 with patch.object(m,'trusted'),patch.object(m.os,'geteuid',return_value=0),patch.object(m.os,'chown'),patch.object(m,'systemd_available',return_value=True),patch.object(m.subprocess,'run',side_effect=run):
  assert m.ensure_sandbox(source,data)==0
  assert m.read_policy(data)==True
  assert ['systemctl','restart',m.unit_name(data)] in calls
  cfg=m.load_config(m.CONFIG_ROOT/(m.identity(data)+'.json'));assert cfg['image']==m.IMAGE
  calls.clear();assert m.ensure_sandbox(source,data)==0
  assert not any('restart' in c for c in calls),calls
  (source/'scripts'/'sandbox_runtime.py').write_text('# updated synthetic helper\\n')
  calls.clear();assert m.ensure_sandbox(source,data)==0
  assert ['systemctl','restart',m.unit_name(data)] in calls
  assert (m.HELPER_ROOT/m.identity(data)/'sandbox_runtime.py').read_text()=='# updated synthetic helper\\n'
  config=m.CONFIG_ROOT/(m.identity(data)+'.json');cfg=json.loads(config.read_text());cfg['image']='codex-agent-platform-sandbox:0.0.1';config.write_text(json.dumps(cfg))
  calls.clear();assert m.ensure_sandbox(source,data)==0
  assert m.load_config(config)['image']==m.IMAGE and ['systemctl','restart',m.unit_name(data)] in calls
  m.setup('disable-sandbox',source,data);calls.clear();assert m.ensure_sandbox(source,data)==0
  assert m.read_policy(data)==False and calls==[]
  (data/m.POLICY).unlink()
  with patch.object(m.subprocess,'run',return_value=Mock(returncode=1,stdout='disabled\\n')) as command:
   assert m.ensure_sandbox(source,data)==0 and m.read_policy(data)==False
   assert command.call_count==1 and command.call_args.args[0]==['systemctl','is-enabled',m.unit_name(data)]
`));
test('automatic sandbox setup reports unsupported hosts without blocking deployment or swallowing opt-out',()=>python(`
import tempfile,io,contextlib
from unittest.mock import patch
with tempfile.TemporaryDirectory() as directory:
 root=Path(directory);data=root/'data';data.mkdir()
 with patch.object(m,'trusted'),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'systemd_available',return_value=False):
  with contextlib.redirect_stderr(io.StringIO()) as log:assert m.ensure_sandbox(root/'source',data)==0
  assert 'Sandbox setup unavailable' in log.getvalue()
  assert not (data/m.POLICY).exists()
 with patch.object(m.os,'geteuid',return_value=1000),patch.object(m.sys,'argv',['host-sandbox.py','ensure-sandbox','--source',str(root/'source'),'--data',str(data)]):
  with contextlib.redirect_stderr(io.StringIO()) as log:assert m.main()==0
  assert 'Sandbox setup unavailable' in log.getvalue()
`));
test('automatic sandbox setup does not wait for a foreground helper holding the setup lock',()=>python(`
import tempfile,threading,fcntl
from unittest.mock import patch
with tempfile.TemporaryDirectory() as directory:
 data=Path(directory);result=[]
 with (data/'.sandbox-setup.lock').open('a') as held,patch.object(m,'trusted'),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'systemd_available',return_value=False):
  fcntl.flock(held,fcntl.LOCK_EX)
  worker=threading.Thread(target=lambda:result.append(m.ensure_sandbox(data/'source',data)));worker.start();worker.join(1)
  returned_while_busy=not worker.is_alive()
  fcntl.flock(held,fcntl.LOCK_UN);worker.join(2)
  assert returned_while_busy,'optional sandbox setup blocked core deployment on a foreground helper'
  assert result==[0]
`));
test('automatic sandbox refresh preserves installed upstream proxy policy across sanitized web updates',()=>python(`
import tempfile,os
from unittest.mock import patch,Mock
with tempfile.TemporaryDirectory() as directory:
 root=Path(directory);source=root/'source';data=root/'data';(source/'scripts').mkdir(parents=True);data.mkdir()
 for name in m.MODULES:(source/'scripts'/name).write_text('# synthetic helper module\\n')
 m.HELPER_ROOT=root/'lib';m.CONFIG_ROOT=root/'etc';m.STATE_ROOT=root/'state';m.UNIT_ROOT=root/'units';m.UNIT_ROOT.mkdir()
 with patch.object(m,'trusted'),patch.object(m.os,'geteuid',return_value=0),patch.object(m.os,'chown'),patch.object(m,'systemd_available',return_value=True),patch.object(m.subprocess,'run',return_value=Mock(returncode=0,stdout='enabled\\n')):
  with patch.dict(os.environ,{'HTTPS_PROXY':'http://synthetic:private@proxy.example.invalid:8080'},clear=True):m.setup('enable-sandbox',source,data)
  config=m.CONFIG_ROOT/(m.identity(data)+'.json');original=m.load_config(config)['proxy_env']
  cfg=m.load_config(config);cfg['image']='codex-agent-platform-sandbox:0.0.1';config.write_text(__import__('json').dumps(cfg))
  (source/'scripts'/'sandbox_runtime.py').write_text('# newer synthetic runtime\\n')
  with patch.dict(os.environ,{},clear=True):assert m.ensure_sandbox(source,data)==0
  assert m.load_config(config)['proxy_env']==original,'automatic update discarded saved upstream proxy policy'
`));
test('automatic setup retries an incomplete refresh even while the old helper is still active',()=>python(`
import tempfile,subprocess
from unittest.mock import patch,Mock
with tempfile.TemporaryDirectory() as directory:
 root=Path(directory);source=root/'source';data=root/'data';(source/'scripts').mkdir(parents=True);data.mkdir()
 for name in m.MODULES:(source/'scripts'/name).write_text('# synthetic helper module\\n')
 m.HELPER_ROOT=root/'lib';m.CONFIG_ROOT=root/'etc';m.STATE_ROOT=root/'state';m.UNIT_ROOT=root/'units';m.UNIT_ROOT.mkdir()
 calls=[]
 def run(argv,**kwargs):calls.append(argv);return Mock(returncode=0,stdout='enabled\\n')
 def fail_reload(argv,**kwargs):
  if argv==['systemctl','daemon-reload']:raise subprocess.CalledProcessError(1,argv)
  return run(argv,**kwargs)
 with patch.object(m,'trusted'),patch.object(m.os,'geteuid',return_value=0),patch.object(m.os,'chown'),patch.object(m,'systemd_available',return_value=True),patch.object(m.subprocess,'run',side_effect=run):
  m.setup('enable-sandbox',source,data)
  (source/'scripts'/'sandbox_runtime.py').write_text('# updated synthetic module\\n')
  with patch.object(m.subprocess,'run',side_effect=fail_reload):assert m.ensure_sandbox(source,data)==0
  calls.clear();assert m.ensure_sandbox(source,data)==0
  assert ['systemctl','restart',m.unit_name(data)] in calls,'old active process was mistaken for an updated helper'
  calls.clear();assert m.ensure_sandbox(source,data)==0
  assert not any('restart' in c for c in calls),'successful unchanged helper should remain running'
`));
test('sandbox channel is only mounted read-only into Manager, never Docker socket',()=>{
  const result=spawnSync('docker',['compose','--env-file',root+'/.env.example','-f',root+'/compose.yaml','config','--format','json'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const config=JSON.parse(result.stdout);
  const volume=config.services.manager.volumes.find(x=>x.target==='/run/platform-sandbox');
  assert.ok(volume);assert.equal(volume.read_only,true);
  for(const service of Object.values(config.services))assert.ok(!JSON.stringify(service).includes('docker.sock'));
  for(const name of ['gateway','runner'])assert.ok(!config.services[name].volumes.some(x=>x.target==='/run/platform-sandbox'));
});
