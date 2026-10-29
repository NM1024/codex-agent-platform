import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('optional host updater bounds requests and durably serializes jobs',()=>{
  const result=spawnSync('python3',['-B','tests/host_updater_test.py'],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
