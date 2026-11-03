# lumen 协议规格 v4

**状态**：**已实现（2026-11-03，分支 `feat/68-protocol-v4`；2026-11-04 原地扩展 #98）**。
本文件取代 `docs/protocol-v3.md`（v3 保留为历史参考，不再维护）。
固件 host 测试 13996 项断言与 `docs/protocol-testvectors-v4.json`（93 条向量）
都对着本文件跑。
**适用范围**：微信小程序 ↔ ESP32-C3 固件之间的 BLE 协议。
**唯一真相**：本文件定义字节级契约，`docs/protocol-testvectors-v4.json` 是它的可执行副本。
改协议 = 本文件 + 测试向量 + 两端实现进同一个 commit。
**相关**：[灯效规格](./effects-spec.md)（参数块语义）、[v3 规格](./protocol-v3.md)（历史）。

> **读 `effects-spec.md` 时注意**：那份文档是 **v2/v3 语义**的历史定义，其中
> 呼吸 `min_level` 是「绝对 0-255」、层编码是 8 字节。**本文件（v4）取代了这两点**：
> `p5` 改为相对百分比 0-100（`> 100` 一律 `InvalidParam`），层扩到 9 字节并新增 `level`。
> 参数块的类型枚举、色相 / 周期 / 公式形态不变。冲突时**一律以本文件为准**。

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
| `MAX_LEDS` | 100 | 单条灯带的灯珠上限（#72 从 64 抬高） |
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
| `0x13` | SetPlayback | `action, loop`（loop 0/1/2，见 §7.5） | 2 |
| `0x14` | ScriptBegin | `script_id, stage_count, strip_count` | 3 |
| `0x15` | ScriptStage | `script_id, stage_index, duration, fade` | 6 |
| `0x16` | ScriptSegment | `script_id, stage_index` + §7.1 | **25**（v3: 23） |
| `0x17` | ScriptCommit | `script_id` | 1 |
| `0x18` | ScriptAbort | `script_id` | 1 |
| `0x19` | ActivateScript | `script_id, loop`（loop 0/1/2，见 §7.5） | 2 |
| `0x1A` | QueryScript | `script_id` | 1 |
| `0x1B` | SetStripPower | `strip_id, on` | 2 |
| `0x1C` | QueryStripConfig | — | 0 |
| `0x1D` | QueryDeviceInfo | — | 0 |
| `0x1E` | ClearScript | `script_id` | 1 |

- `0x08-0x0F`、`0x1F-0x7F` 保留；设备收到回 `0x02`。
- 小程序写入 `0x80-0xFF`（设备→小程序方向）→ `0x02`。

### 6.1 ClearScript（`0x1E`，v4 原地新增）

真正从设备上**删掉**一套已提交剧本，而不是只删小程序本机的草稿。

| 结果码 | 触发条件 |
|---|---|
| `0x00` OK | 已清空；**该 id 本来就没有已提交剧本也算成功**（幂等） |
| `0x01` InvalidParam | `script_id >= 4`（`LUMEN_MAX_SCRIPTS`） |
| `0x04` BadLength | 载荷长度 ≠ 1 |
| `0x02` UnknownCommand | 旧固件（不认识 `0x1E`）；**它不会误改任何东西** |
| `0x06` StorageFailed | 落盘预检失败；RAM 里的剧本**原样保留**，仍可用 |

语义：

- 清空后该 id 的 `stage_count` 回 **0**，`QueryScript` 的 `ScriptSummary` 给出
  `stage_count = 0 / flags = 0 / active = 0`（与查询一个从未提交的 id 完全一致），
  State 里若它是激活剧本则 `script_id = 0xFF`、`stage_index = 0`、`playback_state = 0`、
  `flags.bit1 = 0`。
- **清空正在播放（或暂停 / 播完停住）的那套**：播放停止、设备退回「无激活剧本」，
  画面交回静态段配置。判定是「当前激活 id == 被清 id」，越界 id 永远不算命中。
- **未提交即成功**：对一个从未提交过的 id 发清空也回 `0x00`。理由与 `ClearSegment`
  相同——它是绝对值语义（「让这个槽位为空」），让用户处理「本来就没有」这种无害情况
  只会制造需要重试的错误。
- **不影响其它 id**：只有目标槽位被抹掉，其它剧本、段配置与播放状态原样。
- 若该 id 正在暂存（`ScriptBegin` 之后还没 `Commit`），暂存也一并丢弃——否则
  「清空 → Abort」会留下不可预期的中间态。
