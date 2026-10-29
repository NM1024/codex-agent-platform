import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('updater', ROOT / 'scripts/update-release.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


class ReleaseUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'checkout'
        self.source.mkdir()
        (self.source / 'compose.yaml').write_text('services: {}\n')
        (self.source / 'deploy.sh').write_text('#!/bin/bash\n')
        (self.source / 'package.json').write_text('{"version":"0.1.0-preview.1"}')
        self.data = self.root / 'runtime'
        self.data.mkdir()
        (self.data / '.env').write_text(f'PLATFORM_DATA_DIR={self.data}\nRUNNER_TOKEN=synthetic\n')
        for name in ('data', 'workspace', 'codex', 'manager'):
            (self.data / name).mkdir()
            (self.data / name / 'retained').write_text('synthetic')
        self.install = u.Install(self.source, self.data, 'synthetic-platform')
        self.calls = []
        self.archive = self.make_archive()
        name = 'codex-agent-platform-v1.0.0.tar.gz'
        self.metadata = {'tag_name':'v1.0.0', 'draft':False, 'prerelease':False,
                         'published_at':'2026-10-29T00:00:00Z', 'assets':[
            {'name':n,'browser_download_url':f'https://github.com/NM1024/codex-agent-platform/releases/download/v1.0.0/{n}'}
            for n in (name,'SHA256SUMS')]}
        self.checksum = f'{hashlib.sha256(self.archive).hexdigest()}  {name}\n'.encode()

    def make_archive(self, bad=None):
        out = io.BytesIO()
        with tarfile.open(fileobj=out, mode='w:gz') as tar:
            files = {'package.json':b'{"version":"1.0.0"}', 'compose.yaml':b'services: {}',
                     'deploy.sh':(ROOT/'deploy.sh').read_bytes(), 'scripts/update-release.py':(ROOT/'scripts/update-release.py').read_bytes()}
            if bad:
                files[bad] = b'bad'
            for name, body in files.items():
                item = tarfile.TarInfo('codex-agent-platform-v1.0.0/' + name)
                item.size = len(body)
                tar.addfile(item, io.BytesIO(body))
        return out.getvalue()

    def download(self, url, path, limit):
        body = json.dumps(self.metadata).encode() if url.endswith('/latest') else self.checksum if url.endswith('SHA256SUMS') else self.archive
        path.write_bytes(body)

    def run_command(self, args, **kwargs):
        self.calls.append([str(x) for x in args])
        if args[-3:]==['compose','version','--short']:
            return '2.30.0'
        if args[-2:] == ['config', '--format=json']:
            services = {}
            for name, mounts in u.MOUNTS.items():
                services[name] = {'image':f'codex-agent-platform-{name}:1.0.0','volumes':[{'type':'bind','source':str(self.data / sub),'target':target} for target, sub in mounts.items()]}
            return json.dumps({'services':services})
        if args[:3]==['docker','image','inspect']:
            return 'sha256:'+'a'*64
        if '-q' in args and 'ps' in args:
            return args[-1]+'-container'
        if args[:2]==['docker','inspect']:
            service=args[-1].removesuffix('-container')
            return json.dumps([{'Image':'sha256:'+'a'*64,'Config':{'Image':f'codex-agent-platform-{service}:1.0.0','Labels':{'com.docker.compose.project':self.install.project,'com.docker.compose.service':service}},'State':{'Running':True,'Health':{'Status':'healthy'}}}])
        if args[:2]==['docker','exec']:
            return '1.0.0'
        return ''

    def update(self):
        with patch.object(u, 'download', self.download), patch.object(u, 'run', self.run_command):
            u.update(self.install)

    def test_verified_update_retains_data_backups_and_activates_only_after_health(self):
        self.update()
        state = json.loads((self.data / '.deployment.json').read_text())
        self.assertEqual(state['version'], '1.0.0')
        self.assertEqual(state['project'], self.install.project)
        self.assertEqual((self.data/'codex/retained').read_text(),'synthetic')
        backups=list((self.data/'backups').glob('*.tar.gz'))
        self.assertEqual(len(backups),1)
        self.assertEqual(backups[0].stat().st_mode & 0o777,0o600)
        with tarfile.open(backups[0]) as tar:
            self.assertIn('codex/retained',tar.getnames())
            self.assertNotIn('releases',tar.getnames())
        self.assertTrue(any('--wait' in c for c in self.calls))
        self.assertTrue((self.data/'deploy.sh').exists())
        self.assertEqual(json.loads((self.source/'package.json').read_text())['version'],'0.1.0-preview.1')
        with patch.object(u,'containers',return_value=[]):
            resolved=u.discover(self.source,self.data,None)
        self.assertEqual(str(resolved.source),state['source'])

    def test_backup_preserves_explicit_web_update_opt_out(self):
        (self.data/'.web-update-policy.json').write_text('{"enabled":false}')
        self.update()
        backup=next((self.data/'backups').glob('*.tar.gz'))
        with tarfile.open(backup) as archive:
            self.assertIn('.web-update-policy.json',archive.getnames())
            self.assertEqual(json.load(archive.extractfile('.web-update-policy.json')),{'enabled':False})

    def test_same_version_update_ensures_missing_host_service_after_verification(self):
        self.update()
        state=json.loads((self.data/'.deployment.json').read_text())
        active=u.Install(Path(state['source']),self.data,self.install.project)
        self.calls.clear()
        with patch.object(u,'download',self.download),patch.object(u,'run',self.run_command):u.update(active)
        ensure=[x for x in self.calls if 'ensure-web-update' in x]
        self.assertEqual(len(ensure),1)
        self.assertEqual(ensure[0][:3],['bash',str(active.source/'deploy.sh'),'ensure-web-update'])

    def test_original_and_runtime_launchers_follow_activated_source(self):
        self.update()
        state=json.loads((self.data/'.deployment.json').read_text())
        bin_dir=self.root/'bin'
        bin_dir.mkdir()
        docker=bin_dir/'docker'
        log=self.root/'docker.log'
        docker.write_text('#!/bin/bash\nif [[ "$1" == ps ]]; then exit 0; fi\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n')
        docker.chmod(0o700)
        env={**os.environ,'PATH':str(bin_dir)+os.pathsep+os.environ['PATH'],'COMMAND_LOG':str(log)}
        for script in (ROOT/'deploy.sh',self.data/'deploy.sh'):
            result=subprocess.run(['bash',str(script),'status',str(self.data)],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
        lines=log.read_text().splitlines()
        self.assertEqual(len(lines),2)
        self.assertTrue(all(str(Path(state['source'])/'compose.yaml') in line for line in lines))
        self.assertTrue(all('--project-name synthetic-platform' in line for line in lines))

    def test_colocated_checkout_script_is_preserved(self):
        original=(ROOT/'deploy.sh').read_text()
        (self.data/'deploy.sh').write_text(original)
        (self.data/'compose.yaml').write_text('services: {}')
        (self.data/'package.json').write_text('{"version":"0.1.0-preview.1"}')
        self.install=u.Install(self.data,self.data,'synthetic-platform')
        self.update()
        self.assertEqual((self.data/'deploy.sh').read_text(),original)
        self.assertTrue((self.data/'platform-deploy.sh').is_file())
        state=json.loads((self.data/'.deployment.json').read_text())
        self.assertEqual(state['launcher'],str(self.data/'platform-deploy.sh'))

    def test_original_update_uses_active_updater(self):
        active=self.root/'active'
        (active/'scripts').mkdir(parents=True)
        (active/'compose.yaml').write_text('services: {}')
        (active/'deploy.sh').write_text('#!/bin/bash')
        (active/'scripts/update-release.py').write_text('print("active updater selected")')
        (self.data/'.deployment.json').write_text(json.dumps({'source':str(active),'project':'synthetic-platform'}))
        bin_dir=self.root/'bin'
        bin_dir.mkdir()
        (bin_dir/'docker').write_text('#!/bin/bash\nexit 0\n')
        (bin_dir/'docker').chmod(0o700)
        env={**os.environ,'PATH':str(bin_dir)+os.pathsep+os.environ['PATH']}
        result=subprocess.run(['bash',str(ROOT/'deploy.sh'),'update',str(self.data)],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('active updater selected',result.stdout)

    def test_old_compose_is_refused_before_download_or_stop(self):
        with patch.object(u,'run',return_value='2.17.0'),patch.object(u,'download') as download:
            with self.assertRaisesRegex(u.UpdateError,'Compose'):
                u.update(self.install)
            download.assert_not_called()

    def test_checksum_mismatch_and_traversal_never_build_or_stop(self):
        self.checksum=b'0'*64+b'  codex-agent-platform-v1.0.0.tar.gz\n'
        with self.assertRaisesRegex(u.UpdateError,'checksum'):
            self.update()
        self.assertFalse(any('build' in c or 'stop' in c for c in self.calls))
        self.archive=self.make_archive('../../outside')
        self.checksum=f'{hashlib.sha256(self.archive).hexdigest()}  codex-agent-platform-v1.0.0.tar.gz\n'.encode()
        with self.assertRaisesRegex(u.UpdateError,'archive'):
            self.update()
        self.assertFalse((self.root/'outside').exists())

    def test_prerelease_and_wrong_asset_host_refused(self):
        self.metadata['prerelease']=True
        with self.assertRaisesRegex(u.UpdateError,'stable'):
            self.update()
        self.metadata['prerelease']=False
        self.metadata['assets'][0]['browser_download_url']='https://example.com/source.tar.gz'
        with self.assertRaisesRegex(u.UpdateError,'asset'):
            self.update()

    def test_build_failure_keeps_old_services_and_no_state(self):
        def fail(args,**kwargs):
            if 'build' in args:
                raise u.UpdateError('build failed')
            return self.run_command(args,**kwargs)
        with patch.object(u,'download',self.download),patch.object(u,'run',fail):
            with self.assertRaisesRegex(u.UpdateError,'build failed'):
                u.update(self.install)
        self.assertFalse((self.data/'.deployment.json').exists())
        self.assertFalse(any('stop' in c for c in self.calls))

    def test_failed_health_does_not_activate_or_automatically_downgrade(self):
        def fail(args,**kwargs):
            if '--wait' in args:
                raise u.UpdateError('health failed')
            return self.run_command(args,**kwargs)
        with patch.object(u,'download',self.download),patch.object(u,'run',fail):
            with self.assertRaisesRegex(u.UpdateError,'backup'):
                u.update(self.install)
        self.assertFalse((self.data/'.deployment.json').exists())
        self.assertEqual(sum('up' in c for c in self.calls),0)
        self.assertEqual(len(list((self.data/'backups').glob('*.tar.gz'))),1)

    def test_same_release_is_noop(self):
        self.update()
        self.calls=[]
        with patch.object(u,'containers',return_value=[]):
            self.install=u.discover(self.source,self.data,None)
        self.update()
        self.assertFalse(any('build' in c or 'stop' in c for c in self.calls))

    def container(self, data=None, project='synthetic-platform', config=None):
        return {'Config':{'Image':'codex-agent-platform-manager:0.1.0-preview.1','Labels':{
            'com.docker.compose.project':project,'com.docker.compose.service':'manager',
            'com.docker.compose.project.config_files':str(config or self.source/'compose.yaml')}},
            'Mounts':[{'Destination':target,'Source':str((data or self.data)/sub),'Type':'bind'} for target,sub in u.MOUNTS['manager'].items()]}

    def test_discovery_from_container_and_custom_project(self):
        with patch.object(u,'containers',return_value=[self.container()]):
            got=u.discover(self.source,None,None)
        self.assertEqual(got.data,self.data)
        self.assertEqual(got.project,'synthetic-platform')

    def test_ambiguous_or_override_installations_fail(self):
        with patch.object(u,'containers',return_value=[self.container(),self.container(self.root/'other','other')]):
            with self.assertRaisesRegex(u.UpdateError,'multiple'):
                u.discover(self.source,None,None)
        with patch.object(u,'containers',return_value=[self.container(config='compose.yaml,override.yaml')]):
            with self.assertRaisesRegex(u.UpdateError,'custom'):
                u.discover(self.source,self.data,None)

    def test_explicit_wrong_project_is_rejected(self):
        with patch.object(u,'containers',return_value=[self.container()]):
            with self.assertRaisesRegex(u.UpdateError,'different Compose project'):
                u.discover(self.source,self.data,'wrong')

    def test_backup_failure_restarts_old_services_and_never_migrates(self):
        with patch.object(u,'download',self.download),patch.object(u,'run',self.run_command),patch.object(u,'backup',side_effect=OSError('disk full')):
            with self.assertRaisesRegex(u.UpdateError,'Backup failed'):
                u.update(self.install)
        self.assertTrue(any('start' in c for c in self.calls))
        self.assertFalse(any('validate' in c for c in self.calls))
        self.assertFalse((self.data/'.deployment.json').exists())

    def test_backup_failure_does_not_claim_restart_succeeded_when_restart_also_fails(self):
        original=self.run_command
        def failing_restart(args,**kwargs):
            if args[-1]=='start':
                raise u.UpdateError('restart failed')
            return original(args,**kwargs)
        with patch.object(u,'download',self.download),patch.object(u,'run',failing_restart),patch.object(u,'backup',side_effect=OSError('disk full')):
            with self.assertRaisesRegex(u.UpdateError,'attempted to restart'):
                u.update(self.install)
        self.assertFalse((self.data/'.deployment.json').exists())

    def test_concurrent_updates_are_rejected(self):
        import fcntl
        with (self.data/'.update.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(u.UpdateError,'Another update'):
                self.update()

    def test_existing_project_cannot_be_reused_for_another_runtime(self):
        other=self.root/'other'
        other.mkdir()
        (other/'.env').write_text(f'PLATFORM_DATA_DIR={other}\nRUNNER_TOKEN=synthetic\n')
        with patch.object(u,'containers',return_value=[self.container(project='codex-agent-platform')]):
            with self.assertRaisesRegex(u.UpdateError,'mount|project'):
                u.discover(self.source,other,None)

    def test_gateway_or_runner_foreign_live_mount_is_rejected(self):
        runner={'Config':{'Image':'codex-agent-platform-runner:0.1.0-preview.1','Labels':{
            'com.docker.compose.project':'synthetic-platform','com.docker.compose.service':'runner'}},
            'Mounts':[{'Destination':'/codex','Source':'/foreign/codex','Type':'bind'},
                      {'Destination':'/workspace','Source':str(self.data/'workspace'),'Type':'bind'}]}
        with patch.object(u,'containers',return_value=[self.container(),runner]):
            with self.assertRaisesRegex(u.UpdateError,'mount'):
                u.discover(self.source,self.data,None)

    def test_mount_mismatch_does_not_stop_services(self):
        original=self.run_command
        def mismatch(args,**kwargs):
            result=original(args,**kwargs)
            if args[-2:]==['config','--format=json']:
                result=json.loads(result)
                result['services']['runner']['volumes'][0]['source']='/other'
                return json.dumps(result)
            return result
        with patch.object(u,'download',self.download),patch.object(u,'run',mismatch):
            with self.assertRaisesRegex(u.UpdateError,'mount'):
                u.update(self.install)
        self.assertFalse(any('stop' in c for c in self.calls))

if __name__=='__main__':
    unittest.main()
