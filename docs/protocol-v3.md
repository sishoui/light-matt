# lumen 协议规格 v3

**状态**：**已实现（2026-10-31，分支 `integration/lumen-v3`）**。本文件取代 `docs/protocol.md`（v2 已作废）。
固件 host 测试 11053 项断言与小程序 603 个单测都对着 `docs/protocol-testvectors-v3.json` 跑。
**适用范围**：微信小程序 ↔ ESP32-C3 固件之间的 BLE 协议。
**唯一真相**：本文件定义字节级契约，`docs/protocol-testvectors-v3.json` 是它的可执行副本。
改协议 = 本文件 + 测试向量 + 两端实现进同一个 commit。
**相关**：[灯效规格](./effects-spec.md)（参数块语义）、[v3 实现规格](./spec-v3.md)。

> **v3 不向后兼容。** 现场设备需重刷固件，小程序需整包更新。个人测试阶段没有第三方在用，
> 没有迁移代价（沿用 v2 的版本策略）。
>
> **v2 → v3 变了什么**：
> - 信封换成 **16 位长度 + CRC16 + BLE 分片重组**，逻辑帧上限从 20B 提到 **240B**；
> - `magic` 从 `0xA5` 改为 `0xA6`，版本号 `0x03`；
> - **段支持两层灯效叠加**，段载荷从 8/12 字节变成 9-21 字节；
> - 新增**每条灯带独立开关**、`QueryStripConfig`（读引脚）、`QueryDeviceInfo`（读 MAC 与能力）；
> - State 从 14 字节扩到 **37 字节**（带每条灯带的灯珠数/段数/动画位）；
> - 剧本阶段加 `fade_ms`（**预留，恒为 0**，行为仍是硬切）；
> - `ScriptCommit` 新增「持久化尺寸预检」，超限回 `ScriptTooLarge`，不再静默放弃持久化。

---

## 1. 角色与链路

- **小程序**是 central：写 RX、订阅 TX、读 State。
- **设备**是 peripheral：单连接，不配对，不绑定。
- 所有多字节字段 **小端**，除了 `hw_id`（§7.3）按 MAC 打印顺序原样给出。
- Kconfig 的引脚表决定物理灯带数，协议**不能改引脚映射**（只读，见 §10.6）。

### 1.1 常量

| 常量 | 值 | 说明 |
|---|---|---|
| `MAX_LEDS` | 64 | 单条灯带的灯珠上限（v3 固件冻结在 64；v4 #72 抬到 100，见 `docs/protocol-v4.md`） |
| `MAX_STRIPS` | 8 | 灯带数（8 个引脚，TDM 轮询） |
| `MAX_SEGMENTS` | 8 | **每条灯带**的段数 |
| `MAX_STAGES` | 8 | **每套剧本**的阶段数 |
| `MAX_SCRIPTS` | 4 | 设备侧可存剧本数 |
| `MAX_LAYERS` | 2 | 每段最多两层 |
| `MAX_STAGE_MS` | 65535 | 单阶段时长上限 |
| `NO_SCRIPT` | `0xFF` | `script_id` 表示「无激活剧本」 |
| `NO_EFFECT` | `0xFF` | 层类型表示「该层为空」 |
| `MAX_PAYLOAD` | 232 | 单条逻辑帧的载荷上限 |
| `MAX_FRAME` | 240 | `8 + MAX_PAYLOAD` |
| `MAX_CHUNK_DATA` | 179 | 单次 BLE 写的数据上限（见 §3.2） |

`strip_id` / `seg_id` / `stage_index` / `script_id` 均从 **0** 起。

---

## 2. GATT

**UUID 与 v2 完全一致**（连接发现逻辑不用改）：

| 特征 | UUID | 属性 |
|---|---|---|
| Service | `6c756d65-6e00-4b1e-9a3c-000000000001` | primary |
| RX | `6c756d65-6e00-4b1e-9a3c-000000000002` | `WRITE_NO_RSP` |
| TX | `6c756d65-6e00-4b1e-9a3c-000000000003` | `NOTIFY` |
| State | `6c756d65-6e00-4b1e-9a3c-000000000004` | `READ` |

