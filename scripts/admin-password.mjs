import {join} from 'node:path';
import {ManagerStore} from '../src/manager/store.mjs';
import {AdminAuth} from '../src/manager/auth.mjs';
let store;
try {
  let password='';for await(const chunk of process.stdin){password+=chunk.toString('utf8');if(password.length>1024)throw new Error('INVALID_PASSWORD');}
  store=new ManagerStore(join(process.env.MANAGER_DATA_DIR ?? '/management','manager.sqlite'));
  const auth=new AdminAuth(store.db);if(auth.initialized)await auth.setPassword(password);else await auth.initialize(password);
  console.log(JSON.stringify({updated:true,sessions_revoked:true}));
}catch{console.error('Admin password update failed. Supply 12–1024 characters on stdin.');process.exitCode=1;}
finally{store?.close();}
