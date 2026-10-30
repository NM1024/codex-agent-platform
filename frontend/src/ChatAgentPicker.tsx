import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties} from 'react';
import {Button,Drawer,Grid,Input,Popover,Switch} from 'antd';
import {useConsole} from './context';
import {Icon} from './Icon';
import {changeAgentModel} from './modelOptions';
import type {AgentSettings} from './types';

const effortOrder=['none','minimal','low','medium','high','xhigh'];
interface Props {
  value:AgentSettings;defaults:AgentSettings;onChange:(value:AgentSettings)=>void;
  disabled?:boolean;saving?:boolean;saveError?:string;onRetry:()=>void;
}

export function ChatAgentPicker({value,defaults,onChange,disabled=false,saving=false,saveError,onRetry}:Props) {
  const {catalog,t}=useConsole(),screens=Grid.useBreakpoint(),mobile=!screens.lg;
  const [open,setOpen]=useState(false),[search,setSearch]=useState('');
  const [placement,setPlacement]=useState<'topLeft'|'bottomLeft'>('topLeft'),[availableHeight,setAvailableHeight]=useState(560);
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const chosen=value.model??defaults.model,model=catalog.models.find(item=>item.model===chosen);
  const globalModel=catalog.models.find(item=>item.model===defaults.model);
  const modelName=model?.displayName??chosen??t('模型默认');
  const differentModel=!!value.model&&value.model!==defaults.model;
  const serviceTier=value.serviceTier??defaults.serviceTier??'default';
  const fastSupported=model?.serviceTiers?.some(item=>item.id==='priority')===true;
  const inherited=(!differentModel?defaults.reasoningEffort:undefined)??model?.defaultReasoningEffort;
  const overridden=Object.hasOwn(value,'reasoningEffort');
  const effective=overridden?(value.reasoningEffort??model?.defaultReasoningEffort):inherited;
  const efforts=Array.from(new Map((model?.supportedReasoningEfforts??[]).map(item=>[item.reasoningEffort,item])).values())
    .sort((a,b)=>{const ai=effortOrder.indexOf(a.reasoningEffort),bi=effortOrder.indexOf(b.reasoningEffort);return ai<0||bi<0?0:ai-bi;});
  const effortKey=efforts.map(item=>item.reasoningEffort).join(','),effectiveIndex=efforts.findIndex(item=>item.reasoningEffort===effective);
  const [preview,setPreview]=useState(effectiveIndex),previewRef=useRef(effectiveIndex),dirty=useRef(false);
  const label=(effort:string|null|undefined)=>effort??'default';
  const source=overridden?(value.reasoningEffort===null?t('模型默认'):t('自定义思考程度')):t(differentModel?'所选模型默认':'继承全局设置');
  const shown=preview>=0?efforts[preview]?.reasoningEffort:effective;
  useLayoutEffect(()=>{previewRef.current=effectiveIndex;dirty.current=false;setPreview(effectiveIndex);},[chosen,effective,effortKey,effectiveIndex]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useLayoutEffect(()=>{
    if(!open||mobile)return;
    const update=()=>{
      if(!trigger.current)return;
      const rect=trigger.current.getBoundingClientRect(),viewport=window.visualViewport;
      const top=viewport&&Math.abs(viewport.scale-1)<.01?viewport.offsetTop:0,bottom=top+(viewport&&Math.abs(viewport.scale-1)<.01?viewport.height:window.innerHeight);
      const above=rect.top-top-16,below=bottom-rect.bottom-16;
      setPlacement(above>=below?'topLeft':'bottomLeft');setAvailableHeight(Math.max(72,Math.min(560,Math.max(above,below))));
    };
    update();const observer=new ResizeObserver(update);if(trigger.current)observer.observe(trigger.current);
    window.addEventListener('resize',update);window.visualViewport?.addEventListener('resize',update);window.visualViewport?.addEventListener('scroll',update);
    return()=>{observer.disconnect();window.removeEventListener('resize',update);window.visualViewport?.removeEventListener('resize',update);window.visualViewport?.removeEventListener('scroll',update);};
  },[open,mobile]);
  const close=(restoreFocus=false)=>{setOpen(false);setSearch('');if(restoreFocus)trigger.current?.focus();};
  const setEffort=(effort:string)=>{if(value.reasoningEffort!==effort)onChange({...value,reasoningEffort:effort});};
  const commit=()=>{
    if(!dirty.current)return;dirty.current=false;
    const next=efforts[previewRef.current]?.reasoningEffort;
    if(next!==undefined&&previewRef.current!==effectiveIndex)setEffort(next);
  };
  const reset=()=>{if(overridden){const next={...value};delete next.reasoningEffort;onChange(next);}};
  const selectModel=(id:string|undefined)=>{if(value.model!==id){setSearch('');onChange(changeAgentModel(value,id,true));}};
  const chooseByKey=(event:React.KeyboardEvent<HTMLDivElement>)=>{
    if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const current=buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(['ArrowDown','ArrowRight'].includes(event.key)?1:-1)+buttons.length)%buttons.length;
    event.preventDefault();buttons[next]?.focus();buttons[next]?.click();
  };
  const filtered=catalog.models.filter(item=>(item.displayName+' '+item.model).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const modelTabStop=value.model&&filtered.some(item=>item.model===value.model)?value.model:undefined;
  const content=<div ref={panel} className="chat-agent-panel" style={mobile?undefined:{maxHeight:availableHeight}} role={mobile?undefined:'dialog'} aria-label={mobile?undefined:t('模型与思考设置')} tabIndex={-1}
    onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
      if(!mobile&&event.key==='Tab'){
        const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')).filter(control=>control.tabIndex>=0&&control.getClientRects().length>0);
        const first=controls[0],last=controls.at(-1);
        if(event.shiftKey&&(document.activeElement===first||document.activeElement===event.currentTarget)){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }}>
    {!mobile&&<div className="chat-agent-heading"><h3>{t('模型与思考设置')}</h3><Button size="small" type="text" icon={<Icon name="close"/>} aria-label={t('关闭模型设置')} onClick={()=>close(true)}/></div>}
    <div className="chat-agent-body">
      {catalog.models.length>6&&<Input type="search" className="chat-agent-search" aria-label={t('搜索模型')} placeholder={t('搜索模型')} value={search} onChange={event=>setSearch(event.target.value)}/>}
      <div className="chat-agent-models" role="radiogroup" aria-label={t('模型')} onKeyDown={chooseByKey}>
        <button type="button" className="chat-agent-option" role="radio" aria-label={t('继承全局设置')} aria-checked={!value.model} tabIndex={modelTabStop===undefined?0:-1} disabled={disabled} onClick={()=>selectModel(undefined)}>
          <span className="chat-agent-option-copy"><span>{t('继承全局设置')}</span><small title={`${globalModel?.displayName??defaults.model??t('模型默认')} · ${label(defaults.reasoningEffort??globalModel?.defaultReasoningEffort)}`}>{globalModel?.displayName??defaults.model??t('模型默认')} · {label(defaults.reasoningEffort??globalModel?.defaultReasoningEffort)}</small></span>{!value.model&&<Icon name="check"/>}
        </button>
        {value.model&&!model&&<div className="chat-agent-unavailable">{t('当前保存值：{value}',{value:value.model})}</div>}
        {filtered.map(item=><button type="button" key={item.model} className="chat-agent-option" role="radio" aria-label={item.displayName} aria-checked={value.model===item.model} tabIndex={modelTabStop===item.model?0:-1} disabled={disabled} title={item.model} onClick={()=>selectModel(item.model)}>
          <span className="chat-agent-option-copy"><span>{item.displayName}</span>{item.defaultReasoningEffort&&<small>{item.defaultReasoningEffort}</small>}</span>{value.model===item.model&&<Icon name="check"/>}
        </button>)}
        {!filtered.length&&<p className="chat-agent-empty">{t(catalog.models.length?'没有匹配的模型':'模型列表暂不可用，保留当前配置。')}</p>}
      </div>
      <section className="chat-effort-card" aria-label={t('思考程度')}>
        <div className="chat-effort-heading"><strong aria-live="polite">{label(shown)}</strong><Button type="text" size="small" icon={<Icon name="reset"/>} aria-label={t('恢复默认思考程度')} title={t('恢复默认思考程度')} disabled={disabled||!overridden} onClick={reset}/></div>
        <div className="chat-effort-caption"><span title={modelName}>{modelName}</span><small id="chat-reasoning-source">{source}</small></div>
        {efforts.length>1&&effectiveIndex>=0&&<div className="chat-effort-track" style={{'--effort-percent':`${Math.max(0,preview)/(efforts.length-1)*100}%`} as CSSProperties}>
          <input id="chat-reasoningEffort" type="range" min={0} max={efforts.length-1} step={1} value={Math.max(0,preview)} disabled={disabled} aria-label={t('思考程度')} aria-valuetext={label(shown)} aria-describedby="chat-reasoning-source"
            onChange={event=>{const index=Number(event.target.value);previewRef.current=index;dirty.current=true;setPreview(index);}}
            onPointerDown={event=>event.currentTarget.setPointerCapture(event.pointerId)} onPointerUp={commit} onBlur={commit} onKeyUp={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))commit();}}
            onPointerCancel={()=>{dirty.current=false;previewRef.current=effectiveIndex;setPreview(effectiveIndex);}}/>
          <div className="chat-effort-dots" aria-hidden="true">{efforts.map((item,index)=><i key={item.reasoningEffort} style={{left:`${index/(efforts.length-1)*100}%`}}/>)}</div>
        </div>}
        {!!efforts.length&&<div className="chat-effort-labels" style={{gridTemplateColumns:`repeat(${efforts.length},minmax(0,1fr))`}}>{efforts.map(item=><button type="button" key={item.reasoningEffort} data-effort={item.reasoningEffort} aria-pressed={shown===item.reasoningEffort} title={item.description??item.reasoningEffort} disabled={disabled} onClick={()=>setEffort(item.reasoningEffort)}>{label(item.reasoningEffort)}</button>)}</div>}
        {!efforts.length&&<p className="chat-agent-empty">{t('暂时无法获取思考档位，保留当前设置。')}</p>}
        {!!efforts.length&&effectiveIndex<0&&<p className="chat-agent-empty">{t('当前保存值：{value}',{value:label(effective)})} · {t('请选择可用档位。')}</p>}
        {efforts.length===1&&<p className="chat-agent-empty">{t('仅支持此档位')}</p>}
        <div className="chat-effort-defaults"><span>{overridden?label(effective):t('跟随默认')}</span>{!differentModel&&<button type="button" disabled={disabled||value.reasoningEffort===null} aria-pressed={value.reasoningEffort===null} onClick={()=>onChange({...value,reasoningEffort:null})}>{t('使用模型默认')}</button>}</div>
        <div className="chat-speed-row"><span>{t('快速模式')}</span><div>{value.serviceTier!==undefined&&<Button size="small" type="text" aria-label={t('恢复默认响应速度')} title={t('恢复默认响应速度')} disabled={disabled} onClick={()=>{const next={...value};delete next.serviceTier;onChange(next);}}><Icon name="reset"/></Button>}<Switch size="small" aria-label={t('快速模式')} checked={serviceTier==='priority'} disabled={disabled||(!fastSupported&&serviceTier!=='priority')} onChange={enabled=>onChange({...value,serviceTier:enabled?'priority':'default'})}/></div></div>
        <p className="chat-speed-note">{t(!fastSupported?'当前模型暂不支持快速模式；可选择普通模式。':'快速模式会增加额度消耗。')}</p>
      </section>
      {saveError&&<div className="chat-agent-save-error" role="alert"><span title={saveError}>{t('保存失败，已保留当前选择。')}</span><Button type="link" size="small" disabled={disabled} onClick={onRetry}>{t('重试保存')}</Button></div>}
    </div>
    <div className="chat-agent-footnote" role={saving?'status':undefined}>{t(saving?'正在保存…':'下一轮对话生效')}</div>
  </div>;
  const button=<Button ref={trigger} id="chat-model" type="text" className="chat-agent-trigger" aria-label={t('模型与思考设置')} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} title={`${modelName} · ${label(effective)} · ${t(serviceTier==='priority'?'快速模式':'普通模式')} · ${source}`} onClick={()=>{if(mobile)setOpen(!open);}}>
    {!value.model&&<span className="chat-agent-inherit-dot" aria-hidden="true"/>}<span className="chat-agent-trigger-name">{modelName}</span><span className="chat-agent-trigger-effort"> - {label(effective)}</span><Icon name="chevron"/>
  </Button>;
  // Keep only one live panel/slider in the DOM as the viewport changes.
  return <div className="chat-agent-picker" data-model={value.model??''} data-effort={value.reasoningEffort===null?'__model_default__':value.reasoningEffort??'__inherit__'} data-effective-effort={effective??''} data-service-tier={serviceTier}>
    {mobile?<>{button}<Drawer title={t('模型与思考设置')} placement="bottom" open={open} height="auto" classNames={{root:'chat-agent-sheet'}} closable={{placement:'end','aria-label':t('关闭模型设置')}} onClose={()=>close(true)} styles={{body:{padding:0}}}>{content}</Drawer></>:
      <Popover content={content} open={open} onOpenChange={next=>{setOpen(next);if(!next)setSearch('');}} trigger="click" placement={placement} arrow={false} destroyOnHidden classNames={{root:'chat-agent-popover'}} styles={{container:{padding:0}}} afterOpenChange={next=>{if(next&&!panel.current?.contains(document.activeElement))panel.current?.focus();}}>{button}</Popover>}
  </div>;
}