广播名仍是 `Lumen-XXXX`（BT MAC 末两字节），但**它不再是设备身份**——身份用 `hw_id`（§7.3）。

### 2.1 MTU 协商（v3 新增，必须做）

- 设备在初始化时调用 `ble_att_set_preferred_mtu(247)`；连接后以实际协商结果为准，用
  `ble_att_mtu(conn_handle)` 取到 `mtu`。
- 小程序 Android 侧连接后调用 `wx.setBLEMTU(deviceId, 185)`；iOS 不允许设置，用系统协商值。
- **两端都必须在 `mtu` 未知时按 23 处理**（可用 20 字节），即最坏情况下也能工作。
- 单次写的最大字节数 `chunk_capacity = min(mtu - 3, 180)`。
- **单次写的数据上限** = `chunk_capacity - 1`（1 字节分片头），下限 `20 - 1 = 19`。

---

## 3. 帧格式

### 3.1 逻辑帧（v3 信封）

```
偏移  宽度  字段
0     1     magic   = 0xA6
1     1     version = 0x03
2     1     command
3     1     seq
4     2     length（载荷字节数，小端，0 ≤ length ≤ 232）
6     N     payload
6+N   2     crc16（小端）
```

- 整帧长度 = `8 + length`，上限 240。
- `crc16` 覆盖 **magic 到 payload 末字节**（即前 `6 + length` 字节）。
- **CRC16**：CCITT-FALSE，多项式 `0x1021`，初值 `0xFFFF`，不反转，无末尾异或。
  参考实现见 §3.4。

### 3.2 BLE 分片（传输层）

每一次 `write`（小程序→设备）或 `notify`（设备→小程序）都带 **1 字节分片头**：

```
byte 0: ctrl
  bit7      FIRST  —— 本逻辑帧的第一个分片
  bit6      LAST   —— 本逻辑帧的最后一个分片
  bit5..0   分片序号（0-63 循环，仅用于诊断，不要求连续）
byte 1..: 逻辑帧的连续切片
```

- **不分片的帧也必须带分片头**：`ctrl = 0xC0`。不允许「裸帧」形式——否则 `0xA6` 会和
  `FIRST|序号 0x26` 冲突，接收端无法区分。
- 分片顺序：`FIRST` 带序号 0，后续依次 +1，最后一个置 `LAST`。单分片时 `FIRST|LAST` 同为 1。
- 每个分片的数据长度 ≤ `chunk_capacity - 1`。

**接收端重组规则**（两端对称）：

1. 收到 `FIRST` 时，若已有未完成的重组缓冲，**丢弃旧缓冲重新开始**（latest-wins）。
2. 依次追加到 240 字节的静态缓冲，累计超过 240 → 丢弃缓冲、回 `BadLength (0x04)`。
3. 收到 `LAST` 时，按 §3.1 解析；解析失败按 §5 回对应结果码，然后清空缓冲。
4. **重组超时 1000ms**（自收到上一个分片起算）。超时丢弃缓冲，**不回 ACK**（此时 seq 可能已不可靠）。
   设备侧在 BLE 回调里检查，同时渲染任务每秒兜底清理一次。

> 为什么坚持「同步 ACK」：小程序一次只发一条命令、等 ACK 再发下一条（沿用 v2 的串行模型）。
> 分片只是让单条命令能更大，不改变「一问一答」的节奏，因此不需要窗口/流控。

### 3.3 帧示例

```
SetPower(on)，seq=1：载荷 1 字节 → 逻辑帧 9 字节
A6 03 01 01 01 00 01 F0 A0
│  │  │  │  └─┴len=1(小端)  └─┴crc16 = 0xA0F0
│  │  │  └seq                 （小端存 F0 A0）
│  │  └cmd=0x01
│  └ver=0x03
└magic=0xA6

分片后（单分片，ctrl = FIRST|LAST = 0xC0）：
C0 A6 03 01 01 01 00 01 F0 A0
```

### 3.4 CRC16 参考实现

