import { HttpError } from '../errors.mjs';
import {withImageWork} from './image-work.mjs';

const invalid=()=>new HttpError(400,'INVALID_IMAGES','最多上传四张 JPEG、PNG 或 WebP 图片，每张不超过 160 KiB，长边不超过 2048 像素。');
const formats={jpeg:'image/jpeg',png:'image/png',webp:'image/webp'};

// This is the server admission boundary. Never trust browser compression or MIME metadata.
export async function validateChatImages(attachments=[]) {
  if(!Array.isArray(attachments)||attachments.length>4)throw invalid();
  const images=[];
  for(const attachment of attachments) {
    if(!attachment||typeof attachment.name!=='string'||typeof attachment.dataUrl!=='string'||attachment.dataUrl.length>220000)throw invalid();
    const match=/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(attachment.dataUrl);
    if(!match)throw invalid();
    const bytes=Buffer.from(match[2],'base64');
    if(!bytes.length||bytes.length>160*1024||bytes.toString('base64')!==match[2])throw invalid();
    await withImageWork(async sharp=>{try {
      const decoder=sharp(bytes,{failOn:'warning',limitInputPixels:2048*2048,animated:true});
      const metadata=await decoder.metadata();
      if(formats[metadata.format]!==match[1]||!metadata.width||!metadata.height||metadata.width>2048||metadata.height>2048||(metadata.pages ?? 1)!==1)throw invalid();
      // Metadata parsing alone accepts truncated/corrupted compressed pixel streams.
      await decoder.stats();
      const name=attachment.name.replace(/[\u0000-\u001f\u007f/\\]/g,'_').slice(0,160)||'image';
      images.push({name,mime:match[1],width:metadata.width,height:metadata.height,size:bytes.length,bytes});
    }catch{throw invalid();}});
  }
  return images;
}
