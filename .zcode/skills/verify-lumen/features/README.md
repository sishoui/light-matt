# lumen 验证特性地图

这个目录是 lumen 小程序**用户可见行为**的验证配方来源。驱动之前先读本索引，然后
用对应的特性文件当配方。

## 基线前置条件

- 微信开发者工具开着自动化端口，且窗口里打开的是 `<仓库>/miniprogram`（见
  `../SKILL.md` §2）。默认端点 `ws://127.0.0.1:9502`，用 `WS=` 覆盖。
- `node .zcode/skills/verify-lumen/scripts/doctor.mjs` 全绿再驱动。
- 没有真机连接记录时，**演示模式默认开启**，播三台设备：`书桌`（2 条灯组，开着）、
  `客厅`（8 条，关着）、`卧室`（1 条，低亮度）。大部分配方依赖它。
- 驱动前记录当前状态，因为配方会真的改设备状态与存储；**每个配方负责复位**。
- 只驱动本技能自己确认过的实例。窗口里如果是别的项目，断言结果毫无意义。

## 驱动约定

- 导航走真实路由：`mp.switchTab("/pages/home/home")`、
  `mp.navigateTo("/pages/device/device?key=<URL 编码的 key>")`。
- 交互调用页面自己的处理器，传它期望的 event 形状：
  `p.onPowerTap({ currentTarget: { dataset: { key } } })`。
- 读数据必须 `mp.evaluate(() => getCurrentPages().pop().data)`——
  这个 SDK 版本的 `page.data()` 不可用。
- 读 DOM 用 `mp.currentPage().then(p => p.$$(".class"))` 与 `.outerWxml()`。
- 每条断言写清「动作 + 结果」，不要只截一张最终屏。

## 证明与跳过的报告

- 界面证明 = 交互前后的 `records` 断言 + 能解释「凭什么是这个结果」的原始数字。
- 副作用证明 = 设备 State 读回（`p.session`）或存储键第二次只读查看。
- 每个产物带上特性 ID 与所用入口。
- 路径走不通时报告**尝试过的调用与未满足的前置条件**，不要把「换个入口跑通了」
  当成原入口已验证。

## 特性文件契约

每个特性文件以 H1 标题开头，一段话说清用户可见行为，然后**恰好四个 H2**，顺序固定：

1. `Sub-features` —— 短 ID + 一行说明。
2. `How to get to it (user POV)` —— 所有用户入口。
3. `Driving it with miniprogram-automator` —— 以 `Preconditions:` 开头，逐条把
   用户动作与确切调用、可观察结果配对。
4. `Gotchas` —— 会浪费或作废一次验证的坑。

## 特性索引

- [首页设备卡](./home-page.md) —— 大卡 / 小图切换 / 电源键 / 亮度拖动 / 搜索 / 长按菜单。
- [发现与添加设备](./discover-add-device.md) —— 扫描、清单式结果、添加表单。
- [设备页](./device-page.md) —— 总开关 / 全局亮度 / 灯组单列卡片 / 三点菜单。
- [灯组简单档](./strip-simple.md) —— 灯珠胶囊与圆盘、三套方案、一行式灯效。
- [灯组进阶档](./strip-advanced.md) —— 时间轴、步骤气泡、循环三档、背景层 / 特效层。
- [我的与主题](./me-and-theme.md) —— 主题切换（三处同步）、演示开关、删除设备、日志面板。

## 当前覆盖

`drive.mjs` 里可直接跑的五个场景，与本机三轮实测（66/66）对应：

| 场景 | 覆盖的特性 | 断言数 |
|---|---|---|
| `doctor` | 基线：启动链 / 设备 / 忙碌态 / 主题 | 4 |
| `home-search` | HOME-4 | 3 |
| `home-power` | HOME-2（含 State 读回与复位） | 3 |
| `strip-advanced` | ADV-3 / ADV-5 / ADV-6 | 6 |
| `delete-device` | ME-3（含还原） | 6 |

其余子特性只有配方文字（`How to get to it` / `Driving it` 段），没有现成场景。要自动化就
照 `drive.mjs` 里的形状加一个 `scenarios` 条目。
