import { HttpError } from '../errors.mjs';
export class PluginStore {
  constructor(db,registry) {
    this.db=db;this.registry=registry;this.invalid=[];
    db.exec('CREATE TABLE IF NOT EXISTS platform_plugins(type TEXT PRIMARY KEY,definition TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL)');
    if(!db.prepare('PRAGMA table_info(platform_plugins)').all().some(column=>column.name==='deleted_at'))db.exec('ALTER TABLE platform_plugins ADD COLUMN deleted_at INTEGER');
    this.reload();
  }
  // Startup settings may restore capabilities referenced by saved definitions.
  reload() {
    this.invalid=[];
    for (const row of this.db.prepare('SELECT type,definition,deleted_at FROM platform_plugins').all()) {
      if(row.deleted_at!==null){this.registry.modules.delete(row.type);continue;}
      try {
        const definition=JSON.parse(row.definition);
        this.registry.pluginConnections?.ensure(row.type,definition.routes?.[0]);
        if(this.registry.pluginConnections&&!this.registry.pluginConnections.status(row.type).ready) {
          definition.enabled=false;
          this.db.prepare('UPDATE platform_plugins SET definition=? WHERE type=?').run(JSON.stringify(definition),row.type);
        }
        this.registry.registerDefinition(definition);
      }
      catch {this.invalid.push({type:row.type,error:'INVALID_PLUGIN_CONFIGURATION'});}
    }
  }
  save(definition) {
    let module=this.registry.compileDefinition(definition);
    if(this.db.prepare('SELECT deleted_at FROM platform_plugins WHERE type=?').get(module.type)?.deleted_at!=null)throw new HttpError(409,'PLUGIN_DELETED','业务插件已删除，不能通过保存重新启用。');
    if(this.registry.pluginConnections) {
      const exists=this.db.prepare('SELECT 1 FROM platform_plugins WHERE type=?').get(module.type);
      if(!exists||!this.registry.pluginConnections.status(module.type).ready)module=this.registry.compileDefinition({...module.definition,enabled:false});
    }
    this.registry.assertRoutes(module);
    if (this.registry.modules.has(module.type) && !this.registry.modules.get(module.type).definition && !this.registry.catalog.profiles?.[module.type]) throw new HttpError(409,'BUILTIN_TYPE_RESERVED','该类型由现有兼容模块提供。');
    const saved=module.definition;
    this.db.exec('SAVEPOINT plugin_save');
    try {
      this.db.prepare('INSERT INTO platform_plugins(type,definition,revision,updated_at) VALUES(?,?,1,?) ON CONFLICT(type) DO UPDATE SET definition=excluded.definition,revision=revision+1,updated_at=excluded.updated_at').run(saved.type,JSON.stringify(saved),Date.now());
      this.registry.pluginConnections?.ensure(saved.type,saved.routes?.[0]);
      this.db.exec('RELEASE plugin_save');
    } catch(error) {this.db.exec('ROLLBACK TO plugin_save;RELEASE plugin_save');throw error;}
    this.registry.modules.set(saved.type,module);return this.get(saved.type);
  }
  get(type) {
    const row=this.db.prepare('SELECT definition,revision,updated_at FROM platform_plugins WHERE type=? AND deleted_at IS NULL').get(type);
    if (!row) throw new HttpError(404,'PLUGIN_NOT_FOUND','找不到业务插件。');
    const definition=JSON.parse(row.definition);
    if(this.registry.pluginConnections&&!this.registry.pluginConnections.status(type).ready)definition.enabled=false;
    return {...definition,revision:row.revision,updated_at:row.updated_at};
  }
  list() {return this.db.prepare('SELECT type FROM platform_plugins WHERE deleted_at IS NULL ORDER BY type').all().map(row=>this.get(row.type));}
  delete(type) {
    const row=this.db.prepare('SELECT definition,deleted_at FROM platform_plugins WHERE type=?').get(type);
    if(!row)throw new HttpError(404,'PLUGIN_NOT_FOUND','找不到业务插件。');
    const deleted_at=row.deleted_at??Date.now();
    if(row.deleted_at===null)this.db.prepare('UPDATE platform_plugins SET definition=?,deleted_at=?,updated_at=?,revision=revision+1 WHERE type=?').run(JSON.stringify({...JSON.parse(row.definition),enabled:false}),deleted_at,deleted_at,type);
    this.registry.modules.delete(type);
    return {type,deleted:true,deleted_at};
  }
  setEnabled(type,enabled) {const {revision,updated_at,...definition}=this.get(type);if(enabled)this.registry.pluginConnections?.assertReady(type);return this.save({...definition,enabled});}
  setExecution(type,execution,expectedRevision) {
    const {revision,updated_at,...definition}=this.get(type);
    if(revision!==expectedRevision)throw new HttpError(409,'PLUGIN_REVISION_CONFLICT','业务插件已被修改，请重新读取后再保存。');
    return this.save({...definition,execution});
  }
}
