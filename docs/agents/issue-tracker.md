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

现有的 wayfinder 地图与决策票仍在 `docs/wayfinding/`（历史产物）；之后新开的 wayfinder effort 走 GitHub Issues。

## Pull requests as a triage surface

**PRs as a request surface: no.**

如果以后把外部 PR 当作需求入口，把这里改成 `yes`；`/triage` 会读这个标记。
