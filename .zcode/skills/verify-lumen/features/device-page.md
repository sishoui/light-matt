# 设备页

设备页是「这台设备」的落地页：设备名与状态收进副标题，一个总开关，一条全局亮度滑条，
下面是**单列**的灯组卡片（封面 + 名称 + 开关），再下面是一行设备摘要入口。右上角三点菜单
（设备信息 / 断开）。**这里没有任何灯效编辑控件**——全部在灯组页。

## Sub-features

- **DEV-1 副标题与状态** —— 没有整条状态栏；连接状态、设备名收进导航副标题。
- **DEV-2 总开关** —— 一个电源按钮，控制整机亮灭。
- **DEV-3 全局亮度** —— 一条滑条，下发 `brightness`（0–max，固件上限 200）。
- **DEV-4 灯组卡片（单列）** —— 每张卡有封面、名称、开关；点卡进灯组页。
- **DEV-5 长按卡片** —— 改名 / 换封面 / 清除封面。
- **DEV-6 三点菜单** —— 设备信息、断开连接。

## How to get to it (user POV)

首页 → 点大卡。**连接发生在这一页**（首页点小图只管切换，不连接）。

## Driving it with miniprogram-automator

`Preconditions:` 有演示设备「书桌」（`A4:CF:12:9B:3E:01`，2 条灯组）；`doctor.mjs` 全绿。

- **打开设备页并连上** → `mp.navigateTo("/pages/device/device?key=A4%3ACF%3A12%3A9B%3E%3A01")`
  → 等 ~2s；可观察结果：`route === "pages/device/device"`，`data.ready === true`。
- **没有整条状态栏** → `p.$$(".statusbar")` 长度 === 0。
- **灯组卡片单列且有封面** → `p.$$(".strip-list")` 长度 === 1，
  `p.$$(".strip-cover")` 长度 ≥ 1；`data.stripCards` 里每项是
  `{ stripId, label, photo, photoIsCustom, ledCount, summary }`。
- **总开关** → 读 `p.session` State 的 `power` → `p.onTogglePower()` → 再读；
  可观察结果：`power` 翻转且 `data.power` 与之一致。
- **进灯组页** → `p.onStripCardTap({ currentTarget: { dataset: { stripId } } })`；
  可观察结果：路由变成 `pages/strip/strip` 且 `data.stripId` 等于传入值。
- **长按卡片** → `p.onStripCardLongPress({ currentTarget: { dataset: { stripId } } })`；
  可观察结果：`data.stripMenuOpen === true`，DOM 里出现改名 / 换封面菜单项。

## Gotchas

- **不连接就没有灯组数据。** 直接深链进设备页会走 `ensureConnected`；如果设备不在（演示
  模式被关掉），`data.ready` 会一直 false，`stripCards` 为空。此时是**前置条件不满足**，
  不是界面坏了——报告时要写清这一点。
- **灯组卡片是单列**（`.strip-list` 一个容器）。旧的「两列」断言已作废。
- **设备页没有灯效编辑控件**（#60 之后全部搬到灯组页）。在这里找效果卡片的断言是错的。
- 灯组号的 `dataset` 键是 **`stripId`**，不是 `strip`。灯组页 URL 的参数才叫 `strip`。
- 总开关与逐组开关是两份状态：`data.power` 是整机，`stripCards[].on` 是逐组
  `strip_power_mask`。断言时别混。
- 相关单测：`tests/device-list.test.ts`、`tests/strip-meta.test.ts`（名字与占位图）。
