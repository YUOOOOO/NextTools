# 插件系统

## 设计原则

1. 插件必须先声明能力，Host 决定是否授予。
2. Agent 调用插件工具与用户调用同样经过权限、审批和审计。
3. 插件不能直接获得 Tauri Shell、文件系统、数据库或凭据。
4. 移动端复用插件协议和 UI，但不承诺本地执行桌面进程能力。
5. 官方插件随应用签名发布；第三方 executable 插件不进入首版。

## 插件类型

| 类型 | 示例 | 桌面 | iOS/Android |
|---|---|---:|---:|
| UI/数据 | 待办、笔记、产物浏览 | 完整 | 完整 |
| API Agent | DeepSeek Chat | 完整 | 完整 |
| 工作区工具 | 文件、Git、索引 | 完整 | 只读或远控 |
| 本地 Agent runtime | Pi Agent | 完整 | 远程控制 |
| 平台集成 | IDE、通知 | 平台特化 | 官方预置 |
| MCP bridge | MCP server 和工具 | 完整 | 只读或远控 |

## Manifest

```json
{
  "id": "com.nexttools.pi-agent",
  "name": "Pi Agent",
  "version": "1.0.0",
  "kind": "agent-runtime",
  "platforms": ["windows", "macos", "linux"],
  "mobileMode": "remote-controller",
  "capabilities": ["agent.session", "workspace.read", "workspace.tool.invoke"],
  "contributes": {
    "views": ["agent-workbench", "session-inspector"],
    "commands": [
      {
        "id": "pi.newSession",
        "title": "新建会话",
        "execution": "foreground",
        "viewId": "agent-workbench",
        "requiredCapabilities": ["agent.session"]
      },
      {
        "id": "pi.continueSession",
        "title": "继续会话",
        "execution": "foreground",
        "viewId": "agent-workbench",
        "requiredCapabilities": ["agent.session"]
      }
    ],
    "remoteOperations": ["session.view", "session.prompt", "session.stop", "approval.respond"]
  },
  "runtime": { "kind": "desktop-sidecar", "entry": "runner" }
}
```

`mobileMode` 的值为 `native`、`remote-controller` 或 `unavailable`。它必须反映真实运行能力，不能以 UI 可显示为由承诺移动端本地执行。

## 命令、页面与全局快捷键

按呈现方式，插件分为有页面和无页面（headless）两类，与上面的运行能力分类正交。沿用 `contributes.views` 和 `contributes.commands`：非空 `views` 表示有页面，空或省略 `views` 表示无页面，不增加另一套 presentation 声明。有页面插件在工作台的主内容容器运行，也可贡献不打开页面的命令；无页面插件通过命令入口执行，不占用工作台容器。

```ts
type PluginCommand = {
  id: string;
  title: string;
  description?: string;
  execution: "foreground" | "background";
  viewId?: string; // 引用本插件 contributes.views；省略表示不打开页面
  requiredCapabilities: Capability[];
};
```

一个插件可贡献多个 `PluginCommand`；每个命令的全局 ID 为 `<pluginId>/<commandId>`。**每条命令都可单独分配一个全局快捷键**，无需插件另外允许。用户可将 `com.nexttools.screenshot/capture` 绑定为 `F1`，也可分别绑定同一插件的其他命令；未配置时不注册。Agent 工具不自动成为命令，须显式贡献命令入口。

插件不能直接注册、覆盖或监听全局快捷键。Rust Host 持久化设备本地绑定并在启动时恢复注册，触发经统一 command dispatcher、capability broker、审批和审计。`viewId` 存在时，`execution` 必须为 `foreground`，Host 打开或激活工作台内对应页面；无页面命令不要求聚焦主窗口。Pi Agent 的会话命令进入 Agent 模式，不将工作台改为第二套聊天 UI。全局快捷键仅面向桌面端，不同步到其他设备。

详见 [桌面端全局快捷键](desktop-shortcuts.md)。

## Capability 模型

```text
全局默认策略
  -> 工作区策略
    -> 插件策略
      -> 工具规则
        -> 单次调用与审批
```

初始能力集合：

```text
workspace.read
workspace.write
workspace.delete
shell.execute
git.read
git.commit
git.push
network.request
credential.provider.use
agent.session
workspace.tool.invoke
screen.capture
```

能力必须同时受工作区根目录、目标域名、命令规则、Git remote/branch 和来源设备限制。

截图命令须声明 `screen.capture`，由 Host 检查屏幕捕获范围、用户批准和平台系统权限；全局快捷键不是屏幕捕获授权。该能力不意味着移动端可本地执行桌面截图。

## Agent 工具协议

工作插件注册结构化工具；Host 在会话创建时向可用 Agent runtime 提供工具定义。Agent 本身不持有系统权限。

```ts
type WorkspaceTool = {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  requiredCapability:
    | "workspace.read"
    | "workspace.write"
    | "workspace.delete"
    | "shell.execute"
    | "git.commit"
    | "git.push"
    | "network.request";
  remotePolicy: "never" | "desktop-only" | "paired-device";
};
```

调用链固定为：

```text
Agent -> Agent runtime ToolDefinition -> tool.invoke -> Rust capability broker
  -> 工作插件 execute -> tool.result -> Agent
```

每个 `tool.invoke` 都需要工作区、会话、插件、工具、参数、来源设备和幂等请求 ID。Host 校验后才执行；结果必须是结构化数据并写入审计。

## 初始工作插件

| 插件 | 初始工具 |
|---|---|
| `workspace-files` | search、read、write、create、delete、diff |
| `workspace-git` | status、diff、log、branch、commit、push |
| `workspace-shell` | 在规则允许范围内执行命令 |
| `workspace-index` | 代码符号、项目结构、文档检索 |
| `mcp-bridge` | 调用已批准 MCP server 的工具 |

## 安全边界

- 插件 UI 通过 SDK 和 Host command 通信；不能直接 import 原生 API。
- 高风险工具的 UI 不能自己伪造“已批准”；批准令牌只由 Host 签发且单次使用。
- 能力升级、插件更新、插件替换都应再次征得工作区管理员同意。
- 手机端远程控制插件的操作集由 `remoteOperations` 声明，并由目标桌面本地策略二次检查。
