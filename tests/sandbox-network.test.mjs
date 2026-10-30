import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const python = String.raw`
import sys, os, socket, threading, time, unittest, json, subprocess, tempfile
from unittest.mock import patch
sys.path.insert(0, 'scripts')
from sandbox_network import SandboxNetwork, NetworkDenied, canonical_domain, public_addresses, GuardedProxy

class NetworkTests(unittest.TestCase):
    def test_canonical_hosts_and_public_resolution(self):
        self.assertEqual(canonical_domain('EXAMPLE.COM'), 'example.com')
        self.assertEqual(canonical_domain('bücher.example'), 'xn--bcher-kva.example')
        for host in ['*.example.com','127.0.0.1','[::1]','::1','example.com.','user@example.com','example.com:443','localhost','a..example','0177.0.0.1','2130706433','0x7f000001','example.com/path',' example.com']:
            with self.subTest(host=host), self.assertRaises(NetworkDenied): canonical_domain(host)
        self.assertEqual(public_addresses('example.com', lambda h,p: ['93.184.216.34']), ['93.184.216.34'])
        for ip in ['127.0.0.1','10.0.0.2','169.254.169.254','172.18.0.2','192.168.1.1','100.64.0.1','0.0.0.0','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','64:ff9b::a00:1','::ffff:0:127.0.0.1','2001:db8::1']:
            with self.subTest(ip=ip), self.assertRaises(NetworkDenied): public_addresses('example.com', lambda h,p: [ip])
        with self.assertRaises(NetworkDenied): public_addresses('example.com', lambda h,p: ['93.184.216.34','10.0.0.1'])

    def fixture(self, lifetime=3000):
        server = socket.socket(); server.bind(('127.0.0.1',0)); server.listen()
        peers=[]
        def serve():
            try: conn,_=server.accept(); peers.append(conn)
            except OSError: return
            try:
                while True:
                    data=conn.recv(65536)
                    if not data: break
                    conn.sendall(data)
            except OSError: pass
            finally: conn.close()
        threading.Thread(target=serve,daemon=True).start()
        resolutions=[]; dials=[]
        def resolve(host,port): resolutions.append((host,port)); return ['93.184.216.34']
        def dial(ip,port,register):
            dials.append((ip,port)); conn=socket.socket(); conn.settimeout(2); register(conn); conn.connect(server.getsockname()); return conn
        proxy=GuardedProxy('127.0.0.1',0,resolver=resolve,dial=dial)
        proxy.grant('127.0.0.1','job-one',['example.com'],int(time.time()*1000)+lifetime)
        self.addCleanup(proxy.close); self.addCleanup(server.close)
        return proxy,resolutions,dials

    def request(self, proxy, request):
        conn=socket.create_connection(proxy.address,timeout=2); conn.settimeout(2); conn.sendall(request); return conn

    def test_connect_pins_resolution_and_revoke_closes_existing_tunnel(self):
        proxy,resolutions,dials=self.fixture()
        conn=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')
        self.addCleanup(conn.close)
        self.assertIn(b'200 Connection Established',conn.recv(4096))
        conn.sendall(b'opaque encrypted bytes'); self.assertEqual(conn.recv(4096),b'opaque encrypted bytes')
        self.assertEqual(resolutions,[('example.com',443)]); self.assertEqual(dials,[('93.184.216.34',443)])
        proxy.revoke('job-one'); self.assertEqual(conn.recv(4096),b'')
        denied=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\n\r\n'); self.addCleanup(denied.close)
        self.assertIn(b'403',denied.recv(4096))

    def test_revoke_closes_socket_while_outbound_connection_is_pending(self):
        started=threading.Event(); released=threading.Event(); sockets=[]
        def pending(ip,port,register):
            conn=socket.socket(); sockets.append(conn); register(conn); started.set(); released.wait(2); return conn
        proxy=GuardedProxy('127.0.0.1',0,resolver=lambda h,p:['93.184.216.34'],dial=pending)
        self.addCleanup(proxy.close); self.addCleanup(released.set)
        proxy.grant('127.0.0.1','pending',['example.com'],int(time.time()*1000)+3000)
        conn=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\n\r\n'); self.addCleanup(conn.close)
        self.assertTrue(started.wait(.3),'outbound socket must be registered before connect')
        proxy.revoke('pending'); self.assertEqual(sockets[0].fileno(),-1); released.set()
        self.assertEqual(conn.recv(4096),b'')

    def test_relay_error_after_connect_cannot_append_a_second_http_response(self):
        proxy,_,_=self.fixture()
        def expired_socket(*args,**kwargs): raise OSError('tunnel socket closed during expiry')
        proxy._relay=expired_socket
        conn=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\n\r\n'); self.addCleanup(conn.close)
        received=b''
        while True:
            chunk=conn.recv(4096)
            if not chunk: break
            received+=chunk
        self.assertEqual(received,b'HTTP/1.1 200 Connection Established\r\n\r\n')

    def test_relay_error_after_plain_http_response_cannot_append_proxy_error(self):
        proxy,_,_=self.fixture()
        upstream_response=b'HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\npartial'
        def failed_upstream(client,*args,**kwargs):
            client.sendall(upstream_response)
            raise OSError('upstream closed after a partial response')
        proxy._relay=failed_upstream
        conn=self.request(proxy,b'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n'); self.addCleanup(conn.close)
        received=b''
        while True:
            chunk=conn.recv(4096)
            if not chunk: break
            received+=chunk
        self.assertEqual(received,upstream_response)

    def test_deadline_closes_existing_tunnel(self):
        # Establish first, then advance the wall clock: a short admission window
        # can expire before the handshake on a loaded CI worker.
        proxy,_,_=self.fixture(30000)
        conn=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\n\r\n'); self.addCleanup(conn.close)
        response=b''
        while not response.endswith(b'\r\n\r\n'):
            chunk=conn.recv(4096)
            self.assertTrue(chunk,'CONNECT handshake must finish before expiry is triggered')
            response+=chunk
        self.assertEqual(response,b'HTTP/1.1 200 Connection Established\r\n\r\n')
        with patch('sandbox_network.time.time',return_value=time.time()+31):
            self.assertEqual(conn.recv(4096),b'')

    def test_new_domains_private_rebinding_ports_and_host_mismatch_denied(self):
        proxy,resolutions,dials=self.fixture()
        for req in [b'CONNECT evil.example:443 HTTP/1.1\r\n\r\n',b'CONNECT example.com:22 HTTP/1.1\r\n\r\n',b'CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n',b'GET http://example.com/ HTTP/1.1\r\nHost: evil.example\r\n\r\n',b'GET / HTTP/1.1\r\nHost: example.com\r\n\r\n']:
            conn=self.request(proxy,req); self.addCleanup(conn.close); self.assertIn(b'403',conn.recv(4096))
        self.assertEqual(dials,[])
        proxy.resolver=lambda h,p:['10.1.2.3']
        conn=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\n\r\n'); self.addCleanup(conn.close)
        self.assertIn(b'403',conn.recv(4096)); self.assertEqual(dials,[])

    def test_dns_rebinding_cannot_change_existing_or_new_tunnel_destination(self):
        proxy,_,dials=self.fixture()
        conn=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\n\r\n'); self.addCleanup(conn.close)
        self.assertIn(b'200 ',conn.recv(4096))
        proxy.resolver=lambda h,p:['127.0.0.1']
        rebound=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\n\r\n'); self.addCleanup(rebound.close)
        self.assertIn(b'403',rebound.recv(4096)); self.assertEqual(len(dials),1)
        conn.sendall(b'existing pinned socket'); self.assertEqual(conn.recv(4096),b'existing pinned socket')

    def test_redirect_does_not_grant_another_destination(self):
        server=socket.socket(); server.bind(('127.0.0.1',0)); server.listen(); self.addCleanup(server.close)
        calls=[]
        def origin():
            conn,_=server.accept()
            with conn:
                conn.recv(4096)
                conn.sendall(b'HTTP/1.1 302 Found\r\nLocation: http://evil.example/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        threading.Thread(target=origin,daemon=True).start()
        def dial(ip,port,register):
            calls.append((ip,port)); conn=socket.socket(); register(conn); conn.connect(server.getsockname()); return conn
        proxy=GuardedProxy('127.0.0.1',0,resolver=lambda h,p:['93.184.216.34'],dial=dial); self.addCleanup(proxy.close)
        proxy.grant('127.0.0.1','redirect',['example.com'],int(time.time()*1000)+3000)
        conn=self.request(proxy,b'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n'); self.addCleanup(conn.close)
        self.assertIn(b'302 Found',conn.recv(4096))
        follow=self.request(proxy,b'GET http://evil.example/ HTTP/1.1\r\nHost: evil.example\r\n\r\n'); self.addCleanup(follow.close)
        self.assertIn(b'403',follow.recv(4096)); self.assertEqual(len(calls),1)

    def test_peer_identity_is_required(self):
        proxy,_,dials=self.fixture(); proxy.revoke('job-one'); proxy.grant('192.0.2.1','other',['example.com'],int(time.time()*1000)+3000)
        conn=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\n\r\n'); self.addCleanup(conn.close)
        self.assertIn(b'403',conn.recv(4096)); self.assertEqual(dials,[])

    def test_plain_http_strips_proxy_credentials_and_cannot_reuse_for_new_host(self):
        proxy,_,_=self.fixture()
        conn=self.request(proxy,b'GET http://example.com/data HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: secret\r\n\r\n'); self.addCleanup(conn.close)
        response=conn.recv(4096)
        self.assertIn(b'GET /data HTTP/1.1',response); self.assertNotIn(b'secret',response)
        # A plain HTTP connection carries one bounded request, never a second proxy request.
        conn.sendall(b'GET http://evil.example/ HTTP/1.1\r\nHost: evil.example\r\n\r\n')
        self.assertEqual(conn.recv(4096),b'')

    def test_globally_classified_docker_subnet_is_not_an_internet_destination(self):
        with self.assertRaises(NetworkDenied): public_addresses('example.com',lambda h,p:['11.0.0.2'],denied_networks=['11.0.0.0/24'])
        with self.assertRaises(NetworkDenied): public_addresses('example.com',lambda h,p:['2606:4700:1::2'],denied_networks=['2606:4700:1::/64'])
        proxy,_,dials=self.fixture()
        proxy.destination_policy=lambda:(set(),['93.184.216.0/24'])
        conn=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\n\r\n'); self.addCleanup(conn.close)
        self.assertIn(b'403',conn.recv(4096)); self.assertEqual(dials,[])

    def test_network_destination_policy_failure_never_falls_back_to_dial(self):
        proxy,_,dials=self.fixture()
        def unavailable(): raise subprocess.CalledProcessError(1,['docker','network','inspect'])
        proxy.destination_policy=unavailable
        conn=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\n\r\n'); self.addCleanup(conn.close)
        self.assertIn(b'403',conn.recv(4096)); self.assertEqual(dials,[])

    def test_all_docker_network_cidrs_and_endpoints_are_discovered(self):
        network=SandboxNetwork(installation='synthetic')
        network._run=lambda args:json.dumps([{'addr_info':[{'local':'11.0.0.1'}]}])
        def docker(*args):
            if args[:2]==('network','ls'): return '0123456789abcdef'
            return json.dumps([{'IPAM':{'Config':[{'Subnet':'11.0.0.0/24'},{'Subnet':'2606:4700:1::/64'}]},'Containers':{'synthetic':{'IPv4Address':'11.0.0.2/24','IPv6Address':'2606:4700:1::2/64'}}}])
        network._docker=docker
        addresses,networks=network._protected_destinations()
        self.assertEqual(addresses,{'11.0.0.1','11.0.0.2','2606:4700:1::2'})
        self.assertEqual(set(map(str,networks)),{'11.0.0.0/24','2606:4700:1::/64'})

    def test_host_public_address_is_denied(self):
        proxy,_,dials=self.fixture()
        proxy.denied_addresses=frozenset(['93.184.216.34'])
        conn=self.request(proxy,b'CONNECT example.com:443 HTTP/1.1\r\n\r\n'); self.addCleanup(conn.close)
        self.assertIn(b'403',conn.recv(4096)); self.assertEqual(dials,[])

    def test_grants_require_finite_bounded_deadlines(self):
        proxy,_,_=self.fixture()
        for index,deadline in enumerate([float('nan'),float('inf'),int(time.time()*1000)+601000]):
            with self.subTest(deadline=deadline), self.assertRaises(NetworkDenied): proxy.grant('192.0.2.'+str(index+2),'bad',['example.com'],deadline)

    def network_fixture(self):
        class Boundary(SandboxNetwork):
            def __init__(self):
                super().__init__(installation='synthetic-network')
                self.commands=[]; self.connected=False; self.fail_remove=False
            def available(self): return True
            def _docker(self,*args):
                self.commands.append(('docker',args))
                if args[0]=='inspect':
                    nets={self.net:{'IPAddress':'127.0.0.1'}} if self.connected else {'none':{}}
                    return json.dumps([{'Config':{'Labels':{'io.codex-agent-platform.sandbox':self.installation}},'NetworkSettings':{'Networks':nets}}])
                if args[:2]==('network','create'): self.net=args[-1]
                if args[:2]==('network','inspect'): return json.dumps([{'Internal':True,'EnableIPv6':False,'IPAM':{'Config':[{'Gateway':'127.0.0.1'}]}}])
                if args[:2]==('network','connect'): self.connected=True
                if args[:2]==('network','disconnect'): self.connected=False
                if args[:2]==('network','rm') and self.fail_remove: raise subprocess.CalledProcessError(1,args)
                return ''
            def _fw(self,family,*args): self.commands.append(('firewall',family,args)); return ''
        network=Boundary(); self.addCleanup(network.close); return network

    def test_internal_bridge_is_guarded_before_container_attachment(self):
        network=self.network_fixture()
        handle=network.enable('owned-container',['example.com'],int(time.time()*1000)+3000)
        commands=network.commands
        created=next(c for c in commands if c[0]=='docker' and c[1][:2]==('network','create'))
        self.assertIn('--internal',created[1]); self.assertIn('io.codex-agent-platform.sandbox=synthetic-network',created[1])
        attached=next(i for i,c in enumerate(commands) if c[0]=='docker' and c[1][:2]==('network','connect'))
        for family in (4,6):
            self.assertTrue(any(i<attached and c[0]=='firewall' and c[1]==family and c[2][:4]==('-I','INPUT','1','-i') for i,c in enumerate(commands)))
            for direction in ('-i','-o'):
                self.assertTrue(any(i<attached and c[0]=='firewall' and c[1]==family and c[2][:4]==('-I','FORWARD','1',direction) for i,c in enumerate(commands)))
        self.assertTrue(handle['environment']['HTTPS_PROXY'].startswith('http://127.0.0.1:'))
        self.assertEqual(handle['environment']['NO_PROXY'],'')
        network.disable(handle); self.assertEqual(network._handles,{})
        network.disable(handle)

    def test_unconfirmed_disconnect_keeps_drop_rules_and_requires_container_destruction(self):
        network=self.network_fixture()
        handle=network.enable('owned-container',['example.com'],int(time.time()*1000)+3000)
        network.fail_remove=True; count=len(network.commands)
        with self.assertRaises(NetworkDenied): network.disable(handle)
        self.assertFalse(any(c[0]=='firewall' and c[2][0]=='-D' for c in network.commands[count:]))
        network.fail_remove=False; network.disable(handle)

    def test_teardown_retries_after_container_already_removed_and_partial_firewall_failure(self):
        network=self.network_fixture()
        handle=network.enable('owned-container',['example.com'],int(time.time()*1000)+3000)
        original_docker=network._docker
        def removed(*args):
            if args[:2]==('network','disconnect'): raise subprocess.CalledProcessError(1,args)
            return original_docker(*args)
        network._docker=removed
        original_fw=network._fw; failed=[False]
        def flaky(family,*args):
            if args[0]=='-D' and not failed[0]: failed[0]=True; raise subprocess.CalledProcessError(1,args)
            return original_fw(family,*args)
        network._fw=flaky
        with self.assertRaises(NetworkDenied): network.disable(handle)
        network.disable(handle)
        self.assertEqual(network._handles,{})

    def test_recovery_never_deletes_other_installation_firewall_rules(self):
        network=self.network_fixture()
        own='SBXI'+network._scope.upper()+'01234567'
        foreign='SBXIFFFFFFFFFF01234567'
        commands=[]
        def firewall(family,*args):
            commands.append((family,args))
            if args==('-S','INPUT'): return '-A INPUT -i synthetic -j '+own+'\n-A INPUT -i synthetic -j '+foreign
            if args==('-S','FORWARD'): return ''
            if args==('-S',): return '-N '+own+'\n-N '+foreign
            return ''
        network._fw=firewall; network.recover()
        self.assertTrue(any(args[:2]==('-D','INPUT') and own in args for family,args in commands))
        self.assertFalse(any(args[0] in ('-D','-F','-X') and foreign in args for family,args in commands))

    def test_managed_policy_without_inherited_proxy_still_refuses_direct_egress(self):
        original=dict(os.environ)
        try:
            for key in list(os.environ):
                if key.lower().endswith('_proxy'): os.environ.pop(key)
            with tempfile.TemporaryDirectory() as directory:
                policy=os.path.join(directory,'network-policy.json')
                with open(policy,'w') as file: json.dump({'version':1,'http_proxy':'http://synthetic.invalid:8080'},file)
                network=SandboxNetwork(installation='network-test',network_policy_file=policy)
                self.assertFalse(network.available()); self.assertIn('upstream',network.reason.lower())
        finally: os.environ.clear(); os.environ.update(original)

    def test_upstream_proxy_or_missing_firewall_never_silently_bypassed(self):
        original=dict(os.environ)
        try:
            os.environ['HTTPS_PROXY']='http://synthetic.invalid:8080'
            network=SandboxNetwork(installation='network-test'); self.addCleanup(network.close)
            self.assertFalse(network.available()); self.assertIn('upstream',network.reason.lower())
            with self.assertRaises(NetworkDenied): network.enable('sandbox-test',['example.com'],int(time.time()*1000)+1000)
            for key in list(os.environ):
                if key.lower().endswith('_proxy'): os.environ.pop(key)
            network=SandboxNetwork(installation='network-test', firewall_command='/nonexistent/firewall')
            self.addCleanup(network.close); self.assertFalse(network.available())
        finally: os.environ.clear(); os.environ.update(original)

unittest.main(argv=['network-tests'],verbosity=2)
`;

