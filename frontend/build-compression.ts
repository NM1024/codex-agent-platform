import {readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {brotliCompress,gzip,constants} from 'node:zlib';
import type {Plugin} from 'vite';

const br=promisify(brotliCompress),gz=promisify(gzip);
// Only public, content-hashed resources are compressed. Nonce HTML stays private.
// Spend compression effort at build time to keep added UI out of the download budget.
export function compressedAssets():Plugin {
  let output:string;
  return {
    name:'admin-compressed-assets',apply:'build',
    configResolved(config){output=resolve(config.root,config.build.outDir,'assets');},
    async closeBundle(){
      await Promise.all((await readdir(output)).filter(file=>/\.(?:js|css)$/.test(file)).map(async file=>{
        const data=await readFile(resolve(output,file));
        const [gzipData,brData]=await Promise.all([gz(data,{level:9}),br(data,{params:{[constants.BROTLI_PARAM_QUALITY]:9}})]);
        await Promise.all([writeFile(resolve(output,file+'.gz'),gzipData),writeFile(resolve(output,file+'.br'),brData)]);
      }));
    },
  };
}
