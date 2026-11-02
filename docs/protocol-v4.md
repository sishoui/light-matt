# lumen 协议规格 v4

**状态**：**已实现（2026-11-03，分支 `feat/68-protocol-v4`）**。本文件取代 `docs/protocol-v3.md`
（v3 保留为历史参考，不再维护）。
固件 host 测试 11441 项断言与 `docs/protocol-testvectors-v4.json`（64 条向量）
都对着本文件跑。
**适用范围**：微信小程序 ↔ ESP32-C3 固件之间的 BLE 协议。
**唯一真相**：本文件定义字节级契约，`docs/protocol-testvectors-v4.json` 是它的可执行副本。
改协议 = 本文件 + 测试向量 + 两端实现进同一个 commit。
**相关**：[灯效规格](./effects-spec.md)（参数块语义）、[v3 规格](./protocol-v3.md)（历史）。

> **v4 不向后兼容。** 现场设备需重刷固件，小程序需整包更新。个人测试阶段没有第三方在用，
> 没有迁移代价（沿用 v2 / v3 的版本策略）。
>
> **刷机后设备配置回到默认值**：旧固件写下的 State blob（版本 4、1312 字节）与脚本 blob
> （magic `LMS3` / 版本 2）在新固件里**整份拒绝**，上电回落到协议默认值。这是设计取舍，
> 不是缺陷——见 §10.2 / §10.3。
>
> **v3 → v4 变了什么**：
> - **层编码从 8 字节扩到 9 字节**，新增第 9 字节 `level`（0-100，本层亮度档位）；
> - `SetSegment` 载荷 **21 → 23**、`ScriptSegment` 载荷 **23 → 25**、
>   `SegmentReport` **21 → 23**；
> - **逐层亮度**：每层先按 `level` 压暗，再 blend，最后乘全局亮度并过 gamma 一次；
> - **呼吸的最暗基线改为相对百分比**：谷底 = 本层 `level` × `minLevel%`；
> - **合成顺序改为「先乘亮度、再 gamma 一次」**（v3 是「先 gamma、再乘亮度」）；
> - State blob 版本 **4 → 5**、段记录 **20 → 22**、总长 **1312 → 1440**；
> - 脚本 blob magic `LMS3` → **`LMS4`**、版本 **2 → 3**、单条记录上限 19 → **21**；
> - 协议版本号 `0x03` → **`0x04`**，固件版本号 `0x0300` → **`0x0400`**；
> - 帧上限不变（240 字节），信封结构不变。

---

## 1. 角色与链路

- **小程序**是 central：写 RX、订阅 TX、读 State。
- **设备**是 peripheral：单连接，不配对，不绑定。
- 所有多字节字段 **小端**，除了 `hw_id`（§7.3）按 MAC 打印顺序原样给出。
- Kconfig 的引脚表决定物理灯带数，协议**不能改引脚映射**（只读，见 §10.6）。

### 1.1 常量

| 常量 | 值 | 说明 |
|---|---|---|
| `MAX_LEDS` | 64 | 单条灯带的灯珠上限 |
| `MAX_STRIPS` | 8 | 灯带数（8 个引脚，TDM 轮询） |
| `MAX_SEGMENTS` | 8 | **每条灯带**的段数 |
| `MAX_STAGES` | 8 | **每套剧本**的阶段数 |
| `MAX_SCRIPTS` | 4 | 设备侧可存剧本数 |
| `MAX_LAYERS` | 2 | 每段最多两层 |
| `MAX_STAGE_MS` | 65535 | 单阶段时长上限 |
| `NO_SCRIPT` | `0xFF` | `script_id` 表示「无激活剧本」 |
| `NO_EFFECT` | `0xFF` | 层类型表示「该层为空」 |
| `LAYER_LEVEL_MAX` | 100 | **v4**：层亮度上限（百分比） |
| `MAX_PAYLOAD` | 232 | 单条逻辑帧的载荷上限 |
| `MAX_FRAME` | 240 | `8 + MAX_PAYLOAD` |
| `MAX_CHUNK_DATA` | 179 | 单次 BLE 写的数据上限（见 §3.2） |
| `SEGMENT_BYTES` | **23** | **v4**：段载荷（5 字节头 + 2 × 9 字节层） |

`strip_id` / `seg_id` / `stage_index` / `script_id` 均从 **0** 起。

---

## 2. GATT

**UUID 与 v2 / v3 完全一致**（连接发现逻辑不用改）：

