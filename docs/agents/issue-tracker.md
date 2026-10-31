# Issue tracker: GitHub

Issue 与 spec 住在 GitHub Issues。所有操作走 `gh` CLI；在仓库目录内运行，`gh` 会自动推断仓库。

- **仓库**：`sishoui/light-matt`
- **规格父 issue**：`#1`，label `spec`；13 张实现票是它的 sub-issues
- **实现票 label**：`ready-for-agent`

## 常用操作

- **创建 issue**：`gh issue create --title "..." --body-file <path> --label ...`
- **读取**：`gh issue view <n> --json number,title,body,labels,comments,blockedBy,parent`
- **列出**：`gh issue list --state open --json number,title,body,labels,comments`
- **设为 sub-issue**：`gh issue create --parent <parent> ...`，或 `gh issue edit <parent> --add-sub-issue <child>`
- **阻塞关系**：`gh issue create --blocked-by <n>,<n> ...`，或 `gh issue edit <child> --add-blocked-by <n>`。这是 UI 可见的原生依赖；不可用时退回正文顶部的 `Blocked by: #<n>` 行
- **统计未关闭阻塞**：`gh api repos/sishoui/light-matt/issues/<n> --jq .issue_dependencies_summary.blocked_by`
- **评论**：`gh issue comment <n> --body "..."`
- **标签**：`gh issue edit <n> --add-label "..."` / `--remove-label "..."`
- **关闭**：先 `gh issue comment <n> --body "..."`，再 `gh issue close <n>`

## 当前票据

| 本地编号 | GitHub | 标题 |
|---|---|---|
| 01 | #2 | 协议定稿与跨端测试向量 |
| 02 | #3 | 开发环境就绪 |
| 03 | #4 | 灯带点亮与电气基线 |
| 04 | #5 | 小程序 BLE 平台能力探针 |
| 05 | #6 | 固件 GATT 骨架 |
| 06 | #7 | RMT × BLE 共存验证 |
| 07 | #8 | 开关端到端（walking skeleton） |
| 08 | #9 | 亮度端到端 |
| 09 | #10 | 颜色与预设端到端 |
| 10 | #11 | 状态同步与断线回连 |
| 11 | #12 | 灯珠数量与断电记忆 |
| 12 | #13 | 协议日志与自检 |
| 13 | #14 | 端到端真机验收 |

`.scratch/lumen-mvp/issues/` 里的本地文件是发布时的底稿，**GitHub 上的 issue 是权威 tracker**。两者冲突时以 GitHub 为准。

## Wayfinding

- **地图**：单个 issue，label `wayfinder:map`
- **决策票**：地图的 sub-issue，label `wayfinder:<type>`（`research` / `prototype` / `grilling` / `task`）；认领 = assign 给自己
- **阻塞**：同上，用原生依赖
- **frontier**：列出地图的 open sub-issues，去掉有未关闭 blocker 的与已有 assignee 的，按地图顺序取第一张
- **回答**：评论写结论，然后 close，再在地图的 Decisions so far 追加指针

v1（MVP）的 wayfinder 地图与决策票仍在 `docs/wayfinding/`（历史产物）。之后新开的 wayfinder effort 走 GitHub Issues。

### 当前 effort：v3 扩展

