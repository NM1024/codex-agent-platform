import { createHmac } from 'node:crypto';
import { HttpError } from '../errors.mjs';
import { validateUrl } from '../config.mjs';

export const notificationProviders = Object.freeze(['feishu', 'wecom', 'dingtalk', 'slack', 'discord', 'custom']);
const maxBodyBytes = 256 * 1024;
const maxSummaryLength = 512;
const reservedHeaders = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'expect', 'proxy-connection']);
const formats = {
  feishu: {
    instructions: 'Send native Feishu/Lark bot JSON. Use msg_type with content (text, post, share_chat, etc.) or card for interactive messages. Text: {msg_type:"text",content:{text:"..."}}. Maximum 20 KiB. The platform controls timestamp/sign and adds configured signatures; do not provide credentials or signing fields.',
    example: { msg_type: 'text', content: { text: 'Synthetic notification example' } },
  },
  wecom: {
    instructions: 'Send native WeCom group robot JSON with msgtype and its matching payload object, such as text.content, markdown.content, news or template_card. The platform supplies the saved Webhook target and authentication.',
    example: { msgtype: 'text', text: { content: 'Synthetic notification example' } },
  },
  dingtalk: {
    instructions: 'Send native DingTalk robot JSON with msgtype and its matching payload object, such as text.content, markdown, link, actionCard or feedCard. The platform supplies access credentials and optional timestamp/sign URL parameters. Do not provide credentials or signatures.',
    example: { msgtype: 'text', text: { content: 'Synthetic notification example' } },
  },
  slack: {
    instructions: 'Send native Slack incoming Webhook JSON with text, blocks or attachments. A text fallback helps accessibility for rich messages. The platform supplies the saved Webhook target. An accepted response means Slack returned its plain-text ok confirmation.',
    example: { text: 'Synthetic notification example' },
  },
  discord: {
    instructions: 'Send native Discord execute-Webhook JSON with content, embeds, components or poll. Respect Discord limits, including 2000 content characters. Use allowed_mentions to control mentions. The platform forces wait=true for confirmation and supplies the saved target. File uploads are not supported.',
    example: { content: 'Synthetic notification example', allowed_mentions: { parse: [] } },
  },
  custom: {
    instructions: 'Send a native JSON object matching the receiving application protocol. The platform POSTs JSON to the saved target and injects configured authentication headers or Bearer token. HTTP 2xx is accepted; inspect the bounded response summary when your protocol needs further checks.',
    example: { event: 'synthetic-notification', message: 'Synthetic notification example' },
  },
};

function invalid(message = 'Invalid notification configuration or message.') {
  return new HttpError(400, 'INVALID_NOTIFICATION', message);
}

function providerKnown(provider) {
  if (!notificationProviders.includes(provider)) throw invalid('Unsupported notification provider.');
}