| 特征 | UUID | 属性 |
|---|---|---|
| Service | `6c756d65-6e00-4b1e-9a3c-000000000001` | primary |
| RX | `6c756d65-6e00-4b1e-9a3c-000000000002` | `WRITE_NO_RSP` |
| TX | `6c756d65-6e00-4b1e-9a3c-000000000003` | `NOTIFY` |
| State | `6c756d65-6e00-4b1e-9a3c-000000000004` | `READ` |

广播名仍是 `Lumen-XXXX`（BT MAC 末两字节），但**它不再是设备身份**——身份用 `hw_id`（§7.3）。

### 2.1 MTU 协商（v3 起，必须做）

- 设备在初始化时调用 `ble_att_set_preferred_mtu(247)`；连接后以实际协商结果为准，用
  `ble_att_mtu(conn_handle)` 取到 `mtu`。
- 小程序 Android 侧连接后调用 `wx.setBLEMTU(deviceId, 185)`；iOS 不允许设置，用系统协商值。
- **两端都必须在 `mtu` 未知时按 23 处理**（可用 20 字节），即最坏情况下也能工作。
- 单次写的最大字节数 `chunk_capacity = min(mtu - 3, 180)`。
- **单次写的数据上限** = `chunk_capacity - 1`（1 字节分片头），下限 `20 - 1 = 19`。

---

## 3. 帧格式

### 3.1 逻辑帧

```
偏移  宽度  字段
0     1     magic   = 0xA6
1     1     version = 0x04
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
   设备侧在 BLE 回调里检查，同时 `esp_timer` 每秒兜底清理一次。

> 为什么坚持「同步 ACK」：小程序一次只发一条命令、等 ACK 再发下一条（沿用 v2 / v3 的串行模型）。
> 分片只是让单条命令能更大，不改变「一问一答」的节奏，因此不需要窗口/流控。

### 3.3 帧示例

```
SetPower(on)，seq=1：载荷 1 字节 → 逻辑帧 9 字节
A6 04 01 01 01 00 01 68 B1
│  │  │  │  └─┴len=1(小端)  └─┴crc16 = 0x68B1
│  │  │  └seq                 （小端存 68 B1）
│  │  └cmd=0x01
│  └ver=0x04
└magic=0xA6

分片后（单分片，ctrl = FIRST|LAST = 0xC0）：
C0 A6 04 01 01 01 00 01 68 B1
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

- `version != 0x04` → 回 `UnsupportedVersion (0x07)`，整个分片重组缓冲立刻丢弃。
- `magic != 0xA6` → 回 `BadMagic (0x08)`。
- **收到 v3 帧（version = 0x03）一律回 0x07**，不做双版本解码。坏帧只影响它自己：
  重组器在 COMPLETE 后已复位，后续合法帧照常服务（host 测试 `test_reject_v2_protocol_frames`
  锁住这条）。
- magic 与 v3 相同（`0xA6`），所以 v4 与 v3 只能靠 version 区分；**不要**把 version 校验
  挪到 CRC 之后——坏 CRC 的 v3 帧会被当成 `BadChecksum` 而不是 `UnsupportedVersion`。

---

## 5. 结果码

沿用 v3，值不变：

| 值 | 名称 | 说明 |
|---|---|---|
| `0x00` | OK | |
| `0x01` | InvalidParam | 参数越界 / 区间重叠 / 周期过短 / **层亮度 > 100** / **空层带非零亮度** |
| `0x02` | UnknownCommand | 未知或本固件未实现的命令字 |
| `0x03` | BadChecksum | CRC16 不匹配 |
| `0x04` | BadLength | 长度字段越界 / 载荷长度与命令要求不符 / 重组溢出 |
| `0x05` | Busy | |
| `0x06` | StorageFailed | NVS 写入失败 |
| `0x07` | UnsupportedVersion | |
| `0x08` | BadMagic | |
| `0x09` | InternalError | |
| `0x0A` | ScriptTooLarge | 剧本编码后超过持久化上限（§10.4） |

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
| `0x10` | SetSegment | 见 §7.1 | **23**（v3: 21） |
| `0x11` | ClearSegment | `strip_id, seg_id` | 2 |
| `0x12` | QueryStrip | `strip_id` | 1 |
| `0x13` | SetPlayback | `action, loop` | 2 |
| `0x14` | ScriptBegin | `script_id, stage_count, strip_count` | 3 |
| `0x15` | ScriptStage | `script_id, stage_index, duration, fade` | 6 |
| `0x16` | ScriptSegment | `script_id, stage_index` + §7.1 | **25**（v3: 23） |
| `0x17` | ScriptCommit | `script_id` | 1 |
| `0x18` | ScriptAbort | `script_id` | 1 |
| `0x19` | ActivateScript | `script_id, loop` | 2 |
| `0x1A` | QueryScript | `script_id` | 1 |
| `0x1B` | SetStripPower | `strip_id, on` | 2 |
| `0x1C` | QueryStripConfig | — | 0 |
| `0x1D` | QueryDeviceInfo | — | 0 |

