export function retentionScope() {
  return {
    name:'retention',title:'历史数据清理',requireRevision:true,
    description:'默认关闭。开启后每天分批永久删除到期的管理对话、任务记录及关联图片和文件；保留未结束的工作、插件、定时计划和账号配置。',
    schema:{type:'object',additionalProperties:false,required:['enabled','days'],properties:{
      enabled:{type:'boolean',title:'自动清理历史数据'},
      days:{type:'integer',minimum:1,maximum:3650,title:'保留天数'},
    }},
    defaults:{enabled:false,days:60},
  };
}
