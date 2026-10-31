#!/usr/bin/env python3
"""Root-owned, installation-scoped local sandbox broker. No host shell API."""
import argparse
import ast
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import tempfile
import threading

IMAGE = 'codex-agent-platform-sandbox:1.0.3'
HELPER_ROOT = Path('/usr/local/lib/codex-agent-platform-sandbox')
CONFIG_ROOT = Path('/etc/codex-agent-platform-sandbox')
STATE_ROOT = Path('/var/lib/codex-agent-platform-sandbox')
UNIT_ROOT = Path('/etc/systemd/system')
POLICY = '.sandbox-policy.json'
MODULES = ('host-sandbox.py', 'sandbox_runtime.py', 'sandbox_files.py', 'sandbox_network.py')
PROXIES = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
ACTIONS = {'context', 'files', 'exec', 'process', 'export', 'destroy', 'recover'}
MAX_BODY = 30 * 1024 * 1024
CONTROL_BODY = 512 * 1024
OWNER = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def trusted(path, directory=False):
    path = Path(path)
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Sandbox helper paths must be root-owned and not writable by others')
    info = path.stat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError('Unexpected sandbox helper path type')


def identity(data):
    return hashlib.sha256(str(Path(data).resolve()).encode()).hexdigest()[:16]


def atomic(path, value):
    if path.is_symlink():
        raise ValueError('Refusing symlink configuration')
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out); out.write('\n'); out.flush(); os.fsync(out.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def read_policy(data):
    path = Path(data) / POLICY
    if not path.exists() and not path.is_symlink(): return False
    trusted(path)
    if path.stat().st_size > 256: raise ValueError('Invalid sandbox policy')
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or set(value) != {'enabled'} or type(value['enabled']) is not bool:
        raise ValueError('Invalid sandbox policy')
    return value['enabled']


def load_config(path):
    trusted(path)
    if Path(path).stat().st_size > 16384: raise ValueError('Invalid sandbox configuration')
    cfg = json.loads(Path(path).read_text())
    if not isinstance(cfg, dict) or set(cfg) != {'data', 'installation', 'image', 'proxy_env'}:
        raise ValueError('Invalid sandbox configuration')
    if cfg['image'] != IMAGE or not isinstance(cfg['data'], str) or not Path(cfg['data']).is_absolute():
        raise ValueError('Invalid fixed sandbox configuration')
    trusted(cfg['data'], True)
    if cfg['installation'] != identity(cfg['data']): raise ValueError('Invalid installation identity')
    if not isinstance(cfg['proxy_env'], dict) or any(k not in PROXIES or not isinstance(v, str) or len(v) > 4096 or '\n' in v or '\x00' in v for k, v in cfg['proxy_env'].items()):
        raise ValueError('Invalid proxy configuration')
    return cfg


def prepare_channel(data):
    channel = Path(data) / 'sandbox'
    if channel.is_symlink(): raise ValueError('Refusing symlink sandbox channel')
    channel.mkdir(mode=0o750, exist_ok=True)
    channel.chmod(0o750)
    os.chown(channel, 0, 1000)
    return channel


def systemd_available():
    if sys.platform != 'linux' or not Path('/run/systemd/system').is_dir() or not shutil.which('systemctl'): return False
    try:
        return subprocess.run(['systemctl', 'show', '--property=Version', '--value'], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode == 0
    except (OSError, subprocess.SubprocessError): return False


def unit_name(data): return 'codex-agent-platform-sandbox-' + identity(data) + '.service'


def systemd_unit(base, config, data):
    def quote(value): return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
    return '''[Unit]
Description=Codex Agent Platform local code sandbox
After=docker.service
Requires=docker.service
[Service]
Type=simple
User=root
Group=root
UMask=0077
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=45
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
''' + 'ReadWritePaths=' + quote(data) + ' ' + quote(STATE_ROOT / identity(data)) + '\nExecStart=/usr/bin/python3 -B ' + quote(base / 'host-sandbox.py') + ' serve --config ' + quote(config) + '''
[Install]
WantedBy=multi-user.target
'''


def prepare_install(source, data):
    trusted(source, True); trusted(data, True)
    source, data = Path(source).resolve(), Path(data).resolve()
    trusted(source, True); trusted(data, True)
    bodies = {}
    for name in MODULES:
        path = source / 'scripts' / name
        trusted(path)
        if path.stat().st_size > 1024 * 1024: raise ValueError('Sandbox helper module exceeds limit')
        bodies[name] = path.read_bytes()
        ast.parse(bodies[name], filename=name)
    key = identity(data)
    base, config, state = HELPER_ROOT / key, CONFIG_ROOT / (key + '.json'), STATE_ROOT / key
    for folder in (base, CONFIG_ROOT, state):
        folder.mkdir(parents=True, mode=0o700, exist_ok=True); trusted(folder, True); folder.chmod(0o700)
    for name, body in bodies.items():
        target = base / name
        if target.is_symlink(): raise ValueError('Refusing symlink helper module')
        fd, temporary = tempfile.mkstemp(prefix='.' + name, dir=base)
        try:
            with os.fdopen(fd, 'wb') as out: out.write(body); out.flush(); os.fsync(out.fileno())
            os.chmod(temporary, 0o600); os.replace(temporary, target)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
    cfg = {'data': str(data), 'installation': key, 'image': IMAGE, 'proxy_env': {k: os.environ[k] for k in PROXIES if k in os.environ}}
    atomic(config, cfg)
    prepare_channel(data)
    return base, config


def setup(action, source, data):
    if os.geteuid() != 0: raise ValueError('Host sandbox setup requires root')
    # Reject links before resolving the trusted installation path.
    trusted(data, True)
    data = Path(data).resolve()
    unit = unit_name(data)
    if action == 'sandbox-status':
        active = False
        if systemd_available():
            active = subprocess.run(['systemctl', 'is-active', '--quiet', unit], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).returncode == 0
        path = data / 'sandbox/sandbox.sock'
        print(json.dumps({'enabled': read_policy(data), 'service_active': active, 'socket_exists': path.exists() and stat.S_ISSOCK(path.lstat().st_mode), 'unit': unit, 'image': IMAGE}))
        return 0
    lock_path = data / '.sandbox-setup.lock'
    if lock_path.exists() or lock_path.is_symlink(): trusted(lock_path)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == 'disable-sandbox':
            atomic(data / POLICY, {'enabled': False})
            if systemd_available() and (UNIT_ROOT / unit).exists():
                subprocess.run(['systemctl', 'disable', '--now', unit], env=ENV, check=True)
            path = data / 'sandbox/sandbox.sock'
            if path.exists() and stat.S_ISSOCK(path.lstat().st_mode): path.unlink()
            print('Local sandbox disabled. If using foreground mode, stop that process too.')
            return 0
        if action == 'enable-sandbox' and not systemd_available():
            raise ValueError('A running Linux/systemd host is required; use deploy.sh sandbox-foreground for a manually supervised foreground helper')
        trusted(source, True)
        base, config = prepare_install(source, data)
        atomic(data / POLICY, {'enabled': True})
        if action == 'sandbox-foreground':
            print('Starting foreground local sandbox; keep this root-owned process supervised.', flush=True)
            return subprocess.run([sys.executable, '-B', str(base / 'host-sandbox.py'), 'serve', '--config', str(config)], env={**ENV, **{k: os.environ[k] for k in PROXIES if k in os.environ}}).returncode
        unit_path = UNIT_ROOT / unit
        if unit_path.is_symlink(): raise ValueError('Refusing symlink systemd unit')
        unit_path.write_text(systemd_unit(base, config, data)); unit_path.chmod(0o644)
        subprocess.run(['systemctl', 'daemon-reload'], env=ENV, check=True)
        subprocess.run(['systemctl', 'enable', unit], env=ENV, check=True)
        # enable --now leaves an already-active process on old imported modules.
        # Restart only after every fixed module and the config are staged.
        subprocess.run(['systemctl', 'restart', unit], env=ENV, check=True)
        print('Local sandbox enabled for ' + str(data) + '; unit ' + unit)
        return 0


def request_body(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value: raise ValueError('Duplicate request key')
            value[key] = item
        return value
    value = json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Invalid number')))
    if not isinstance(value, dict) or not {'action'} <= set(value) or not set(value) <= {'action', 'conversation_id', 'args'}:
        raise ValueError('Invalid request fields')
    action, owner, args = value['action'], value.get('conversation_id'), value.get('args', {})
    if not isinstance(action, str) or action not in ACTIONS or not isinstance(args, dict): raise ValueError('Invalid sandbox action')
    fields = {'context': set(), 'files': {'action', 'path', 'text', 'content_base64', 'offset', 'limit', 'expected_revision'},
              'exec': {'request_key', 'command', 'cwd', 'timeout_seconds', 'memory_mb', 'grant'},
              'process': {'action', 'execution_id'}, 'export': {'path'}, 'destroy': set(), 'recover': set()}
    if not set(args) <= fields[action]: raise ValueError('Invalid action fields')
    if action == 'files' and 'expected_revision' in args:
        if args.get('action') not in ('write', 'import', 'delete') or type(args['expected_revision']) is not int or args['expected_revision'] < 0:
            raise ValueError('Invalid expected workspace revision')
    if action == 'recover':
        if owner is not None or args: raise ValueError('Invalid recovery request')
    elif not isinstance(owner, str) or not OWNER.fullmatch(owner): raise ValueError('Invalid conversation identity')
    binary = action == 'files' and args.get('action') == 'import'
    if len(raw) > (MAX_BODY if binary else CONTROL_BODY): raise ValueError('Request exceeds action limit')
    return action, owner, args


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 8

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*args, **kwargs)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False): self.shutdown_request(request); return
        try: super().process_request(request, address)
        except BaseException: self.slots.release(); raise

    def process_request_thread(self, request, address):
        try: super().process_request_thread(request, address)
        finally: self.slots.release()

    def get_request(self):
        connection, address = super().get_request(); connection.settimeout(10)
        return connection, address

    def verify_request(self, request, address):
        _, uid, _ = struct.unpack('3i', request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return uid in (0, 1000)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    server_version = 'Sandbox'
    sys_version = ''

    def log_message(self, *args): pass

    def reply(self, status, value):
        body = json.dumps(value, separators=(',', ':'), allow_nan=False).encode()
        if len(body) > MAX_BODY:
            status, body = 503, b'{"error":{"code":"SANDBOX_UNAVAILABLE","message":"Sandbox response exceeds limit"}}'
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass

    def error(self, status, code, message): self.reply(status, {'error': {'code': code, 'message': message}})
    def send_error(self, code, message=None, explain=None): self.error(code, 'SANDBOX_REQUEST', 'Invalid sandbox HTTP request')
    def do_GET(self): self.error(405, 'SANDBOX_REQUEST', 'Use POST /sandbox')

    def do_POST(self):
        if self.path != '/sandbox': return self.error(404, 'SANDBOX_REQUEST', 'Unknown sandbox endpoint')
        try:
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) != 1 or not lengths[0].isdigit() or int(lengths[0]) > MAX_BODY or self.headers.get('Transfer-Encoding') or self.headers.get('Expect'):
                raise ValueError('Invalid request framing')
            if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json': raise ValueError('Expected JSON')
            raw = self.rfile.read(int(lengths[0]))
            if len(raw) != int(lengths[0]): raise ValueError('Incomplete request')
            action, owner, args = request_body(raw)
        except (ValueError, UnicodeError, TimeoutError): return self.error(400, 'SANDBOX_REQUEST', 'Invalid sandbox request')
        try:
            if not getattr(self.server, 'enabled', lambda: True)():
                return self.error(503, 'SANDBOX_UNAVAILABLE', 'Local sandbox is disabled')
            result = self.server.runtime.dispatch(action, owner, args)
            self.reply(200, result)
        except self.server.sandbox_error as error:
            self.error(error.status, error.code, str(error))
        except Exception:
            self.error(503, 'SANDBOX_UNAVAILABLE', 'Local sandbox is unavailable')


def serve(cfg):
    if not read_policy(cfg['data']): raise ValueError('Local sandbox is disabled')
    for name in MODULES: trusted(Path(__file__).with_name(name))
    from sandbox_network import SandboxNetwork
    from sandbox_runtime import SandboxRuntime, SandboxError
    # Preserve only the installer-recorded upstream proxy policy. Workload
    # environments are separately constructed by SandboxRuntime.
    for key in PROXIES: os.environ.pop(key, None)
    os.environ.update(cfg['proxy_env']); os.environ['PATH'] = ENV['PATH']
    channel = prepare_channel(cfg['data'])
    state = STATE_ROOT / cfg['installation']; trusted(state, True)
    lock_path = state / 'daemon.lock'
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        network = SandboxNetwork(installation=cfg['installation'])
        runtime = SandboxRuntime(image=IMAGE, installation=cfg['installation'], network=network)
        stopping = threading.Event()
        path = channel / 'sandbox.sock'
        try:
            runtime.recover()
            if path.exists() or path.is_symlink():
                if not stat.S_ISSOCK(path.lstat().st_mode): raise ValueError('Unexpected sandbox socket path')
                path.unlink()
            with Server(str(path), Handler) as server:
                path.chmod(0o660); os.chown(path, 0, 1000)
                server.runtime, server.sandbox_error = runtime, SandboxError
                server.enabled = lambda: read_policy(cfg['data'])
                def shutdown(signum, frame):
                    stopping.set(); threading.Thread(target=server.shutdown, daemon=True).start()
                for signum in (signal.SIGTERM, signal.SIGINT): signal.signal(signum, shutdown)
                def sweep():
                    while not stopping.wait(30):
                        try: runtime.sweep()
                        except Exception: print('Sandbox sweep unavailable; cleanup will retry.', file=sys.stderr)
                threading.Thread(target=sweep, daemon=True).start()
                def policy_watch():
                    while not stopping.wait(1):
                        try: enabled = read_policy(cfg['data'])
                        except Exception: enabled = False
                        if not enabled:
                            stopping.set(); server.shutdown(); return
                threading.Thread(target=policy_watch, daemon=True).start()
                server.serve_forever(poll_interval=0.5)
        finally:
            stopping.set()
            try: runtime.close()
            finally:
                network.close()
                if path.exists() and stat.S_ISSOCK(path.lstat().st_mode): path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('serve', 'enable-sandbox', 'disable-sandbox', 'sandbox-status', 'sandbox-foreground'))
    parser.add_argument('--source', type=Path); parser.add_argument('--data', type=Path); parser.add_argument('--project')
    parser.add_argument('--config', type=Path)
    args = parser.parse_args(); os.umask(0o077)
    try:
        if os.geteuid() != 0: raise ValueError('Host sandbox requires root')
        if args.action == 'serve':
            if not args.config: raise ValueError('A trusted configuration is required')
            serve(load_config(args.config)); return 0
        if not args.data or not args.source: raise ValueError('Source and deployment directory are required')
        return setup(args.action, args.source, args.data)
    except Exception as error:
        # Do not echo config values: upstream proxy URLs can contain credentials.
        if isinstance(error, ValueError): print('Host sandbox error: ' + str(error), file=sys.stderr)
        else: print('Host sandbox unavailable; inspect trusted installation and Docker readiness.', file=sys.stderr)
        return 1


if __name__ == '__main__': sys.exit(main())