```c
static uint16_t lumen_crc16(const uint8_t *data, size_t len)
{
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; ++i) {
        crc ^= (uint16_t)data[i] << 8;
        for (int b = 0; b < 8; ++b) {
            crc = (crc & 0x8000u) ? (uint16_t)((crc << 1) ^ 0x1021u) : (uint16_t)(crc << 1);
        }
    }
    return crc;
}
```

```ts
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
```

---

## 4. 版本

- `version != 0x03` → 回 `UnsupportedVersion (0x07)`，整个分片重组缓冲立刻丢弃。
- `magic != 0xA6` → 回 `BadMagic (0x08)`。
- 因为 magic 同时变更，v2 固件收到 v3 分片头（`0x80/0xC0`）会回 `BadMagic`，不会误解析。

---

## 5. 结果码

沿用 v2，**新增两个**：

| 值 | 名称 | 说明 |
|---|---|---|
| `0x00` | OK | |
| `0x01` | InvalidParam | 参数越界 / 区间重叠 / 周期过短 |
| `0x02` | UnknownCommand | 未知或本固件未实现的命令字 |
| `0x03` | BadChecksum | CRC16 不匹配 |
| `0x04` | BadLength | 长度字段越界 / 载荷长度与命令要求不符 / 重组溢出 |
| `0x05` | Busy | |
| `0x06` | StorageFailed | NVS 写入失败 |
| `0x07` | UnsupportedVersion | |
| `0x08` | BadMagic | |
| `0x09` | InternalError | |
| `0x0A` | **ScriptTooLarge** | 剧本编码后超过持久化上限（§10.5） |

校验顺序（固定）：分片重组 → magic → version → length 越界 → CRC16 → 命令已知 → 载荷长度 → 参数取值。

---

## 6. 命令（小程序 → 设备）

| 命令字 | 名称 | 载荷 | 长度 |
|---|---|---|---|
| `0x01` | SetPower | `power` | 1 |
| `0x02` | SetBrightness | `brightness` | 1 |
| `0x03` | *退役保留* | — | 回 `0x02` |
| `0x04` | *退役保留* | — | 回 `0x02` |
| `0x05` | QueryState | — | 0 |
| `0x06` | SetLedCount | `strip_id, count_lo, count_hi` | 3 |
| `0x07` | SelfTest | — | 0 |
| `0x10` | SetSegment | 见 §7.1 | 21 |
| `0x11` | ClearSegment | `strip_id, seg_id` | 2 |
| `0x12` | QueryStrip | `strip_id` | 1 |
| `0x13` | SetPlayback | `action, loop` | 2 |
| `0x14` | ScriptBegin | `script_id, stage_count, strip_count` | 3 |
| `0x15` | ScriptStage | `script_id, stage_index, duration, fade` | 6 |
| `0x16` | ScriptSegment | `script_id, stage_index` + §7.1 | 23 |
| `0x17` | ScriptCommit | `script_id` | 1 |
| `0x18` | ScriptAbort | `script_id` | 1 |
| `0x19` | ActivateScript | `script_id, loop` | 2 |
| `0x1A` | QueryScript | `script_id` | 1 |
| `0x1B` | **SetStripPower** | `strip_id, on` | 2 |
| `0x1C` | **QueryStripConfig** | — | 0 |
| `0x1D` | **QueryDeviceInfo** | — | 0 |
| `0x1E` | **ClearScript**（v4 新增，v3 固件回 `0x02`） | `script_id` | 1 |

- `0x08-0x0F`、`0x1F-0x7F` 保留；设备收到回 `0x02`。
- 小程序写入 `0x80-0xFF`（设备→小程序方向）→ `0x02`。
- `0x1E ClearScript` 是 **v4 原地新增**的命令（v4 文档 §6.1）。v3 固件的命令表里
  没有它，按 §5 的固定顺序在「命令已知」这一步回 `0x02 UnknownCommand`，
  **不误改任何配置并继续正常服务后续帧**。向量 `clear_script_unsupported_v3`
  锁住这条行为。协议版本号因此没有变化（新增命令不影响旧固件的安全拒绝）。

---

## 7. 数据布局

### 7.1 段（SetSegment / ScriptSegment / SegmentReport）

