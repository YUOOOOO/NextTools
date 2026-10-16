# NextTools Agent 协作说明

## 项目定位

NextTools 是基于 Tauri 2 的跨平台、local-first、插件化 Agent 工作台。桌面端运行本地开发 Agent；iOS/Android 运行共享 UI/API 插件并远程控制已配对桌面端。

详细架构以 [`docs/README.md`](docs/README.md) 为入口；修改实现前必须阅读受影响主题文档。

## 不可违反的边界

- Tauri 2 是唯一客户端宿主；不得新建 Electron 主客户端。
- Rust Host 是本地文件、Git、Shell、MCP、数据库、系统凭据和 sidecar 管理的唯一门面。
- 前端、插件、Node Runner 与手机端不得绕过 capability broker。
- Node Pi Runner 仅在 Windows/macOS/Linux 运行；iOS/Android 仅远程控制，不启动 Node、Pi、Shell、Git 或 MCP server。
- Agent 仅通过结构化 `tool.invoke` 调用工作插件；必须经过授权、审批和审计。
- 控制通道与同步通道必须分离。控制请求不可离线重放，必须短时有效、签名并按目标桌面授权。
- provider API key、SSH key 与设备私钥只能留在当前设备 Keychain/Keystore，绝不写入同步数据、日志或服务端。
- 服务端不执行 Agent、Shell、Git 或插件业务逻辑。
- 不下载或执行未签名 native/Rust/Node 插件。
- 桌面端 Agent 页面保留 Percho 会话布局骨架；Agent 侧栏内可提供资源管理器、Chat、Git 工具切换，不得增加跨模式全局竖栏、额外顶栏、常驻检查器或独立仪表盘。详见 `docs/desktop-layout.md` 的布局决策调整。
- `工作台 / Agent` 模式切换固定在 Percho 右上角新建会话操作旁。Agent 模式显示原新建会话操作；工作台模式由当前插件贡献该位置的主操作。
- 模式切换必须保留会话和运行中的 Agent；工作台与 Agent 的页面状态分别在当前设备恢复。
- 设置按钮属于宿主共用框架，在工作台与 Agent 模式始终可见；两边打开同一个设置弹窗并使用同一配置来源。插件主操作隐藏不影响设置入口，打开/关闭设置不得切换模式、重置页面状态或停止 Agent。
- 工作台首版只将 Percho 的会话主内容容器替换为 `WorkbenchHome`；有页面插件在该容器运行，无页面插件不得占用该容器或创建新的全局布局。
- 工作区选择与列表只放在 Agent Chat 侧栏，界面标题为`项目`；标题右侧加号打开目录授权，各项目展开所属会话。工作台侧栏只提供首页和插件导航，工作插件复用已授权的当前工作区，不维护第二套工作区选择。
- Git 入口及其按需侧栏面板只属于 Agent 工具区；工作台不得显示或打开该入口，Git 操作仍只可经 Rust Host 校验、审批和审计。
- 全局快捷键只在 Windows/macOS/Linux 由 Rust Host 注册。沿用 `contributes.commands` 与 `contributes.views`，每条命令都可单独绑定；插件不得自行注册、监听、覆盖全局快捷键或绕过 command dispatcher、capability broker、审批和审计。

## 工程约定

- 领域模型、协议和权限判断优先放在 Rust；React 仅负责展示和意图提交。
- Host↔Runner 使用版本化 stdin/stdout JSON-RPC；不得引入 Electron IPC 或本地监听 HTTP 服务。
- 插件 API 以 `packages/protocol` 和 `packages/plugin-sdk` 的单一 schema 为准，不能在插件内复制协议类型。
- 新能力须同时定义：manifest 声明、Host 强制校验、工作区策略、审批表现和审计事件。
- 新的跨端插件须明确 `native`、`remote-controller` 或 `unavailable` 的移动端模式。
- 复用 Percho 实质源码时保留版权声明和 MIT 许可；详见 `docs/pi-agent.md`。
- Percho 上游通过 `vendor/percho` Git submodule 固定到已验证 commit；NextTools 只维护 `plugins/pi-agent/runner` 薄适配层。不得追踪上游 `main`、运行时自动升级或改动 vendored 源码来承载 NextTools 功能。
- 升级 Percho 时必须审阅 `backend`、`shared` 与 Pi SDK 的变化，并验证创建/恢复会话、流式、取消、工具、审批、扩展和打包；Electron shell/preload/IPC 不能迁入 Tauri 客户端。
- 快捷键绑定按设备持久化且不参与同步。一个规范化快捷键只能绑定一个命令；冲突或操作系统占用必须显式失败，绝不静默替换、覆盖或降级。

## 修改要求

1. 先检查受影响架构文档和现有模式。
2. 修改导出 API 前查找全部调用方；完成后不保留废弃兼容层，除非迁移计划明确要求。
3. 安全敏感变更必须验证允许与拒绝路径，包括超时、取消、撤销或重放场景。
4. Agent/插件变更必须验证实际用户路径：创建会话、流式事件、工具审批、执行/拒绝与审计。
5. 文档中的设计约束与实现冲突时，先更新架构决策记录，再实现；不得静默改变安全边界。

## 当前状态

仓库已初始化 Tauri 2、React/TypeScript、Rust workspace、SQLite、带审批的工作区文件插件、桌面快捷键和桌面 Pi Runner，并提供项目会话导航、本机智能体模板、代码编辑器和受控 Git 管理。Runner 复用固定的 Percho/Pi 依赖，通过 stdin/stdout JSON-RPC 接入 Rust Host；移动端仅保留远程控制边界。真实 Provider 开发任务仍待配置凭据后验证。
