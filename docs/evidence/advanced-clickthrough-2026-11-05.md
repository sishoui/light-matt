# 进阶灯效：模拟用户点击 → 真实设备 逐步骤验收

- **时间**：2026-11-05
- **设备**：`Lumen-5662` @ `CC:8D:A2:C2:56:62`，固件 v4.0，8 条带 × 30 颗
- **结论**：修复前 **22 / 24**，修复后 **24 / 24**。未通过的两项是同一个用户可见缺陷
  （循环档位没送到设备）；修复过程中又查明同一根因下还有两处（见 §3 末），全部已修（#114）

---

## 1. 这条测试为什么可信

模拟器里的蓝牙是桩实现（`createBLEConnection` 直接回「暂时不支持此 API 调试」），
所以「在模拟器里点一下」到不了真实设备。本测试换了做法：

```
strip.ts 的页面对象（Page({...})，179 个字段）
    ↓ 只把 wx 换成转发桩
scripts/ble-gateway.py（bleak）
    ↓
PC 真实蓝牙 → ESP32-C3 → 真实灯带
```

- 点的是**页面自己的事件处理器**（`onModeTap` / `onZoneAdd` / `onPickerConfirm` /
  `onPanelTypeTap` / `onLoopTap` / `onDurationChange` / `applyAdvanced`），不是测试里另写一遍调用顺序；
- 跑的是**产品代码**（`ControlSession` + `BleTransport` + 帧编解码）；
- 唯一被替换的是渲染层：WXML 不求值，断言读页面 `data` + **设备 State / QueryStrip**。

每一项都同时核对三件事：页面状态变了没、**设备收到没**、两边一致吗。

---

## 2. 逐步骤结果

| # | 用户操作 | 页面反应 | 设备反应 | 判定 |
|---|---|---|---|---|
| 0 | 进入灯组页 | ready、默认简单档 | 8 带 / 30 颗 / 亮度 128 | ✅ |
| 1 | 点「进阶」 | `mode: simple → advanced`，出现循环三档与时间轴 | 无写入（正确） | ✅ |
| 2 | 点「加步骤」 | 2 → 3 步 | **设备段数不变**（编排是本地草稿，点应用才下发） | ✅ |
| 3 | 点「加分区」 | 灯珠弹窗打开 | — | ✅ |
| 4 | 点两颗灯珠划选 | 区间 0-9，确定键可用 | — | ✅ |
| 5 | 点「确定」 | 分区数 0 → 1，弹窗关闭 | — | ✅ |
| 6 | 点「应用并播放」 | — | 剧本激活 `script_id=0`、`playback=1`；**静态分区读回 0-9** | ✅ |
| 7 | 选中分区 → 点「呼吸」 | `panelMode: breathing` | **读回第一层类型 0x01** | ✅ |
| 8 | 点循环「不循环」 | 草稿 loop=0 | flags `0x02`（无循环位） | ✅ |
| 9 | 点循环「全部循环」 | 草稿 loop=1 | flags `0x02` | ❌ **循环位没置上** |
| 10 | 点循环「最后一步循环」 | 草稿 loop=2 | flags `0x02` | ❌ **loop 根本没下发** |
| 11 | 拖时长到 1.5 秒 | `durationInput=1500` | 剧本摘要 stageCount=3 | ✅ |
| 12 | 只改 strip 0 后应用 | — | **strip 1 分区数与颜色逐字节不变** | ✅ |
| 13 | 收尾 | — | 无残留分区 | ✅ |

**22 项通过**（表中 ✅ 共 22 个计数点，含分步拆分项）。

---

## 3. 未通过项：循环档位在页面路径上失效

### 现象

用户在进阶档点「全部循环」或「最后一步循环」，**页面草稿正确记下值**（实测 `draft.loop=2`），
但设备 `flags` 始终是 `0x02`（有激活剧本、无循环位）——等于**不循环**。

抓到的实际调用：

```
>>> session.setPlayback(action=1, loop=false) typeof=boolean
```

用户选的是 `2`，发出去的是布尔 `false`。

### 根因

`miniprogram/pages/strip/strip.ts` 的 `applyAdvanced`（约 3641 行）这样取 loop：

```ts
const state = session.deviceState;
const loop = state !== null && (state.flags & 0x01) === 1;   // 布尔
...
const uploaded = await session.downloadScript(script, { activate: true, loop });
const played = await session.setPlayback(1, loop);
```

它读的是**设备当前状态**，不是用户刚选的**草稿**。而：

1. 协议里 loop 是**三值**（0 不循环 / 1 全部循环 / 2 最后一步循环），这里只看 bit0；
2. `assertLoopMode(true)` 映射成 `LOOP.ALL`，`false` 映射成 `LOOP.NONE`；
3. 用户选的值只进了草稿（`onLoopTap` → `withDraftLoop`），而 `draftToScriptConfig` **不携带 loop**。

所以结果是：设备原先不循环 → 推导出 `false` → 永远下发不循环。**三档里只有「不循环」碰巧对**。

同一个文件第 3450 行还有一处同样写法（「继续播放」路径）。

### 正确写法（现成函数，同文件已在用）

```ts
import { stateLoopMode } from "../../utils/protocol/commands";   // 第 228 行已 import

// 应改为：读草稿（用户的选择）优先，兜底才读设备
const loop = state === null ? draftLoop(this.currentDraft()) : stateLoopMode(state);
```