**段载荷是固定 21 字节。** 这是 v3 的一个刻意选择：层用**定宽 8 字节**编码，
不按 type 变长。代价是静态层浪费 4 字节，收益是两端解析不需要「先读 type 再定长」的
二次校验路径，段表结构、NVS 记录、报告帧全部同构，代码和测试都少一半分支。

`0x10 SetSegment` 的 21 字节载荷：

```
偏移  宽  字段
0     1   strip_id
1     1   seg_id
2     1   start      闭区间起点
3     1   end        闭区间终点，必须 < 该灯带灯珠数
4     1   blend      层 1 如何叠加到层 0（§7.2）
5     8   layer 0
13    8   layer 1
```

`0x16 ScriptSegment` 在末尾再追加 `script_id(1) + stage_index(1)` → **23 字节**。

**层编码（8 字节定宽）**：

```
偏移  宽  字段
0     1   type        0x00 静态 / 0x01 呼吸 / 0x02 彩虹 / 0x03 流光 / 0xFF 空层
1..7  7   param       参数块右对齐填满 7 字节，未用字节必须为 0
```

参数块语义见 `docs/effects-spec.md` §2（v3 沿用，未改）：

| type | 有效参数长度 | 在 `param[0..6]` 中的布局 |
|---|---|---|
| `0x00` 静态 | 3 | `hue(2 LE), sat(1)`；`param[3..6]` = 0 |
| `0x01` 呼吸 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(min_level), flags(波形)` |
| `0x02` 彩虹 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(span), flags(bit0 reverse)` |
| `0x03` 流光 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(tail), flags(bit0 reverse)` |
| `0xFF` 空层 | 0 | 全部 8 字节为 0（type 除外） |

**校验规则**（顺序固定）：

1. 载荷长度必须**精确等于** 21（`SetSegment`）/ 23（`ScriptSegment`），否则 `BadLength`。
2. `layer0.type` 必须是已知类型且 **不得为 `0xFF`**。
3. `layer1.type` 必须是已知类型或 `0xFF`。
4. `layer1.type == 0xFF` 时 `blend` 必须为 0。
5. `blend ≤ 0x02`。
6. 静态层的 `param[3..6]` 必须全为 0（保留位，防止将来语义漂移时旧固件静默接受）。
7. 各层按 type 做参数校验（周期下限、flags 保留位等，见 §11.3）。

**为什么不做变长**：v2 的变长方案（静态 8 / 动画 12）确实省 4 字节，但它带来
「未知 type 时无法确定长度边界」的问题，只能靠固定长度表兜底。v3 帧已经放大到 232 字节，
4 字节的浪费不再有意义，而定宽换来的是**任何未知 type 都能安全地判定为非法而不是越界读**。

**合法性约束**：

1. 两层都允许 `period_ms = 0` 表示静止。
2. 未知 type → `InvalidParam`（不静默降级，沿用 effects-spec D7）。

> **v3 的类型表冻结在四种。** 爆闪 `0x04` / 心跳 `0x05` / 熄灭 `0x06` 是 **v4 原地新增**的
> （#74，见 `docs/protocol-v4.md` §7.1 / §9.3.4）。**v3 固件不认识它们**，会走第 2 步的
> 「未知类型」路径回 `InvalidParam`——这正是 #74 验收里的「旧固件收到新类型按未知类型拒绝，
> 不静默降级成别的效果」。v3 向量因此只加**拒绝**用例（`set_segment_bad_strobe_type_unsupported`
> 一类），不加编码用例。
>
> 三种新类型复用现有 7 字节参数块，所以 v4 的层宽（9）、段载荷（23 / 25）、State（37）、
> blob（1440）与**协议版本号**都没有因为 #74 变化。

### 7.2 blend（层 1 叠加到层 0）

| 值 | 名称 | 公式（用户空间，0-255） |
|---|---|---|
| `0x00` | 覆盖 | `out = L1` |
| `0x01` | 相乘 | `out = (L0 * L1 + 127) / 255` |
| `0x02` | 相加 | `out = min(255, L0 + L1)` |

`blend` 只在 `layer1.type != 0xFF` 时生效。**不支持取最大值**（与相加视觉重合，已明确不做）。

### 7.3 State（37 字节）

State 特征值 read 与 `StateReport 0x82` 载荷同布局：

| 偏移 | 字段 | 宽度 | 说明 |
|---|---|---|---|
| 0 | power | 1 | 全局总开关 0/1 |
| 1 | brightness | 1 | 生效亮度（全局，已按 `max_brightness` 钳位） |
| 2 | R | 1 | strip 0 / seg 0 **层 0** 的基准色（不含动画包络） |
| 3 | G | 1 | 同上 |
| 4 | B | 1 | 同上 |
| 5 | max_brightness | 1 | 固件当前上限，当前构建值 200 |
| 6 | strip_count | 1 | 1-8 |
| 7 | script_id | 1 | `0xFF` = 无激活剧本 |
| 8 | stage_index | 1 | 当前阶段；无剧本时 0 |
| 9 | playback_state | 1 | 0 停止 / 1 播放 / 2 暂停 |
| 10 | flags | 1 | bit0 loop；bit1 script_active；bit2-7 保留 = 0 |
| 11 | strip_power_mask | 1 | bit i = 第 i 条灯带的独立开关 |
| 12 | strip_anim_mask | 1 | bit i = 第 i 条灯带当前有动画类活动段 |
| 13-28 | strip_counts[8] | 8×2 | 每条灯带的灯珠数（u16 小端） |
| 29-36 | strip_seg_counts[8] | 8×1 | 每条灯带的活动段数 |

- **实际是否出光 = 全局 `power` && `strip_power_mask` 对应位**。
- 亮度是**全局唯一值**，不分到灯带（已定）。每条灯带只有开关。
- `strip_anim_mask` 是渲染任务每帧维护的摘要，用于 App 判断「这条带是否在跑动画」，
  不需要逐带查询 `QueryStrip`。
- State 长度必须正好 37；小程序读到别的长度视为协议不匹配。

### 7.4 设备 → 小程序帧

| 命令字 | 名称 | 载荷 | 长度 | seq |
|---|---|---|---|---|
| `0x80` | ACK | `orig_command, result` | 2 | 回显请求 |
| `0x81` | Event | `event_code, detail` | 2 | 固定 `0x00` |
| `0x82` | StateReport | §7.3 | 37 | 回显请求 |
| `0x83` | SegmentReport | 与 §7.1 SetSegment 同构 | 9-21 | 回显 QueryStrip |
| `0x84` | SegmentListEnd | `strip_id, seg_mask` | 2 | 回显 QueryStrip |
| `0x85` | ScriptSummary | `script_id, stage_count, flags, active` | 4 | 回显 QueryScript |
| `0x86` | ScriptProgress | `script_id, frames_lo, frames_hi` | 3 | 回显下发请求 |
| `0x87` | **StripConfigReport** | 8 × `[strip_id, gpio, flags]` | 24 | 回显 QueryStripConfig |
| `0x88` | **DeviceInfoReport** | 见下 | 15 | 回显 QueryDeviceInfo |

**StripConfigReport** 的 `flags`：bit0 = 该路已分配（`i < strip_count`），bit1-7 保留 = 0。
未分配的记录 `gpio = 0xFF`。引脚表来自构建期 Kconfig，**协议只读**。

**DeviceInfoReport**：

```
0..1   firmware_version   u16，major<<8 | minor
2..7   hw_id              6 字节 BT MAC，按 "AA:BB:CC:DD:EE:FF" 的自然顺序
8      max_leds
9      max_strips
10     max_segments
11     max_stages
12     max_scripts
13     caps                bit0 = 支持两层叠加；bit1 = fade 已实现（当前为 0）
14     reserved = 0
```

**Event code**：`0x01` 存储失败（detail = 触发命令字）；`0x02` ScriptCommit 校验失败
（detail = script_id）；`0x03-0xFF` 保留。`ScriptTooLarge` **走 ACK 结果码 `0x0A`**，不走 Event。

---

## 8. seq 语义

与 v2 一致：每条连接从 `0x01` 起，每发一帧 +1，`0xFF` 后回 `0x00`；新连接重置。
分片头里的序号是**分片内序号**，与命令 seq 无关。

- ACK 的 seq 回显请求逻辑帧的 seq。
- 同 seq 多帧合法：`QueryStrip` 的所有 `SegmentReport` + `SegmentListEnd` 共用同一 seq。
- `QueryStripConfig` 固定一条报告；`QueryDeviceInfo` 固定一条报告。

---

## 9. 行为语义

### 9.1 重连重建 UI 的权威路径（v3）

```
读 State 特征值（37B）        → 全局开关/亮度/剧本状态/每条带灯珠数与段数
QueryStripConfig             → 8 路的 GPIO 分配（只读）
QueryDeviceInfo              → 固件版本、hw_id、能力上限
QueryStrip(strip) × 0..strip_count-1  → 每段的两层配置
QueryScript(id) × 0..MAX_SCRIPTS-1    → 已提交剧本摘要（按需）
```

- **不要缓存覆盖设备**：设备是唯一权威。
- `strip_anim_mask` 只作显示提示，不作为正确性依据。

### 9.2 分段模型

- 每条灯带独立 8 段；段区间 `start ≤ end < strip_counts[strip]`。
- **同带内段不得重叠**，重叠拒绝（`InvalidParam`），调用方需先清段。
- 未被任何段覆盖的灯珠**必须输出 0**（WS2812B 锁存，不清会留残影）。
- 修改某段只影响该段；其他段相位不重置。

### 9.3 两层渲染

对每颗灯珠：

1. 从该灯带的活动段里找到覆盖它的段（最多一个，因为不重叠）。
2. 没有段 → 输出 `(0,0,0)`。
3. 有段 → 分别求 `L0 = layer0.pixel(t)`、`L1 = layer1.pixel(t)`（两层各自持有自己的
   `t0_ms`，见 §9.4），再按 `blend` 合成。
4. 合成结果**之后**统一过 gamma 与全局亮度——两层都不做 gamma/亮度。

### 9.4 相位与 t0

- 每个**段**持有 `t0_ms`（两层共享一个时间原点），`SetSegment` / `ScriptSegment` 写入时置为当前时刻。
- 剧本切换阶段时，新阶段的每个段 `t0_ms` 重置为当前时刻（相位归零，与 v2 一致）。
- `t0_ms` 不持久化。

### 9.5 每条灯带独立开关（v3 新增）

- `SetStripPower(strip_id, on)` 只改该带掩码位，不影响其他带。
- 关某条带时，设备**先向该带推一帧全黑**，然后 TDM 轮询**跳过**该带——这既保证熄灭，
  也顺带省掉该路的 RMT 时间。
- 重新打开时立刻恢复渲染。
- 全局 `SetPower(0)` 对所有带生效（等于总闸），但**不改** `strip_power_mask`。

### 9.6 剧本下发流程

与 v2 相同，命令载荷换成 v3 布局：

```
ScriptBegin(script_id, stage_count, strip_count)      → ACK 0x00
ScriptStage(script_id, stage, duration_ms, fade_ms)   × stage_count → ACK
ScriptSegment(script_id, stage, ...)                  × 每个有内容的段 → ACK
ScriptCommit(script_id)                               → ACK 0x00 / 0x01 / 0x0A
ActivateScript(script_id, loop)                       → ACK 0x00
```

- **段的清空**：`ScriptSegment` 的两层都写 `0xFF` 表示「该槽位为空」，效果等同于不下发该段。
- `fade_ms` 当前**恒为 0**；非 0 值先**接受并存储**，但播放行为仍是硬切（格式预留，
  见 `docs/spec-v3.md` 的取舍记录）。
- 失败回滚：`ScriptCommit` 失败只丢暂存区，已提交的那一套不动。
- **删除一套方案**：v3 没有这个能力（`ScriptBegin` 要求 `stage_count ∈ 1..8`，
  下发不了「空剧本」）。v4 新增 `0x1E ClearScript`（§6 / v4 文档 §6.1）；
  v3 固件收到它回 `0x02`，配置不变——这也是「新增命令不必升协议版本」的依据。

### 9.7 自检

与 v2 相同：红→绿→蓝→白，每色 500ms。自检期间**忽略每带开关**（全部点亮），
结束后恢复。自检不受两层配置影响（纯色覆盖）。

---

## 10. 持久化

### 10.1 分区表（v3 变更）

4MB flash 下原来的 `SINGLE_APP_LARGE` 只给 NVS 24KB。v3 换自定义分区表：

```csv
# Name,   Type, SubType, Offset,   Size,     Flags
nvs,      data, nvs,     0x9000,   0x10000,
phy_init, data, phy,     0x19000,  0x1000,
factory,  app,  factory, 0x20000,  0x3E0000,
```

- NVS **64KB**（16 个 page）。
- app 分区 0x3E0000（≈3.9MB），当前固件约 1MB，余量充足。
- `sdkconfig.defaults` 改为 `CONFIG_PARTITION_TABLE_CUSTOM=y` +
  `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.csv"`。

