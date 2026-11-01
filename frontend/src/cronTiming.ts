export const cronPresets=[['daily','每天'],['weekly','每周'],['monthly','每月'],['5','每 5 分钟'],['15','每 15 分钟'],['30','每 30 分钟'],['hourly','每小时'],['custom','自定义 Cron']] as const;

/** Only exact picker-supported expressions are simplified; other expressions stay intact. */
export function cronMode(expression:string):string {
 const parts=expression.trim().split(/\s+/),[minute,hour,day,month,week]=parts;
 if(parts.length!==5)return 'custom';
 const normalized=parts.join(' ');
 for(const interval of ['5','15','30'])if(normalized===`*/${interval} * * * *`)return interval;
 if(normalized==='0 * * * *')return 'hourly';
 if(!/^\d+$/.test(minute)||!/^\d+$/.test(hour)||Number(minute)>59||Number(hour)>23||month!=='*')return 'custom';
 if(day==='*'&&week==='*')return 'daily';
 if(day==='*'&&/^[0-6]$/.test(week))return 'weekly';
 if(/^\d+$/.test(day)&&Number(day)>=1&&Number(day)<=28&&week==='*')return 'monthly';
 return 'custom';
}

export function cronForMode(expression:string,mode:string):string {
 if(mode==='custom')return expression;
 const parts=expression.trim().split(/\s+/);
 const minute=/^\d+$/.test(parts[0])&&Number(parts[0])<=59?Number(parts[0]):0;
 const hour=/^\d+$/.test(parts[1])&&Number(parts[1])<=23?Number(parts[1]):9;
 if(mode==='daily')return `${minute} ${hour} * * *`;
 if(mode==='weekly')return `${minute} ${hour} * * 1`;
 if(mode==='monthly')return `${minute} ${hour} 1 * *`;
 return mode==='hourly'?'0 * * * *':`*/${mode} * * * *`;
}
