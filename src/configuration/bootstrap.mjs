export const bootstrapSettings=[
  {names:['PORT','MCP_PORT','PLATFORM_PORT','MANAGER_PORT','MANAGER_MCP_PORT'],description:'服务监听及容器端口映射，修改后需重新部署。'},
  {names:['TASK_DB_PATH','WORKSPACE_DIR','MANAGER_DATA_DIR','PLATFORM_DATA_DIR','CODEX_HOME','CODEX_LOGIN_HOME','HOST_PROC_PATH'],description:'数据库、卷、认证及已安装资料路径；涉及挂载或迁移，需部署调整。插件可热选择已注册资源。'},
  {names:['RUNNER_URL','GATEWAY_INTERNAL_URL','RUNNER_TOKEN'],description:'服务间连接与引导凭证，需要协调部署；不通过配置接口返回凭证。'},
];
