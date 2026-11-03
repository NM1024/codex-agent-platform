import {systemFailure,systemDue,systemObserve} from '../observability/system-maintenance.mjs';
import { lifecycleDetails } from "./codex.mjs";
import { join } from "node:path";
import { readdir, unlink, stat } from "node:fs/promises";
import { safeDirectory, atomicJson, readRegular } from "../files.mjs";

export class EventOutbox {
  constructor({ workspace, send, journal }) {
    this.directory = join(workspace, ".agent-events");
    this.send = send;this.journal=journal;
    this.closed = false;
  }
  async publish(run_id, code, details) {
    if (!/^[a-f0-9-]{36}$/.test(run_id)) throw new Error("INVALID_RUN");
    await safeDirectory(this.directory);
    await atomicJson(join(this.directory, `${run_id}.${details?.generation ?? 0}.${code}.json`), {
      run_id, code, ...(details ? { details: lifecycleDetails(details) } : {}),
    });
    await this.flush();
  }
  flush({force=false}={}) {
    if(!systemDue(this.journal,'event-outbox',{force})){this.schedule();return Promise.resolve();}
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = this.sendPending().catch(error=>{systemFailure(this.journal,{id:'event-outbox',module:'events',code:'EVENT_DELIVERY_FAILED',allowed_actions:['event_flush']},error);this.schedule();throw error;}).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }
  async sendPending() {
    do {
      this.again = false;
      await safeDirectory(this.directory);
      let pending=0,oldest=Date.now(),failure;
      for (const name of await readdir(this.directory)) {
        if (this.closed) return;
        if (!/^[a-f0-9-]{36}(?:\.[0-9]+\.[A-Z_]+)?\.json$/.test(name)) continue;
        const path = join(this.directory, name);
        try {
          const event = JSON.parse(
            await readRegular(this.directory, path, 16384),
          );
          await this.send(event);
          await unlink(path);
        } catch(error) {
          pending++;failure=error;try{oldest=Math.min(oldest,Math.floor((await stat(path)).mtimeMs));}catch{}
          /* Keep uncertain delivery durable; its receiver is idempotent. */
        }
      }
      const work={id:'event-outbox',module:'events',pending_count:pending,allowed_actions:['event_flush'],details:pending?{oldest_pending_at:oldest}:{}};
      if(pending)systemFailure(this.journal,{...work,code:'EVENT_DELIVERY_FAILED'},failure);
      else systemObserve(this.journal,{...work,state:'completed',code:'EVENT_DELIVERED'});
    } while (this.again && !this.closed);
    this.schedule();
  }
  schedule(){if(!this.closed&&!this.timer)this.timer=setTimeout(()=>{this.timer=null;void this.flush().catch(()=>{});},15000);}
  async stop() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.flushing;
  }
}
