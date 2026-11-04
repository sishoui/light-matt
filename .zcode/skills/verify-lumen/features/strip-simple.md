# 灯组简单档

灯组详情页的「简单」档是日常使用的主路径：顶部标题右侧一个**灯珠数胶囊**（长按弹 1–100
圆盘），下面固定三套圆形方案，然后是一行式灯效选择（点开滚轮），最下面是色相 / 饱和度 /
亮度三个滑块。**没有「应用并播放」按钮——改动立即生效。**

## Sub-features

- **SIMPLE-1 灯珠数胶囊与圆盘** —— 标题右侧胶囊显示当前颗数；长按弹圆盘（1–100），
  **松手才下发**。页面上没有独立的灯珠数滑块区块。
- **SIMPLE-2 三套固定方案** —— 恰好三个圆形数字按钮，没有新增 / 删除入口。
- **SIMPLE-3 一行式灯效** —— 一个「灯效」行，点开滚轮，**八个**灯效：空 / 常亮 / 呼吸 /
  彩虹 / 流星 / 爆闪 / 心跳 / 随机闪烁（名字不带颜色）。选中立刻生效。
- **SIMPLE-4 三个滑块** —— 色相 / 饱和度 / 亮度，原生滑块，激活色跟随主题。
- **SIMPLE-5 立即生效** —— 任何改动直接下发，写失败在面板里就地说明。

## How to get to it (user POV)

首页 → 点大卡进设备页 → 点灯组卡片 → 灯组页默认就是「简单」档。

## Driving it with miniprogram-automator

`Preconditions:` 已连上一台有灯组的演示设备；`doctor.mjs` 全绿。灯组页 URL 形如
`/pages/strip/strip?strip=0`。

- **灯珠胶囊存在且没有独立滑块** → 进页后
  `mp.currentPage().then(p => p.$$(".led-capsule"))` 恰 1 个，
  `p.$$(".led-count-slider")` 为 0；`data.ledText` 是当前颗数文案。
- **长按胶囊弹圆盘** → `p.onLedCapsuleLongPress()`；可观察结果：`data.dialOpen === true`，
  `data.dialTicks.length === 100`（刻度 1–100）。
- **恰好三个方案圆** → `p.$$(".plan-circle")` 长度 === 3；`p.$$(".plan-action")` 长度 === 0。
- **点灯效行弹滚轮、选中立刻生效** → `p.onEffectRowTap()`（`data.effectWheelOpen === true`，
  `data.effectOptions.length === 8`）→ `p.onEffectPick({ currentTarget: { dataset: { id: "heartbeat" } } })`
  → 等 ~3.2s 读 `p.segmentReports[0].layer0.type`；可观察结果：类型是 `0x05`（心跳），
  即**设备真的收到了**，不是只改了 `data.effectId`。
- **没有「应用并播放」** → `outerWxml()` 去掉注释后不含「应用并播放」。
- **一行式而非色块网格** → `p.$$(".quick-card")` 为 0，`p.$$(".effect-row")` 为 1。

## Gotchas

- **选中灯效后要等设备 ACK。** 立即读 `segmentReports` 可能还是旧值；给 3s 以上，
  并按协议语义断言 `layer0.type`，不要只看 `data.effectId`（那是本地态）。
- 灯效写入会改设备实时状态，**跑完把灯效复位**（例如切回 `solid`），否则用户打开设备会
  发现灯效被改了。
- 灯珠数圆盘松手才下发；直接 `setData({ dialValue })` 不会写设备。
- `quickHint` 是面板里的一次性反馈文案，读它证明「界面说了什么」，不证明「设备收到了什么」。
  两者要分开断言。
- 灯珠数上限 100（不是 64），超出由固件拒绝；圆盘刻度固定 100 条，不要断言成「当前上限」。
- 相关单测：`tests/strip-head.test.ts`（胶囊 / 三套方案 / 圆盘）、
  `tests/simple-effects.test.ts`（八个灯效、立即生效顺序）、`tests/quick-selection.test.ts`。
