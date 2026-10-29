import {registerEnglish} from './i18n.ts';

registerEnglish({
  '模型设置':'Model settings',
  '模型设置：{name}':'Model settings: {name}',
  '保存模型设置':'Save model settings',
  '仅用于此业务插件的新任务；已接单任务保持原有设置。留空继承全局设置。':'Applies to new tasks for this plugin. Accepted tasks keep their saved settings. Leave overrides unset to inherit global settings.',
  '模型设置暂时无法读取，请重试。':'Model settings could not be loaded. Please retry.',
  '模型设置保存失败，请重试。':'Model settings could not be saved. Please retry.',
  '业务插件已被修改，请重新读取后再保存。':'This plugin has changed. Reload it before saving.',
});
