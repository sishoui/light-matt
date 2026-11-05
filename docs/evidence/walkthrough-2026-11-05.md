# 真机走查底座验收记录（#128，规格 #127）

**日期**：2026-11-05
**设备**：`Lumen-5662`（8 带 × 30 颗，固件 v4.0 = `0x0400`，`maxBrightness=200`）
**命令**：`node scripts/test-run.mjs ble`

---

## 1. 用例组覆盖（验收标准第一条）

20 条，跑完一个真实用户在一组页面上的动作：

| 类 | 行 |
|---|---|
| 连接 | `walkthrough.connected` |
| 首页 | `baseline.home-power-key`、`baseline.home-brightness` |
| 设备页 | `baseline.device-strip-switch` |
| 灯组页简单档 | `baseline.simple-mode-effect` |
| 灯组页进阶档 | `baseline.advanced-loop-tristate` |
| 自动回连 | `home.power-after-reconnect` + `baseline.post-reconnect-recovery` |
| 扫描与连接 | `home.scan-keeps-link`、`home.status-action-does-what-it-says`、`discover.empty-hint-matches-button` |
| 收尾 | `walkthrough.settle` |

每一条都调页面自己的事件处理器（`onPowerTap` / `onBrightnessChange` /
`onStripPowerChange` / `onEffectPick` / `onModeTap` / `onLoopTap` / `onStatusTap` /
`onScanTap` / `onStepAdd`），测试里没有另写一遍调用顺序。

## 2. 一次真实运行（有设备）

```
PASS  walkthrough.connected：界面 page.data home.statusText=已连接 · Lumen-5662 · 设备 refreshState power/brightness/stripCount=1/60/8
PASS  baseline.home-power-key：界面 page.data home.powerHint=hint="灯光已关闭" busy=false · 设备 refreshState power=0
PASS  baseline.home-brightness：界面 page.data home.brightnessSlider=100 · 设备 refreshState brightness=100
PASS  baseline.device-strip-switch：界面 page.data device.stripCards[1].on=false · 设备 refreshState stripPowerMask=bit1=false mask=0xfd
PASS  baseline.simple-mode-effect：界面 page.data strip.effectRows[0].value=呼吸 · 设备 queryStrip strip0.layer0.type=0x1 呼吸
SKIP  strip.simple.first-open-honest：界面 page.data strip.effectRows[0].value=常亮 · 设备 queryStrip strip0.zones=0
SKIP  strip.advanced.delete-step-exists：界面 page.data strip.onStepDelete=无入口 · 设备 capability 协议里的删步骤命令={"kind":"capability","absent":"没有删除单一步骤的命令（只能整套重写方案）","via":""}
SKIP  strip.advanced.add-step-inherits：界面 page.data strip.stepCount=3 · 设备 lastDownloadedScript stages[2].segments(strip0)=0
SKIP  strip.simple.recolor-keeps-plan：界面 page.data strip.quickHint=彩虹 已生效 · 设备 lastDownloadedScript playbackState + 方案形状=playback=1 stages=2 segments=1
SKIP  home.power-after-reconnect：界面 page.data home.busy/powerHint=busy=true powerHint="灯光已关闭" · 设备 refreshState power=tap 前=0 tap 后=0（没翻转）
SKIP  home.scan-keeps-link：界面 page.data home.statusText=未连接 · 设备 refreshState linkState + QueryState=idle queryState=不通
SKIP  home.status-action-does-what-it-says：界面 page.data home.statusAction=停止 · 设备 refreshState 点完之后 linkState=scanning
SKIP  discover.empty-hint-matches-button：界面 page.data discover.emptyHint=把灯控通电，再点下面的「重新扫描」。 · 设备 refreshState scanLabel + linkState=scanLabel=停止扫描 link=scanning
PASS  strip.advanced.guide-right-level：界面 page.data strip.panelGuide=这一步还没有分区：在「分区」里点「+ 新增」划出第一片灯珠区间。 · 设备 lastDownloadedScript planEmpty/stepZones/otherSteps=planEmpty=false stepZones=0 otherSteps=true
SKIP  strip.simple.name-single-source：界面 page.data strip.simpleParams.title=流光追逐的参数（灯效行 流星） · 设备 queryStrip strip0.layer0.type→名字=流星
SKIP  deviceinfo.firmware-version：界面 page.data deviceInfo.firmwareText=v0.4（0x0004） · 设备 frameLog 0x88 payload[0..1] 按小端=v4.0（0x0400）
SKIP  home.brightness.percent-honest：界面 page.data home.brightnessSlider/max/percent + 上限文案=100/200/50% caption="拖动调节，松手生效" · 设备 refreshState brightness/maxBrightness=100/200
PASS  baseline.advanced-loop-tristate：界面 page.data strip.loopChoices=不循环|全部循环|最后一步循环* · 设备 refreshState flags→loop=2（flags=0x7）
PASS  baseline.post-reconnect-recovery：界面 page.data home.statusText=已连接 · Lumen-5662 · 设备 refreshState power/brightness + QueryState=power=0 brightness=100 queryState=通
PASS  walkthrough.settle：界面 snapshot snapshot(power/brightness/mask)=1/60/200 mask=0xff · 设备 refreshState 逐带段数 + power/brightness/mask=segs=[0,0,0,0,0,0,0,0] power=1 brightness=60/200 mask=0xff
      Tests  9 passed | 11 skipped (20)
```

