import {registerEnglish} from './i18n.ts';

registerEnglish({
  '历史数据清理':'History retention',
  '自动清理历史数据':'Automatically delete history',
  '保留天数':'Retention days',
  '{days} 天':'{days} days',
  '保存清理设置':'Save retention settings',
  '已保存历史清理设置。':'History retention settings saved.',
  '保留天数须为 1 至 3650 的整数。':'Retention days must be an integer from 1 to 3650.',
  '历史清理设置保存失败，请重试。':'Could not save retention settings. Please retry.',
  '历史清理配置暂时无法读取，请重试。':'Could not load retention settings. Please retry.',
  '默认关闭。开启后每天分批永久删除到期的管理对话、任务记录及关联图片和文件；保留未结束的工作、插件、定时计划和账号配置。':'Off by default. When enabled, expired management chats, task history and associated images/files are permanently deleted in daily batches. Unfinished work, plugins, schedules and account settings are retained.',
  '删除不可恢复。开启或缩短保留天数后，已到期数据会从下一次后台检查开始清理。':'Deletion cannot be undone. Enabling cleanup or shortening retention makes expired data eligible from the next background check.',
  '对话按最后活动时间，任务按结束时间计算。排队、运行、等待恢复、未发送草稿和未完成回调暂不清理。关闭后不再开始新的清理批次。':'Chats expire from their last activity; tasks expire from completion. Queued, running or recovering work, unsent drafts and unfinished callbacks are kept. Disabling stops new cleanup batches.',
});