### 10.2 State blob v4

```
0..3    magic 'L','M','E','N'
4..5    version = 4
6       power
7       brightness
8..10   r,g,b
11..12  led_count（strip 0，冗余）
13      strip_count
14      strip_power_mask
15..30  strip_counts[8]（u16 × 8）
31      seg_count（strip 0 的冗余摘要）
32..    段表：8 × 8 槽位 × 20 字节 = 1280
```

段记录 20 字节：`active(1) start(1) end(1) blend(1) layer0(8) layer1(8)`，
层编码与 §7.1 的 8 字节完全一致（type + 7 字节参数）。

总长 **1312 字节**。不持久化 `t0_ms`。

### 10.3 Script blob v2

```
0..3    magic 'L','M','S','3'
4..5    version = 2
6       active_script_id
7       flags（bit0 loop）
8..     4 个剧本槽位，按 id 升序：
          0 committed | 1 stage_count | 2 strip_count
          然后 stage_count 个阶段：
            0..1 duration_ms
            2..3 fade_ms
            然后 strip_count 组：[seg_mask(1)] [每个置位槽位一条记录]
          记录（槽位升序）：start(1) end(1) blend(1) layer0 layer1
          层编码：type(1) + param_len(type) 字节（0xFF 长度为 0）
```

### 10.4 上限与失败语义