test('sandbox guarded proxy validates targets, pins public DNS, and closes revoked tunnels', () => {
  const result = spawnSync('python3', ['-c', python], { cwd: process.cwd(), encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Traceback|Exception in thread/);
});

// This exercises the actual container->bridge->guarded-proxy path only on a
// capable local host. It never pulls images or connects to a public destination.
const actualBoundary = String.raw`
import sys, json, time, socket, threading, subprocess, uuid
sys.path.insert(0,'scripts')
from sandbox_network import SandboxNetwork
installation='synthetic-network-'+uuid.uuid4().hex[:10]
network=SandboxNetwork(installation=installation)
def docker(*args,check=True):
    return subprocess.run(['docker','--host=unix:///var/run/docker.sock',*args],check=check,capture_output=True,text=True,timeout=20).stdout
if not network.available():
    print(json.dumps({'skip':network.reason})); sys.exit(0)
image='codex-agent-platform-sandbox:1.0.2'
try: docker('image','inspect',image)
except subprocess.CalledProcessError:
    print(json.dumps({'skip':'Fixed sandbox image is not built locally'})); sys.exit(0)
name='synthetic-network-'+uuid.uuid4().hex
other=name+'-other'
handle=None; second=None; server=None
try:
    docker('run','--detach','--name',name,'--label','io.codex-agent-platform.sandbox='+installation,'--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','128',*[part for key in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy') for part in ('--env',key+'=')],'--entrypoint','python3',image,'-c','import signal; signal.pause()')
    server=socket.socket(); server.bind(('127.0.0.1',0)); server.listen()
    def echo():
        conn,_=server.accept()
        try:
            while True:
                data=conn.recv(65536)
                if not data: break
                conn.sendall(data)
        except OSError: pass
        finally: conn.close()
    threading.Thread(target=echo,daemon=True).start()
    handle=network.enable(name,['example.com'],int(time.time()*1000)+15000)
    handle['proxy'].resolver=lambda h,p:['93.184.216.34']
    def local_dial(ip,p,register):
        conn=socket.socket(); conn.settimeout(2); register(conn); conn.connect(server.getsockname()); return conn
    handle['proxy'].dial=local_dial
    docker('run','--detach','--name',other,'--label','io.codex-agent-platform.sandbox='+installation,'--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','128',*[part for key in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy') for part in ('--env',key+'=')],'--entrypoint','python3',image,'-c','import signal; signal.pause()')
    second=network.enable(other,['example.com'],int(time.time()*1000)+15000)
    other_peer=json.loads(docker('inspect',other))[0]['NetworkSettings']['Networks'][second['network']]['IPAddress']
    gateway=handle['gateway']; port=handle['proxy'].address[1]
    script='''import socket
host=%r; port=%r; other=%r; other_gateway=%r; other_proxy=%r
s=socket.create_connection((host,port),timeout=2)
s.sendall(b'CONNECT example.com:443 HTTP/1.1\\r\\n\\r\\n')
assert b'200 ' in s.recv(4096)
s.sendall(b'synthetic tunnel'); assert s.recv(4096)==b'synthetic tunnel'; s.close()
for address in [('93.184.216.34',443),('169.254.169.254',80),(host,22),('172.17.0.1',80),('10.0.0.1',80),(other,443),(other_gateway,other_proxy)]:
 try: c=socket.create_connection(address,timeout=.3)
 except OSError: continue
 c.close(); raise AssertionError('direct or host access unexpectedly permitted: '+str(address))
print('guarded actual bridge verified')
'''%(gateway,port,other_peer,second['gateway'],second['proxy'].address[1])
    result=docker('exec',name,'python3','-c',script)
    assert 'guarded actual bridge verified' in result
    network.disable(handle); handle=None
    docker('exec',name,'python3','-c',"import socket\ntry: s=socket.create_connection((%r,%r),timeout=.3)\nexcept OSError: pass\nelse: s.close(); raise AssertionError('proxy still reachable after revoke')"%(gateway,port))
    print(json.dumps({'verified':True}))
finally:
    docker('rm','--force',name,other,check=False)
    if second: network.disable(second)
    if handle: network.disable(handle)
    network.close()
    if server: server.close()
`;

test('actual container bridge permits only guarded job egress when host enforcement is available', (t) => {
  const result = spawnSync('python3', ['-c', actualBoundary], { cwd: process.cwd(), encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Traceback|Exception in thread/);
  const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1));
  if (outcome.skip) {assert.notEqual(process.env.SANDBOX_REQUIRE_NETWORK_TEST,'1',outcome.skip);return t.skip(outcome.skip);}
  assert.equal(outcome.verified, true);
});
