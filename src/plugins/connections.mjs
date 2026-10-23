import { createHash } from 'node:crypto';
import { HttpError } from '../errors.mjs';

const hash=token=>createHash('sha256').update(token).digest('hex');
const invalid=()=>new HttpError(400,'INVALID_PLUGIN_CONNECTION');
const entryPattern=/^\/hooks\/[a-zA-Z0-9][a-zA-Z0-9/_-]*$/;

// These human-owned values deliberately never enter a plugin definition or task snapshot.
export class PluginConnectionStore {
  constructor(db,registry) {
    this.db=db;this.registry=registry;
    db.exec(`CREATE TABLE IF NOT EXISTS platform_plugin_connections(
      type TEXT PRIMARY KEY REFERENCES platform_plugins(type),entry_address TEXT,entry_path TEXT UNIQUE,
      entry_key_hash TEXT UNIQUE,callback_url TEXT,callback_token TEXT,revision INTEGER NOT NULL DEFAULT 1
    )`);
  }
  assertPlugin(type) {
    if(!this.db.prepare('SELECT 1 FROM platform_plugins WHERE type=?').get(type))throw new HttpError(404,'PLUGIN_NOT_FOUND');
  }
  entry(value) {
    if(value===null||value==='')return {address:null,path:null};
    if(typeof value!=='string'||value.length>4096||value.trim()!==value)throw invalid();
    let path=value;
    if(!value.startsWith('/')) {
      if(!/^https?:\/\/[^/?#]+\/[^?#]*$/i.test(value))throw invalid();
      let parsed;try{parsed=new URL(value);}catch{throw invalid();}
      if(parsed.username||parsed.password||parsed.search||parsed.hash)throw invalid();
      path=value.slice(value.indexOf('/',value.indexOf('://')+3));
      if(parsed.pathname!==path)throw invalid();
    }
    if(!entryPattern.test(path)||(this.registry.catalog.reservedRoutes ?? []).includes(path))throw invalid();
    return {address:value,path};
  }
  callback(value) {
    if(value===null||value==='')return null;
    if(typeof value!=='string'||value.length>4096||value.trim()!==value||/[\r\n]/.test(value))throw invalid();
    let parsed;try{parsed=new URL(value);}catch{throw invalid();}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.hash)throw invalid();
    return value;
  }
  ensure(type,suggestedPath) {
    this.assertPlugin(type);
    if(!this.db.prepare('SELECT 1 FROM platform_plugin_connections WHERE type=?').get(type)) {
      const {address,path}=this.entry(suggestedPath ?? `/hooks/${type.replaceAll('.','/')}`);
      try{this.db.prepare('INSERT INTO platform_plugin_connections(type,entry_address,entry_path) VALUES(?,?,?)').run(type,address,path);}
      catch(error){if(error.code==='ERR_SQLITE_ERROR'&&/UNIQUE constraint/.test(error.message))throw new HttpError(409,'PLUGIN_CONNECTION_CONFLICT');throw error;}
    }
    return this.get(type);
  }
  row(type) {
    this.assertPlugin(type);
    const row=this.db.prepare('SELECT * FROM platform_plugin_connections WHERE type=?').get(type);
    if(!row){this.ensure(type);return this.db.prepare('SELECT * FROM platform_plugin_connections WHERE type=?').get(type);}
    return row;
  }
  get(type) {
    const row=this.row(type),missingFields=[];
    if(!row.entry_path)missingFields.push('entryAddress');
    if(!row.entry_key_hash)missingFields.push('entryKey');
    return {type,entryAddress:row.entry_address,entryPath:row.entry_path,entryKeyConfigured:!!row.entry_key_hash,
      callbackUrl:row.callback_url,callbackTokenConfigured:!!row.callback_token,ready:missingFields.length===0,missingFields,revision:row.revision};
  }
  status(type) {
    const value=this.get(type);
    return {ready:value.ready,entryPath:value.entryPath,callbackConfigured:!!value.callbackUrl,missingFields:value.missingFields};
  }
  update(type,patch) {
    const row=this.row(type);
    if(!patch||Array.isArray(patch)||typeof patch!=='object'||Object.keys(patch).some(key=>!['entryAddress','entryKey','callbackUrl','callbackToken','revision'].includes(key)))throw invalid();
    if(Object.hasOwn(patch,'revision')&&(!Number.isSafeInteger(patch.revision)||patch.revision!==row.revision))throw new HttpError(409,'PLUGIN_CONNECTION_REVISION_CONFLICT');
    const entry=Object.hasOwn(patch,'entryAddress')?this.entry(patch.entryAddress):{address:row.entry_address,path:row.entry_path};
    let entryHash=row.entry_key_hash;
    if(Object.hasOwn(patch,'entryKey')) {
      if(patch.entryKey===null)entryHash=null;
      else {
        if(typeof patch.entryKey!=='string'||patch.entryKey.length<24||patch.entryKey.length>1024||!/^[A-Za-z0-9._~+/-]+=*$/.test(patch.entryKey)||(this.registry.catalog.connectionForbiddenTokens ?? []).includes(patch.entryKey))throw invalid();
        entryHash=hash(patch.entryKey);
      }
    }
    const callbackUrl=Object.hasOwn(patch,'callbackUrl')?this.callback(patch.callbackUrl):row.callback_url;
    let callbackToken=row.callback_token;
    if(Object.hasOwn(patch,'callbackToken')) {
      if(patch.callbackToken!==null&&(typeof patch.callbackToken!=='string'||patch.callbackToken.length<1||patch.callbackToken.length>1024||/[\r\n]/.test(patch.callbackToken)))throw invalid();
      callbackToken=patch.callbackToken;
    }
    if(!callbackUrl)callbackToken=null;
    try {
      const changed=this.db.prepare('UPDATE platform_plugin_connections SET entry_address=?,entry_path=?,entry_key_hash=?,callback_url=?,callback_token=?,revision=revision+1 WHERE type=? AND revision=?').run(entry.address,entry.path,entryHash,callbackUrl,callbackToken,type,row.revision).changes;
      if(!changed)throw new HttpError(409,'PLUGIN_CONNECTION_REVISION_CONFLICT');
    } catch(error) {if(error.code==='ERR_SQLITE_ERROR'&&/UNIQUE constraint/.test(error.message))throw new HttpError(409,'PLUGIN_CONNECTION_CONFLICT');throw error;}
    return this.get(type);
  }
  authenticate(token) {
    if(typeof token!=='string'||token.length<24||token.length>1024)return null;
    return this.db.prepare('SELECT type FROM platform_plugin_connections WHERE entry_key_hash=?').get(hash(token))?.type ?? null;
  }
  forPath(path) {return this.db.prepare('SELECT type FROM platform_plugin_connections WHERE entry_path=?').get(path)?.type ?? null;}
  assertReady(type) {if(!this.status(type).ready)throw new HttpError(409,'PLUGIN_CONNECTION_NOT_READY');}
  callbackFor(type) {const row=this.row(type);return row.callback_url?{url:row.callback_url,...(row.callback_token?{token:row.callback_token}:{})}:null;}
}
