# 实施路线

## 依赖顺序

先实现可信本地 Host 和单设备完整闭环，再增加 Pi、账号、远控和同步。不要让服务端或移动端抢在本地权限边界之前决定执行行为。

## 阶段一：宿主与工作区

1. 初始化 Tauri 2、React、TypeScript 和 Rust workspace。
2. 建立工作区领域模型、本地 SQLite、迁移和附件索引。
3. 实现插件 manifest、注册表、安装状态和设置页。
4. 实现 Rust capability broker、审批卡和本地审计。
5. 实现 `workspace-files`：搜索、读取、写入、创建、删除、diff。

**完成标准：** 桌面端可以在受控工作区内使用官方文件插件，所有写入均有审批和审计记录。

## 阶段二：本地 Pi Agent

1. 定义版本化 Host↔Runner JSON-RPC schema。
2. 捆绑 Node sidecar；实现启动、健康检查、取消和崩溃恢复。
3. 封装 Percho backend/Pi SDK；实现单会话、流式事件和会话恢复。
4. 将 Pi 工具调用接到 capability broker 和 `workspace-files`。
5. 实现项目可信任、模型配置、skills、extensions、MCP、subagents、Git、Shell、diff 和待办面板。

**完成标准：** 桌面端在不绕过 Host 权限边界的前提下，完成一次 Pi Agent 本地开发任务。

## 阶段三：账号、设备与远控

1. 实现 OIDC/Passkey、设备登记、密钥和撤销。
2. 实现二维码配对、工作区 ACL 与远控范围授权。
3. 实现 WebSocket 中继、控制请求验签、过期和重放拒绝。
4. 实现手机端会话浏览、prompt、停止、事件流和审批策略 UI。
5. 实现加密同步、附件对象存储、离线 outbox 和无敏感推送唤醒。

**完成标准：** 已配对手机可控制在线桌面 Pi 会话，但无法本地或绕过策略执行系统操作。

## 阶段四：扩展

1. 实现 DeepSeek API 对话插件及本地 Keychain/Keystore 配置。
2. 完善 Git、Shell、索引和 MCP 工作插件。
3. 定义 `AgentProvider`，让经授权的模型使用工作区工具。
4. 建立签名插件目录、版本治理、权限升级审查和兼容策略。

**完成标准：** 新插件可在不破坏 Host 权限模型的前提下为工作台贡献 UI、命令、数据或 Agent 能力。

## 每阶段验证

- 桌面：启动真实 Tauri 应用，执行对应用户路径。
- Rust：领域、存储、权限、签名和协议兼容性测试。
- Runner：流式、取消、崩溃、协议版本和工具结果测试。
- 移动：真机验证会话浏览、远控、后台/前台切换和推送唤醒。
- 安全：拒绝路径、过期请求、重放请求、撤销设备、越权插件和未批准操作。
