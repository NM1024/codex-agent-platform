import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../src/application.mjs';
import { RequestStore } from '../src/core/store.mjs';
import { createTaskApi } from '../src/api.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const environment = { INGRESS_TOKEN: 'local-external', RUNNER_TOKEN: 'local-internal', WORKSPACE_DIR: '/tmp' };

test('a fresh installation exposes only generic examples and configuration scopes', t => {
  const app = createApplication('gateway', environment);
  const store = new RequestStore(':memory:', { registry: app.registry });
  t.after(() => store.close());
  assert.deepEqual(store.plugins.list().map(p => p.type).sort(), ['content.review', 'novel.illustrated']);
  assert.deepEqual(app.configuration(store).list().map(g => g.scope).sort(), ['access', 'execution', 'http']);
  assert.deepEqual(Object.keys(app.registry.catalog.resources ?? {}), []);
  assert.equal(app.config.clientId, 'default');
});

test('generic ingress accepts independent requests and uses live credential rotation', async t => {
  const app = createApplication('gateway', environment);
  const store = new RequestStore(':memory:', { registry: app.registry });
  t.after(() => store.close());
  const settings = app.configuration(store);
  const dispatcher = { drain: async () => {}, runner: {} };
  const server = createTaskApi({ ...app, store, dispatcher, runner: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = token => fetch(`http://127.0.0.1:${server.address().port}/v2/tasks`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'content.review', request_id: 'same', input: { content: 'Example article.' } }),
  });
  const first = await post(environment.INGRESS_TOKEN), second = await post(environment.INGRESS_TOKEN);
  assert.equal(first.status, 202); assert.equal(second.status, 202);
  assert.notEqual((await first.json()).task_id, (await second.json()).task_id);
  settings.update('access', { ingressToken: 'rotated-external' });
  assert.equal((await post(environment.INGRESS_TOKEN)).status, 401);
  assert.equal((await post('rotated-external')).status, 202);
});

for (const type of ['text.callback', 'content.review']) {
  test(`a persisted HTTP destination restores the ${type} plugin on restart`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'standalone-restart-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'tasks.sqlite');
    let app = createApplication('gateway', environment);
    let store = new RequestStore(path, { registry: app.registry });
    try {
      const settings = app.configuration(store);
      settings.update('http', { targets: { destination: { url: 'https://example.invalid/callback', token: 'local-target' } } });
      const { revision, updated_at, ...definition } = store.plugins.get('content.review');
      store.plugins.save({ ...definition, type, delivery: { mode: 'callback_once', target: 'destination' } });
    } finally { store.close(); }
    app = createApplication('gateway', environment);
    store = new RequestStore(path, { registry: app.registry });
    t.after(() => store.close());
    app.configuration(store);
    assert.deepEqual(store.plugins.invalid, []);
    const task = store.accept('default', { type, request_id: 'after-restart', input: { content: 'Example.' } });
    assert.equal(task.status, 'queued');
    const run = store.claim(task.task_id);
    await store.complete(run.run_id, { approved: true, reasons: [] });
    assert.equal(store.get(task.task_id).delivery.status, 'pending');
  });
}
