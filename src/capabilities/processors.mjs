import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { readRegular, safeDirectory } from '../files.mjs';

export const sourceRoots=state=>[state.workDir,join(state.home,'generated_images')];
export async function saveArtifact(body,{state,workspace}) {
  if (state.completed || state.ending) throw new Error('TASK_CLOSED');
  if (!/^[a-f0-9-]{36}$/.test(body.artifact_id)) throw new Error('UNSAFE_PATH');
  const root=join(workspace,'artifacts',state.run.run_id);await safeDirectory(root);
  let bytes,mime,extension,preview;
  if (body.name==='write_text_artifact') {
    if (typeof body.filename!=='string' || !/^[a-zA-Z0-9_\u4e00-\u9fff][a-zA-Z0-9_.\u4e00-\u9fff-]*$/.test(body.filename) || typeof body.text!=='string') throw new Error('UNSAFE_PATH');
    bytes=Buffer.from(body.text,'utf8');mime='text/plain; charset=utf-8';extension='txt';
  } else {
    let source;
    for (const dir of sourceRoots(state)) {
      try {source=await readRegular(dir,body.source_path);break;}
      catch(error) {if (error.message!=='UNSAFE_PATH') throw error;}
    }
    if (!source) throw new Error('UNSAFE_PATH');
    const format=body.format ?? 'jpeg';
    if (!['jpeg','png','webp'].includes(format)) throw new Error('INVALID_IMAGE_FORMAT');
    let image=sharp(source,{limitInputPixels:67108864});
    const metadata=await image.metadata();
    const width=body.width ?? (body.height?Math.ceil(metadata.width*body.height/metadata.height):metadata.width),height=body.height ?? (body.width?Math.ceil(metadata.height*body.width/metadata.width):metadata.height);
    if (!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>67108864) throw new Error('INVALID_IMAGE_DIMENSIONS');
    if (body.width || body.height) image=image.resize(body.width ?? null,body.height ?? null,{fit:'cover'});
    bytes=await image.toFormat(format,{quality:body.quality ?? 85}).toBuffer();
    if(bytes.length>32*1024*1024)throw new Error('ARTIFACT_TOO_LARGE');
    preview=await sharp(bytes).resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).jpeg({quality:75}).toBuffer();
    mime=`image/${format}`;extension=format==='jpeg'?'jpg':format;
  }
  if (state.completed || state.ending) throw new Error('TASK_CLOSED');
  const path=join(root,`${body.artifact_id}.${extension}`);await writeFile(path,bytes,{flag:'wx',mode:0o600});
  return {artifact_id:body.artifact_id,path,mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),filename:body.filename ?? `${body.artifact_id}.${extension}`,
    ...(body.name==='register_image'?{preview:preview.toString('base64'),preview_mime:'image/jpeg'}:{}),run_id:state.run.run_id};
}
