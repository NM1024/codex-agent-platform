import {createHash} from 'node:crypto';
import {readSystemPrompt,renderSystemPrompt} from '../prompts.mjs';
import {DEFAULT_CONCURRENCY} from '../config.mjs';
import {managementTools} from '../contracts/management.mjs';

export function currentPlatformContext() {
  const instructions=[renderSystemPrompt('manager-project',{default_concurrency:DEFAULT_CONCURRENCY}),readSystemPrompt('manager-connections')].join('\n\n');
  const revision=createHash('sha256').update(instructions).update(JSON.stringify(managementTools)).digest('hex');
  return {revision,instructions};
}
