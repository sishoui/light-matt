---
name: verify-lumen-ble
description: 用 PC 的真实蓝牙驱动真实 ESP32-C3，验证 lumen 的 BLE 链路层与协议语义——真实 MTU、真分片、真 CRC、真 ACK。用于改了 miniprogram/utils/ble、utils/protocol、utils/control/session 或固件之后，需要「设备真的收到了 / 真的读回了」的证据时。不覆盖渲染层（那是 verify-lumen）、固件 host 单测和后端。
---

# 验证 lumen 的 BLE 交互

这里只回答一个问题：**PC 通过真实蓝牙跟 ESP32 说话，字节对不对。**
渲染层（页面 / 交互 / 主题）归 `verify-lumen`；纯逻辑归 vitest；固件算法归
`firmware/test/run-tests.cmd`。

## 为什么这条链路值得单独验

微信开发者工具的蓝牙是**桩实现**（`createBLEConnection` 直接回「暂时不支持此 API
调试」），而 `noble` 在 Node 24 上编译不过。所以本项目的做法是：

```
vitest（被测的是真实 TS 产品代码）
   ↓  wx 被换成转发桩（tests/e2e/wx-bridge.mjs）
   ↓  JSON over stdio
scripts/ble-gateway.py（bleak）
   ↓
PC 的真实蓝牙 → ESP32-C3
```

关键点：**跑的是产品代码本身**（`BleTransport` / `ControlSession` / 帧编解码），
只把 `wx` 换掉了。所以它验的是真实 MTU、真实分片、真实 CRC、真实 ACK 时序——
不是假 transport 的调用顺序。这是本技能存在的唯一理由。

## 1. 前置

| 需要 | 检查 |
|---|---|
| 设备上电、**没被别处连着** | 固件连上就停止广播；手机连着时 PC 扫不到 |
| 固件是 v4 | v3 帧会被断崖拒绝为 `0x07`，所有断言会以错误原因失败 |
| Python + bleak | `python -c "import bleak"` |
| 依赖已装 | `cd miniprogram && npm install` |

静态检查先跑（它们比真机快，且能先修掉明显错误）：

```bash
cd miniprogram && npx tsc --noEmit
cd miniprogram && npx vitest run            # 不含 e2e
```

## 2. Doctor：设备在不在、烧的是哪版固件

**每次驱动前先跑。** 全只读（`QueryDeviceInfo` / `QueryState` / `QueryStrip`），
不发任何写命令，不写 NVS。

```bash
python .zcode/skills/verify-lumen-ble/scripts/doctor.py
python .zcode/skills/verify-lumen-ble/scripts/doctor.py --address CC:8D:A2:C2:56:62
```

它回答：扫得到设备吗 → 连得上吗 → 协商到多大 MTU → `DeviceInfoReport 0x88` 的
version / caps / 各项上限 → `StateReport 0x82` 是否恰好 37 字节且取值合法 →
`QueryStrip` 是否回了 `SegmentListEnd 0x84`。

退出码 `0` = 值得驱动；`1` = 不能驱动。**没设备不是测试失败**，是前置条件不满足，
脚本会明确说出来。

实测输出（2026-11-04，v4.0 固件）：

```
OK   扫到 Lumen-* 设备  — Lumen-5662 @ CC:8D:A2:C2:56:62
OK   连上设备
OK   MTU 已协商（≥23 才能发一帧）  — mtu=247
OK   收到 DeviceInfoReport 0x88
OK   固件是 v4（v3 帧会被断崖拒绝为 0x07）  — 0x0400 = v4.0
     固件      : v4.0 (0x0400)
     上限      : leds=100 strips=8 segments=8 stages=8 scripts=4
     caps      : 0x01  (bit0 两层叠加=True, bit1 fade=False)
OK   State 恰好 37 字节（v4 契约）  — len=37
OK   brightness ≤ max_brightness  — 128 ≤ 200
```

## 3. 驱动真实往返

```bash
node .zcode/skills/verify-lumen-ble/scripts/drive.mjs --scenario all
node .zcode/skills/verify-lumen-ble/scripts/drive.mjs --list
```

