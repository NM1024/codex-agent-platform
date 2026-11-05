function signatureMime(bytes:Uint8Array):string|undefined {
  if(bytes.length>=3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) return 'image/jpeg';
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length>=8 && view.getUint32(0)===0x89504e47 && view.getUint32(4)===0x0d0a1a0a) return 'image/png';
  if(bytes.length>=12 && view.getUint32(0)===0x52494646 && view.getUint32(8)===0x57454250) return 'image/webp';
}

function metadataMime(file:File):string|undefined {
  const mime=file.type.split(';',1)[0].trim().toLowerCase();
  if(['image/jpeg','image/png','image/webp'].includes(mime)) return mime;
  if(!mime || mime==='application/octet-stream') {
    const extension=/\.([^.]+)$/.exec(file.name)?.[1].toLowerCase();
    if(extension==='jpg' || extension==='jpeg') return 'image/jpeg';
    if(extension==='png') return 'image/png';
    if(extension==='webp') return 'image/webp';
  }
}

export async function partitionChatAttachments(selected:File[]):Promise<{images:File[];files:File[]}> {
  const images:File[]=[],files:File[]=[];
  for(const file of selected) {
    // Metadata is only a fallback: the existing image compressor validates the full raster.
    const mime=signatureMime(new Uint8Array(await file.slice(0,12).arrayBuffer())) || metadataMime(file);
    if(mime) images.push(file.type===mime?file:new File([file],file.name,{type:mime,lastModified:file.lastModified}));
    else files.push(file);
  }
  return {images,files};
}
