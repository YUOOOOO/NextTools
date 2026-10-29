# NextTools

基于 **PI-Desktop** 二次开发的本地优先个人工作台，计划使用 **OpenMinis** 作为手机端基础。

[English](README.md) · [开发总纲](docs/project/pi-workbench.md) · [阶段规格](docs/project/pi-workbench/phases.md) · [验收清单](docs/project/pi-workbench/acceptance.md)

## 项目状态

当前仓库包含 PI-Desktop 桌面端基线，个人工作台总纲和阶段方案已整理。Activity Bar、个人 Agent、新增内置模块、加密中继和手机适配仍属于后续开发内容，不代表已经上线。

应用名称、包标识和构建元数据目前仍沿用 PI-Desktop。NextTools 是仓库名称，PI Workbench 是设计文档中的暂定产品名；品牌与发布配置将作为独立任务处理。

当前发布线为 0.1.x。

## 参考项目

| 项目 | 在 NextTools 中的作用 | 源码 |
|---|---|---|
| PI-Desktop | 桌面二开基础：Electron/React 界面、项目会话、Agent 运行时、Host Core、插件、工具及权限 | [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) |
| OpenMinis | 计划中的本地优先手机端基础；保留原生本地 Agent、对话、记忆、工具与权限，适配共同的个人 Agent 数据 | [OpenMinis/OpenMinis](https://github.com/OpenMinis/OpenMinis) |

**OpenMinis 尚未导入。** 当前仅预留 [`apps/mobile/`](apps/mobile/README.md)；源码导入、许可证审查、原生构建和详细适配留待对应阶段。后续固定经审查的 commit，一次性导入、独立开发、按需更新，不自动合并上游。

个人 Agent 的记忆设计另参考 [MyAgents/Mino](https://github.com/hAcKlyc/MyAgents/tree/db56b48be4bdaf025a549a6669c1adf41fc1e943/bundled-workspaces/mino) 的身份、人格、用户上下文，以及每日记录、主题记忆、核心记忆分层。这里只借鉴设计，不引入第三套运行时，也不沿用其 Git 同步机制。

## 现有桌面基础

沿用 PI 的项目与会话、模型配置、Agent 流式执行、本地工具和权限审批、会话持久化、插件、右侧工作面板、定时任务及通知能力。具体行为以当前代码和 [PI 规格文档](docs/spec/README.md) 为准。

现有职责边界保持不变：Renderer 处理交互，Electron Main 负责编排，Rust Host Core 管理持久化和受控宿主能力，Agent Runtime 管理模型执行。

## 开发方向

- **桌面导航：**最左侧增加固定图标栏，顺序为 Agent、工作台、定时任务、扩展；底部为通知、设置。默认打开 Agent，保留原项目会话工作区。
- **插件优先：**优先复用现有插件机制，第一方功能随包内置、不可卸载；内置身份不扩大权限。不做工作台内嵌 Agent 助手。
- **个人 Agent：**独立于项目 Agent，具有可审阅的人格、会话、用户上下文、分层记忆、版本历史和逐步演进的记忆能力。
- **本地优先手机端：**基于 OpenMinis 适配相同的个人 Agent 记录契约，保留手机本地执行和原生数据所有权。
- **在线项目远控：**手机控制在线且已认证的电脑会话；电脑离线时不排队、不自动补发执行任务。
- **加密端侧同步：**双方在线时交换个人 Agent 数据；中继不可解密，不保存消息、密文历史、记忆或快照。并发冲突及离线会话分支显式处理。
- **业务工具：**先做 Tushare，再扩展 Quant、News；手动界面与可选 Agent Tool 复用同一业务服务。

参见[联合架构](docs/project/pi-workbench/architecture.md)及[已确认决策与待决策项](docs/project/pi-workbench/decisions.md)。互联协议与手机端仍需专项设计后再实施。

## 目录结构

```text
apps/
  desktop/                 现有 PI-Desktop Electron 应用
  mobile/                  预留 OpenMinis 手机端，目前仅 README
packages/                  现有 Agent、运行时、插件与共享契约
crates/host-core/          Rust 持久化、权限及宿主服务
docs/project/pi-workbench.md
                           开发总纲
docs/project/pi-workbench/
  architecture.md          数据所有权、记忆模型与互联草案
  phases.md                阶段范围、依赖与退出条件
  acceptance.md            待验证的验收门槛
  decisions.md             已确认约束和待决策项
```

目录预留不引入手机构建、中继应用或第二套插件引擎。

## 桌面端开发

需要 Node.js `>=22.19.0`、[`package.json`](package.json) 中 `packageManager` 固定的 pnpm、稳定版 Rust，以及对应平台的原生编译环境。开发流程和验证规则见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。

首次建立开发环境：

```powershell
pnpm install
cargo build -p host-core
pnpm build:js
pnpm dev
```

独立 worktree 应复用现有依赖与缓存，不为单次验证重复安装运行环境。手机端尚未导入，因此当前不提供手机构建命令。

按变更范围选择相关检查：

```powershell
pnpm docs:check
pnpm check:agent-policy
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
```

以上是命令说明，不代表每个候选版本均已执行通过。各阶段实际验收证据记录在[验收清单](docs/project/pi-workbench/acceptance.md)中。

## 文档入口

- [开发总纲](docs/project/pi-workbench.md)
- [阶段规格](docs/project/pi-workbench/phases.md)
- [验收清单](docs/project/pi-workbench/acceptance.md)
- [联合架构草案](docs/project/pi-workbench/architecture.md)
- [决策与源码参考](docs/project/pi-workbench/decisions.md)
- [手机端预留与导入规则](apps/mobile/README.md)
- [现有插件开发指南](docs/plugin-development.md)
- [现有桌面用户指南](docs/guide/index.md)

## 许可证与归属

当前继承的桌面源码遵循仓库 [LICENSE](LICENSE)（LGPL v3），保留适用的上游声明和各文件条款。列为参考项目不改变其源码许可证。

OpenMinis 使用 GPL v3，导入手机源码或组合分发前需要核对兼容性、声明、源码提供和打包义务。MyAgents 仓库使用 AGPL v3；Mino 模板的声明不能用于许可其他实现文件。本次路线图和 README 修改不导入外部实现代码。

PI-Desktop 和 OpenMinis 都是独立的上游项目，其发布包、徽章及社区入口不代表 NextTools 的发布或支持渠道。