- 失败时**什么都不改**：先按「清空后」的状态编码一遍持久化快照，编得出来才改 RAM。
  因此 `StorageFailed` 之后原剧本仍可正常播。
- **落盘的异步失败**（NVS 在 500ms debounce 后真正写入时失败）无法再改 ACK——ACK
  已经发出。这条路径与 `ScriptCommit` 共用，按 §10.3 的异步语义上报 `Event 0x81`
  （`event_code = 0x01 StorageFailed`），App 应在收到后重试或提示。也就是说 `0x06`
  只覆盖「预检时就知道存不下」的同步失败。

**为什么不是 `script_id` 换成 `ScriptBegin(0 阶段)` 或 `ScriptCommit` 一个空剧本**：
两条路径都要求 `stage_count ∈ 1..8`（§9.6），表达不了「这套方案不存在」。
用一条显式命令，语义与失败语义都能单独定义。

**为什么协议版本号不变**：`0x1E` 原来落在保留区，旧固件的命令表里没有它，
按 §5 的固定顺序在「命令已知」这一步就回 `0x02 UnknownCommand` 并**继续正常服务
后续帧**（不会把连接搞坏，也不会误改配置）。新增一条命令因此不需要两端同时升级，
也就不需要升 `0x04` ——升版本会让所有旧固件对全部帧回 `0x07`，代价远大于收益。
这条取舍只对「新增命令」成立：**任何已存在命令的载荷或语义变化仍然必须升版本**。

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
0     1   type        0x00 静态 / 0x01 呼吸 / 0x02 彩虹 / 0x03 流光 /
                      0x04 爆闪 / 0x05 心跳 / 0x06 熄灭 / 0x07 随机闪烁 /
                      0xFF 空层
1..7  7   param       参数块右对齐填满 7 字节，未用字节必须为 0
8     1   level       v4 新增：本层亮度档位 0-100（100 满亮，0 不出光）
```

参数块语义见 `docs/effects-spec.md` §2 —— **但那份文档写的是 v2/v3 的 `min_level`（绝对 0-255）**；
v4 下呼吸的 `p5` 是**相对百分比 0-100**（见下方 `level` 语义与 §9.3），冲突以本文件为准：

| type | 有效参数长度 | 在 `param[0..6]` 中的布局 |
|---|---|---|
| `0x00` 静态 | 3 | `hue(2 LE), sat(1)`；`param[3..6]` = 0 |
| `0x01` 呼吸 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(minLevel **%), flags(波形)` |
| `0x02` 彩虹 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(span), flags(bit0 reverse)` |
| `0x03` 流光 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(tail), flags(bit0 reverse / bit1 实色拖尾 / bit2-3 头数量-1)` |
| `0x04` 爆闪 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(duty), flags(必须 0)` |
| `0x05` 心跳 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(pulse), flags(bit0 双脉冲)` |
| `0x06` 熄灭 | 7 | 全部 0（`hue/sat/p5/period/flags` 任一非 0 → `InvalidParam`） |
| `0x07` 随机闪烁 | 7 | `hue(2 LE), sat(1), period_ms(2 LE), p5(亮着的比例), flags(必须 0)` |
| `0xFF` 空层 | 0 | 其余 8 字节（param 7 + level 1）全为 0 |

> **#74 的三种新类型与 #98 的随机闪烁复用同一个 7 字节参数块**，所以层编码仍是
> 9 字节、段载荷仍是 23 / 25、报告仍是 23、状态 blob 仍是 1440、**协议版本号仍是 4**。
> 它们没有吃掉 effects-spec §2.8 记录的「动画类只剩 2 字节余量」——余量原封不动。

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
8. 各层按 type 做参数校验（周期下限、flags 保留位、**呼吸 `p5 ≤ 100`**，见 §11.3）：
   - `0x00` 静态：`flags == 0`；
   - `0x01` 呼吸：`flags & 0xF8 == 0`，`p5 ≤ 100`，`period == 0` 或 `≥ 334`；
   - `0x02` 彩虹：`flags & 0xFE == 0`，`period == 0` 或 `≥ 200`；
   - **`0x03` 流光（#98 扩展）**：`flags & 0xF0 == 0`（bit4-7 保留），`period == 0`
     或 `≥ 200`；bit0 = reverse、bit1 = 实色拖尾、bit2-3 = 头数量 - 1（0..3 ⇒ 1..4 个）；
   - **`0x04` 爆闪（#74）**：`flags == 0`，`period == 0` 或 `≥ 100`（10Hz 上界）；
   - **`0x05` 心跳（#74）**：`flags & 0xFE == 0`（bit0 = 双脉冲），`period == 0` 或 `500-1500`（40-120 BPM）；
   - **`0x06` 熄灭（#74）**：`hue / sat / p5 / flags / period_ms` 全部为 0；
   - **`0x07` 随机闪烁（#98）**：`flags == 0`，`period == 0` 或 `≥ 334`（3Hz，与呼吸同一条安全线）。
