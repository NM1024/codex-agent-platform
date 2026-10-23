import {HttpError} from '../errors.mjs';
import {publicChatText} from './chat-progress.mjs';

export function normalizeQuestions(value,secrets=[]) {
  const invalid=()=>{throw new HttpError(400,'INVALID_QUESTIONS','管理 Agent 的提问格式无效。');};
  if(!Array.isArray(value)||!value.length||value.length>3)invalid();
  const text=(v,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max)invalid();return publicChatText(v,secrets,false,max);};
  const result=value.map(q=>{
    if(!q||typeof q!=='object')invalid();
    if(q.isSecret===true)throw new HttpError(400,'SECRET_QUESTION_DENIED','凭证请在业务插件的配置接入中填写，不要发送到管理对话。');
    const id=text(q.id,64);if(!/^[a-zA-Z0-9_-]+$/.test(id))invalid();
    if(q.options!=null&&(!Array.isArray(q.options)||q.options.length>5))invalid();
    const options=(q.options??[]).map(o=>({label:text(o?.label,120),description:typeof o?.description==='string'&&o.description.length<=500?publicChatText(o.description,secrets,false,500):invalid()}));
    if(new Set(options.map(o=>o.label)).size!==options.length)invalid();
    return {id,header:text(q.header,80),question:text(q.question,2000),isOther:q.isOther===true,options};
  });
  if(new Set(result.map(q=>q.id)).size!==result.length)invalid();
  return result;
}

export function validateAnswers(questions,value) {
  const invalid=()=>{throw new HttpError(400,'INVALID_ANSWERS','请回答每个问题，或检查答案是否过长。');};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==questions.length)invalid();
  return Object.fromEntries(questions.map(q=>{
    if(!Object.hasOwn(value,q.id))invalid();
    const answer=value[q.id]?.answers;
    if(!Array.isArray(answer)||answer.length!==1||typeof answer[0]!=='string'||!answer[0].trim()||answer[0].length>4000)invalid();
    if(q.options.length&&!q.isOther&&!q.options.some(o=>o.label===answer[0]))invalid();
    return [q.id,{answers:[answer[0]]}];
  }));
}