`stateLoopMode` → `loopModeFromFlags` 能正确区分三值（`flags & 0x04` 判 LAST）。
同文件 2735 / 3265 行已经在用这个写法，只有这两处漏了。

### 修复 #114 时又发现两处（本节初版未覆盖）

上面这版结论**只对了一半**，照它改会引入一个方向相反的新缺陷。修复时补测了两层：

**① 计划层也把三值压成了布尔。** 绕过页面、直接把三值喂给会话：

```
[会话直传] loop=0  downloadScript=ok  激活后设备flags=0x03  setPlayback=ok  播放后设备flags=0x02
[会话直传] loop=1  downloadScript=ok  激活后设备flags=0x03  setPlayback=ok  播放后设备flags=0x03
[会话直传] loop=2  downloadScript=ok  激活后设备flags=0x03  setPlayback=ok  播放后设备flags=0x07
```

`setPlayback` 三档全对，但 `downloadScript` 收到 `loop=0` 也发成 `0x03`（不循环被写成全部循环）。
根因在 `utils/control/script-plan.ts`：`cmdActivateScript(id, opts.loop !== false)` 与
`opts.loop === false ? "（播一次）" : "（循环）"` —— `0 !== false` 为真，`2 !== false` 也为真。
**只改页面的话，三档会变成「0 变全部循环、1 正确、2 仍错」。**

**② 简单档写入会篡改循环档位。** `silentDownloadPlans` 硬编码 `loop: false`：

```
[前置] 设备设为最后一步循环 → flags=0x7
[silentDownloadPlans] stages=2 segs=[1,0] loop=undefined
[downloadScript] opts.loop=false kind=ok flags=0x2   ← 档位 2 被刷成 0
[writeQuick] 结束 flags=0x7                          ← 被随后的恢复帧掩盖
```

播放中被恢复帧掩盖，但设备**暂停**时 `writeQuick` 只停不恢复，档位就真丢了。
所以「点一张效果卡」会静默把最后一步循环改回不循环。

这两处都在 `loop-mode.test.ts` 里有用例钉住；把修复临时 stash 掉时，
11 条里有 10 条变红（漏掉的那条是当时写得太松，已改成「暂停态」再验证）。

### 最终修复

单一推导 + 类型收窄，三值从用户点击一路原样到线上字节：

| 位置 | 改法 |
|---|---|
| `advanced-layers.ts` | 新增 `resolveLoopMode(draftLoop, flags)`：`draft.loop !== undefined` 时用草稿，否则用设备；判据不是 `draftOwned`（后者在任何编辑时都变真） |
| `constants.ts` | 新增 `type LoopMode = 0 \| 1 \| 2` |
| `commands.ts` / `session.ts` | `stateLoopMode` / `loopModeFromFlags` / `setPlayback` / `activateScript` 收窄到 `LoopMode`，布尔不再能上传 |
| `script-plan.ts` | `ScriptPlanOptions.loop` 改 `LoopMode`，文案与载荷来自同一个规范化值 |
| `strip.ts` | `applyAdvanced` / `activatePlan` 读草稿；`onApplyAndPlay` 简单档保持设备当前档；`silentDownloadPlans(loop)` 由调用方给值；`onLoopTap` 的提前返回改比原始值 |

修复后同一台设备逐档实测（六次点击、三档来回）：

```
点档位 1 → downloadScript 入参=1 / setPlayback 入参=1 → 设备 flags=0x03 ✅
点档位 2 → downloadScript 入参=2 / setPlayback 入参=2 → 设备 flags=0x07 ✅
点档位 0 → downloadScript 入参=0 / setPlayback 入参=0 → 设备 flags=0x02 ✅
（再点 1 / 2 / 1 各一轮，同样全对）
```

真机点击链路 24/24 通过。

### 为什么既有测试没发现

- `advanced-layers.test.ts` 只测纯函数 `loopFlagsOf` / `loopLabel`，全绿；
- 没有任何测试覆盖 `applyAdvanced` 的 loop 推导；
- 真机 e2e（`complex-plan.test.ts`）自己拼 loop 值，绕过了页面；
- `scripts/probe-v4.py` 直接发协议帧，也绕过了页面。

**三层测试都绿，但用户真实路径是坏的** —— 这正是本轮模拟点击要补的缺口。

---

## 4. 固件侧对照（证明不是设备的问题）

同一台设备，直接走协议帧：

| 档位 | 阶段序列 | 终态 | flags |
|---|---|---|---|
| 不循环 | 0→1→2 | 停在第 2 步 | `0x02` |
| 全部循环 | 0→1→2→0→1 | 持续 | `0x03` |
| 最后一步循环 | 0→1→2，第 2 步原地重播 | 持续 | `0x07` |
| loop=3 | — | — | 被拒 `InvalidParam` |

**固件完全正确，问题在小程序页面的取值。**

---

## 5. 现场与复现

测试结束设备已复原：无剧本、无段、8 带全开、亮度 128、关灯。

```bash
cd miniprogram
npx vitest run --config .auto/advtest/vitest.adv.config.ts
```

用例文件 `.auto/advtest/click-through.spec.ts`（本地产物，未入库）；
页面运行时 `.auto/advtest/page-runtime.ts`（`Page({...})` 捕获 + `setData` 路径合并 + 缺失的 `wx` API 桩）。
