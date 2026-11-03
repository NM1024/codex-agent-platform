import {SYSTEM_CODES} from './system-contracts.mjs';
import {systemObserve} from './system-maintenance.mjs';

export const SYSTEM_REPOSITORY_URL='https://github.com/NM1024/codex-agent-platform';
// Only known deployed source references may survive caller notes. Syntactically
// plausible filenames can themselves contain credentials/deployment identifiers.
const sourceFiles=new Set([
 ...['contracts','journal','maintenance','operations','report'].map(name=>`src/observability/system-${name}.mjs`),
 ...['operations','server','mcp','client','version','agent','sandbox','inspection-notifications','history-retention','project-source'].map(name=>`src/manager/${name}.mjs`),
 'src/api.mjs','src/operations/service.mjs','src/operations/schedules.mjs','src/runtime/client.mjs','src/runtime/server.mjs','src/runtime/events.mjs','src/core/dispatcher.mjs','src/history/worker.mjs','prompts/manager-project.md','docs/ARCHITECTURE.md',
]);
const credentialWords=new Set(['password','passwd','token','secret','key','authorization','cookie','credential','credentials','密码','令牌','密钥']);
const compactCredentialKeys=new Set(['accesstoken','refreshtoken','clientsecret','apikey','entrykey','signingsecret']);
function sensitiveAssignment(key) {
 const words=key.replace(/([A-Z])([A-Z][a-z])/g,'$1_$2').replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase().split(/[_-]+/);
 return credentialWords.has(words.at(-1))||compactCredentialKeys.has(key.toLowerCase());
}
function scrubCredentialAssignments(value) {
 // Scan only key prefixes until a sensitive assignment is found: consuming a
 // harmless label's value would skip any credential embedded in that value.
 const keys=/(?:\\*["'])?([\p{L}][\p{L}\p{N}_-]*)(?:\\*["'])?\s*[=:]\s*/gu;
 let match,from=0,result='';
 while((match=keys.exec(value))){
  if(!sensitiveAssignment(match[1]))continue;
  const start=keys.lastIndex,opening=/^(\\*)(["'])/.exec(value.slice(start));let end=start;
  if(opening){
   const escapes=opening[1].length,quote=opening[2];let slashes=0;end+=opening[0].length;
   // JSON string wrappers encode delimiter quotes with 0, 1, 3, ... slashes;
   // escaped quotes inside the value have the other parity at that depth.
   while(end<value.length){const char=value[end++];if(char===quote&&slashes%(2*(escapes+1))===escapes)break;slashes=char==='\\'?slashes+1:0;}
  }else{
   end+=(/^[^\s;,}\]"']+/.exec(value.slice(start))?.[0].length??0);
   if(value[end]==='"'||value[end]==="'")while(end>start&&value[end-1]==='\\')end--;
  }
  result+=value.slice(from,match.index)+'[redacted credential]';from=end;keys.lastIndex=end;
 }
 return result+value.slice(from);
}
/** Caller prose is untrusted and never persisted in the journal. Remove deployment
 * locators and credential-like content before producing an in-conversation draft. */
export function sanitizeSystemNote(value='') {
 return scrubCredentialAssignments(value.replace(/```[\s\S]*?```/g,'[redacted block]')
  .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,'[redacted key]'))
  .replace(/\b(?:Bearer|Basic)\s+[^\s;,]+/gi,'[redacted credential]')
  .replace(/["']?\b(?:password|passwd|(?:access[_-]?|refresh[_-]?)?token|(?:client[_-]?)?secret|authorization|api[_-]?key|cookie|credential|entrykey|signingsecret|deployment|hostname|host|server|container|(?:run|task|conversation|job)[_-]?id)\b["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,'[redacted credential or deployment]')
  .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g,'[redacted credential]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted credential]')
  .replace(/(?:https?|wss?|ssh):\/\/[^\s<>]+/gi,'[redacted address]')
  .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,'[redacted address]')
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]+\b/gi,'[redacted address]')
  .replace(/(?:[A-Za-z]:\\|\/)[^\s<>;,]+/g,'[redacted path]')
  .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b/gi,'[redacted host]')
  .replace(/\b[a-f0-9]{8}-[a-f0-9-]{27,}\b|\b[A-Za-z0-9_+\/-]{32,}={0,2}\b/gi,'[redacted identifier]')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'').slice(0,2000);
}
export function buildSystemIssueDraft({work,events,notes={},version='unknown'}) {
 const refs=(notes.source_refs??[]).filter(ref=>{const match=/^([^:]+)(?::([1-9][0-9]{0,5}))?$/.exec(ref);return match&&sourceFiles.has(match[1]);});
 const evidence_ids=[work.id,...events.map(e=>e.id)];
 const lines=['# Platform code-defect investigation','',`Version: ${/^\d+\.\d+\.\d+$/.test(version)?version:'unknown'}`,`Scope: ${work.service} / ${work.module}`,`Observed: ${new Date(work.updated_at).toISOString()}`,`State: ${work.state}; classification: ${work.classification}`,'Report topic: possible platform code defect (unverified)',`Safe cause: ${work.code} — ${SYSTEM_CODES[work.code]}`,`Attempts: ${work.attempts}; last attempt: ${work.last_attempt_at??'unknown'}`,'',...['diagnosis','reproduction','expected','actual'].flatMap(key=>[`## ${key[0].toUpperCase()+key.slice(1)} (caller-provided hypothesis)`,sanitizeSystemNote(notes[key]??'Not supplied.'),'']), '## Attempted actions',...events.filter(e=>e.details.action).map(e=>`- ${e.details.action}; ${e.code}; ${e.last_seen_at}`),'','## Evidence references',...evidence_ids.map(id=>`- ${id}`),'','## Source references',...(refs.length?refs:['Not supplied.']),'','## Uncertainty','Caller diagnosis is unverified. Missing or unavailable sources are not healthy evidence. A draft does not fix code, prove recovery or submit an issue. Developer review and human deployment may be required.'];
 return {classification:'code_defect',submitted:false,repository_url:SYSTEM_REPOSITORY_URL,markdown:lines.join('\n'),evidence_ids};
}
/** Request error observers accept no URL, body, prompt, credentials or raw message. */
export function observeSystemApiError(journal,error,{status}={}) {
 const code=Object.hasOwn(SYSTEM_CODES,error?.code)?error.code:'SYSTEM_ERROR';
 journal?.event({module:'api',event:'request_failed',level:'error',code,details:{...(Number.isInteger(status)&&status>=400&&status<=599?{status_code:status}:{})}});
}
export function observeSystemVersion(journal,value,{failed=false}={}) {
 if(failed)return systemObserve(journal,{id:'version-check',module:'upgrade',state:'unknown',code:'UPGRADE_UNKNOWN',allowed_actions:[],attempted:false});
 return systemObserve(journal,{id:value?.latest?'version-check':'running-version',module:'upgrade',state:'completed',code:'SYSTEM_OK',allowed_actions:[],details:{current_version:value?.current,latest_version:value?.latest,result:'success'},attempted:false});
}
export function observeSystemUpgrade(journal,value) {
 if(!value?.available)return systemObserve(journal,{id:'host-access',module:'upgrade',state:'disabled',code:'HOST_ACCESS_UNAVAILABLE',allowed_actions:[],details:{source:'host'},attempted:false});
 systemObserve(journal,{id:'host-access',module:'upgrade',state:'idle',code:'SYSTEM_OK',allowed_actions:[],details:{source:'host'},attempted:false});
 if(!value.job)return;
 const state={queued:'running',running:'running',succeeded:'completed',failed:'blocked',interrupted:'unknown'}[value.job.state]??'unknown';
 return systemObserve(journal,{id:'host-upgrade',module:'upgrade',state,code:state==='completed'?'UPGRADE_COMPLETED':state==='blocked'?'UPGRADE_FAILED':state==='running'?'WORK_RUNNING':'UPGRADE_UNKNOWN',allowed_actions:[],details:{source:'host',phase:value.job.phase,observed_progress_at:value.job.updated_at,target_version:value.job.target_version,installed_version:value.job.installed_version,result:state==='completed'?'success':state==='blocked'?'failure':state==='running'?'pending':'unknown'},attempted:false});
}