它做三件事：先跑 doctor（不通过就 SKIP，退出码 3）→ 用 JSON reporter 跑
`npm run test:ble` → 按「通过 / 失败 / 跳过」分开汇总并归档证据。

**没有按名字筛选的选项，这是刻意的**：这份 e2e 的第一条用例本身就是「扫到设备」，
用 `vitest -t` 过滤会把它一起滤掉，`device` 永远为 null，其余用例全部 skip
（本机实测全 skip，看起来像「跳过」实际是过滤器坏了）。要跑单条请临时加
`.only`，跑完去掉。

退出码：`0` 全过 / `1` 有真实失败 / `3` SKIP（没设备或全被跳过）。

**用例数取实际收集数，不要手抄。** `vitest.e2e.config.ts` 的 include 是
`tests/e2e/**/*.test.ts`，当前覆盖 `real-device.test.ts`、`complex-plan.test.ts`、
`page-click.test.ts` 与 `walkthrough.test.ts`。加一个文件不需要改任何数字；
`drive.mjs --list` 与编排器的 `ble` 层都按实际收集数报。

`walkthrough.test.ts` 的 12 行挂着 `[已知分歧 #NNN]` 前缀，今天预期 skip 并照留读数。
它们的跳过与「运行中途设备不可用」是两类，编排器分开报。

实测（2026-11-04，v4.0，当时仓库里只有 `real-device.test.ts`，故为 8 条）：

```
===== 8 passed / 0 failed / 0 skipped =====

✓ 网关能扫到 Lumen 设备
✓ BleTransport 连接后读到 37 字节 State，且 MTU ≥ 23
✓ ControlSession 真实往返：SetPower / SetBrightness 都收到 ACK
✓ 段下发后读回逐字节一致（21B 两层定宽编码全链路）
✓ 非法参数在客户端就被拦下（不会发到设备）
✓ 超出灯珠数的段被设备拒绝（客户端不知道实物长度，只能设备兜底）
✓ 每带开关只影响该带
✓ QueryDeviceInfo 返回真实 MAC 与 caps
```

这一份覆盖的东西，正好是别的层验不到的：

| 用例 | 只有真机能证明的部分 |
|---|---|
| 扫到设备 | 广播名与地址形态 |
| 37 字节 State + MTU ≥ 23 | 真实协商出来的 MTU；State 长度不符视为协议不匹配 |
| SetPower / SetBrightness 收到 ACK | 真实写入 + 真实 ACK 往返（不是本地状态） |
| 段下发逐字节读回 | 23 字节定宽层编码 → 设备存储 → 再编码回来的全链路 |
| 非法参数客户端拦截 | `blend≠0` 的单层在客户端就抛，比设备回 InvalidParam 更早 |
| 超灯珠数被设备拒绝 | 客户端不知道实物长度，必须由设备兜底 → `resultCode=1` |
| 每带开关只影响该带 | `strip_power_mask` 的位语义 |
| QueryDeviceInfo | 真实 MAC 与 caps 位 |

## 4. 证据

落在 `miniprogram/.auto/evidence-ble/<RUN_ID>/`（本地产物，不入库）：

- `vitest.json` —— vitest 原始 JSON 报告（含每条用例的状态与失败消息）；
- `ble-all.json` —— doctor 全文 + 逐用例状态汇总 + 判定原因。

**什么算证明**：断言原文 + 通过 / 跳过 / 失败分别计数 + 失败用例的原始错误消息。
只有「绿了」不算——必须能说出跑了哪几条、每条验的是什么。

**什么不算**：

- `npm run test:ble` 输出全 passed 但**没看到 skipped 计数**——没设备时它应当显示
  skipped，而不是悄悄变绿。
- 只跑 doctor 就说「BLE 没问题」——doctor 只证明设备在、能读状态，不证明写入往返。
- 改完代码直接跑 e2e 就宣布通过，而没跑 `tsc --noEmit` 与普通单测。

## 5. 清理与现场还原

这是**真实设备**，用户还要用它。e2e 用例自己要负责还原（每带开关开了又关、段写完
清掉），但仍有残留风险：

