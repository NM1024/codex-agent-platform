import Ajv from 'ajv';
import {HttpError} from '../errors.mjs';

const child=(schema,key)=>schema.properties?.[key] ?? (typeof schema.additionalProperties==='object'?schema.additionalProperties:{});
const pointer=key=>key.replaceAll('~','~0').replaceAll('/','~1');
function visible(value,schema,paths,path='') {
  if(schema.writeOnly){if(value)paths.push(path);return undefined;}
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map((item,i)=>visible(item,schema.items ?? {},paths,`${path}/${i}`));
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visible(item,child(schema,key),paths,`${path}/${pointer(key)}`)]).filter(([,item])=>item!==undefined));
}
function preserveSecrets(next,previous,schema) {
  if(!next||typeof next!=='object'||Array.isArray(next))return next;
  const result={...next};
  for(const [key,old] of Object.entries(previous ?? {}))if(child(schema,key).writeOnly&&!Object.hasOwn(next,key))result[key]=old;
  for(const key of Object.keys(result))result[key]=preserveSecrets(result[key],previous?.[key],child(schema,key));
  return result;
}
export class ConfigurationStore {
  constructor(db,scopes=[]) {
    this.db=db;this.scopes=new Map();
    db.exec('CREATE TABLE IF NOT EXISTS platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const ajv=new Ajv({strict:true});
    for(const scope of scopes) {
      const descriptor={...scope,check:ajv.compile(scope.schema)};this.scopes.set(scope.name,descriptor);
      const key='configuration:'+scope.name;
      if(!db.prepare('SELECT 1 FROM platform_settings WHERE key=?').get(key)) {
        const values=structuredClone(typeof scope.defaults==='function'?scope.defaults():scope.defaults);this.validate(descriptor,values,{initial:true});
        db.prepare('INSERT INTO platform_settings VALUES(?,?)').run(key,JSON.stringify({values,revision:0,updated_at:Date.now(),...(scope.initialError?{bootstrap_error:scope.initialError}:{})}));
      }
      const record=this.record(scope.name);this.validate(descriptor,record.values,{initial:true});scope.apply?.(structuredClone(record.values),{initial:true,revision:record.revision,bootstrapError:record.bootstrap_error});
    }
  }
  descriptor(name){const scope=this.scopes.get(name);if(!scope)throw new HttpError(404,'CONFIGURATION_NOT_FOUND','找不到配置组。');return scope;}
  record(name){this.descriptor(name);return JSON.parse(this.db.prepare('SELECT value FROM platform_settings WHERE key=?').get('configuration:'+name).value);}
  read(name){return this.record(name).values;}
  get(name) {
    const scope=this.descriptor(name),record=this.record(name),configured_secrets=[];
    return {scope:name,title:scope.title,description:scope.description ?? '',schema:scope.schema,values:visible(record.values,scope.schema,configured_secrets),configured_secrets,revision:record.revision,updated_at:record.updated_at,...(record.bootstrap_error?{error:record.bootstrap_error}:{})};
  }
  list(){return [...this.scopes.keys()].map(name=>this.get(name));}
  validate(scope,values,context={}) {
    if(!scope.check(values)) {const error=scope.check.errors[0];throw new HttpError(400,'INVALID_CONFIGURATION',`${error.instancePath || '/'} ${error.message}`);}
    scope.validate?.(values,context);
  }
  update(name,patch,{revision}={}) {
    const scope=this.descriptor(name);
    if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new HttpError(400,'INVALID_CONFIGURATION','配置修改须为 JSON 对象。');
    const previous=this.record(name);
    if((scope.requireRevision||revision!==undefined)&&(!Number.isSafeInteger(revision)||revision!==previous.revision))throw new HttpError(409,'CONFIGURATION_REVISION_CONFLICT','配置已被其他操作更新，请重新读取后再保存。');
    const values=preserveSecrets({...previous.values,...patch},previous.values,scope.schema);
    this.validate(scope,values);
    this.db.exec('SAVEPOINT configuration_update');
    try {
      const changed=this.db.prepare("UPDATE platform_settings SET value=? WHERE key=? AND json_extract(value,'$.revision')=?").run(JSON.stringify({values,revision:previous.revision+1,updated_at:Date.now()}),'configuration:'+name,previous.revision).changes;
      if(!changed)throw new HttpError(409,'CONFIGURATION_REVISION_CONFLICT','配置已被其他操作更新，请重新读取后再保存。');
      scope.apply?.(structuredClone(values));this.db.exec('RELEASE configuration_update');
    }catch(error){this.db.exec('ROLLBACK TO configuration_update; RELEASE configuration_update');throw error;}
    return this.get(name);
  }
}
