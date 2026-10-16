# 实施路线

## 依赖顺序

先实现可信本地 Host 和单设备完整闭环，再增加 Pi、账号、远控和同步。不要让服务端或移动端抢在本地权限边界之前决定执行行为。

## 当前落地状态

- 已有：Tauri/React/Rust workspace、SQLite 迁移、工作区选择与文件浏览、插件清单与启停、设备本地全局快捷键、Rust capability broker 和本地审计。
- 已有：固定 Percho submodule、可打包 Node runtime、Host↔Runner 协议、模型目录与系统凭据、会话创建/列出/恢复、流式事件、取消、工作区/Git/Shell 工具审批、Skills 和显式连接的 stdio/HTTP MCP。
- 已补齐：通用 `workspace-files` 创建、写入、删除和 unified diff；工作台文件页与 Agent 文件预览共用编辑器。仅允许工作区内 1 MiB 以内的 UTF-8 普通文件，写入先预览再单次审批，120 秒过期；执行时重新校验权限和原内容，并记录参数摘要及审批/执行审计。真实 Tauri 已验证创建、拒绝、批准写入和删除；Rust 回归覆盖冲突、过期、重放、插件撤销及跨工作区拒绝。
- 已补齐：Agent 项目展开与所属会话导航、本机智能体模板、CodeMirror 代码编辑器，以及受审批控制的 Git 暂存、提交、分支、远端、比较、Stash、重置和冲突处理。Git 回归覆盖本地远端发布/fetch/pull、分支检出、Stash 引用变化、合并冲突和审批拒绝/过期/重放/撤销/跨工作区绑定；真实桌面已验证 diff、暂存、拒绝和撤销暂存。
- 尚未达到阶段二完成标准：项目可信任、Pi extensions、subagents、完整 diff/待办体验，以及一次使用真实 provider 的端到端本地开发任务仍待验证。
- 待实现：当前 Agent 页面及整体布局向官方 WorkBuddy 的体验与布局方向调整，按 [桌面端页面布局](desktop-layout.md) 与 [UI 规范](UI_SPEC.md) 核对官方参考并验收。保留 Tauri/React/Rust Host 与 Pi Runner；本次文档更新不代表页面改造或多智能体能力已完成。
- 已实现自托管账号与远控链路：PostgreSQL 持久化、OIDC Authorization Code + PKCE、系统凭据库设备密钥、一次性配对、桌面项目/操作授权、加密会话快照和独立 WebSocket 控制中继。真实 Windows Tauri 与协议手机端已验证登录、配对确认、快照解密、控制到达 Host、越权/重放/过期/高风险审批拒绝、撤销及退出。尚未配置 Provider/API Key，未验证真实模型回复；不代表阶段三全部完成。
- 已接入移动端“工作台 / Agent / 我的”中的账号、设备、公钥确认、同步状态与远程会话界面，并保留独立 iOS 构建配置。浏览器仅验证移动布局；iOS Keychain、URI 回调、编译、签名、后台恢复及真机完整远控仍须在 macOS/Xcode 验证。Passkey、附件对象存储、推送唤醒、DeepSeek 与签名第三方插件仍未实现。

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
6. 按官方 WorkBuddy 参考调整 Agent 页面及整体布局，核对导航、会话、输入区和工具/产物详情；在真实桌面验证会话状态、后台执行、取消、审批与工作区隔离不退化。未核实的官方细节不预设为既定规范。

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