- `0x08-0x0F`、`0x1E-0x7F` 保留；设备收到回 `0x02`。
- 小程序写入 `0x80-0xFF`（设备→小程序方向）→ `0x02`。

---

## 7. 数据布局

### 7.1 段（SetSegment / ScriptSegment / SegmentReport）

**段载荷是固定 23 字节**（v3 是 21）。层用**定宽 9 字节**编码（v3 是 8），不按 type 变长。
代价是静态层浪费 5 字节，收益是两端解析不需要「先读 type 再定长」的二次校验路径，
段表结构、NVS 记录、报告帧全部同构。

`0x10 SetSegment` 的 23 字节载荷：

```
偏移  宽  字段
0     1   strip_id
1     1   seg_id
2     1   start      闭区间起点
3     1   end        闭区间终点，必须 < 该灯带灯珠数
4     1   blend      层 1 如何叠加到层 0（§7.2）
5     9   layer 0
14    9   layer 1
```

`0x16 ScriptSegment` = 两个前缀字节 `script_id(1) + stage_index(1)` **在最前面**，
其后紧跟 §7.1 的 23 字节段 → **25 字节**（v3 是 23）。

**层编码（9 字节定宽）**：

```
偏移  宽  字段
0     1   type        0x00 静态 / 0x01 呼吸 / 0x02 彩虹 / 0x03 流光 / 0xFF 空层
1..7  7   param       参数块右对齐填满 7 字节，未用字节必须为 0
8     1   level       v4 新增：本层亮度档位 0-100（100 满亮，0 不出光）
```

参数块语义见 `docs/effects-spec.md` §2：

