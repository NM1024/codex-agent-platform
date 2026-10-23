// Assemble generic capabilities, plugin examples and live configuration.
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { BusinessRegistry } from './core/registry.mjs';
import { createPlatformCatalog } from './platform.mjs';
import { loadTargets,httpConfiguration } from './capabilities/config.mjs';
import { ConfigurationStore } from './configuration/store.mjs';
import { executionScope } from './configuration/execution.mjs';

export function createApplication(role, env = process.env) {
  const config = loadConfig(role, env);
  config.clientId = 'default';
  const catalog = createPlatformCatalog({ workspace: config.workspace, targets: {} });
  catalog.requirePluginConnections=true;
  catalog.connectionForbiddenTokens=[config.runnerToken,env.INGRESS_TOKEN].filter(Boolean);
  const registry = new BusinessRegistry([], catalog);
  registry.initialDefinitions = ['content.review', 'novel.illustrated'].map(name =>
    JSON.parse(readFileSync(new URL(`./plugins/examples/${name}.json`, import.meta.url), 'utf8')));
  return {
    config, registry,
    configuration: store => {
      const settings = new ConfigurationStore(store.db, [
      executionScope({ store, config }),
      httpConfiguration(catalog.targets,{name:'http_targets',initialTargets:()=>loadTargets(env)}),
      ]);
      store.plugins.reload();
      return settings;
    },
  };
}
