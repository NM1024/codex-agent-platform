import { readFile,statfs } from 'node:fs/promises';
import { join } from 'node:path';

const number=(text,key)=>Number(text.match(new RegExp(`^${key}:?\\s+(\\d+)`,'m'))?.[1]);
export class ResourceSampler {
  constructor({procRoot='/host/proc',cgroupRoot='/sys/fs/cgroup',diskPath='/management',readDiskStats=statfs}={}){Object.assign(this,{procRoot,cgroupRoot,diskPath,readDiskStats});}
  async sample() {
    const files=[join(this.procRoot,'stat'),join(this.procRoot,'meminfo'),join(this.cgroupRoot,'cpu.max'),join(this.cgroupRoot,'cpu.stat'),join(this.cgroupRoot,'memory.current'),join(this.cgroupRoot,'memory.max')];
    const values=await Promise.allSettled(files.map(path=>readFile(path,'utf8'))),text=index=>values[index].status==='fulfilled'?values[index].value:null;
    const now=Date.now(),host={available:false,source:this.procRoot},container={source:'cgroup-v2'};
    if(text(0)) {
      const counters=text(0).split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number),total=counters.reduce((sum,x)=>sum+x,0),idle=counters[3]+counters[4];
      if(counters.length>=5&&Number.isFinite(total)) {
        host.available=true;host.cpu_percent=this.previousHost&&total>this.previousHost.total?Math.round(1000*(1-(idle-this.previousHost.idle)/(total-this.previousHost.total)))/10:null;
        host.cpu_cores=text(0).split('\n').filter(line=>/^cpu\d+\s/.test(line)).length;this.previousHost={total,idle};
      }
    }
    if(text(1)) {
      const total=number(text(1),'MemTotal'),available=number(text(1),'MemAvailable');
      if(Number.isFinite(total)&&total>0&&Number.isFinite(available)&&available<=total)Object.assign(host,{available:true,memory_total_bytes:total*1024,memory_used_bytes:(total-available)*1024,memory_available_bytes:available*1024});
    }
    if(text(2)) {
      const [quota,period]=text(2).trim().split(/\s+/),cores=Number(quota)/Number(period);
      if(quota==='max')container.quota_cores=null;
      else if(Number(period)>0&&Number.isFinite(cores)&&cores>0)container.quota_cores=cores;
    }
    if(text(3)) {
      const usage=number(text(3),'usage_usec');
      if(Number.isFinite(usage)) {container.cpu_percent=this.previousContainer&&now>this.previousContainer.time?Math.round((usage-this.previousContainer.usage)/(now-this.previousContainer.time)/10):null;this.previousContainer={time:now,usage};}
    }
    if(text(4)&&/^\d+$/.test(text(4).trim())&&Number.isSafeInteger(Number(text(4))))container.memory_used_bytes=Number(text(4).trim());
    if(text(5)?.trim()==='max')container.memory_limit_bytes=null;
    else if(text(5)&&/^\d+$/.test(text(5).trim())&&Number.isSafeInteger(Number(text(5)))&&Number(text(5))>0)container.memory_limit_bytes=Number(text(5).trim());
    let disk;try{const stats=await this.readDiskStats(this.diskPath);disk={path:this.diskPath,total_bytes:stats.blocks*stats.bsize,free_bytes:stats.bfree*stats.bsize,used_bytes:(stats.blocks-stats.bfree)*stats.bsize,available_bytes:stats.bavail*stats.bsize};}catch{disk={path:this.diskPath,available:false};}
    return {sampled_at:now,host,container,process:{pid:process.pid,memory_rss_bytes:process.memoryUsage().rss},disk};
  }
}
