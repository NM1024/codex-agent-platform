# Codex Agent Platform

[English](README.md) · [架构](docs/ARCHITECTURE.md) · [插件](docs/PLUGINS.md) · [部署](docs/DEPLOYMENT.md)

把 Codex Agent 包装成可接收 API 任务、按约定返回结果的自托管平台。

一次请求对应一个独立任务、一个 Codex 对话。平台一次性给出完整任务、提示词和必要 MCP，Agent 自主执行并调用 `complete_task` 提交结果。平台负责接单、排队、调度、状态、恢复和记录；具体步骤与业务规则由插件提示词负责。

已有能力：

- JSON 插件：输入和输出 Schema、提示词、工具、路由、交付方式。
- 通用内容审核、图文小说示例，可通过控制台或管理 Agent 修改和新增插件。
- 独立管理 Agent 与 Admin 控制台：查看任务、错误、产物、运行资源；重试、管理插件和定时任务。
- 持久化动态配置：模型、并发、队列、暂停、超时、入口密钥、HTTP 目标、管理提示词及会话有效期。
- 重启恢复未完成任务；同一请求编号再次发送仍创建新任务；已结束任务不自动重跑。
- 原生生图、文本产物、可选 HTTP 交付；不提供 API Key 或其他生图服务的回退。

这是预览版本，当前控制台与示例提示词使用中文。需要 Node.js 24、Docker Compose v2，以及自己的 ChatGPT 登录和对应模型/能力权限；项目并非 OpenAI 官方产品。

## 部署

源码和运行数据分开存放。详细命令、HTTPS 反代、密码和备份见 [部署文档](docs/DEPLOYMENT.md)。

```bash
./deploy.sh init /data/codex-agent-platform
./deploy.sh build /data/codex-agent-platform
./deploy.sh login /data/codex-agent-platform
./deploy.sh start /data/codex-agent-platform
```

Admin：`http://127.0.0.1:3007/admin/`。初始密码独立随机生成，保存在运行目录 `manager/initial-password`，首次登录后可修改。HTTP API 使用 `.env` 内的 `INGRESS_TOKEN`；`RUNNER_TOKEN` 只用于内部服务通信。普通运行参数初始化后在控制台或管理 MCP 修改；端口、卷和内部连接仍属于部署配置。

发布包只包含平台源码、通用示例和合成测试数据，不包含账户认证、运行数据库、密钥或证书。MIT 许可证仅覆盖本项目源码；第三方服务与依赖遵守各自条款。
