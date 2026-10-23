import {Alert,Button,Input,Radio,Typography} from 'antd';
import {useConsole} from './context';
import {ApiError} from './api';
import type {QuestionRequest} from './types';

export function QuestionCard({request,conversationId}:{request:QuestionRequest;conversationId:string}) {
  const {api,t,questionDrafts,updateQuestionDraft,beginQuestionAnswer}=useConsole();
  const draftKey=conversationId+':'+request.id,draft=questionDrafts[draftKey],choices=draft?.choices??{},texts=draft?.texts??{};
  const busy=!!draft?.pending,accepted=!!draft?.answered;
  const error=draft?.error,expired=!!draft?.expired;
  const choice=(id:string)=>Object.hasOwn(choices,id)?choices[id]:'';
  const text=(id:string)=>Object.hasOwn(texts,id)?texts[id]:'';
  const active=request.status==='pending'&&!accepted&&!expired;
  const answers=Object.fromEntries(request.questions.map(q=>[q.id,{answers:[choice(q.id).startsWith('choice:')?q.options[Number(choice(q.id).slice(7))]?.label??'':text(q.id)]} ]));
  const valid=request.questions.every(q=>answers[q.id].answers[0].trim().length>0);
  const submit=async()=>{
    if(!active||!valid)return;
    const lease=beginQuestionAnswer(draftKey);if(!lease)return;
    try{await api(`/conversations/${encodeURIComponent(conversationId)}/questions/${encodeURIComponent(request.id)}/answer`,{answers});lease.accepted();}
    catch(caught){if(caught instanceof ApiError&&/QUESTION_EXPIRED|QUESTION_NOT_FOUND/.test(caught.message))lease.failed('',true);else lease.failed('回答提交失败，请保留内容并在连接恢复后重试。');}
    finally{lease.release();}
  };
  return <section className="question-card" aria-label={t('Agent 提问')}>
    <div className="question-heading"><Typography.Text strong>{t(active?'等待你的回答':request.status==='answered'||accepted?'已回答':'提问已失效')}</Typography.Text></div>
    {request.questions.map(q=><fieldset key={q.id} disabled={!active||busy}>
      <legend>{q.header}</legend><p>{q.question}</p>
      {active?<>
        {!!q.options.length&&<Radio.Group value={choice(q.id)} onChange={event=>{const value=event.target.value;updateQuestionDraft(draftKey,current=>({...current,choices:{...current.choices,[q.id]:value}}));}}>
          {q.options.map((o,index)=><Radio key={index} value={'choice:'+index}><strong>{o.label}</strong>{o.description&&<span className="question-option-description">{o.description}</span>}</Radio>)}
          {q.isOther&&<Radio value="other" aria-label={t('其他')}>{t('其他')}</Radio>}
        </Radio.Group>}
        {(!q.options.length||q.isOther&&choice(q.id)==='other')&&<Input.TextArea aria-label={t('补充回答')} maxLength={4000} autoSize={{minRows:2,maxRows:5}} value={text(q.id)} onChange={event=>{const value=event.target.value;updateQuestionDraft(draftKey,current=>({...current,texts:{...current.texts,[q.id]:value}}));}}/>}
      </>:<p className="question-answer">{request.answers&&Object.hasOwn(request.answers,q.id)?request.answers[q.id].answers.join(' · '):accepted?answers[q.id].answers[0]:t('请等待 Agent 重新提问。')}</p>}
    </fieldset>)}
    {active&&<div className="question-footer"><Typography.Text type="secondary">{t('回答会交回当前轮次，不会新建任务。请勿填写密钥或密码。')}</Typography.Text><Button type="primary" aria-label={t('提交回答')} loading={busy} disabled={!valid} onClick={()=>{void submit();}}>{t('提交回答')}</Button></div>}
    {error&&<Alert type="error" title={t(error)}/>}
  </section>;
}