| type | 有效参数长度 | 在 `param[0..6]` 中的布局 |
|---|---|---|
| `0x00` 静态 | 3 | `hue(2 LE), sat(1)`；`param[3..6]` = 0 |
| `0x01` 呼吸 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(minLevel **%), flags(波形)` |
| `0x02` 彩虹 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(span), flags(bit0 reverse)` |
| `0x03` 流光 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(tail), flags(bit0 reverse)` |
| `0xFF` 空层 | 0 | 其余 8 字节（param 7 + level 1）全为 0 |

**`level` 的语义**：

- 取值 **0-100**。`100` 等于 v3 的行为（满亮），`0` 表示这一层不出光。
- **`> 100` 一律 `InvalidParam`**。不做钳位、不做回绕——明确拒绝比静默改变用户意图安全。
- **空层（`type = 0xFF`）的 `level` 必须为 0**，否则 `InvalidParam`。空层没有亮度可言，
  携带非零亮度说明发送端把「清槽」和「压暗」搞混了。
- `level` 是**独立字节**，不受静态层「`param[3..6]` 必须全 0」那条保留位规则的约束。
  `level = 0` 的静态层**仍然**要求 `param[3..6] = 0`——亮度为零不会让参数校验失效。
- 呼吸层的 `p5`（最暗基线）在 v4 是**相对百分比 0-100**（v3 是绝对 0-255）。
  **101-255 一律 `InvalidParam`**。实际谷底 = `level × p5 / 100`（见 §9.3）。

**校验规则**（顺序固定）：

1. 载荷长度必须**精确等于** 23（`SetSegment`）/ 25（`ScriptSegment`），否则 `BadLength`。
2. `layer0.type` 必须是已知类型且 **不得为 `0xFF`**。
3. `layer1.type` 必须是已知类型或 `0xFF`；**若为空层，整个 9 字节（param + level）必须全 0**。
4. **任一层 `level ≤ 100`**。
5. `layer1.type == 0xFF` 时 `blend` 必须为 0。
6. `blend ≤ 0x02`。
7. 静态层的 `param[3..6]` 必须全为 0（保留位，对两层都生效）。
8. 各层按 type 做参数校验（周期下限、flags 保留位、**呼吸 `p5 ≤ 100`**，见 §11.3）。

**ScriptSegment 的清槽旁路**：两层都 `0xFF` 表示「清空该槽位」（§9.6）。这条路径
**绕过**上面的形状校验（它会把 layer0 = 0xFF 判成非法），所以必须**单独**要求两层的
`level` 都为 0；否则回 `InvalidParam`（不是清槽）。回归：向量
`script_segment_clear_level_nonzero`、host 测试 `test_script_segment_clear_slot_level`。

**为什么不做变长**：v2 的变长方案省 5 字节，但它带来「未知 type 时无法确定长度边界」
的问题。v4 帧上限 232 字节，5 字节浪费没有意义，而定宽换来的是**任何未知 type 都能安全
地判定为非法而不是越界读**。

### 7.2 blend（层 1 叠加到层 0）

| 值 | 名称 | 公式（用户空间，0-255） |
|---|---|---|
| `0x00` | 覆盖 | `out = L1` |
| `0x01` | 相乘 | `out = (L0 * L1 + 127) / 255` |
| `0x02` | 相加 | `out = min(255, L0 + L1)` |

`blend` 只在 `layer1.type != 0xFF` 时生效。**不支持取最大值**（与相加视觉重合，已明确不做）。

**v4：`L0` / `L1` 都是「已按本层 level 压暗后」的值**——level 在 blend 之前施加
（见 §9.3），所以「相乘」是两块各自带亮度的用户空间像素相乘。

### 7.3 State（37 字节）

State 特征值 read 与 `StateReport 0x82` 载荷同布局（v4 未改，仍是 37 字节）：

| 偏移 | 字段 | 宽度 | 说明 |
|---|---|---|---|
| 0 | power | 1 | 全局总开关 0/1 |
| 1 | brightness | 1 | 生效亮度（全局，已按 `max_brightness` 钳位） |
| 2 | R | 1 | strip 0 / seg 0 **层 0** 的基准色（不含动画包络、**不含 level**） |
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
- 亮度是**全局唯一值**；每层的 `level` **不进 State**（见 §9.3 与 §7.3 的 R/G/B 说明）。
- **R/G/B 是「色」，不含 level**：裁决为不乘。否则调低某光区的亮度会让 App 里显示的
  「当前颜色」跟着变暗，用户无法区分「颜色变了」与「变暗了」。
- `strip_anim_mask` 是渲染任务每帧维护的摘要，用于 App 判断「这条带是否在跑动画」，
  不需要逐带查询 `QueryStrip`。
- State 长度必须正好 37；小程序读到别的长度视为协议不匹配。
- **要读回每段的 `level` 必须逐段 `QueryStrip`**——State 里没有逐段亮度字段。

### 7.4 设备 → 小程序帧

| 命令字 | 名称 | 载荷 | 长度 | seq |
|---|---|---|---|---|
| `0x80` | ACK | `orig_command, result` | 2 | 回显请求 |
| `0x81` | Event | `event_code, detail` | 2 | 固定 `0x00` |
| `0x82` | StateReport | §7.3 | 37 | 回显请求 |
| `0x83` | SegmentReport | 与 §7.1 SetSegment 同构 | **23**（固定） | 回显 QueryStrip |
| `0x84` | SegmentListEnd | `strip_id, seg_mask` | 2 | 回显 QueryStrip |
| `0x85` | ScriptSummary | `script_id, stage_count, flags, active` | 4 | 回显 QueryScript |
| `0x86` | ScriptProgress | `script_id, frames_lo, frames_hi` | 3 | 回显下发请求 |
| `0x87` | StripConfigReport | 8 × `[strip_id, gpio, flags]` | 24 | 回显 QueryStripConfig |
| `0x88` | DeviceInfoReport | 见下 | 15 | 回显 QueryDeviceInfo |

> v3 文档 §7.4 的 SegmentReport 长度写成 "9-21"，与 §7.1 的「固定 21」矛盾。
> **v4 统一为固定 23 字节**——报告与下发同构，没有变长形态。

**StripConfigReport** 的 `flags`：bit0 = 该路已分配（`i < strip_count`），bit1-7 保留 = 0。
未分配的记录 `gpio = 0xFF`。引脚表来自构建期 Kconfig，**协议只读**。

**DeviceInfoReport**：

```
0..1   firmware_version   u16，major<<8 | minor（v4 固件为 0x0400）
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

与 v2 / v3 一致：每条连接从 `0x01` 起，每发一帧 +1，`0xFF` 后回 `0x00`；新连接重置。
分片头里的序号是**分片内序号**，与命令 seq 无关。

- ACK 的 seq 回显请求逻辑帧的 seq。
- 同 seq 多帧合法：`QueryStrip` 的所有 `SegmentReport` + `SegmentListEnd` 共用同一 seq。
- `QueryStripConfig` 固定一条报告；`QueryDeviceInfo` 固定一条报告。