整层（四个 e2e 文件）：

```
| 真机 e2e | ✅ PASS | 41 用例 | 161.8s | 30/41 个用例通过，11 条跳过 |
- 结论：✅ 通过（1 项层内跳过）
- 层内未验证：11 条跳过是已知分歧（走查用例组里规格 #127 的发现，今天预期仍未修好）
```

## 3. 没有真机时（验收标准第二条）

用改名前缀（四个 e2e 文件的 `Lumen-` → `NoSuchDevice-`）实测，不是靠拔设备。
**验证完已全部改回**，恢复后重跑 30/41 通过。

```
| 真机 e2e | ⏭️ SKIP | 41 用例 | 119.2s | 40/41 条用例跳过（设备不在或被别处占用），有效通过 1 条 |
- 结论：⚠️ 未全验证（真机 e2e 未跑）
ORCH_EXIT=0
```

- 走查组 20 条**全部 skip**，贡献 **0 passed**。
- 全层 40 条跳过、1 条有效通过（既有的扫描用例），`parseE2eJson` 的
  「至多 1 条通过」阈值仍然成立。
- 退出码 **0**，层记 SKIP 而不是 FAIL。

## 4. 12 项发现（验收标准最后一条）

11 项以 `quarantined` 复现，票号与读数见上表。第 12 项：

**#137 引导指错地方 —— 没复现。** 真机上停在空步骤、其它步骤有内容时，
`panelGuide` 给的是 `PANEL_EMPTY_STEP_GUIDE`（正确文案），
条件为 `planEmpty=false stepZones=0 otherSteps=true`。
所以这一行**没有**挂 `known-divergence`，写成会真实通过的 `must-hold`：
三级引导互斥且指向当前这一步。判据一旦被改回「只看方案级」，这一行立刻变红。

## 5. 现场复位（验收标准第五条）

```
segs=[0,0,0,0,0,0,0,0] power=1 brightness=60/200 mask=0xff
```

逐带段数回到 0，电源 / 亮度 / 逐带掩码回到走查开始时的快照（`1/60/200`、`0xff`）。

复位断言是**一条真用例**，不是 `afterAll`：实测 `afterAll` 抛错时 vitest 的
`numFailedTests` 仍是 0，而 `drive.mjs` 只从 `assertionResults` 数失败，
收尾出错会被报成 PASS。

## 6. 三处实现与设计不一致的地方（都更强，不是放宽）

1. **`neutralise()` 必须一并清方案草稿。** 草稿落在 wx 桩的内存 Map
   （`lumen.planDrafts.v1`）里跨行存活；上一个 probe 画过的区间会让下一个 probe
   被重叠预检挡住，方案不下发、播放头不动。第一次真机跑出 1 条假失败就是这个。
2. **#130 的「静默」不能靠 `powerHint` 为空判。** 同一进程里首页只有一个实例，
   上一条基线行留下的 `"灯光已关闭"` 会一直在。判据改成只看设备电源位有没有翻转，
   `busy=true` 进归因文案——比原判据更强。
3. **#139 的「方案被重下」在当前这台设备上不可观察。** 改色前后
   `lastDownloadedScript` 形状相同（`stages=2 segments=1`），因为简单档改的是一组
   单分区，重下出来的形状恰好一样。这一行的设备值记的是
   `playback=<n> stages=<n> segments=<n>`，断言落在票面明确的那一半：改色必须停播。
   「方案内容被改写」这一半不写成恒真的对比。

## 7. #129 的设备侧真值怎么来的

不改协议、不加测试出口、不新增接缝：
`session.log.snapshot()` 里 `dir === "rx" && command === 0x88` 的整帧，
payload 从下标 6 开始，前两字节按小端 = `0x0400` = v4.0。

固件侧交叉验证：`firmware/main/protocol.c:236-237` 写的是
`payload[0] = version & 0xFF` / `payload[1] = version >> 8`（小端），
而 `docs/protocol-v4.md:479` 与可执行向量写的是 `0x0400`（大端）。
三方不一致正是 #129 要修的东西。
