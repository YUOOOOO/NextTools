# NextTools 文档

NextTools 是一个基于 Tauri 2 的 local-first、多端同步、插件化 Agent 工作台。

## 架构文档

- [总体架构](architecture.md)：产品边界、部署拓扑、技术选型与仓库结构。
- [桌面端页面布局](desktop-layout.md)：当前 Agent 页面与整体布局以官方 WorkBuddy 的体验方向为目标，定义工作台/Agent 切换及宿主边界。
- [桌面端全局快捷键](desktop-shortcuts.md)：插件多命令、无页面插件、桌面注册与冲突策略。
- [插件系统](plugin-system.md)：插件分类、manifest、能力授权与 Agent 工具协议。
- [Pi Agent / Percho 集成](pi-agent.md)：以桌面 Node sidecar 复用 Percho/Pi 的运行模型，并将 WorkBuddy 作为 Agent UI 的产品参考方向。
- [账号、设备与远程控制](account-remote-control.md)：账号关联、配对、实时控制和移动端边界。
  - 同页包含自托管服务启动、账号与配对、加密同步/控制、回归命令，以及移动预览和 iOS 真机验证边界。
- [数据、安全与审计](data-security.md)：同步、密钥、数据存储、审批和审计要求。
- [实施路线](roadmap.md)：按依赖顺序的交付阶段。

## 已确定的架构决策

1. **Tauri 2 是唯一客户端宿主。** 同一客户端面向 Windows、macOS、Linux、iOS 和 Android；不并行维护 Electron 主客户端。
2. **Pi/Percho 是桌面端插件。** `pi-agent` 通过 Node sidecar 运行，不能在手机本机运行。
3. **手机端控制桌面端。** 手机通过账号、设备配对和实时中继观察、发起、继续、停止及按策略审批桌面 Agent 任务。
4. **Agent 通过工具协议调用本地工作插件。** 文件、Git、Shell、MCP 和索引能力必须经过 Rust Host 的 capability broker。
5. **账号服务不执行本地任务。** 它只处理身份、设备、授权、同步、中继和推送；执行始终发生在已授权的桌面 Host。
6. **DeepSeek 是独立 API 插件。** 不抓取或嵌入 DeepSeek 网站作为 Agent 运行时。
7. **Agent 页面与整体布局向官方 WorkBuddy 对齐。** 这是产品体验与信息架构目标，不表示当前实现已经与官方产品完全一致；官方公开资料、截图和可实测行为优先于第三方实现或旧版内部约定。
8. **WorkBuddy 只约束产品体验方向，不改变宿主技术边界。** NextTools 继续使用 Tauri/React/Rust Host、Manifest 驱动插件和受控 Pi Runner；文件、Git、Shell、MCP、凭据及审批仍由 Host capability broker 管理。
9. **Percho 上游以固定提交持续跟进。** 通过 Git submodule 保留上游；NextTools 仅维护薄适配层，不追踪 `main` 或运行时自动升级。Percho/Ace 等项目只能作为实现机制参考，不能当作官方 WorkBuddy 的等价证明。
10. **全局快捷键由 Host 管理。** 插件每条命令均可单独分配快捷键，按当前桌面设备持久化并在下次启动时恢复；触发仍经过能力、审批和审计。

## 术语

- **Host**：Tauri/Rust 宿主，唯一的本地系统能力入口。
- **工作区**：项目、会话、插件配置、同步状态和授权策略的隔离单元。
- **插件**：向 Host 声明 UI、命令、工具或 Agent runtime 的签名扩展包。
- **Runner**：插件的受控执行进程。Pi Runner 特指承载 Percho backend/Pi SDK 的 Node sidecar。
- **能力（capability）**：工作区范围内可授权的原子操作，例如 `workspace.read`、`git.push`。
- **控制通道**：手机到在线桌面 Host 的实时、不可离线重放命令流。
- **同步通道**：可离线排队的持久化工作区状态复制通道。
