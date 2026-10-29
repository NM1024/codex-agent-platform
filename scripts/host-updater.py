#!/usr/bin/env python3
"""Root-owned Unix HTTP upgrade service; never accepts deployment options."""
import argparse
import ast
import contextlib
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid

REPO='NM1024/codex-agent-platform'
LOG_LIMIT=128*1024
PUBLIC=('id','state','phase','started_at','updated_at','target_version','installed_version','error_code')
ACTIVE=('queued','running')
PHASES=('queued','checking','downloading','building','stopping','backing_up','validating','restarting','verifying','completed','failed','interrupted')
STATES=(*ACTIVE,'succeeded','failed','interrupted')
ENV={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'}
HELPER_ROOT=Path('/usr/local/lib/codex-agent-platform-updater')
CONFIG_ROOT=Path('/etc/codex-agent-platform-updater')
STATE_ROOT=Path('/var/lib/codex-agent-platform-updater')
UNIT_ROOT=Path('/etc/systemd/system')
POLICY='.web-update-policy.json'

def atomic(path, value):
    fd,temp=tempfile.mkstemp(prefix='.'+path.name,dir=path.parent)
    try:
        with os.fdopen(fd,'w') as out:
            json.dump(value,out); out.write('\n'); out.flush(); os.fsync(out.fileno())
        os.chmod(temp,0o600); os.replace(temp,path)
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(temp):os.unlink(temp)

class JobStore:
    def __init__(self, directory):
        self.directory=Path(directory)
        self.directory.mkdir(mode=0o700,parents=True,exist_ok=True)
        self.path=self.directory/'job.json'
    @contextlib.contextmanager
    def lock(self):
        with (self.directory/'admission.lock').open('a') as out:
            os.chmod(out.name,0o600)
            fcntl.flock(out,fcntl.LOCK_EX)
            yield
    def _read(self):
        return json.loads(self.path.read_text()) if self.path.exists() else None
    def read(self):
        job=self._read()
        return {k:job[k] for k in PUBLIC if k in job} if job else None
    def admit(self, launch):
        with self.lock():
            job=self._read()
            if job and job['state'] in ACTIVE:return self.read()
            now=int(time.time()*1000)
            job={'id':uuid.uuid4().hex,'state':'queued','phase':'queued','started_at':now,'updated_at':now}
            atomic(self.path,job)
            try:launch(job)
            except Exception:
                job.update(state='failed',phase='failed',error_code='launch_failed',updated_at=int(time.time()*1000))
                atomic(self.path,job)
            return self.read()
    def change(self, job_id, **fields):
        with self.lock():
            job=self._read()
            if not job or job['id']!=job_id or job['state'] not in ACTIVE:return
            clean={k:v for k,v in fields.items() if k in (*PUBLIC,'release_sha256') and k not in ('id','started_at','updated_at')}
            if 'state' in clean and clean['state'] not in STATES:raise ValueError('Invalid state')
            if 'phase' in clean and clean['phase'] not in PHASES:raise ValueError('Invalid phase')
            for key in ('target_version','installed_version'):
                if key in clean and not re.fullmatch(r'\d+\.\d+\.\d+',clean[key]):raise ValueError('Invalid version')
            if 'error_code' in clean and not re.fullmatch(r'[a-z_]{1,64}',clean['error_code']):raise ValueError('Invalid error code')
            if 'release_sha256' in clean and not re.fullmatch(r'[a-f0-9]{64}',clean['release_sha256']):raise ValueError('Invalid release digest')
            job.update(clean,updated_at=int(time.time()*1000)); atomic(self.path,job)
    def interrupt(self):
        job=self.read()
        if job and job['state'] in ACTIVE:self.change(job['id'],state='interrupted',phase='interrupted',error_code='updater_restarted')

def upgrade_body(body):
    if len(body)>64 or json.loads(body)!= {} or not isinstance(json.loads(body),dict):raise ValueError('Only {} is accepted')
    return {}

def trusted(path, directory=False):
    path=Path(path)
    for item in (path,*path.parents):
        info=item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
            raise ValueError('Updater paths must be root-owned and not writable by others')
    info=path.stat()
    if directory and not stat.S_ISDIR(info.st_mode):raise ValueError('Expected directory')
    if not directory and not stat.S_ISREG(info.st_mode):raise ValueError('Expected regular file')

def load_config(path):
    trusted(path)
    if Path(path).stat().st_size>4096:raise ValueError('Invalid config')
    cfg=json.loads(Path(path).read_text())
    if set(cfg)!={'source','data','project','state','upstream'} or cfg['upstream']!=REPO:raise ValueError('Invalid config')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*',cfg['project']):raise ValueError('Invalid project')
    for key in ('source','data','state'):
        if not isinstance(cfg[key],str) or not Path(cfg[key]).is_absolute():raise ValueError('Invalid path')
    for key in ('data','state'):trusted(cfg[key],True)
    deployment=Path(cfg['data'])/'.deployment.json'
    if deployment.exists() or deployment.is_symlink():
        trusted(deployment)
        if deployment.stat().st_size>16384:raise ValueError('Invalid deployment state')
        active=json.loads(deployment.read_text()).get('source')
        if active:
            if not isinstance(active,str) or not Path(active).is_absolute():raise ValueError('Invalid active source')
            cfg['source']=active
    trusted(cfg['source'],True)
    trusted(Path(cfg['data'])/'.env')
    return cfg

def append_log(path,text):
    data=text.encode(errors='replace')[-LOG_LIMIT:]
    previous=path.read_bytes()[-max(0,LOG_LIMIT-len(data)):] if path.exists() and len(data)<LOG_LIMIT else b''
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as out:out.write(previous+data)

def updater_module(source=None):
    path=Path(source)/'scripts/update-release.py' if source else Path(__file__).with_name('update-release.py')
    spec=importlib.util.spec_from_file_location('release_updater',path)
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

def worker(cfg, job_id):
    store=JobStore(cfg['state'])
    job=store.read()
    if not job or job['id']!=job_id or job['state']!='queued':return 1
    store.change(job_id,state='running',phase='checking')
    module=updater_module()
    phase='checking'
    log=Path(cfg['state'])/'worker.log'
    log.unlink(missing_ok=True)
    def event(name,**fields):
        nonlocal phase
        phase=name
        store.change(job_id,phase=name,**fields)
    def command(args,capture=False,**kwargs):
        # Drain continuously; disk logs and captured command responses have hard bounds.
        process=subprocess.Popen([str(a) for a in args],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=kwargs.get('env',ENV))
        output=bytearray()
        while True:
            chunk=process.stdout.read(8192)
            if not chunk:break
            if capture:
                output.extend(chunk)
                if len(output)>2*1024*1024:
                    process.kill(); process.wait(); raise module.UpdateError('Command response exceeds limit')
            else:append_log(log,chunk.decode(errors='replace'))
        process.stdout.close()
        code=process.wait()
        if code:raise module.UpdateError('Host update command failed')
        return output.decode(errors='replace')
    module.run=command
    try:
        install=module.discover(cfg['source'],cfg['data'],cfg['project'])
        trusted(install.source,True)
        for name in ('compose.yaml','deploy.sh','package.json','scripts/update-release.py'):trusted(install.source/name)
        # Follow the activated trusted release for future updater fixes.
        module=updater_module(install.source)
        module.run=command
        module.update(install,event=event)
        refreshed=refresh_helper(cfg)
        store.change(job_id,state='succeeded',phase='completed')
        if refreshed:
            # Persist success before replacing this service's process group.
            subprocess.Popen(['systemctl','--no-block','restart','codex-agent-platform-updater-'+identity(cfg['data'])+'.service'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=ENV,close_fds=True)
        return 0
    except Exception as error:
        append_log(log,str(error)+'\n')
        store.change(job_id,state='failed',phase='failed',error_code=phase+'_failed')
        return 1

class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
    daemon_threads=True
    request_queue_size=8
    def __init__(self,*args,**kwargs):
        self.slots=threading.BoundedSemaphore(16)
        super().__init__(*args,**kwargs)
    def process_request(self,request,address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request);return
        try:super().process_request(request,address)
        except BaseException:
            self.slots.release();raise
    def process_request_thread(self,request,address):
        try:super().process_request_thread(request,address)
        finally:self.slots.release()
    def get_request(self):
        connection,address=super().get_request()
        connection.settimeout(5)
        return connection,address
    def verify_request(self,request,address):
        _,uid,_=struct.unpack('3i',request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        return uid in (0,1000)

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.0'
    def log_message(self,*args):pass
    def reply(self,status,value):
        body=json.dumps(value,separators=(',',':')).encode()
        self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path!='/status':return self.reply(404,{'error_code':'not_found'})
        self.reply(200,{'available':True,'job':self.server.store.read()})
    def do_POST(self):
        if self.path!='/upgrade':return self.reply(404,{'error_code':'not_found'})
        try:
            length=self.headers.get('Content-Length','')
            if not length.isdigit() or int(length)>64 or self.headers.get('Transfer-Encoding'):raise ValueError()
            upgrade_body(self.rfile.read(int(length)))
        except (ValueError,TimeoutError):return self.reply(400,{'error_code':'invalid_request'})
        job=self.server.store.admit(self.server.launch)
        self.reply(202,{'available':True,'job':job})

def watch_worker(process,store,job_id):
    process.wait()
    # Covers failure before the worker can claim its durable job (invalid config,
    # import error or abrupt exit). Terminal outcomes are never overwritten.
    store.change(job_id,state='failed',phase='failed',error_code='worker_exited')


def launch_worker(config_path,job,store):
    process=subprocess.Popen([sys.executable,'-B',str(Path(__file__).resolve()),'worker','--config',str(config_path),'--job',job['id']],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,close_fds=True,env=ENV)
    threading.Thread(target=watch_worker,args=(process,store,job['id']),daemon=True).start()


def serve(cfg, config_path):
    channel=Path(cfg['data'])/'updater'
    prepare_channel(channel)
    store=JobStore(cfg['state'])
    # Single helper instance. This lock is distinct from the updater's shared CLI lock.
    with (Path(cfg['state'])/'daemon.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        store.interrupt()
        socket_path=channel/'updater.sock'
        if socket_path.exists() or socket_path.is_symlink():
            if not stat.S_ISSOCK(socket_path.lstat().st_mode):raise ValueError('Unexpected socket path')
            socket_path.unlink()
        with Server(str(socket_path),Handler) as server:
            socket_path.chmod(0o660); os.chown(socket_path,0,1000)
            server.store=store
            server.launch=lambda job:launch_worker(config_path,job,store)
            server.serve_forever()

def prepare_channel(channel):
    if channel.is_symlink():raise ValueError('Refusing symlink updater channel')
    channel.mkdir(mode=0o750,exist_ok=True)
    channel.chmod(0o750)
    if os.geteuid()==0:os.chown(channel,0,1000)

def identity(data):return hashlib.sha256(str(Path(data).resolve()).encode()).hexdigest()[:16]

def refresh_files(source,target):
    bodies={}
    for name in ('host-updater.py','update-release.py'):
        path=Path(source)/'scripts'/name
        trusted(path)
        if path.stat().st_size>1024*1024:raise ValueError('Helper source exceeds limit')
        body=path.read_bytes();ast.parse(body,filename=name);bodies[name]=body
    for name,body in bodies.items():
        path=Path(target)/name
        if path.is_symlink():raise ValueError('Refusing symlink helper')
        fd,temp=tempfile.mkstemp(prefix='.'+name,dir=target)
        try:
            with os.fdopen(fd,'wb') as out:out.write(body);out.flush();os.fsync(out.fileno())
            os.chmod(temp,0o600);os.replace(temp,path)
        finally:
            if os.path.exists(temp):os.unlink(temp)


def refresh_helper(cfg):
    base=HELPER_ROOT/identity(cfg['data'])
    if Path(__file__).resolve().parent!=base:return False
    state_path=Path(cfg['data'])/'.deployment.json';trusted(state_path)
    source=Path(json.loads(state_path.read_text())['source']);trusted(source,True)
    trusted(base,True);refresh_files(source,base)
    return True


def read_policy(data):
    path=Path(data)/POLICY
    if path.is_symlink():raise ValueError('Refusing symlink web update policy')
    if not path.exists():return True
    trusted(path)
    if path.stat().st_size>256:raise ValueError('Invalid web update policy')
    value=json.loads(path.read_text())
    if not isinstance(value,dict) or set(value)!={'enabled'} or not isinstance(value['enabled'],bool):
        raise ValueError('Invalid web update policy')
    return value['enabled']


@contextlib.contextmanager
def setup_lock(data):
    trusted(data,True)
    path=Path(data)/'.web-update.lock'
    if path.exists() or path.is_symlink():trusted(path)
    fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'a') as out:
        fcntl.flock(out,fcntl.LOCK_EX)
        yield


def systemd_available():
    if sys.platform!='linux' or not Path('/run/systemd/system').is_dir() or not shutil.which('systemctl'):return False
    try:
        return subprocess.run(['systemctl','show','--property=Version','--value'],env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5).returncode==0
    except (OSError,subprocess.SubprocessError):return False


def ensure_web_update(source,data,project):
    try:
        if os.geteuid()!=0:raise ValueError('root is required; run deployment with sudo')
        with setup_lock(data):
            if not read_policy(data):
                print('Web upgrades remain explicitly disabled for '+str(data))
                return 0
            if not systemd_available():raise ValueError('a running Linux/systemd host is required')
            unit='codex-agent-platform-updater-'+identity(data)+'.service'
            active=subprocess.run(['systemctl','is-active','--quiet',unit],env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
            # Never restart a broker/worker while it is upgrading its own deployment.
            if active.returncode==0:return 0
            if not (Path(data)/POLICY).exists() and (UNIT_ROOT/unit).exists():
                enabled=subprocess.run(['systemctl','is-enabled',unit],env=ENV,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=10)
                if enabled.stdout.strip() in ('disabled','masked','masked-runtime'):
                    atomic(Path(data)/POLICY,{'enabled':False})
                    print('Preserved previously disabled web upgrade service for '+str(data))
                    return 0
            # Distinguish our partially-created unit from a legacy operator opt-out.
            atomic(Path(data)/POLICY,{'enabled':True})
            install_service(source,data,project,staged=os.environ.get('PLATFORM_UPDATE_STAGED')=='1')
    except Exception as error:
        entry=str(Path(source or '.')/'deploy.sh')
        status=shlex.join(['sudo','bash',entry,'web-update-status',str(data)])
        repair=shlex.join(['sudo','bash',entry,'enable-web-update',str(data)])
        print('Web upgrade setup unavailable: '+str(error)+'. CLI update remains available. '
              'Inspect: '+status+'; retry setup: '+repair,file=sys.stderr)
    return 0


def install(action,source,data,project):
    if action=='ensure-web-update':return ensure_web_update(source,data,project)
    if os.geteuid()!=0:raise ValueError('Host updater setup requires root')
    key=identity(data)
    state=STATE_ROOT/key
    unit='codex-agent-platform-updater-'+key+'.service'
    if action=='web-update-status':
        print(json.dumps(status_info(data,state),indent=2),flush=True)
        return subprocess.run(['systemctl','status','--no-pager',unit],env=ENV).returncode
    with setup_lock(data):
        read_policy(data)
        if action=='disable-web-update':
            atomic(Path(data)/POLICY,{'enabled':False})
            if systemd_available() and (UNIT_ROOT/unit).exists():
                subprocess.run(['systemctl','disable','--now',unit],check=True,env=ENV)
            # systemd terminates workers too; uncertainty remains visible on next startup.
            if state.exists():
                trusted(state,True);JobStore(state).interrupt()
            socket_path=Path(data)/'updater/updater.sock'
            if socket_path.exists() and stat.S_ISSOCK(socket_path.lstat().st_mode):socket_path.unlink()
            print('Web upgrades explicitly disabled for '+str(data))
            return 0
        if not systemd_available():raise ValueError('Web upgrades require a running Linux/systemd host; CLI update remains available')
        atomic(Path(data)/POLICY,{'enabled':True})
        install_service(source,data,project)
        return 0


def install_service(source,data,project,staged=False):
    key=identity(data)
    base=HELPER_ROOT/key
    config_dir=CONFIG_ROOT
    state=STATE_ROOT/key
    unit='codex-agent-platform-updater-'+key+'.service'
    config=config_dir/(key+'.json')
    module=updater_module()
    installation=module.discover(source,data,project)
    selected_source=Path(source).resolve() if staged else installation.source
    try:
        trusted(selected_source,True)
        for name in ('compose.yaml','deploy.sh','package.json'):trusted(selected_source/name)
    except (OSError,ValueError):
        raise ValueError('Source must be root-owned. First run the verified stable update bootstrap as root to stage a root-owned release, then run the runtime deploy.sh enable-web-update command.') from None
    trusted(installation.data,True)
    trusted(installation.data/'.env')
    for folder in (base,config_dir,state):
        folder.mkdir(parents=True,exist_ok=True,mode=0o700); trusted(folder,True); folder.chmod(0o700)
    for name in ('host-updater.py','update-release.py'):
        trusted(Path(__file__).with_name(name))
        target=base/name
        if target.is_symlink():raise ValueError('Refusing symlink installed helper')
        shutil.copyfile(Path(__file__).with_name(name),target); target.chmod(0o600)
    cfg={'source':str(selected_source),'data':str(installation.data),'project':installation.project,'state':str(state),'upstream':REPO}
    atomic(config,cfg); prepare_channel(installation.data/'updater')
    contents=systemd_unit(base,config,installation.data)
    unit_path=UNIT_ROOT/unit
    if unit_path.is_symlink():raise ValueError('Refusing symlink unit file')
    unit_path.write_text(contents); unit_path.chmod(0o644)
    subprocess.run(['systemctl','daemon-reload'],check=True,env=ENV)
    subprocess.run(['systemctl','enable','--now',unit],check=True,env=ENV)
    print('Web upgrades enabled for '+str(installation.data)+'; unit '+unit)
    return 0

def status_info(data,state):
    state=Path(state)
    job=None
    if state.exists():
        trusted(state,True)
        job=JobStore(state).read()
    return {'job':job,'web_update_enabled':read_policy(data),'backup_directory':str(Path(data)/'backups'),'log_file':str(state/'worker.log'),
            'recovery':'Inspect host backups and deployment recovery instructions; do not downgrade migrated databases.'}


def systemd_unit(base,config,data):
    # Paths enter systemd argv through quoted arguments, never a shell.
    def quote(value):return '"'+str(value).replace('\\','\\\\').replace('"','\\"').replace('%','%%')+'"'
    contents='''[Unit]\nDescription=Codex Agent Platform host updater\nAfter=docker.service\nRequires=docker.service\n[Service]\nType=simple\nUser=root\nGroup=root\nUMask=0077\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=30\nNoNewPrivileges=true\nProtectSystem=full\nPrivateTmp=true\n[Install]\nWantedBy=multi-user.target\n'''
    contents=contents.replace('[Install]', 'ReadWritePaths='+quote(base)+' '+quote(data)+'\n'+ 'ExecStart=/usr/bin/python3 -B '+quote(base/'host-updater.py')+' serve --config '+quote(config)+'\n[Install]')
    return contents

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('serve','worker','ensure-web-update','enable-web-update','disable-web-update','web-update-status'))
    parser.add_argument('--config',type=Path); parser.add_argument('--job')
    parser.add_argument('--source',type=Path); parser.add_argument('--data',type=Path); parser.add_argument('--project')
    args=parser.parse_args(); os.umask(0o077)
    try:
        if args.action in ('serve','worker'):
            if os.geteuid()!=0:raise ValueError('Root required')
            cfg=load_config(args.config)
            if args.action=='serve':serve(cfg,args.config)
            else:
                if not re.fullmatch('[a-f0-9]{32}',args.job or ''):raise ValueError('Invalid job')
                return worker(cfg,args.job)
        else:return install(args.action,args.source,args.data,args.project)
    except (OSError,ValueError,subprocess.SubprocessError) as error:
        print('Host updater error: '+str(error),file=sys.stderr); return 1
    return 0
if __name__=='__main__':sys.exit(main())
