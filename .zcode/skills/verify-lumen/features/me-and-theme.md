# 我的与主题

tab 2「我的」放三件与设备无关的东西：本机头像昵称、外观（浅色 / 深色 / 跟随系统）、
演示设备开关，以及「我的设备」列表（可删除）。另一件事是隐藏的协议日志面板——连点版本号
5 次打开。

## Sub-features

- **ME-1 主题切换** —— 主色雾蓝（浅 `#6B8CAE` / 深 `#8FA9C4`）；页面 / 导航栏 / tabBar
  **三处同时**换色，原生滑块激活色也跟着换。
- **ME-2 演示模式开关** —— 显式开关写 `lumen.mockMode.v1`；关掉会把演示设备清掉。
- **ME-3 我的设备** —— 列出最近设备，每行有「删除」；删除是**一组动作**（断开 + 清六处
  存储 + 记演示删除标记）。
- **ME-4 资料** —— 头像与昵称；昵称只在失焦 / 确认时落盘。
- **ME-5 日志面板** —— 连点版本号 5 次打开，展示 200 帧环形缓冲的 cmd / seq / len / result。

## How to get to it (user POV)

底部 tab 2「我的」。删除设备在「我的设备」每行右侧的「删除」。

## Driving it with miniprogram-automator

`Preconditions:` `doctor.mjs` 全绿；有 3 台演示设备。脚本场景：`--scenario delete-device`。

- **切深色后三处同步** → `mp.switchTab("/pages/me/me")` →
  `p.onThemeTap({ currentTarget: { dataset: { value: "dark" } } })` → 依次读
  `p.data.themeClass`、`p.getTabBar().data.themeClass`、再切回首页读 `data.themeClass`；
  可观察结果：三处都是 `"theme-dark"`，首页 `data.accentColor` 是 `#8FA9C4`，
  导航栏 WXML 含 `nav-root use-dark`。
- **删除设备真的清干净** → `mp.switchTab("/pages/me/me")` → 从 `data.myDevices` 挑一台
  非 `current` 的，取 `key` → 调 `p.onDeleteDevice({ currentTarget: { dataset: { key } } })`
  （确认框用临时替换的 `wx.showModal` 自动确认）→ 可观察结果：`data.myDevices` 里没有它、
  `lumen.recentDevices.v2` 里没有它、`lumen.mockDeleted.v1` 里有它。见
  `drive.mjs --scenario delete-device`。
- **日志面板默认隐藏、连点打开** → 读 `p.data.logVisible`（应为 `false`）→
  连点版本号 5 次（`p.onVersionTap()` × 5）→ 可观察结果：`logVisible === true` 且 DOM
  里出现日志面板节点。

## Gotchas

- **存储里的设备列表是 JSON 字符串**，不是数组。`loadRecentDevices` 自己 `JSON.parse`。
  直接 `wx.getStorageSync(k).length` 数到的是**字符数**（本机实测 446），会得到
  「有 446 台设备」这种荒谬结论。要么先 parse，要么数渲染出的 `data.myDevices`。
- **删除前有 `wx.showModal` 确认框**，不处理的话 `onDeleteDevice` 会一直挂着不返回。
  驱动的做法是临时替换 `wx.showModal` 让它立刻回调，并在 `finally` 里还原。
- **删除是破坏性的**：会断开连接、清设备草稿（`lumen.planDrafts.v1`）与灯组元数据
  （`lumen.stripMeta.v1`）。驱动前备份这些键，跑完还原；否则下一次运行的基线变了。
- **主题 class 必须挂在页面根节点上**。手动覆盖由 `.page.theme-light|theme-dark` 决定
  （`utils/control/theme.ts`，存储 `lumen.theme.v1`）。页面 wxss 写死 hex 会在某个主题下
  变白底白字——这类问题 `records` 查不出，要人眼看。
- `data.myDevices` 每行是 `{ key, deviceId, hardwareId, label, whenText, current }`；
  `dataset` 键是 **`key`**，不是 `deviceId`。用错会静默 `return`（方法第一行就找不到 row），
  表现为「调了没反应」。
