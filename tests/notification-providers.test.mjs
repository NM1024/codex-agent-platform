import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/errors.mjs';
import { notificationProviders, validateNotificationTarget, notificationFormat, notificationRequest, notificationOutcome } from '../src/notifications/providers.mjs';

const targets = {
  feishu: 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-hook',
  wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-key',
  dingtalk: 'https://oapi.dingtalk.com/robot/send?access_token=synthetic-token',
  slack: 'https://hooks.slack.com/services/TEXAMPLE/BEXAMPLE/synthetic-token',
  discord: 'https://discord.com/api/webhooks/123456789012345678/synthetic-token',
  custom: 'https://receiver.example/notifications',
};
const bodies = {
  feishu: { msg_type: 'text', content: { text: 'Synthetic notification' } },
  wecom: { msgtype: 'text', text: { content: 'Synthetic notification' } },
  dingtalk: { msgtype: 'text', text: { content: 'Synthetic notification' } },
  slack: { text: 'Synthetic notification' },
  discord: { content: 'Synthetic notification' },
  custom: { event: 'synthetic-notification' },
};
const invalid = fn => assert.throws(fn, error => error instanceof HttpError && error.status === 400);

test('lists six providers and supplies independent safe native examples', () => {
  assert.deepEqual(notificationProviders, Object.keys(targets));
  for (const provider of notificationProviders) {
    const format = notificationFormat(provider);
    assert.equal(typeof format.instructions, 'string');
    assert.ok(format.instructions.length > 30);
    notificationRequest({ provider, url: targets[provider] }, format.example);
    format.example.changed = true;
    assert.equal(notificationFormat(provider).example.changed, undefined);
  }
  invalid(() => notificationFormat('unsupported'));
});

test('accepts official native targets and Lark protocol endpoints', () => {
  for (const [provider, url] of Object.entries(targets)) validateNotificationTarget(provider, url);
  validateNotificationTarget('feishu', 'https://open.larksuite.com/open-apis/bot/v2/hook/synthetic-hook');
  validateNotificationTarget('discord', 'https://discord.com/api/v10/webhooks/123456789012345678/synthetic-token?thread_id=123');
  validateNotificationTarget('slack', 'https://hooks.slack-gov.com/services/TEXAMPLE/BEXAMPLE/synthetic-token');
});

test('limits custom HTTP targets to existing exact loopback rules', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) validateNotificationTarget('custom', `http://${host}:1234/notify`);
  for (const url of ['http://receiver.example/notify', 'http://127.0.0.2/notify', 'ftp://receiver.example/notify', 'https://user:password@receiver.example/', 'https://receiver.example/#fragment', 'not-a-url']) {
    invalid(() => validateNotificationTarget('custom', url));
  }
  invalid(() => validateNotificationTarget('unknown', targets.custom));
});

test('rejects native host spoofing, API alternatives, nonstandard ports and test-host bypasses', () => {
  for (const [provider, raw] of Object.entries(targets).filter(([p]) => p !== 'custom')) {
    const url = new URL(raw);
    for (const invalidUrl of [raw.replace(url.hostname, `${url.hostname}.example`), raw.replace('https:', 'http:'), raw.replace(url.hostname, `${url.hostname}:444`), 'http://127.0.0.1:1234/notify', raw.replace(url.pathname, '/arbitrary')]) {
      invalid(() => validateNotificationTarget(provider, invalidUrl));
    }
  }
  invalid(() => validateNotificationTarget('wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send'));
  invalid(() => validateNotificationTarget('dingtalk', 'https://oapi.dingtalk.com/robot/send'));
  invalid(() => validateNotificationTarget('discord', `${targets.discord}/slack`));
});

test('serializes native JSON without mutating callers and fixes POST, JSON and redirects', () => {
  for (const provider of notificationProviders) {
    const channel = Object.freeze({ provider, url: targets[provider] });
    const body = structuredClone(bodies[provider]);
    const original = structuredClone(body);
    const request = notificationRequest(channel, body);
    assert.deepEqual(body, original);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.redirect, 'manual');
    assert.equal(request.options.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), original);
  }
});

