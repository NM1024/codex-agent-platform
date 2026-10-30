import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readdir,realpath} from 'node:fs/promises';
import {resolve,relative,sep,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HttpError} from '../errors.mjs';

// Deployment-owned source only. Never point this reader at a runtime volume.
const directories=['src/manager','src/contracts','src/configuration','src/codex','src/notifications','frontend/src','prompts','docs'];
const files=['README.md','README.zh-CN.md','package.json','Dockerfile','frontend/vite.config.ts','frontend/tsconfig.json',
  'src/main-manager.mjs','src/prompts.mjs','src/config.mjs','src/errors.mjs','src/files.mjs','src/http.mjs'];
const extensions=new Set(['.mjs','.ts','.tsx','.css','.md']);
const excluded=new Set(['node_modules','web-dist','dist','build','coverage']);
const maxFileBytes=256*1024,maxSourceBytes=8*1024*1024,maxOutputChars=24000;
const error=(code,status=400)=>new HttpError(status,code);
const safePath=path=>typeof path==='string'&&path.length<=400&&!path.includes('\\')&&!path.includes('\0')&&
  (path===''||path.split('/').every(part=>part&&!part.startsWith('.')&&!excluded.has(part)));
const allowedFile=path=>files.includes(path)||(directories.some(dir=>path.startsWith(dir+'/'))&&extensions.has(extname(path)));
const allowedPrefix=path=>path===''||[...directories,...files].some(entry=>entry===path||entry.startsWith(path+'/')||path.startsWith(entry+'/'));

export function createProjectSourceReader(sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..')) {
  return async function projectSource({mode,path='',query,offset=0,limit=mode==='search'?30:100}={}) {
    if(!['list','read','search'].includes(mode)||!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isSafeInteger(limit)||limit<1||limit>200||
      (mode==='search'&&(typeof query!=='string'||!query.trim()||query.length>200)))throw error('INVALID_SOURCE_QUERY');
    if(!safePath(path)||!allowedPrefix(path)||(mode==='read'&&!allowedFile(path)))throw error('SOURCE_PATH_DENIED',403);
    const root=await realpath(sourceRoot),entries=[];let scanned=0,totalBytes=0;
    async function visit(name) {
      if(!safePath(name))return;
      if(++scanned>2000)throw error('SOURCE_SCAN_LIMIT',413);
      const absolute=resolve(root,name),rel=relative(root,absolute);
      if(rel.startsWith('..'+sep)||rel==='..'||rel.startsWith(sep))throw error('SOURCE_PATH_DENIED',403);
      let info;
      try{info=await lstat(absolute);}catch(caught){if(caught.code==='ENOENT')return;throw caught;}
      if(info.isSymbolicLink())return;
      if(info.isDirectory()) {
        for(const child of (await readdir(absolute)).sort())await visit(name+'/'+child);
      } else if(info.isFile()&&allowedFile(name)&&info.nlink===1) {
        if(info.size>maxFileBytes){entries.push({path:name,bytes:info.size,unavailable:'SOURCE_FILE_TOO_LARGE'});return;}
        totalBytes+=info.size;if(totalBytes>maxSourceBytes)throw error('SOURCE_SCAN_LIMIT',413);
        // O_NOFOLLOW rejects final-component replacements; canonical path and inode
        // checks also reject a changed parent or file during the read.
        const handle=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
        try {
          const opened=await handle.stat();
          if(!opened.isFile()||opened.dev!==info.dev||opened.ino!==info.ino||await realpath(absolute)!==absolute)throw error('SOURCE_PATH_DENIED',403);
          const bytes=Buffer.alloc(maxFileBytes+1);let bytesRead=0;
          while(bytesRead<bytes.length) {
            const chunk=await handle.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);
            if(!chunk.bytesRead)break;
            bytesRead+=chunk.bytesRead;
          }
          if(bytesRead>maxFileBytes)throw error('SOURCE_FILE_TOO_LARGE',413);
          const content=bytes.subarray(0,bytesRead).toString('utf8');
          entries.push({path:name,bytes:bytesRead,content,sha256:createHash('sha256').update(bytes.subarray(0,bytesRead)).digest('hex')});
        } finally {await handle.close();}
      }
    }
    // Each allowlisted root is walked from its parents so even a symlinked
    // src/ or frontend/ directory cannot escape the deployed source tree.
    for(const entry of [...directories,...files]) {
      let parent=root,symlinked=false;
      for(const part of entry.split('/').slice(0,-1)) {
        parent=resolve(parent,part);
        try{if((await lstat(parent)).isSymbolicLink()){symlinked=true;break;}}
        catch(caught){if(caught.code==='ENOENT'){symlinked=true;break;}throw caught;}
      }
      if(!symlinked)await visit(entry);
    }
    entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const revision=createHash('sha256').update(JSON.stringify(entries.map(({path,bytes,sha256,unavailable})=>({path,bytes,sha256,unavailable})))).digest('hex');
    const base={source:'deployed-management-source',revision};
    const selected=entries.filter(entry=>!path||entry.path===path||entry.path.startsWith(path+'/'));
    if(mode==='list')return {...base,files:selected.slice(offset,offset+limit).map(({content,sha256,...entry})=>entry),total:selected.length,next_offset:offset+limit<selected.length?offset+limit:null};
    if(mode==='read') {
      const entry=selected.find(entry=>entry.path===path);
      if(!entry)throw error('SOURCE_FILE_NOT_FOUND',404);
      if(entry.unavailable)throw error(entry.unavailable,413);
      const lines=entry.content.split('\n'),page=[];let length=0,truncated=false;
      for(let index=offset;index<Math.min(lines.length,offset+limit);index++) {
        const line=`${index+1}: ${lines[index].slice(0,4000)}`;
        if(length+line.length+1>maxOutputChars)break;
        page.push(line);length+=line.length+1;if(lines[index].length>4000)truncated=true;
      }
      return {...base,path,start_line:offset+1,content:page.join('\n'),total_lines:lines.length,truncated,next_offset:offset+page.length<lines.length?offset+page.length:null};
    }
    const matches=[],needle=query.toLowerCase(),pageLimit=Math.min(limit,50);let total=0;
    for(const entry of selected) {
      if(entry.content===undefined)continue;
      for(const [index,line] of entry.content.split('\n').entries()) {
        const at=line.toLowerCase().indexOf(needle);
        if(at>=0) {
          if(total>=offset&&matches.length<pageLimit)matches.push({path:entry.path,line:index+1,text:line.slice(Math.max(0,at-120),at+needle.length+240)});
          total++;
        }
      }
    }
    return {...base,matches,total,next_offset:offset+matches.length<total?offset+matches.length:null,
      omitted_files:selected.filter(entry=>entry.unavailable).map(({path,unavailable})=>({path,reason:unavailable}))};
  };
}
