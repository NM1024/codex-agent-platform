import test from 'node:test';
import assert from 'node:assert/strict';
import {partitionChatAttachments} from '../frontend/src/chat-attachments.ts';

const png=Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);
const jpeg=Uint8Array.from([0xff,0xd8,0xff,0xe0,1,2,3,4,5,6,7,8]);
const webp=Uint8Array.from([0x52,0x49,0x46,0x46,4,0,0,0,0x57,0x45,0x42,0x50]);

test('mixed attachment batches route each supported raster and preserve order within each group',async()=>{
  const first=new File([png],'first.png',{type:'image/png'});
  const csv=new File(['name,count\nexample,1'],'data.csv',{type:'text/csv'});
  const second=new File([jpeg],'second.jpg',{type:'image/jpeg'});
  const third=new File([webp],'third.webp',{type:'image/webp'});
  const pdf=new File(['%PDF-1.7'],'notes.pdf',{type:'application/pdf'});
  const selected=[first,csv,second,third,pdf];
  const original=[...selected];
  const result=await partitionChatAttachments(selected);
  assert.deepEqual(result.images.map(file=>file.name),['first.png','second.jpg','third.webp']);
  assert.deepEqual(result.files,[csv,pdf]);
  assert.deepEqual(selected,original);
});

test('real signatures normalize missing, generic, incorrect and parameterized MIME without changing image content',async()=>{
  const cases=[
    [png,'no-type.bin','','image/png'],
    [jpeg,'generic.bin','application/octet-stream','image/jpeg'],
    [webp,'mislabeled.csv','text/csv','image/webp'],
    [png,'wrong-image.jpg','image/jpeg','image/png'],
    [jpeg,'parameters.jpg','IMAGE/JPEG; charset=binary','image/jpeg'],
  ];
  for(const [bytes,name,type,expectedType] of cases) {
    const original=new File([bytes],'original-'+name,{type,lastModified:1700000000123});
    const result=await partitionChatAttachments([original]);
    assert.equal(result.files.length,0,name);
    assert.equal(result.images.length,1,name);
    const [image]=result.images;
    assert.equal(image.type,expectedType,name);
    assert.equal(image.name,original.name,name);
    assert.equal(image.lastModified,1700000000123,name);
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()),bytes,name);
    assert.equal(original.type,type.toLowerCase(),name);
  }
});

test('invalid raster candidates remain on the image validation path from supported MIME or generic filename metadata',async()=>{
  const cases=[
    ['broken.dat','IMAGE/PNG; charset=binary','image/png'],
    ['broken.dat','image/jpeg','image/jpeg'],
    ['broken.dat','image/webp','image/webp'],
    ['broken.PNG','','image/png'],
    ['broken.JPEG','application/octet-stream','image/jpeg'],
    ['broken.jpg','application/octet-stream; charset=binary','image/jpeg'],
    ['broken.WeBp','','image/webp'],
  ];
  for(const [name,type,expectedType] of cases) {
    const source=new File(['invalid image bytes'],name,{type,lastModified:42});
    const {images,files}=await partitionChatAttachments([source]);
    assert.equal(files.length,0,name);
    assert.equal(images.length,1,name);
    assert.equal(images[0].type,expectedType,name);
    assert.equal(await images[0].text(),'invalid image bytes',name);
    assert.equal(images[0].name,name);
    assert.equal(images[0].lastModified,42);
  }
});

test('ordinary documents and unsupported image formats retain their original File objects',async()=>{
  const files=[
    new File(['GIF89a'],'animation.gif',{type:'image/gif'}),
    new File(['<svg/>'],'drawing.svg',{type:'image/svg+xml'}),
    new File(['GIF87a'],'animation.GIF'),
    new File(['<svg/>'],'drawing.svg'),
    new File(['text'],'text.png',{type:'text/plain'}),
    new File(['data'],'data.bin',{type:'application/octet-stream'}),
    new File(['ordinary filename'],'png'),
    new File(['ordinary filename'],'jpeg',{type:'application/octet-stream'}),
    new File(['report'],'report.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),
    new File(['%PDF-1.7'],'document.pdf',{type:'application/pdf'}),
  ];
  const result=await partitionChatAttachments(files);
  assert.deepEqual(result.images,[]);
  assert.equal(result.files.length,files.length);
  for(let index=0;index<files.length;index++) assert.equal(result.files[index],files[index]);
});

test('classification reads only a bounded header and never reads the complete source',async()=>{
  const reads=[];
  class HeaderOnlyFile extends File {
    arrayBuffer() { throw new Error('whole-file reads are forbidden'); }
    slice(start,end,type) {
      assert.equal(start,0);
      assert.ok(end<=12);
      reads.push([start,end]);
      return super.slice(start,end,type);
    }
  }
  const image=new HeaderOnlyFile([png,new Uint8Array(1024*1024)],'large.png');
  const document=new HeaderOnlyFile(['report'],'report.txt',{type:'text/plain'});
  const result=await partitionChatAttachments([image,document]);
  assert.equal(result.images[0]?.type,'image/png');
  assert.equal(result.files[0],document);
  assert.equal(reads.length,2);
});

test('empty batches stay empty and duplicate selections are retained',async()=>{
  assert.deepEqual(await partitionChatAttachments([]),{images:[],files:[]});
  const image=new File([png],'image.png',{type:'image/png'});
  const document=new File(['report'],'report.txt');
  const result=await partitionChatAttachments([image,document,image,document]);
  assert.deepEqual(result.images.map(file=>file.name),['image.png','image.png']);
  assert.deepEqual(result.files,[document,document]);
});