- 跑完再跑一次 `doctor.py`，看 `逐带灯珠` / `逐带段数` 是否与跑之前一致。
- **段是持久化到 NVS 的**：残留的段会一直留在设备上，并让下一次「段下发」用例因为
  **区间重叠**被拒绝（`resultCode=1`）。这不是回归，是现场脏了。
- `scripts/probe-v4.py` 末尾会主动恢复（灯珠 30、亮度 128、清空光区），需要硬复位
  现场时用它。

## 6. Gotchas（都是实测踩到的）

- **区间重叠会被拒**。同一灯带上任意两个活动段不能有交集
  （`overlaps_others`，闭区间）。所以第二次跑「段下发」用例时，如果上一次的段没清掉，
  `SetSegment(0,0,0..9)` 会拿到 `resultCode=1`，断言 `expected 3 to be 9` 失败。
  **先确认现场干净，再判断是不是代码回归。**
- **State 的 `strip_seg_counts` 是「当前生效」的配置，不是静态配置**。
  设备上若有一个**已激活的剧本**（`State.flags bit1 = script_active`），播放中 State
  报的是**当前阶段**的段数，而 `QueryStrip 0x12` 读的是**静态**配置
  （`led_engine.c:1390` 用 `s_segments`，State 用 `active_segments_locked()`）。
  本机实测：State 说 strip 0 有 2 段，QueryStrip 返回 0 段——两者都对，只是问的不是
  同一份配置。**别把它当成 bug**，也别用 State 的段数去断言 QueryStrip 的条数。
- **`probe-readonly-version.py` 的能力位是错的**：它打印 `info[8]`（那是
  `max_leds=100=0x64`）并标成「能力位」，真正的 caps 在偏移 13。`doctor.py` 用的是正确
  偏移，并会打印 `caps 0x01`。该脚本只适合看固件版本，不要拿它的 caps 做判断。
- **`LUMEN_FIRMWARE_VERSION` 不会随灯效扩增而变，doctor 判断不了「固件是否够新」。**
  #68 定下 `0x0400` 之后，#74（爆闪 / 心跳 / 熄灭）与 #98（流光密度 / 实色拖尾 /
  随机闪烁 `0x07`）**都没有再改这个常量**（`git show <commit>:firmware/main/ble_link.c`
  逐版本都是 `0x0400`）。所以 v4.0 只说明「协议大版本对」，不说明灯效齐不齐。
  本机实测这台设备：接受爆闪 / 心跳 / 熄灭（#74 已在），**拒绝随机闪烁 `0x07` 与
  流光的 `flags=0x0C`/`0x02`**（#98 不在）——它烧的是 #74 之后、#98 之前的构建。
- **判断固件新旧只能靠行为**，不能靠版本号。跑 `python scripts/probe-v4.py`：它按灯效
  逐条发段并读回，早期构建会在 #98 新增的那批用例上回 `InvalidParam`、其余全过，
  就是这个特征。**这不是协议 bug，是固件没跟上源码**——先确认烧入的构建，再判断代码对错。
- **MTU 由系统协商，`setBLEMTU` 不能强制**。网关的 `set_mtu` 会如实回报当前值并注明
  「bleak 不主动协商」。本机实测 247。
- **阈值是光敏性癫痫安全线**：呼吸 / 随机闪烁周期 `< 334ms`、彩虹 / 流星 `< 200ms`、
  爆闪 `< 100ms`、心跳不在 `500–1500ms`——这些会被设备按规则拒绝，不是实现缺陷。
- **同一时刻只能有一条 BLE 连接**。手机连着时 PC 扫不到；e2e 也不能并行跑
  （`vitest.e2e.config.ts` 已设 `fileParallelism: false`）。

## 7. 不覆盖的部分

- **渲染层**：`verify-lumen`（微信开发者工具 + miniprogram-automator）。
- **固件 host 单测**：`node scripts/test-run.mjs firmware`（或 `run-tests.cmd`）。
- **协议向量的静态校验**：`node scripts/check-protocol-testvectors-v4.mjs`（固件层会跑它；
  没有 node 时固件入口打印 `SKIPPED:` 标签而不是静默跳过）。
- **实际观感**（颜色 / 亮度 / 闪烁是否好看）：人眼或相机。
- **回连与 latest-wins 的竞态**：那是形式化验证的领域，不是本技能。
