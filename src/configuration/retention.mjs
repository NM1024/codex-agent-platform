export function retentionScope() {
  return {
    name:'retention',title:'历史数据清理',requireRevision:true,
    description:'默认关闭。开启后每天分批永久删除到期的管理对话、任务记录及关联图片和文件。系统日志、已完成后台工作和已恢复问题的历史记录遵循同一启用开关与保留天数；未完成工作、未恢复问题及必要证据受保护，保留插件、定时计划和账号配置。',
    schema:{type:'object',additionalProperties:false,required:['enabled','days'],properties:{
      enabled:{type:'boolean',title:'自动清理历史数据'},
      days:{type:'integer',minimum:1,maximum:3650,title:'保留天数'},
    }},
    defaults:{enabled:false,days:60},
  };
}