---

## 9. 行为语义

### 9.1 重连重建 UI 的权威路径

```
读 State 特征值（37B）        → 全局开关/亮度/剧本状态/每条带灯珠数与段数
QueryStripConfig             → 8 路的 GPIO 分配（只读）
QueryDeviceInfo              → 固件版本、hw_id、能力上限
QueryStrip(strip) × 0..strip_count-1  → 每段的两层配置（**含每层 level**）
QueryScript(id) × 0..MAX_SCRIPTS-1    → 已提交剧本摘要（按需）
```

- **不要缓存覆盖设备**：设备是唯一权威。
- `strip_anim_mask` 只作显示提示，不作为正确性依据。

### 9.2 分段模型

- 每条灯带独立 8 段；段区间 `start ≤ end < strip_counts[strip]`。
- **同带内段不得重叠**，重叠拒绝（`InvalidParam`），调用方需先清段。
- 未被任何段覆盖的灯珠**必须输出 0**（WS2812B 锁存，不清会留残影）。
- 修改某段只影响该段；其他段相位不重置。

### 9.3 合成顺序（v4 的核心变化）

对每颗灯珠：

1. 从该灯带的活动段里找到覆盖它的段（最多一个，因为不重叠）。
2. 没有段 → 输出 `(0,0,0)`。
3. 有段 → 分别求 `L0 = layer0.pixel(t)`、`L1 = layer1.pixel(t)`。**每层求值后立即按
   自己的 `level` 逐通道压暗**（`round(value × level / 100)`）；呼吸层的包络谷底也
   是 `level × p5 / 100`（见下）。
4. 按 `blend` 在**用户空间**合成 `L0` / `L1`。
5. **合成结果乘全局亮度**（用户空间）：`round(v × brightness / 255)`。
6. **过 gamma 一次**：`out = gamma(v)`。色相丢失截断在 gamma 之后（§9.3.2）。

形式化（单通道，0-255）：

```
layer_i_user  = level_i(value_i)                 // i = 0,1；呼吸的谷底也含 level_i
blended       = blend(L0_user, L1_user)
out           = gamma( round(blended × brightness / 255) )
```

**这就是「每层 × level → blend → × 全局 brightness → gamma 一次」。**

#### 9.3.1 与 v3 的差异

v3 是 **先 gamma、再乘亮度**：`out = gamma(v) × brightness / 255`。
v4 是 **先乘亮度、再 gamma**：`out = gamma(v × brightness / 255)`。

两者在 `brightness = 255` 时逐字节相同；`brightness < 255` 时数值不同：

| 输入 | brightness | v3（先 gamma） | v4（先乘亮度） |
|---|---|---|---|
| 128 | 128 | 78 × 128 / 255 ≈ **39** | gamma(64) = **28** |
| 255 | 128 | 255 × 128 / 255 = 128 | gamma(128) = 78 |

v4 更暗、暗部层次更符合物理直觉，且让 `level` 与 `brightness` 严格按乘积生效。
**所有 brightness < 255 的既有真机基线都会偏移**——这是协议升级的可观测后果，不是 bug。

#### 9.3.2 色相丢失截断

8bit 输出在极暗处装不下色相（橙色呼吸到谷底只剩红）。规则不变：**输入有 ≥2 个非零通道、
gamma 输出只剩 <2 个 → 整颗归零**。判据仍是**输入**（含亮度、不含 gamma）的非零通道数。

#### 9.3.3 呼吸的谷底

v4 呼吸层 `p5` 是相对百分比：

```
floor = level × p5 / 100            // 百分比
gain  = floor + (level - floor) × e // e = 波形包络 0-1
```

- `level = 100, p5 = 0` → 0..100%（v3 里 `min_level = 0` 的等价行为）。
- `level = 100, p5 = 100` → 恒 100%（几乎不呼吸，与 v3 的 `min_level = 255` 等价）。
- `level = 50, p5 = 0` → 0..50%（峰值半亮）。
- `level = 50, p5 = 100` → 恒 50%（完全不呼吸）。

### 9.4 相位与 t0

- 每个**段**持有 `t0_ms`（两层共享一个时间原点），`SetSegment` / `ScriptSegment` 写入时置为当前时刻。
- 剧本切换阶段时，新阶段的每个段 `t0_ms` 重置为当前时刻（相位归零，与 v2 / v3 一致）。
- `t0_ms` 不持久化。

