import type {ChatImage} from './types';

const MAX_SOURCE=20*1024*1024, MAX_PIXELS=40_000_000, MAX_BYTES=160*1024;
// Read dimensions before decoding so oversized rasters never reach a canvas.
function dimensions(bytes:Uint8Array):[number,number] {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length>=24 && view.getUint32(0)===0x89504e47 && view.getUint32(4)===0x0d0a1a0a) return [view.getUint32(16),view.getUint32(20)];
  if(bytes.length>=30 && view.getUint32(0)===0x52494646 && view.getUint32(8)===0x57454250) {
    const kind=view.getUint32(12);
    if(kind===0x56503858) return [1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16),1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16)];
    if(kind===0x56503820 && bytes[23]===0x9d && bytes[24]===1 && bytes[25]===0x2a) return [view.getUint16(26,true)&0x3fff,view.getUint16(28,true)&0x3fff];
    if(kind===0x5650384c && bytes[20]===0x2f) {const bits=view.getUint32(21,true);return [(bits&0x3fff)+1,((bits>>>14)&0x3fff)+1];}
  }
  if(bytes.length>=4 && bytes[0]===0xff && bytes[1]===0xd8) {
    let offset=2;
    while(offset+4<=bytes.length) {
      if(bytes[offset++]!==0xff) break;
      while(bytes[offset]===0xff) offset++;
      const marker=bytes[offset++];
      if(marker===0xd9 || marker===0xda) break;
      if(marker===0x01 || marker>=0xd0 && marker<=0xd7) continue;
      if(offset+2>bytes.length) break;
      const length=view.getUint16(offset);
      if(length<2 || offset+length>bytes.length) break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length>=7) return [view.getUint16(offset+5),view.getUint16(offset+3)];
      offset+=length;
    }
  }
  throw new Error('图片格式无效，请选择 JPEG、PNG 或 WebP。');
}
export async function compressChatImage(file:File):Promise<ChatImage> {
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('图片格式无效，请选择 JPEG、PNG 或 WebP。');
  if(file.size>MAX_SOURCE) throw new Error('原始图片不能超过 20 MiB。');
  const bytes=new Uint8Array(await file.arrayBuffer());
  const [width,height]=dimensions(bytes);
  if(!width || !height || width*height>MAX_PIXELS) throw new Error('原始图片不能超过 4000 万像素。');
  let bitmap:ImageBitmap;
  try {bitmap=await createImageBitmap(file);} catch {throw new Error('图片格式无效，请选择 JPEG、PNG 或 WebP。');}
  try {
    let scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');
    for(let attempt=0;attempt<9;attempt++) {
      canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const context=canvas.getContext('2d');if(!context) throw new Error('无法压缩图片，请重试。');
      context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      for(const quality of [0.86,0.7,0.5,0.3]) {
        const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
        if(blob && blob.size<=MAX_BYTES) {
          const dataUrl=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('无法压缩图片，请重试。'));reader.readAsDataURL(blob);});
          return {id:crypto.randomUUID(),name:file.name,dataUrl,size:blob.size,width:canvas.width,height:canvas.height};
        }
      }
      scale*=0.75;
    }
    throw new Error('无法压缩图片，请重试。');
  } finally {bitmap.close();}
}
