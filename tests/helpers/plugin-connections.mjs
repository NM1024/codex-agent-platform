import {createHash} from 'node:crypto';

// Explicitly simulate human setup in tests; never expose this through Agent tools.
export function configurePlugin(store,type,patch={}) {
  const key=createHash('sha256').update('synthetic-test-only:'+type).digest('hex');
  if(store.pluginConnections){store.pluginConnections.update(type,{entryKey:key,...patch});store.plugins.setEnabled(type,true);}
  return key;
}
