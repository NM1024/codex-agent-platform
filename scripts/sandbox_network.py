"""Installation-owned, fail-closed, short-lived sandbox HTTP(S) egress.

CONNECT is opaque. Domain/port/address/deadline limits apply to every tunnel;
this module makes no claim to filter the contents of encrypted connections.
"""
import hashlib
import ipaddress
import json
import math
import os
import re
import select
import socket
import socketserver
import subprocess
import threading
import time
import uuid
from urllib.parse import urlsplit


class NetworkDenied(RuntimeError):
    pass


def canonical_domain(value):
    if not isinstance(value, str) or not value or value != value.strip() or value.endswith('.'):
        raise NetworkDenied('A canonical domain is required')
    try:
        host = value.encode('idna').decode('ascii').lower()
    except UnicodeError as exc:
        raise NetworkDenied('Invalid domain') from exc
    if len(host) > 253 or not re.fullmatch(r'[a-z0-9-]+(?:\.[a-z0-9-]+)+', host):
        raise NetworkDenied('Only named domains are permitted')
    if any(len(label) > 63 or label.startswith('-') or label.endswith('-') for label in host.split('.')):
        raise NetworkDenied('Invalid domain label')
    # Also reject legacy numeric IPv4 spellings accepted by libc/browser resolvers.
    if not re.search(r'[a-z]', host.split('.')[-1]) or host.split('.')[-1].startswith('0x'):
        raise NetworkDenied('IP literals are not permitted')
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return host
    raise NetworkDenied('IP literals are not permitted')


def _resolve(host, port):
    return [item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]


def public_addresses(host, resolver=_resolve, port=443, denied_addresses=(), denied_networks=()):
    try:
        values = resolver(canonical_domain(host), port)
        addresses = list(dict.fromkeys(str(ipaddress.ip_address(item)) for item in values))
    except (OSError, ValueError, TypeError) as exc:
        raise NetworkDenied('Target resolution failed') from exc
    if not addresses:
        raise NetworkDenied('Target has no public addresses')
    networks = [ipaddress.ip_network(value, strict=False) for value in denied_networks]
    for value in addresses:
        address = ipaddress.ip_address(value)
        # IPv4-mapped and transition forms can encode otherwise blocked destinations.
        if (value in denied_addresses or any(address in network for network in networks) or not address.is_global or address.is_reserved or address.is_multicast or address.is_unspecified
                or getattr(address, 'scope_id', None) is not None
                or getattr(address, 'ipv4_mapped', None) is not None
                or getattr(address, 'sixtofour', None) is not None
                or getattr(address, 'teredo', None) is not None):
            raise NetworkDenied('Non-public target denied')
    return addresses


def _dial(address, port, register):
    # Numeric address only: no second DNS lookup after validation.
    family = socket.AF_INET6 if ':' in address else socket.AF_INET
    conn = socket.socket(family, socket.SOCK_STREAM)
    conn.settimeout(5)
    try:
        register(conn)
        conn.connect((address, port))
        return conn
    except BaseException:
        conn.close()
        raise


