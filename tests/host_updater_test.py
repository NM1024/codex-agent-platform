import importlib.util
import json
import http.client
import io
import shlex
import socket
import subprocess
import sys
import time
from types import SimpleNamespace
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from contextlib import ExitStack,redirect_stderr

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class HostUpdaterTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)

    def host(self):
        self.assertTrue((ROOT/'scripts/host-updater.py').exists(), 'host updater service is missing')
        return load('host_updater', ROOT/'scripts/host-updater.py')

    def setup_installation(self):
        h=self.host()
        self.assertTrue(hasattr(h,'ensure_web_update'),'default web updater setup is missing')
        stack=ExitStack();self.addCleanup(stack.close)
        for key,sub in [('HELPER_ROOT','helpers'),('CONFIG_ROOT','config'),('STATE_ROOT','state'),('UNIT_ROOT','units')]:
            folder=self.root/sub;folder.mkdir()
            stack.enter_context(patch.object(h,key,folder))
        source=self.root/'source';data=self.root/'runtime'
        source.mkdir();data.mkdir();(source/'scripts').mkdir()
        (data/'.env').write_text('PLATFORM_DATA_DIR='+str(data))
        for name in ('compose.yaml','deploy.sh','package.json'):(source/name).write_text('synthetic')
        for name in ('host-updater.py','update-release.py'):(source/'scripts'/name).write_text('print("synthetic")\n')
        installation=SimpleNamespace(source=source,data=data,project='synthetic')
        stack.enter_context(patch.object(h,'updater_module',return_value=SimpleNamespace(discover=lambda *args:installation)))
        stack.enter_context(patch.object(h,'trusted'))
        stack.enter_context(patch.object(h.os,'geteuid',return_value=0))
        stack.enter_context(patch.object(h.os,'chown'))
        stack.enter_context(patch.object(h,'systemd_available',return_value=True))
        calls=[]
        def command(args,**kwargs):
            calls.append(args)
            return SimpleNamespace(returncode=1 if args[1]=='is-active' else 0)
        stack.enter_context(patch.object(h.subprocess,'run',side_effect=command))
        return h,source,data,calls

    def test_standard_supported_host_automatically_installs_service(self):
        h,source,data,calls=self.setup_installation()
        self.assertEqual(h.ensure_web_update(source,data,'synthetic'),0)
        key=h.identity(data)
        cfg=json.loads((h.CONFIG_ROOT/(key+'.json')).read_text())
        self.assertEqual((cfg['data'],cfg['project']),(str(data),'synthetic'))
        self.assertTrue((h.UNIT_ROOT/('codex-agent-platform-updater-'+key+'.service')).is_file())
        self.assertIn(['systemctl','enable','--now','codex-agent-platform-updater-'+key+'.service'],calls)
        self.assertEqual((h.HELPER_ROOT/key/'host-updater.py').read_bytes(),(ROOT/'scripts/host-updater.py').read_bytes())

    def test_existing_active_service_is_not_reinstalled_or_restarted(self):
        h,source,data,calls=self.setup_installation()
        with patch.object(h.subprocess,'run',return_value=SimpleNamespace(returncode=0)) as command:
            self.assertEqual(h.ensure_web_update(source,data,'synthetic'),0)
        self.assertEqual(list(h.UNIT_ROOT.iterdir()),[])
        self.assertEqual([x.args[0] for x in command.call_args_list],[['systemctl','is-active','--quiet','codex-agent-platform-updater-'+h.identity(data)+'.service']])

    def test_disable_persists_across_ensure_and_explicit_enable_restores_default(self):
        h,source,data,calls=self.setup_installation()
        self.assertEqual(h.install('disable-web-update',source,data,'synthetic'),0)
        self.assertFalse(h.read_policy(data))
        calls.clear();h.ensure_web_update(source,data,'synthetic')
        self.assertEqual(calls,[])
        h.install('enable-web-update',source,data,'synthetic')
        self.assertTrue(h.read_policy(data))
        policy=data/h.POLICY
        self.assertEqual(policy.stat().st_mode&0o777,0o600)

    def test_non_root_and_missing_systemd_skip_without_host_changes(self):
        h,source,data,calls=self.setup_installation()
        with patch.object(h.os,'geteuid',return_value=1000):h.ensure_web_update(source,data,'synthetic')
        with patch.object(h,'systemd_available',return_value=False):h.ensure_web_update(source,data,'synthetic')
        self.assertEqual(calls,[])
        self.assertEqual(list(h.UNIT_ROOT.iterdir()),[])

    def test_auto_install_failure_warns_but_explicit_enable_reports_failure(self):
        h,source,data,calls=self.setup_installation()
        with patch.object(h.subprocess,'run',side_effect=subprocess.CalledProcessError(1,['systemctl'])):
            self.assertEqual(h.ensure_web_update(source,data,'synthetic'),0)
            with self.assertRaises(subprocess.CalledProcessError):h.install('enable-web-update',source,data,'synthetic')

    def test_staged_validation_installs_selected_release_helper(self):
        h,source,data,calls=self.setup_installation()
        staged=self.root/'selected';staged.mkdir()
        for name in ('compose.yaml','deploy.sh','package.json'):(staged/name).write_text('selected')
        with patch.dict(os.environ,{'PLATFORM_UPDATE_STAGED':'1'}):h.ensure_web_update(staged,data,'synthetic')
        cfg=json.loads((h.CONFIG_ROOT/(h.identity(data)+'.json')).read_text())
        self.assertEqual(cfg['source'],str(staged))

    def test_policy_symlinks_and_invalid_policy_never_enable_service(self):
        h,source,data,calls=self.setup_installation()
        policy=data/h.POLICY;target=self.root/'outside';target.write_text('{"enabled":true}')
        policy.symlink_to(target)
        with self.assertRaises(ValueError):h.read_policy(data)
        self.assertEqual(h.ensure_web_update(source,data,'synthetic'),0)
        self.assertEqual(calls,[])
        policy.unlink();policy.write_text('{"enabled":"false"}')
        with self.assertRaises(ValueError):h.read_policy(data)

    def test_untrusted_source_cannot_install_root_service(self):
        h,source,data,calls=self.setup_installation()
        def trust(path,*args):
            if Path(path)==source:raise ValueError('untrusted source')
        with patch.object(h,'trusted',side_effect=trust):h.ensure_web_update(source,data,'synthetic')
        self.assertEqual(list(h.UNIT_ROOT.iterdir()),[])
        self.assertFalse(any('enable' in x for x in calls))

    def test_disable_on_host_without_systemd_preserves_opt_out(self):
        h,source,data,calls=self.setup_installation()
        with patch.object(h,'systemd_available',return_value=False):h.install('disable-web-update',source,data,'synthetic')
        self.assertFalse(h.read_policy(data));self.assertEqual(calls,[])

    def test_legacy_explicitly_disabled_unit_is_not_automatically_reenabled(self):
        h,source,data,calls=self.setup_installation()
        unit='codex-agent-platform-updater-'+h.identity(data)+'.service'
        (h.UNIT_ROOT/unit).write_text('synthetic legacy unit')
        def command(args,**kwargs):
            calls.append(args)
            return SimpleNamespace(returncode=1,stdout='disabled\n')
        with patch.object(h.subprocess,'run',side_effect=command):h.ensure_web_update(source,data,'synthetic')
        self.assertFalse(h.read_policy(data))
        self.assertFalse(any('enable' in x for x in calls))

    def test_partial_auto_install_failure_is_retried_instead_of_becoming_opt_out(self):
        h,source,data,calls=self.setup_installation()
        fail=[True]
        def command(args,**kwargs):
            calls.append(args)
            if args[1]=='daemon-reload' and fail[0]:
                fail[0]=False;raise subprocess.CalledProcessError(1,args)
            return SimpleNamespace(returncode=1 if args[1] in ('is-active','is-enabled') else 0,stdout='disabled\n')
        with patch.object(h.subprocess,'run',side_effect=command):
            h.ensure_web_update(source,data,'synthetic')
            h.ensure_web_update(source,data,'synthetic')
        self.assertTrue(h.read_policy(data))
        self.assertEqual(sum(x[1]=='daemon-reload' for x in calls),2)
        self.assertTrue(any('enable' in x for x in calls))

    def test_failed_explicit_enable_preserves_enable_intent_for_retry(self):
        h,source,data,calls=self.setup_installation()
        h.install('disable-web-update',source,data,'synthetic')
        with patch.object(h.subprocess,'run',side_effect=subprocess.CalledProcessError(1,['systemctl'])):
            with self.assertRaises(subprocess.CalledProcessError):h.install('enable-web-update',source,data,'synthetic')
        self.assertTrue(h.read_policy(data))

    def test_setup_warning_uses_existing_source_entry_for_fresh_install(self):
        h,source,data,calls=self.setup_installation()
        output=io.StringIO()
        with patch.object(h,'systemd_available',return_value=False),redirect_stderr(output):h.ensure_web_update(source,data,'synthetic')
        self.assertIn(shlex.join(['sudo','bash',str(source/'deploy.sh'),'web-update-status',str(data)]),output.getvalue())
        self.assertIn(shlex.join(['sudo','bash',str(source/'deploy.sh'),'enable-web-update',str(data)]),output.getvalue())
        self.assertFalse((data/'deploy.sh').exists())

    def test_duplicate_admission_is_serialized_and_persisted_before_launch(self):
        h=self.host()
        store=h.JobStore(self.root)
        launched=[]
        def launch(job):
            self.assertEqual(store.read()['id'],job['id'])
            launched.append(job['id'])
        jobs=[]
        threads=[threading.Thread(target=lambda: jobs.append(store.admit(launch))) for _ in range(12)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(len(set(j['id'] for j in jobs)),1)
        self.assertEqual(len(launched),1)
        self.assertEqual(store.read()['state'],'queued')
        self.assertEqual((self.root/'job.json').stat().st_mode&0o777,0o600)

    def test_restart_marks_uncertain_job_interrupted_and_does_not_replay(self):
        h=self.host(); store=h.JobStore(self.root)
        job=store.admit(lambda job:None)
        store.change(job['id'],state='running',phase='validating')
        h.JobStore(self.root).interrupt()
        self.assertEqual(store.read()['state'],'interrupted')
        self.assertEqual(store.read()['error_code'],'updater_restarted')

    def test_job_projection_is_bounded_and_sanitized(self):
        h=self.host(); store=h.JobStore(self.root)
        job=store.admit(lambda job:None)
        store.change(job['id'],state='failed',phase='failed',error_code='build_failed',raw_log='secret',target_version='1.2.3')
        public=store.read()
        self.assertNotIn('raw_log',public)
        self.assertEqual(public['target_version'],'1.2.3')
        for _ in range(30):
            job=store.admit(lambda job:None)
            store.change(job['id'],state='failed',phase='failed')
        self.assertLessEqual(len(list(self.root.iterdir())),4)

    def test_admission_failure_is_durable(self):
        h=self.host(); store=h.JobStore(self.root)
        def fail(job):raise OSError('synthetic secret')
        job=store.admit(fail)
        self.assertEqual(job['state'],'failed')
        self.assertEqual(job['error_code'],'launch_failed')
        self.assertNotIn('synthetic',json.dumps(job))

    def test_request_input_has_no_options(self):
        h=self.host()
        for body in (b'{"tag":"v1.2.3"}',b'[]',b'null',b'',b'{"data":"/tmp"}'):
            with self.assertRaises(ValueError):h.upgrade_body(body)
        self.assertEqual(h.upgrade_body(b'{}'),{})

    def test_trusted_config_rejects_writable_and_symlink_files(self):
        h=self.host(); path=self.root/'config.json'
        path.write_text('{}'); path.chmod(0o666)
        with self.assertRaises(ValueError):h.load_config(path)
        path.unlink(); path.symlink_to('/dev/null')
        with self.assertRaises(ValueError):h.load_config(path)

    def test_release_success_requires_expected_image_and_package_version(self):
        u=load('image_verifier',ROOT/'scripts/update-release.py')
        self.assertTrue(hasattr(u,'verify_images'),'deployed image verification is missing')
        install=u.Install(self.root,self.root,'synthetic')
        config={'services':{name:{'image':'codex-agent-platform-'+name+':1.2.3'} for name in u.MOUNTS}}
        def command(args,**kwargs):
            if args[:3]==['docker','image','inspect']:return 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
            if '-q' in args:return 'container-id\n'
            if args[:2]==['docker','inspect']:
                service=active[0]
                return json.dumps([{'Image':image[0],'Config':{'Image':config['services'][service]['image'],'Labels':{'com.docker.compose.project':'synthetic','com.docker.compose.service':service}},'State':{'Running':True,'Health':{'Status':'healthy'}}}])
            if args[:2]==['docker','exec']:return package[0]
            raise AssertionError(args)
        active=['gateway'];image=['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'];package=['1.2.3']
        def dispatch(args,**kwargs):
            if '-q' in args:active[0]=args[-1]
            return command(args,**kwargs)
        with patch.object(u,'run',dispatch):
            expected=u.expected_images(config,'v1.2.3')
            u.verify_images(install,self.root,expected,'v1.2.3')
            image[0]='sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
            with self.assertRaises(u.UpdateError):u.verify_images(install,self.root,expected,'v1.2.3')
            image[0]='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';package[0]='1.0.0'
            with self.assertRaises(u.UpdateError):u.verify_images(install,self.root,expected,'v1.2.3')

    def test_unix_http_is_bounded_and_duplicate_requests_reuse_job(self):
        h=self.host(); path=self.root/'updater.sock'; launches=[]
        # Transport coverage must run under arbitrary CI host UIDs. Peer admission
        # is exercised separately against the unchanged production implementation.
        class TransportServer(h.Server):
            def verify_request(self,request,address):return True
        server=TransportServer(str(path),h.Handler);server.store=h.JobStore(self.root/'private')
        server.launch=lambda job:launches.append(job['id'])
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        def request(method,url,body=None,headers=None):
            conn=http.client.HTTPConnection('localhost',timeout=3)
            try:
                conn.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);conn.sock.connect(str(path))
                conn.request(method,url,body,headers or {})
                response=conn.getresponse()
                return response.status,json.loads(response.read())
            finally:conn.close()
        status,body=request('GET','/status');self.assertEqual((status,body),(200,{'available':True,'job':None}))
        status,body=request('POST','/upgrade',b'{}');self.assertEqual(status,202)
        job=body['job'];self.assertEqual(job['state'],'queued')
        status,body=request('POST','/upgrade',b'{}');self.assertEqual(body['job']['id'],job['id'])
        self.assertEqual(len(launches),1)
        self.assertEqual(request('POST','/upgrade',b'{"tag":"v8.0.0"}')[0],400)
        self.assertEqual(request('POST','/upgrade',b'a'*65)[0],400)
        self.assertEqual(request('GET','/status?data=/tmp')[0],404)
        self.assertTrue(hasattr(server,'slots'),'HTTP concurrency must have an explicit bound')

    def test_production_peer_admission_allows_only_root_and_manager_uid(self):
        h=self.host()
        server=h.Server.__new__(h.Server)
        for uid,allowed in ((0,True),(1000,True),(1001,False),(65534,False)):
            with self.subTest(uid=uid):
                def credentials(level,option,length):
                    self.assertEqual((level,option,length),(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                    return h.struct.pack('3i',1234,uid,1000)
                peer=SimpleNamespace(getsockopt=credentials)
                self.assertIs(h.Server.verify_request(server,peer,None),allowed)

    def test_worker_records_phase_failure_and_bounds_private_subprocess_log(self):
        h=self.host();store=h.JobStore(self.root/'state');job=store.admit(lambda job:None)
        def update(install,event):
            event('building',target_version='1.2.3')
            fake.run([sys.executable,'-c','print("x"*300000)'])
            raise RuntimeError('synthetic private error')
        fake=SimpleNamespace(discover=lambda *args:SimpleNamespace(source=self.root),update=update,UpdateError=RuntimeError)
        with patch.object(h,'updater_module',return_value=fake),patch.object(h,'trusted'):
            code=h.worker({'state':str(self.root/'state'),'source':str(self.root),'data':str(self.root),'project':'synthetic'},job['id'])
        self.assertEqual(code,1);self.assertEqual(store.read()['error_code'],'building_failed')
        self.assertNotIn('synthetic private',json.dumps(store.read()))
        self.assertLessEqual((self.root/'state/worker.log').stat().st_size,h.LOG_LIMIT)

    def test_helper_refresh_accepts_only_parseable_active_source_files(self):
        h=self.host()
        self.assertTrue(hasattr(h,'refresh_files'),'trusted broker refresh is missing')
        source=self.root/'release';target=self.root/'installed'
        (source/'scripts').mkdir(parents=True);target.mkdir()
        for name in ('host-updater.py','update-release.py'):
            (source/'scripts'/name).write_text('print("synthetic")\n')
            (target/name).write_text('old')
        with patch.object(h,'trusted'):
            h.refresh_files(source,target)
            self.assertIn('synthetic',(target/'host-updater.py').read_text())
            self.assertEqual((target/'host-updater.py').stat().st_mode&0o777,0o600)
            (source/'scripts/host-updater.py').write_text('invalid python ???')
            with self.assertRaises(SyntaxError):h.refresh_files(source,target)
        self.assertIn('synthetic',(target/'host-updater.py').read_text())

    def test_systemd_only_allows_fixed_helper_and_runtime_write_exceptions(self):
        h=self.host()
        self.assertTrue(hasattr(h,'systemd_unit'),'testable systemd unit generation is missing')
        unit=h.systemd_unit(Path('/usr/local/lib/codex-agent-platform-updater/abc'),Path('/etc/codex-agent-platform-updater/abc.json'),Path('/data/synthetic space%runtime'))
        self.assertIn('ProtectSystem=full',unit)
        self.assertIn('KillMode=control-group',unit)
        self.assertIn('ReadWritePaths="/usr/local/lib/codex-agent-platform-updater/abc" "/data/synthetic space%%runtime"',unit)
        self.assertIn('ExecStart=/usr/bin/python3 -B',unit)
        self.assertIn('PrivateTmp=true',unit)

    def test_host_cli_status_projects_job_and_host_recovery_paths(self):
        h=self.host()
        self.assertTrue(hasattr(h,'status_info'),'durable CLI status is missing')
        state=self.root/'state';store=h.JobStore(state);job=store.admit(lambda job:None)
        store.change(job['id'],state='failed',phase='failed',error_code='validating_failed',raw_log='secret')
        with patch.object(h,'trusted'):
            value=h.status_info(self.root/'runtime',state)
        self.assertEqual(value['job']['error_code'],'validating_failed')
        self.assertEqual(value['backup_directory'],str(self.root/'runtime/backups'))
        self.assertEqual(value['log_file'],str(state/'worker.log'))
        self.assertNotIn('secret',json.dumps(value))

    def test_worker_early_exit_is_durable_instead_of_stuck_queued(self):
        h=self.host();store=h.JobStore(self.root/'state');job=store.admit(lambda job:None)
        self.assertTrue(hasattr(h,'watch_worker'),'worker exit reconciliation is missing')
        child=subprocess.Popen([sys.executable,'-c','raise SystemExit(2)'])
        h.watch_worker(child,store,job['id'])
        self.assertEqual(store.read()['state'],'failed')
        self.assertEqual(store.read()['error_code'],'worker_exited')

    def test_config_follows_trusted_active_release_after_original_checkout_is_removed(self):
        h=self.host();data=self.root/'runtime';state=self.root/'state';active=self.root/'active'
        for path in (data,state,active):path.mkdir()
        (data/'.env').write_text('synthetic')
        (data/'.deployment.json').write_text(json.dumps({'source':str(active)}))
        config=self.root/'config.json'
        config.write_text(json.dumps({'source':str(self.root/'removed'),'data':str(data),'project':'synthetic','state':str(state),'upstream':h.REPO}))
        with patch.object(h,'trusted'):
            loaded=h.load_config(config)
        self.assertEqual(loaded['source'],str(active))

    def test_detached_worker_finishes_after_request_owner_exits(self):
        h=self.host()
        self.assertTrue(hasattr(h,'launch_worker'),'detached worker launch is missing')
        config=self.root/'config.json';state=self.root/'state';fake=self.root/'synthetic-python'
        config.write_text(json.dumps({'state':str(state)}))
        fake.write_text('#!'+sys.executable+'\n'+
            'import importlib.util,json,os,sys,time\n'+
            'from pathlib import Path\n'+
            'spec=importlib.util.spec_from_file_location("h",sys.argv[2]);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)\n'+
            'cfg=json.loads(Path(sys.argv[sys.argv.index("--config")+1]).read_text());job=sys.argv[sys.argv.index("--job")+1]\n'+
            'assert os.getsid(0)==os.getpid()\n'+
            'store=h.JobStore(cfg["state"]);store.change(job,state="running",phase="checking");time.sleep(0.2);store.change(job,state="succeeded",phase="completed")\n')
        fake.chmod(0o700)
        launcher=('import importlib.util;from pathlib import Path;from types import SimpleNamespace;'+
            'spec=importlib.util.spec_from_file_location("h",'+repr(str(ROOT/'scripts/host-updater.py'))+');h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h);'+
            'h.sys=SimpleNamespace(executable='+repr(str(fake))+');store=h.JobStore('+repr(str(state))+');store.admit(lambda job:h.launch_worker(Path('+repr(str(config))+'),job,store))')
        result=subprocess.run([sys.executable,'-c',launcher],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            job=h.JobStore(state).read()
            if job['state']=='succeeded':break
            time.sleep(0.02)
        self.assertEqual(job['state'],'succeeded')

    def test_bounded_log_keeps_tail(self):
        h=self.host(); log=self.root/'worker.log'
        h.append_log(log,'a'*300000)
        h.append_log(log,'end')
        self.assertLessEqual(log.stat().st_size,h.LOG_LIMIT)
        self.assertTrue(log.read_text().endswith('end'))

if __name__=='__main__':unittest.main()
