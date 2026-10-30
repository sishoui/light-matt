# lumen 协议规格 v2

**状态**：定稿（2026-10-31）。**v1 已退役**——旧固件与新小程序互相回 `UnsupportedVersion (0x07)`，不做兼容解析。
**适用范围**：微信小程序 ↔ ESP32-C3 固件之间的 BLE 协议。
**唯一真相**：本文件定义字节级契约，`docs/protocol-testvectors.json` 是它的可执行副本。改协议 = 本文件 + 测试向量 + 两端实现进同一个 commit。
**相关**：[灯效规格](./effects-spec.md)（参数块布局的唯一真相）、[实现规格 v2](./spec-v2.md)、[固件架构](./firmware-architecture.md)。

> **v1 → v2 变了什么**：`version` = `0x02`；State 从 8 字节扩到 **14 字节**；`0x03 SetColor` / `0x04 SetAll` **退役**；`SetLedCount` 载荷加 `strip_id`；新增 11 条段/剧本命令（`0x10`–`0x1A`）与 4 条设备回报帧（`0x83`–`0x86`）。
> **没变的**：信封结构、校验和算法、校验顺序、结果码、seq 语义、ACK 时序、自检、持久化机制——全部原样沿用 v1。

---

## 1. 角色与链路

- **小程序**是 central：写 RX、订阅 TX、读 State。
- **设备**是 peripheral：单连接，不配对，不绑定。
- 所有多字节字段 **小端**。
- 帧总长 **≤ 20 字节**（BLE 默认 ATT MTU 23 − 3）。本协议不定义分包/重组。

### 1.1 常量

| 常量 | 值 | 说明 |
|---|---|---|
| `MAX_LEDS` | 64 | 单条灯带的灯珠上限 |
| `MAX_STRIPS` | 8 | 灯带数（8 个引脚，TDM 轮询，见 #29） |
| `MAX_SEGMENTS` | 8 | **每条灯带**的段数 |
| `MAX_STAGES` | 8 | **每套剧本**的阶段数 |
| `MAX_SCRIPTS` | 4 | 设备侧可存剧本数 |
| `MAX_STAGE_MS` | 65535 | 单阶段时长上限 |
| `NO_SCRIPT` | `0xFF` | `script_id` 表示「无激活剧本」 |

`strip_id` / `seg_id` / `stage_index` 均从 **0** 起。

## 2. GATT

| 项 | UUID | 属性 | 方向 |
|---|---|---|---|
| Service | `6c756d65-6e00-4b1e-9a3c-000000000001` | — | — |
| RX | `6c756d65-6e00-4b1e-9a3c-000000000002` | write-no-response | 小程序 → 设备 |
| TX | `6c756d65-6e00-4b1e-9a3c-000000000003` | notify | 设备 → 小程序 |
| State | `6c756d65-6e00-4b1e-9a3c-000000000004` | read | 小程序读设备 |

- **广播包**：flags + 128-bit Service UUID。
- **扫描响应包**：完整本地名 `Lumen-XXXX`，XXXX = 蓝牙 MAC 最后 2 字节的大写十六进制。
- **只允许 1 个连接**；断开后重新开始广播。
- **连接参数请求**：15-30ms interval，latency 0，优先保证拖动跟手，不追求省电。
- State read 固定 **14 字节**，布局见 §7。

## 3. 帧格式

| 偏移 | 字段 | 宽度 | 说明 |
|---|---|---|---|
| 0 | magic | 1 | 固定 `0xA5` |
| 1 | version | 1 | 固定 `0x02` |
| 2 | command | 1 | 命令字，见 §6 / §8 |
| 3 | seq | 1 | 请求序号，见 §9 |
| 4 | length | 1 | **载荷长度**，0-14 |
| 5..5+length-1 | payload | length | 载荷 |
| 5+length | checksum | 1 | 校验和 |

