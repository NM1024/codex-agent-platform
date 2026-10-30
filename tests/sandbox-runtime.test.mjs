import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function python(source, {docker = false} = {}) {
  const result = spawnSync('python3', ['-c', source], { cwd: process.cwd(), encoding: 'utf8', timeout: docker ? 180000 : 30000, env: { ...process.env, PYTHONPATH: 'scripts', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('sandbox files reject escapes, links, special files and bound import/read/export bytes', () => {
  python(`
import tempfile,pathlib,os,base64
from sandbox_files import operate, FileError
with tempfile.TemporaryDirectory() as root:
 def deny(args):
  try: operate(root,args)
  except FileError: return
  raise AssertionError(args)
 assert operate(root,{'action':'write','path':'dir/data.csv','text':'a,b\\n1,2'})['size']==7
 assert operate(root,{'action':'read','path':'dir/data.csv','offset':2,'limit':3})['text']=='b\\n1'
 assert operate(root,{'action':'list','path':'dir'})['entries'][0]['name']=='data.csv'
 assert base64.b64decode(operate(root,{'action':'export','path':'dir/data.csv'})['content_base64'])==b'a,b\\n1,2'
 for path in ['../escape','/etc/passwd','dir/../../escape','dir//bad','dir/./bad','x\\x00y','\\udcff']:
  deny({'action':'write','path':path,'text':'bad'})
 pathlib.Path(root,'link').symlink_to('/etc')
 deny({'action':'read','path':'link/passwd'})
 deny({'action':'write','path':'link/new','text':'bad'})
 os.mkfifo(root+'/pipe')
 deny({'action':'read','path':'pipe'})
 deny({'action':'export','path':'pipe'})
 deny({'action':'write','path':'huge','text':'a'*262145})
 deny({'action':'read','path':'dir/data.csv','limit':65537})
 deny({'action':'import','path':'bin','content_base64':'!bad!'})
 assert operate(root,{'action':'import','path':'binary','content_base64':'AAEC'})['size']==3
 os.link(root+'/binary',root+'/hard')
 deny({'action':'read','path':'binary'})
 deny({'action':'export','path':'hard'})
 with open(root+'/oversize','wb') as file: file.truncate(20971521)
 deny({'action':'export','path':'oversize'})
 operate(root,{'action':'delete','path':'dir/data.csv'})
 assert not pathlib.Path(root,'dir/data.csv').exists()
`);
});

test('runtime validates owner/request/grants before Docker and never replays failed request keys', () => {
 python(`
from sandbox_runtime import SandboxRuntime,SandboxError
r=SandboxRuntime(docker_command=['/bin/false'])
owner='11111111-1111-4111-8111-111111111111'
assert r.dispatch('context',owner)['exists']==False
for action,who,args in [('files','../x',{'action':'ensure'}),('exec',owner,{'request_key':'x','command':'true','timeout_seconds':121}),('exec',owner,{'request_key':'x','command':'true','memory_mb':2048})]:
 try: r.dispatch(action,who,args)
 except SandboxError: pass
 else: raise AssertionError('unvalidated admission')
for attempt in range(2):
 try: r.dispatch('exec',owner,{'request_key':'fail-once','command':'true'})
 except SandboxError as error: assert error.code in ['SANDBOX_UNAVAILABLE','SANDBOX_REQUEST_UNKNOWN']
 else: raise AssertionError('unavailable runtime succeeded')
try: r.dispatch('exec',owner,{'request_key':'fail-once','command':'echo changed'})
except SandboxError as error: assert error.code=='SANDBOX_REQUEST_CONFLICT'
else: raise AssertionError('request key changed command')
r.close()
`);
});

const docker = process.env.SANDBOX_DOCKER_TEST === '1';
test('actual fixed Docker sandbox enforces isolation, ownership, resource limits and execution lifecycle', { skip: !docker }, () => {
 python(`
import time,json,base64,uuid
from sandbox_runtime import SandboxRuntime,SandboxError
r=SandboxRuntime(installation='test-runtime-'+uuid.uuid4().hex)
a='11111111-1111-4111-8111-111111111111'; b='22222222-2222-4222-8222-222222222222'; c='33333333-3333-4333-8333-333333333333'
def run(owner,key,command,**extra):
 job=r.dispatch('exec',owner,dict(request_key=key,command=command,**extra))
 deadline=time.monotonic()+30
 while job['status']=='running' and time.monotonic()<deadline:
  time.sleep(.05); job=r.dispatch('process',owner,{'execution_id':job['execution_id'],'action':'status'})
 assert job['status']!='running',job
 return job
try:
 r.recover()
 info=r.dispatch('files',a,{'action':'ensure'}); assert info['instance_id']
 r.dispatch('files',a,{'action':'write','path':'input.csv','text':'a,b\\n1,2'})
 job=run(a,'python',"python3 -c 'import os; print(os.getuid()); print(open(\\\"input.csv\\\").read()); print(os.path.exists(\\\"/var/run/docker.sock\\\")); print(os.environ.get(\\\"HTTP_PROXY\\\"))'")
 assert job['status']=='completed',job
 assert '1000\\na,b\\n1,2\\nFalse\\n\\n'==job['stdout'],job
 same=r.dispatch('exec',a,{'request_key':'python','command':"python3 -c 'import os; print(os.getuid()); print(open(\\\"input.csv\\\").read()); print(os.path.exists(\\\"/var/run/docker.sock\\\")); print(os.environ.get(\\\"HTTP_PROXY\\\"))'"}); assert same['execution_id']==job['execution_id']
 r.dispatch('files',a,{'action':'write','path':'json.py','text':'raise RuntimeError("untrusted module")'})
 assert r.dispatch('files',a,{'action':'read','path':'input.csv'})['text']=='a,b\\n1,2'
 try: r.dispatch('files',a,{'action':'write','path':'input.csv','text':'bad','expected_revision':0})
 except SandboxError as e: assert e.code=='SANDBOX_REVISION'
 else: raise AssertionError('stale revision overwrote input')
 node=run(a,'node',"node -e 'console.log(6 * 7)'"); assert node['stdout']=='42\\n',node
 isolated=run(b,'owner',"test ! -e /workspace/input.csv && test ! -e /app && ! touch /etc/probe && python3 -c 'import socket; s=socket.socket(); s.settimeout(.2); print(s.connect_ex((\\\"198.51.100.1\\\",443)))'")
 assert isolated['status']=='completed' and isolated['stdout'].strip()!='0',isolated
 grant_info=r.dispatch('context',a)
 grant=dict(id='grant-synthetic',request_key='grant',instance_id=grant_info['instance_id'],revision=grant_info['revision'],command='echo approved',cwd='.',timeout_seconds=121,memory_mb=1024,domains=[],expires_at=int(time.time()*1000)+60000)
 granted=run(a,'grant','echo approved',timeout_seconds=121,grant=grant); assert granted['stdout']=='approved\\n',granted
 stale=dict(grant,request_key='stale')
 try: r.dispatch('exec',a,dict(request_key='stale',command='echo approved',timeout_seconds=121,grant=stale))
 except SandboxError as e: assert e.code=='SANDBOX_PERMISSION'
 else: raise AssertionError('stale grant accepted')
 limits=run(a,'limits',"python3 -c 'import pathlib; print(pathlib.Path(\\\"/sys/fs/cgroup/memory.max\\\").read_text().strip()); print(pathlib.Path(\\\"/sys/fs/cgroup/pids.max\\\").read_text().strip()); print(pathlib.Path(\\\"/sys/fs/cgroup/cpu.max\\\").read_text().strip())'")
 assert limits['stdout'].splitlines()==['1073741824','128','100000 100000'],limits
 capped=run(a,'cap',"python3 -c 'import sys; sys.stdout.write(\\\"a\\\"*200000); sys.stderr.write(\\\"b\\\"*200000)'"); assert len(capped['stdout'])==65536 and len(capped['stderr'])==65536,capped
 job=r.dispatch('exec',a,{'request_key':'cancel','command':'sleep 30 & wait'})
 try: r.dispatch('exec',a,{'request_key':'busy','command':'true'})
 except SandboxError as e: assert e.code=='SANDBOX_BUSY'
 else: raise AssertionError('parallel job accepted')
 cancelled=r.dispatch('process',a,{'action':'cancel','execution_id':job['execution_id']}); assert cancelled['status']=='cancelled',cancelled
 assert r.dispatch('context',a)['exists']==False
 timeout=run(a,'timeout','sleep 20 & wait',timeout_seconds=1); assert timeout['status']=='failed' and timeout['reason']=='timeout_workspace_lost',timeout
 orphan=run(a,'orphan','sleep 30 &'); assert orphan['reason']=='descendants_workspace_lost',orphan
 oom=run(a,'oom',"python3 -c 'x=bytearray(200*1024*1024)'",memory_mb=64); assert oom['status']=='failed' and oom['reason']=='oom_workspace_lost',oom
 assert not r.dispatch('context',a)['exists']
 r.dispatch('files',a,{'action':'ensure'}); r.dispatch('files',b,{'action':'ensure'}); r.dispatch('files',c,{'action':'ensure'})
 assert not r.dispatch('context',a)['exists']; assert r.dispatch('context',b)['exists']; assert r.dispatch('context',c)['exists']
 r.owners[b]['last_used']=time.monotonic()-1801
 r.sweep(); assert not r.dispatch('context',b)['exists']
 r.recover(); assert not r.dispatch('context',c)['exists']
finally: r.close()
`, {docker:true});
});

test('actual sandbox tmpfs and PID pressure stays inside configured limits', { skip: !docker }, () => {
 python(`
import time,uuid,shlex
from sandbox_runtime import SandboxRuntime
r=SandboxRuntime(installation='test-pressure-'+uuid.uuid4().hex)
owner='44444444-4444-4444-8444-444444444444'
def run(key,script):
 job=r.dispatch('exec',owner,dict(request_key=key,command='python3 -I -S -c '+shlex.quote(script),timeout_seconds=30))
 stop=time.monotonic()+40
 while job['status']=='running' and time.monotonic()<stop:
  time.sleep(.1); job=r.dispatch('process',owner,{'execution_id':job['execution_id']})
 assert job['status']=='completed',job
 return job['stdout']
try:
 for directory in ['/tmp','/workspace']:
  script='''import os
p=\"DIRECTORY/pressure\"
fd=os.open(p,os.O_CREAT|os.O_WRONLY,0o600)
try:
 while True: os.write(fd,b'x'*1048576)
except OSError as e: print(e.errno)
finally: os.close(fd); os.unlink(p)
'''.replace('DIRECTORY',directory)
  assert run(directory,script)=='28\\n'
 script='''import os,signal,time
children=[]
try:
 for i in range(200):
  pid=os.fork()
  if not pid: time.sleep(10); os._exit(0)
  children.append(pid)
except OSError as e: print(e.errno); print(len(children))
finally:
 for pid in children: os.kill(pid,signal.SIGKILL)
 for pid in children: os.waitpid(pid,0)
'''
 result=run('pids',script).splitlines()
 assert result[0]=='11' and 1<int(result[1])<128,result
finally: r.close()
`, {docker:true});
});

test('actual running execution exposes output before termination and cancellation remains idempotent', { skip: !docker }, () => {
 python(`
import time,uuid
from sandbox_runtime import SandboxRuntime
r=SandboxRuntime(installation='test-stream-'+uuid.uuid4().hex)
owner='55555555-5555-4555-8555-555555555555'
try:
 job=r.dispatch('exec',owner,{'request_key':'stream','command':'printf started; sleep 30'})
 deadline=time.monotonic()+2
 while time.monotonic()<deadline:
  current=r.dispatch('process',owner,{'execution_id':job['execution_id']})
  if current['stdout']=='started': break
  time.sleep(.05)
 assert current['status']=='running' and current['stdout']=='started',current
 cancelled=r.dispatch('process',owner,{'action':'cancel','execution_id':job['execution_id']})
 repeated=r.dispatch('process',owner,{'action':'cancel','execution_id':job['execution_id']})
 assert cancelled['status']==repeated['status']=='cancelled'
 assert not r.dispatch('context',owner)['exists']
finally: r.close()
`, {docker:true});
});

test('unconfirmed container removal quarantines the instance before any new command admission', () => {
 python(`
from sandbox_runtime import SandboxRuntime,SandboxError
r=SandboxRuntime(docker_command=['/bin/false'])
owner='66666666-6666-4666-8666-666666666666'
r.dispatch('context',owner)
state=r.owners[owner]
state.update(name='synthetic-uncertain-container',instance_id='synthetic-instance')
def unavailable(*args,**kwargs): raise SandboxError('SANDBOX_UNAVAILABLE','synthetic daemon timeout',503)
r._docker=unavailable
try: r.dispatch('destroy',owner)
except SandboxError: pass
else: raise AssertionError('removal falsely confirmed')
assert state['unhealthy'], 'uncertain container remained eligible for reuse'
try: r.dispatch('exec',owner,{'request_key':'blocked','command':'true'})
except SandboxError as error: assert error.code=='SANDBOX_UNAVAILABLE'
else: raise AssertionError('unconfirmed workload reused')
`);
});

test('context bounds log summaries while process keeps the bounded complete record', () => {
 python(`
import json
from sandbox_runtime import SandboxRuntime
r=SandboxRuntime(docker_command=['/bin/false'])
owner='77777777-7777-4777-8777-777777777777'
r.dispatch('context',owner)
state=r.owners[owner]
for i in range(16):
 job=dict(execution_id=str(i),request_key=str(i),instance_id='synthetic',status='completed',stdout='x'*65536,stderr='y'*65536,exit_code=0,created_at=0,completed_at=1,timeout_seconds=60,memory_mb=1024)
 state['jobs'][str(i)]=job
context=r.dispatch('context',owner)
assert len(json.dumps(context).encode())<512*1024
assert all(len(j['stdout'])<=2048 and len(j['stderr'])<=2048 and j['stdout_truncated'] and j['stderr_truncated'] for j in context['executions'])
assert len(r.dispatch('process',owner,{'execution_id':'0'})['stdout'])==65536
r.close()
`);
});

test('actual execution history retains sixteen detailed results and never replays compacted keys', { skip: !docker }, () => {
 python(`
import time,uuid
from sandbox_runtime import SandboxRuntime,SandboxError
r=SandboxRuntime(installation='test-history-'+uuid.uuid4().hex)
owner='88888888-8888-4888-8888-888888888888'
try:
 for i in range(17):
  job=r.dispatch('exec',owner,dict(request_key=str(i),command='printf bounded'))
  stop=time.monotonic()+10
  while job['status']=='running' and time.monotonic()<stop:
   time.sleep(.03); job=r.dispatch('process',owner,{'execution_id':job['execution_id']})
  assert job['status']=='completed',job
 assert len(r.owners[owner]['jobs'])==16
 assert len(r.owners[owner]['keys'])==17
 try: r.dispatch('exec',owner,{'request_key':'0','command':'printf bounded'})
 except SandboxError as error: assert error.code=='SANDBOX_REQUEST_UNKNOWN'
 else: raise AssertionError('compacted request replayed')
 assert r.dispatch('exec',owner,{'request_key':'16','command':'printf bounded'})['execution_id']==job['execution_id']
finally: r.close()
`, {docker:true});
});

test('deadline removal begins while an unrelated readiness probe remains blocked', () => {
 python(`
import os,json,subprocess,threading,time
from sandbox_runtime import SandboxRuntime
r=SandboxRuntime(docker_command=['synthetic-docker'])
owner='99999999-9999-4999-8999-999999999999'
other='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
state=r._owner(owner); state.update(name='synthetic-active',instance_id='synthetic-instance')
stopped=threading.Event(); probe_entered=threading.Event(); release_probe=threading.Event()
class Process:
 def __init__(self): self.stdout=open(os.devnull,'rb'); self.stderr=open(os.devnull,'rb'); self.returncode=None
 def poll(self): return self.returncode
 def wait(self,timeout=None):
  if not stopped.wait(timeout): raise subprocess.TimeoutExpired('synthetic',timeout)
  self.returncode=137; return 137
 def kill(self): stopped.set()
process=Process()
def docker(args,**kwargs):
 if args[0]=='rm': stopped.set()
 return subprocess.CompletedProcess(args,0,stdout=b'[]',stderr=b'')
def slow_readiness(): probe_entered.set(); release_probe.wait(4)
r._docker=docker
import sandbox_runtime
original=sandbox_runtime.subprocess.Popen
sandbox_runtime.subprocess.Popen=lambda *args,**kwargs: process
try:
 admitted=time.monotonic()
 job=r.dispatch('exec',owner,{'request_key':'deadline','command':'synthetic-only','timeout_seconds':1})
 r._readiness=slow_readiness
 probe=threading.Thread(target=lambda:r.dispatch('context',other)); probe.start()
 assert probe_entered.wait(1)
 assert stopped.wait(1.5), 'deadline waited for unrelated readiness probe lock'
 assert time.monotonic()-admitted<1.8
finally:
 release_probe.set(); probe.join(5); stopped.set(); sandbox_runtime.subprocess.Popen=original
 r.close()
`);
});

test('actual timeout and cancellation bypass a blocked readiness probe', { skip: !docker }, () => {
 python(`
import threading,time,uuid
from sandbox_runtime import SandboxRuntime
owner='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; other='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
for action in ['timeout','cancel']:
 r=SandboxRuntime(installation='test-deadline-'+uuid.uuid4().hex)
 release=threading.Event(); entered=threading.Event(); removal=threading.Event(); timestamps=[]
 original=r._docker
 def observed(args,**kwargs):
  if args[0]=='rm': timestamps.append(time.monotonic()); removal.set()
  return original(args,**kwargs)
 r._docker=observed
 probe=None; cancel=None
 try:
  job=r.dispatch('exec',owner,dict(request_key=action,command='sleep 20 & wait',timeout_seconds=1 if action=='timeout' else 20))
  admitted=time.monotonic()
  def slow(): entered.set(); release.wait(10)
  r._readiness=slow
  probe=threading.Thread(target=lambda:r.dispatch('context',other)); probe.start(); assert entered.wait(1)
  requested=time.monotonic()
  if action=='cancel':
   cancel=threading.Thread(target=lambda:r.dispatch('process',owner,{'action':'cancel','execution_id':job['execution_id']})); cancel.start()
  assert removal.wait(1.8), action+' removal was blocked by readiness'
  assert timestamps[0]-(admitted if action=='timeout' else requested)<1.8
  release.set(); probe.join(2)
  if cancel: cancel.join(10); assert not cancel.is_alive()
  deadline=time.monotonic()+10
  while job['status']=='running' and time.monotonic()<deadline:
   time.sleep(.05); job=r.dispatch('process',owner,{'execution_id':job['execution_id']})
  assert job['status']==('failed' if action=='timeout' else 'cancelled'),job
  assert not r.dispatch('context',owner)['exists']
 finally:
  release.set()
  if probe: probe.join(12)
  if cancel: cancel.join(12)
  r.close()
`, {docker:true});
});

test('deadline removal bypasses slow network probes, foreign files and final inspection', () => {
 python(`
import os,json,subprocess,threading,time
import sandbox_runtime
from sandbox_runtime import SandboxRuntime
for blocked in ['network','files','inspection']:
 r=SandboxRuntime(docker_command=['synthetic-docker']); r.ready=True
 owner='dddddddd-dddd-4ddd-8ddd-dddddddddddd'; other='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
 state=r._owner(owner); state.update(name='synthetic-active',instance_id='synthetic-instance')
 stopped=threading.Event(); entered=threading.Event(); release=threading.Event()
 class Process:
  def __init__(self): self.stdout=open(os.devnull,'rb'); self.stderr=open(os.devnull,'rb'); self.returncode=None
  def poll(self): return self.returncode
  def wait(self,timeout=None):
   if blocked=='inspection': self.returncode=0; return 0
   if not stopped.wait(timeout): raise subprocess.TimeoutExpired('synthetic',timeout)
   self.returncode=137; return 137
  def kill(self): stopped.set()
 process=Process()
 def docker(args,**kwargs):
  if args[0]=='rm': stopped.set()
  if (blocked=='files' and args[0]=='exec' and '-i' in args) or (blocked=='inspection' and args[0]=='inspect'):
   entered.set(); release.wait(4)
  value={'entries':[]} if '-i' in args else [{'State':{'Running':True}}] if args[0]=='inspect' else []
  return subprocess.CompletedProcess(args,0,stdout=json.dumps(value).encode(),stderr=b'')
 class Network:
  def available(self): entered.set(); release.wait(4); return False
  def close(self): pass
 r._docker=docker
 original=sandbox_runtime.subprocess.Popen
 sandbox_runtime.subprocess.Popen=lambda *args,**kwargs:process
 probe=None
 try:
  admitted=time.monotonic(); r.dispatch('exec',owner,{'request_key':blocked,'command':'synthetic-only','timeout_seconds':1})
  if blocked=='network':
   r.network=Network(); probe=threading.Thread(target=lambda:r.dispatch('context',other)); probe.start()
  elif blocked=='files':
   probe=threading.Thread(target=lambda:r.dispatch('files',other,{'action':'list'})); probe.start()
  assert entered.wait(1),blocked
  assert stopped.wait(1.5),blocked+' blocked deadline removal'
  assert time.monotonic()-admitted<1.8,blocked
 finally:
  release.set()
  if probe: probe.join(5)
  stopped.set(); sandbox_runtime.subprocess.Popen=original; r.close()
`);
});

test('actual late cleanup cannot remove a replacement conversation instance', { skip: !docker }, () => {
 python(`
import threading,time,uuid
from sandbox_runtime import SandboxRuntime
r=SandboxRuntime(installation='test-generation-'+uuid.uuid4().hex)
owner='ffffffff-ffff-4fff-8fff-ffffffffffff'
entered=threading.Event(); release=threading.Event(); old_name=[None]
original=r._docker
old_thread=None
try:
 r.dispatch('files',owner,{'action':'ensure'}); old_name[0]=r.owners[owner]['name']
 def delayed(args,**kwargs):
  result=original(args,**kwargs)
  if args[:2]==['inspect',old_name[0]]:
   entered.set(); release.wait(10)
  return result
 r._docker=delayed
 old=r.dispatch('exec',owner,{'request_key':'old','command':'printf finished'})
 assert entered.wait(5)
 old_thread=r.owners[owner]['jobs'][old['execution_id']]['_thread']
 r.dispatch('process',owner,{'action':'cancel','execution_id':old['execution_id']})
 new=r.dispatch('exec',owner,{'request_key':'new','command':'sleep 20'})
 release.set(); old_thread.join(10); assert not old_thread.is_alive()
 context=r.dispatch('context',owner)
 assert context['exists'] and context['instance_id']==new['instance_id'],context
 assert r.dispatch('process',owner,{'execution_id':new['execution_id']})['status']=='running'
finally:
 release.set()
 if old_thread: old_thread.join(12)
 r.close()
`, {docker:true});
});

test('a job is fully cancellable as soon as its execution identity is published', () => {
 python(`
import os,subprocess,threading
import sandbox_runtime
from sandbox_runtime import SandboxRuntime
r=SandboxRuntime(docker_command=['synthetic-docker']); r.ready=True
owner='abababab-abab-4bab-8bab-abababababab'
state=r._owner(owner); state.update(name='synthetic-published',instance_id='synthetic-instance')
stopped=threading.Event()
class Process:
 def __init__(self): self.stdout=open(os.devnull,'rb'); self.stderr=open(os.devnull,'rb'); self.returncode=None
 def poll(self): return self.returncode
 def wait(self,timeout=None): stopped.wait(timeout); self.returncode=137; return 137
 def kill(self): stopped.set()
process=Process()
def docker(args,**kwargs):
 if args[0]=='rm': stopped.set()
 return subprocess.CompletedProcess(args,0,stdout=b'[]',stderr=b'')
r._docker=docker
class Published(dict):
 def __setitem__(self,key,value):
  super().__setitem__(key,value)
  result=r.dispatch('process',owner,{'action':'cancel','execution_id':key})
  assert result['status']=='cancelled'
state['jobs']=Published()
original=sandbox_runtime.subprocess.Popen
sandbox_runtime.subprocess.Popen=lambda *args,**kwargs:process
try:
 job=r.dispatch('exec',owner,{'request_key':'published','command':'synthetic-only'})
 assert job['status']=='cancelled'
 assert stopped.is_set()
finally:
 stopped.set(); sandbox_runtime.subprocess.Popen=original; r.close()
`);
});