test('injects fixed custom headers and bearer credentials, never accepts header smuggling', () => {
  const channel = { provider: 'custom', url: targets.custom, headers: { 'X-Synthetic-Auth': 'example', Authorization: 'old', 'Content-Type': 'text/plain' }, token: 'synthetic-token' };
  const before = structuredClone(channel);
  const request = notificationRequest(channel, bodies.custom);
  assert.equal(request.options.headers['x-synthetic-auth'], 'example');
  assert.equal(request.options.headers.authorization, 'Bearer synthetic-token');
  assert.equal(request.options.headers['content-type'], 'application/json');
  assert.deepEqual(channel, before);
  for (const name of ['Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Keep-Alive', 'TE', 'Trailer', 'Upgrade', 'Proxy-Authorization', 'Proxy-Connection', 'Expect', ':authority', 'invalid name', 'x\r\ninjected']) {
    invalid(() => notificationRequest({ ...channel, headers: { [name]: 'value' } }, bodies.custom));
  }
  for (const value of ['value\r\nx-evil: yes', 'value\n', 123, null]) {
    invalid(() => notificationRequest({ ...channel, headers: { 'x-example': value } }, bodies.custom));
  }
  invalid(() => notificationRequest({ ...channel, token: 'bad\r\ntoken' }, bodies.custom));
  invalid(() => notificationRequest({ ...channel, headers: [] }, bodies.custom));
});

// Expected signatures generated once with the independent Python snippets in the
// official vendor docs, not Node crypto or notificationRequest. Synthetic secret:
// 'this is secret'; epoch: 1599360473000 milliseconds.
// Feishu: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
// DingTalk: https://open.dingtalk.com/document/dingstart/customize-robot-security-settings
test('Feishu uses seconds and HMAC with timestamp-newline-secret as key and empty data', () => {
  const body = { ...bodies.feishu, timestamp: 'model-time', sign: 'model-sign' };
  const before = structuredClone(body);
  const request = notificationRequest({ provider: 'feishu', url: targets.feishu, signingSecret: 'this is secret' }, body, { now: 1599360473999 });
  assert.deepEqual(JSON.parse(request.options.body), { ...bodies.feishu, timestamp: '1599360473', sign: '/eYKrXQBzTjUZJ3s6NX16VxGbTwmK7AEs8/FnvC1CSw=' });
  assert.deepEqual(body, before);
  const unsigned = notificationRequest({ provider: 'feishu', url: targets.feishu }, body);
  assert.deepEqual(JSON.parse(unsigned.options.body), bodies.feishu);
});

test('DingTalk signs milliseconds with secret as key and appends encoded query values', () => {
  const request = notificationRequest({ provider: 'dingtalk', url: `${targets.dingtalk}&timestamp=old&sign=old&sign=duplicate`, signingSecret: 'this is secret' }, bodies.dingtalk, { now: 1599360473000 });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('access_token'), 'synthetic-token');
  assert.equal(url.searchParams.get('timestamp'), '1599360473000');
  assert.equal(url.searchParams.get('sign'), 'hXZTWifRGHclNuZSKxoXc//sh51SWfVfRIhcdeKs63I=');
  assert.equal(url.searchParams.getAll('sign').length, 1);
  assert.ok(request.url.includes('sign=hXZTWifRGHclNuZSKxoXc%2F%2Fsh51SWfVfRIhcdeKs63I%3D'));
  assert.deepEqual(JSON.parse(request.options.body), bodies.dingtalk);
});

test('Discord forces confirmation while preserving thread routing', () => {
  const request = notificationRequest({ provider: 'discord', url: `${targets.discord}?wait=false&wait=false&thread_id=123` }, bodies.discord);
  const url = new URL(request.url);
  assert.deepEqual(url.searchParams.getAll('wait'), ['true']);
  assert.equal(url.searchParams.get('thread_id'), '123');
});

test('rejects malformed native bodies and non-JSON or oversized messages before transport', () => {
  for (const provider of notificationProviders) {
    for (const body of [null, [], 'text', 42, { nested: undefined }, { nested: NaN }, { nested: 1n }]) {
      invalid(() => notificationRequest({ provider, url: targets[provider] }, body));
    }
  }
  for (const provider of notificationProviders.filter(p => p !== 'custom')) invalid(() => notificationRequest({ provider, url: targets[provider] }, {}));
  invalid(() => notificationRequest({ provider: 'feishu', url: targets.feishu }, { msg_type: 'text' }));
  invalid(() => notificationRequest({ provider: 'wecom', url: targets.wecom }, { msgtype: 'text' }));
  invalid(() => notificationRequest({ provider: 'dingtalk', url: targets.dingtalk }, { msgtype: 'text' }));
  const circular = {}; circular.self = circular;
  invalid(() => notificationRequest({ provider: 'custom', url: targets.custom }, circular));
  invalid(() => notificationRequest({ provider: 'custom', url: targets.custom }, { text: 'x'.repeat(256 * 1024) }));
  invalid(() => notificationRequest({ provider: 'feishu', url: targets.feishu }, { msg_type: 'text', content: { text: 'x'.repeat(21 * 1024) } }));
});

