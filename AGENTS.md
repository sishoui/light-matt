# lumen

微信小程序通过 BLE 直连控制 ESP32-C3FH4 驱动的 WS2812B 灯带。

## 新会话从这里开始

**先读 [`docs/handoff.md`](docs/handoff.md)。** 它写清了当前在哪、哪些已完成、剩余工作卡在
什么上。不要凭本文件的简短描述推断进度——项目已经过了三个大版本。

> **刚完成**：灯组进阶编辑器打磨（规格 [#71](https://github.com/sishoui/light-matt/issues/71)，
> 实现票 #72–#83 全部关闭），在分支 `feat/strip-editor-polish`（基线
> `integration/ui-refactor-v4`），**待合入 master**。灯珠上限 64→100 且逐组滑块可调；
> 时间轴固定宽度永不滚动、长按 300ms 抬起跟手重排；光区起止有圆形手柄、弹窗有起止数字滚轮；
> 方案改为**设备级动态槽位**（默认 1 套、上限 4、可删且不重排）；新增**爆闪 / 心跳 / 熄灭**
> 三种灯效与 `0x1E ClearScript`。**本轮没上真机**，也**没做叠加层编辑器**，详见 handoff §0。

**上一轮**：UI 重构 + 协议 v4（规格 [#60](https://github.com/sishoui/light-matt/issues/60)，
实现票 #61–#69），在分支 `integration/ui-refactor-v4`，**待合入 master**。底部改为
「设备 / 我的」，发现页降为二级页，新增**灯组详情页**；协议 v4 把层编码扩到 9 字节并新增
逐光区亮度 `level`。`pages/devices`、`pages/scripts`、`pages/segment-edit` 均已删除。

**上上轮**：v3 的 11 张实现票（#36–#45）与 4 张缺口票（#47–#50）全部关闭，
**已合入 `master`**（PR #51，merge commit `f9f2fe3`）。**设备侧验收已全部跑完**：协议层 47 项 + 行为语义
69 项（`scripts/probe-v3-deep.py`）+ 400s 压力（0 事件）均已在真机闭环。

GitHub **#46** 已关闭且**验收项全部闭环**：§1.1–1.8 的 38 项里 §1.7 多设备的
5 项决定不作验收（只有 1 台设备），有效 32 项 **✅ 32 / ◐ 0 / ☐ 0**。
观感项用相机实测替代人眼，UI 提示文案用**微信开发者工具自动化**实测。

> **写小程序代码时注意**：相对 import 不能指向目录（`from "../usage"`）。
> 小程序的模块解析器不认目录 `index`，会抛 `module 'xxx.js' is not defined`，
> 且在 App 启动链上会导致**整个小程序白屏**——`tsc` 与单测都发现不了。
> 回归测试：`miniprogram/tests/module-resolution.test.ts`。
>
> **第二个同类陷阱**：`Page({...})` 只保证 `data` 里的字段出现在 `this.data`；
> 写在对象字面量上的私有字段（`remoteDevices: [] as X[]`）**运行时是 `undefined`**。
> 它在 `onLoad` 的调用链上会抛错并**中断整页事件绑定**，表现是「点扫描 / 连接 /
> 取消全都没反应」，而构建、`tsc`、单测全绿。每个页面的 `onLoad` 开头必须显式
> 初始化全部私有字段（`segment-edit` 有提前 `return` 分支，必须在它之前）。
> 回归测试：`miniprogram/tests/page-fields.test.ts`。

> **第三个同类陷阱**：`Page({...})` 的私有字段除了要在 `onLoad` 初始化，页面**卸载后**
> 也不该被当成「数据已丢」——进阶档的方案草稿现在落盘在 `lumen.planDrafts.v1`
> （`utils/control/plan-drafts.ts`，键 = `deviceKey#stripId#slot`），断线、切页、
> 重启小程序都不清，**只在用户显式删除设备时清**。那是界面上「内容只存在这台手机上」
> 这句承诺的实现；改这块之前先看 `tests/plan-drafts.test.ts`。

## 小程序 UI 结构（2026-11-03 改版）

**页面树**（`app.json`，全部 `navigationStyle: custom`）：

| 路由 | 角色 |
|---|---|
| `pages/home/home` | **tab 1 设备**：大设备卡 + 下方设备小图；右上角下拉菜单进发现 / 设备信息 / 断开 |
| `pages/me/me` | **tab 2 我的**：本机头像昵称 / 外观 / 演示设备 / 我的设备（删除）/ 版本号 |
| `pages/discover/discover` | 二级页：**只有扫描**（一个按钮 + 一行状态 + 结果列表） |
| `pages/device/device` | 二级页：设备名与状态 / 总开关 / 全局亮度 / **灯组两列卡片** / 设备摘要 |
| `pages/device-info/device-info` | 二级页：身份 / 固件 / 逐组灯珠数与显隐 / 自检 / 改名 / 删除 |
| `pages/strip/strip` | 二级页：**灯组详情**——简单档九张成品卡 / 进阶档时间轴 + 光区轴 + 效果面板 |

> UI 重构（#60）删除了 `pages/devices`（原 tab 2「发现」）、`pages/scripts` 与
> `pages/segment-edit`；设备页**不再有**任何灯效编辑控件，全部搬到 `pages/strip`。

**交互契约**（`pages/home`）：点小图只切换大卡**不连接**；点大卡进 `pages/device`
（在那里才连接）；卡上的电源键是 `catchtap` 快捷开关，未连接时先连上/切换。
大卡是 **1:1 方形**，图片 absolute 铺满，状态徽标与电源键在顶部、名称与亮度信息
叠在图片底部（`.hero-scrim` 渐变保证任意照片上都可读）。
演示设备的封面图在 `assets/devices/*.webp`（三张共 9KB，由 PIL 生成的抽象光照图）；
**真实设备没有照片时 `photo` 为空串**，页面用设备色渐变兜底，不拿图冒充。

**灯组详情页**：简单档 = **九张**成品卡（三列）+ 色相 / 饱和度 / 亮度三个滑块；进阶档自上而下是
时间轴（**固定宽度不滚动**、比例块 + 24px 保底、长按 300ms 抬起跟手重排、≤8 步骤）→ 时长条（0.5–30 秒）
→ 光区轴（按灯珠比例、未覆盖灰条、选中两端圆形手柄、≤8 光区）→ 效果面板（**七类型**：静态 / 呼吸 /
彩虹 / 流光 / 爆闪 / 心跳 / 熄灭，参数区整体替换）。
灯珠方格只在弹窗里出现（起点实心点 / 终点空心环 + 起止数字滚轮）。
底部只有一个「应用并播放」，写入失败在按钮下方就地说明。
**进阶档会把整份方案下发到灯控**（`session.downloadScript(script, { activate: true, loop })`）
—— 只写实时光区的话第 2..N 步根本播不到。

**交互契约**（`pages/home`）：点小图只切换大卡**不连接**；点大卡进 `pages/device`
（在那里才连接）；卡上的电源键是 `catchtap` 快捷开关，未连接时先连上/切换。
大卡是 **1:1 方形**，图片 absolute 铺满，状态徽标与电源键在顶部、名称与亮度信息
叠在图片底部（`.hero-scrim` 渐变保证任意照片上都可读）。
演示设备的封面图在 `assets/devices/*.webp`（三张共 9KB，由 PIL 生成的抽象光照图）；
**真实设备没有照片时 `photo` 为空串**，页面用设备色渐变兜底，不拿图冒充。

**样式**：`app.wxss` 用 CSS 变量（`--bg / --card / --text / --accent / …`），
浅色为默认、深色走 `prefers-color-scheme`，手动覆盖由 `.page.theme-light|theme-dark`
决定（`utils/control/theme.ts`，存储在 `lumen.theme.v1`）。
**页面 wxss 不要写死 hex**——写死会在某个主题下变白底白字。

**导航栏与 tabBar 都是自建的**：`components/nav-bar`（含状态栏高度与胶囊避让）、
`custom-tab-bar`（2 项，图标纯 CSS）。tab 页内容必须给 tabBar 让出
`padding-bottom: calc(140rpx + env(safe-area-inset-bottom))`，否则底部被压住。

**演示模式（mock）**：`utils/ble/mock-transport.ts` 实现与 `BleTransport` 同形的方法，
`utils/control/mock-devices.ts` 提供 3 台设备的 spec，`utils/control/mock-mode.ts`
负责开关与播种（写进真实的 `lumen.recentDevices.v2` / `lumen.deviceRegistry.v1`）。
**无真机记录时默认开启**；有真机记录或用户显式关闭则不起作用。
会话层没有任何 mock 分支——它只拿到一个「传输层」。


**v3 验收手册**：[`docs/acceptance-v3.md`](docs/acceptance-v3.md) —— 逐项清单 + 记录表 +
已完成项的实测数字。

**未完成任务清单**：[`docs/pending-tasks.md`](docs/pending-tasks.md) —— 剩余项按
「人眼 / 手机 / 更多硬件」分类，含相机色域压缩这个最大阻塞。

**证据归档**：[`docs/evidence/`](docs/evidence/) —— 行为探针报告、400s 稳定性数据、
SHA-256 索引、配置丢失记录。

## 字节契约

- **v4（当前唯一真相）**：`docs/protocol-v4.md` + 可执行副本
  `docs/protocol-testvectors-v4.json`（由 `scripts/gen-protocol-testvectors-v4.mjs` 生成）
- **v3 已作废**：`docs/protocol-v3.md` 与 `protocol-testvectors-v3.json` 仅保留供对照
- **v2 已作废**：`docs/protocol.md` 与 `docs/spec-v2.md` 仅保留供对照

改任何字节布局 = 契约 + 向量 + 两端实现同一个 commit。

## 测试基线（改代码后必须保持）

```bash
cmd.exe //c "firmware\\test\\run-tests.cmd"   # 12701 项断言 + 78 条 v4 向量
cd miniprogram && npx vitest run              # 1461 用例 / 56 文件（不含 e2e）
cd miniprogram && npm run test:ble            # 8 项真机 e2e（无设备自动 skip）
cd miniprogram && npx tsc --noEmit            # 必须干净
cd server && npm test                         # 140 用例
cd server && npm run typecheck                # 必须干净
```

**模拟器 UI 回归**（改页面后必跑；需要微信开发者工具开着自动化端口）：

> ⚠️ **截至 `feat/strip-editor-polish`，下面三个脚本已作废**：它们断言的是旧的
> 六张卡 + 方案轮换世界（`onPlanSlotTap`、`quickCards.length === 6` 等），
> 页面已改为九张卡 + 方案 tab，跑会直接崩。**需要按新结构重写**（handoff §0 记录在案）。
> 新增的 `verify-plan-slots.mjs`（26 项，方案 tab / 新建 / 删除）当时能跑通，
> 但它在 gitignored 的 `.auto/` 里，只存在于当时的 worktree。

```bash
cd miniprogram && node .auto/verify-effect-editor.mjs   # ⚠️ 已作废：简单档六卡 / 时间轴 / 光区轴 / 效果面板
cd miniprogram && node .auto/verify-redesign.mjs        # 37 项：页面树 / 大卡 / 小图切换 / 主题 / tabBar / 发现页 / 我的页
cd miniprogram && node .auto/verify-deep.mjs            # ⚠️ 已作废：电源 / 亮度 / 灯组卡片 / 写入 / 播放
cd miniprogram && node .auto/verify-ui-interaction.mjs  # 40 项：点得动（发现页 / 我的页 / 日志面板 / 删除确认）
```

`verify-effect-editor.mjs` 锁的是「只有渲染层能发现」的问题：白屏、`bindtap` 全失效、
点小图却发起了连接、主题 class 没挂上、tabBar 没渲染，以及**点效果卡 / 应用并播放后
设备状态真的变了**（不是只改 data，且方案的步骤数真的到了设备）。改页面后**跑一次再交付**。

## Agent skills

### Issue tracker

GitHub Issues（`sishoui/light-matt`）。**当前 effort 的规格父票是 `#60`**（UI 重构 +
协议 v4），9 张实现票 `#61`–`#69` **全部完成并在集成分支**。上一轮 v3 的父票 `#35`
（`#36`–`#45` / `#46`）已关闭；v1 的 `#1` 与 v2 的 `#27` 是历史。
详见 `docs/agents/issue-tracker.md`。

### Domain docs

单上下文布局（`GLOSSARY.md` + `docs/adr/`）。见 `docs/agents/domain.md`。

## 真机工具

- `scripts/probe-v3.py` —— 协议层 47 项真机验证（PC 当 central，需 bleak）
- `scripts/probe-v3-deep.py` —— 行为语义 69 项（段回滚 / 逐带独立 / 剧本推进 /
  断连续播 / 过大回滚），`--skip-heavy` 跳过 ~900 帧大剧本下发
- `scripts/ble-gateway.py` —— BLE 网关（bleak → JSON over stdio），**由 e2e 自动拉起**。
  让 Node 侧的小程序代码直连 PC 真实蓝牙，无需手机
- `scripts/stress-fragment-v3.py` —— 分片重组压力测试
- `scripts/capture-serial.py` —— 抓串口日志（`--reset` 用 DTR/RTS 复位）
- `scripts/build-firmware.cmd` / `flash-firmware.cmd COM6` —— 编译与烧录

**烧录是断崖升级**：刷 v4 后设备配置回默认值，这是设计取舍，不是 bug（v3 的 State blob
版本 4 与脚本 blob `LMS3`/v2 会被整份拒绝，v4 用版本 5 与 `LMS4`/v3）。
