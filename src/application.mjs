// Assemble generic capabilities, plugin examples and live configuration.
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { BusinessRegistry } from './core/registry.mjs';
import { createPlatformCatalog } from './platform.mjs';
import { loadTargets, httpConfiguration } from './capabilities/config.mjs';
import { ConfigurationStore } from './configuration/store.mjs';
import { executionScope } from './configuration/execution.mjs';
import { HttpError } from './errors.mjs';

export function createApplication(role, env = process.env) {
  const config = loadConfig(role, env);
  config.clientId = 'default';
  const catalog = createPlatformCatalog({ workspace: config.workspace, targets: loadTargets(env) });
  const registry = new BusinessRegistry([], catalog);
  registry.initialDefinitions = ['content.review', 'novel.illustrated'].map(name =>
    JSON.parse(readFileSync(new URL(`./plugins/examples/${name}.json`, import.meta.url), 'utf8')));
  return {
    config, registry,
    configuration: store => {
      const settings = new ConfigurationStore(store.db, [
      executionScope({ store, config }),
      {
        name: 'access', title: '外部 API 鉴权', description: '新密钥立即用于外部 API；Admin 使用独立密码。',
        schema: {
          type: 'object', additionalProperties: false, required: ['ingressToken'],
          properties: { ingressToken: { type: 'string', minLength: 1, writeOnly: true, title: '入口密钥' } },
        },
        defaults: { ingressToken: config.ingressToken ?? '' },
        validate(value) {
          if (!value.ingressToken.trim() || /[\r\n]/.test(value.ingressToken) || value.ingressToken === config.runnerToken)
            throw new HttpError(400, 'INVALID_CONFIGURATION', '入口密钥不能为空或与内部凭证相同。');
        },
        apply(value) { config.ingressToken = value.ingressToken; },
      },
      httpConfiguration(catalog.targets),
      ]);
      store.plugins.reload();
      return settings;
    },
  };
}