| 项 | 上限 | 超限行为 |
|---|---|---|
| 剧本 blob | **16384 字节** | `ScriptCommit` 回 `ScriptTooLarge (0x0A)`，**不提交** |
| State blob | 1312 字节 | 固定，不会超 |

**不变式：能提交的剧本一定能持久化。** 这修掉了 v2 的缺陷——v2 允许提交、然后在
NVS 编码时静默放弃，导致「重启后剧本消失但界面上还在」。v3 把尺寸检查**前移到
`ScriptCommit`**：先编码到暂存缓冲，超限直接拒签，RAM 里也不会出现「已提交但存不下」的剧本。

**尺寸预算**（记录宽度 = `3 + (1+layer0参数) + (1+layer1参数)`，动画层参数 7、静态 3、空层 0）：

| 场景 | 单套 | 4 套合计 | 16KB 够吗 |
|---|---|---|---|
| 8 带 × 8 阶段 × 8 段，**两层全动画**（理论最坏） | 9792 B | 39176 B | ❌ 仅够 1 套 |
| 4 带 × 8 阶段 × 8 段，两层全动画 | 4896 B | 19584 B | ❌ 不够 4 套 |
| 2 带 × 4 阶段 × 4 段，两层全动画 | 616 B | 2464 B | ✅ 宽裕 |
| 1 带 × 4 阶段 × 3 段，一层静态一层动画 | 184 B | 736 B | ✅ 宽裕 |

