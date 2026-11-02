# lumen

微信小程序通过 BLE 直连控制 ESP32-C3FH4 驱动的 WS2812B 灯带。

## 新会话从这里开始

**先读 [`docs/handoff.md`](docs/handoff.md)。** 它写清了当前在哪、哪些已完成、剩余工作卡在
什么上。不要凭本文件的简短描述推断进度——项目已经过了三个大版本。

> **刚完成**：灯效编辑重构（规格 [#52](https://github.com/sishoui/light-matt/issues/52)，
> 实现票 #53–#58），在分支 `feat/effect-editor`，**待合入 master**。灯效编辑现在是
> 设备详情页里的「快捷 / 自定义」两档；`pages/scripts` 与 `pages/segment-edit` 已删除。
> 细节与两个真机陷阱见 handoff §0。

**当前状态**：v3 的 11 张实现票（#36–#45）与 4 张缺口票（#47–#50）全部关闭，
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

## 小程序 UI 结构（2026-11-02 改版）

**页面树**（`app.json`，全部 `navigationStyle: custom`）：

| 路由 | 角色 |
|---|---|
| `pages/home/home` | **tab 1 设备**：大设备卡 + 下方设备小图 |
| `pages/devices/devices` | **tab 2 发现**：扫描 / 我的设备 / 外观 / 演示开关 |
| `pages/device/device` | 二级页：**设备控制 + 灯效编辑（快捷 / 自定义两档）** |
| `pages/device-info/device-info` | 二级页：身份 / 固件 / 灯珠数 / 自检 / 改名 / 删除 |

> 灯效编辑重构（#52）删除了 `pages/scripts`（剧本 tab）与 `pages/segment-edit`：
> 多步骤方案并入设备详情页的「自定义」档，底部只剩「设备 / 发现」两项。

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

- **v3（当前唯一真相）**：`docs/protocol-v3.md` + 可执行副本
  `docs/protocol-testvectors-v3.json`（由 `scripts/gen-protocol-testvectors-v3.mjs` 生成）
- **v2 已作废**：`docs/protocol.md` 与 `docs/spec-v2.md` 仅保留供对照

改任何字节布局 = 契约 + 向量 + 两端实现同一个 commit。

## 测试基线（改代码后必须保持）

```bash
cmd.exe //c "firmware\\test\\run-tests.cmd"   # 11053 项断言 + 58 条 v3 向量
cd miniprogram && npx vitest run              # 921 用例（不含 e2e）
cd miniprogram && npm run test:ble            # 8 项真机 e2e（无设备自动 skip）
cd miniprogram && npx tsc --noEmit            # 必须干净
cd server && npm test                         # 140 用例
cd server && npm run typecheck                # 必须干净
```

**模拟器 UI 回归**（改页面后必跑；需要微信开发者工具开着自动化端口）：

```bash
cd miniprogram && node .auto/verify-effect-editor.mjs   # 48 项：快捷卡生效 / 参数区 / 切分 / 快照恢复 / 逐组灯珠数 / 术语 / 两 tab
cd miniprogram && node .auto/verify-redesign.mjs        # 26 项：页面树 / 大卡 / 小图切换 / 主题 / tabBar
cd miniprogram && node .auto/verify-deep.mjs            # 27 项：电源 / 亮度 / 自定义档 / 写入 / 播放
cd miniprogram && node .auto/verify-ui-interaction.mjs  # 7 项：点得动
```

`verify-effect-editor.mjs` 锁的是「只有渲染层能发现」的问题：白屏、`bindtap` 全失效、
点小图却发起了连接、主题 class 没挂上、tabBar 没渲染，以及**点效果卡后设备状态
真的变了**（不是只改 data）。改页面后**跑一次再交付**。

## Agent skills

### Issue tracker

GitHub Issues（`sishoui/light-matt`）。**当前 effort 的规格父票是 `#35`**（v3），
11 张实现票 `#36`–`#45` 已关闭，#46 验收票 open。v1 的父票 `#1` 与 v2 的 `#27` 是历史。
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

**烧录是断崖升级**：刷 v3 后设备配置回默认值，这是设计取舍，不是 bug。
