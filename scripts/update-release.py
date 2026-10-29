#!/usr/bin/env python3
"""Host-side stable-release updater. Python 3.10+, curl and Compose v2 required."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from typing import NamedTuple

REPO = 'NM1024/codex-agent-platform'
API = f'https://api.github.com/repos/{REPO}/releases/latest'
STATE = '.deployment.json'
MOUNTS = {
    'gateway': {'/data':'data', '/workspace':'workspace'},
    'runner': {'/workspace':'workspace', '/codex':'codex'},
    'manager': {'/management':'manager', '/codex':'codex'},
}


class UpdateError(Exception):
    pass


class Install(NamedTuple):
    source: Path
    data: Path
    project: str


def run(args, capture=False, **kwargs):
    result = subprocess.run([str(x) for x in args], text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None, **kwargs)
    if result.returncode:
        # Do not print captured Compose config or Docker inspection (contains secrets).
        raise UpdateError(f'Command failed ({result.returncode}): {shlex.join([str(x) for x in args[:3]])}')
    return result.stdout or ''


def containers():
    ids = run(['docker','ps','-aq','--filter','label=com.docker.compose.project'], capture=True).split()
    if not ids:
        return []
    return json.loads(run(['docker','inspect',*ids],capture=True))


def env_data(data):
    file = data / '.env'
    if not file.is_file() or file.is_symlink():
        raise UpdateError(f'No regular installation .env in {data}; pass the existing deployment directory.')
    values = {}
    for line in file.read_text().splitlines():
        match = re.fullmatch(r'\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*',line)
        if match:
            value = match[2]
            if len(value)>1 and value[0]==value[-1] and value[0] in '\"\'':
                value=value[1:-1]
            values[match[1]]=value
    configured=values.get('PLATFORM_DATA_DIR','/data/codex-agent-platform')
    if '$' in configured or Path(configured).resolve()!=data:
        raise UpdateError('PLATFORM_DATA_DIR in .env differs from installation directory; resolve it before updating.')
    override=os.environ.get('PLATFORM_DATA_DIR')
    if override and Path(override).resolve()!=data:
        raise UpdateError('PLATFORM_DATA_DIR environment override differs from installation directory.')


def saved(data):
    file=data/STATE
    if file.is_symlink():
        raise UpdateError('Refusing symlink deployment state.')
    return json.loads(file.read_text()) if file.is_file() else {}


def discover(source, data=None, project=None):
    source=Path(source).resolve()
    explicit=data is not None
    data=Path(data).resolve() if explicit else None
    candidates=[]
    existing=containers()
    for item in existing:
        labels=item['Config'].get('Labels',{})
        if not item.get('Config',{}).get('Image','').startswith('codex-agent-platform-manager:') or labels.get('com.docker.compose.service')!='manager' or labels.get('com.docker.compose.oneoff','').lower()=='true':
            continue
        mount=next((v for v in item.get('Mounts',[]) if v['Destination']=='/management' and v.get('Type')=='bind'),None)
        if not mount:
            continue
        location=Path(mount['Source']).resolve().parent
        name=labels.get('com.docker.compose.project','')
        if data and location==data and project and name!=project:
            raise UpdateError('Existing installation uses a different Compose project; correct PLATFORM_PROJECT.')
        if (data and location!=data) or (project and name!=project):
            continue
        candidates.append((location,name,labels))
    unique={(str(d),p) for d,p,_ in candidates}
    if len(unique)>1:
        raise UpdateError('Found multiple installations; pass deployment directory and, if needed, PLATFORM_PROJECT.')
    if candidates:
        location,name,labels=candidates[0]
        configs=labels.get('com.docker.compose.project.config_files','')
        if ',' in configs or not configs or Path(configs).name!='compose.yaml':
            raise UpdateError('Unsupported custom Compose files; update manually using the release source.')
        data=location
        project=name
        # Container labels identify the original Git/archive installation, even from a bootstrap in /tmp.
        source=Path(configs).resolve().parent
    if data is None:
        # A runtime launcher passes its own directory explicitly. A colocated .env is also supported.
        for possible in (source, Path('/data/codex-agent-platform')):
            if (possible/'.env').is_file():
                data=possible.resolve()
                break
    if data is None:
        raise UpdateError('Cannot find installation; use ./deploy.sh update /path/to/existing/runtime.')
    env_data(data)
    state=saved(data)
    if state.get('source'):
        source=Path(state['source']).resolve()
    project=project or state.get('project') or 'codex-agent-platform'
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*',project):
        raise UpdateError('Invalid Compose project name.')
    if any(c in str(data)+str(source) for c in ('\n','\r','$','#')):
        raise UpdateError('Unsupported installation path characters.')
    if not (source/'compose.yaml').is_file() or not (source/'deploy.sh').is_file():
        raise UpdateError(f'Active deployment source unavailable: {source}')
    install=Install(source,data,project)
    check_existing(install,existing)
    return install


def check_existing(install,existing):
    for item in existing:
        labels=item['Config'].get('Labels',{})
        if labels.get('com.docker.compose.project')!=install.project or labels.get('com.docker.compose.oneoff','').lower()=='true':
            continue
        service=labels.get('com.docker.compose.service')
        if service not in MOUNTS:
            raise UpdateError('Selected Compose project has unsupported services; upgrade manually.')
        for target,sub in MOUNTS[service].items():
            mount=next((m for m in item.get('Mounts',[]) if m['Destination']==target),None)
            if not mount or mount.get('Type')!='bind' or Path(mount['Source']).resolve()!=install.data/sub:
                raise UpdateError(f'Existing project {install.project} has a different {service} mount for {target}; refusing to touch it.')


def download(url, path, limit):
    run(['curl','--fail','--silent','--show-error','--location','--proto','=https',
         '--proto-redir','=https','--connect-timeout','20','--max-time','300',
         '--max-filesize',str(limit),'-H','Accept: application/vnd.github+json',
         '-H','X-GitHub-Api-Version: 2022-11-28','--output',str(path),url])
    if path.stat().st_size>limit:
        raise UpdateError('Release download exceeds size limit.')


def version(text):
    match=re.fullmatch(r'v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)',text)
    if not match:
        raise UpdateError('Expected a stable semantic version release (vX.Y.Z).')
    return tuple(map(int,match.groups()))


def release(work):
    metadata=work/'release.json'
    download(API,metadata,2*1024*1024)
    info=json.loads(metadata.read_text())
    tag=info.get('tag_name','')
    version(tag)
    if info.get('draft') is not False or info.get('prerelease') is not False or not info.get('published_at'):
        raise UpdateError('Latest release is not a published stable release.')
    name=f'codex-agent-platform-{tag}.tar.gz'
    urls={}
    for wanted in (name,'SHA256SUMS'):
        matches=[a for a in info.get('assets',[]) if a.get('name')==wanted]
        expected=f'https://github.com/{REPO}/releases/download/{tag}/{wanted}'
        if len(matches)!=1 or matches[0].get('browser_download_url')!=expected:
            raise UpdateError(f'Missing or untrusted release asset: {wanted}')
        urls[wanted]=expected
    sums=work/'SHA256SUMS'
    archive=work/name
    download(urls['SHA256SUMS'],sums,16384)
    download(urls[name],archive,64*1024*1024)
    expected=[line.split()[0] for line in sums.read_text().splitlines()
              if len(line.split())==2 and line.split()[1]==name]
    actual=hashlib.sha256(archive.read_bytes()).hexdigest()
    if len(expected)!=1 or not re.fullmatch(r'[a-f0-9]{64}',expected[0]) or expected[0]!=actual:
        raise UpdateError('Release checksum mismatch; no service was changed.')
    return tag,archive,actual


def extract(archive, directory, tag):
    prefix=f'codex-agent-platform-{tag}'
    with tarfile.open(archive,'r:gz') as tar:
        members=tar.getmembers()
        if len(members)>20000 or sum(m.size for m in members)>256*1024*1024:
            raise UpdateError('Release archive exceeds extraction limits.')
        seen=set()
        for item in members:
            parts=PurePosixPath(item.name).parts
            if (not parts or parts[0]!=prefix or '..' in parts or item.name.startswith('/')
                    or '\\' in item.name or not (item.isfile() or item.isdir()) or item.name in seen):
                raise UpdateError('Unsafe release archive path or file type.')
            seen.add(item.name)
            relative=Path(*parts[1:])
            target=directory/relative
            if item.isdir():
                target.mkdir(parents=True,exist_ok=True)
            else:
                target.parent.mkdir(parents=True,exist_ok=True)
                with tar.extractfile(item) as src, target.open('xb') as dst:
                    shutil.copyfileobj(src,dst)
                target.chmod(0o700 if item.mode & 0o111 else 0o600)
    for name in ('compose.yaml','deploy.sh','scripts/update-release.py','package.json'):
        if not (directory/name).is_file():
            raise UpdateError(f'Release archive is missing {name}.')
    if json.loads((directory/'package.json').read_text()).get('version')!=tag[1:]:
        raise UpdateError('Release package version does not match tag.')


def compose(install,source=None):
    return ['docker','compose','--project-name',install.project,'--env-file',str(install.data/'.env'),
            '-f',str((source or install.source)/'compose.yaml')]


def check_mounts(install,source):
    config=json.loads(run(compose(install,source)+['config','--format=json'],capture=True))
    for service,mounts in MOUNTS.items():
        volumes=config.get('services',{}).get(service,{}).get('volumes',[])
        for target,sub in mounts.items():
            mount=next((m for m in volumes if m['target']==target),None)
            if not mount or mount.get('type')!='bind' or Path(mount['source']).resolve()!=install.data/sub:
                raise UpdateError(f'Unsafe {service} mount for {target}; no service was stopped.')
    return config


def atomic(path,body,mode=0o600):
    fd,temp=tempfile.mkstemp(prefix='.'+path.name,dir=path.parent)
    try:
        with os.fdopen(fd,'w') as out:
            out.write(body)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temp,mode)
        os.replace(temp,path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def backup(install,path):
    # Services are stopped. Include every installation-owned file except update artifacts.
    # dereference=False preserves the shared login symlink without following it.
    with tarfile.open(path,'x:gz',dereference=False) as tar:
        for name in ('.env',STATE,'deploy.sh','platform-deploy.sh','data','workspace','codex','manager'):
            file=install.data/name
            if file.exists() or file.is_symlink():
                tar.add(file,arcname=name,recursive=True)
    path.chmod(0o600)


def expected_images(config,tag):
    expected={}
    for service in MOUNTS:
        image=config.get('services',{}).get(service,{}).get('image')
        if image!=f'codex-agent-platform-{service}:{tag[1:]}':
            raise UpdateError('Release image tag does not match selected version.')
        identity=run(['docker','image','inspect','--format','{{.Id}}',image],capture=True).strip()
        if not re.fullmatch(r'sha256:[a-f0-9]{64}',identity):
            raise UpdateError('Cannot resolve expected release image identity.')
        expected[service]=(image,identity)
    return expected


def verify_images(install,source,expected,tag):
    for service,(image,identity) in expected.items():
        ids=run(compose(install,source)+['ps','--all','-q',service],capture=True).split()
        if len(ids)!=1:raise UpdateError('Expected exactly one deployed container per service.')
        details=json.loads(run(['docker','inspect',ids[0]],capture=True))
        if len(details)!=1:raise UpdateError('Cannot inspect deployed service.')
        item=details[0]
        labels=item.get('Config',{}).get('Labels',{})
        state=item.get('State',{})
        if (item.get('Image')!=identity or item.get('Config',{}).get('Image')!=image
                or labels.get('com.docker.compose.project')!=install.project
                or labels.get('com.docker.compose.service')!=service or state.get('Running') is not True
                or state.get('Health',{}).get('Status')!='healthy'):
            raise UpdateError('Deployed service image identity or health does not match selected release.')
        package=run(['docker','exec',ids[0],'node','-p',"require('/app/package.json').version"],capture=True).strip()
        if package!=tag[1:]:raise UpdateError('Deployed package version does not match selected release.')


def update(install,event=None):
    event=event or (lambda phase,**fields:None)
    event('checking')
    compose_version=run(['docker','compose','version','--short'],capture=True).strip()
    match=re.match(r'v?(\d+)\.(\d+)\.(\d+)',compose_version)
    if not match or tuple(map(int,match.groups()))<(2,20,0):
        raise UpdateError('Docker Compose v2 2.20+ is required for health-checked updates.')
    lock=install.data/'.update.lock'
    if lock.is_symlink():
        raise UpdateError('Refusing symlink update lock.')
    with lock.open('a') as handle:
        try:
            fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            raise UpdateError('Another update is running.') from None
        with tempfile.TemporaryDirectory(prefix='platform-update-') as temp:
            event('downloading')
            tag,archive,digest=release(Path(temp))
            event('checking',target_version=tag[1:],release_sha256=digest)
            current=json.loads((install.source/'package.json').read_text())['version']
            state=saved(install.data)
            if state.get('version')==tag[1:] and current==tag[1:]:
                event('verifying')
                config=check_mounts(install,install.source)
                verify_images(install,install.source,expected_images(config,tag),tag)
                event('completed',installed_version=tag[1:])
                print(f'Already running latest stable release {tag}.')
                return
            if re.fullmatch(r'\d+\.\d+\.\d+',current) and version(current)>version(tag):
                raise UpdateError('Refusing to downgrade to an older release.')
            launcher_path=install.data/'deploy.sh'
            if launcher_path.exists() and '# Codex Agent Platform generated launcher' not in launcher_path.read_text():
                launcher_path=install.data/'platform-deploy.sh'
            if launcher_path.exists() and '# Codex Agent Platform generated launcher' not in launcher_path.read_text():
                raise UpdateError('Existing platform-deploy.sh is not an update launcher; refusing to overwrite it.')
            releases=install.data/'releases'
            backups=install.data/'backups'
            for folder in (releases,backups):
                if folder.is_symlink():
                    raise UpdateError(f'Refusing symlink directory: {folder}')
                folder.mkdir(mode=0o700,exist_ok=True)
            staged=Path(tempfile.mkdtemp(prefix=tag+'-',dir=releases))
            extract(archive,staged,tag)
            print(f'Updating {install.project} at {install.data}: {current} → {tag}',flush=True)
            config=check_mounts(install,staged)
            # Verify the original Compose resolves the same data before using it to stop services.
            check_mounts(install,install.source)
            env={**os.environ,'PLATFORM_PROJECT':install.project}
            event('building')
            run(['bash',str(staged/'deploy.sh'),'build',str(install.data)],env={**env,'PLATFORM_UPDATE_STAGED':'1'})
            expected=expected_images(config,tag)
            backup_path=backups/(time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+str(time.time_ns())+'.tar.gz')
            try:
                event('stopping')
                run(compose(install)+['stop'])
            except BaseException:
                with contextlib.suppress(Exception):
                    run(compose(install)+['start'])
                raise UpdateError('Could not stop all services; attempted to restart original containers; no migration was run.') from None
            try:
                event('backing_up')
                backup(install,backup_path)
            except BaseException:
                with contextlib.suppress(Exception):
                    run(compose(install)+['start'])
                raise UpdateError('Backup failed; attempted to restart old containers; verify service status. Update not activated.') from None
            try:
                # Validation opens/migrates the database: it must run after the consistent backup.
                event('validating')
                run(['bash',str(staged/'deploy.sh'),'validate',str(install.data)],env={**env,'PLATFORM_UPDATE_STAGED':'1'})
                event('restarting')
                run(compose(install,staged)+['up','-d','--no-build','--wait','--wait-timeout','180'])
            except BaseException:
                raise UpdateError(f'New release did not pass health checks. Not activated; backup: {backup_path}. '
                                  f'Inspect with docker compose --project-name {shlex.quote(install.project)} '
                                  f'--env-file {shlex.quote(str(install.data/".env"))} -f {shlex.quote(str(staged/"compose.yaml"))} logs. '
                                  'Do not downgrade migrated databases; see docs/DEPLOYMENT.md recovery instructions.') from None
            event('verifying')
            verify_images(install,staged,expected,tag)
            launcher='#!/usr/bin/env bash\n# Codex Agent Platform generated launcher\nset -euo pipefail\nexec bash '+shlex.quote(str(staged/'deploy.sh'))+' "${1:-status}" '+shlex.quote(str(install.data))+'\n'
            atomic(install.data/STATE,json.dumps({'source':str(staged),'project':install.project,
                   'version':tag[1:],'sha256':digest,'previous_source':str(install.source),
                   'backup':str(backup_path),'launcher':str(launcher_path)},indent=2)+'\n')
            atomic(launcher_path,launcher,0o700)
            event('completed',installed_version=tag[1:])
            print(f'Updated successfully to {tag}. Backup: {backup_path}\nNext update: sudo bash {shlex.quote(str(launcher_path))} update')


def main():
    if sys.version_info<(3,10):
        print('Python 3.10+ is required.',file=sys.stderr)
        return 1
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('resolve','update'))
    parser.add_argument('--source',required=True,type=Path)
    parser.add_argument('--data',type=Path)
    parser.add_argument('--project',default=os.environ.get('PLATFORM_PROJECT'))
    args=parser.parse_args()
    os.umask(0o077)
    try:
        install=discover(args.source,args.data,args.project)
        if args.action=='resolve':
            print(install.source,install.data,install.project,sep='\n')
        else:
            # An original checkout must use updater fixes from its active installed release.
            active=install.source/'scripts/update-release.py'
            if __file__!='<stdin>' and saved(install.data).get('source') and Path(__file__).resolve()!=active.resolve():
                os.execv(sys.executable,[sys.executable,'-B',str(active),'update','--source',str(install.source),'--data',str(install.data),'--project',install.project])
            update(install)
    except (UpdateError,OSError,ValueError,KeyError,tarfile.TarError) as error:
        print(f'Update error: {error}',file=sys.stderr)
        return 1
    return 0


if __name__=='__main__':
    sys.exit(main())