**结论与应对**：

- **典型用法（1-2 条灯带、4-8 阶段、3-4 段）远低于上限**，16KB 绰绰有余。
- 理论最坏（8 带 × 8 阶段 × 8 段 × 两层动画）**装不下一整套 4 套剧本**，这是 4MB flash
  的物理限制，不是设计缺陷。此时 `ScriptCommit` 会明确回 `0x0A`，App 必须提示
  「剧本过大，请减少阶段数 / 每阶段段数 / 灯带数」。
- **不要为了装下最坏情况扩大 blob 上限**：40KB 的 NVS 写入要跨 10 个 page、上千条记录，
  C3 上提交耗时可达数百毫秒到数秒，期间掉电风险显著上升。宁可明确失败。

App 侧必须用同一公式在**下发前**预估，超限直接提示，不要等设备报到一半才失败。

### 10.5 默认值

与 v2 相同（关灯、亮度 128、暖白 255/180/120），补充：`strip_power_mask = 0xFF`（全部打开）、
每段 `layer1.type = 0xFF`、`blend = 0`、`fade_ms = 0`。

---

## 11. 测试向量

`docs/protocol-testvectors-v3.json` 是本文的可执行副本，字段：

```jsonc
{
  "protocol_version": 3,
  "magic": "0xA6",
  "crc16": "CCITT-FALSE poly 0x1021 init 0xFFFF",
  "cases": [
    {
      "name": "set_power_on",
      "direction": "app_to_device",
      "command": 1,
      "seq": 1,
      "payload_hex": "01",
      "frame_hex": "A60301...",        // 逻辑帧（含 CRC16）
      "chunks_hex": ["C0A60301..."],   // 按 MTU=247 分片后的实际写序列
      "frame_valid": true,
      "result_code": 0,
      "device_frames_hex": ["..."],     // 设备应回的帧（可选）
      "note": ""
    }
  ]
}
```