9. 熄灭层的 `level` **不参与**上述参数校验（熄灭本来就是黑的），但 `level ≤ 100` 仍由第 4 步统一约束。

> **熄灭必须同时出现在 `lumen_effect_type_known` 与 `lumen_effect_type_implemented` 里**，
> 否则第 2 步（只认「已知且已实现」）会把它作为 layer0 拒绝。
>
> **熄灭不算动画类型**（`lumen_effect_is_animated` 显式枚举：静态与熄灭为 false）。
> 这不影响协议字节，只影响渲染层是否为「一整组只有熄灭」的配置启动帧循环。
>
> **流光的多头 / 实色拖尾（#98）用的是同一字节的保留位**：旧固件只认 bit0
> （`flags & 0xFE == 0`），所以带 bit1-3 的流光在旧固件上回 `InvalidParam`，
> 不会静默丢掉密度或拖尾形状——这正是「旧固件安全拒绝」的依据。
>
> **随机闪烁 `0x07` 是全新的类型值**：旧固件的已知类型表里没有它，
> 按第 2 步（`layer0` 必须已知且已实现）回 `InvalidParam`，不改任何配置。
>
> **熄灭作为 layer1（叠加层）**：协议层不额外拒绝——语义就是「黑色叠加」
> （覆盖 / 相乘都会把整段变黑）。界面层不提供这个选项（#80 / #81），
> 协议层不必为它写特例：语义明确，且 `blend` 的既有规则已经覆盖。

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
| 10 | flags | 1 | bit0 循环中；bit1 script_active；bit2 最后一步循环；bit3-7 保留 = 0（§7.5） |
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

`ScriptSummary` 的 `flags` 与 State 字节 10 是**同一张位表**（§7.5）：
bit0 = 循环中、bit1 = active、bit2 = 最后一步循环、bit3-7 = 0。未激活剧本只报 0
（循环是播放属性，未激活剧本没有独立的循环存储位置）。
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

### 7.5 循环字段（`loop`）

`SetPlayback (0x13)` 与 `ActivateScript (0x19)` 的第二个字节从布尔扩成三值
（#98）。**值就是线上字节，不做重映射**：

| 值 | 名称 | 语义 |
|---|---|---|
| `0x00` | 不循环 | 走完最后一步停在最后一帧（`hold_last`），`playback_state = 0` |
| `0x01` | 全部循环 | 走完最后一步回到第 0 步 |
| `0x02` | 最后一步循环 | 第 0..N-2 步各播一次，第 N-1 步**原地重播** |
| `0x03-0xFF` | 非法 | `InvalidParam (0x01)`，不改任何配置 |

- **旧固件天然安全拒绝**：它们原本的实现就是 `loop > 1 → InvalidParam`，
  所以 `0x02` 会被拒收且不产生副作用，不需要额外迁移代码。
- **持久化与上报共用一张位表**（§7.3 / §7.4 / §10.3）：
  `bit0 = 循环中`（`loop != 0`，**保留旧语义**，旧读者仍能看到「在循环」）、
  `bit1 = 有激活剧本 / active`、`bit2 = 最后一步循环`（`loop == 2`）、`bit3-7` 保留 = 0。
  因此 `loop = 1` 写 `0x01`、`loop = 2` 写 `0x05`。
- 剧本 blob 的 flags 没有「激活」概念（激活 id 是独立字段），`bit1` 恒 0；
  解码时 `bit1` 或 `bit3-7` 非 0、或 `bit2` 单独出现（无 `bit0`）都**整份拒收**。

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

#### 9.3.4 流光的多头与实色拖尾（#98）