- **整帧长度 = 6 + length**，必须 ≤ 20。
- **checksum** = 对 `magic` 到 `payload` 最后一个字节求和，取低 8 位，再**按位取反**（one's complement，不是取负）。checksum 自己不参与计算。
- 设备 → 小程序的帧（ACK / Event / StateReport / SegmentReport / …）使用完全相同的信封、version 与校验算法。

### 校验和例子

帧 `A5 02 01 01 01 01`：

```
sum = A5 + 02 + 01 + 01 + 01 + 01 = 0xAB
checksum = ~0xAB & 0xFF = 0x54
完整帧 = A5 02 01 01 01 01 54
```

可执行伪代码：

```
sum = 0
for i in 0 .. (5 + length - 1):
    sum = (sum + frame[i]) & 0xFF
checksum = (~sum) & 0xFF
```

## 4. 版本

- `version = 0x02`。v2 **不向后兼容** v1。
- 设备遇到未知 version（含 `0x01`）：回 ACK `0x07`，不执行。
- 小程序遇到未知 version：视为协议不匹配，提示用户升级，不继续解析。
- 不兼容的协议变更必须提升 version。

## 5. 结果码

ACK 载荷的第二个字节：

| 值 | 名称 | 含义 |
|---|---|---|
| `0x00` | OK | 已接受并写入 RAM |
| `0x01` | InvalidParam | 参数越界或取值非法 |
| `0x02` | UnknownCommand | 未知/退役/保留命令字，或尚未实现的 v2 命令 |
| `0x03` | BadChecksum | 校验失败 |
| `0x04` | BadLength | 帧长度或命令载荷长度错误 |
| `0x05` | Busy | 暂时无法执行，可稍后重试 |
| `0x06` | StorageFailed | 同步存储失败（保留；异步失败用 Event） |
| `0x07` | UnsupportedVersion | 不支持的协议版本 |
| `0x08` | BadMagic | magic 不是 `0xA5` |
| `0x09` | InternalError | 资源/句柄重建失败 |

`0x0A-0x0F` 保留。

## 6. 命令（小程序 → 设备）

v1 已稳定语义的命令字保持不变；`0x03` / `0x04` **退役**；新命令从 `0x10` 起。

| 命令字 | 名称 | 载荷 | 长度 |
|---|---|---|---|
| `0x01` | SetPower | `power` | 1 |
| `0x02` | SetBrightness | `brightness` | 1 |
| `0x03` | *退役保留*（v1 SetColor） | — | 回 `0x02` |
| `0x04` | *退役保留*（v1 SetAll） | — | 回 `0x02` |
| `0x05` | QueryState | — | 0 |
| `0x06` | SetLedCount | `strip_id, count_lo, count_hi` | 3 |
| `0x07` | SelfTest | — | 0 |
| `0x10` | SetSegment | `strip_id, seg_id, start, end, type, params(3\|7)` | 8 \| 12 |
| `0x11` | ClearSegment | `strip_id, seg_id` | 2 |
| `0x12` | QueryStrip | `strip_id` | 1 |
| `0x13` | SetPlayback | `action, loop` | 2 |
| `0x14` | ScriptBegin | `script_id, stage_count, strip_count` | 3 |
| `0x15` | ScriptStage | `script_id, stage_index, duration_lo, duration_hi` | 4 |
| `0x16` | ScriptSegment | `script_id, stage_index, strip_id, seg_id, start, end, type, params(3\|7)` | 10 \| 14 |
| `0x17` | ScriptCommit | `script_id` | 1 |
| `0x18` | ScriptAbort | `script_id` | 1 |
| `0x19` | ActivateScript | `script_id, loop` | 2 |
| `0x1A` | QueryScript | `script_id` | 1 |

- `0x08-0x0F`、`0x1B-0x7F` 保留；设备收到回 `0x02`。
- 小程序写入 `0x80-0xFF`（设备→小程序方向）→ `0x02`。
- 载荷长度与命令要求不符 → `0x04`，整帧不执行。
- 命令层对变长命令按 **type → 期望长度** 做二次校验（`SetSegment` / `ScriptSegment`）：先读 `type` 再定长，长度不符回 `0x04`。

