import {SYSTEM_SERVICES,SYSTEM_MODULES,SYSTEM_STATES,SYSTEM_LEVELS,SYSTEM_CLASSIFICATIONS,SYSTEM_ACTIONS,SYSTEM_CODES,SYSTEM_SEARCH_ALIASES,systemQueryProperties,systemIssueQueryProperties} from './system-contracts.mjs';

const titles={system:'System',cleanup:'Cleanup',sandbox:'Sandbox',retention:'History retention',configuration:'Configuration synchronization',events:'Internal events',runtime:'Runtime recovery',schedules:'Schedules',inspections:'Inspections',notifications:'Notifications',delivery:'Final callback delivery',health:'Service health',api:'Management operations',upgrade:'Upgrade'};
const failureStates=new Set(['retrying','blocked','unknown']);
const token=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)?value:null;
const time=value=>Number.isSafeInteger(value)&&value>=0;
const fail=code=>{const error=new Error(code);error.code=code;return error;};
const own=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const select=(value,values,fallback)=>values.includes(value)?value:fallback;
const numericDetails=new Set(['observed_progress_at','plugin_revision','connection_revision','confirmed_revision','oldest_pending_at','pending_count','attempt','attempts','pending','attempted','completed','failed','deleted','scanned','skipped','duration_ms','revision','generation','bytes','count','status_code','gap_count','failed_operations','first_failed_at','last_failed_at','last_recovered_at','gap_started_at']);
const selectors={
  classification:SYSTEM_CLASSIFICATIONS,previous_classification:SYSTEM_CLASSIFICATIONS,
  action:SYSTEM_ACTIONS,actor:['admin','agent','system'],
  phase:['cleanup','scan','prune','compact','synchronize','sync','dispatch','claim','ack','handoff','reconcile','recovery','probe','send','verify','start','stop','complete','idle','queued','checking','downloading','building','stopping','backing_up','validating','restarting','verifying','completed','failed','interrupted'],
  status:[...SYSTEM_STATES,'pending','failed','succeeded','unavailable','available','accepted','claimed','acknowledged','cancelled'],
  result:['success','failure','unknown','skipped','pending','partial'],source:[...SYSTEM_SERVICES,'local','remote','sandbox','codex','callback','notification','host'],
};
/** Structured details are a flat allowlist of finite nonnegative numbers and fixed selectors. */
export function safeSystemDetails(details) {
  const result={};if(!details||typeof details!=='object'||Array.isArray(details))return result;
  for(const key of numericDetails)if(time(details[key]))result[key]=details[key];
  for(const key of ['current_version','latest_version','installed_version','target_version'])if(typeof details[key]==='string'&&/^v?(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})$/.test(details[key]))result[key]=details[key];
  for(const [key,values] of Object.entries(selectors))if(values.includes(details[key]))result[key]=details[key];
  return result;
}
function publicId(service,kind,local) {return `${service}:${kind}:${local}`;}
/** Returns a validated identity or null; IDs cannot select a database, SQL, path or source file. */
export function parseSystemId(id) {
  if(typeof id!=='string'||id.length>256)return null;
  const match=/^(manager|gateway|runner):(work|event):([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(id);
  return match?{service:match[1],kind:match[2],local_id:match[3]}:null;
}
/** Cursor position is the last consumed public {time,id}; ordering is descending time then ASCII id. */
export function encodeSystemCursor(position) {
  if(!position||!time(position.time)||!parseSystemId(position.id))throw fail('SYSTEM_QUERY_INVALID');
  return Buffer.from(JSON.stringify({time:position.time,id:position.id})).toString('base64url');
}
export function decodeSystemCursor(cursor) {
  try {
    if(typeof cursor!=='string'||cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(cursor))throw 0;
    const position=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
    if(!position||!time(position.time)||!parseSystemId(position.id)||Object.keys(position).sort().join(',')!=='id,time')throw 0;
    return {time:position.time,id:position.id};
  }catch{throw fail('SYSTEM_QUERY_INVALID');}
}
/** Events sort/filter by last_seen_at; work/issues by updated_at. These are current-state pages,
 * not frozen snapshots. Never use a per-source cursor as a global cursor.
 */
export const systemRecordTime=record=>record.kind==='event'?record.last_seen_at:record.updated_at;
export function compareSystemRecords(a,b) {return systemRecordTime(b)-systemRecordTime(a)||(a.id===b.id?0:a.id<b.id?1:-1);}
/** Merge already-filtered source pages fetched with the SAME input cursor and >= requested limit.
 * Re-query every source with returned last-consumed cursor; do not forward source next_cursor values.
 * Source availability is reported by the aggregator, never inferred from an empty page here.
 */
export function mergeSystemPages(pages,{limit=50}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw fail('SYSTEM_QUERY_INVALID');
  const records=[...new Map(pages.flatMap(page=>page.items).map(item=>[item.id,item])).values()].sort(compareSystemRecords);
  const items=records.slice(0,limit),more=records.length>limit||pages.some(page=>page.next_cursor);
  return {items,next_cursor:more&&items.length?encodeSystemCursor({time:systemRecordTime(items.at(-1)),id:items.at(-1).id}):null};
}
export function normalizeSystemQuery(query={},{issues=false}={}) {
  const properties=issues?systemIssueQueryProperties:systemQueryProperties;
  if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(key=>!own(properties,key)))throw fail('SYSTEM_QUERY_INVALID');
  const out={...query,limit:query.limit??50};
  for(const [key,allowed] of [['service',SYSTEM_SERVICES],['module',SYSTEM_MODULES],['state',SYSTEM_STATES],['level',SYSTEM_LEVELS]])if(out[key]!==undefined&&!allowed.includes(out[key]))throw fail('SYSTEM_QUERY_INVALID');
  if(!Number.isSafeInteger(out.limit)||out.limit<1||out.limit>100)throw fail('SYSTEM_QUERY_INVALID');
  if(out.include_total!==undefined&&typeof out.include_total!=='boolean')throw fail('SYSTEM_QUERY_INVALID');
  for(const key of ['after','before','resolved_after'])if(out[key]!==undefined&&!time(out[key]))throw fail('SYSTEM_QUERY_INVALID');
  if(out.after!==undefined&&out.before!==undefined&&out.after>out.before)throw fail('SYSTEM_QUERY_INVALID');
  if(out.search!==undefined&&(typeof out.search!=='string'||!out.search.length||out.search.length>200))throw fail('SYSTEM_QUERY_INVALID');
  if(out.target_id!==undefined&&!token(out.target_id))throw fail('SYSTEM_QUERY_INVALID');
  if(out.work_id!==undefined&&!parseSystemId(out.work_id))throw fail('SYSTEM_QUERY_INVALID');
  if(out.resolution!==undefined&&!['unresolved','recovered','all'].includes(out.resolution))throw fail('SYSTEM_QUERY_INVALID');
  if(out.cursor!==undefined)out.position=decodeSystemCursor(out.cursor);
  return out;
}
/**
 * Service-owned SQLite journal; no links or foreign keys to conversations/business history.
 * Event: {id,kind:'event',service,module,event,level,code,message,work_id,target_id,details,
 *   state,created_at,first_seen_at,last_seen_at,count}. state is null for standalone events.
 * Repeats update last_seen_at/count, never created_at.
 * Work/issue: {id,kind:'work',service,module,title,state,code,message,target_id,details,classification,
 *   allowed_actions,revision,created_at,updated_at,first_attempt_at,last_attempt_at,last_progress_at,
 *   last_success_at,completed_at,attempts,consecutive_failures,pending_count,next_retry_at,
 *   issue_opened_at,issue_count,resolved_at}. Issue IDs equal their owning work IDs.
 * work({attempted:true}) (default) starts/counts an actual attempt. Progress/completion observations
 * use attempted:false, preserving attempts/first_attempt_at/last_attempt_at (null until attempted).
 * Failure observations still increment consecutive_failures and issue_count; callers must not
 * submit routine refreshes as failures. Callers must use stable logical local IDs.
 * work() emits a linked event atomically. Only completed clears an issue; idle/disabled do not.
 * issues() defaults to unresolved. resolution=unresolved/recovered/all is independent of work state.
 * Without resolution, state=completed aliases recovered issues regardless of current work state.
 * Writes fail closed to null with health fallback; reads throw fixed safe unavailable errors.
 * health.available/code describe current verified access. health.collection keeps separate cumulative
 * gap counters/timestamps and pending (not yet durably recorded) evidence. A verified read recovers
 * access but cannot clear pending evidence. The next successful write atomically saves fixed failure
 * and recovery events plus compact service-owned counters, which survive journal reconstruction.
 * Caller-owned outer transactions remain untouched. Evidence stays pending until verified outside
 * any transaction; visible matching metadata deduplicates staged writes. After outer rollback the
 * pending evidence is retried; after outer commit a later verified access clears pending.
 * Gap events follow ordinary event retention; compact counters contain no payload/history bodies.
 * Storage and lifecycle remain owned by the caller; this class never closes db.
 */
export class SystemJournal {
  constructor({db,service,now=Date.now}) {
    if(!SYSTEM_SERVICES.includes(service))throw fail('SYSTEM_SERVICE_INVALID');
    Object.assign(this,{db,service,now});
    this.health={available:true,code:'SYSTEM_OK',failed_at:null,collection:{gap_count:0,failed_operations:0,first_failed_at:null,last_failed_at:null,last_recovered_at:null,gap_started_at:null,pending:false}};
    try{db.exec(`
      CREATE TABLE IF NOT EXISTS system_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,service TEXT NOT NULL,module TEXT NOT NULL,level TEXT NOT NULL,code TEXT NOT NULL,work_id TEXT,target_id TEXT,created_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,fingerprint TEXT NOT NULL,record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS system_events_page ON system_events(service,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS system_events_occurrence_page ON system_events(service,last_seen_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS system_events_work ON system_events(work_id);
      CREATE INDEX IF NOT EXISTS system_events_repeat ON system_events(service,module,work_id,target_id,seq DESC);
      CREATE TABLE IF NOT EXISTS system_work(id TEXT PRIMARY KEY,service TEXT NOT NULL,module TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL,issue_opened_at INTEGER,resolved_at INTEGER,record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS system_work_page ON system_work(service,updated_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS system_journal_health(service TEXT PRIMARY KEY,record TEXT NOT NULL);
    `);
      const saved=db.prepare('SELECT record FROM system_journal_health WHERE service=?').get(service);
      if(saved)this.health.collection={...JSON.parse(saved.record),pending:db.isTransaction};
    }catch{this.unavailable();}
  }
  unavailable() {
    if(this.health.available)process.stderr.write('SYSTEM_JOURNAL_UNAVAILABLE: System journal is unavailable.\n');
    const at=this.now(),old=this.health.collection;
    this.health={available:false,code:'SYSTEM_JOURNAL_UNAVAILABLE',failed_at:at,collection:{...old,
      gap_count:old.gap_count+(old.pending?0:1),failed_operations:old.failed_operations+1,
      first_failed_at:old.first_failed_at??at,last_failed_at:at,gap_started_at:old.pending?old.gap_started_at:at,pending:true,
    }};
  }
  savedCollectionEvidence() {
    const row=this.db.prepare('SELECT record FROM system_journal_health WHERE service=?').get(this.service);
    const saved=row?JSON.parse(row.record):null;
    return saved&&!saved.pending&&['gap_count','failed_operations','first_failed_at','last_failed_at','gap_started_at'].every(key=>saved[key]===this.health.collection[key])?saved:null;
  }
  verifiedAccess() {
    // RELEASE only commits when there is no caller-owned transaction. A matching row read in
    // autocommit mode proves persistence; an absent row after rollback leaves evidence pending.
    if(this.health.collection.pending&&!this.db.isTransaction){
      const committed=this.savedCollectionEvidence();
      if(committed)this.health={...this.health,collection:committed};
    }
    this.health={...this.health,available:true,code:'SYSTEM_OK',failed_at:null};
  }
  read(fn) {try{const result=fn();this.verifiedAccess();return result;}catch(error){if(error.code?.startsWith('SYSTEM_'))throw error;this.unavailable();throw fail('SYSTEM_JOURNAL_UNAVAILABLE');}}
  transaction(fn) {
    this.db.exec('SAVEPOINT system_journal_write');
    try{const result=fn();this.db.exec('RELEASE system_journal_write');return result;}
    catch(error){try{this.db.exec('ROLLBACK TO system_journal_write');this.db.exec('RELEASE system_journal_write');}catch{}throw error;}
  }
  write(fn) {
    const result=this.transaction(()=>{
      const saved=fn();
      if(this.health.collection.pending&&!this.savedCollectionEvidence()){
        const collection={...this.health.collection,last_recovered_at:this.now(),pending:false};
        this.saveEvent({module:'system',event:'collection_failed',level:'error',code:'SYSTEM_JOURNAL_UNAVAILABLE',details:collection});
        this.saveEvent({module:'system',event:'collection_recovered',level:'info',code:'SYSTEM_JOURNAL_RECOVERED',details:collection});
        this.db.prepare('INSERT INTO system_journal_health(service,record) VALUES(?,?) ON CONFLICT(service) DO UPDATE SET record=excluded.record').run(this.service,JSON.stringify(collection));
      }
      return saved;
    });
    // Reconcile the evidence only after commit; a caller-owned transaction remains pending.
    this.verifiedAccess();return result;
  }
  projection(input={}) {
    const code=own(SYSTEM_CODES,input.code)?input.code:'SYSTEM_ERROR';
    return {service:this.service,module:select(input.module,SYSTEM_MODULES,'system'),code,message:SYSTEM_CODES[code],target_id:token(input.target_id),details:safeSystemDetails(input.details)};
  }
  saveEvent(input) {
    const at=this.now(),record={...this.projection(input),kind:'event',event:token(input.event)??'operation',level:select(input.level,SYSTEM_LEVELS,'info'),state:select(input.state,SYSTEM_STATES,null),work_id:null,created_at:at,first_seen_at:at,last_seen_at:at,count:1};
    const identity=parseSystemId(input.work_id);
    if(identity?.service===this.service&&identity.kind==='work')record.work_id=input.work_id;
    const fingerprint=JSON.stringify([record.module,record.event,record.level,record.code,record.state,record.work_id,record.target_id,record.details]);
    // Consecutive per logical target: interleaved modules do not generate per-minute noise.
    // A recovery between two failures for the same target stays visible.
    const previous=this.db.prepare('SELECT * FROM system_events WHERE service=? AND module=? AND work_id IS ? AND target_id IS ? ORDER BY seq DESC LIMIT 1').get(this.service,record.module,record.work_id,record.target_id);
    if(previous?.fingerprint===fingerprint) {
      const saved=JSON.parse(previous.record);saved.count++;saved.last_seen_at=at;
      this.db.prepare('UPDATE system_events SET record=?,last_seen_at=? WHERE id=?').run(JSON.stringify(saved),at,saved.id);return saved;
    }
    const result=this.db.prepare('INSERT INTO system_events(service,module,level,code,work_id,target_id,created_at,last_seen_at,fingerprint,record) VALUES(?,?,?,?,?,?,?,?,?,?)').run(this.service,record.module,record.level,record.code,record.work_id,record.target_id,at,at,fingerprint,'{}');
    record.id=publicId(this.service,'event',String(result.lastInsertRowid).padStart(16,'0'));
    this.db.prepare('UPDATE system_events SET id=?,record=? WHERE seq=?').run(record.id,JSON.stringify(record),result.lastInsertRowid);return record;
  }
  event(input={}) {try{return this.write(()=>this.saveEvent(input));}catch{this.unavailable();return null;}}
  work(input={}) {
    const parsed=parseSystemId(input.id),local=parsed?.service===this.service&&parsed.kind==='work'?parsed.local_id:token(input.id);
    if(!local||parsed&&(parsed.service!==this.service||parsed.kind!=='work')||!SYSTEM_STATES.includes(input.state))throw fail('SYSTEM_WORK_INVALID');
    try{return this.write(()=>{
      const id=publicId(this.service,'work',local),old=this.getRecord('system_work',id),at=this.now();
      const issue=failureStates.has(input.state),completed=input.state==='completed',attempted=input.attempted!==false;
      const safe=this.projection({...input,code:input.code??`WORK_${input.state.toUpperCase()}`});
      const count=value=>time(value)?value:0;
      const record={...safe,id,kind:'work',title:titles[safe.module],state:input.state,
        // Owner observations update outcome facts, never release human-review protection.
        classification:old?.classification==='code_defect'?'code_defect':select(input.classification,SYSTEM_CLASSIFICATIONS,old?.classification??'unknown'),
        allowed_actions:Array.isArray(input.allowed_actions)?[...new Set(input.allowed_actions.filter(x=>SYSTEM_ACTIONS.includes(x)))].slice(0,SYSTEM_ACTIONS.length):[],
        revision:(old?.revision??0)+1,created_at:old?.created_at??at,updated_at:at,
        first_attempt_at:old?.first_attempt_at??(attempted?at:null),last_attempt_at:attempted?at:old?.last_attempt_at??null,
        last_progress_at:!old||old.state!==input.state||old.pending_count!==count(input.pending_count)?at:old.last_progress_at,
        last_success_at:completed?at:old?.last_success_at??null,completed_at:completed?at:null,
        attempts:(old?.attempts??0)+(attempted?1:0),consecutive_failures:issue?(old?.consecutive_failures??0)+1:completed?0:old?.consecutive_failures??0,
        pending_count:count(input.pending_count),next_retry_at:time(input.next_retry_at)?input.next_retry_at:null,
        issue_opened_at:issue&&(old?.issue_opened_at==null||old.resolved_at!==null)?at:old?.issue_opened_at??null,
        issue_count:(old?.issue_count??0)+(issue?1:0),resolved_at:completed&&old?.issue_opened_at!=null?(old.resolved_at??at):issue?null:old?.resolved_at??null,
      };
      this.putWork(record);
      this.saveEvent({...record,event:completed?'recovered':'work_observed',level:issue?'error':'info',work_id:id});
      return record;
    });}catch{this.unavailable();return null;}
  }
  getRecord(table,id) {const row=this.db.prepare(`SELECT record FROM ${table} WHERE id=? AND service=?`).get(id,this.service);return row?JSON.parse(row.record):null;}
  putWork(record) {
    this.db.prepare('INSERT INTO system_work(id,service,module,state,updated_at,issue_opened_at,resolved_at,record) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET module=excluded.module,state=excluded.state,updated_at=excluded.updated_at,issue_opened_at=excluded.issue_opened_at,resolved_at=excluded.resolved_at,record=excluded.record').run(record.id,this.service,record.module,record.state,record.updated_at,record.issue_opened_at,record.resolved_at,JSON.stringify(record));
  }
  logs(query={}) {return this.query('system_events',query);}
  works(query={}) {return this.query('system_work',query);}
  issues(query={}) {return this.query('system_work',query,true);}
  query(table,query,issues=false) {
    const q=normalizeSystemQuery(query,{issues}),event=table==='system_events',column=event?'last_seen_at':'updated_at';
    if(q.service&&q.service!==this.service)return {items:[],next_cursor:null,...(q.include_total?{total:0,total_complete:true}:{})};
    return this.read(()=>{
      const where=['service=?'],params=[this.service];
      const completedAlias=issues&&q.resolution===undefined&&q.state==='completed';
      for(const key of ['module',...(event?['level','work_id','target_id']:['state'])])if(q[key]!==undefined&&!(key==='state'&&completedAlias)){where.push(`${key}=?`);params.push(q[key]);}
      if(event&&q.state!==undefined){where.push("json_extract(record,'$.state')=?");params.push(q.state);}
      if(!event&&q.level!==undefined){where.push("(CASE WHEN state IN ('retrying','blocked','unknown') THEN 'error' ELSE 'info' END)=?");params.push(q.level);}
      if(!event&&q.target_id!==undefined){where.push("json_extract(record,'$.target_id')=?");params.push(q.target_id);}
      if(!event&&q.work_id!==undefined){where.push('id=?');params.push(q.work_id);}
      if(issues){
        where.push('issue_opened_at IS NOT NULL');
        const resolution=q.resolution??(completedAlias?'recovered':'unresolved');
        if(resolution==='unresolved')where.push('resolved_at IS NULL');
        if(resolution==='recovered')where.push('resolved_at IS NOT NULL');
      }
      for(const [key,op] of [['after','>='],['before','<']])if(q[key]!==undefined){where.push(`${column}${op}?`);params.push(q[key]);}
      if(issues&&q.resolved_after!==undefined){where.push('resolved_at>=?');params.push(q.resolved_after);}
      if(q.search!==undefined){
        const fields=['id','service','module','code','message','event','work_id','target_id','title','state','classification'];
        const terms=fields.map(key=>`json_extract(record,'$.${key}') LIKE ? ESCAPE '\\'`);
        const value=`%${q.search.replace(/[\\%_]/g,'\\$&')}%`;params.push(...fields.map(()=>value));
        for(const [field,aliases] of [['module',SYSTEM_SEARCH_ALIASES.modules],['code',SYSTEM_SEARCH_ALIASES.codes]]){
          const matched=Object.entries(aliases).filter(([,alias])=>alias.toLowerCase().includes(q.search.toLowerCase())).map(([key])=>key);
          if(matched.length){terms.push(`json_extract(record,'$.${field}') IN (${matched.map(()=>'?').join(',')})`);params.push(...matched);}
        }
        where.push(`(${terms.join(' OR ')})`);
      }
      // Count the complete filtered set before applying the current page position.
      const totals=q.include_total?{total:this.db.prepare(`SELECT count(*) AS total FROM ${table} WHERE ${where.join(' AND ')}`).get(...params).total,total_complete:true}:{};
      if(q.position){where.push(`(${column}<? OR (${column}=? AND id<?))`);params.push(q.position.time,q.position.time,q.position.id);}
      const rows=this.db.prepare(`SELECT record FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${column} DESC,id DESC LIMIT ?`).all(...params,q.limit+1);
      const items=rows.slice(0,q.limit).map(row=>JSON.parse(row.record));
      return {items,next_cursor:rows.length>q.limit?encodeSystemCursor({time:systemRecordTime(items.at(-1)),id:items.at(-1).id}):null,...totals};
    });
  }
  detail(id) {const identity=parseSystemId(id);if(!identity)throw fail('SYSTEM_QUERY_INVALID');if(identity.service!==this.service)return null;return this.read(()=>this.getRecord(identity.kind==='event'?'system_events':'system_work',id));}
  classify(id,classification,revision,{actor='system',review=false}={}) {
    if(!SYSTEM_CLASSIFICATIONS.includes(classification)||!Number.isSafeInteger(revision)||revision<1||!['admin','agent','system'].includes(actor)||typeof review!=='boolean')throw fail('SYSTEM_QUERY_INVALID');
    const identity=parseSystemId(id);if(identity?.kind!=='work'||identity.service!==this.service)throw fail('SYSTEM_QUERY_INVALID');
    return this.read(()=>this.write(()=>{
      const record=this.getRecord('system_work',id);if(!record)throw fail('SYSTEM_WORK_NOT_FOUND');if(record.revision!==revision)throw fail('SYSTEM_REVISION_CONFLICT');
      if(record.classification==='code_defect'&&classification!=='code_defect'&&(!review||actor!=='admin'))throw fail('SYSTEM_HUMAN_REQUIRED');
      const previous_classification=record.classification;
      record.classification=classification;record.revision++;record.updated_at=this.now();this.putWork(record);
      this.saveEvent({module:record.module,event:review?'classification_reviewed':'classification_changed',code:'WORK_UNKNOWN',work_id:id,details:{actor,revision:record.revision,previous_classification,classification}});return record;
    }));
  }
  summary() {
    try {
      const rows=this.db.prepare('SELECT state,count(*) AS count FROM system_work WHERE service=? GROUP BY state').all(this.service);
      const states=Object.fromEntries(SYSTEM_STATES.map(x=>[x,0]));for(const row of rows)states[row.state]=row.count;
      const unresolved=this.db.prepare('SELECT count(*) AS count FROM system_work WHERE service=? AND issue_opened_at IS NOT NULL AND resolved_at IS NULL').get(this.service).count;
      const collected_at=this.now(),recovered_24h=this.db.prepare('SELECT count(*) AS count FROM system_work WHERE service=? AND issue_opened_at IS NOT NULL AND resolved_at>=?').get(this.service,collected_at-86400000).count;
      this.verifiedAccess();
      return {service:this.service,collected_at,health:{...this.health},states,unresolved,recovered_24h};
    }catch{this.unavailable();return {service:this.service,collected_at:this.now(),health:{...this.health},states:null,unresolved:null,recovered_24h:null};}
  }
  /** Caller MUST gate by existing retention.enabled/days; cutoff is explicit, no independent age default.
   * A batch deletes at most limit rows total. All events linked to unfinished/unresolved work stay.
   * Diagnostic classifications do not extend retention after verified completion.
   * Work with newer linked evidence stays until that evidence becomes eligible, preserving history.
   */
  prune({cutoff,limit=50}={}) {
    if(!time(cutoff)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw fail('SYSTEM_QUERY_INVALID');
    return this.read(()=>this.write(()=>{
      const eligible="w.state IN ('completed','idle','disabled') AND (w.issue_opened_at IS NULL OR w.resolved_at IS NOT NULL)";
      const events=this.db.prepare(`SELECT e.id FROM system_events e WHERE e.service=? AND e.last_seen_at<? AND NOT EXISTS(SELECT 1 FROM system_work w WHERE w.id=e.work_id AND NOT (${eligible})) ORDER BY e.created_at,e.id LIMIT ?`).all(this.service,cutoff,limit);
      for(const row of events)this.db.prepare('DELETE FROM system_events WHERE id=?').run(row.id);
      const works=this.db.prepare(`SELECT w.id FROM system_work w WHERE w.service=? AND w.updated_at<? AND ${eligible} AND NOT EXISTS(SELECT 1 FROM system_events e WHERE e.work_id=w.id) ORDER BY w.updated_at,w.id LIMIT ?`).all(this.service,cutoff,limit-events.length);
      for(const row of works)this.db.prepare('DELETE FROM system_work WHERE id=?').run(row.id);
      return {deleted:events.length+works.length,events_deleted:events.length,works_deleted:works.length};
    }));
  }
}
