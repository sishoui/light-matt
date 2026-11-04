# 首页设备卡

首页（tab 1「设备」）是用户打开小程序看到的第一屏：一张 1:1 方形大卡展示当前设备的
照片、名称、亮度，顶部有电源键；下方一排小图切换设备；右上角加号进「发现」，右上还有
一个灰底搜索框。长按大卡或小图弹出五项菜单。

## Sub-features

- **HOME-1 大卡与小图** —— 点小图只切换大卡，**不发起连接**；大卡照片有则用照片、
  没有则用设备色渐变兜底（真实设备没照片时 `photo` 是空串，不拿图冒充）。
- **HOME-2 电源键** —— 卡上电源是 `catchtap` 快捷开关；未连接时先连上再切。
- **HOME-3 亮度滑条** —— 大卡亮度可拖；拖动期间不下发，停手 300ms 才发最后一帧。
- **HOME-4 搜索** —— 灰底搜索框按名称过滤卡片；清空恢复全部。
- **HOME-5 长按菜单** —— 长按弹**五项**底部菜单（连接状态不同，项不同）。
- **HOME-6 加号** —— 右上角是 `+`（不是「发现」文字），点开下拉进发现 / 设备信息 / 断开。

## How to get to it (user POV)

- 打开小程序（`app.json` 第一个页面就是 `pages/home/home`）。
- 从任意二级页返回 / 从「我的」切回 tab 1。

## Driving it with miniprogram-automator

`Preconditions:` 演示模式已开（无真机记录时默认开），且有 3 台演示设备；
`doctor.mjs` 全绿。脚本场景：`--scenario home-power`、`--scenario home-search`。

- **看大卡渲染** → `mp.evaluate(() => getCurrentPages().pop().data.current)`；
  可观察结果：`{ name, photo, powerOn, brightnessPercent, key }` 非空，`name` 是
  「书桌」（最近连接的第一台）。
- **点小图只切换不连接** → 记下 `p.session.linkState` → 调
  `p.onThumbTap({ currentTarget: { dataset: { key } } })` → 再读 `linkState`；
  可观察结果：`data.current.key` 变成新设备，而 `linkState` **没有**变成 `ready`。
- **电源键翻转** → 读 `p.session` 的 State `power` → 调
  `p.onPowerTap({ currentTarget: { dataset: { key: p.data.current.key } } })` →
  等 ~2.5s 再读 State；可观察结果：`power` 从 1 变 0（或反之），且
  `data.current.powerOn` 与之一致。见 `drive.mjs --scenario home-power`。
- **亮度拖动只在停手后下发** → 调 `p.onBrightnessChanging({ detail: { value } })`
  多次，再调 `p.onBrightnessChange({ detail: { value } })`；可观察结果：
  拖动期间设备没收到写入，停手 300ms 后最后一帧到达。
- **搜索过滤** → `p.onQueryInput({ detail: { value: "书" } })`；可观察结果：
  `data.searching === true` 且 `data.searchResults` 里是「书桌」。调
  `p.onQueryClear()` 后 `data.searching === false`。见 `drive.mjs --scenario home-search`。
- **长按菜单五项** → `p.onCardLongPress({ currentTarget: { dataset: { key } } })`；
  可观察结果：`p.$$(".sheet-item")` 恰好 5 个。
- **加号** → 读 `outerWxml()`；可观察结果：含 `<text class="nav-action">+</text>`。

## Gotchas

- **点小图不该连接。** 这是刻意的交互契约（连接发生在设备页）。如果验证脚本点小图后
  `linkState === "ready"`，那是回归，不是「顺手验证了连接」。
- **`busy` 会卡在 true，然后电源键静默返回。** `applyLink()` 在链路进入
  `connecting/initializing` 时把 `busy` 置 true（`pages/home/home.ts:271`），
  而**只有 `onPowerTap` 自己的 `finally` 会把它清掉**。任何不经过 `onPowerTap` 的
  建链——`session.connect` / `session.switchTo` / 静默回连——都会让 `busy` 永久 true，
  之后电源键在 `home.ts:382` 直接 `return`，用户看到的是「点了没反应」。
  本机实测两种触发都成立：直接调 `session.switchTo` 后 `busy=true`；断链后调
  `session.onShow()` 触发静默回连后 `busy=true`，随后电源键 `power` 不变。
  **编写验证脚本时不要用 `session.connect` 代替点电源键**——那既不是用户路径，也会
  制造这个假象。用 `onPowerTap`。若确实需要绕过，先断言 `busy === false`。
- **大卡是 1:1 方形**，照片 `absolute` 铺满，名称与亮度叠在底部、靠 `.hero-scrim`
  渐变保证任意照片上可读。尺寸/可读性只能人眼判断，`records` 证明不了。
- 演示设备的封面在 `assets/devices/*.webp`；**真机没照片时 `photo` 是空串**，
  这是对的，不要把「没图」当失败。
- 亮度拖动会写设备。复位时要把它拖回原值，否则下一次运行的基线变了。
- 搜索是 `bindinput` 入口；直接 `setData({ query })` 不会触发过滤逻辑。
- **`p.selectedKey` 是内存态，`p.refresh()` 之后才生效**；直接改它不会持久化。
  设备「当前是哪台」由会话的 `recentDevices` 顺序决定，复位要改连接状态而不是只改选中态。