def _stop(conn):
    try:
        conn.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        conn.close()
    except OSError:
        pass


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    block_on_close = False

    def __init__(self, *args, **kwargs):
        self._slots = threading.BoundedSemaphore(64)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class GuardedProxy:
    """One installation-local listener; grants are selected only by kernel peer IP.

    Resolver/dial dependencies allow synthetic loopback fixtures without weakening
    the production address validation or requiring public Internet access.
    """
    def __init__(self, host, port=0, *, resolver=_resolve, dial=_dial, denied_addresses=(), destination_policy=None):
        self.resolver, self.dial = resolver, dial
        self.denied_addresses = frozenset(denied_addresses)
        self.destination_policy = destination_policy
        self._lock = threading.RLock()
        self._grants, self._sockets = {}, {}
        self._closed = threading.Event()
        owner = self
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                owner._serve(self.request, self.client_address[0])
        self._server = _Server((host, port), Handler)
        self.address = self._server.server_address
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={'poll_interval': .05}, daemon=True)
        self._thread.start()
        self._watcher = threading.Thread(target=self._expire, daemon=True)
        self._watcher.start()

    def grant(self, peer, job, domains, deadline_ms):
        allowed = frozenset(canonical_domain(domain) for domain in domains)
        if (not allowed or len(allowed) > 32 or not isinstance(deadline_ms, (int,float))
                or not math.isfinite(deadline_ms) or not time.time()*1000 < deadline_ms <= time.time()*1000 + 600000):
            raise NetworkDenied('Invalid or expired network grant')
        with self._lock:
            if self._closed.is_set() or peer in self._grants or job in self._sockets:
                raise NetworkDenied('Peer already has a grant or proxy is closed')
            self._grants[peer] = (job, allowed, deadline_ms)
            self._sockets[job] = set()

    def revoke(self, job):
        with self._lock:
            self._grants = {peer: grant for peer, grant in self._grants.items() if grant[0] != job}
            connections = self._sockets.pop(job, set())
            for conn in connections:
                _stop(conn)

    def _expire(self):
        while not self._closed.wait(.025):
            with self._lock:
                expired = [g[0] for g in self._grants.values() if g[2] <= time.time() * 1000]
            for job in expired:
                self.revoke(job)

    def _register(self, peer, grant, conn):
        with self._lock:
            if self._grants.get(peer) != grant or grant[2] <= time.time() * 1000:
                _stop(conn)
                raise NetworkDenied('Grant expired or revoked')
            self._sockets[grant[0]].add(conn)

    def _serve(self, client, peer):
        target = None
        grant = None
        try:
            with self._lock:
                grant = self._grants.get(peer)
            if not grant:
                raise NetworkDenied('No active peer grant')
            self._register(peer, grant, client)
            client.settimeout(min(5, max(.01, grant[2] / 1000 - time.time())))
            data = b''
            while b'\r\n\r\n' not in data:
                chunk = client.recv(4096)
                if not chunk:
                    return
                data += chunk
                if len(data) > 32768:
                    raise NetworkDenied('Request headers too large')
            header, body = data.split(b'\r\n\r\n', 1)
            lines = header.decode('ascii').split('\r\n')
            method, uri, version = lines[0].split(' ')
            if not re.fullmatch(r'[A-Z]+', method) or version not in ('HTTP/1.0', 'HTTP/1.1'):
                raise NetworkDenied('Malformed proxy request')
            headers = []
            for line in lines[1:]:
                if not line or line[0].isspace() or ':' not in line:
                    raise NetworkDenied('Malformed header')
                key, value = line.split(':', 1)
                if not re.fullmatch(r'[!#$%&\'*+.^_`|~0-9A-Za-z-]+', key) or any(ord(c) < 32 or ord(c) == 127 for c in value):
                    raise NetworkDenied('Malformed header')
                headers.append((key.lower(), value.strip()))
            if method == 'CONNECT':
                if not re.fullmatch(r'[^:/@\[\]]+:(80|443)', uri):
                    raise NetworkDenied('CONNECT requires canonical host and port 80/443')
                raw_host, raw_port = uri.rsplit(':', 1)
                host, port = canonical_domain(raw_host), int(raw_port)
                if body:
                    raise NetworkDenied('Early CONNECT data denied')
            else:
                parsed = urlsplit(uri)
                if parsed.scheme != 'http' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
                    raise NetworkDenied('Only absolute HTTP targets are permitted')
                host, port = canonical_domain(parsed.hostname), parsed.port or 80
                if port not in (80, 443):
                    raise NetworkDenied('Only ports 80/443 are permitted')
                hosts = [value for key, value in headers if key == 'host']
                expected_host = host if port == 80 else f'{host}:{port}'
                if len(hosts) != 1 or hosts[0].lower() not in (expected_host, f'{host}:{port}'):
                    raise NetworkDenied('Host header does not match target')
                if any(key in ('transfer-encoding', 'upgrade', 'expect') for key, _ in headers):
                    raise NetworkDenied('Streaming request framing unsupported')
            if host not in grant[1]:
                raise NetworkDenied('Domain is outside this job grant')
            resolved = public_addresses(host, self.resolver, port)
            denied_addresses, denied_networks = self.destination_policy() if self.destination_policy else ((), ())
            addresses = public_addresses(host, lambda _host, _port: resolved, port, self.denied_addresses | frozenset(denied_addresses), denied_networks)
            # No re-resolution or alternative unchecked destination on failure.
            def register_target(conn):
                nonlocal target
                target = conn
                self._register(peer, grant, conn)
            target = self.dial(addresses[0], port, register_target)
            self._register(peer, grant, target)
            if method == 'CONNECT':
                client.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                self._relay(client, target, grant, bidirectional=True)
            else:
                lengths = [v for k,v in headers if k == 'content-length']
                if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]{1,9}', lengths[0])):
                    raise NetworkDenied('Invalid Content-Length')
                length = int(lengths[0]) if lengths else 0
                if length > 32 * 1024 * 1024 or len(body) > length:
                    raise NetworkDenied('Request body limit exceeded or pipelining denied')
                hop = {'connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer'}
                for key,value in headers:
                    if key == 'connection':
                        hop.update(token.strip().lower() for token in value.split(','))
                path = parsed.path or '/'
                if parsed.query:
                    path += '?' + parsed.query
                forwarded = f'{method} {path} HTTP/1.1\r\n'.encode('ascii')
                forwarded += b''.join(f'{k}: {v}\r\n'.encode('ascii') for k,v in headers if k not in hop)
                target.sendall(forwarded + b'Connection: close\r\n\r\n' + body)
                remaining = length - len(body)
                while remaining:
                    chunk = client.recv(min(65536, remaining))
                    if not chunk:
                        raise NetworkDenied('Incomplete request body')
                    target.sendall(chunk)
                    remaining -= len(chunk)
                target.shutdown(socket.SHUT_WR)
                self._relay(client, target, grant, bidirectional=False)
        except (NetworkDenied, OSError, ValueError, UnicodeError, subprocess.SubprocessError):
            try:
                client.sendall(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass
        finally:
            with self._lock:
                if grant and grant[0] in self._sockets:
                    self._sockets[grant[0]].discard(client)
                    self._sockets[grant[0]].discard(target)
            if target:
                _stop(target)
            _stop(client)

    def _relay(self, client, target, grant, *, bidirectional):
        readers = [client, target] if bidirectional else [target]
        while time.time() * 1000 < grant[2]:
            ready, _, _ = select.select(readers, [], [], .05)
            for source in ready:
                data = source.recv(65536)
                if not data:
                    return
                (target if source is client else client).sendall(data)

    def close(self):
        if self._closed.is_set():
            return
        self._closed.set()
        with self._lock:
            jobs = list(self._sockets)
        for job in jobs:
            self.revoke(job)
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)
        self._watcher.join(timeout=2)