> **`0x16 ScriptSegment` 的动画类载荷是 14 字节，整帧正好 20 字节——协议上限，没有余量。**
> 这是刻意选择（显式寻址、无隐式上下文、可重试）；将来要加字段只能升协议版本。

### 6.1 已实现的命令（#21 交付时）

`lumen_command_is_known()` **只包含已实现的命令**。未实现的 v2 命令回 `UnknownCommand (0x02)`，因此小程序会明确看到「该命令需要升级固件」而不是静默成功。

**#21 交付后已实现**：`0x01` `0x02` `0x05` `0x06` `0x07`。
`0x03` / `0x04` 退役 → 回 `0x02`。
`0x10`–`0x1A` 由 #25（段配置）/ #32（剧本）逐票加入；在它们落地前，这些命令字**已分配但未实现**，设备回 `0x02`。

### 6.2 SetPower / SetBrightness / SetLedCount

- **SetPower**：`power` 只接受 0 / 1，其它 → `0x01`。与当前值相同不 commit，ACK 仍为 `0x00`。
- **SetBrightness**：0-255 全部合法；按构建期 `max_brightness` **钳位**而不是拒绝，ACK 为 `0x00`。
- **SetLedCount**：`strip_id` 先校验（`0 ≤ strip_id < strip_count`）。多灯带（#29）落地前设备只接受 `strip_id = 0`，其它值回 `0x01`。`count` 合法 1-64，越界回 `0x01`。ACK 等句柄重建完成后才发（§12.3）。

### 6.3 QueryState

`0x05` 收到后：

1. 回 ACK `0x80`，载荷 `[0x05, 0x00]`，seq 回显请求的 seq。
2. 紧接着回 StateReport `0x82`，载荷为 14 字节状态，seq 同样回显。

State read 是主同步路径；查询状态是次要/调试路径，两者返回完全相同的 14 字节布局。

## 7. State 布局与语义

State 特征值 read 与 StateReport `0x82` 载荷都是 **14 字节**：

| 偏移 | 字段 | 宽度 | 说明 |
|---|---|---|---|
| 0 | power | 1 | 0 关 / 1 开 |
| 1 | brightness | 1 | 0-255，已按 `max_brightness` 钳位后的生效值 |
| 2 | R | 1 | strip 0 / seg 0 的**基准色**（hue+sat 转 RGB，**不含**动画包络）；无 seg 0 时 0 |
| 3 | G | 1 | 同上 |
| 4 | B | 1 | 同上 |
| 5 | led_count_lo | 1 | strip 0 的灯珠数低字节 |
| 6 | led_count_hi | 1 | 同上高字节 |
| 7 | max_brightness | 1 | 固件当前亮度上限，当前构建值 200 |
| 8 | strip_count | 1 | 1-8，当前配置的灯带数 |
| 9 | seg_count | 1 | strip 0 的活动段数 |
| 10 | script_id | 1 | `0xFF` = 无激活剧本 |
| 11 | stage_index | 1 | 当前阶段；无剧本时 0 |
| 12 | playback_state | 1 | 0 停止 / 1 播放 / 2 暂停 |
| 13 | flags | 1 | bit0 `loop`；bit1 `script_active`；bit2-7 保留 = 0 |

- State read 必须正好 14 字节；长度不符视为协议不匹配。
- **前 8 字节与 v1 完全一致**：这是刻意的——过渡期小程序 UI 不必整体重写，且 0..7 的语义在 v2 仍然成立。
- **R/G/B 是基准色**：四种灯效都有 `hue(2)+sat(1)` 前缀，随时可算出基准色。动画效果的实际像素**不在** State 里——那是每帧变化的，不报。
- `max_leds = 64` 是协议常量，不放进 State；两端硬编码。
- **开关与亮度独立存储**：亮度 0 且开关为 1 是合法状态，视觉上等于关灯；把亮度拖到 0 不会清掉开关位，拖回来就恢复。
- 关灯保留亮度。
- 设备是状态权威：小程序连上后读 State，不用本地缓存覆盖设备。

