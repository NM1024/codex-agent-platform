import Ajv from 'ajv';

// Read-only schema presentation; it does not import or execute plugin runtime code.

const absent=Symbol('no-example');
function reference(schema,root) {
  if(!schema||typeof schema!=='object'||typeof schema.$ref!=='string')return schema;
  if(schema.$ref==='#')return root;
  if(!schema.$ref.startsWith('#/'))return null;
  try{return decodeURIComponent(schema.$ref.slice(2)).split('/').reduce((value,key)=>{key=key.replaceAll('~1','/').replaceAll('~0','~');return value&&Object.hasOwn(value,key)?value[key]:null;},root);}catch{return null;}
}
function sample(schema,root,depth=0,seen=new Set()) {
  if(depth>8||schema===false||schema===null)return absent;
  if(schema===true)return {};
  if(typeof schema!=='object')return absent;
  if(schema.$ref){
    if(seen.has(schema.$ref))return absent;
    const next=new Set([...seen,schema.$ref]),{$ref,...siblings}=schema;
    const base=sample(reference(schema,root),root,depth+1,next),extra=sample(siblings,root,depth+1,next);
    if(base===absent)return absent;
    return base&&extra&&typeof base==='object'&&typeof extra==='object'&&!Array.isArray(base)&&!Array.isArray(extra)?Object.fromEntries([...Object.entries(base),...Object.entries(extra)]):base;
  }
  for(const key of ['const','default'])if(Object.hasOwn(schema,key))return structuredClone(schema[key]);
  if(schema.examples?.length)return structuredClone(schema.examples[0]);
  if(schema.enum?.length)return structuredClone(schema.enum[0]);
  const alternatives=schema.oneOf??schema.anyOf;
  if(alternatives?.length)return sample({...schema,oneOf:undefined,anyOf:undefined,...alternatives[0]},root,depth+1,seen);
  if(schema.allOf?.length){
    const values=[sample({...schema,allOf:undefined},root,depth+1,seen),...schema.allOf.map(part=>sample(part,root,depth+1,seen))];
    if(values.some(value=>value===absent))return absent;
    return values.every(value=>value&&typeof value==='object'&&!Array.isArray(value))?Object.fromEntries(values.flatMap(value=>Object.entries(value))):values.at(-1);
  }
  const type=Array.isArray(schema.type)?schema.type.find(value=>value!=='null')??'null':schema.type??(schema.properties?'object':schema.items?'array':undefined);
  if(type==='object') {
    const entries=[];
    for(const [key,value] of Object.entries(schema.properties??{}).slice(0,100)){
      const candidate=sample(value,root,depth+1,seen);
      if(candidate===absent){if(schema.required?.includes(key))return absent;continue;}
      entries.push([key,candidate]);
    }
    return Object.fromEntries(entries);
  }
  if(type==='array'){
    if(Array.isArray(schema.items)){const values=schema.items.map(item=>sample(item,root,depth+1,seen));return values.includes(absent)?absent:values;}
    const count=schema.maxItems===0?0:Math.max(1,schema.minItems??0);if(count>8)return absent;
    const values=Array.from({length:count},()=>sample(schema.items??true,root,depth+1,seen));return values.includes(absent)?absent:values;
  }
  if(type==='string'){const length=Math.max(0,schema.minLength??0);if(length>512)return absent;return 'example'.padEnd(length,'x').slice(0,schema.maxLength??Math.max(7,length));}
  if(type==='integer'||type==='number'){
    let value=schema.minimum??(typeof schema.exclusiveMinimum==='number'?schema.exclusiveMinimum+(type==='integer'?1:0.5):Math.min(0,schema.maximum??0));
    if(type==='integer')value=Math.ceil(value);
    if(schema.multipleOf>0)value=Math.ceil(value/schema.multipleOf)*schema.multipleOf;
    return value;
  }
  if(type==='boolean')return false;
  if(type==='null')return null;
  return {};
}

export function schemaDocumentation(schema) {
  const rows=[],constraints=['$ref','enum','const','default','minLength','maxLength','pattern','format','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minItems','maxItems','uniqueItems','minProperties','maxProperties','additionalProperties','oneOf','anyOf','allOf','if','then','else'];
  function visit(source,path,required,depth=0,seen=new Set()) {
    if(depth>8||rows.length>=300)return;
    const resolved=reference(source,schema);let node=resolved&&typeof resolved==='object'?resolved:source;
    if(source?.$ref&&resolved&&typeof resolved==='object'){
      const {$ref,...siblings}=source;
      const properties=Object.fromEntries([...Object.entries(resolved.properties??{}),...Object.entries(source.properties??{}).map(([key,value])=>[key,Object.hasOwn(resolved.properties??{},key)?{allOf:[resolved.properties[key],value],description:value?.description??resolved.properties[key]?.description}:value])]);
      node={...resolved,...siblings,properties,required:[...new Set([...(resolved.required??[]),...(source.required??[])])]};
      // Referenced and sibling assertions both apply; retain both instead of pretending an override weakens a constraint.
      if(Object.keys(siblings).some(key=>!['description','title','examples','default','$comment','readOnly','writeOnly','deprecated'].includes(key)))node.allOf=[resolved,siblings];
    }
    const type=node?.type??(node?.properties?'object':node?.items?'array':typeof node==='boolean'?String(node):node?.$ref?'$ref':'any');
    rows.push({path,type:Array.isArray(type)?type.join(' | '):type,required,description:typeof node?.description==='string'?node.description:'',constraints:Object.fromEntries(constraints.filter(key=>source&&Object.hasOwn(source,key)||node&&Object.hasOwn(node,key)).map(key=>[key,source?.[key]??node?.[key]]))});
    if(!node||typeof node!=='object'||source?.$ref&&seen.has(source.$ref))return;
    const next=source?.$ref?new Set([...seen,source.$ref]):seen;
    for(const [key,value] of Object.entries(node.properties??{}))visit(value,path?path+'.'+key:key,!!node.required?.includes(key),depth+1,next);
    if(node.items&&!Array.isArray(node.items))visit(node.items,path+'[]',null,depth+1,next);
  }
  visit(schema,'',true);
  const candidates=[...(schema?.examples??[]),...(Object.hasOwn(schema??{},'default')?[schema.default]:[]),sample(schema,schema)];
  let value=null,available=false;
  try {
    const validate=new Ajv({strict:true}).compile(schema);
    for(const candidate of candidates)if(candidate!==absent&&validate(candidate)){value=structuredClone(candidate);available=true;break;}
  }catch{/* Complete schema remains available when references/dialects prevent a safe example. */}
  return {rows,example:{available,value},schema};
}