头数量 `H = (flags bit2-3) + 1`（1..4），沿整条**均分**。每个灯珠的权重是
所有头的**最大值**（绝不相加，重叠处不会亮度翻倍）：

```
phase    = (now - t0) / period            // [0,1)
head_k   = round(k × N / H)               // 0..N-1，k = 0..H-1
p_k      = ((i / N) - phase - head_k / N) mod 1
tail_n   = 1 + (tail/255) × (N-1)          // 以灯珠数计
w_i      = max over k of  head_gain(p_k)
```

`head_gain(p)`：

- **衰减拖尾（flags bit1 = 0）**：`p × N < tail_n` 时 `exp(-3 × p × N / tail_n)`，
  否则 0（即 effects-spec §3.4 的原公式）。
- **实色拖尾（flags bit1 = 1）**：`p × N < 1` 那颗是头（Q16 满值），其余落在尾巴里的
  是固定的 **75%**（Q16 `49152`）。头与尾之间因此始终保留一颗的亮暗台阶，
  不会糊成一条同亮的块。`tail = 0` 时尾巴为空，仍然只有头。
- `N` 不能被 `H` 整除时头位置四舍五入到整颗灯，各头亮度因此始终对齐。

#### 9.3.5 随机闪烁（#98）

每颗灯珠按自己的哈希相位做确定性亮灭方波：

```
seed      = mix(i, N, t0_ms)              // 16 位，同一份配置下是常量
s_i       = seed / 65536                  // 该灯的空间相位
time      = (now - t0) / period           // [0,1)；period = 0 时恒 0
p         = (time + s_i) mod 1
duty      = p5 / 255
gain      = square_with_5pct_ramps(p, duty)   // 与爆闪同一套边沿
```

- **确定性**：`seed` 不含 `now_ms`，所以同一颗灯在同一时刻反复求值结果一致；
  它不是逐帧白噪声。`t0_ms` 参与种子，因此「重新下发同一份配置」会换来一张
  新的分布图，而同一份配置期间它不变。
- **密度**：`p5` 是同时亮着的比例。各灯的 `s_i` 均匀撒在 `[0,1)`，所以任一时刻
  亮的比例约等于 `p5/255`；`p5 = 0` 全灭、`p5 = 255` 几乎常亮。
- `period == 0` 时时间相位不前进，画面冻结在一张固定分布上。

#### 9.3.6 爆闪 / 心跳 / 熄灭的合成（#74）

三种新类型与呼吸一样是**整段同色同步**（包络只与时间有关，与段内位置无关），
所以每颗灯的求值都是 `static_rgb(hue, sat) × level/100 × envelope(t)`：

| 类型 | 包络（0-1） | 说明 |
|---|---|---|
| `0x04` 爆闪 | 方波 + 两端 5% 线性斜坡，高电平占比 `p5(duty)/255` | `period == 0` → 0（不出光） |
| `0x05` 心跳 | 0..w 升到 1；2w..3w 升到 0.6；其余 0（`w = max(pulse/255, 1%)`） | `flags` bit0 = 双脉冲；`period == 0` → 0 |
| `0x06` 熄灭 | 恒 0（直接返回全黑，不读任何参数） | 不受 `level` 影响 |

完整公式与相位推导见 `docs/effects-spec.md` §2.5-§2.7。

> **帧率上界**：默认 20fps（每帧 50ms），所以 10Hz 是爆闪能表现的上界。
> 本票**不提高帧率**——8 条满 100 颗时提高帧率会掉帧，那种掉帧比低频更糟。

> **熄灭不是动画类型**：`lumen_effect_is_animated` 只对静态与熄灭返回 false。
> 协议层不影响字节语义，但决定渲染任务是否为「一整组只有熄灭」的配置启动帧循环。

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
ActivateScript(script_id, loop)                       → ACK 0x00（loop 0/1/2）
ClearScript(script_id)                                → ACK 0x00 / 0x01 / 0x06
```

- **删掉一套方案用 `ClearScript 0x1E`**（§6.1），不是「下发一套空剧本」：
  `ScriptBegin` 要求 `stage_count ∈ 1..8`，表达不了「这套不存在」。清空是幂等的，
  清掉的正是激活剧本时停播并退回无激活。
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
7       flags（bit0 循环中、bit1 恒 0、bit2 最后一步循环、bit3-7 保留 = 0；§7.5）
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

**整份拒绝**：长度 < 8 / magic 不符 / version ≠ 3 / flags 的 `bit1` 或 `bit3-7`
非 0 / `bit2` 单独出现（无 `bit0`）/ 激活 id 指向未提交剧本 —— 任一不符返回
`false`，调用方必须重新 `lumen_script_store_init()`。

> 旧固件对 blob flags 的检查是 `flags & 0xFE != 0 → 拒`，所以带 `bit2` 的
> 新 blob 会被旧固件明确拒收，而不是被当成「不循环」静默降级。

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

`docs/protocol-testvectors-v4.json` 是本文的可执行副本（93 条用例），字段：

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

**`#74` 三种新灯效的向量**（爆闪 / 心跳 / 熄灭）：