必须覆盖：每个命令的合法帧、每个命令的边界值、两层各种组合（空层 / 静态+静态 /
静态+动画 / 动画+动画）、三种 blend、非法 blend 与空 layer0、ScriptTooLarge、
分片重组（2 分片 / 3 分片 / 乱序 FIRST / 超长 / 超时）、CRC 错误、bad magic、坏长度。

**#74 的降级用例**：v3 固件不认识 v4 新增的爆闪 `0x04` / 心跳 `0x05` / 熄灭 `0x06`，
所以 v3 向量只加**拒绝**用例（`set_segment_bad_strobe_type_unsupported` 等），期望
`0x01 InvalidParam`——这正是「旧固件按未知类型拒绝，不静默降级」的证据。

---

## 12. 迁移清单（实现时必须同步改的地方）

| 端 | 文件 | 改什么 |
|---|---|---|
| 固件 | `main/protocol.[ch]` | 信封换成 16 位长度 + CRC16；magic/version |
| 固件 | `main/ble_link.c` | 分片重组缓冲、MTU 协商、State 37B、两条新报告 |
| 固件 | `main/effects.[ch]` | 层结构 `lumen_effect_layer_t`、blend 合成 |
| 固件 | `main/segment_store.[ch]` | 段结构两层化、校验规则 |
| 固件 | `main/led_render.c` | 两层合成后再过 gamma/亮度 |
| 固件 | `main/led_engine.c` | 每带开关、TDM 跳过、State 摘要扩展 |
| 固件 | `main/script_store.[ch]` | 阶段 fade、两层段、commit 尺寸预检 |
| 固件 | `main/state_blob.[ch]` / `script_blob.[ch]` | v4 / v2 blob |
| 固件 | `partitions.csv`（新增） / `sdkconfig.defaults` | 自定义分区表 |
| 固件 | `test/` | host 测试改用 v3 向量 |
| 小程序 | `utils/protocol/frame.ts` | 新信封 + CRC16 + 分片 |
| 小程序 | `utils/protocol/commands.ts` `types.ts` `constants.ts` | 两层段、新命令、State 37B |
| 小程序 | `utils/ble/transport.ts` | 分片写、分片收、MTU |
| 小程序 | `utils/control/session.ts` | 拆出 strip 维度、每带开关 |
| 小程序 | `pages/**` | 按 `docs/spec-v3.md` §5 拆页 |
| 后端 | `src/schema.ts` | `devices` / `user_devices` 表 + 迁移 version 2 |
| 后端 | `src/app.ts` `auth.ts` | `POST /api/v1/session`、设备 API |

---

## 13. 变更规则

- 改任何字节布局 = 本文件 + 测试向量 + 两端实现同一个 commit。
- **新增命令字必须同时更新 `querystrip` 风格的报告与 ACK 语义**，不允许「只发不收」。
- 预留位（flags 的保留位、`caps` 的保留位、`fade_ms`）**只能由本文件授权后启用**。