### 7.1 示例

默认值（上电后开灯、30 灯、单灯带、无激活剧本）：

```
01 80 FF B4 78 1E 00 FF 01 00 FF 00 00 00
```

## 8. 设备 → 小程序帧

| 命令字 | 名称 | 载荷 | 长度 | seq |
|---|---|---|---|---|
| `0x80` | ACK | `orig_command, result` | 2 | 回显请求 |
| `0x81` | Event | `event_code, detail` | 2 | 固定 `0x00` |
| `0x82` | StateReport | 见 §7 | 14 | 回显请求 |
| `0x83` | SegmentReport | 与 SetSegment 载荷同构 | 8 \| 12 | 回显 QueryStrip |
| `0x84` | SegmentListEnd | `strip_id, seg_mask` | 2 | 回显 QueryStrip |
| `0x85` | ScriptSummary | `script_id, stage_count, flags, active` | 4 | 回显 QueryScript |
| `0x86` | ScriptProgress | `script_id, frames_lo, frames_hi` | 3 | 回显下发请求 |

- Event code：
  - `0x01` = 存储失败（detail = 触发写入的原命令字）；
  - `0x02` = ScriptCommit 校验失败（detail = 失败的 `script_id`）；
  - `0x03-0xFF` 保留。
- `0x87-0xFF` 保留。
- ACK / Event / StateReport 本身不再回 ACK。
- 设备**不主动推送状态**；StateReport 只在查询状态时发送。`0x83`–`0x86` 只在对应查询/下发命令的响应里出现。
- **同 seq 多帧是合法的**：`QueryStrip` 的 `seg_count` 条 `SegmentReport` + 1 条 `SegmentListEnd` 全部回显同一个 seq（§10.1）。

## 9. seq 语义

- 每条连接从 `0x01` 开始，每发一帧 +1，`0xFF` 后回 `0x00`。
- 新连接重置为 `0x01`。
- 设备原样回显请求的 seq；**不去重**。写操作串行化 + 命令都是绝对值，重传不会造成状态翻转。
- Event 的 seq 固定 `0x00`；StateReport 回显查询请求的 seq。
- 一条请求对应多帧响应时（`QueryStrip`），**所有响应帧共用请求的 seq**；小程序按命令字区分帧类型，按 `SegmentListEnd` 收尾。

## 10. 行为语义

### 10.1 重连重建 UI 的权威路径

```
1. 读 State 特征值（14B）
     -> power / brightness / max_brightness / led_count(0) / strip_count
        / seg_count(0) / script_id / stage_index / playback_state / loop
2. 对 strip 0..strip_count-1，各发一条 QueryStrip(strip_id)
     -> seg_count(i) 条 SegmentReport(0x83) + 1 条 SegmentListEnd(0x84)
        全部帧回显该 QueryStrip 的 seq（同 seq 多帧是合法的）
3. script_id != 0xFF 时，发 QueryScript(script_id)
     -> ScriptSummary(0x85)
4. 至此 UI 重建完成
```

单灯带 3 段场景约 70 字节。设备是权威；小程序**不得**用本地缓存覆盖设备。

### 10.2 分段模型与逐段下发的一致性

- 一条灯带最多 8 段；每段独立持有 `type + 参数 + 灯珠区间 + 生效时间戳`。
- 段之间的相位独立（`effects-spec.md` D4）。
- **未被任何段覆盖的灯珠必须写 0（熄灭）**——WS2812B 会锁存，不主动清零就一直亮着。
- **逐段下发，每帧独立生效，不加包裹帧。**