| 用例 | 期望 |
|---|---|
| `set_segment_single_strobe` | OK（爆闪，period 100ms、duty 90、level 100） |
| `set_segment_single_heartbeat` | OK（心跳，period 1000ms、pulse 60、双脉冲） |
| `set_segment_single_off` | OK（熄灭，参数全 0） |
| `set_segment_strobe_plus_heartbeat` | OK（爆闪打底 + 心跳相乘，证明两种新类型都能作叠加层） |
| `set_segment_bad_strobe_period` | `0x01`（period 99ms < 100ms 下限） |
| `set_segment_bad_strobe_flags` | `0x01`（爆闪 flags 非 0） |
| `set_segment_bad_heartbeat_period_low` | `0x01`（499ms < 500ms） |
| `set_segment_bad_heartbeat_period_high` | `0x01`（1501ms > 1500ms） |
| `set_segment_bad_heartbeat_flags` | `0x01`（心跳 flags bit1 非 0） |
| `set_segment_bad_off_params` | `0x01`（熄灭带 hue） |

v3 向量里对应加一条 `set_segment_bad_strobe_type_unsupported` / 同类用例：
v3 固件不认识 `0x04`-`0x06`，按未知类型回 `InvalidParam`（**不静默降级**）。

**`#98` 流光密度 / 实色拖尾 / 随机闪烁 / 循环三值的向量**：

| 用例 | 期望 |
|---|---|
| `set_segment_comet_heads_1` | OK（flags = 0x00，1 个头） |
| `set_segment_comet_heads_2` | OK（flags = 0x04，2 个头） |
| `set_segment_comet_heads_4` | OK（flags = 0x0C，4 个头） |
| `set_segment_comet_solid_tail` | OK（flags = 0x02，实色拖尾） |
| `set_segment_comet_heads4_solid_reverse` | OK（flags = 0x0F，4 头 + 实色 + 反向） |
| `set_segment_bad_comet_flags_reserved` | `0x01`（flags bit4 非 0） |
| `set_segment_single_flicker` | OK（`0x07`，period 1000ms、duty 128） |
| `set_segment_flicker_plus_static` | OK（随机闪烁作 layer1，相乘） |
| `set_segment_bad_flicker_period` | `0x01`（333ms < 334ms） |
| `set_segment_bad_flicker_flags` | `0x01`（随机闪烁 flags 非 0） |
| `set_playback_loop_last` | OK（loop = 2） |
| `activate_script_loop_last` | OK（loop = 2） |
| `set_playback_loop_invalid` | `0x01`（loop = 3） |
| `activate_script_loop_invalid` | `0x01`（loop = 3） |
| `state_report_loop_last` | OK（flags = 0x07：循环中 + 激活 + 最后一步循环） |

**`0x1E ClearScript`（#73）的向量**：

| 用例 | 期望 |
|---|---|
| `clear_script` | OK（seq 62，`script_id = 0`） |
| `clear_script_last_slot` | OK（seq 63，`script_id = 3`，最后一个合法槽位） |
| `clear_script_bad_id` | `0x01` InvalidParam（`script_id = 4`） |

生成器：`scripts/gen-protocol-testvectors-v4.mjs`（层构造器默认 `level = 100`，
断言 23 / 25 字节）。
独立校验器：`scripts/check-protocol-testvectors-v4.mjs`（只读 JSON，不信任生成器；
另外校验「合法帧里每层 level ≤ 100」「空层 level 必须 0」「三档都有向量」，
以及 **#74 / #98 的类型规则**：已知八种类型、各类型的 flags 保留位与周期区间、
熄灭层参数全 0、三种新类型的编码用例与边界拒绝用例，以及 **#98 的流光 flags
位域（bit4-7 必须 0）、随机闪烁（flags = 0、周期 ≥ 334）、循环三值（2 接受、
3 拒绝）**）。

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

