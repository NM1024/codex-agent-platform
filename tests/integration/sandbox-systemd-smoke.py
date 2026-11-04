#!/usr/bin/env python3
"""Synthetic sandbox setup from the updater's read-only systemd namespace."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time


def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, timeout=150, **kwargs)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    args=parser.parse_args()
    if os.geteuid()!=0 or not Path('/run/systemd/system').is_dir():
        raise RuntimeError('Real root/systemd host required; this release check must not skip')
    # /tmp has writable ancestry and intentionally fails the installer's trust checks.
    root=Path(tempfile.mkdtemp(prefix='codex-synthetic-systemd-',dir='/var/lib'))
    source=root/'source';data=root/'runtime';(source/'scripts').mkdir(parents=True);data.mkdir()
    for name in ['host-sandbox.py','sandbox_runtime.py','sandbox_files.py','sandbox_network.py']:
        shutil.copyfile(args.source/'scripts'/name,source/'scripts'/name)
        (source/'scripts'/name).chmod(0o600)
    key=hashlib.sha256(str(data).encode()).hexdigest()[:16]
    unit='codex-agent-platform-sandbox-'+key+'.service'
    worker='codex-synthetic-updater-'+key
    try:
        run(['systemd-run','--quiet','--wait','--pipe','--collect','--unit='+worker,
             '--property=User=root','--property=UMask=0077','--property=ProtectSystem=full',
             '--property=PrivateTmp=true','--property=NoNewPrivileges=true',
             '--property=ReadWritePaths='+str(root),'/usr/bin/python3','-B',
             source/'scripts/host-sandbox.py','ensure-sandbox','--source',source,'--data',data])
        assert json.loads((data/'.sandbox-policy.json').read_text())=={'enabled':True}
        channel=data/'sandbox/sandbox.sock'
        deadline=time.monotonic()+20
        while not channel.exists() and time.monotonic()<deadline:time.sleep(.2)
        assert channel.is_socket(),'protected updater did not create a working host channel'
        run(['systemctl','is-active','--quiet',unit])
        connection=http.client.HTTPConnection('localhost',timeout=10)
        connection.sock=socket.socket(socket.AF_UNIX);connection.sock.settimeout(10);connection.sock.connect(str(channel))
        try:
            connection.request('POST','/sandbox',body='{"action":"health"}',headers={'Content-Type':'application/json'})
            response=connection.getresponse();value=json.loads(response.read())
            assert response.status==200 and value.get('available') is True
        finally:connection.close()
        print('Verified sandbox installation and Unix API from ProtectSystem=full updater')
    finally:
        subprocess.run(['systemctl','disable','--now',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=60)
        Path('/etc/systemd/system',unit).unlink(missing_ok=True)
        for path in [Path('/usr/local/lib/codex-agent-platform-sandbox',key),Path('/var/lib/codex-agent-platform-sandbox',key),root]:
            if path.exists():shutil.rmtree(path)
        Path('/etc/codex-agent-platform-sandbox',key+'.json').unlink(missing_ok=True)
        run(['systemctl','daemon-reload'])


if __name__=='__main__':main()
