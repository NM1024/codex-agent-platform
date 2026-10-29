const day=86400000;
function validatePolicy(policy) {
  if(!policy||typeof policy.enabled!=='boolean'||!Number.isSafeInteger(policy.days)||policy.days<1||policy.days>3650||!Number.isSafeInteger(policy.revision)||policy.revision<0)throw new Error('INVALID_RETENTION_POLICY');
  return policy;
}

// Each service owns its sweep state and records. No model turn or business plan
// is created to perform maintenance.
export class HistoryRetentionWorker {
  constructor({db,readPolicy,runBatch,maintenance,compact,onSweep=()=>{},batchSize=50,maxBatches=5}) {
    Object.assign(this,{db,readPolicy,runBatch,maintenance,compact,onSweep,batchSize,maxBatches});
    db.exec('CREATE TABLE IF NOT EXISTS history_retention_sweep(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL)');
  }
  state(){const row=this.db.prepare('SELECT state FROM history_retention_sweep WHERE id=1').get();return row?JSON.parse(row.state):null;}
  save(state){this.db.prepare('INSERT OR REPLACE INTO history_retention_sweep VALUES(1,?)').run(JSON.stringify(state));}
  tick(now=Date.now()) {
    if(this.closed)return Promise.resolve();
    if(this.current)return this.current;
    this.current=Promise.resolve().then(()=>this.sweep(now)).finally(()=>{this.current=null;});
    return this.current;
  }
  async reclaim(state) {
    if(!state.compaction_pending||!this.compact)return;
    try {
      const result=await this.compact();state.compaction_pending=!!result?.skipped;this.save(state);
    } catch { /* Deleted pages remain reusable; retry contraction when idle. */ }
  }
  async sweep(now) {
    await this.maintenance?.();
    const policy=validatePolicy(await this.readPolicy());
    if(!policy.enabled)return {enabled:false};
    let state=this.state();
    if(!state||state.revision!==policy.revision||state.days!==policy.days||state.completed_at!==null&&now>=state.completed_at+day) {
      state={revision:policy.revision,days:policy.days,cutoff:now-policy.days*day,started_at:now,completed_at:null,cursor:null,deleted:0,failed:0,compaction_pending:!!state?.compaction_pending};
      this.save(state);
    }
    if(state.completed_at!==null){await this.reclaim(state);return state;}
    for(let batch=0;batch<this.maxBatches&&!this.closed;batch++) {
      const current=validatePolicy(await this.readPolicy());
      if(!current.enabled||current.revision!==policy.revision||current.days!==policy.days)break;
      const result=await this.runBatch({cutoff:state.cutoff,now,cursor:state.cursor,limit:this.batchSize});
      state.cursor=result.cursor??state.cursor;state.deleted+=result.deleted??0;state.failed+=result.failed??0;
      if(result.deleted)state.compaction_pending=true;
      if(!result.hasMore)state.completed_at=now;
      this.save(state);
      if(state.completed_at!==null){await this.reclaim(state);this.onSweep(state);break;}
      await new Promise(resolve=>setImmediate(resolve));
    }
    return state;
  }
  async stop(){this.closed=true;await this.current?.catch(()=>{});}
}

// SQLite DELETE alone leaves pages allocated. Contract only while the owner is
// idle; existing databases are converted once, new incremental sweeps reuse it.
export function compactHistoryDatabase(db,{idle=false,minFreePages=256}={}) {
  if(!idle)return {skipped:true};
  const free=db.prepare('PRAGMA freelist_count').get().freelist_count;
  if(free<minFreePages)return {skipped:false,reclaimedPages:0};
  if(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum===2)db.exec('PRAGMA incremental_vacuum');
  else db.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return {skipped:false,reclaimedPages:free-db.prepare('PRAGMA freelist_count').get().freelist_count};
}
