import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function dependencyManifests(pkg,lock){
 const normalizedPackage=structuredClone(pkg),normalizedLock=structuredClone(lock);
 normalizedPackage.version='0.0.0';normalizedLock.version='0.0.0';
 if(normalizedLock.packages?.[''])normalizedLock.packages[''].version='0.0.0';
 return [normalizedPackage,normalizedLock];
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const paths=['package.json','package-lock.json'],values=dependencyManifests(...paths.map(path=>JSON.parse(readFileSync(path,'utf8'))));
 paths.forEach((path,index)=>writeFileSync(path,JSON.stringify(values[index],null,2)+'\n'));
}