**v4 内的增量改动（#73，ClearScript 0x1E）**——协议版本号**不变**，所以不是迁移项，
但改动的落点是固定的：

| 端 | 文件 | 改什么 |
|---|---|---|
| 固件 | `main/protocol.h` | `LUMEN_CMD_CLEAR_SCRIPT = 0x1E` |
| 固件 | `main/command.c/h` | `is_known` / `payload_len` / dispatch；outcome 加 `clear_script` + `clear_script_id` |
| 固件 | `main/script_store.c/h` | `lumen_script_store_clear`、`lumen_script_should_deactivate`（纯逻辑，host 可测） |
| 固件 | `main/script_blob.c/h` | `lumen_script_blob_encode_with_cleared`（落盘前容量预检） |
| 固件 | `main/led_engine.c/h` | `lumen_led_engine_clear_script`（锁内清空 + 激活态回退 + 持久化） |
| 固件 | `main/ble_link.c` | `outcome.clear_script` 分支 |
| 固件 | `test/test_skeleton.c` | 清空 / 幂等 / 越界 / 激活回退判定 / 预检编码 |
| 向量 | `scripts/gen-*.mjs` / `check-*.mjs` | v4 三条用例；v3 一条「未知命令」用例 |
| 小程序 | `utils/protocol/*` | `CMD.CLEAR_SCRIPT = 0x1E` + `cmdClearScript`（调用方是 #83） |

**v4 内的增量改动（#98，流光密度 / 随机闪烁 / 循环三值）**——协议版本号同样**不变**：

| 端 | 文件 | 改什么 |
|---|---|---|
| 固件 | `main/effects.h/.c` | `LUMEN_EFFECT_FLICKER = 0x07`；流光 flags 位定义；`lumen_layer_comet_gain_q16` 多头（取 max）+ 实色拖尾；`lumen_effect_flicker_phase_seed` / `_gain_q16` |
| 固件 | `main/segment_store.c` | 流光 flags 保留位改成 `0xF0`（bit0-3 有含义）；新增随机闪烁的 flags / 周期校验 |
| 固件 | `main/script_store.h` | `lumen_loop_mode_t`（0/1/2）+ State / ScriptSummary / blob 共用的 flags 位表与两个转换 helper |
| 固件 | `main/script_store.c` | 「最后一步循环」在 `lumen_script_playback_tick` 里原地重播 |
| 固件 | `main/command.c/h` | loop 边界 `> LUMEN_LOOP_MAX`（0x13 / 0x19），`script_loop` 从 bool 变 uint8 |
| 固件 | `main/led_engine.c/h` | `activate_script` / `set_playback` 收 `uint8_t loop`；State flags 与 ScriptSummary flags 走同一张位表 |
| 固件 | `main/script_blob.c/h` | blob flags 按位表编码 / 解码（bit1 与 bit3-7 拒收） |
| 固件 | `main/state_store.c/h` | `load_scripts` 的 `loop` 出参改 `uint8_t` |
| 固件 | `test/test_skeleton.c` | 流光 1/2/3/4 头、取 max、实色 vs 衰减、随机闪烁确定性与密度、最后一步循环、循环非法值、blob 三档往返 |
| 向量 | `scripts/gen-*.mjs` / `check-*.mjs` | #98 的 15 条用例 + 类型 / 位域规则 |
| 小程序 | `utils/protocol/*` | `SEGMENT_TYPE.FLICKER = 0x07`；流光 `cometFlags/cometHeads/cometSolidTail`；`LOOP` 三值与 `assertLoopMode`；State / ScriptSummary 的循环位解析 |

---

## 13. 变更规则

- 改任何字节布局 = 本文件 + 测试向量 + 两端实现同一个 commit。
- **新增命令字必须同时更新对应的报告与 ACK 语义**，不允许「只发不收」。
  **例外（唯一）**：v4 原地新增的 `0x1E ClearScript` 不需要报告帧——它的结果完全由
  ACK 承载，而清空后的状态用已有的 `QueryScript` / State 即可读到（§6.1）。
- 预留位（flags 的保留位、`caps` 的保留位、`fade_ms`）**只能由本文件授权后启用**。
- `level` 的取值范围（0-100）与空层规则是本契约的一部分，**不要**在实现里放宽成 0-255。
