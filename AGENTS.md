# lumen

微信小程序通过 BLE 直连控制 ESP32-C3FH4 驱动的 WS2812B 灯带。

## 新会话从这里开始

**先读 [`docs/handoff.md`](docs/handoff.md)。** 它写清了当前在哪、哪些已完成、剩余工作卡在
什么上。不要凭本文件的简短描述推断进度——项目已经过了三个大版本。

> **当前状态：第十一轮（v5 · 部位与场景）在 `integration/lumen-v5`（draft PR #163），
> 九张票全部落地，**实现完成、待合入**。** 规格 [#145](https://github.com/sishoui/light-matt/issues/145)，
> 实现票 `#154`–`#162`。详见 [`docs/handoff.md`](docs/handoff.md) §0 与
> [`docs/evidence/v5-integration-2026-11-07.md`](docs/evidence/v5-integration-2026-11-07.md)。
> v5 是**断崖**：协议 v5、灯组 → **部位**（多段灯珠、各有独立时间轴）、三套**场景**；
> 「灯组详情页」与「简单档」已删，压成「设备页 → 部位编辑器」两层。
> **`ui` 层必须跑**（`scripts/verify-v5.mjs` 48/48），改 `pages/device` / `pages/part` 时它验的是
> 「点得动 + 设备真的收到」——单测（直接 `new ControlSession`）覆盖不到那一层。
> **改过页面之后若 `ui` 报「方法不存在」，先重开 `cli auto`**：开发者工具会缓存旧编译产物。
>
> **800 颗 / 64 播放头的帧率基线已实测**：`--framerate` 把 8 条链的 `SetLedCount`
> 全部设成 100（不必真的接 800 颗灯——RMT 仍按 100 颗的位时间真的发，CPU 成本是真实的），
> **round ≈ 5.53 ms / 轮，20fps 预算 50 ms**。
> 注意判据：必须 `lit=8` 且 `pushed` 持续增长，否则测到的是「去重跳过、什么都没推」
> （第一版就踩了这个坑，读出物理上不可能的 1.9ms）。
>
> 上一轮（第十轮）的修复在 `fix/no-segment-black-and-layer-blend`，已随本分支带上。

**第五轮**（规格 [#85](https://github.com/sishoui/light-matt/issues/85)，实现票 #90–#101）：

| 层 | 变化 |
|---|---|
| 主题 | 主色从橙换成**雾蓝**（浅 `#6B8CAE` / 深 `#8FA9C4`）；页面 / 导航栏 / tabBar / 原生滑块三处同时换色，切完任意页都是新色 |
| 首页 | 右上角加号下拉 / 灰底搜索框（按名称过滤）/ 大卡亮度可拖（停手 300ms 才下发）/ 长按弹五项菜单 |
| 发现页 | 重做成**清单式**（搜索条 + 分组标题 + 封面与信号条），点一行弹**添加表单**（名称预填 + 封面），不再点一下就跳走 |
| 设备页 | 去掉整条状态栏（状态收进副标题）/ 三点菜单 / 灯组卡片改单列（封面 + 名称 + 开关），长按改名与换封面 |
| 灯组页 | 灯珠数改成标题右侧胶囊，**长按弹圆盘**（1–100，松手下发）/ 方案固定三套圆形数字 / 简单档改成一行式灯效 + 滚轮，**去掉「应用并播放」**（改动立即生效）/ 「光区」全面改叫**分区**，新增逐颗预览条 |
| 进阶页 | 时间轴不再包在卡片里、标题放大、加步骤在右侧；选中步骤下方有**气泡卡片**（步骤名 / 时长 / 分区列表）；**循环三档**（不循环 / 全部循环 / 最后一步循环）；「效果 + 叠加效果」改成平级的**背景层 + 特效层**，混合只剩相加 / 覆盖 |
| 灯效 | 八个：空 / 常亮 / 呼吸 / 彩虹 / 流星 / 爆闪 / 心跳 / 随机闪烁（名字不带颜色） |
| 协议（仍是 v4） | 流星可调密度与实色拖尾、新增**随机闪烁 `0x07`**、循环字节扩成三值 |
| 修缺陷 | 删除设备现在是**一组动作**（断开 + 清六处存储 + 演示设备不再回来）；电源键三条静默返回都有反馈；灯效选中不再被迟到的读回覆盖；下发前补齐其它灯组切片，修掉跨灯组串扰 |
| 新增单测 | `theme-sync` / `add-device` / `strip-meta` / `delete-device` / `home-actions` / `quick-selection` / `simple-effects` / `strip-head` / `zone-preview` / `advanced-layers` / `plan-fill` |

**上一轮**（规格 [#71](https://github.com/sishoui/light-matt/issues/71)，实现票 #72–#83）：
灯珠上限 64→100 且逐组滑块可调；时间轴固定宽度永不滚动、长按 300ms 抬起跟手重排；
分区起止有圆形手柄、弹窗有起止数字滚轮；方案改为**设备级动态槽位**（默认 1 套、上限 4、
可删且不重排）；新增**爆闪 / 心跳 / 熄灭**三种灯效与 `0x1E ClearScript`；
进阶档有**叠加层编辑器**（不含「熄灭」）——**第五轮已用「两层模型」取代它**。

**再上一轮**（规格 [#60](https://github.com/sishoui/light-matt/issues/60)，实现票 #61–#69）：
底部改为「设备 / 我的」，发现页降为二级页，新增**灯组详情页**；协议 v4 把层编码扩到
9 字节并新增逐分区亮度 `level`。`pages/devices`、`pages/scripts`、`pages/segment-edit`
均已删除。

**验收**：真机探针（`scripts/probe-v4.py`）、模拟器渲染回归、三端单测全部通过，
肉眼观感已确认。数字见 [`docs/acceptance-v4.md`](docs/acceptance-v4.md)、
[`docs/acceptance-v5.md`](docs/acceptance-v5.md) 与最近一次测试报告。

**上上轮**：v3 的 11 张实现票（#36–#45）与 4 张缺口票（#47–#50）全部关闭，
**已合入 `master`**（PR #51，merge commit `f9f2fe3`）。**设备侧验收已全部跑完**：协议层探针 + 行为语义探针
（`scripts/probe-v3-deep.py`）+ 400s 压力（0 事件）均已在真机闭环。

GitHub **#46** 已关闭且**验收项全部闭环**：§1.1–1.8 的 38 项里 §1.7 多设备的
5 项决定不作验收（只有 1 台设备），有效 33 项 **✅ 33 / ◐ 0 / ☐ 0**（口径见
[`docs/acceptance-v3.md`](docs/acceptance-v3.md) §5.1）。
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
**进阶档没有「应用」按钮**（#125）：离散动作点完即下发、滑块松手才下发，
写入失败的原因显示在**页面顶部**（`applyError`）。
**进阶档会把整份方案下发到灯控**（`session.downloadScript(script, { activate: true, loop })`）
—— 只写实时光区的话第 2..N 步根本播不到。上传在**停播之前**（#124，只写 staging
不影响画面），否则停播到开播之间会闪回旧画面。
**方案只驱动它包含的灯带**（#122，`firmware/main/script_scope.c`）：没编排过的带
继续渲自己的实时分区，停播 / 切步 / 播完都碰不到它。不要再「补齐其它灯带」——
`QueryStrip` 读的是静态存储，播放中的画面协议读不回来。

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

## 测试

**怎么跑、改哪类代码该跑哪层、报告在哪、清单怎么维护，全部见 [`docs/testing.md`](docs/testing.md)。**
日常一条命令：`node scripts/test-run.mjs`（固件 / 小程序 / 后端三层，约 10 秒）。
改页面再加 `node scripts/test-run.mjs ui`；发版前 `--release`。

### `ui` 层（渲染回归）怎么开起来

`ui` 层长期报 `SKIPPED: 缺自动化端口`，**不是没装工具，是没开自动化**。三步：

```powershell
# 1. 开发者工具已安装（本机：C:\Program Files (x86)\Tencent\微信web开发者工具）
# 2. 用 CLI 开自动化（IDE 已在 9501 上跑时，auto 会自己占 9502）
powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat' auto --project 'C:\Users\13092\Desktop\项目\zcode\lumen\miniprogram'"
# 3. 指定端口跑（auto 通常落在 9502）
WS=ws://127.0.0.1:9502 node scripts/verify-v5.mjs
```

- **9501 是 IDE 的 HTTP 端口，不是自动化 ws**。探 9501 通 ≠ 自动化可用。
- 带中文路径的 `.ps1` 必须存成 **UTF-8 with BOM**，否则 PowerShell 把 `微信` 读成乱码、
  报「找不到 cli.bat」。
- `cli auto` 若报 `IDE server has started on 9501 and must be restarted on 9420`，
  **不要加 `--port`**，直接不带端口重跑。
- `scripts/verify-v5.mjs` 的断言集已改写成 **v5 页面**（设备页就地展开 + 部位编辑器），
  实测 **38/38**。改这两个页面时它必须跟着改——它验的是「点得动 + 设备真的收到」，
  这是单测（直接 `new ControlSession`）覆盖不到的那一层。

## Agent skills

### Issue tracker

GitHub Issues（`sishoui/light-matt`）。**最近一轮的规格父票是 `#102`**（测试流程改造），
九张实现票 `#103`–`#111` **全部关闭**，改动在集成分支 `integration/test-flow`。
上一轮的 `#85`（UI 第五轮，`#90`–`#101`）已合入 `master`；`#60`（UI 重构 + 协议 v4）
与 v3 的 `#35` 已关闭；v1 的 `#1` 与 v2 的 `#27` 是历史。
详见 `docs/agents/issue-tracker.md`。

### Domain docs

单上下文布局（`GLOSSARY.md` + `docs/adr/`）。见 `docs/agents/domain.md`。

### 会话收尾：发飞书总结

**每次会话结束前必须发一条**，用 `scripts/notify-feishu.py` 把本轮做了什么、
跑到什么数、卡在哪发到飞书群。这是硬规则：**「没发」和「发过了」必须长得不一样**。

```bash
# 凭证只放环境变量，永不写进仓库 / 文档 / commit
export FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx

python scripts/notify-feishu.py --status green \
  --title "lumen 会话总结 · <一句话结论>" \
  --body-file .scratch/session-summary.md
```

| 项 | 要求 |
|---|---|
| 数字 | 引用**最近一次测试报告**的实际值（见 `docs/testing.md`），不抄旧数、不写「都正常」 |
| 失败 | 有失败就用 `--status red`，写清哪层、哪条、报错原文 |
| 未覆盖 | 明确列出没跑的层（如 `ui` 缺服务端口而 SKIP），**不许当通过** |
| 凭证 | 只从 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 读；泄露过的 secret 要去后台重置 |
| 目标群 | 默认 `oc_19c2c88a44e0ae537b82d72712afbf53`，换群用 `--chat-id` |
| 验证 | 脚本会打印 `message_id`；要复核可 `GET /open-apis/im/v1/messages/{id}` |

**凭证放在 `lumen/.env`**（已 gitignore，键名 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`）。
**不要每次重新找**：直接 `set -a && . ./.env && set +a` 再跑脚本即可。

```bash
cd "C:\Users\13092\Desktop\项目\zcode\lumen"
set -a && . ./.env && set +a
python scripts/notify-feishu.py --status green --title "..." --body-file .scratch/xxx.md
```

**为什么是应用凭证而不是自定义机器人 Webhook**：Webhook 只能发到「它被添加的那个群」，
不能指定 `chat_id`；要发固定群就得走 `im/v1/messages`。
**前提是应用已发布并开了 `im:message` 权限**，否则换得到 token 但发消息会报权限错。

没配凭证时脚本退出码 `2` 并打印缺什么。**不要因此静默跳过**——在回复里明说
「总结未发送：缺 FEISHU_APP_ID/SECRET」，让用户知道这事没做完。

## 真机工具

- `scripts/probe-v5.py` —— **v5 协议层真机验证（67 项，当前唯一有效的协议探针）**。
  含断崖、布局往返、段互斥、场景往返、复位恢复。`--skip-persist` 跳过复位段
- `scripts/probe-v3.py` / `probe-v3-deep.py` / `probe-v4.py` —— v3/v4 时代的探针，
  **对 v5 固件全部无效**（命令字与 State 布局都换了），只留作历史
- `scripts/ble-gateway.py` —— BLE 网关（bleak → JSON over stdio），**由 e2e 自动拉起**。
  让 Node 侧的小程序代码直连 PC 真实蓝牙，无需手机
- `scripts/stress-fragment-v3.py` —— 分片重组压力测试
- `scripts/capture-serial.py` —— 抓串口日志（`--reset` 用 DTR/RTS 复位）
- `scripts/build-firmware.cmd` / `flash-firmware.cmd COM6` —— 编译与烧录

### 本机环境（换机器要重做）

| 项 | 值 |
|---|---|
| ESP-IDF | v6.1，checkout 在 `C:\Users\13092\esp\esp-idf\esp-idf` |
| Python 环境 | `C:\Espressif\python_env\idf6.1_py3.11_env` |
| **export.bat 的坑** | 它默认找 `idf6.1_py3.12_env`，本机只装了 3.11 → **必须先 `set IDF_PYTHON_ENV_PATH`**，否则报 `not found` |
| 设备 | `Lumen-5662` / `CC:8D:A2:C2:56:62`，串口 `COM6`，8 条链 × 30 颗 |
| **组件注册表** | 本机连不上 `components-file.espressif.com`（TLS 失败）。`idf.py build` 会卡在配置阶段——**把 `%TEMP%\lumen-firmware\managed_components` 里的 `espressif__led_strip` 复制到新目录**即可离线编译 |
| **仓库路径含中文** | `项目` 会让 riscv gcc 读 `picolibc.specs` 时把路径截成 `\x0a`。**必须在 ASCII 路径下编译**（`scripts/build-firmware.cmd` 拷到 `%TEMP%\lumen-firmware` 就是为了这个） |

一条能跑通的编译+烧录（在 ASCII 目录里）：

```bat
set "MSYSTEM="
set "IDF_TOOLS_PATH=C:\Espressif"
set "IDF_PYTHON_ENV_PATH=C:\Espressif\python_env\idf6.1_py3.11_env"
call "C:\Users\13092\esp\esp-idf\esp-idf\export.bat"
idf.py --no-ccache set-target esp32c3
idf.py --no-ccache build
idf.py -p COM6 flash
```

**烧录是断崖升级**：刷 v5 后设备配置回默认值，这是设计取舍，不是 bug（v4 的 State blob
版本 5、脚本 blob `LMS4`/v3 与段表都会被整份拒绝，v5 用 State blob 版本 6、
布局键 `LML1`、场景键 `LMS5`）。**灯组名与封面存在手机上，不受影响。**