- **规格（实现层）**：[#35 lumen v3 · 实现规格](https://github.com/sishoui/light-matt/issues/35)，label `spec`。11 张实现票是它的 sub-issues。
- **字节细节**的唯一真相是 `docs/protocol-v3.md`（v3 契约，含分片与两层段）；可执行副本是 `docs/protocol-testvectors-v3.json`，由 `scripts/gen-protocol-testvectors-v3.mjs` 生成 —— **改契约必须重新生成向量**。
- **不取代**：`docs/effects-spec.md` 的灯效参数语义在 v3 里没有变。

**v3 要解决的核心问题**：v2 把多带 / 多段 / 多阶段 / 多灯效都做进了固件和协议，但**小程序没跟上**（`PRIMARY_STRIP_ID = 0` 写死，无灯带维度）。v3 的主战场是小程序，固件做「补齐 + 放开」。

**依赖形状（11 张票）**

| 票 | 阻塞 | 交付 |
|---|---|---|
| #36 固件：协议 v3 信封与持久化 | — | 新信封 + CRC16 + 分片 + blob v4/v2 + 分区表 |
| #37 固件：段两层灯效与 blend 合成 | #36 | 段两层化、三种 blend、合成后再过 gamma |
| #38 固件：每带独立开关与配置查询 | #36 | `SetStripPower` / `QueryStripConfig` / `QueryDeviceInfo` |
| #39 固件：剧本两层化与容量预检 | #37 | `fade_ms` 预留、`ScriptTooLarge` 显式失败 |
| #40 小程序：协议 v3 与分片传输 | — | frame/crc16/chunk/两层段/37B State |
| #41 小程序：拆页与灯带维度 | #40 | tabBar 三页 + 二级页，消除 `PRIMARY_STRIP_ID` |
| #42 小程序：段编辑与两层灯效 | #41 | 区间 + 两层 + blend 编辑 |
| #43 后端：设备登记与会话 API | — | `devices` / `user_devices` + openid 可配置回落 |
| #44 小程序：设备页与后端同步 | #41 + #43 | 本地优先列表 + 异步同步 |
| #45 小程序：剧本页与读回 | #41 + #39 | 时间轴、从设备读回、容量预检 |
| #46 v3 端到端真机验收 | #37 #39 #41 #42 #44 #45 | 真机证据 |

**v3 的六条已定取舍（实现时不要「修复」）**：

- **不做运行期改引脚**：句柄热重建会放大已实测的 BLE 抢 RMT ISR 问题。引脚仍由 Kconfig 定，协议只读。
- **不做每带独立亮度**：只有每带开关，亮度保持全局。
- **最多两层叠加**：三层会让段结构从 21B 涨到 29B，吃掉本就紧张的剧本容量。
- **blend 只有覆盖/相乘/相加**：不做取最大（与相加视觉重合）。
- **`fade_ms` 只预留格式**：行为仍硬切（过渡期 RMT 负载翻倍）。
- **后端不存灯光配置**：设备 NVS 是唯一真相，双真相无解。

**v3 仍然是断崖升级**：magic 改 `0xA6`、version 改 `0x03`、State 14B→37B、段 8/12B→21B。
现场设备必须重刷固件，v2 的 NVS blob（state v3 / script v1）不被识别，刷完配置回默认值。
个人测试阶段可接受，但要写进验收记录。

**注意**：v2 的 `docs/protocol.md` 在 v3 实现完成后作废，`docs/spec-v2.md` 同时作废。

---

## 历史 effort：v2 扩展（已完成）

- **地图（决策层）**：[#16](https://github.com/sishoui/light-matt/issues/16)，label `wayfinder:map`。已关闭的决策票是它的 sub-issues。
- **规格（实现层）**：[#27 lumen v2 · 实现规格](https://github.com/sishoui/light-matt/issues/27)，label `spec`。所有实现票是它的 sub-issues。
- **已定前提**写在地图 Notes 里，开工前必须先读；**字节细节**的唯一真相是 `docs/protocol.md`（v2 章节待 #21）与 `docs/effects-spec.md`（灯效参数，已定稿）。

**依赖形状（12 张票）**

设计闸门：

| 票 | 阻塞 | 说明 |
|---|---|---|
| #21 协议 v2 字节契约 | — | 解锁 #25 / #29 |
| #20 RMT × BLE 共存与动画帧率基线 | — | 需真机，解锁 #22 |
| #23 后端数据模型与 API | — | 解锁 #33 / #34 |
| #22 固件动画引擎架构 | #20 | 解锁 #30 |

实现纵切（按执行顺序）：

| 票 | 阻塞 | 交付 |
|---|---|---|
| #28 prefactor：拆分四个大模块 | — | 零功能变更 |
| #25 端到端：分段配置（静态单色） | #28 + #21 | 划 3 段 → 各段不同色 → 断电恢复 |
| #29 端到端：八引脚 TDM 多灯带 | #25 + #21 | 8 条独立设色 |
| #30 端到端：呼吸灯效 | #25 + #22 | 可调快慢与最暗亮度 |
| #31 端到端：彩虹与流光 | #30 | 空间维度灯效 |
| #32 端到端：剧本（阶段序列） | #31 | 4 阶段循环，存多套 |
| #33 端到端：多设备切换 | #23 | 设备列表 + 换一台 |
| #34 端到端：后端日志与看板 | #23 | 只读看板 |

已关闭：#17（个人资质）、#18（BLE 并发）、#19（灯效规格）、#26（IDF 升级）。

**关键前提**：当前是**个人测试**阶段，不上架、不发布，所以 #17 不阻塞任何设计。**不做设备归属**——任何人扫到都能连，后端只记日志、不做业务处理，后台纯只读。

**五条已成事实的约束**：

- **小程序切后台 5 秒 JS 挂起、BLE 连接无法后台维持**，回前台必须重连。这是「单连接 + 切换」而非多连并发的根本理由（#18）。
- **官方明确记载 C3 的 RMT 在开 BLE 时会出现数据帧异常**（无 DMA + ISR 切缓冲，C3 不能用「换核」缓解）。动画持续刷新会放大这条风险，#20 必须实测。
- **C3 只有 2 个 RMT TX 通道**（v6.1 中为 `RMT_LL_TX_CANDIDATES_PER_INST=2`），8 条灯带必须走 TDM 轮询（`led_strip_switch_gpio()`）。
- **工具链基线 = ESP-IDF v6.1（最新稳定版）**，`idf_component.yml` 已钉 `idf: ">=6.1"`，`rmt_tx_switch_gpio` 确认可链接。**不做旧版本兼容**：MVP 只是试验，不维护降级路径与版本条件编译。详见 `docs/dev-environment.md`。
- **段配置必须带 `strip_id`**（8 条灯带需要区分归属），整帧 14 / 18 字节。**动画类只剩 2 字节余量，加字段几乎不可能**——不要假设有余量。

**v2 不向后兼容**：现场那台 64 灯设备需重刷固件。个人测试阶段没有第三方在用，无迁移代价。

## Pull requests as a triage surface

**PRs as a request surface: no.**

如果以后把外部 PR 当作需求入口，把这里改成 `yes`；`/triage` 会读这个标记。
