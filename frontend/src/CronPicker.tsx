import {useEffect,useId,useLayoutEffect,useRef,useState,type CSSProperties} from 'react';
import {Button,Input,InputNumber,Popover,Select} from 'antd';
import type {InputRef} from 'antd';
import {CronExpressionParser} from 'cron-parser';
import {useConsole} from './context';
import {Icon} from './Icon';
import {cronForMode,cronMode,cronPresets} from './cronTiming';
import './cron-picker.css';

const weekdays=['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];

export function CronPicker({id,value,onChange}:{id:string;value:string;onChange:(value:string)=>void}) {
 const {t}=useConsole();
 const [open,setOpen]=useState(false),[custom,setCustom]=useState<string|null>(null);
 const [viewport,setViewport]=useState<{height:number;top:number;width:number}|null>(null);
 const root=useRef<HTMLDivElement>(null),panel=useRef<HTMLDivElement>(null),input=useRef<InputRef>(null),skipFocus=useRef(false);
 const popupId=useId(),hintId=useId(),mode=custom===value?'custom':cronMode(value),parts=value.trim().split(/\s+/);
 let valid=true;try{if(parts.length!==5)throw new Error();CronExpressionParser.parse(value).next();}catch{valid=false;}
 const close=(restore=false)=>{setOpen(false);if(restore){skipFocus.current=true;input.current?.focus();skipFocus.current=false;}};
 const focusPanel=()=>{requestAnimationFrame(()=>panel.current?.querySelector<HTMLElement>('#schedule-frequency')?.focus());};
 useEffect(()=>{
  if(!open)return;
  const outside=(event:Event)=>{const target=event.target as HTMLElement;
   // Modal enter animation may focus its own container after the picker opens.
   if(event.type==='focusin'&&target===root.current?.closest('[aria-modal="true"]'))return;
   if(!root.current?.contains(target)&&!panel.current?.contains(target)&&!target.closest('.cron-picker-select-dropdown'))setOpen(false);};
  document.addEventListener('pointerdown',outside);document.addEventListener('focusin',outside);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',outside);};
 },[open]);
 useLayoutEffect(()=>{
  if(!open)return;
  const update=()=>{const visible=window.visualViewport;setViewport({height:visible?.height??window.innerHeight,top:visible?.offsetTop??0,width:visible?.width??window.innerWidth});};
  update();window.addEventListener('resize',update);window.visualViewport?.addEventListener('resize',update);window.visualViewport?.addEventListener('scroll',update);
  return()=>{window.removeEventListener('resize',update);window.visualViewport?.removeEventListener('resize',update);window.visualViewport?.removeEventListener('scroll',update);};
 },[open]);
 const compact=viewport&&(viewport.width<=720||viewport.height<=480);
 const popupStyle:CSSProperties=compact?{position:'fixed',left:'50%',top:viewport.top+viewport.height/2,right:'auto',bottom:'auto',transform:'translate(-50%, -50%)'}:{};
 const setMode=(next:string)=>{setCustom(next==='custom'?value:null);if(next!=='custom')onChange(cronForMode(value,next));};
 const clock=`${String(Number(parts[1])||0).padStart(2,'0')}:${String(Number(parts[0])||0).padStart(2,'0')}`;
 const content=<div id={popupId} ref={panel} role="dialog" aria-label={t('Cron 选择器')} className="cron-picker-panel" style={viewport?{maxHeight:Math.max(120,viewport.height-24)}:undefined} onKeyDown={event=>{
  if(event.key==='Escape'){
   // Let an open Select consume its first Escape before closing the picker.
   if(event.target instanceof HTMLElement&&event.target.getAttribute('aria-expanded')==='true')return;
   event.preventDefault();event.stopPropagation();close(true);
  }
  if(event.key==='Tab'){
   const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')).filter(control=>control.tabIndex>=0&&control.getClientRects().length);
   if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();close(true);}
   else if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();close(true);}
  }
 }}>
  <div className="cron-picker-heading"><strong>{t('Cron 选择器')}</strong><Button type="text" size="small" icon={<Icon name="close"/>} aria-label={t('关闭 Cron 选择器')} onClick={()=>close(true)}/></div>
  <div className="cron-picker-body">
   <label htmlFor="schedule-frequency">{t('执行频率')}</label><Select virtual={false} id="schedule-frequency" value={mode} options={cronPresets.map(([preset,label])=>({value:preset,label:t(label)}))} onChange={setMode} classNames={{popup:{root:'cron-picker-select-dropdown'}}}/>
   {['daily','weekly','monthly'].includes(mode)&&<><label htmlFor="schedule-time">{t('执行时间')}</label><Input id="schedule-time" type="time" value={clock} onChange={event=>{if(!event.target.value)return;const [hour,minute]=event.target.value.split(':').map(Number);onChange(`${minute} ${hour} ${mode==='monthly'?parts[2]:'*'} * ${mode==='weekly'?parts[4]:'*'}`);}}/></>}
   {mode==='weekly'&&<><label htmlFor="schedule-weekday">{t('执行日期')}</label><Select virtual={false} id="schedule-weekday" value={Number(parts[4])} options={weekdays.map((label,day)=>({value:day,label:t(label)}))} onChange={day=>onChange(`${parts[0]} ${parts[1]} * * ${day}`)} classNames={{popup:{root:'cron-picker-select-dropdown'}}}/></>}
   {mode==='monthly'&&<><label htmlFor="schedule-monthday">{t('每月日期')}</label><InputNumber id="schedule-monthday" min={1} max={28} precision={0} value={Number(parts[2])} onChange={day=>{if(day)onChange(`${parts[0]} ${parts[1]} ${day} * *`);}}/><small>{t('可选 1–28 日，确保每月都执行。')}</small></>}
   {mode==='custom'&&<><label htmlFor={`${id}-custom`}>{t('自定义 Cron')}</label><Input id={`${id}-custom`} className="code-input" value={value} aria-invalid={!valid} onChange={event=>{setCustom(event.target.value);onChange(event.target.value);}}/></>}
   <p>{t('分 时 日 月 周；可直接编辑，复杂规则会显示为自定义。')}</p>
  </div>
  <div className="cron-picker-footer"><code title={value}>{value||'—'}</code><Button size="small" type="primary" onClick={()=>close(true)}>{t('完成')}</Button></div>
 </div>;
 return <div ref={root} className="cron-picker-field">
  <Popover open={open} trigger={[]} placement="bottomLeft" arrow={false} autoAdjustOverflow destroyOnHidden content={content} classNames={{root:'cron-picker-popover'}} styles={{root:popupStyle,container:{padding:0}}}>
   <div className="cron-picker-anchor"><Input ref={input} id={id} value={value} placeholder="0 9 * * *" className="code-input" aria-invalid={!valid} aria-describedby={hintId} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?popupId:undefined} onFocus={()=>{if(!skipFocus.current)setOpen(true);}} onChange={event=>{setCustom(null);onChange(event.target.value);}} onKeyDown={event=>{
    if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();close();}
    if(event.key==='ArrowDown'){event.preventDefault();setOpen(true);focusPanel();}
   }} suffix={<Button type="text" size="small" aria-label={t('打开 Cron 选择器')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?popupId:undefined} onClick={()=>{setOpen(!open);if(!open)focusPanel();}} icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 5h16v16H4z M8 2v6 M16 2v6 M4 11h16 M8 15h2 M14 15h2"/></svg>}/>} status={valid?undefined:'error'}/></div>
  </Popover>
  {!valid&&<div id={hintId} className="cron-picker-error" role="status">{t('请输入有效的五字段 Cron 规则。')}</div>}
 </div>;
}