> **取舍（已接受，不要「修复」）**：不做事务、不加 Begin/End 暂存区。
> 后果：整份配置重写时用户会看到灯带**逐段跳变**。
> 缓解方式：小程序应把「未覆盖区清零」**放在最后**下发，以减轻观感。

### 10.3 段重叠：拒绝

`effects-spec.md` §4.1 早期写的是「重叠时后下发者覆盖，ACK 保持 OK」。**v2 改为拒绝**（覆盖该说法），理由：设备持有全部 8 段，全局校验是**可以**做的，§4.1 给出的技术理由不成立。

- 新区间与同 strip 的其它活动段有交集 → `InvalidParam (0x01)`，**旧配置不变**。
- `ClearSegment` 之后该段槽位释放，其灯珠归入未覆盖区（写 0）。

### 10.4 剧本下发流程

```
小程序                                    设备
ScriptBegin(script_id, stage_count, strip_count)
  -> ACK 0x00            (在暂存区分配/清空该 script_id)
ScriptStage(script_id, stage, duration_ms)   x stage_count
  -> ACK 0x00
ScriptSegment(script_id, stage, strip, seg, start, end, type, params)
  -> ACK 0x00            每一帧独立 ACK（这就是下发进度）
  -> ScriptProgress 0x86 每接受 8 帧补一条（frames_written 累加）
ScriptCommit(script_id)
  -> ACK 0x00               校验通过 → 原子替换为激活剧本
  -> ACK 0x01 InvalidParam  缺阶段/阶段时长为 0/段越界 → 保留上一套，整体丢弃暂存
ScriptAbort(script_id)     中途放弃，丢弃暂存
ActivateScript(script_id, loop) -> ACK 0x00
```

- **失败回滚**：`ScriptCommit` 失败时设备**保留上一套可用配置**，暂存区丢弃。
- **重来**：`ScriptBegin` 会清空同 `script_id` 的旧暂存（不需要先 Abort）。
- **进度**：以每帧 ACK 为权威（小程序自己数）；`0x86` 是设备侧补充证据。
- **断电恢复**：激活剧本**已提交**后持久化。**播放位置不持久化**——上电从第一阶段开始，且 `playback_state = 0`（停止）。

> **取舍（已接受）**：剧本播放位置不持久化。上电总是「第一阶段 + 停止」。理由：播放位置是瞬态，持久化它会让「上电自动播放」变得不可预期；从第一阶段开始是唯一可解释的行为。

### 10.5 播放控制

`SetPlayback(action, loop)`：

| action | 语义 |
|---|---|
| 0 | stop：停止播放，播放头回到 stage 0，`playback_state = 0` |
| 1 | play：从**当前播放头**开始/继续（暂停后继续 = 从这里恢复，不从头） |
| 2 | pause：冻结播放头，保持当前画面，`playback_state = 2` |

`loop` 在三种 action 下都写入（stop 时也记，供下次 play 使用）。

### 10.6 自检

收到 `0x07` 后：

1. 立即回 ACK `0x00`。
2. 渲染任务按 **红 → 绿 → 蓝 → 白** 依次输出，每色 500ms，共 2s；每色亮度取当前 `max_brightness`。
3. 自检是**临时覆盖**：不写 NVS，不改共享状态；结束后恢复自检前的开关/亮度/颜色。
4. 即使自检开始时是关灯态，也会点亮；结束后回到关灯。
5. 任何改变状态的命令（开关 / 亮度 / 灯珠数量 / 段配置 / 播放控制）立即取消自检并应用新命令。
6. 查询状态不取消自检；State read / StateReport 返回存储状态，不是自检颜色。
7. 重复收到自检命令则重新开始序列；不发送完成事件。

### 10.7 灯珠数量重建

收到合法的 `0x06` 后：

