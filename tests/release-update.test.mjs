import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('stable release updater discovers installs, verifies sources and protects deployment failures',()=>{
  const result=spawnSync('python3',['-B','tests/release_update_test.py'],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