test('permits vendor-native card, block and component payloads', () => {
  for (const [provider, body] of [
    ['feishu', { msg_type: 'interactive', card: { elements: [] } }],
    ['wecom', { msgtype: 'markdown', markdown: { content: 'example' } }],
    ['dingtalk', { msgtype: 'actionCard', actionCard: { title: 'example', text: 'example' } }],
    ['slack', { blocks: [{ type: 'section', text: { type: 'plain_text', text: 'example' } }] }],
    ['discord', { embeds: [{ title: 'example' }] }],
    ['discord', { flags: 32768, components: [{ type: 10, content: 'example' }] }],
  ]) assert.deepEqual(JSON.parse(notificationRequest({ provider, url: targets[provider] }, body).options.body), body);
});

test('requires successful vendor business codes and distinguishes unconfirmed responses', () => {
  for (const provider of ['feishu', 'wecom', 'dingtalk']) {
    const field = provider === 'feishu' ? 'code' : 'errcode';
    assert.equal(notificationOutcome(provider, 200, JSON.stringify({ [field]: 0 })).status, 'accepted');
    assert.deepEqual(notificationOutcome(provider, 200, JSON.stringify({ [field]: 12345, msg: 'synthetic rejection' })), { status: 'rejected', provider_code: 12345, summary: 'Webhook provider rejected the message (12345).' });
    for (const response of ['', 'not-json', '{}', 'null', '[]']) assert.equal(notificationOutcome(provider, 200, response).status, 'unknown');
  }
  assert.equal(notificationOutcome('feishu', 200, '{"StatusCode":0}').status, 'accepted');
  assert.equal(notificationOutcome('feishu', 200, '{"code":19021,"StatusCode":0}').status, 'rejected');
  assert.equal(notificationOutcome('feishu', 200, '{"code":0,"StatusCode":19021}').status, 'rejected');
});

test('recognizes Slack plain ok and confirmed Discord message objects', () => {
  assert.equal(notificationOutcome('slack', 200, 'ok').status, 'accepted');
  assert.equal(notificationOutcome('slack', 200, 'ok\n').status, 'accepted');
  assert.equal(notificationOutcome('slack', 200, 'invalid_payload').status, 'rejected');
  assert.equal(notificationOutcome('slack', 200, '').status, 'unknown');
  assert.equal(notificationOutcome('discord', 200, '{"id":"123456789012345678","channel_id":"123456789012345679","content":"example"}').status, 'accepted');
  assert.equal(notificationOutcome('discord', 200, '{"code":50035,"message":"Invalid Form Body"}').status, 'rejected');
  for (const response of ['', '{}', '{"id":"123"}', '{"id":"not-a-snowflake","channel_id":"123"}']) assert.equal(notificationOutcome('discord', 200, response).status, 'unknown');
  assert.equal(notificationOutcome('discord', 204, '').status, 'unknown');
});

test('custom accepts 2xx, all providers reject explicit HTTP failures, and summaries stay bounded', () => {
  for (const status of [200, 201, 204, 299]) assert.equal(notificationOutcome('custom', status, '').status, 'accepted');
  for (const provider of notificationProviders) {
    for (const status of [301, 400, 401, 429, 500]) assert.equal(notificationOutcome(provider, status, 'secret body').status, 'rejected');
    for (const status of [0, undefined, NaN]) assert.equal(notificationOutcome(provider, status, '').status, 'unknown');
    assert.ok(notificationOutcome(provider, 200, 'x'.repeat(100000)).summary.length <= 512);
  }
  const outcome = notificationOutcome('custom', 200, 'See https://receiver.example/private?token=synthetic-secret Authorization: Bearer synthetic-secret');
  assert.equal(outcome.status, 'accepted');
  assert.ok(!outcome.summary.includes('synthetic-secret'));
  assert.ok(!outcome.summary.includes('https://receiver.example'));
});

test('invalid targets and headers never expose saved credentials in thrown errors', () => {
  for (const call of [
    () => validateNotificationTarget('feishu', 'https://receiver.example/private?secret=synthetic-secret'),
    () => notificationRequest({ provider: 'custom', url: targets.custom, headers: { host: 'synthetic-secret' } }, {}),
  ]) assert.throws(call, error => error instanceof HttpError && !String(error).includes('synthetic-secret'));
});

test('custom response summaries redact credential fields inside JSON and quoted text', () => {
  const outcome = notificationOutcome('custom', 200, '{"token":"synthetic-token","password":"synthetic-password","api_key": "synthetic-key","message":"received"}');
  for (const secret of ['synthetic-token', 'synthetic-password', 'synthetic-key']) assert.ok(!outcome.summary.includes(secret));
  assert.ok(outcome.summary.includes('received'));
});
