# 灯组进阶档

灯组详情页的「进阶」档是这套产品的核心编辑器：一条固定宽度、永不横向滚动的时间轴，
每个步骤是一个比例块（24px 保底），选中步骤下方浮出气泡卡片（步骤名 / 时长 / 分区
列表）；循环是三档；效果分成**背景层**与**特效层**两个平级槽位。

## Sub-features

- **ADV-1 时间轴** —— 固定宽度、长按 300ms 抬起后跟手重排，最多 8 步；右侧「+」加步骤。
- **ADV-2 步骤气泡** —— 选中步骤下方有气泡卡片：步骤名（长按改名）、时长刻度、分区列表。
- **ADV-3 循环三档** —— 不循环 / 全部循环 / 最后一步循环。方案级设置，写进草稿。
- **ADV-4 分区轴** —— 按灯珠比例画出分区，未覆盖处是灰条，选中两端有圆形手柄，最多 8 个。
- **ADV-5 背景层** —— 铺底的那一层：静态 / 呼吸 / 彩虹 / 爆闪 / 心跳 / 熄灭 + 参数区。
- **ADV-6 特效层** —— 与背景层平级的第二个槽位：流星 / 随机闪烁这类流动效果；混合只剩
  相加 / 覆盖。**没有「叠加效果」这一整块，也没有「光区」这个叫法——统一叫「分区」。**
- **ADV-7 逐颗预览条** —— 打开后按分区颜色画出每一颗灯珠。

## How to get to it (user POV)

首页 → 点大卡进设备页（**在这里才连接**）→ 点某张灯组卡片 → 灯组页 →
点顶部的「进阶」分段。分区编辑器与两层面板都在这一屏里往下滚。

## Driving it with miniprogram-automator

`Preconditions:` 已连上一台有灯组的演示设备（`书桌` 有 2 条灯组）；`doctor.mjs` 全绿。
脚本场景：`--scenario strip-advanced`。

- **进到进阶档** → 先 `connectDemo`（首页 `p.session.connect("A4:CF:12:9B:3E:01","书桌")`），
  `mp.navigateTo("/pages/device/device?key=A4%3ACF%3A12%3A9B%3E%3A01")`，
  `mp.navigateTo("/pages/strip/strip?strip=0")`，再
  `p.onModeTap({ currentTarget: { dataset: { mode: "advanced" } } })`；
  可观察结果：`data.mode === "advanced"`。
- **循环恰好三档** → 读 `p.data.loopChoices`；可观察结果：标签依次是
  `["不循环", "全部循环", "最后一步循环"]`。
- **切到最后一步循环真的改草稿** → `p.onLoopTap({ currentTarget: { dataset: { value: 2 } } })`
  → `p.currentDraft().loop`；可观察结果：值变成 `2`，不是只改了 `data`。
- **两层编辑器要选中分区才出现** → `p.onZoneAxisTap({ currentTarget: { dataset: { segId } } })`
  （`segId` 取自 `p.data.zoneBlocks` 里 `kind === "zone"` 的第一块）；
  可观察结果：`data.panelHasZone === true`，且页面 WXML 同时含「背景层」「特效层」。
- **没有「叠加效果」/「光区」** → 读 `outerWxml()`；可观察结果：`includes("叠加效果")`
  与 `includes("光区")` 都是 false。
- **逐颗预览** → `p.onPreviewToggle()`；可观察结果：`data.previewLeds` 长度等于该灯组
  灯珠数（演示设备 30 颗）。

## Gotchas

- **两层面板是条件渲染的**：没选中任何分区时 `panelHasZone` 为 false，此时 WXML 里
  **不会出现**「背景层 / 特效层」。断言前必须先选中一个分区，否则会得到假的 FAIL
  （或者更糟：因为字符串没找到而误判为「界面被删了」）。
- 字段名是 `loopChoices`，不是 `loopOptions`；`stepCount` 是数字，`steps` 是渲染块。
  用错名字会得到 `undefined`/`0`，而 `undefined === 0` 之类的松断言会**假通过**。
  断言要写严（比较完整数组、比较严格相等）。
- **「应用并播放」按钮已不存在**（第五轮去掉的）：改动立即生效。看到它说明跑的是旧代码。
- 时间轴长按重排依赖 300ms 计时与抬起事件，纯 `evaluate` 调用可能绕过；重排要真实验证
  请用真实 touch 序列（`mp.currentPage()` 的 element 上派发）。
- 草稿落盘在 `lumen.planDrafts.v1`（键 = `deviceKey#stripId#slot`），断线 / 切页 /
  重启都不清，**只在显式删除设备时清**。改这块之前先看 `tests/plan-drafts.test.ts`。
- 改完复位到 `mode: "simple"`，否则下一次进页面默认落在进阶档，别的配方基线会变。
