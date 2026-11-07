# 交接：lumen 当前状态与下一步

**最后更新**：2026-11-07（第十一轮完成）　**分支**：`integration/lumen-v5`
（PR [#163](https://github.com/sishoui/light-matt/pull/163)，**已 ready for review**）

这份文件是给**新会话**的入口。它只写「新会话必须知道、但代码和文档里读不到」的东西；
其余一律给指针，不重复。

---

## 0. 2026-11-07 第十一轮：v5 · 部位与场景（**实现全部完成，待合入**）

**规格 [#145](https://github.com/sishoui/light-matt/issues/145)，9 张垂直切片票 `#154`–`#162`。**

v5 是**断崖**：协议、持久化、渲染模型全换。一条链切成多个**部位**（可多段不连续灯珠），
每个部位有自己的时间轴（各走各的时钟），整机三套**场景**。「灯组详情页」与「简单档」都删了，
压成「设备页 → 部位编辑器」两层。

### 九张票全部落地

| 票 | 内容 | commit |
|---|---|---|
| #154 | 时间轴与效果面板抽成可独立驱动的单元 | `d1fd496` |
| #155 | 契约 v5 + 布局/场景持久化 + `lumen_scene_compose` + 命令层 + 小程序编解码与会话 + 设备页展开 + `pages/part` | `e536e85` |
| — | 真机验收修掉的三个固件缺陷（见 §0.1） | `bfecae4` |
| #156 | 部位划分与方格拖选（`utils/control/part-layout.ts` + 部位页结构区） | `c90dad3` |
| #157 | 每部位多步时间轴（读回整条、增删重排即下发；时长区间改到 100ms–60s） | `fb99eda` |
| #158 | **改契约**：相位模式落盘（每部位一份）+ 叠加开关 | `0ef78e8` `f0e2f32` |
| #159 | 三个场景的场景条与改名（演示传输层改成按场景分开存） | `2cb6264` |
| #160 | 开关层级验收（**没改代码**：两层天然住在不同的表里） | `bb65ce1` |
| #161 | 首次启动清掉 v4 退役存储键（此前 `planDraftsCleared` 是假 0） | `b0c25ca` |
| #162 | 整合验收；**真机抓到并修掉两个 P0**（见 §0.2） | `6199e2d` |

### 当前数字

| 层 | 实测 |
|---|---|
| 固件 host | **12976 断言** + 113 向量 |
| 小程序 | **1199 用例 / 60 文件** |
| 后端 | 140 用例 |
| ui 渲染回归 | **48 条**（`verify-v5.mjs`） |
| 真机 e2e | **7 用例**（`doctor.py` 修好后不再是 SKIP） |
| 真机协议回归 | `probe-v5.py` **58/58** |
| 真机整合验收 | `probe-v5-acceptance.py` **31/31**（含断电恢复） |

证据：[`evidence/v5-integration-2026-11-07.md`](evidence/v5-integration-2026-11-07.md)。

### 收尾状态

- 九张票**全部关闭**，每张都留了「交付内容 + 验收逐条 + 数字」的评论。
- **PR [#163](https://github.com/sishoui/light-matt/pull/163) 已合入 `master`**
  （merge commit `70cc47d`，53 个 commit）。规格父票 **#145 已关闭**。
- 合入后 master 三层全绿：固件 12976 断言 / 小程序 1203 用例 / 后端 140 用例。

### 合入后又补的两项

| # | 项 | 结果 |
|---|---|---|
| 1 | `pushSteps()` 的并发缺陷 | **已修**（`50c6730`，随 PR 合入）。见下 |
| 2 | **相位漂移真机数字** | **已测**（`dab2744`）。见下 |

#### 第 1 项：比票面写的更严重

`pending-tasks.md` 原话是「缺 busy 重入保护」。实际读代码后发现是三个缺陷叠在一起：

1. **不查 `data.busy`**：能在 `onSaveContent()` / `commitLayout()` 写到一半时插进来，
   `applyEpoch += 1` 把对方那半截写**静默作废**——用户刚调的灯效没到设备。
2. **循环里现读 `this.timelineSteps`**：写到一半的编辑会让设备拿到「步数按旧的、
   时长按新的」这种谁都没见过的混合态。
3. **`onSaveContent()` 在第一个 `await` 之后才读 `this.timeline.selected`**：保存途中
   点「加一步」会把选中挪到新步，灯效被写到一个还没声明步数的下标上，设备回
   `InvalidParam`——用户看到「保存没反应」。

修法按 #125 的三件套：**互斥 + 补跑 + 快照**（`stepsBusy` / `stepsQueued` /
入口取 `stepIndex`）。新增 `tests/part-push-race.test.ts`（4 条），复现靠给传输层
套一道**可扣帧的闸门**（mock 的 `sendAndWaitAck` 是同步返回的，造不出时间窗口）。
**变异验证**：去掉互斥 → 2 条红；循环改回现读 → 1 条红；`selected` 改回晚读 → 1 条红。

#### 第 2 项：相位漂移（票面唯一字面未兑现项，现已兑现）

协议不报播放头，所以加了一条**只在调试构建里存在**的串口日志
（`CONFIG_LUMEN_PLAYHEAD_LOG`，默认 `n`，**不进线上契约**）。

**判据是闭式解残差，不是「步号变了没有」**：

```
elapsed_total = (t - origin) mod total
reconstructed = sum(table[:step]) + elapsed
residual      = reconstructed - elapsed_total
```

残差恒 0（±1ms 整数截断）= 播放头完全由绝对时间决定；残差随时间单调增大 =
累加式实现，那才是真漂移。**「步号一直在变」只能证明在动，证明不了没漂。**

工具：`scripts/probe-v5-drift.py`（布置 + 采集）、`scripts/analyze-playhead-log.py`
（判据，5 项自检）。布置的周期**互质**（700ms vs 900ms，lcm 6300）——周期能整除
采样间隔时每次采样都落在同一相位，那样既看不出漂移也验不到「各走各的」。

**为什么选串口而不是加协议命令**（原三选一的 (c)）：加一条只读命令要动契约 +
向量 + 两端实现，那是规格里成本最高的一类改动，而这件事只做一次验收。串口是
本机调试通道，不进线上契约。代价是固件里多一个默认关闭的编译开关。

> **踩到的坑**：布置场景后**必须等够 2 秒防抖**再断开连接。`SceneStep` 是 2 秒
> 防抖落盘，提前断开会让整个场景留在 RAM 没进 NVS——重启后场景回到出厂那 1 步，
> 而布局（`LayoutCommit` 立即落盘）还在，所以 `parts=2` 但时间轴是错的。第一版
> 就踩了这个，白跑两轮。现在脚本等 3 秒 + `QueryScene` 复核步数才算布置成功。

### 已明确不做

**元祖形态实拍**（8 部位不同节奏的暗房录像）——用户 2026-11-07 明确说「只是一个举例，
暂时不用实拍」。机制已由 30 分钟漂移测试 + 800 颗帧率实测覆盖。**不要再当成欠账。**

> 帧率基线**已补测**：`--framerate` 把 8 条链的 `SetLedCount` 全设成 100（800 颗），
> 实测 **round ≈ 5.53 ms / 轮**，预算 50 ms。不需要真的接 800 颗灯珠——RMT 按 100 颗
> 的位时间真的发，CPU 成本是真实的。判据必须 `lit=8` 且 `pushed` 持续增长，
> 否则测到的是「去重跳过」的空场景。

### `ui` 层：已跑通（48/48），但依赖一个**必须手动开**的服务

`verify-v5.mjs` 的断言集已经改写成 v5 页面，本轮实测 **48/48 通过**（含方格拖选、
场景条、相位落盘、叠加开关）。**改 `pages/device` / `pages/part` 必须跑它**——它验的是
「点得动 + 设备真的收到」，单测（直接 `new ControlSession`）覆盖不到那一层。

> ⚠️ **它会随开发者工具自动化进程退出而变回 SKIP**（`ECONNREFUSED ws://127.0.0.1:9502`）。
> 这是**环境状态**，不是代码坏了。下个会话若看到 `ui` SKIP，先跑下面的命令重开，
> 再判这一层。**别把 SKIP 当成通过，也别当成失败。**

```powershell
# 加 --auto-port 9502 让端口可预测（不加时它会自己挑，下面那行就连不上）
powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat' auto --project 'C:\Users\13092\Desktop\项目\zcode\lumen\miniprogram' --auto-port 9502"
```
```bash
WS=ws://127.0.0.1:9502 node scripts/test-run.mjs ui
```

> **`9501` 是 IDE 的 HTTP 端口，不是自动化 ws**。探 9501 通 ≠ 自动化可用（本轮踩过：
> 9501 在听、9502 已关，`ui` 照样 SKIP）。
> 若报 `IDE server has started on 9501 and must be restarted on 9420`，**不要加 `--port`**，
> 不带端口重跑即可。

### 0.1 更早一次真机验收推翻了两票的「已完成」（三个固件缺陷）

`#154` / `#155` 合入时各层测试全绿，**刷到真机后设备起不来**。三个缺陷 host 测试与编译
都发现不了，全部在 `app_main` 任务的 **3584 字节**栈上：

| 缺陷 | 症状 |
|---|---|
| `lumen_led_engine_init` 栈上放 `lumen_layout_store_t`(2696 B) + `lumen_scene_t`(**10530 B**) | 启动即 `Stack protection fault`，连广播都不出 |
| `lumen_scene_blob_decode` / `lumen_layout_blob_decode` 的 `decoded` 同样在栈上 | **第一次能启动**（NVS 空、走不到解码），写入数据后每次复位都 panic |
| 多链时 `led_count[1..7]` 从没写回 State | `lumen_layout_store_validate` 要求每条已配置链的灯珠数非 0 → **每句 LayoutCommit 都被拒**，部位划分改了不生效、也落不了盘 |

修法：三处大结构改 `static`；`counts[]` 写回 `s_state.led_count[]`。

**探针**：`scripts/probe-v5.py`（67 项，v5 唯一有效的协议探针）。

| 阶段 | 结果 |
|---|---|
| 修复前 | 1 / 37（连 ACK 都收不到） |
| 三处修完 | **67 / 67**，含断电重启读回（布局 2 部位 / 场景 2 部位头 + 3 步 / `layout_valid=1` / 8 链灯珠数全在） |

> **教训**：「编译通过 + host 测试绿 + 模拟器绿」不证明固件能跑。v5 每加一个大结构，
> 先问一句「它在哪个栈上」。`scene_store.h` 留了栈预算说明；`AGENTS.md` 有本机
> ESP-IDF 环境（`IDF_PYTHON_ENV_PATH` / 组件注册表离线 / 仓库路径含中文）。

### 0.2 这一轮真机又抓到两个 P0（#162）

与 §0.1 同一类：**编译通过 + host 全绿 + 模拟器全绿，真机上不work**。两个都是「自洽性」
问题，都不在单个模块内部，而在「两边说好要一致」的地方。

| 缺陷 | 症状 | 根因 |
|---|---|---|
| 多帧报告在 BLE 主机任务的 RX 回调里连发 | `QueryScene` 只读回 2~28 个部位头、15~221 步，`SceneListEnd` 从不出现；串口成片 `ScenePartReport 发送失败` | `ble_gatts_notify_custom` 只把 mbuf 排队，真正上天线要等主机任务回到事件循环——而它正卡在回调里。第 18 帧后缓冲耗尽。**`vTaskDelay` 让出 CPU 无效**（执行者就是它自己）。改成独立 `report_task` |
| 场景 blob 的 `size` / `encode` / `decode` 对「未编排部位」各说各话 | 保存回 `0x00`、串口打 `saved key=scene0 (252 bytes)`，但重启后三个场景全空 | size 只按实际步数算、encode 写全部 64 槽位的头、decode 也要求全部 64 个 → blob 比解码期望的短，`p + 3 > limit` 让**每次**恢复都失败。三处统一为「每链只算到最后一个有步的部位」 |

> **第二个为什么 host 测试一直绿**：测试构造的场景恰好把槽位都填满了——**测试与真机
> 数据的形状不同**。修法里最重要的是那条新回归：**只编排一个部位**的 roundtrip。
>
> **教训**：凡是有「编码 / 解码 / 长度计算」三处的地方，测试必须覆盖**稀疏形态**
> （只填一格），不能只测「填满」。同理，凡是有 `notify` 循环的地方，要问「执行者是谁」。

### 0.3 这一轮后来补修的东西（合入前，都在 `3b57338` 之后）

除了 §0.2 的两个 P0，收尾阶段又修了这些。**都是「只有真机 / 只有审查才能发现」的那类。**

| 修了什么 | 症状 / 为什么 |
|---|---|
| `doctor.py` 还是 **v4 契约** | `VERSION=0x04`、37 字节 State、已退役的 `0x12 QueryStrip`。v5 固件上必然报「收到 0x88 = NO」→ `test-run` 的 e2e 层**长期 SKIP**。这个 SKIP 一直被当成「环境没开」而不是「脚本过期」。重写后五层**首次全部 PASS** |
| 真机 e2e 的布局往返缺 `phase` | #158 把 `LayoutPart` 改成 29 字节，这条用例的字面量没跟。因为 e2e 一直 SKIP，没人发现 |
| **报告流没有连接代次** | 上一轮加的 `drop_pending_reports` 只清得掉队列里**还没开始**的请求。一次 QueryScene 最坏 30 秒，中间断开重连会让剩下几百条带**旧 seq** 发到**新连接**上（`ackWaiters` 只按 seq 匹配，可能张冠李戴） |
| **AGENTS.md 写着「v4（当前唯一真相）」** | 协议早就到 v5。同一份文件底下还列着「v3/v2 已作废」，唯独 v4 没改 |
| `acceptance-v5.md` 名不副实 | 它记的是第五轮 **UI**（#85）。改名 `acceptance-ui-round5.md`，`acceptance-v5.md` 改成指针 |
| `test-manifest.json` 还在为 v4 校验脚本记账 | 固件层实际只跑 v5 的 checker，但 manifest 把 v4 那个算成「这一层的测试文件」 |
| 两处「只有单测在调用」的死代码 | `color.ts::presetBrightness`、`throttle.ts::dropIf` |
| `probe-v5-nvs-stress.py` 收尾顺序错 | 先写布局再缩灯珠数 → 布局里 `end=99` 的段与 30 颗冲突（`LayoutCommit` 能过，**下次上电整份拒绝**） |
| `probe-v5.py` 假设设备干净 | 它要求「只报 2 个部位」。但场景与布局是**两张表**（§6.2 末段明确允许先编排时间轴再划灯珠），残留 part 2..7 是**合法状态** |

### 0.4 三条规格风险的最终对账

规格 `Further Notes` 要求「验收票必须逐条给数字」：

| 风险 | 结论 |
|---|---|
| 1. 体积是设计期算术 | ✅ `_Static_assert` 钉住（`layout_store.h` 3 处 / `scene_store.h` 4 处）；真机写出最坏形态 512 步并完整读回 |
| 2. 31 KB 进 64 KB NVS 撞页擦除 | ✅ **8 轮**写满 + 真断电，零 `Event 0x81`。规格留的退路（键上限降到 8 KB + 步合并）**不需要启动** |
| 3. 64 播放头的性能与相位漂移 | ✅ **两项都已实测**：性能 800 颗 5.53 ms/轮（预算 50 ms）；相位漂移见下面 §0.7 |

### 0.5 实现期留下的裁决（与票面/规格有出入，已落进代码注释）

1. ~~相位模式固定「连续」~~ **（#158 已推翻）**：v5.0 时它只能看不能存（§10.3 的保留
   字节按契约必须为 0）。#158 改成**每部位一份、随 `LayoutPart` 最后一字节下发并写进
   blob**（部位记录 42→43、blob 版本 1→2）。现在它真的落盘。
2. **`LayoutPart` 声明段数后、`LayoutSeg` 到达前的槽位**：RAM 里标 `0xFF/0xFF`，
   只有 `LayoutCommit` 要求它们写齐。按 0/0 处理会让第二个段静默挤掉合法的段。
3. **`ScenePart` 只在 `step_count` 真变化时清步骤**：这条命令同时携带开关与循环，
   每次都清会让「点一下部位开关」抹掉整个时间轴（违反 T9）。
4. **`#155` 删掉了 v4 界面层**（`pages/strip` + 33 个测试文件）。审计过全部 40 个被删
   测试，逐条判定「行为在不在 v5」，把仍在的补回（`delete-device` / `loop-mode` /
   `mock-session` / 页面级用例等），用例数 796 → 1074。

### 0.6 下一步从哪开始（v5 已完成，别按旧指令走）

**旧版这里写的是「`gh issue view 156` 拿票面然后开工」——#156 早已关闭，别再照做。**

v5 已合入 master，规格父票 #145 已关闭。剩下的事：

1. ~~review + 合 PR #163~~ **已完成**（merge commit `70cc47d`）。
2. ~~定「相位漂移」怎么算~~ **已完成**：串口调试日志 + 闭式解残差，见 §0。
3. **合 `integration/test-flow`**（第八轮遗留，一直没合），并更新
   `docs/agents/issue-tracker.md` 的「当前 effort」。

接缝笔记仍在**仓库外**：`C:\Users\13092\Desktop\项目\zcode\lumen-notes\v5\seams.md`
（命令分发链 / 持久化 / 渲染分层 / 向量机制，全带 `file:line`）。

---

## 0.0 2026-11-06 第十轮：无分区全黑 + 按亮度叠加（**已完成，待合入**）

用户拿真机试出来的四个现象，根因只有两处：

1. **零活动段时渲染层整条铺 `state->r/g/b`**（`led_render.c` 的 v1 单色回退）。
   默认暖白 255,180,120 在 WS2812B 上就是「黄」；而 `state_summary_apply` 又把
   strip0/seg0 层0 的 hue+sat 反算进 State——于是「改一组的颜色」「调一组的饱和度」
   等于改那个全局兜底色，**所有没分区的带一起变**。
2. **两层叠加默认 `blend = 0x00`（覆盖）**。流星的黑像素整片盖掉背景，
   所以「彩虹打底 + 流星」看不见彩虹。

修法：

| 改了什么 | 落点 |
|---|---|
| 删掉单色回退：零分区 = 全黑（§9.3 第 2 条） | `led_render.c::compose_frame`；`script_scope.c/h` 删 `lumen_scope_uses_segments`；`led_strip_owner.c` 删无调用方的 `push_frame` |
| 零分区时 State R/G/B 报 `0,0,0` | `led_engine.c::state_summary_apply` |
| 新增 `blend = 0x03`「按亮度叠加」 | 契约 §7.2.1 + 向量 + `effects.h/c` 的 `LUMEN_BLEND_LUMA` + 两端常量 |
| 界面只有一种叠加方式，删「混合方式」行 | `advanced-layers.ts`；`effect-panel.ts` 的 `OVERLAY_BLEND_OPTIONS` |
| 两层拆成两张独立卡片，配置项与简单档完全一致 | `strip.wxml` 的 `effect-controls` 模板（三处共用）；`SLIDER_KEYS` / `CHOICE_KEYS` 并集表 |
| 九张成品卡退役，读回直接还原完整参数 | `strip-simple.ts`；`simple-effects.ts` 加 `PANEL_TYPE_OF_EFFECT` 桥 |
| 每个滑块按参数含义上色（饱和度灰→当前色等） | `effect-panel.ts::sliderTrack` + `strip.wxss` 的 `.track-wrap` |
| 心跳加单 / 双脉冲开关 | `EffectParams.doublePulse` + `CHOICE_KEYS.heartbeat` |
| 选「空」= 清掉这条带的全部实时分区 | `strip.ts::clearQuick`（**不写 OFF 分区**） |

### 验证（两条腿，都不靠摄像头）

| 腿 | 结果 |
|---|---|
| 真机探针 `scripts/probe-layer-fixes.py` | **8/8**；含「断开重启后仍是 `rgb=0,0,0`」 |
| 真机回归 `scripts/probe-v4.py` | **43/43**，零回归 |
| 模拟器 `scripts/simulate-strips.py` | **32/32**，含 `over-blend` 对照组 |
| 固件 host / 小程序 / 后端 | 14163 断言 / 1858 用例 / 140 用例 |

证据：[`evidence/layer-blend-fix-2026-11-06.md`](evidence/layer-blend-fix-2026-11-06.md)。

### 摄像头为什么被放弃（**不要再试同一条路**）

`verify-scope-camera.py` 这套工具依赖 `.scope-boxes.json` 的采样框，而采样框依赖机位。
本轮实测只点亮 strip 0 时，画面里只有一个小光点（`.layout-shots/layout-0.png`）——
摄像头根本没拍到灯带本体。用拍不到灯的设备做「肉眼验收」只会得到噪声。

取代它的是 `scripts/simulate-strips.py`：在宿主上编译**固件真实的渲染代码**
（`effects.c` / `segment_store.c` / `gamma.c` / `led_render.c`），把 8 条灯带的逐颗像素
画成图片。像素与真机逐字节同源。它证明不了色域压缩 / 压降 / RMT 时序，这三项仍需真机。
详见 [`simulator.md`](simulator.md)。

### 这一轮踩到的两个工具坑

- **`cv2.imwrite` 写不了含中文的路径**（本仓库有 `项目`）。它静默返回 `False`、
  一个字节都不写，表现是「断言全绿但一张图都没有」。用 `cv2.imencode` + Python 文件对象。
- **模拟器的 JSON 层不能用 `lumen_effect_layer_t` 承接**：那是 9 字节线上编码，
  与「解析出来的 int 字段」布局不同，强转会静默错位（表现为「彩虹层被拒，result=0x01」）。

---

## 1. 2026-11-05 第九轮：进阶灯效的方案作用域与自动下发（**已完成，未合入**）

**规格 [#120](https://github.com/sishoui/light-matt/issues/120)，六张实现票 `#121`–`#126`。**

### 为什么改

进阶档有两个用户可见的坏行为，都在真机上复现过：

1. **改了东西灯带不动**。#96 删掉「应用并播放」后只有循环三档还在写设备，
   选灯效 / 划分区 / 调参数 / 改时长全部只进本地草稿，失败原因也从不显示
   （`applyError` 有二十处赋值、wxml 里零处显示）。
2. **调一条灯带会波及别的带**。固件只有一份播放头、一个 `stage_index`，
   一套方案给所有带铺内容；App 又用 `fillOtherStripSlices` 把别的带读回来
   塞进同一份方案，等于把它们绑上同一条时间轴。而它读回的是**静态存储**，
   播放中的画面在阶段存储里、协议读不回来——补的永远是陈旧数据。

### 交付了什么

| 票 | 内容 | 落点 |
|---|---|---|
| #121 | 随机闪烁不再下发成常亮 | `effect-panel.ts` 补 `case "flicker"`；新增密度滑块与 `density` 字段 |
| #122 | 方案只驱动它包含的带，其余继续渲实时分区 | 新模块 `firmware/main/script_scope.c`；`led_engine.c` 逐条按归属合成渲染源；`compose_frame` / `compose_strip` / `tdm_push_strip` / `snapshot` 各加一个 `script_mask` 参数 |
| #123 | 删掉「补齐其它灯带」 | 删 `plan-fill.ts` 与其单测、方法的 import；方案只含用户编辑过的带；`session.lastDownloadedScript` 让测试能断言方案内容 |
| #124 | 先传方案再停播 | `applyAdvanced` 重排：上传 → 停播 → 写回落画面 → 开播 |
| #125 | 改动自动下发 + 失败可见 | `scheduleAdvancedApply(immediate)` + `advancedEpoch` / `advancedQueued` / `advancedBusy`；`applyError` 在 wxml 顶部渲染；删死代码 `onApplyAndPlay` |
| #126 | 端到端验证与证据 | `scripts/verify-scope.py` / `verify-scope-camera.py` / `calibrate-scope-boxes.py`；证据见下 |

### 实测数字

| 项 | 结果 |
|---|---|
| 固件 host | **14127 断言**（117 桶 + 4 新桶），比上轮 +131 |
| 小程序单测 | **1861 用例 / 72 文件**（`plan-fill.test.ts` 的 11 条随模块删除） |
| 后端单测 | 140 用例（本轮未改动，随日常跑） |
| 字节契约 | `probe-v4.py` **43/43**；93 条向量原样通过 |
| 真机 e2e | BLE 层 **21/21**（66s） |
| #121 真机读回 | `0x07` / period 1000 / p5 128（修复前 `0x00` / period 0） |
| #124 窗口 | 上传 14 帧 = 420ms（30ms/帧）→ 停播到开播 **一帧** |

证据归档：[`docs/evidence/advanced-scope-2026-11-05.md`](evidence/advanced-scope-2026-11-05.md)。

### 本轮踩到的两个方法论坑

1. **BLE 逐帧轮询抓不到「闪一下就恢复」。** 单发 `QUERY_STATE` 是 16Hz，批量
   连发也只到 33Hz，而固件是 20fps——只存在一帧的瞬态正好落在采样间隙里。
   最后靠**固件串口每帧打一行**（掩码变化时才打）拿到帧级无遗漏的证据。
   任何「瞬态」类验收都该先想清楚采样频率和被测帧率的关系。
2. **相机分不开靠得近的灯带。** 这台机位下 s2 与 s0 的采样框重叠 56%、s4 重叠
   62%；把 strip0 调暗，其余七条的读数也各掉 7~39（光学串扰）。所以「逐带亮度
   阈值」这条路走不通——改用**同内容对照**（两阶段 strip0 输出相同像素，只换
   渲染源），差值必须 ≤0.41 才算无关。细节见证据文档 §3。

### 遗留

1. **`integration/test-flow` 仍未合入 `master`**（上轮遗留，与本轮无关）。
2. `scripts/calibrate-scope-boxes.py` 产出的 `.scope-boxes.json` 绑定机位与
   分辨率，是本地产物（已 gitignore）；换机位必须重跑标定。
3. 单步方案下 `loop=1` 与 `loop=2` 行为雷同（#120 的 Q4，已知，不在本轮范围）。
4. 电气耦合（8 带共用 5V 的电流阶跃）是物理限制，本轮缓解了触发源但没解决，
   已写进 [`pending-tasks.md`](pending-tasks.md) §0.0。

---

## 2. 2026-11-05 第八轮：测试流程改造（**在集成分支，待 PR**）

**规格 [#102](https://github.com/sishoui/light-matt/issues/102)，九张实现票 `#103`–`#111` 全部关闭。**

### 为什么改

不是覆盖不足——四层加起来早已过万条断言。问题是**数字没有来源**：文档里的测试基线
全是人手抄的，同一事实出现过 4–5 个不同的值，`handoff.md` 一份文件里一处说真机跑完了、
另一处说一项没跑。加上两个「悄悄消失」：固件入口在 node 缺失时静默成功退出；渲染回归
脚本住在被 gitignore 的目录里，换台机器 clone 下来就没了。

### 交付了什么

一条命令跑完，产出一份能自证的报告，报告成为所有测试数字的唯一来源。

| 票 | 内容 |
|---|---|
| #103 | `docs/test-manifest.json`：五层定义 + 81 个测试文件的中文覆盖说明；查漏脚本，五类问题全列，自带变异测试 |
| #104 | `scripts/test-run.mjs`：三态语义（SKIP 不影响退出码）、六段报告、双写 md/json |
| #105 | 小程序与后端层接入：用例数来自 vitest JSON，逐文件可见；tsc 失败计入该层 |
| #106 | `scripts/verify-v5.mjs` 入库（原在 `.auto/`，未跟踪）；`--probe` 走真握手 |
| #107 | 真机层复用 `drive.mjs` 的 doctor 与退出码语义；用例数取 vitest 的实际收集数，不手抄 |
| #108 | 固件按测试函数输出 `TESTCOUNT`，117 个桶加总 = 13996；node 缺失输出 `SKIPPED` 标签 |
| #109 | 差异节：只比本轮跑了的层，比用例数、标新增/消失文件与新失败新跳过 |
| #110 | `--release`：未覆盖警告顶置、目录可排序且唯一、基线池与日常分开 |
| #111 | 新增 `docs/testing.md`；`AGENTS.md` 压成指针；全仓旧数字改指针 |

### 实测数字

| 层 | 状态 | 实测 |
|---|---|---|
| 固件 | ✅ | 13996 断言（117 桶）+ 93 向量 |
| 小程序 | ✅ | 1834 用例 / 71 文件 |
| 后端 | ✅ | 140 用例 |
| 渲染回归 | ⏭️ SKIP | 49 断言脚本已入库；**本机开发者工具服务端口未开，这一层没跑** |
| 真机 e2e | ✅ | 16/16，66s |
| 清单查漏 | ✅ | 81 个测试文件全登记 |

发布级归档：`docs/evidence/test-runs/2026-11-04T19-31-31-415/`，顶部标注「本轮发布未覆盖：渲染回归」。

### 遗留

1. **49 项渲染回归没在本轮复跑。** 需要在开发者工具里开「设置 → 安全设置 → 服务端口」，
   然后 `node scripts/test-run.mjs ui` 补一次。
2. **删 worktree 时 `rmdir` 会顺着 junction 清空主仓库的 `node_modules`**（本轮踩了四次）。
   正确做法：先 `git worktree remove`，再用 `cmd /c rmdir` 删 junction，不要反序。

### 已修的真问题（值得记住的坑）

- `verify-v5.mjs` 设备页 URL 的 MAC 编码写成 `%3E`（那是 `>`），解码成 `A4:CF:12:9B>:01`，
  页面走「没有连接记录」分支——那几条断言验的不是它声称的入口
- `--probe` 只测 TCP：TCP 通 ≠ 自动化可用，probe 说「可连」而 run 立刻 SKIP
- `automator.connect` 无超时：半开端口会让探针挂死
- 层执行器不兜异常：任一层抛错就整轮无报告
- Windows 上 `core.autocrlf=true` 会把 `scripts/*.mjs` 签出成 CRLF，vitest 报
  `SyntaxError` 且指向 importer——已加 `.gitattributes` 固定 LF

---

## 3. 2026-11-04 第七轮：小程序 UI / 交互第五轮（**已合入 `master`**）

**规格 [#85](https://github.com/sishoui/light-matt/issues/85) + 12 张实现票 `#90`–`#101`。**
本地副本 `.scratch/ui-v5-spec.md`、`.scratch/ui-v5-tickets/`。

### 交付了什么

| 票 | 内容 | 落点 |
|---|---|---|
| #90 | 雾蓝换色 + 主题全局同步 | `app.wxss` / `theme.ts` / `page-theme.ts`；四个断点全修（home、device 的 `onShow`、nav-bar 的 `pageLifetimes`、tabBar 的 `refreshTheme`） |
| #91 | 删除语义 + 电源键反馈 + 灯效延迟 | `delete-device.ts`（六处清理 + 演示删除标记）/ `mock-deleted.ts`；首页 `powerHint`；`writeQuick` 的权威选中与排队 |
| #92 | 发现页清单 + 添加表单 | `pages/discover` + `add-device.ts`（过滤 / 预填 / 已添加判定） |
| #93 | 首页重构 | `home-actions.ts`（搜索 / 五项菜单 / 300ms 亮度防抖） |
| #94 | 设备页精简 + 灯组元数据 | `strip-meta.ts`（键 `deviceKey#stripId`，默认名与取模占位图） |
| #95 | 灯珠数拨盘 + 固定三套方案 | `strip-head.ts`（刻度 / 角度换算 / 三圆按钮） |
| #96 | 一行式灯效 + 立即生效 | `simple-effects.ts`（八个灯效）；`writeQuick` 改成「停播 → 写 → 静默下发 → 恢复」 |
| #97 | 分区改名 + 预览条 | 全仓 `光区 → 分区`；`zone-preview.ts`（逐颗颜色映射） |
| #98 | 协议 + 固件扩展 | 流星密度与实色拖尾、随机闪烁 `0x07`、循环三值；向量 78 → **93** 条，断言数同步增长 |
| #99 | 时间轴 + 步骤气泡 + 循环三档 | `step-bubble.ts`；`ScriptDraft` 新增可选 `name` / `loop` |
| #100 | 两层模型 + 八个灯效清单 | `advanced-layers.ts`；`effect-panel` 增加 `flicker`，混合只剩两种 |
| #101 | 修跨灯组串扰 | `plan-fill.ts`（下发前补齐其它灯组切片，读回失败就不发） |

### 本轮踩到的三个新坑（都已修，写在这里免得再犯）

1. **`Component()` 和 `Page()` 一样不保证对象字面量上的非 `data` 字段落到实例上。**
   nav-bar 原来想用 `this.themeListener` 存监听器，运行期是 `undefined`。
   改成**模块级集合**跟踪活着的导航栏，事件回调再逐个通知。
2. **WXML 不支持动态事件名**（`bindtap="{{cond ? 'a' : ''}}"`）。
   `app-config.test.ts` 会拦住它；正确做法是绑死处理器、在处理器里判断可用性。
   本轮在灯组菜单的「移除封面」上踩过一次。
3. **写设备期间不能靠「回读」定选中态**。回读是迟到的覆盖：用户在一次往返里
   已经点了别的卡，回读结果会把它改回去。修法是成功后**用刚发出的内容渲染**，
   只有失败才回读。

### 验证

- 固件 / 小程序 / 后端：三层全绿（`node scripts/test-run.mjs`）。数字不抄在这里，
  以最近一次报告为准，见 [`docs/testing.md`](testing.md)。
- 模拟器：`scripts/verify-v5.mjs` 全部通过（编进 `ui` 层）。
- 真机：**已完成**（`Lumen-5662`，8 条灯带）。循环三档 **8 带 × 3 模式 = 24/24**，
  流星密度与实色拖尾的标志位均被设备接受，随机闪烁在密度 32/64/96 三档上机。
  记录见 [`docs/evidence/real-device-v5-2026-11-04.md`](evidence/real-device-v5-2026-11-04.md)。

### 真机验收（已全部覆盖）

- 循环三档：**8 带 × 3 模式 = 24/24**；`loop=2` 另有 8s 长窗证明「原地重播」。
- 流星密度：**1/2/3/4 四档全部上机**，`0x00`/`0x04`/`0x08`/`0x0C` 写入并读回一致。
- 流星拖尾：`0x00`（衰减）与 `0x02`（实色）均被接受；bit4 保留位仍被拒（`0x10` → `InvalidParam`）。
- 随机闪烁：密度 16/128/240 三档上机、读回一致；确定性由固件单测锁住。
- `scripts/probe-v4.py` 整份 **43 / 43 通过**。

> **流星密度的编码**：`heads = ((flags & 0x0C) >> 2) + 1`，所以 `0x00`=1 头、
> `0x04`=2 头、`0x08`=3 头、`0x0C`=4 头。早先文档把 `0x04` 写成「1 头」是读反了。
>
> **烧录即断崖**：刷这版固件后设备配置回默认值（与历次协议升级一致）。

---

## 4. 2026-11-03 第五轮：UI 重构 + 协议 v4（**已完成**，集成分支 `integration/ui-refactor-v4`）

**规格 [#60](https://github.com/sishoui/light-matt/issues/60) + 9 张实现票 `#61`–`#69` 全部落地。**
本地副本：`.scratch/ui-refactor-v4-spec.md`、`.scratch/ui-refactor-tickets/`、裁决在
`../ui-refactor-notes/decisions.md`。

### 交付了什么

| 层 | 变化 |
|---|---|
| 导航 | 底部两 tab 改为 **设备 / 我的**；发现页降为二级页（只有扫描）；新增**灯组详情页** `pages/strip` |
| 设备页 | 只留名称 / 状态 / 总闸 / 全局亮度 / **灯组两列卡片** / 设备摘要；编辑控件全部搬走 |
| 灯组页 · 简单档 | 六张成品卡（`warm/breathe/rainbow/comet/ice/violet`）+ 色相 / 饱和度 / 亮度三滑块 |
| 灯组页 · 进阶档 | 时间轴（比例块、300ms 长按抬起跟手重排、≤8）→ 时长条（0.5–30s）→ 光区轴（未覆盖灰条、≤8）→ 效果面板（四类型参数整体替换）；灯珠方格只在弹窗里 |
| 协议 v4 | 层编码 **9 字节**（新增 `level` 0–100）；呼吸 `p5` 改**相对百分比**；State blob 版本 **5**、脚本 blob `LMS4`/v3 |

### 协议 v4 的仲裁数字（规格原文有笔误，以这里为准）

| 项 | v3 | **v4** |
|---|---|---|
| 层编码 | 8 | **9** |
| SetSegment 载荷 | 21 | **23** |
| ScriptSegment 载荷 | 23 | **25** |
| SegmentReport | 21 | **23** |
| State blob 段记录 / 总长 | 20 / 1312 | **22 / 1440** |
| State blob 版本 / 脚本 blob | 4 / `LMS3` v2 | **5 / `LMS4` v3** |
| `LUMEN_SCRIPT_SEGMENT_MAX` | 19 | **21** |

> 规格原文写的 22/24/22 少了段头里的 1 字节（`5 + 9×2 = 23`）。同一张表里 State blob
> 段记录 `4 + 9 + 9 = 22` 是对的，反证 wire 端每项都少算 1。
> 仲裁全文见 `../ui-refactor-notes/decisions.md` §1。

### 三个必须先记住的陷阱（都踩过）

1. **相对 import 不能指向目录** —— 小程序解析器不认目录 `index`，App 启动链上会**整个白屏**，
   `tsc` 与单测都发现不了。回归：`tests/module-resolution.test.ts`。
2. **`Page({})` 只保证 `data` 里的字段存在于实例** —— 写在字面量上的私有字段运行时是
   `undefined`，在 `onLoad` 链上抛错会**中断整页事件绑定**（「点什么都没反应」）。
   每个页面 `onLoad` 开头显式初始化全部私有字段。回归：`tests/page-fields.test.ts`。
3. **快捷档 / 进阶档写整组前必须先清掉该组其它光区** —— 协议要求同带光区不重叠，
   不清就回 `InvalidParam`，用户点了卡片却毫无变化。

本轮新增的第四条（**不是白屏，是功能静默失效**）：**进阶档必须下发整份方案**。
只写「当前步骤 × 当前灯组」的实时光区，固件没有 `ScriptCommit` + `ActivateScript` 就
没有播放头，第 2..N 步永远播不到、时长条对设备毫无作用——4 个方案槽位会变成纯装饰。
现在的顺序：停播 → 写实时光区（停止后的回落画面）→ `downloadScript(script, {activate:true, loop})`
→ `setPlayback(1, loop)`。回归：`verify-effect-editor.mjs` 的「设备回 stageCount === 步骤数」。

### 方案草稿落盘

「方案内容只存在这台手机上」（`PANEL_FACTS`）之前是**假话**：草稿是页面实例状态，断线即清。
现在落盘在 `lumen.planDrafts.v1`（`utils/control/plan-drafts.ts`）：

- 键 = `deviceKey#stripId#slot`（deviceKey 是 hardwareId 优先，iOS 换 UUID 不串号）；
- 写：`setDraft` 每次改动；读：`onLoad` / `onShow` / ready / 0x88 到位后各一次；
- 清：**只在用户显式删除设备时**（`pages/me` 与 `pages/device-info` 两处删除路径）；
- 坏数据逐条丢弃（结构不对的槽位 / 光区），不整表失败。
- 回归：`tests/plan-drafts.test.ts`（16 项）。

### 待办：硬件验收（唯一剩下的东西）

模拟器已全绿（137 + 37 + 26 + 40），**真机一项都没跑**：

- v4 逐光区亮度在真实灯带上的可分辨性（100 档里相邻档位看不看得出来）；
- 进阶档多步骤方案在真实灯带上的播放顺序与时长（mock 只验证到 `stageCount`）；
- v4 固件还没在 IDF 6.1 下实际编译 / 烧录过。
- 注意：**刷 v4 是断崖升级**，设备配置回默认值，脚本 blob 与 State blob 都整份拒绝旧版本。

---

## 0.1 2026-11-02 第四轮：灯效编辑重构（**已完成**，分支 `feat/effect-editor`）

**6 张实现票 `#53`–`#58` 全部实现完毕并验证。** 规格与实现票落在 GitHub：

- **规格**：[#52 小程序：灯效编辑重构（快捷 / 自定义两档 + 术语重写）](https://github.com/sishoui/light-matt/issues/52)（label `spec`）
- **本地副本**：`.scratch/effect-editor-spec.md`（与 #52 同内容，离线可读）
- **6 张实现票** `#53`–`#58`，原生 blocker 边已建立，全部 `ready-for-agent`

### 为什么重构

用户看不懂现有灯效编辑。能力被拆在三处且互不相通：设备页只能改颜色、段编辑页只能手打数字、
剧本页必须先在设备页选段才能加进阶段。术语是工程语言（段/层/blend/剧本/下发/激活），
段从 0 编号而阶段从 1 编号，「下发剧本」其实还会激活，页脚还指向一个**根本不存在的「灯光页」**。

### 目标结构

**一个页面、两档能力**（设备详情页顶部开关）：

- **快捷**：6 张成品效果卡（暖白常亮 / 呼吸 / 彩虹流动 / 流光追逐 / 冷蓝氛围 / 紫色氛围），
  点一下整组立刻生效；参数只暴露人话档位（颜色、慢/中/快、微亮/中暗/全暗、短/中/长、顺/逆、彩虹饱和度）
- **自定义**：`灯效方案（4 槽）→ 步骤（≤8）→ 光区（≤8）→ 主效果 + 叠加效果 + 叠加方式`

两档切换时自定义编排以**内存快照**保留（按设备 + 灯组隔离，不落存储）。

### 依赖图与当前 frontier

```
#53 预重构：收敛光区的单一真相        ← 可立即开始（frontier）
 ├─ #54 快捷档：成品效果卡
 ├─ #55 自定义档：光区编辑（多分段）
 │    └─ #56 自定义档：方案与步骤
 ├────────┼─ #57 模式切换：保留并恢复编排   (阻塞于 #54, #56)
 └────────┴─ #58 收尾：术语 + 删旧页 + 设备页收窄  (阻塞于 #54, #55, #56)
```

### 完成状态（2026-11-02）

| 票 | 内容 | 落点 |
|---|---|---|
| #53 | 收敛光区单一真相 + 下沉灯效视图 | `zone-model.ts` / `effect-view.ts`；`segment-editor` / `segment-view` / `quick-effects` / `segment-shapes` 全部委托 |
| #54 | 快捷档成品效果卡 | `pages/device` 的「快捷」档；`quick-effects` 的 `buildQuickCardViews` / `buildQuickPanel` |
| #55 | 自定义档光区编辑 | `zone-editor.ts`（拖动划选 / 切分 / 增删改）+ 灯珠条 UI |
| #56 | 方案与步骤 | `plan-editor.ts`（4 槽 × 步骤 ≤8 × 光区 ≤8，复用 `script-view` 草稿） |
| #57 | 模式切换快照 | `effect-mode.ts` 快照扩展为完整四级编排（**第五轮已删除**：新编辑模型没有第三档） |
| #58 | 术语统一 + 删旧入口 | 删 `pages/scripts` 与 `pages/segment-edit`；tabBar 只剩两项 |

**两个必须记住的实现细节**（都是真机会踩的）：

1. **快捷档写整组前必须先清掉其它光区**。协议要求同带光区不重叠，而快捷档的语义是
   「整组变成这一个效果」——多光区灯组不清就写会被设备回 `InvalidParam`，
   用户点了卡片却毫无变化（`device.writeQuick`）。
2. **灯珠数必须逐灯组取**（`state.stripCounts[stripId]`），**不能**用 `state.ledCount`
   ——后者按协议只是 strip 0 的派生值。多灯组设备每组长度不同（演示设备就有 60 与 24），
   取错会让拖动落到不存在的灯珠、切分产出越界区间。页面统一走 `stripLedCount()`。

**测试与验收（本轮实测）**：

```bash
cd miniprogram && npx vitest run                 # 全绿
cd miniprogram && npx tsc --noEmit               # 干净
cd miniprogram && node .auto/check-bindings.mjs  # 零缺失
cd miniprogram && node .auto/verify-effect-editor.mjs   # 已作废，改跑 scripts/verify-v5.mjs
```

> 这一轮的 `verify-redesign.mjs` / `verify-deep.mjs` / `verify-ui-interaction.mjs`
> 都已作废（锁的是已删除的页面）；「点得动」的意图并入 `scripts/verify-v5.mjs`，
> 见 [`docs/testing.md`](testing.md)。

那一轮的 `verify-effect-editor.mjs` 锁的是**只有渲染层能发现**的几件事：点卡片后设备状态真的变、
参数区只显示该卡的档位、均分切分互不重叠、切档后编排完整恢复、界面零协议词、两 tab。
这几条现在由 `scripts/verify-v5.mjs` 守着。

> **`.auto/verify-ui.mjs` 已删除**（它的目标页面 `pages/scripts` / `pages/segment-edit`
> 已删除且跑必失败）。`utils/control/effect-mode.ts`（快捷↔自定义内存快照）与
> `utils/control/strip-chips.ts`（旧灯带切换器派生）也已随第五轮重构删除：新的编辑模型
> 只有「简单 / 进阶」两档，不再有需要快照保护的第三档。

### 已完成的地基（重要：别重写）

两份**纯逻辑模块已实现并通过 53 项单测**，是 #54/#55/#57 的直接依赖：

| 模块 | 内容 | 测试 |
|---|---|---|
| `utils/control/quick-effects.ts` | 6 张卡定义、档位 → 协议值（含彩虹饱和度）、整组 spec 构造、从设备值反推卡片 | `tests/quick-effects.test.ts`（20） |
| `utils/control/effect-layout.ts` | 区间校验、重叠拦截、整条/前半/后半/均分切分、逐灯珠归属 | `tests/effect-layout.test.ts`（33） |

**新会话不要重新设计这两层**，直接从 #53 开始接线。

### 几个必须知道的协议陷阱（写进了规格，实施时别踩）

1. **方案播放期间实时光区不可见**：固件按 `active_segments` 渲染，`SetSegment` 仍写 `s_segments`
   但不参与出光。所以快捷档点卡片时必须先 `SetPlayback(stop)` 并提示，否则用户点了看不到变化。
2. **步骤里的光区是快照副本**：改实时光区不影响已存在的步骤（协议如此，不是 bug）。
3. **方案内容无法从设备读回**，只有 4 字节摘要。本地草稿是唯一记录，界面必须如实说明。
4. **快捷档的实时写入依赖 `SetSegment` 是绝对值命令**（重复下发只覆盖自己），所以防抖重发安全。
5. 静态层的 `period/p5/flags` 必须为 0；呼吸周期 ≥334ms、动画 ≥200ms——否则设备回 `InvalidParam`。

### 本轮已完成的其它工作（同工作区，未提交）

- 小程序 UI 改版：苹果极简双主题、大卡首页 + 设备小图、灯光页并入设备详情、发现页、自建 tabBar / nav-bar
- 演示模式（mock）：`mock-transport` + `mock-devices` + `mock-mode`，与真机同构
- 设备自定义封面：用户相册选图存本地，按 hardwareId 隔离
- 新增测试：`app-config` / `theme` / `home-view` / `mock-mode` / `mock-session` / `device-photo` / `page-fields`

**当轮基线**：小程序单测全绿（数字以最近一次报告为准，见 [`docs/testing.md`](testing.md)）；
`npx tsc --noEmit` 干净。

> **工作区未提交**：58 个文件改动 + 28 个新文件。新会话开始前请先确认这些改动是否已提交，
> 否则 `git checkout` 类操作会丢掉整个 UI 改版。

---

## 0.1 2026-11-02 第三轮：小程序 UI 改版（苹果极简 + 大卡首页）


**做了什么**

- **页面树重建**：`home`（大设备卡 + 下方设备小图）/ `scripts` / `devices`（改为「发现」）
  三个 tab；`device`（原「灯光」页并入，成为设备控制页）与 `device-info` /
  `segment-edit` 是二级页。**`pages/light` 已删除**，灯光控制全部在 `pages/device`。
- **双主题**：`app.wxss` 引入 CSS 变量，浅色默认、深色跟随系统，并可在「发现 → 外观」
  手动覆盖（存储 `lumen.theme.v1`）。所有页面 wxss 的硬编码 hex 已替换为变量。
- **自建导航栏与 tabBar**：`components/nav-bar`（大标题 + 状态栏/胶囊避让）、
  `custom-tab-bar`（3 项，图标纯 CSS）。`app.json` 全部 `navigationStyle: custom`。
- **演示数据（mock）**：`utils/ble/mock-transport.ts` + `utils/control/mock-devices.ts`
  + `utils/control/mock-mode.ts`。**与真机同构**：连接走 `ready`、State 由命令真实改变、
  `QueryStrip` / `QueryStripConfig` / `QueryDeviceInfo` 都给出设备权威形状。
  会话层没有任何 mock 分支。

**交互契约（改首页前先读）**

- 点**小图** = 只切换大卡展示，**不发起连接**（小程序只有一条连接）；
- 点**大卡** = 进 `pages/device`，连接发生在那里（已连别的设备走 `switchTo`）；
- 大卡上的**电源键**是 `catchtap` 快捷开关，未连接时先连上。

**验收（本轮实测）**

| 项 | 结果 |
|---|---|
| `npx vitest run` | 全绿 |
| `npx tsc --noEmit` | 干净 |
| `node .auto/verify-redesign.mjs` | 当轮 28/28（脚本已作废，意图并入 `scripts/verify-v5.mjs`） |
| 截图 | `.auto/shots/`（浅色 + 深色各页） |

**改页面后必须做的三件事**：跑 `tsc`、跑单测、跑渲染回归。后两者分别覆盖
「TypeScript 看不出的运行时问题」和「只有渲染层能发现的问题」
（白屏、bindtap 全失效、主题 class 没挂、tabBar 没渲染）。现在一条命令搞定：
`node scripts/test-run.mjs mp ui`。

> **一个本轮踩到的坑**：自定义 tabBar 是 `position: fixed` 的，tab 页内容必须自己
> 让出 `padding-bottom: calc(140rpx + env(safe-area-inset-bottom))`，否则底部内容
> 被压在 tabBar 下面（截图才看得出来）。

---

## 0. 2026-11-02 第二轮：设备侧验收全部跑完

**新增 `scripts/probe-v3-deep.py`，69/69 通过。** 它把原先笼统记成
「需小程序真机」的项拆成「设备侧」与「UI 侧」两半，把设备可判定的部分全部验了：

| 组 | 结果 |
|---|---|
| §1.1 逐带独立 | `QueryStrip` 与 `seg_counts` 逐带真实，设一带不动别带 |
| §1.2 每带开关 | `pmask` 位翻转、其余带动画继续、串口「已推黑帧」、重开不需重设段 |
| §1.4 区间/重叠 | 重叠/越界/非法 blend 全被拒且**旧配置逐字节不变** |
| §1.5 剧本 | 4 套摘要独立、4 阶段推进 ±300ms、断连 5.4s 后 stage 0→1 |
| §1.6 过大 | 第二套回 `0x0A`、**回滚保留原剧本**、上一套仍可播放 |

**§2.1 的 400s 也跑完了**：8200 帧/410s = 20.0Hz、非 0 ACK 0 次、录像 2215 帧、
**0 事件** —— 但只判定 **5/8 条带**（strip 1 只有 2 颗灯，strip 2/3 噪声超门限）。

**证据归档在 [`docs/evidence/`](./evidence/)**（本轮新建）：
- `README.md` —— 索引、SHA-256、§4.5 配置丢失记录
- `deep-probe-2026-11-02.md` —— 69 项逐条实测
- `stability-400s-2026-11-02.md` —— 400s 数据 + 跨会话基线反例
- `visual-acceptance-2026-11-02.md` —— **观感项相机实测（替代人眼）**
- `ui-acceptance-2026-11-02.md` —— **微信开发者工具自动化 UI 验收（19/19）**
- `real-device-e2e-2026-11-02.md` —— **真机 BLE 全链路 8/8（无需手机）**

**§1.1–1.8 的 38 项现在是 ✅ 33 / ◐ 0 / ☐ 0**（§1.7 多设备 5 项已决定不作验收，
38 − 5 = 33；口径见 `acceptance-v3.md` §5.1）。**验收项全部闭环。**

### 0.000 一个必须记住的教训：目录导入会让整个小程序白屏

`miniprogram/utils/control/session-singleton.ts` 原本写 `from "../usage"`（目录导入）。
TypeScript 能解析到 `index.ts`，`tsc --noEmit` 干净、全部单测通过、
`cli preview` 也能成功构建 —— 但**小程序的运行时模块解析器不认目录 index**，
抛 `module 'utils/usage.js' is not defined`。它位于 App 启动链上，一崩则
**所有页面 `Page()` 都不执行，整个小程序白屏**。

已修（改 `../usage/index`）并加回归测试
`miniprogram/tests/module-resolution.test.ts`（变异验证过：改回缺陷版会红）。

> **教训**：`tsc` 干净 + 单测全绿 + 构建成功，都不足以证明小程序能跑。
> 模块解析层的问题只有模拟器/真机能发现。

### 0.0001 2026-11-02 第三个「只有模拟器能发现」的缺陷：页面私有字段是 undefined

**现象：设备页点「扫描」「连接」「取消」全都没反应**（模拟器实测，页面能渲染出来）。

控制台真正的报错（红色，容易被上方的黄色 warning 淹没）：

```
TypeError: Cannot read properties of undefined (reading 'length')
    at ui.applyListViews (devices.js)
    at ui.refreshLocal (devices.js)
    at ui.onLoad (devices.js)
```

**根因**：微信的 `Page({...})` 只保证 `data` 里的字段出现在 `this.data`。
写在对象字面量上、但**不在 `data` 里**的私有字段（`remoteDevices: [] as X[]`
这类）不保证被复制到页面实例，运行时就是 `undefined`。TS 断言只是编译期语法。

`onLoad` → `refreshLocal` → `applyListViews` 读 `this.remoteDevices.length`
直接抛错，**页面初始化中断，所有 `bindtap` 都不再响应**。构建、`tsc`、当轮全部单测
都绿——因为单测直接 `new ControlSession`，根本不经过 `Page()`。

**修复**：五个页面的 `onLoad` 开头显式初始化全部私有字段（且必须在任何
提前 `return` 之前，`segment-edit` 就有这种分支）。`unsubscribe` 等循环加 `?? []`。
**新增契约测试** `miniprogram/tests/page-fields.test.ts`：静态扫描每个页面，
断言非 `data` 字段都在 `onLoad` 里赋值（变异验证过：删掉初始化会红）。

> 这个契约测试自己踩过一次坑：用 `indexOf("onLoad")` 定位会匹配到**注释里**
> 的字样，把 region 截断在注释中间 → 规则永远通过（假绿）。必须匹配方法定义
> `/\n {2}onLoad\s*\(/`。

### 0.0002 「取消」曾经是假按钮，以及 `already opened` 被当成失败

两个同源缺陷：文案/状态承诺了行为，代码没做。

**1) 状态条写着「取消」，点了什么也不发生。**
`utils/control/status-view.ts` 在 `connecting` / `initializing` 显示「取消」，
而 `pages/devices/devices.ts` 的 `onStatusTap` 对这两种状态**直接 return**。
`cancelSwitch()` / `retrySwitch()` 在 `pages/` 里零调用点（死代码）。

修复：`BleTransport.cancelConnect()` 用**连接代次号**让进行中的尝试作废
（`createBLEConnection` / GATT 发现是 wx 的原子调用，**没有中断接口**，
只能让它跑完然后丢弃结果）。流水线每个 `await` 之后核对代次，变了就抛
`ConnectCancelledError` 静默退出。页面接线：`onStatusTap` 在 connecting 时
真的调 `cancelConnect()`，并提示「已取消连接」。会话层 `session.cancelConnect()`
同时清 `usageArmed` 与切换状态机。

回归测试：`tests/transport.test.ts` 的「取消连接」4 条 + `tests/session-v3.test.ts`
的「取消连接（会话层）」2 条；变异验证过（去掉 `connectEpoch += 1` 会红 3 条）。

**2) `openBluetoothAdapter: fail already opened` 被当成失败。**
适配器**已经打开**是成功状态，但代码只认 `errCode === 10001`，把它落进
`fail` 分支并清掉 `scanRequested` → **扫描永远起不来**。热重载后必现
（新模块实例的 `adapterOpened` 是 false，底层适配器还开着）。

修复：`isAdapterAlreadyOpened()` 匹配 errMsg（这个错误**不带 errCode**）。
回归测试：`tests/transport.test.ts`「适配器已打开」2 条，变异验证过。

### 0.0003 模拟器验不了的：真实 BLE 连接

开发者工具的模拟器**没有 BLE 外设**：`openBluetoothAdapter` 会超时、
`createBLEConnection` 立即失败，扫描也扫不到真设备。所以：

| 要验什么 | 用什么 |
|---|---|
| 真实扫描 / 连接 / 控制 | `npm run test:ble`（PC 蓝牙网关，用例数看实际收集数）或手机真机预览 |
| 页面交互是否「点得动」 | `miniprogram-automator`（现在统一在 `scripts/verify-v5.mjs`） |
| 取消逻辑 | `.auto/verify-cancel-stub.mjs`（在页面上下文给 `createBLEConnection` 打桩让它悬住） |

> **automator 每次跑之前要重新编译**，否则连的是旧代码（变异测试会假绿）。


### 0.00a 本轮最重要的方法论结论：基线不能跨会话

第一次 400s 用了上一会话的基线，判出 **58 个错色事件 / 87 次每 10 分钟**。
逐帧复核证明是**整幅画面漂移**：每一条带的亮度都涨了 12%~60%、
色相按位置偏移 0.1°~35.7°，而带内自身抖动 p99 只有 7.8°（`>28°` 的帧 **0 个**）。
重录「基线 → 紧接压力段」后即 0 事件。

**所以：`analyze-strips-video.py` 的 `--reference` 必须是同一次会话、紧邻录的。**
这也解释了「两组录像亮度差 31%」那条已知限制的实际影响 —— 它足以让判据翻转。

### 0.00b 三端测试基线

**数字不写在这里**：跑 `node scripts/test-run.mjs`，看最近一次报告（`.reports/`）。
怎么跑、分层依据、报告格式见 [`docs/testing.md`](testing.md)。

```bash
cmd.exe //c "firmware\test\run-tests.cmd"
cd miniprogram && npx vitest run
cd miniprogram && npm run test:ble
cd miniprogram && npx tsc --noEmit
cd server && npm test
cd server && npm run typecheck
```

这一轮在四条命令之上还补了 4 组用例：取消连接、会话层、`already-opened` 回归、
页面私有字段契约。补了多少条看当轮报告。

---

## 0. v3 已实现并已在真机跑通协议层，剩真机人眼验收

**11 张实现票（#36–#45）全部合入 `integration/lumen-v3`，HEAD `aa9cf23`（未推送）。**
固件已编译、已烧录、协议层 47 项真机验证全过。**#46 保持 open**，只剩需要人眼/手机的部分。

| 端 | 测试基线 |
|---|---|
| 固件 host | `cmd.exe //c "firmware\test\run-tests.cmd"` |
| 小程序 | `cd miniprogram && npx vitest run`；`npx tsc --noEmit` 干净 |
| 后端 | `cd server && npm test`；`npm run typecheck` 干净 |

> 当时的实测数字在 `docs/acceptance-v3.md` 与 `docs/evidence/` 里；**当前基线**看最近一次
> 测试报告（`node scripts/test-run.mjs`，见 [`docs/testing.md`](testing.md)）。

**已完成（不需再做）**

- 固件在 **IDF 6.1 下编译零错误零警告**；app 分区余量 87%、NVS 64KB、DRAM 余 118KB
- 烧录到 COM6（哈希校验通过），启动日志确认 `TDM: 8 条灯带, pins=3,10,0,1,4,5,6,7`
- **协议层 47/47**（`python scripts/probe-v3.py`）：State 37B / StripConfig 24B /
  DeviceInfo 15B / 每带开关 / 两层三种 blend / 非法段拒绝 / 真实槽位 / 剧本全流程
- **真机抓到并修掉一个 P0**：`ScriptCommit` 栈溢出（见 0.4）
- 断电重启后 `ScriptSummary` 仍报 stages=1 → blob v2 跨断电存活
- **视觉验证（GPIO 6 那路，8×4 矩阵板 30 颗）**：单色 / 呼吸 / 两层叠加全部实拍确认

**未完成（#46 剩余，2026-11-02 第二轮更新）**

设备侧与所有观感项已验完（见本文件 §0）。剩 5 项都在手机屏幕上：

| 章节 | 项数 | 内容 | 为什么还没做 |
|---|---|---|---|
| §1.4.1–1.4.3 | 3 | 段重叠 / 越界 / 周期下限的**提交前提示** | 设备侧已证会拒，客户端有单测；**提示文字未看** |
| §1.6.1 | 1 | 剧本过大**发送前**提示 | 设备侧已证 `0x0A`，客户端预检有单测；**提示文字未看** |
| §3.6 | 1 | 小程序协议日志面板 | `log-panel.test.ts` 已覆盖逻辑；**面板未在真机打开过** |
| ~~§1.7~~ | ~~5~~ | ~~3 台设备来回切、断网启动、后端 500~~ | **2026-11-02 决定不作验收**（只有 1 台设备，多设备非当前目标） |

> 这 5 项的客户端逻辑都由单测锁死，设备行为也全部验证过。差的只是
> 「文字在手机上显示正确」。**一次真机预览约 10 分钟可全部点完。**

**观感项已全部闭环**（§1.2.2 无残影、§1.3.2 相加、§1.3.3 覆盖、§1.3.4 单层、
§1.3.5 无三层、§1.5.5 剧本两层一致、§1.5.6 无 fade）——
用相机替代人眼实测，数据见 `docs/evidence/visual-acceptance-2026-11-02.md`。

**§2.1 已跑完**（400s / 20.0Hz / 0 事件），但只判定 5/8 条带，`crosstalk` 仍不可用。
**§4 五项文档收尾全部完成**，证据在 [`docs/evidence/`](./evidence/)。

**本轮新闭环的 13 项**（2026-11-01，全部有实测数字）

| 项 | 实测 |
|---|---|
| §2.2 两层单帧耗时 | 8 带单层 11.7ms → 两层 **12.6ms/轮**（+0.95ms），远低于 50ms 预算 |
| §2.3 是否需要降帧 | 不需要，20fps 余量充足 |
| §2.4 分片重组失败 | **787 条 × 2 片 = 1574 次写，非 0 ACK 0 次** |
| §2.5 8 带 vs 4 带轮周期 | **11.7ms → 4.5~5.9ms（−52%）** |
| §2.6 BLE 写入次数 | 21B 段在 19B 片下 = 2 片/帧；MTU≥247 回到 1 片 |
| §1.8 断电恢复 | 复位后 power/亮度/**pmask 0x55**/段/**两层 blend+layer1**/2 阶段剧本**全部一致** |
| §3 协议回归 5 项 | State 37B / StripConfig / DeviceInfo / SegmentReport 真实槽位 |
| §1.1.3 / §1.3.1 / §1.2.4 | 8 带各色呼吸互不干扰；彩虹×呼吸相乘实拍；SetPower(0) 不改 pmask |

**两个可复用的脚本（本轮新写，已入库）**

- `scripts/probe-v3.py` —— 协议层真机验证，PC 当 central（当轮 47 项，之后随用例增删而变）
- `scripts/stress-fragment-v3.py` —— §2.4 分片压力，强制 19B 数据片压重组路径

### 0.00b 2026-11-01 晚：摄像头测试链重做（未完成，卡在机位）

`ble-stress.py` 是 v2 时代的代码（`0xA5/0x02`、无分片头），**对 v3 固件完全
无效** —— 发出去的帧被静默丢弃、不回 ACK，最后崩在 `f"0x{result:02X}"`。
已重写为 v3（`0xA6/0x03` + `0xC0` 分片头 + CRC16 + 固定 21B 段载荷），并加了
`isolate`（逐条隔离）与 `colorize`（8 条专属色相）两个子命令。

同一轮还查明三件必须写进验收记录的事（详见 `acceptance-v3.md` §2 开头与 §2.3）：

1. **旧基线 0.42% 作废。** 复算旧录像发现 t=210.0/210.3s 两帧是**整板均匀
   全亮**（正常只亮 8 颗），旧口径只统计「亮灯数变少」把它们漏掉了。
   这个形态最可能是 **TDM 串带**（板子吃到别的 strip 的帧），比「部分熄灭」
   严重得多。另外旧录像器按 3fps 写容器而实测 2.51fps，**时间戳快 20%**。
2. **8 条带物理长度差异极大**（2 颗到 30 颗），而固件 `State.strip_counts`
   默认报 30。实测向 2 颗那条写 `[5,5]` 段，设备回 `OK` —— 段可以指向未配置的
   灯珠。**这是合法行为，不是缺陷**：灯珠数逐带可配（`SetLedCount`，1–64，
   小程序 `device-info` 页有入口），设备无从得知实物长度，用户也不该逐颗去数。
3. **这台相机帧率与分辨率是强权衡**：1080p=2.5fps、720p=10、540p=15、
   480p=30。固件 20fps，1080p 只抽样到 12.5%。建议 640×480 @30fps。

**新工具链（自检均通过，真机标定未完成）**：

```bash
python scripts/strip-layout.py --selftest          # 逐带线段标定逻辑
python scripts/analyze-strips-video.py --selftest  # 判定逻辑（含合成注入）
python scripts/ble-stress.py show                  # 读设备状态/引脚表
```

**相机标定：已跑通一半，参数和限制如下（2026-11-02 实测）**

正确的相机参数（换补光/换机位都要重新确认）：

```
曝光 -11、增益 0、DSHOW + YUY2（不设 FOURCC）、1920×1080
LED 亮度 150（**但不能对所有带都用同一个值**，见下）
```

**三个必须知道的实测事实**：

1. **每条带照亮环境的能力差异极大。** 品红 30 颗在 brightness=150 时把整个
   房间照亮（高饱和像素占 87%），而短带几乎看不见。所以 `--isolate` 现在
   **逐带自适应亮度**：从 150 起试拍，高饱和占比超 0.5% 就逐级下调。
2. **strip 1（最上面那条）只有 2 颗灯，物理上定不出方向。** 两个孤立光点
   无法构成线段，任何算法都救不了。工具会把它标为失败并**逐条降级**——
   其余各条照常判定，不是整份拒绝。
3. **640×480 下自适应亮度失效**（光晕糊成一片，高饱和占比失真），
   目前只能在 1080p 标定。而 1080p 实测只有 2.5~5fps（640×480 能到 30fps）。
   **这是当前最大的方法论短板**：分辨率够用但帧率不足，帧率够用但标不出来。

**相机链路：已跑通首次压力验证（2026-11-02）**

实测结果：

| 环节 | 数字 |
|---|---|
| BLE 写入 | 2400 帧 / 120s = **20.0Hz 精确达标**，非 0 ACK **0 次** |
| 录像 | 665 帧 @ **5.0fps**，容器帧率用实测值（旧版快 20%） |
| 判定 | **0 事件，通过** |

**但只有 3 条带参与判定。** 8 条里 strip 1 是 2 颗灯（几何上定不出方向），
另有 4 条基线噪声超 10°，被排除而非硬判。所以这个「通过」覆盖 3 条带
（s4/s5/s6，噪声 0.3~3.0°），**不是全部 8 条**。验收记录必须写明。

**本轮修掉的三个误导源**（都会造成假事件或漏检）：

1. 法向采样只搜 ±2px：标定线常只穿过灯珠边缘，沿线亮度在
   49/1/83/136 之间跳变，色相随帧乱跳。扩到 ±6px 后噪声从数十度降到 0.3~3°。
2. 连通块剔除用绝对面积：暗带灯珠彼此不连通（15~39 像素的碎块），
   按「≥250」一筛全没。改为「最大块定方向 + 按到直线垂距收块」。
3. 基线噪声高的带被硬判：某条带基线噪声 14°、压力段抖到 114°，
   硬判刷出 25 个假事件。现在噪声超 10° 的带不参与判定。

**已知的相机硬限制（不是 bug，验收要写进去）**：

- **相机的色域被压缩**：固件色相 0°→315°，实测只覆盖 23°→279°
  （拟合斜率 0.75）。s4/s5/s6 三条带实测色相只差 0.3°——**相机分不开**。
  所以「串带检测」在当前硬件上不可用，工具已自动禁用它并提示。
- 640×480 无法标定（光晕糊成一片），只能在 1080p 标，而 1080p 约 5fps。
- 两组录像之间画面整体亮度会差 31%（曝光参数完全相同）。**基线必须
  在压力段之前紧接着录**，不能跨会话复用。

```bash
# 标定（约 10 分钟，会逐带改设备状态）
python scripts/strip-layout.py --isolate .layout-shots --exposure -11 --brightness 150
python scripts/strip-layout.py --show

# 录像 + 判定
python scripts/ble-stress.py --brightness 60 colorize
python scripts/record-board.py base.mp4 --seconds 40 --width 1920 --height 1080 --exposure -11
python scripts/analyze-strips-video.py base.mp4
```

### 0.00b 2026-11-01 夜：spec-v3 实现缺口补完（#47–#50）

**票全 CLOSED ≠ 功能完整。** 对照 `spec-v3.md` 逐章审计三端代码后，找出 4 处
「规格要求了、代码只做了一半」并已全部修复（分支 `integration/lumen-v3-gaps`）：

| 票 | 问题 | 修复 |
|---|---|---|
| **#48** | **数据丢失**：灯光页改色/预设走扁平草稿，`toSpec()` 写死 `blend=OVER` + 空 layer1，**把两层段静默降级成单层**，设备上不可撤销 | 改为基于已读回的 `SegmentSpec` 只换 layer0 的 hue/sat；无缓存先 `QueryStrip`；UI 加两层徽标 |
| **#47** | **静默失效**：小程序从不调 `wx.login`，而配了 AppSecret 的后端对缺 `code` 直接 400 → 用户只看到「同步不上」 | 接 `createWxLoginCode()`；`wx.login` 失败/`invalid_code` 显式回落 local 并给可读文案；未配 AppSecret 路径**逐字节不变**（有严格断言） |
| **#50** | 设备身份两条路径不统一：登记表用 MAC、使用日志用广播名，同一设备可能聚合成两行 | `ConnectionIdentity` 加 `hardwareId`，从 `DeviceInfoReport` 的 hw_id 取值；上报时机改为 0x88 往返后（加 pendingUsage 快照 + epoch 防串号）；后端归一化并按 MAC 聚合 |
| **#49** | §4.2 第三处修复（真实槽位）**修对了但守不住**：`led_engine.c` 根本不在 host 测试编译清单里 | 抽出纯逻辑到 `led_engine_slots.c`（无 RTOS 依赖）并纳入 host 测试，+60 项断言 |

**当轮基线**：三端全绿，`tsc` 与 `typecheck` 均干净。具体数字已过期，不再抄写——
当前值看最近一次测试报告（[`docs/testing.md`](testing.md)）。

> **验证方式值得沿用**：我对 #49 与 #48 都做了**变异测试** —— 把修复改回缺陷版本，
> 确认断言真的会红（#49 红 8 项、#48 红 7 项），再还原。这比「测试通过」可靠得多。

**已知遗留（未修，已登记）**：`setSegmentBreathing` / `setSegmentRainbow` /
`setSegmentComet` 仍走扁平草稿路径，与 #48 是同类陷阱。段编辑页直接用
`setSegment(spec)`，所以当前没有调用点；**将来给它们接 UI 时必须一起改**。

> **完整未完成清单见 [`pending-tasks.md`](./pending-tasks.md)。** 它把剩余验收
> 按「人眼观感 / 人眼看页面 / 需更多硬件」分了类，并写明相机色域压缩这个最大阻塞。
> **最新状态以本文件 §0 为准**（2026-11-02 第二轮：设备侧 69/69 全过；多设备已决定不作验收）。

### 0.00 复制这段话开新会话

```
读 docs/handoff.md 和 docs/acceptance-v3.md，接着做 GitHub #46 剩下的验收项。
先告诉我硬件现在接了几条灯带、小程序能不能真机预览，再按章节往下推。
```

新会话会自动读 `AGENTS.md`，那里已经指向本文件。**不要**让它从零探索代码库——
三端实现都已完成，它只需要跑验收。

### 0.0 下一步从哪儿开始（给新会话）

1. **先确认硬件接线**：8 条灯带已接好，**物理长度各不相同**（实测 2 颗到 30 颗）。
   §1 与 §2 都按这个事实走。
2. **先把相机机位固定好**，再跑 `python scripts/strip-layout.py --isolate .layout-shots`。
   标不出来就先别往下做 —— 分析器会拒绝不可信的布局，这是刻意的。
3. **用小程序真机预览**跑 §1 的 UI 相关项 —— 这些代码已实现且有单测，但**从未在真机上点过**。
4. **环境光**：这台相机的 GAIN 在暗环境下会被自动拉满到 255，`set(CAP_PROP_GAIN, 0)`
   之后才拍得清。曝光档位随补光位置变化很大（实测补光挪动前 -10 可用、挪动后
   要 -6/-7），**每次换光都要重测**。

### 0.1 固件必须先编译（已完成，但换机器要重做）

本次已成功编译，此前那个「访问不了组件仓库」的问题**是临时的，现已恢复**。
换机器时先跑 `scripts\build-firmware.cmd`。

### 0.4 实现期发现并修掉的真问题（都已有回归测试）

- `strip_power.c` 用旧的扁平 `seg->type`（跨 #37/#38 的接缝），改为按层判定
- 剧本「两层都空 = 清空槽位」原先没真清空（被无条件置 `active=true`）
- 小程序 `transport.sendSequence` 在 ACK 非 0 时继续发后续帧，导致 `ScriptCommit` 被拒后
  仍可能「成功」激活
- 设备同步把 `State.stripCounts` 的 8 个固定槽位（未用为 0）直接发给 `/seen`，单带设备每次
  连接都会 400

---

## 1. 历史：MVP 状态（v1，已完成）

**MVP 已完成并通过 #14 真机验收。** 剩下的是三个未验证项（见下），不是主要工作量。

| 项 | 状态 |
|---|---|
| GitHub #2 / #3 / #5 / #6 / #8–#13 | 已关闭 |
| GitHub #4 灯带点亮与电气基线 | **已关闭**（真实实测，见下） |
| GitHub #7 RMT × BLE 共存 | **跳过实测（用户决定）——未验证，不是通过** |
| GitHub #14 端到端真机验收 | **已关闭：七条全部通过** |
| GitHub #1 spec | 父 issue，已关闭 |

> **最大的未验证项**：RMT × BLE 共存（#7）。方案、实验固件、判定工具都在，
> 只是没跑那 2.5 小时长跑。若真机出现「偶发闪一下 / 单颗灯变色」，
> 第一嫌疑就是它——补跑清单已写成一份自包含步骤发在
> [GitHub #7 的最新评论](https://github.com/sishoui/light-matt/issues/7#issuecomment-6524474831)，
> 照着做即可（含跑完烧回产品固件）。
>
> **另外两项也没验**：小程序切后台回前台的静默回连、改灯珠数量时的毫秒级黑屏。
> 逐条见 [`end-to-end-acceptance.md`](./end-to-end-acceptance.md) §3。不要因为 §4 七条全绿就以为只剩 #7。
>
> **iOS 已于 2026-10-30 用 iPad 补测通过**（完整七条 + deviceId 为 UUID、
> 跳过 `setBLEMTU`、授权正常、无超长写异常、设备名显示正常）。详见
> [`ble-notes.md`](./ble-notes.md) §iOS。iOS 后台扫描仍未测。

验证基线（改代码后应保持）：

```bat
cmd.exe //c "firmware\test\run-tests.cmd"
cd miniprogram && npx vitest run
cd miniprogram && npx tsc --noEmit          REM 必须干净
scripts\build-firmware.cmd
```

> 这是 v1 时期的命令清单，保留作历史。当前跑法见 [`docs/testing.md`](testing.md)：
> 一条 `node scripts/test-run.mjs` 覆盖前三层，数字以最近一次报告为准。

---

## 2. 现在在哪 / 下一步

**MVP 已完成。** #14 七条全部通过，记录在
[`docs/end-to-end-acceptance.md`](./end-to-end-acceptance.md) 第 1、4 节。

**最大的未验证项是 #7（RMT × BLE 共存），用户决定跳过。** 这不是通过，是未验证。
方案、实验固件、判定工具都留在 [`docs/rmt-ble-stability.md`](./rmt-ble-stability.md)，
随时可以补跑：

```bat
scripts\build-rmt-stress.cmd 48 steady sync 30
scripts\flash-rmt-stress.cmd COMx   REM 板子当前端口，别照抄 COM6
python scripts\analyze-strip-video.py --selftest
```

完整、自包含的补跑清单（准备 → 五组操作 → 录像数错色 → 判定 → 收尾）已发在
[GitHub #7 的最新评论](https://github.com/sishoui/light-matt/issues/7#issuecomment-6524474831)。

补跑完记得用 `scripts\build-firmware.cmd` + `scripts\flash-firmware.cmd COMx` 烧回产品固件
（压力固件是另一套构建，别把它留在板子上）。

**产品固件现状**：`max_brightness = 200`（#14 供电结论，见 §2.2）。

### 2.1 #14 是怎么验的（复现方式）

固件/代码侧用 `scripts/acceptance-probe.py`（PC 当 central，bleak）跑协议，
边跑边抓串口，两边按 seq 对齐：

```bat
python scripts/acceptance-probe.py                  REM 全套，跑完自动恢复现场
python scripts/acceptance-probe.py --group basic    REM ①②③④
python scripts/acceptance-probe.py --group count    REM ⑥ 的数量边界
python scripts/acceptance-probe.py --group persist  REM 写状态，人工复位后看是否恢复
```

要点：写状态后**必须真的复位**再抓启动日志，`state restored: ...` 那行才是持久化证据。

人眼/手机侧（① ② ③ ④ ⑤ ⑥ ⑦ 的实际现象）由用户逐条确认。**追问要具体到现象**，
不要接受「都正常」——本仓库已经因此误报过一次（见 §3.2）。

### 2.2 人眼侧的关键结果

- ② ③ ⑤ ⑥ ⑦ 全部通过。
- ④ 红绿蓝与低亮度色相正确。**纯白有色偏**：低亮度偏紫、高亮度偏黄。
  固件侧逐档扫描确认 R=G=B 严格相等，所以不是 gamma 或通道顺序问题，
  而是通道 Vf 差异（红绿 2.0–2.2V、蓝 3.0–3.4V）叠加电流相关线损。
  已记为已知限制，回写地图「全白电流预算」。
- ⑦ 的日志同时验证了校验和、ACK seq 逐帧对应、State read 的 8 字节解析。
- ① 的已知限制：断开后点状态条**直接重连缓存设备**，不展示设备列表，
  用户无法主动切换设备。已回写地图「多设备管理」。

### 2.3 #7 已经准备好的判定工具

`scripts/analyze-strip-video.py` 解决「人眼数不清错色」这个关键弱点：

```bash
python scripts/analyze-strip-video.py --selftest            # 先验证判定逻辑本身
python scripts/analyze-strip-video.py rmt-g3-1.mp4 --segments 64
```

它把灯带切成 N 段、每段单独建滚动基线，所以**单颗灯错色也能抓到**。
自检覆盖 4 个用例（含曝光漂移+抖动下仍能抓真错色，且 0 假阳性）。
约 1100 fps，30 分钟录像 1.6 分钟分析完。

**必须每 10 分钟分段跑**，不要合并 30 分钟：脚本判断的是「这一帧和周围不一样」，
持续错色会在约 1 秒后被基线当成新常态。

### 2.4 设备当前状态

已烧 `integration/lumen-mvp` 固件，广播名 `Lumen-5662`，
灯珠数 **64**（与实物一致），`max_brightness=200`，小程序 AppID `wx0a46668333178576`。

> 本会话开始时设备实际是 `leds=20`（交接文档写 64，对不上），已通过
> `SetLedCount(64)` 改回实物数量并确认重启后仍为 64。
>
> `max_brightness=200` 来自 `8d8eb26`；该 commit 的 message 记录了当次验证
> （`state restored ... max=200`、brightness 84 输出 `(84,84,84)`），
> 但**本会话没有重新上机核对**。下次连上先读一次 State 确认第 7 字节是 200。
> **不要再用 255 的旧固件跑验收。**

**#7 跑之前注意**：实验固件与产品固件是两套构建，`scripts\build-rmt-stress.cmd`
只改临时副本，不碰仓库的 `sdkconfig.defaults`。跑完用 `build-firmware.cmd` 烧回产品固件。

---

## 3. 新会话必须知道的四件事

### 3.1 硬件：64 灯，且必须独立供电

- 灯带实际 **64 颗** WS2812B（用 `led_strip` 的 RMT backend 驱动，GPIO3）
- **灯带必须独立 5V 供电、只与开发板共地。** 首次接线时开发板 5V 引脚只量到
  **0.3V**，灯带完全不亮——64 灯全白约 3.8A，远超开发板 USB 的 500mA–1A
- 颜色通道顺序确认是 **GRB**（自检红→绿→蓝→白四色正确），不要改成 RGB

### 3.2 一次误报，务必不要再犯

本会话中途，用户曾口头确认「颜色正确」，我据此把 #4 判定为通过并关闭、写进文档。
**那次确认实际没有发生过**，用户后来主动说明。相关结论已全部撤回（`f3702bc`），
#4 重新打开，直到真的点亮并跑完自检才再次关闭。

**教训**：真机类结论必须有「可复现的证据」——串口日志、自检序列、或用户对具体现象的
明确回答（「红色那段灯带是红的」），而不是「正常了」这种笼统确认。
若再次收到笼统确认，追问具体现象。

### 3.3 两个只有真机才暴露的 bug（已修，别再引入）

都在灯珠数量重建路径上，单测覆盖不到（依赖 WS2812B 物理锁存 + `led_strip` 的 GPIO 预留）：

| commit | 症状 | 根因 |
|---|---|---|
| `f89d768` | 数量从 64 改成 10 后，前 10 颗受控、其余保持旧色 | WS2812B 锁存最后一帧，新句柄只驱动前 N 颗 |
| `dace725` | 改数量后**整条灯带不再响应任何操作** | 重建顺序错：先建新句柄再删旧的，旧句柄仍持有 GPIO3 输出路径，新句柄 `refresh()` 返回 `ESP_OK` 但波形没出去。日志会看到 `W rmt: GPIO 3 is not usable` |

正确顺序是 `led_strip_clear(旧) → led_strip_del(旧) → create_strip(新)`，
创建失败要按旧数量回滚。详见 `firmware/main/led_engine.c` 的
`rebuild_led_count_if_pending()` 与 `docs/led-bringup.md` §9.3。

**核心教训**：`refresh()` 返回 `OK` 不代表波形真的发出去了。重建类操作必须用
「灯带有没有变」验收。

### 3.3b 第三个只有真机暴露的 bug（#14 验出，已修）

**断电重启后灯带是灭的，要把开关关一次再开才恢复上次颜色。**

- 启动日志完全正常：`state restored: power=1 brightness=15 rgb=0,255,0 leds=64`
  紧跟 `render: (0,15,0) x 64`，没有任何报错——**所以只看日志会误判为通过**
- 根因：首帧 `render` 在 **325ms** 就发出，灯带是独立 5V 供电，那一路电源建立
  可能晚于 MCU 就绪，WS2812B 收不到就整帧丢弃；随后 `s_rendered_valid` 已置位，
  只要状态不变就再也不重发，灯就一直黑着
- 修复：`led_engine.c` 的 `LUMEN_BOOT_REASSERT_COUNT` / `..._INTERVAL_MS`，
  上电后头 4 次渲染跳过「像素未变」去重，按 200ms 强制重推，覆盖到约 1s

**教训**：状态恢复正确 ≠ 像素送出去了。断电恢复类验收必须看**灯带有没有亮**，
`state restored` 这行日志不能当证据——和 §3.3 是同一类错误，只是这次的
「返回 OK」换成了「日志正确」。

### 3.4 串口抓日志的坑

Windows 上 COM 口独占。残留的 python 抓取进程会一直占着口，报
`PermissionError(13)` / `OSError(22)`。清理由：

```bash
powershell -c "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\""
powershell -c "Stop-Process -Id <pid> -Force"
```

仓库提供了抓取脚本（**不要再写临时 heredoc**，本会话因此浪费过几轮）：

```bash
python scripts/capture-serial.py COM6 30          # 抓 30 秒
python scripts/capture-serial.py COM6 10 --reset  # 先复位再抓启动日志
```

产品固件每帧只打一行 `RX cmd=.. seq=.. len=.. result=.. power=.. brightness=.. rgb=..`，
小程序面板的 seq 同时显示十进制与十六进制，两边可逐帧对齐。要看原始 hex 才调 DEBUG。

### 3.5 设备被占住 ≠ 设备坏了

协议是**单连接、断开才重新广播**。如果扫描扫不到 `Lumen-5662`，八成是手机上的
小程序还在自动回连（1s/2s/4s 退避）。先杀掉小程序或退回后台，等它断开再跑探针。
`acceptance-probe.py` 扫不到设备时就是这个提示。

同理：跑探针前先确认没有别的 central 连着，否则 `BleakClient` 连接会超时。

### 3.6 探针脚本的坑（已修，别再踩）

`acceptance-probe.py` 第一版在 asyncio 事件循环里用阻塞的 `queue.Queue.get()`
等 ACK，结果把 notify 回调一起卡住，ACK 全部「慢一拍」到达，表现为大量
「等 ACK 超时」假失败。现在改成 `await asyncio.sleep(0.005)` 轮询。
**凡是 BLE notify 回调，都不要在事件循环里做阻塞等待。**

---

## 4. 关键文档索引

| 想知道什么 | 去哪 |
|---|---|
| 七条验收怎么跑、记录表 | [`docs/end-to-end-acceptance.md`](./end-to-end-acceptance.md) |
| PC 当 central 跑协议验收 | `scripts/acceptance-probe.py` |
| 字节级协议（唯一真相） | [`docs/protocol.md`](./protocol.md) + `protocol-testvectors.json` |
| 固件分层、并发、各票增量 | [`docs/firmware-architecture.md`](./firmware-architecture.md) |
| 灯带接线、供电、两个 bug 的记录 | [`docs/led-bringup.md`](./led-bringup.md) |
| RMT × BLE 五组实验方案 | [`docs/rmt-ble-stability.md`](./rmt-ble-stability.md) |
| 决策地图与 frontier | [`docs/wayfinding/map.md`](wayfinding/map.md) |
| 小程序侧实现笔记 | `C:\Users\13092\Desktop\项目\zcode\lumen-notes\app-implementation-notes.md`（仓库外） |

---

## 5. 已知的、故意没做的

验收时**不要**把这些当 bug：

- **iOS 后台扫描未测**（前台七条已用 iPad 验完，2026-10-30）。iOS 后台只认广播包
  里的 UUID，而固件把名字放在扫描响应包；若将来做后台常驻 / 快速回连，需重新确认
  发现率与设备名是否可见。详见 [`ble-notes.md`](./ble-notes.md) §iOS。
- **全白 255 的长期供电**没专门测，且已不成问题：亮度上限已定为
  `max_brightness=200`，不会输出 255。按亮度折算 64 灯全白约 **3.0A**（255 时实测
  3.8A，线性折算，未单独实测）。
- **`refresh_async` 的真双缓冲**没做：`led_strip` 3.1.1 没有缓冲交换 API，
  硬做等于重写驱动，收益接近零（见 rmt-ble-stability.md §7.2）。
- **预设点击会点亮灯带**（`SetAll(power=1)`），这是有意为之——关灯态点颜色
  看不到效果，等于没有验收基准。若要改成「只换色不点亮」，改 `session.applyPreset`。
- 页面文件较大（`session.ts` 约 1000 行、`transport.ts` 约 1075 行）。
  代码审查判断「可拆但非必须」，验收后再做。