1. 渲染任务重建 `led_strip` 句柄；重建完成后才回 ACK。
2. **成功**：ACK `0x00`，新数量立即生效，当前开关/亮度/颜色保持不变，随后按 §12 持久化。
3. **失败**：保留旧句柄和旧数量，状态不变，ACK `0x09`。
4. 重建进行中收到第二个 `0x06` → ACK `0x05`，不排队。
5. 重建期间的其它命令正常写入共享状态；重建完成后按最新状态渲染。
6. NVS 写失败不影响已经生效的数量，按 §11.3 上报。
7. **数量减少时，超出新数量的灯珠必须熄灭。** WS2812B 每颗灯会锁存最后一次
   收到的像素；固件在删除旧句柄前，必须先用旧数量把整条灯带写成 0 再 refresh 一次。

### 10.8 亮度钳位

- 协议亮度范围是 0-255；固件按构建期常量 `max_brightness` 钳位。
- State 的 `max_brightness` 暴露当前上限，小程序滑块最大值直接用它。
- 当前构建值 **200**。#14 真机验收实测：64 灯全白约 3.8A，蓝光 LED 的 Vf 最高
  （3.0-3.4V），满亮度时蓝通道最先被线损压掉，纯白偏黄。压到 200 给蓝通道留余量。
  依据与逐档验证见 [end-to-end-acceptance.md](./end-to-end-acceptance.md) 第 ④ 条。
- 小程序不硬编码上限，一律读 State 的 `max_brightness`。

## 11. ACK 时序与错误处理

### 11.1 正常时序

```
校验通过 → 写入共享状态（RAM）→ 发渲染信号 → 回 ACK
```

- ACK `0x00` 的含义是「**已接受并写入 RAM**」，不保证已经渲染完或已经写进 NVS。
- 校验失败 / 参数越界：回对应错误码的 ACK，**不写入状态**。
- **例外：SetLedCount**。ACK 要等句柄重建成功/失败之后才发，结果码取决于重建结果（§10.7）。
- **例外：ScriptCommit**。ACK 要等暂存区整体校验完成后才发（§10.4）。

### 11.2 校验顺序

固定顺序：

```
magic (0x08) → version (0x07) → length (0x04) → checksum (0x03)
→ command (0x02) → payload 长度 (0x04) → payload 取值 (0x01)
```

- 长度错误优先于校验和：长度不对就无法定位校验和字节。
- **整帧不足 6 字节**：无法可靠读出 seq，直接丢弃，不回 ACK。
- **实际长度与 length 不符**（多、少、拖尾）→ `0x04`。
- **payload > 14 或整帧 > 20** → `0x04`。
- 坏 checksum 的帧尽力回显 header 里的 seq/命令字；小程序匹配不上就按超时处理。
- 未知 / 退役 / 保留命令 / 小程序写入设备→小程序命令字 → `0x02`。
- 已知命令的载荷长度不符 → `0x04`；载荷取值非法 → `0x01`。
- 任何错误都不改变状态。

### 11.3 参数校验顺序（段 / 剧本命令，扩展 `effects-spec.md` §5）

```
1 信封          magic/version/length/checksum                     沿用 v1
2 命令已知      v2 表内                                          否则 UnknownCommand
3 载荷长度      §6 表；SetSegment/ScriptSegment 先读 type 再定长   否则 BadLength
4 type 已知     type ∈ {0x00,0x01,0x02,0x03}                      否则 InvalidParam
5 strip_id 范围 0 ≤ strip_id < strip_count                        否则 InvalidParam
6 段区间        start ≤ end 且 end < led_count[strip_id]           否则 InvalidParam
7 段重叠        与同 strip 的其它活动段无交集                       否则 InvalidParam
8 flags 保留位  呼吸 bit3-7 / 彩虹·流光 bit1-7 == 0                否则 InvalidParam
9 周期下限      呼吸 period != 0 时 ≥ 334；彩虹/流光 ≥ 200         否则 InvalidParam
```

脚本类命令（`0x15` / `0x16`）额外校验 `stage_index < stage_count`、`duration_ms != 0`。

