#!/usr/bin/env python3
"""Real local Compose update lifecycle using synthetic empty data and a local release fixture.

Build/tag all release targets first. Never mounts existing account state or submits model work.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
from unittest.mock import patch
import uuid


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True,type=Path)
    parser.add_argument('--archive',required=True,type=Path)
    args=parser.parse_args()
    if os.geteuid()!=0:
        parser.error("Run this isolated container test as root so init assigns mounted directories to container UID 1000.")
    source=args.source.resolve()
    archive=args.archive.resolve()
    version=json.loads((source/'package.json').read_text())['version']
    tag='v'+version
    spec=importlib.util.spec_from_file_location('release_updater',source/'scripts/update-release.py')
    u=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(u)
    with tempfile.TemporaryDirectory(prefix='release-smoke-') as temp:
        data=Path(temp)/'runtime'
        project='release-smoke-'+uuid.uuid4().hex[:12]
        install=u.Install(source,data,project)
        def fixture(url,path,limit):
            if url.endswith('/latest'):
                info={'tag_name':tag,'draft':False,'prerelease':False,'published_at':'2026-10-29T00:00:00Z','assets':[
                    {'name':name,'browser_download_url':f'https://github.com/{u.REPO}/releases/download/{tag}/{name}'}
                    for name in (archive.name,'SHA256SUMS')]}
                path.write_text(json.dumps(info))
            elif url.endswith('SHA256SUMS'):
                path.write_text(hashlib.sha256(archive.read_bytes()).hexdigest()+'  '+archive.name+'\n')
            else:
                shutil.copyfile(archive,path)
        def port():
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0))
                return sock.getsockname()[1]
        try:
            u.run(['bash',str(source/'deploy.sh'),'init',str(data)])
            with (data/'.env').open('a') as env:
                env.write(f'\nPLATFORM_PORT={port()}\nMANAGER_PORT={port()}\nEXECUTION_PAUSED=true\n')
            sentinel=data/'workspace'/'synthetic-preserved.txt'
            sentinel.write_text('synthetic retained workspace, no account authorization')
            before=(data/'.env').read_bytes()
            u.run(u.compose(install)+['up','-d','--no-build','--wait','--wait-timeout','120'])
            found=u.discover(source,None,project)
            assert found.data==data and found.project==project
            with patch.object(u,'download',fixture):
                u.update(found)
            state=json.loads((data/u.STATE).read_text())
            assert state['version']==version
            assert Path(state['source'])!=source
            assert (data/'.env').read_bytes()==before
            assert sentinel.read_text().startswith('synthetic retained')
            assert Path(state['backup']).is_file()
            u.run(['bash',str(data/'deploy.sh'),'status'])
            found=u.discover(source,None,project)
            with patch.object(u,'download',fixture):
                u.update(found)
            assert json.loads((data/u.STATE).read_text())==state,'second update must be a no-op'
            print('Real Compose update: discovery, backup, health, launcher, data preservation and no-op passed.')
        finally:
            u.run(u.compose(install)+['down','--remove-orphans'])


if __name__=='__main__':
    main()
