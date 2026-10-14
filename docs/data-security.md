# 数据、安全与审计

## 数据存储

本地 SQLite 保存结构化工作区状态；附件保存在本地缓存与对象存储中，数据库只记录哈希、对象引用、密钥版本、大小和缓存路径。

```text
本地 SQLite
  -> 加密并写入 sync_outbox
  -> Sync API 追加加密事件
  -> 对象存储保存加密附件
  -> 其他设备下载、验签、应用
```

本地表：

```text
workspaces
projects
sessions
messages
agent_runs
tool_calls
approval_requests
artifacts
plugin_installs
plugin_settings
sync_outbox
sync_cursor
audit_events
```

控制平面 PostgreSQL 保存账号、设备、设备密钥、工作区成员、密钥版本、插件目录、控制请求索引、同步事件索引、对象引用、推送 token 和审计索引。默认不保存明文代码、prompt、Agent 输出、附件或工具参数。

## 加密边界

| 数据 | 存放位置 |
|---|---|
| 设备私钥 | 仅当前设备 Keychain/Keystore |
| provider API key | 仅配置它的本地设备 Keychain/Keystore |
| 工作区内容 | 工作区对称密钥加密 |
| 工作区密钥 | 按成员设备公钥加密封装 |
| 同步与控制载荷 | 端到端加密；服务端仅路由或保存密文 |
| 推送内容 | 无敏感信息的唤醒通知 |

成员或设备撤销时必须轮换工作区密钥版本；撤销后的设备不可解密新事件。

## 同步事件

```ts
type SyncEvent = {
  id: string;
  workspaceId: string;
  deviceId: string;
  sequence: number;
  type:
    | "session.created"
    | "message.appended"
    | "task.updated"
    | "artifact.created"
    | "plugin.configured"
    | "approval.recorded";
  keyVersion: number;
  ciphertext: Uint8Array;
  createdAt: string;
};
```

同步事件可重放；控制请求不可重放。客户端必须维护幂等 ID、游标、事件签名和冲突处理规则。

## 高风险操作策略

| 能力 | 默认 | 手机可发起 | 手机默认可批准 |
|---|---|---:|---:|
| 搜索、读取、Git status/diff | 自动允许 | 是 | 不需要 |
| 创建、修改文件 | 要求审批 | 是 | 否 |
| Shell 命令 | 要求审批 | 是 | 否 |
| 删除文件/目录 | 要求审批 | 是 | 否 |
| `git commit` | 要求审批 | 是 | 否 |
| `git push` | 要求审批 | 是 | 否 |
| 网络请求 | 要求审批 | 是 | 按域名策略 |
| 系统凭据、SSH 私钥 | 永不暴露 | 否 | 否 |

批准必须绑定工作区、插件、工具、规范化参数摘要、来源设备、发起人、有效期和单次使用令牌。策略允许发起不等于允许自动执行。

## 审计

```ts
type AuditEvent = {
  id: string;
  workspaceId: string;
  actorAccountId: string;
  actorDeviceId: string;
  targetDeviceId?: string;
  sessionId?: string;
  pluginId?: string;
  action: string;
  parameterDigest?: string;
  decision?: "allowed" | "denied" | "cancelled" | "failed";
  createdAt: string;
};
```

审计至少覆盖：任务发起者和目标桌面；Agent 工具与参数摘要；批准人、批准设备与结果；Git commit hash 与 push 目标摘要；文件写入/删除路径摘要；Runner 崩溃、插件错误、同步失败与权限拒绝。日志默认不上传未脱敏 prompt、代码或凭据。
