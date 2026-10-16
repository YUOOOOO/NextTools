# UI 规范

## 三层架构

```
第一层：宿主 Shell UI（框架级，插件不可修改）
第二层：插件 Slot 区域（iframe 沙箱）
第三层：插件内嵌 UI（插件自管理，但必须用 Design Token）
```

## Design Tokens（插件必须使用）

```css
:root {
  --host-bg-primary: #1e1e1e;
  --host-bg-secondary: #252526;
  --host-bg-tertiary: #2d2d30;
  --host-text-primary: #cccccc;
  --host-text-secondary: #858585;
  --host-accent: #007acc;
  --host-success: #4ec9b0;
  --host-warning: #dcdcaa;
  --host-error: #f44747;
  --host-border: #3c3c3c;

  --host-radius-sm: 4px;
  --host-radius-md: 6px;
  --host-radius-lg: 8px;

  --host-spacing-xs: 4px;
  --host-spacing-sm: 8px;
  --host-spacing-md: 16px;
  --host-spacing-lg: 24px;

  --host-font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif;
  --host-font-mono: "Cascadia Code", "SF Mono", monospace;
}
```

## 桌面布局

当前 Agent 页面及桌面整体布局向**官方 WorkBuddy** 的体验与布局方向实现；详细边界见 [桌面端页面布局](desktop-layout.md)。此目标替代旧版固定活动栏、插件列表、常驻右侧面板及状态栏的示意，不将旧图中的尺寸视为新页面约束。

- 对齐范围包括侧栏层级、项目与会话导航、主内容区、输入区、工具执行与产物的呈现方式，以及字号、间距和操作密度。
- 官方资料、截图或实测是布局细节的核对依据；实现前记录所参考版本与对应页面状态，不将未核实细节当作官方规范。
- Ace 自称 Open WorkBuddy 不构成官方实现或功能一致性证明；Percho/Pi 继续作为运行时来源，不决定最终 UI。
- 使用 NextTools 自身品牌与 Design Tokens，不引入第三方运行时以模拟外观。
- 会话切换、后台运行、取消、审批和工作区隔离不得因布局调整退化；改造后须在真实桌面逐项验证，并区分已实现与待实现能力。

## 移动布局（< 600px）

```
┌─────────────────────┐
│ 顶部栏               │
├─────────────────────┤
│                     │
│   主内容区           │
│                     │
├─────────────────────┤
│ 底部 Tab Bar        │
└─────────────────────┘
```

## 可用 Slot

| Slot | 位置 |
|:---|:---|
| `sidebar.left` | 活动栏 |
| `sidebar.panel` | 插件列表下方 |
| `main` | 主内容区 |
| `settings` | 设置页 |
| `statusbar.left` | 状态栏左侧 |
| `statusbar.right` | 状态栏右侧 |
| `floating.bottom-right` | 右下角悬浮 |
| `titlebar.actions` | 标题栏右侧 |

## 响应式断点

| 断点 | 布局 |
|:---|:---|
| ≥ 1200px | 展示经官方参考核对后的桌面导航与主内容区；辅助详情按需打开，不强制固定三栏 |
| 800-1199px | 收缩导航与辅助详情，保留当前会话和输入操作 |
| 600-799px | 单栏 + 抽屉 |
| < 600px | Tab + 抽屉 |

## iframe 通信

```typescript
// 宿主 → 插件
iframe.contentWindow.postMessage({
  type: 'host:init',
  payload: { theme, locale, permissions, state }
}, '*');

// 插件 → 宿主
window.parent.postMessage({
  type: 'plugin:resize',
  payload: { height: 400 }
}, '*');
```

## 主题切换

宿主在 iframe 的 `<html>` 上设置 `data-theme="dark"` 或 `data-theme="light"`。