### 9.5 每条灯带独立开关

- `SetStripPower(strip_id, on)` 只改该带掩码位，不影响其他带。
- 关某条带时，设备**先向该带推一帧全黑**，然后 TDM 轮询**跳过**该带——这既保证熄灭，
  也顺带省掉该路的 RMT 时间。
- 重新打开时立刻恢复渲染。
- 全局 `SetPower(0)` 对所有带生效（等于总闸），但**不改** `strip_power_mask`。

### 9.6 剧本下发流程

与 v3 相同，命令载荷换成 v4 布局：

```
ScriptBegin(script_id, stage_count, strip_count)      → ACK 0x00
ScriptStage(script_id, stage, duration_ms, fade_ms)   × stage_count → ACK
ScriptSegment(script_id, stage, ...)                  × 每个有内容的段 → ACK
ScriptCommit(script_id)                               → ACK 0x00 / 0x01 / 0x0A
ActivateScript(script_id, loop)                       → ACK 0x00
```

- **段的清空**：`ScriptSegment` 的两层都写 `0xFF` 表示「该槽位为空」，效果等同于不下发该段。
  **两层的 `level` 都必须为 0**，否则 `InvalidParam`（这条路径绕过形状校验，必须在命令层
  与剧本层各自显式判一次）。
- `fade_ms` 当前**恒为 0**；非 0 值先**接受并存储**，但播放行为仍是硬切（格式预留）。
- 失败回滚：`ScriptCommit` 失败只丢暂存区，已提交的那一套不动。

### 9.7 自检

与 v2 / v3 相同：红→绿→蓝→白，每色 500ms。自检期间**忽略每带开关**（全部点亮），
结束后恢复。自检不受两层配置与 level 影响（纯色覆盖，走单色路径）。

---

## 10. 持久化

### 10.1 分区表（v3 起，v4 不变）

4MB flash 下 `SINGLE_APP_LARGE` 只给 NVS 24KB。v3 起换自定义分区表：

```csv
# Name,   Type, SubType, Offset,   Size,     Flags
nvs,      data, nvs,     0x9000,   0x10000,
phy_init, data, phy,     0x19000,  0x1000,
factory,  app,  factory, 0x20000,  0x3E0000,
```

- NVS **64KB**（16 个 page）。
- app 分区 0x3E0000（≈3.9MB），当前固件约 1MB，余量充足。

### 10.2 State blob v5

**版本号是 5，不是 4**——v3 的 State blob 已经用掉 4（记录 20 字节）。v4 必须用 5 才能与
已落盘的 v3 blob 区分。

```
0..3    magic 'L','M','E','N'
4..5    version = 5
6       power
7       brightness
8..10   r,g,b
11..12  led_count（strip 0，冗余）
13      strip_count
14      strip_power_mask
15..30  strip_counts[8]（u16 × 8）
31      seg_count（strip 0 的冗余摘要）
32..    段表：8 × 8 槽位 × 22 字节 = 1408
```

段记录 **22 字节**：`active(1) start(1) end(1) blend(1) layer0(9) layer1(9)`，
层编码与 §7.1 的 9 字节完全一致（type + 7 字节参数 + level）。

总长 **1440 字节**（32 + 64 × 22）。不持久化 `t0_ms`。

**整份拒绝**（`lumen_state_blob_decode` 的先决条件）：

- 长度 ≠ 1440 → 拒（**v3 的 1312 字节 blob 在这里就被拒**）；
- magic ≠ `LMEN` → 拒；
- version ≠ 5 → 拒（含 v3 的 4）；
- 字段 / 形状 / 区间 / 重叠任一项不符 → 拒。

**失败时一个字节都不写 `out`**，调用方保留 `lumen_state_defaults()`。因此「刷机后设备配置
回到默认值」是**实现本身的性质**，不需要额外迁移代码——旧 blob 与默认值之间不存在
「半套加载」。

### 10.3 Script blob v3

magic 同时升级（`LMS3` → `LMS4`）、版本 2 → 3：v4 每条记录多出 level 字节，旧的 `LMS3` v2
按新布局读会整份错位（level 被当成下一层的 type）。

```
0..3    magic 'L','M','S','4'
4..5    version = 3
6       active_script_id
7       flags（bit0 loop）
8..     4 个剧本槽位，按 id 升序：
          0 committed | 1 stage_count | 2 strip_count
          然后 stage_count 个阶段：
            0..1 duration_ms
            2..3 fade_ms
            然后 strip_count 组：[seg_mask(1)] [每个置位槽位一条记录]
          记录（槽位升序）：start(1) end(1) blend(1) layer0 layer1
          层编码：
            非空层：type(1) + param_len(type) 字节 + level(1)
            空层  ：仅 type(1) = 0xFF（**不写 level**，空层 level 恒 0）
```

