"""Installation-scoped Docker runtime. Request text executes only inside code containers."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import uuid

from sandbox_files import _parts, FileError


class SandboxError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.status = code, status


PROXY_KEYS = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
              'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')
LABEL = 'io.codex-agent-platform.sandbox'
FILES_PROGRAM = Path(__file__).with_name('sandbox_files.py').read_text()
# The cgroup check is run inside the actual workload boundary, not inferred from CLI success.
VERIFY_PROGRAM = '''import os,json,pathlib
p=pathlib.Path('/sys/fs/cgroup')
if (p/'memory.max').exists():
 memory=(p/'memory.max').read_text().strip(); pids=(p/'pids.max').read_text().strip(); cpu=(p/'cpu.max').read_text().split()
else:
 memory=(p/'memory/memory.limit_in_bytes').read_text().strip(); pids=(p/'pids/pids.max').read_text().strip(); cpu=[(p/'cpu/cpu.cfs_quota_us').read_text().strip(),(p/'cpu/cpu.cfs_period_us').read_text().strip()]
assert os.getuid()==1000 and int(memory)==1073741824 and int(pids)==128 and int(cpu[0])==int(cpu[1])
mounts=pathlib.Path('/proc/mounts').read_text().splitlines()
for target,size in [('/workspace',268435456),('/tmp',67108864)]:
 line=next(x.split() for x in mounts if x.split()[1]==target)
 assert line[2]=='tmpfs' and os.statvfs(target).f_blocks*os.statvfs(target).f_frsize<=size
assert next(x.split() for x in mounts if x.split()[1]=='/')[3].split(',').count('ro')==1
print('verified')'''
PIDS_PROGRAM = "import os,json; print(json.dumps(sorted(int(x) for x in os.listdir('/proc') if x.isdigit() and int(x)!=os.getpid())))"


class SandboxRuntime:
    def __init__(self, image='codex-agent-platform-sandbox:1.0.2', installation='default', network=None, docker_command=None):
        if not isinstance(installation, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', installation):
            raise ValueError('Invalid installation identifier')
        self.image, self.installation, self.network = image, installation, network
        self.docker_command = list(docker_command) if docker_command else ['docker', '--host=unix:///var/run/docker.sock']
        self.environment = {k: v for k, v in os.environ.items() if k not in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
        self.owners = {}
        self.lock = threading.RLock()  # Catalog only; never held across subprocess/network I/O.
        self.capacity_lock = threading.RLock()
        self.lifecycle_lock = threading.RLock()
        self.recovering = False
        self.closed = False
        self.ready = False

    def _docker(self, args, *, data=None, timeout=30, check=True):
        try:
            result = subprocess.run(self.docker_command + args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.environment, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SandboxError('SANDBOX_UNAVAILABLE', 'Local code runtime is unavailable', 503) from error
        if check and result.returncode:
            raise SandboxError('SANDBOX_UNAVAILABLE', 'Local code runtime rejected the operation', 503)
        return result

    def _readiness(self):
        if self.ready:
            return
        result = self._docker(['info', '--format', '{{json .}}'])
        try:
            info = json.loads(result.stdout)
            if info.get('OSType') != 'linux' or not info.get('CgroupDriver') or info.get('CgroupVersion') not in ('1', '2'):
                raise ValueError()
            if any(re.search(r'(memory|cpu|pids|swap).*limit', x, re.I) for x in (info.get('Warnings') or [])):
                raise ValueError()
            self._docker(['image', 'inspect', self.image])
        except (ValueError, TypeError):
            raise SandboxError('SANDBOX_UNAVAILABLE', 'Required container resource controls are unavailable', 503) from None
        self.ready = True

    def _owner(self, owner):
        if not isinstance(owner, str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', owner):
            raise SandboxError('SANDBOX_SCOPE', 'Invalid conversation identity')
        with self.lock:
            return self.owners.setdefault(owner, {'instance_id': None, 'revision': 0, 'name': None, 'last_used': time.monotonic(), 'jobs': {}, 'keys': {}, 'baseline': set(), 'unhealthy': False, '_lock': threading.RLock()})

    def _states(self):
        with self.lock:
            return list(self.owners.values())

    def _accepting(self):
        with self.lock:
            if self.closed or self.recovering:
                raise SandboxError('SANDBOX_UNAVAILABLE', 'Local code runtime is closed or recovering', 503)

    def _public(self, job):
        return {key: copy.deepcopy(value) for key, value in job.copy().items() if not key.startswith('_')}

    def _summary(self, job):
        value = self._public(job)
        for stream in ('stdout', 'stderr'):
            with job.get('_output_lock', threading.RLock()):
                data = bytes(job['_' + stream]) if job['status'] == 'running' and '_' + stream in job else value[stream].encode('utf-8')
            value[stream] = data[:2048].decode('utf-8', errors='ignore')
            value[stream + '_truncated'] = len(data) > 2048
        return value

    def _active(self, state):
        return next((j for j in state['jobs'].values() if j['status'] == 'running'), None)

    def _idle(self, state):
        if self._active(state):
            raise SandboxError('SANDBOX_BUSY', 'The conversation already has a running command', 409)
        if state['unhealthy']:
            raise SandboxError('SANDBOX_UNAVAILABLE', 'Sandbox cleanup is unconfirmed', 503)

    def _remove(self, state, expected_name=None):
        name = expected_name or state['name']
        if not name:
            return
        # Mark first: a timeout/transport exception leaves the instance quarantined.
        if state['name'] == name:
            state['unhealthy'] = True
        result = self._docker(['rm', '--force', name], check=False)
        if result.returncode:
            # A transport error is not evidence the workload stopped.
            probe = self._docker(['ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.Names}}'], check=False)
            if probe.returncode or probe.stdout.strip():
                if state['name'] == name:
                    state['unhealthy'] = True
                raise SandboxError('SANDBOX_STOP_UNKNOWN', 'Container removal could not be confirmed', 503)
        if state['name'] == name:
            state.update(instance_id=None, name=None, baseline=set(), unhealthy=False, revision=state['revision'] + 1)

    def _pids(self, state, name=None):
        result = self._docker(['exec', name or state['name'], 'python3', '-I', '-S', '-c', PIDS_PROGRAM])
        return set(json.loads(result.stdout))

    def _ensure(self, state):
        self._idle(state)
        if state['name']:
            state['last_used'] = time.monotonic()
            return
        with self.capacity_lock:
            self._accepting()
            self._readiness()
            self.sweep()
            live = [s for s in self._states() if s['name']]
            if len(live) >= 2:
                evicted = False
                for candidate in sorted(live, key=lambda s: s['last_used']):
                    # Another admission may own this lock while waiting for capacity.
                    # Never invert owner/capacity lock order by waiting for it.
                    if not candidate['_lock'].acquire(blocking=False):
                        continue
                    try:
                        if candidate['name'] and not self._active(candidate):
                            self._remove(candidate)
                            evicted = True
                            break
                    finally:
                        candidate['_lock'].release()
                if not evicted:
                    raise SandboxError('SANDBOX_CAPACITY', 'Both local sandboxes are busy', 409)
            instance = str(uuid.uuid4())
            name = 'cap-sandbox-' + hashlib.sha256(self.installation.encode()).hexdigest()[:12] + '-' + instance
            args = ['run', '--detach', '--name', name, '--label', LABEL + '=' + self.installation,
                    '--network', 'none', '--read-only', '--user', '1000:1000', '--init', '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges:true', '--cpus', '1', '--memory', '1g', '--memory-swap', '1g',
                    '--pids-limit', '128', '--tmpfs', '/workspace:rw,nosuid,nodev,size=256m,nr_inodes=10000,uid=1000,gid=1000,mode=0700',
                    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,nr_inodes=10000,uid=1000,gid=1000,mode=0700',
                    '--workdir', '/workspace', '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2']
            for key in PROXY_KEYS:
                args += ['--env', key + '=']
            args += ['--env', 'HOME=/workspace', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'MPLCONFIGDIR=/tmp/matplotlib',
                     '--entrypoint', 'python3', self.image, '-c', 'import signal; signal.pause()']
            try:
                self._docker(args)
                state.update(name=name, instance_id=instance, revision=state['revision'] + 1)
                self._docker(['exec', name, 'python3', '-I', '-S', '-c', VERIFY_PROGRAM])
                state['baseline'] = self._pids(state)
                state['last_used'] = time.monotonic()
            except BaseException:
                if not state['name']:
                    state.update(name=name, instance_id=instance)
                self._remove(state)
                raise

    def _limits(self, args):
        timeout = args.get('timeout_seconds', 60)
        memory = args.get('memory_mb', 1024)
        if type(timeout) is not int or not 1 <= timeout <= 600 or type(memory) is not int or not 1 <= memory <= 2048:
            raise SandboxError('SANDBOX_LIMIT', 'Requested limits exceed deployment maximum')
        if not args.get('grant') and (timeout > 120 or memory > 1024):
            raise SandboxError('SANDBOX_PERMISSION', 'The requested limits require approval', 403)
        return timeout, memory

    def _execution(self, state, args):
        key, command, cwd = args.get('request_key'), args.get('command'), args.get('cwd', '.')
        if not isinstance(key, str) or not 1 <= len(key) <= 128 or not isinstance(command, str) or not 1 <= len(command) <= 20000 or '\x00' in command:
            raise SandboxError('SANDBOX_ARGUMENT', 'A bounded request key and command are required')
        try:
            parts = _parts(cwd, True)
            if cwd.startswith('/'):
                raise FileError('Working directory must be relative')
        except (FileError, AttributeError):
            raise SandboxError('SANDBOX_PATH', 'Working directory must be a relative workspace path') from None
        timeout, memory = self._limits(args)
        fingerprint = hashlib.sha256(json.dumps([command, cwd, timeout, memory], separators=(',', ':')).encode()).hexdigest()
        previous = state['keys'].get(key)
        if previous:
            if previous['fingerprint'] != fingerprint:
                raise SandboxError('SANDBOX_REQUEST_CONFLICT', 'Request key already belongs to another command', 409)
            job = previous.get('job')
            if job:
                return self._public(job)
            raise SandboxError('SANDBOX_REQUEST_UNKNOWN', 'Previous admission had an unknown effect and cannot be replayed', 409)
        self._idle(state)
        if len(state['keys']) >= 4096:
            raise SandboxError('SANDBOX_CAPACITY', 'Conversation command history is full', 409)
        state['keys'][key] = {'fingerprint': fingerprint}
        self._ensure(state)
        grant = args.get('grant')
        domains = []
        if grant is not None:
            expected = dict(request_key=key, instance_id=state['instance_id'], revision=state['revision'], command=command, cwd=cwd, timeout_seconds=timeout, memory_mb=memory)
            if not isinstance(grant, dict) or not isinstance(grant.get('id'), str) or not grant['id'] or any(grant.get(k) != v for k, v in expected.items()) or type(grant.get('expires_at')) not in (int, float) or not time.time() * 1000 < grant['expires_at'] <= time.time() * 1000 + 600001:
                raise SandboxError('SANDBOX_PERMISSION', 'Approval is expired or no longer matches this sandbox', 403)
            domains = grant.get('domains', [])
            if not isinstance(domains, list) or len(domains) > 32 or any(not isinstance(x, str) for x in domains):
                raise SandboxError('SANDBOX_PERMISSION', 'Invalid approved destinations', 403)
            if domains and (not self.network or not self.network.available()):
                raise SandboxError('SANDBOX_NETWORK_UNAVAILABLE', 'Restricted networking is unavailable', 503)
        # CPU/memory/pid verification was performed on the actual container. Updates remain bounded.
        self._docker(['update', '--memory', str(memory) + 'm', '--memory-swap', str(memory) + 'm', state['name']])
        handle = None
        deadline = int(time.time() * 1000 + timeout * 1000)
        try:
            if domains:
                handle = self.network.enable(state['name'], domains, deadline)
            env = dict.fromkeys(PROXY_KEYS, '')
            if handle:
                for k, v in handle.get('environment', {}).items():
                    if k in env and isinstance(v, str) and '\x00' not in v:
                        env[k] = v
            docker_args = ['exec', '--workdir', '/workspace' + ('/' + '/'.join(parts) if parts else '')]
            for k, v in env.items():
                docker_args += ['--env', k + '=' + v]
            docker_args += [state['name'], '/bin/sh', '-c', command]
            process = subprocess.Popen(self.docker_command + docker_args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.environment)
        except BaseException:
            if handle:
                self.network.disable(handle)
            self._remove(state)
            raise
        state['revision'] += 1
        job = dict(execution_id=str(uuid.uuid4()), request_key=key, instance_id=state['instance_id'], status='running', stdout='', stderr='', exit_code=None,
                   created_at=int(time.time() * 1000), timeout_seconds=timeout, memory_mb=memory,
                   _process=process, _network=handle, _deadline=time.monotonic() + timeout, _stop=None, _stdout=bytearray(), _stderr=bytearray(),
                   _container_name=state['name'], _baseline=set(state['baseline']), _stop_lock=threading.RLock(), _output_lock=threading.RLock())
        timer = threading.Timer(timeout, self._stop_job, args=(state, job, 'timeout'))
        timer.daemon = True
        thread = threading.Thread(target=self._watch, args=(state, job), daemon=True)
        job.update(_timer=timer, _thread=thread)
        # Publish only after every control needed by concurrent cancellation exists.
        state['jobs'][job['execution_id']] = job
        state['keys'][key]['job'] = job
        while len(state['jobs']) > 16:
            oldest = next(iter(state['jobs']))
            retired = state['jobs'].pop(oldest)
            # Preserve the admission tombstone, not unbounded historical output.
            state['keys'][retired['request_key']].pop('job', None)
        timer.start()
        thread.start()
        return self._public(job)

    def _disable(self, job):
        handle = job.get('_network')
        if handle:
            self.network.disable(handle)
            job['_network'] = None

    def _stop_job(self, state, job, reason):
        # This path never needs a catalog/owner/capacity lock. Deadline and human
        # cancellation cannot wait behind readiness, file transfers or final probes.
        with job['_stop_lock']:
            if job['status'] != 'running' or job['_stop']:
                return
            job['_stop'] = reason
            errors = []
            try:
                if state['name'] == job['_container_name']:
                    self._remove(state, expected_name=job['_container_name'])
            except Exception as error:
                errors.append(error)
            # Stop the workload first: network teardown itself can involve slow RPCs.
            try:
                self._disable(job)
            except Exception as error:
                errors.append(error)
            if errors:
                job['_stop'] = 'unknown'
            if job['_process'].poll() is None:
                try:
                    job['_process'].kill()  # Only the local Docker client, after removal attempt.
                except ProcessLookupError:
                    pass

    def _output(self, job):
        with job['_output_lock']:
            return {stream: bytes(job['_' + stream]).decode('utf-8', errors='replace') for stream in ('stdout', 'stderr')}

    def _process_job(self, state, args):
        key = args.get('execution_id')
        jobs = state['jobs'].copy()
        job = jobs.get(key) if key else next(reversed(jobs.values()), None)
        if not job:
            raise SandboxError('SANDBOX_NOT_FOUND', 'Execution does not belong to this conversation', 404)
        if args.get('action', 'status') not in ('status', 'cancel'):
            raise SandboxError('SANDBOX_ARGUMENT', 'Unknown process action')
        if args.get('action') == 'cancel' and job['status'] == 'running':
            self._stop_job(state, job, 'cancelled')
            with job['_stop_lock']:
                if job['_stop'] == 'unknown':
                    raise SandboxError('SANDBOX_STOP_UNKNOWN', 'Workload cancellation is unconfirmed', 503)
                if job['status'] == 'running':
                    status = 'cancelled' if job['_stop'] == 'cancelled' else 'failed'
                    job.update(status=status, reason=job['_stop'] + '_workspace_lost', completed_at=int(time.time() * 1000), **self._output(job))
                    job['_timer'].cancel()
        public = self._public(job)
        if job['status'] == 'running':
            public.update(self._output(job))
        return public

    def _destroy_state(self, state):
        current = self._active(state)
        if current:
            self._process_job(state, {'action': 'cancel', 'execution_id': current['execution_id']})
        self._remove(state)

    def _watch(self, state, job):
        def drain(stream, field):
            try:
                while True:
                    chunk = os.read(stream.fileno(), 8192)
                    if not chunk:
                        break
                    with job['_output_lock']:
                        room = 65536 - len(job[field])
                        job[field].extend(chunk[:room])
            finally:
                stream.close()
        process = job['_process']
        readers = [threading.Thread(target=drain, args=(process.stdout, '_stdout'), daemon=True), threading.Thread(target=drain, args=(process.stderr, '_stderr'), daemon=True)]
        for thread in readers:
            thread.start()
        process.wait()
        for thread in readers:
            thread.join(timeout=5)
        status, reason = 'completed' if process.returncode == 0 else 'failed', None
        try:
            self._disable(job)
            if not job['_stop'] and job['status'] == 'running' and state['name'] == job['_container_name']:
                details = json.loads(self._docker(['inspect', job['_container_name']]).stdout)[0]
                if details.get('State', {}).get('OOMKilled') or not details.get('State', {}).get('Running') or process.returncode == 137:
                    oom = details.get('State', {}).get('OOMKilled')
                    self._remove(state, expected_name=job['_container_name'])
                    reason, status = 'oom_workspace_lost' if oom else 'container_stopped_workspace_lost', 'failed'
                elif self._pids(state, job['_container_name']) != job['_baseline']:
                    self._remove(state, expected_name=job['_container_name'])
                    reason, status = 'descendants_workspace_lost', 'failed'
                else:
                    self._docker(['update', '--memory', '1g', '--memory-swap', '1g', job['_container_name']])
        except Exception:
            try:
                if state['name'] == job['_container_name']:
                    self._remove(state, expected_name=job['_container_name'])
                self._disable(job)
                status, reason = 'failed', 'runtime_error_workspace_lost'
            except Exception:
                status, reason = 'unknown', 'cleanup_unconfirmed'
        with job['_stop_lock']:
            job['_timer'].cancel()
            if job['status'] != 'running':
                job.update(**self._output(job))
                return
            if job['_stop']:
                reason = job['_stop'] + '_workspace_lost'
                status = 'cancelled' if job['_stop'] == 'cancelled' else 'failed' if job['_stop'] == 'timeout' else 'unknown'
            job.update(status=status, reason=reason, exit_code=process.returncode if status in ('completed', 'failed') and not job['_stop'] else None,
                       completed_at=int(time.time() * 1000), **self._output(job))
            state['last_used'] = time.monotonic()

    def dispatch(self, action, conversation_id=None, args=None):
        args = {} if args is None else args
        if not isinstance(args, dict):
            raise SandboxError('SANDBOX_ARGUMENT', 'Arguments must be an object')
        if action == 'recover':
            return self.recover()
        self._accepting()
        state = self._owner(conversation_id)
        if action == 'context':
            try:
                self._readiness()
                available = True
            except SandboxError:
                available = False
            network_supported = bool(self.network and self.network.available())
            with state['_lock']:
                self._accepting()
                jobs = list(state['jobs'].values())[-16:]
                result = dict(available=available, exists=bool(state['name']), instance_id=state['instance_id'], revision=state['revision'], network_supported=network_supported,
                              limits=dict(timeout_seconds=120, memory_mb=1024, max_timeout_seconds=600, max_memory_mb=2048), executions=[self._summary(j) for j in jobs])
            if not available:
                result['reason'] = 'Local code runtime or fixed image is unavailable'
            return result
        if action == 'process':
            return self._process_job(state, args)
        with state['_lock']:
            self._accepting()
            if action == 'exec':
                return self._execution(state, args)
            if action == 'destroy':
                self._destroy_state(state)
                return {'destroyed': True}
            if action in ('files', 'export'):
                self._idle(state)
                self._ensure(state)
                if action == 'files' and args.get('action') == 'ensure':
                    return {'instance_id': state['instance_id'], 'revision': state['revision']}
                file_args = dict(args) if action == 'files' else {'action': 'export', 'path': args.get('path')}
                try:
                    _parts(file_args.get('path'), file_args.get('action') == 'list')
                except FileError:
                    raise SandboxError('SANDBOX_PATH', 'Invalid workspace path') from None
                if file_args.get('action') in ('write', 'import', 'delete'):
                    expected = file_args.get('expected_revision')
                    if expected is not None and (type(expected) is not int or expected != state['revision']):
                        raise SandboxError('SANDBOX_REVISION', 'Workspace revision changed', 409)
                    # Even an ambiguous or failed mutation must invalidate unused approval.
                    state['revision'] += 1
                result = self._docker(['exec', '-i', state['name'], 'python3', '-I', '-S', '-c', FILES_PROGRAM], data=json.dumps(file_args).encode(), check=False)
                try:
                    value = json.loads(result.stdout)
                except ValueError:
                    raise SandboxError('SANDBOX_UNAVAILABLE', 'Sandbox file operation failed', 503) from None
                if result.returncode or value.get('error'):
                    raise SandboxError('SANDBOX_FILE', value.get('error', 'Sandbox file operation failed'))
                state['last_used'] = time.monotonic()
                return dict(value, instance_id=state['instance_id'], revision=state['revision'])
            raise SandboxError('SANDBOX_ARGUMENT', 'Unknown sandbox action')

    def sweep(self):
        removed = 0
        for state in self._states():
            if not state['_lock'].acquire(blocking=False):
                continue
            try:
                if state['name'] and not self._active(state) and time.monotonic() - state['last_used'] >= 1800:
                    self._remove(state)
                    removed += 1
            finally:
                state['_lock'].release()
        return {'removed': removed}

    def recover(self):
        with self.lifecycle_lock:
            with self.lock:
                self.recovering = True
            try:
                # Drain any in-flight creation, then release capacity before
                # acquiring owner locks (admission acquires those in reverse order).
                with self.capacity_lock:
                    pass
                for state in self._states():
                    with state['_lock']:
                        self._destroy_state(state)
                result = self._docker(['ps', '-aq', '--filter', 'label=' + LABEL + '=' + self.installation])
                ids = result.stdout.decode().split()
                if any(not re.fullmatch(r'[0-9a-f]{12,64}', item) for item in ids):
                    raise SandboxError('SANDBOX_UNAVAILABLE', 'Invalid container recovery result', 503)
                if ids:
                    self._docker(['rm', '--force'] + ids)
                if self.network:
                    self.network.recover()
                self.ready = False
                return {'recovered': True, 'removed': len(ids)}
            finally:
                with self.lock:
                    self.recovering = False

    def close(self):
        with self.lifecycle_lock:
            with self.lock:
                if self.closed:
                    return
                self.recovering = True
            try:
                # Drain any in-flight creation, then release capacity before
                # acquiring owner locks (admission acquires those in reverse order).
                with self.capacity_lock:
                    pass
                for state in self._states():
                    with state['_lock']:
                        self._destroy_state(state)
                if self.network:
                    self.network.close()
            finally:
                with self.lock:
                    self.closed = True
                    self.recovering = False
