import {setTimeout as delay} from 'node:timers/promises';
import {HttpError} from '../errors.mjs';

// Share one native decoder across uploads and generated files. Waiting uploads
// retain at most their existing 1 MiB request envelope, never decoded pixels.
const MAX_WAITING=8,WAIT_MS=30000;
let active=false,sharpPromise;const waiting=[];
const busy=()=>new HttpError(503,'IMAGE_PROCESSING_BUSY','图片正在处理中，请稍后重试。');
function acquire() {
  if(!active){active=true;return Promise.resolve();}
  if(waiting.length>=MAX_WAITING)return Promise.reject(busy());
  return new Promise((resolve,reject)=>{
    const entry={resolve:()=>{clearTimeout(entry.timer);resolve();}};
    entry.timer=setTimeout(()=>{const index=waiting.indexOf(entry);if(index!==-1)waiting.splice(index,1);reject(busy());},WAIT_MS);
    waiting.push(entry);
  });
}
function release() {const next=waiting.shift();if(next)next.resolve();else active=false;}
function imageLibrary() {
  return sharpPromise??=import('sharp').then(({default:sharp})=>{
    sharp.cache({memory:8,files:0,items:16});sharp.concurrency(1);return sharp;
  });
}
export async function withImageWork(work,{retry=false}={}) {
  // Generated files are already accepted work. Retry admission using only their
  // small file descriptors rather than dropping output when upload slots fill.
  while(true) {
    try {await acquire();break;}
    catch(error){if(!retry||error.code!=='IMAGE_PROCESSING_BUSY')throw error;await delay(100);}
  }
  try {return await work(await imageLibrary());}finally{release();}
}