class SandboxNetwork:
    def __init__(self, installation='default', docker_command=None, firewall_command='iptables', network_policy_file='/etc/codex/network-policy.json'):
        self.installation = installation
        self.docker = list(docker_command) if isinstance(docker_command, (list, tuple)) else [docker_command or 'docker', '--host=unix:///var/run/docker.sock']
        self.firewall = firewall_command
        self.network_policy_file = network_policy_file
        self._scope = hashlib.sha256(installation.encode()).hexdigest()[:10]
        self._prefix = 'sbx' + hashlib.sha256(installation.encode()).hexdigest()[:10]
        self._label = 'io.codex-agent-platform.sandbox=' + installation
        self._handles = {}
        self._lock = threading.RLock()
        self.reason = 'Network readiness has not been checked'
        self._host_addresses = set()

    def _run(self, command):
        environment = {key: value for key,value in os.environ.items() if key not in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH')}
        return subprocess.run(command, check=True, capture_output=True, text=True, timeout=15, env=environment).stdout

    def _docker(self, *args):
        return self._run(self.docker + list(args))

    def _fw(self, family, *args):
        return self._run([self.firewall if family == 4 else 'ip6tables', '-w', '3'] + list(args))

    def _protected_destinations(self):
        # A container network may legitimately use globally classified IPAM.
        # Proxy sockets originate on the host, so bridge INPUT/FORWARD rules
        # alone cannot prevent a proxy request reaching those other containers.
        addresses = json.loads(self._run(['ip', '-json', 'address', 'show']))
        host_addresses = {str(ipaddress.ip_address(item['local'])) for interface in addresses for item in interface.get('addr_info', [])}
        identifiers = self._docker('network','ls','--format','{{.ID}}').splitlines()
        if any(not re.fullmatch(r'[0-9a-f]{12,64}', value) for value in identifiers):
            raise NetworkDenied('Docker network destination policy is unavailable')
        networks = json.loads(self._docker('network','inspect',*identifiers)) if identifiers else []
        subnets = []
        for network in networks:
            for entry in network.get('IPAM',{}).get('Config') or []:
                if entry.get('Subnet'):
                    subnets.append(ipaddress.ip_network(entry['Subnet'], strict=False))
            for endpoint in (network.get('Containers') or {}).values():
                for key in ('IPv4Address','IPv6Address'):
                    if endpoint.get(key):
                        host_addresses.add(str(ipaddress.ip_interface(endpoint[key]).ip))
        return host_addresses, subnets

    def available(self):
        # Standard upstream proxies resolve the hostname again. Forwarding an IP
        # instead loses upstream hostname policy. Neither is a safe fallback.
        policy_proxy = False
        if os.path.exists(self.network_policy_file):
            try:
                with open(self.network_policy_file, encoding='utf-8') as policy_file:
                    policy = json.load(policy_file)
                if policy.get('version') != 1:
                    raise ValueError('Unsupported network policy')
                policy_proxy = bool(policy.get('http_proxy') or policy.get('http_network_policy'))
            except (OSError, ValueError, TypeError, AttributeError):
                self.reason = 'Managed network policy readiness is unavailable'
                return False
        if policy_proxy or any(value for key,value in os.environ.items() if key.lower() in ('http_proxy','https_proxy','all_proxy')):
            self.reason = 'Configured upstream proxy cannot enforce hostname policy with validated destination IP pinning'
            return False
        try:
            for family in (4,6):
                for chain in ('INPUT','FORWARD'):
                    self._fw(family, '-L', chain, '-n')
            self._host_addresses, _ = self._protected_destinations()
            info = json.loads(self._docker('info', '--format', '{{json .}}'))
            if info.get('OSType') != 'linux' or any('rootless' in option for option in info.get('SecurityOptions', [])):
                raise NetworkDenied('Rootful Linux Docker is required')
        except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError, NetworkDenied):
            self.reason = 'Required Docker bridge or IPv4/IPv6 host firewall enforcement is unavailable'
            return False
        self.reason = ''
        return True

    def _rules(self, handle):
        bridge = handle['bridge']
        for family in (4,6):
            for chain in (handle['chain'], handle['forward_chain']):
                self._fw(family, '-N', chain)
                handle['chains'].append((family, chain))
            if family == 4:
                self._fw(family, '-A', handle['chain'], '-d', handle['gateway'], '-p', 'tcp', '--dport', str(handle['proxy'].address[1]), '-j', 'ACCEPT')
            self._fw(family, '-A', handle['chain'], '-j', 'DROP')
            self._fw(family, '-A', handle['forward_chain'], '-j', 'DROP')
            # First INPUT rule overrides pre-existing established/host accepts.
            self._fw(family, '-I', 'INPUT', '1', '-i', bridge, '-j', handle['chain'])
            handle['hooks'].append((family, ['INPUT', '-i', bridge, '-j', handle['chain']]))
            for direction in ('-i','-o'):
                self._fw(family, '-I', 'FORWARD', '1', direction, bridge, '-j', handle['forward_chain'])
                handle['hooks'].append((family, ['FORWARD', direction, bridge, '-j', handle['forward_chain']]))

    def enable(self, container_name, domains, deadline_ms):
        with self._lock:
            if not self.available():
                raise NetworkDenied(self.reason)
            allowed = [canonical_domain(domain) for domain in domains]
            if (not allowed or len(allowed) > 32 or not isinstance(deadline_ms, (int,float))
                    or not math.isfinite(deadline_ms) or not time.time()*1000 < deadline_ms <= time.time()*1000 + 600000):
                raise NetworkDenied('Invalid network grant')
            metadata = json.loads(self._docker('inspect', container_name))[0]
            labels = metadata.get('Config',{}).get('Labels',{})
            if labels.get('io.codex-agent-platform.sandbox') != self.installation:
                raise NetworkDenied('Container does not belong to this installation')
            if metadata.get('NetworkSettings',{}).get('Networks'):
                # --network none is represented by Docker's special none network.
                networks = metadata['NetworkSettings']['Networks']
                if set(networks) != {'none'}:
                    raise NetworkDenied('Container is already attached to another network')
            suffix = uuid.uuid4().hex[:8]
            handle = {'id': suffix, 'container': container_name, 'network': self._prefix+'-'+suffix,
                      'chain': ('SBXI'+self._scope+suffix).upper(), 'forward_chain': ('SBXF'+self._scope+suffix).upper(), 'bridge': 's'+uuid.uuid4().hex[:13],
                      'hooks': [], 'chains': [], 'proxy': None, 'created': False, 'connected': False}
            self._handles[suffix] = handle
            try:
                self._docker('network','create','--internal','--driver','bridge','--label',self._label,
                             '--label','platform.sandbox.network=true','--opt','com.docker.network.bridge.name='+handle['bridge'],handle['network'])
                handle['created'] = True
                network = json.loads(self._docker('network','inspect',handle['network']))[0]
                if not network.get('Internal') or network.get('EnableIPv6'):
                    raise NetworkDenied('Unsafe network configuration')
                gateways = [item.get('Gateway') for item in network['IPAM']['Config'] if item.get('Gateway')]
                if len(gateways) != 1:
                    raise NetworkDenied('No unique bridge gateway')
                handle['gateway'] = gateways[0]
                handle['proxy'] = GuardedProxy(handle['gateway'], denied_addresses=self._host_addresses, destination_policy=self._protected_destinations)
                self._rules(handle)
                # Docker's special none attachment must be detached first; no
                # namespace or container replacement, so tmpfs contents survive.
                if 'none' in metadata.get('NetworkSettings',{}).get('Networks',{}):
                    self._docker('network','disconnect','none',container_name)
                self._docker('network','connect',handle['network'],container_name)
                handle['connected'] = True
                endpoint = json.loads(self._docker('inspect',container_name))[0]['NetworkSettings']['Networks'][handle['network']]
                peer = str(ipaddress.IPv4Address(endpoint['IPAddress']))
                handle['proxy'].grant(peer,suffix,allowed,deadline_ms)
                handle['proxy_url'] = 'http://%s:%s' % handle['proxy'].address
                handle['environment'] = {key: handle['proxy_url'] for key in ('HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy')}
                handle['environment'].update({key:'' for key in ('ALL_PROXY','all_proxy','NO_PROXY','no_proxy')})
                return handle
            except BaseException:
                self.disable(handle)
                raise

    def disable(self, handle):
        with self._lock:
            if not handle or handle.get('id') not in self._handles:
                return
            if handle['proxy']:
                handle['proxy'].close()
            errors=[]
            if handle['connected']:
                try:
                    self._docker('network','disconnect','-f',handle['network'],handle['container'])
                    handle['connected'] = False
                except (OSError,subprocess.SubprocessError) as exc:
                    try:
                        current = json.loads(self._docker('network','inspect',handle['network']))[0]
                        peers = current.get('Containers', {})
                        if any(peer.get('Name') == handle['container'] for peer in peers.values()):
                            errors.append(exc)
                        else:
                            handle['connected'] = False
                    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                        errors.append(exc)
            if handle['created'] and not errors:
                try:
                    self._docker('network','rm',handle['network'])
                    handle['created'] = False
                except (OSError,subprocess.SubprocessError) as exc: errors.append(exc)
            # Remove firewall only after the network is gone; failures retain the
            # drop boundary and must cause runtime to destroy the container.
            if not errors:
                for family,rule in reversed(list(handle['hooks'])):
                    try:
                        self._fw(family,'-D',*rule)
                        handle['hooks'].remove((family,rule))
                    except (OSError,subprocess.SubprocessError) as exc: errors.append(exc)
                for family,chain in list(handle['chains']):
                    try:
                        self._fw(family,'-F',chain); self._fw(family,'-X',chain)
                        handle['chains'].remove((family,chain))
                    except (OSError,subprocess.SubprocessError) as exc: errors.append(exc)
            if errors:
                raise NetworkDenied('Network teardown unconfirmed; container must be destroyed')
            self._handles.pop(handle['id'],None)

    def recover(self):
        # Runtime removes installation containers before calling this method.
        with self._lock:
            for handle in list(self._handles.values()):
                self.disable(handle)
            ids = self._docker('network','ls','--filter','label='+self._label,'--filter','label=platform.sandbox.network=true','--format','{{.Name}}').splitlines()
            for name in ids:
                if re.fullmatch(re.escape(self._prefix)+r'-[0-9a-f]{8}', name):
                    self._docker('network','rm',name)
            chain_pattern = r'SBX[IF]'+self._scope.upper()+r'[0-9A-F]{8}'
            for family in (4,6):
                try:
                    for base in ('INPUT','FORWARD'):
                        for line in self._fw(family,'-S',base).splitlines():
                            tokens = line.split()
                            if tokens[:2] == ['-A',base] and len(tokens) >= 6 and tokens[-2] == '-j' and re.fullmatch(chain_pattern,tokens[-1]):
                                self._fw(family,'-D',*tokens[1:])
                    for line in self._fw(family,'-S').splitlines():
                        tokens = line.split()
                        if len(tokens) == 2 and tokens[0] == '-N' and re.fullmatch(chain_pattern,tokens[1]):
                            self._fw(family,'-F',tokens[1])
                            self._fw(family,'-X',tokens[1])
                except (OSError, subprocess.SubprocessError):
                    # Stale DROP rules without a live network cannot grant access.
                    # An unavailable firewall keeps future enable() fail-closed.
                    continue

    def close(self):
        with self._lock:
            errors=[]
            for handle in list(self._handles.values()):
                try: self.disable(handle)
                except NetworkDenied as exc: errors.append(exc)
            if errors:
                raise errors[0]