export function validateNotificationTarget(provider, raw) {
  providerKnown(provider);
  let url;
  try {
    if (typeof raw !== 'string' || /[\u0000-\u0020\u007f]/.test(raw)) throw invalid();
    validateUrl(raw, 'notification target');
    url = new URL(raw);
  } catch {
    throw invalid('Invalid notification Webhook target.');
  }
  if (provider === 'custom') return raw;
  if (url.protocol !== 'https:' || url.port) throw invalid('Invalid notification Webhook target.');
  const segment = '[A-Za-z0-9_.~-]+';
  let valid = false;
  switch (provider) {
    case 'feishu':
      valid = ['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) && new RegExp(`^/open-apis/bot/v2/hook/${segment}$`).test(url.pathname);
      break;
    case 'wecom':
      valid = url.hostname === 'qyapi.weixin.qq.com' && url.pathname === '/cgi-bin/webhook/send' && hasCredential(url, 'key');
      break;
    case 'dingtalk':
      valid = url.hostname === 'oapi.dingtalk.com' && url.pathname === '/robot/send' && hasCredential(url, 'access_token');
      break;
    case 'slack':
      valid = ['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname) && new RegExp(`^/services/${segment}/${segment}/${segment}$`).test(url.pathname);
      break;
    case 'discord':
      valid = ['discord.com', 'discordapp.com'].includes(url.hostname) && new RegExp(`^/api(?:/v[0-9]+)?/webhooks/[0-9]+/${segment}$`).test(url.pathname);
      break;
  }
  if (!valid) throw invalid('Invalid notification provider Webhook host or path.');
  return raw;
}

function hasCredential(url, field) {
  const values = url.searchParams.getAll(field);
  return values.length === 1 && values[0].trim().length > 0;
}

export function notificationFormat(provider) {
  providerKnown(provider);
  return structuredClone(formats[provider]);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function checkJson(value, seen = new Set(), depth = 0) {
  if (depth > 64) throw invalid('Notification JSON nesting is too deep.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !object(value)) throw invalid('Notification body must contain only JSON values.');
  if (seen.has(value)) throw invalid('Notification body must contain only JSON values.');
  seen.add(value);
  for (const item of Object.values(value)) checkJson(item, seen, depth + 1);
  // Sparse arrays silently become null during JSON serialization.
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw invalid('Notification body must contain only JSON values.');
  seen.delete(value);
}

function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function items(value) { return Array.isArray(value) && value.length > 0; }

function checkBody(provider, body) {
  if (!object(body)) throw invalid('Notification body must be a JSON object.');
  checkJson(body);
  let valid = true;
  switch (provider) {
    case 'feishu': valid = nonempty(body.msg_type) && object(body.msg_type === 'interactive' ? body.card : body.content); break;
    case 'wecom':
    case 'dingtalk': valid = nonempty(body.msgtype) && Object.hasOwn(body, body.msgtype) && object(body[body.msgtype]); break;
    case 'slack': valid = nonempty(body.text) || items(body.blocks) || items(body.attachments); break;
    case 'discord': valid = nonempty(body.content) || items(body.embeds) || items(body.components) || object(body.poll); break;
  }
  if (!valid) throw invalid('Notification body is missing required provider message fields.');
}

function requestHeaders(channel) {
  const result = {};
  if (channel.headers !== undefined && !object(channel.headers)) throw invalid('Invalid notification headers.');
  for (const [rawName, value] of Object.entries(channel.headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName) || reservedHeaders.has(name) || name.startsWith('proxy-') || name.startsWith('sec-') || typeof value !== 'string' || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) {
      throw invalid('Invalid or reserved notification header.');
    }
    result[name] = value;
  }
  if (channel.token !== undefined && (typeof channel.token !== 'string' || /[\u0000-\u0020\u007f]/.test(channel.token))) throw invalid('Invalid notification Bearer token.');
  if (channel.token) result.authorization = `Bearer ${channel.token}`;
  result['content-type'] = 'application/json';
  return result;
}

export function notificationRequest(channel, body, { now = Date.now() } = {}) {
  if (!object(channel)) throw invalid();
  const { provider, signingSecret } = channel;
  const url = new URL(validateNotificationTarget(provider, channel.url));
  checkBody(provider, body);
  const headers = requestHeaders(channel);
  if (signingSecret !== undefined && typeof signingSecret !== 'string') throw invalid('Invalid notification signing secret.');
  let outgoing = body;
  if (provider === 'feishu') {
    const { timestamp: ignoredTimestamp, sign: ignoredSign, ...native } = body;
    outgoing = native;
    if (signingSecret) {
      if (!Number.isSafeInteger(now) || now < 0) throw invalid('Invalid notification signing timestamp.');
      const timestamp = String(Math.floor(now / 1000));
      // Feishu signs empty data using timestamp + newline + secret as the KEY.
      const sign = createHmac('sha256', `${timestamp}\n${signingSecret}`).update('').digest('base64');
      outgoing = { ...native, timestamp, sign };
    }
  }
  if (provider === 'dingtalk' && signingSecret) {
    if (!Number.isSafeInteger(now) || now < 0) throw invalid('Invalid notification signing timestamp.');
    const timestamp = String(now);
    // DingTalk instead uses secret as KEY and timestamp + newline + secret as DATA.
    const sign = createHmac('sha256', signingSecret).update(`${timestamp}\n${signingSecret}`).digest('base64');
    url.searchParams.set('timestamp', timestamp);
    url.searchParams.set('sign', sign);
  }
  if (provider === 'discord') url.searchParams.set('wait', 'true');
  const encoded = JSON.stringify(outgoing);
  if (Buffer.byteLength(encoded) > (provider === 'feishu' ? 20 * 1024 : maxBodyBytes)) throw invalid('Notification body exceeds the size limit.');
  return { url: url.toString(), options: { method: 'POST', headers, body: encoded, redirect: 'manual' } };
}

function result(status, provider_code, summary) { return { status, provider_code, summary }; }
function codeValue(code) {
  if (Number.isSafeInteger(code)) return code;
  if (typeof code === 'string' && /^-?[0-9]{1,16}$/.test(code)) return code;
  return null;
}
function safeSummary(text) {
  return text.slice(0, 4096)
    .replace(/https?:\/\/[^\s<>"']+/gi, '[redacted URL]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/(["'](?:token|secret|password|authorization|api[_-]?key|access[_-]?key)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi, '$1"[redacted]"')
    .replace(/\b(token|secret|password|authorization|api[_-]?key|access[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, maxSummaryLength);
}

export function notificationOutcome(provider, httpStatus, responseText) {
  providerKnown(provider);
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) return result('unknown', null, 'No confirmed Webhook response.');
  if (httpStatus < 200 || httpStatus >= 300) return result('rejected', null, `Webhook returned HTTP ${httpStatus}.`);
  const text = typeof responseText === 'string' ? responseText : '';
  if (provider === 'custom') return result('accepted', null, safeSummary(text) || 'Webhook accepted the message.');
  if (provider === 'slack') {
    const plain = text.trim();
    if (plain === 'ok') return result('accepted', null, 'Slack accepted the message.');
    if (plain) return result('rejected', /^[a-z_]{1,80}$/.test(plain) ? plain : null, 'Slack did not return its ok confirmation.');
    return result('unknown', null, 'Slack response did not confirm acceptance.');
  }
  // Avoid parsing unbounded response strings in this pure protocol adapter.
  let data;
  if (text.length <= 64 * 1024) {
    try { data = JSON.parse(text); } catch { /* An unrecognized success response is uncertain. */ }
  }
  if (!object(data)) return result('unknown', null, 'Webhook response did not confirm acceptance.');
  let code;
  if (provider === 'discord') {
    code = codeValue(data.code);
    if (code !== null) return result('rejected', code, `Webhook provider rejected the message (${code}).`);
    if (httpStatus === 200 && typeof data.id === 'string' && /^[0-9]+$/.test(data.id) && typeof data.channel_id === 'string' && /^[0-9]+$/.test(data.channel_id)) return result('accepted', null, 'Discord confirmed the created message.');
    return result('unknown', null, 'Discord response did not confirm a created message.');
  }
  if (provider === 'feishu') {
    // Either historical or modern code is supported; conflicting codes fail closed.
    const codes = [data.code, data.StatusCode].map(codeValue).filter(value => value !== null);
    code = codes.find(value => Number(value) !== 0) ?? codes[0] ?? null;
  } else code = codeValue(data.errcode);
  if (code === null) return result('unknown', null, 'Webhook response did not include a provider result code.');
  return Number(code) === 0 ? result('accepted', code, 'Webhook provider accepted the message.') : result('rejected', code, `Webhook provider rejected the message (${code}).`);
}
