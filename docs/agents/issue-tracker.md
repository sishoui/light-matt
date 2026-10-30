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

### 当前 effort：v2 扩展

- **地图**：[#16 地图：lumen v2 — 多用户 / 多设备 / 多灯效 / 多阶段 / 多分段](https://github.com/sishoui/light-matt/issues/16)
- **决策票**：地图的 sub-issues，label `wayfinder:research` / `grilling` / `prototype` / `task`
- **已定前提**（多分段自由划、逐段下发、固件跑时间轴、升 v2 不兼容等）写在地图的 Notes 里，开工前必须先读。

依赖形状：

- **frontier（无阻塞）**：#19（灯效规格）、#20（RMT 实测）、#23（后端模型）
- #21 协议 v2 ← #19
- #22 动画引擎 ← #19 + #20
- #24 多设备切换 ← #23
- #25 纵切 ← #21
- 已关闭：#17（个人资质）、#18（BLE 并发）、#26（IDF 升级）

**关键前提**：当前是**个人测试**阶段，不上架、不发布，所以 #17 不阻塞任何设计。**不做设备归属**——任何人扫到都能连，后端只记日志、不做业务处理，后台纯只读。

**四条已成事实的约束**：

- **小程序切后台 5 秒 JS 挂起、BLE 连接无法后台维持**，回前台必须重连。这是「单连接 + 切换」而非多连并发的根本理由（#18）。
- **官方明确记载 C3 的 RMT 在开 BLE 时会出现数据帧异常**（无 DMA + ISR 切缓冲，C3 不能用「换核」缓解）。动画持续刷新会放大这条风险，#20 必须实测。
- **C3 只有 2 个 RMT TX 通道**（`SOC_RMT_TX_CANDIDATES_PER_GROUP=2`），8 条灯带必须走 TDM 轮询（`led_strip_switch_gpio()`）。
- **TDM 的前置已解除**：ESP-IDF 已升到 **v5.4.4**，`rmt_tx_switch_gpio` 确认可链接（`nm lumen.elf` → `T rmt_tx_switch_gpio`）。升级细节与两个坑见 `docs/dev-environment.md`。

**v2 不向后兼容**：现场那台 64 灯设备需重刷固件。个人测试阶段没有第三方在用，无迁移代价。

## Pull requests as a triage surface

**PRs as a request surface: no.**

如果以后把外部 PR 当作需求入口，把这里改成 `yes`；`/triage` 会读这个标记。