### 11.4 异步错误

- NVS 写失败发生在 ACK 之后，用 Event `0x81` 上报：载荷 `[0x01, 原命令字]`，seq `0x00`。
- 剧本提交失败用 Event `[0x02, script_id]`。
- 小程序收到后显示非阻塞警告，不回 ACK。
- 自检不写 NVS，因此不会产生存储失败 Event。

## 12. 持久化与默认值

- 持久化字段：开关、亮度、基准色（R/G/B）、灯珠数量、已提交的激活剧本、`loop`。
- **不持久化**：播放位置（`stage_index` / `playback_state` / `frames` 播放头）、自检状态。上电从第一阶段、停止态开始（§10.4）。
- 任意变更后 **500ms debounce** 写 NVS。
- 上电恢复；恢复失败回默认值。
- 默认值（无 NVS 历史时）：

| 字段 | 默认值 |
|---|---|
| power | 0（关） |
| brightness | 128 |
| R, G, B | 255, 180, 120（暖白） |
| led_count | 30 |
| max_brightness | 200（构建期常量，见 §10.8） |
| strip_count | 1 |
| seg_count | 0 |
| script_id | `0xFF`（无） |
| stage_index | 0 |
| playback_state | 0（停止） |
| flags | 0 |

## 13. 测试向量

文件：`docs/protocol-testvectors.json`。两端 codec 必须跑同一份文件并全绿。

顶层字段：

- `protocol_version`：2
- `checksum`：算法说明
- `frame_layout`：帧布局说明
- `state_read_example_hex`：14 字节 State 示例
- `state_read_fields`：14 个字段的顺序
- `cases`：用例数组（56 条）

每个用例：

| 字段 | 说明 |
|---|---|
| `name` | 用例名 |
| `direction` | `app_to_device` / `device_to_app` |
| `command` | 命令字（无效帧可缺省） |
| `command_name` | 命令名（可选） |
| `seq` | 序号（无效帧可缺省） |
| `payload_hex` | 载荷（有效帧） |
| `frame_hex` | 完整帧 hex |
| `frame_valid` | 信封是否有效 |
| `result_code` | 设备应回的结果码；`null` 表示静默丢弃；设备→小程序帧可缺省 |
| `note` | 可选说明 |

覆盖范围：

- **已实现命令**：开关、亮度、查询、灯珠数量（3 字节）、自检；
- **退役命令**：`0x03` / `0x04` → `result_code: 2`；
- **布局钉死用例**（`frame_valid: true`, `result_code: 2`, `note` 写明「布局固定；实现票落地后改为 0」）：
  `SetSegment`（静态 8B / 呼吸 12B）、`ScriptSegment`（静态 10B / 动画 14B）、
  `ClearSegment`、`QueryStrip`、`SetPlayback`、`ScriptBegin`、`ScriptStage`、
  `ScriptCommit`、`ScriptAbort`、`ActivateScript`、`QueryScript`；
- **设备回报**：ACK 各结果码、Event、14 字节 StateReport、`SegmentReport`、
  `SegmentListEnd`、`ScriptSummary`、`ScriptProgress`；
- **信封失败**：坏校验、坏 magic、短帧、长度不符、超长。

> **布局钉死用例的 `result_code: 2` 只是当下事实**：#21 时 `0x10`–`0x1A` 尚未实现，设备回 UnknownCommand。
> 向量把**字节布局**固定下来（`frame_hex` 是权威），实现票落地后只需把 `result_code` 改成 `0`。

## 14. 变更规则

- 改协议 = 本文件 + 测试向量 + 两端实现进同一个 commit。
- 不兼容变更提升 `version`；读端遇到未知 version 回 `0x07`，不尝试兼容解析。
- UUID、命令字、结果码、State 布局都是协议的一部分，不得单端修改。
- 动画类载荷（`effects-spec.md` §2）**只剩 2 字节余量**，加字段前先确认是否必须升版本。
