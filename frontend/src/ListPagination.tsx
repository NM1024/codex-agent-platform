import {Button,Select,Typography} from 'antd';
import {useConsole} from './context';

export const PAGE_SIZES=[10,20,50,100] as const;
export const DEFAULT_PAGE_SIZE=20;
interface Props {
  id?:string;page:number;pageSize:number;total?:number|null;totalComplete?:boolean;
  loading?:boolean;disabled?:boolean;hasPrevious:boolean;hasNext:boolean;
  onPrevious:()=>void;onNext:()=>void;onPageSizeChange:(size:number)=>void;
}
export function ListPagination({id,page,pageSize,total,totalComplete=true,loading=false,disabled=false,hasPrevious,hasNext,onPrevious,onNext,onPageSizeChange}:Props){
  const {t}=useConsole(),inactive=loading||disabled;
  const known=typeof total==='number'&&Number.isSafeInteger(total)&&total>=0&&totalComplete;
  return <nav id={id} className="list-pagination" aria-label={t('分页')} aria-busy={loading}>
    <Typography.Text className="list-pagination-total" type="secondary">{known?t('共 {total} 条',{total:total.toLocaleString()}):t('总条数暂不可用')}</Typography.Text>
    <Select className="list-pagination-size" aria-label={t('每页条数')} value={pageSize} disabled={inactive} virtual={false} options={PAGE_SIZES.map(count=>({value:count,label:t('{count} 条/页',{count})}))} onChange={value=>{if(PAGE_SIZES.some(size=>size===value)&&value!==pageSize)onPageSizeChange(value);}}/>
    <div className="list-pagination-pages">
      <Button disabled={inactive||!hasPrevious} onClick={onPrevious}>{t('上一页')}</Button>
      <Typography.Text className="list-pagination-current">{t('第 {page} 页',{page})}</Typography.Text>
      <Button disabled={inactive||!hasNext} onClick={onNext}>{t('下一页')}</Button>
    </div>
  </nav>;
}
export default ListPagination;