**记录宽度按层类型变长**：静态层 1+3+1 = 5、动画层 1+7+1 = 9、空层 1。
一条记录是 `3 + w(layer0) + w(layer1)`，取值 **5..21**（v3 是 5..19，多出的 2 是两个
level 字节）。对应 `LUMEN_SCRIPT_SEGMENT_MIN = 3`（记录头）与
`LUMEN_SCRIPT_SEGMENT_MAX = 21`（v3 是 19）。

**整份拒绝**：长度 < 8 / magic 不符 / version ≠ 3 / flags 保留位非 0 / 激活 id 指向未提交
剧本 —— 任一不符返回 `false`，调用方必须重新 `lumen_script_store_init()`。

### 10.4 上限与失败语义

| 项 | 上限 | 超限行为 |
|---|---|---|
| 剧本 blob | **16384 字节** | `ScriptCommit` 回 `ScriptTooLarge (0x0A)`，**不提交** |
| State blob | **1440 字节** | 固定，不会超 |

**不变式：能提交的剧本一定能持久化。** 尺寸检查**前移到 `ScriptCommit`**：先编码到暂存
缓冲，超限直接拒签，RAM 里也不会出现「已提交但存不下」的剧本。

**尺寸预算**（记录宽度 = `3 + (1 + 1 + 参数0) + (1 + 1 + 参数1)`，动画层参数 7、静态 3、空层 0）：

| 场景 | 单套 | 4 套合计 | 16KB 够吗 |
|---|---|---|---|
| 8 带 × 8 阶段 × 8 段，**两层全动画**（理论最坏） | 10752 B | 43008 B | ❌ 仅够 1 套 |
| 4 带 × 8 阶段 × 8 段，两层全动画 | 5376 B | 21504 B | ❌ 不够 4 套 |
| 2 带 × 4 阶段 × 4 段，两层全动画 | 672 B | 2688 B | ✅ 宽裕 |
| 1 带 × 4 阶段 × 3 段，一层静态一层动画 | 204 B | 816 B | ✅ 宽裕 |

**结论与应对**：

- **典型用法（1-2 条灯带、4-8 阶段、3-4 段）远低于上限**，16KB 绰绰有余。
- 理论最坏装不下一整套 4 套剧本，这是 4MB flash 的物理限制，不是设计缺陷。
  此时 `ScriptCommit` 会明确回 `0x0A`，App 必须提示「剧本过大」。
- **不要为了装下最坏情况扩大 blob 上限**：40KB 的 NVS 写入要跨 10 个 page、上千条记录，
  C3 上提交耗时可达数百毫秒到数秒，期间掉电风险显著上升。宁可明确失败。

### 10.5 默认值

与 v2 / v3 相同（关灯、亮度 128、暖白 255/180/120），补充：`strip_power_mask = 0xFF`
（全部打开）、每段 `layer1.type = 0xFF`、`layer1.level = 0`、`layer0.level = 100`、
`blend = 0`、`fade_ms = 0`。

### 10.6 RAM 代价（v4 记录）

层 8 → 9 字节、段 24 → 28 字节（`t0_ms` 的 4 字节对齐）：

| 结构 | v3 | v4 |
|---|---|---|
| `lumen_effect_layer_t` | 8 | **9** |
| `lumen_segment_t` | 24 | **28** |
| `lumen_segment_store_t` | 1536 | **1792** |
| `lumen_script_stage_t` | ≈1538 | ≈**1796** |
| `lumen_script_store_t` | ≈61.5 KB | ≈**70 KB** |
| `lumen_persist_t` | ≈1.07 KB | ≈**1.83 KB** |
| State blob | 1312 | **1440** |

存储任务栈 `CONFIG_LUMEN_STORE_TASK_STACK_SIZE = 5120`：编码时栈上同时有
`lumen_persist_t`（≈1.83 KB）与 1440 字节 blob，合计约 3.3 KB，余量约 1.8 KB。
**不要压回 4 KB 以下**。

---

## 11. 测试向量

`docs/protocol-testvectors-v4.json` 是本文的可执行副本（64 条用例），字段：

