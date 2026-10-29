import {join,resolve,relative,sep,basename,isAbsolute} from 'node:path';
import {readRegular} from '../files.mjs';
import {withImageWork} from './image-work.mjs';

const MAX_BYTES=20*1024*1024;
// Native output is accepted only from the current conversation's private roots.
// This adapter does not grant the Agent filesystem or command execution tools.
export class GeneratedChatImages {
  constructor({store,messageId,workDir,home}) {
    Object.assign(this,{store,messageId});this.roots=[workDir,join(home,'generated_images')];this.pending=Promise.resolve();
  }
  accept(item) {
    if(item?.type!=='imageGeneration'||item.status!=='completed'||item.failure||typeof item.id!=='string'||item.id.length>200)return;
    const id=item.id,savedPath=typeof item.savedPath==='string'?item.savedPath:null;
    this.pending=this.pending.then(async()=>{
      if(this.store.generatedImage(this.messageId,id))return;
      try {await withImageWork(async sharp=>{
        if(typeof savedPath!=='string')throw new Error('IMAGE_NOT_SAVED');
        const target=resolve(savedPath);
        const root=this.roots.find(root=>{const rel=relative(resolve(root),target);return rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);});
        if(!root)throw new Error('UNOWNED_IMAGE');
        const bytes=await readRegular(root,target,MAX_BYTES);
        const metadata=await sharp(bytes,{limitInputPixels:67108864}).metadata();
        if(!['png','jpeg','webp'].includes(metadata.format)||!metadata.width||!metadata.height)throw new Error('INVALID_IMAGE');
        // Decode the pixels as well as the header before accepting the file.
        await sharp(bytes,{limitInputPixels:67108864}).stats();
        this.store.saveGeneratedImage(this.messageId,id,{name:basename(target),mime:'image/'+metadata.format,width:metadata.width,height:metadata.height,size:bytes.length,bytes});
      },{retry:true});
      }catch {
        this.store.progress(this.messageId,{id:'image-save:'+id,kind:'status',label:'Image unavailable',text:'生成的图片未能保存，请重新发起图片请求。',status:'failed'});
      }
    });
  }
  drain(){return this.pending;}
}
