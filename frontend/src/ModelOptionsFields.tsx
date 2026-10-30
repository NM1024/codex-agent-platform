import {Collapse,Form,InputNumber,Select} from 'antd';
import {useConsole} from './context';
import {budgetSettings,tokenLimitMaximum} from './modelOptions';
import type {AgentSettings} from './types';

type BudgetKey=keyof typeof budgetSettings;
interface Props {id:string;value:AgentSettings;onChange:(value:AgentSettings)=>void;defaults?:AgentSettings;inherit?:boolean;disabled?:boolean}

export function ModelOptionsFields({id,value,onChange,defaults={},inherit=false,disabled=false}:Props) {
  const {t}=useConsole();
  const verbosityLabels={low:'简洁',medium:'适中',high:'详细'};
  const summaryLabels={auto:'自动摘要',concise:'简要摘要',detailed:'详细摘要',none:'不显示摘要'};
  const set=(key:keyof AgentSettings,next:string|number|null)=>{
    const updated={...value};
    if(next==='__inherit__')delete updated[key];else Object.assign(updated,{[key]:next});
    onChange(updated);
  };
  const inheritedOption=(label:string)=>({value:'__inherit__',label:t('继承全局设置：{value}',{value:label})});
  const budget=(key:BudgetKey,label:string,description:string)=>{
    const settings=budgetSettings[key],own=Object.hasOwn(value,key),current=value[key];
    const mode=inherit&&!own?'__inherit__':typeof current==='number'?'manual':'auto';
    const inherited=defaults[key];
    return <div className="model-budget-field" key={key}>
      <Form.Item label={t(label)} htmlFor={id+'-'+key+'-mode'} extra={t(description)}>
        <Select id={id+'-'+key+'-mode'} aria-label={t(label)} disabled={disabled} value={mode} options={[
          ...(inherit?[inheritedOption(typeof inherited==='number'?String(inherited):t('自动'))]:[]),
          {value:'auto',label:t('自动')},{value:'manual',label:t('手动')},
        ]} onChange={mode=>set(key,mode==='__inherit__'?mode:mode==='auto'?null:typeof current==='number'?current:settings.suggestion)}/>
      </Form.Item>
      {mode==='manual'&&<Form.Item className="model-budget-input" label={t('Token 数')} htmlFor={id+'-'+key} extra={t('整数范围：{min}–{max}',{min:settings.minimum,max:tokenLimitMaximum})}>
        <InputNumber id={id+'-'+key} aria-label={t(label)+' · '+t('Token 数')} min={settings.minimum} max={tokenLimitMaximum} precision={0} step={1} disabled={disabled} value={current??settings.suggestion} onChange={number=>{if(typeof number==='number'&&Number.isInteger(number)&&number>=settings.minimum&&number<=tokenLimitMaximum)set(key,number);}}/>
      </Form.Item>}
    </div>;
  };
  return <Collapse className="model-options-collapse" size="small" items={[{key:'advanced',label:t('高级模型参数'),children:<div className="model-options-fields">
    <Form.Item label={t('回复详细程度')} htmlFor={id+'-verbosity'} extra={t('控制回复详细倾向，并非硬性长度限制；实际效果取决于模型。')}>
      <Select id={id+'-verbosity'} aria-label={t('回复详细程度')} disabled={disabled} value={value.verbosity??(inherit?'__inherit__':'medium')} options={[
        ...(inherit?[inheritedOption(t(verbosityLabels[defaults.verbosity??'medium']))]:[]),
        ...Object.entries(verbosityLabels).map(([value,label])=>({value,label:t(label)})),
      ]} onChange={next=>set('verbosity',next)}/>
    </Form.Item>
    <Form.Item label={t('思考摘要')} htmlFor={id+'-reasoningSummary'} extra={t('仅控制公开摘要，不改变思考程度。')}>
      <Select id={id+'-reasoningSummary'} aria-label={t('思考摘要')} disabled={disabled} value={value.reasoningSummary??(inherit?'__inherit__':'auto')} options={[
        ...(inherit?[inheritedOption(t(summaryLabels[defaults.reasoningSummary??'auto']))]:[]),
        ...Object.entries(summaryLabels).map(([value,label])=>({value,label:t(label)})),
      ]} onChange={next=>set('reasoningSummary',next)}/>
    </Form.Item>
    {budget('autoCompactTokenLimit','自动压缩阈值','自动跟随模型；手动阈值不会扩展真实上下文上限。')}
    {budget('toolOutputTokenLimit','工具输出预算','自动跟随模型；预算过小可能截断重要工具信息。')}
  </div>}]}/>;
}