```jsonc
{
  "protocol_version": 4,
  "magic": "0xA6",
  "crc16": "CCITT-FALSE poly 0x1021 init 0xFFFF",
  "cases": [
    {
      "name": "set_power_on",
      "direction": "app_to_device",
      "command": 1,
      "seq": 1,
      "payload_hex": "01",
      "frame_hex": "A604...",         // 逻辑帧（含 CRC16）
      "chunks_hex": ["C0A604..."],    // 按 MTU=247 分片后的实际写序列
      "frame_valid": true,
      "result_code": 0,
      "note": ""
    }
  ]
}
```

必须覆盖：每个命令的合法帧、每个命令的边界值、两层各种组合（空层 / 静态+静态 /
静态+动画 / 动画+动画）、三种 blend、非法 blend 与空 layer0、ScriptTooLarge、
分片重组（2 分片 / 3 分片）、CRC 错误、bad magic、坏长度，以及 **v4 的层亮度**：

| 用例 | 期望 |
|---|---|
| `set_segment_level_0` | OK（层 0 不出光） |
| `set_segment_level_50` | OK（半亮） |
| `set_segment_level_100` | OK（满亮，等价 v3） |
| `set_segment_bad_level_101` | `0x01` InvalidParam |
| `set_segment_bad_empty_level` | `0x01`（空层带 level 50） |
| `script_segment_clear_level_nonzero` | `0x01`（清槽旁路 + level 30） |

生成器：`scripts/gen-protocol-testvectors-v4.mjs`（层构造器默认 `level = 100`，
断言 23 / 25 字节）。
独立校验器：`scripts/check-protocol-testvectors-v4.mjs`（只读 JSON，不信任生成器；
另外校验「合法帧里每层 level ≤ 100」「空层 level 必须 0」「三档都有向量」）。

---

## 12. 迁移清单（v3 → v4 实现时同步改的地方）

| 端 | 文件 | 改什么 |
|---|---|---|
| 固件 | `main/protocol.h` | `LUMEN_VERSION` 0x03 → 0x04；SegmentReport 注释 21 → 23 |
| 固件 | `main/protocol.c` | SegmentReport 23 字节、layer1 偏移 14、数组 `[9]` |
| 固件 | `main/effects.h/.c` | 层结构加 `level`（8 → 9）；`lumen_layer_encode/decode`；`lumen_effect_apply_level_q8`；`lumen_effect_breathing_gain_pct_q16`；`lumen_layer_pixel` 按 level 压暗 |
| 固件 | `main/gamma.h/.c` | 新增 `lumen_gamma_apply_pixel_scaled`（先乘亮度、再 gamma）；`lumen_gamma_apply_pixel` 保留 |
| 固件 | `main/led_render.c` | 改用 `lumen_gamma_apply_pixel_scaled` |
| 固件 | `main/command.c` | `LUMEN_WIRE_SEGMENT_BYTES` 23、layer1 偏移 14、长度表 23 / 25、**清槽旁路加 level 校验** |
| 固件 | `main/segment_store.c/h` | `lumen_segment_validate_shape` 加 level 规则（≤100、空层 =0、呼吸 p5 ≤100） |
| 固件 | `main/script_store.c` | 清槽路径要求两层 level 均为 0 |
| 固件 | `main/state_blob.h/.c` | 段记录 22、版本 5、layer1 偏移 13 |
| 固件 | `main/script_blob.h/.c` | magic `LMS4`、版本 3、MAX 21、编解码读 level |
| 固件 | `main/ble_link.c` | 报告数组 `[9]`、`LUMEN_FIRMWARE_VERSION` 0x0400 |
| 固件 | `main/Kconfig.projbuild` / `state_store.c` | blob 1440 的栈预算注释 |
| 固件 | `test/test_skeleton.c` | 偏移 / 长度 / 结构体尺寸；helper 默认 level=100；重推 gamma 数值；新增 level 边界用例 |
| 固件 | `test/run-tests.cmd` | 向量与 checker 换 v4 |
| 小程序 | `utils/protocol/*` | 层 9 字节、段 23 / 25、`PROTOCOL_VERSION = 0x04`、逐层 level（票 #69） |
| 后端 | — | **无影响**（`server/` 不持有任何 wire 常量） |

---

## 13. 变更规则

- 改任何字节布局 = 本文件 + 测试向量 + 两端实现同一个 commit。
- **新增命令字必须同时更新对应的报告与 ACK 语义**，不允许「只发不收」。
- 预留位（flags 的保留位、`caps` 的保留位、`fade_ms`）**只能由本文件授权后启用**。
- `level` 的取值范围（0-100）与空层规则是本契约的一部分，**不要**在实现里放宽成 0-255。
