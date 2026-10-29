# RMT × BLE 共存稳定性验证（issue #7）

**状态**：实验固件与方案就绪；**全部实测数据待用户填**（本文件没有任何实测结论）。
**相关**：[固件架构](./firmware-architecture.md)、[灯带 bring-up 基线](./led-bringup.md)、[BLE/固件事实研究](./wayfinding/research/ble-and-firmware-facts.md)、[wayfinder 票 10](./wayfinding/tickets/10-rmt-ble-coexistence.md)。

---

## 0. 一句话现状

- 这里回答的问题是：**ESP32-C3 上 BLE 连接并持续通信时，`led_strip` 的 RMT 刷新会不会偶发损坏波形，导致灯珠错色或闪烁？加大 `mem_block_symbols` 能不能压住？**
- 本票交付的是**能在同一份固件上只改 Kconfig 跑完五组实验的实验固件 + 这份报告模板**。
- 判定线（照抄票）：**30 分钟高频写入下，错色帧 ≤ 1 次/10 分钟，且用户不可感知 → 可接受**。
- 结论栏目前是空的。**没有跑过就不许填「通过」。**

### 为什么必须真机做

研究已确认两条硬事实（见 [ble-and-firmware-facts.md](./wayfinding/research/ble-and-firmware-facts.md) §B11–B12）：

1. C3 的 RMT **没有 DMA**（`soc_caps.h` 无 `SOC_RMT_SUPPORT_DMA`），编码在 ISR 里逐块执行；
2. `led_strip` README 明写：RMT 中断被延迟（例如同核 Wi-Fi 中断）会导致 **RMT 事务损坏、灯珠显示错误颜色**。

官方头号缓解措施是「把 RMT 驱动装到另一个核」，**C3 单核，不可用**。而 BLE 连接事件会周期性占用射频/中断。所以这不是「可能有问题」，是「默认应当怀疑」。

---

## 1. 实验固件

### 1.1 开关

Kconfig 符号（`firmware/main/Kconfig.projbuild`，menuconfig 路径 `Lumen → RMT × BLE 共存压力测试模式`）：

| 符号 | 默认 | 说明 |
|---|---|---|
| `CONFIG_LUMEN_RMT_STRESS_MODE` | **n** | 总开关。关闭时固件与 #6/#8 骨架**完全一致**，产品路径零改动 |
| `CONFIG_LUMEN_STRESS_PERIOD_MS` | 50 | 压力循环周期，50ms = 20Hz |
| `CONFIG_LUMEN_STRESS_DURATION_MIN` | 30 | 压力阶段时长；0 = 无限 |
| `CONFIG_LUMEN_STRESS_START_DELAY_S` | 20 | 开跑前等待，给手机留连接时间 |
| `CONFIG_LUMEN_STRESS_PATTERN_CYCLE` / `_STEADY` | CYCLE | 见 §1.3 |
| `CONFIG_LUMEN_STRESS_REFRESH_ASYNC` | n | 组 5：`refresh_async` + 延迟等待（**不是双缓冲**，见 §7） |
| `CONFIG_LUMEN_STRESS_HEARTBEAT_S` | 30 | 心跳间隔 |
| `CONFIG_LUMEN_STRESS_BRIGHTNESS` | 64 | 压力帧亮度（gamma 后乘到 RGB） |
| `CONFIG_LUMEN_STRESS_LOG_WRITES` | n | 每次写入立即打一行（会阻塞 NimBLE 主机任务，仅调试用） |
| `CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS` | 48 | 组 4 的扫描对象 |

**固件默认值保持 `CONFIG_LUMEN_RMT_STRESS_MODE=n`。** `scripts/build-rmt-stress.cmd` 只改 `%TEMP%` 里的临时副本，不碰仓库里的 `sdkconfig.defaults`。

### 1.2 压力阶段做了什么

```
等待 START_DELAY（手机连接窗口）
→ 发一条真实 SetPower(1) 帧，走协议编解码 + command.c reducer + commit（把灯点亮）
→ 每 PERIOD_MS 一帧：
     STEADY：固定暗红，只 set_pixel + refresh（颜色恒定，便于肉眼数错色）
     CYCLE ：每帧两条真实协议帧走 reducer
              SetBrightness（#9 已实现）→ 亮度在 32/64/96/128 间循环
              SetColor（#10 之后实现）→ 未实现时退回内置 8 色调色板
     → set_pixel × 灯数 → led_strip_refresh（或 refresh_async）
→ 到时：打印汇总，回到普通 latest-wins 渲染路径（若压力期间有 BLE 写入，按最新共享状态重绘一次）
```

要点：

- **刺激复用 `command.h` 的纯 reducer**，没有另写一套命令语义。命令层是唯一入口，后续 #9/#10 把 SetColor/SetBrightness 实现后，CYCLE 会自动使用真实状态通道，无需改本票代码。
- **STEADY 与 CYCLE 的 RMT 负载完全相同**（每周期都完整发送 30×24 bit）。区别只在像素是否变化，因此 STEADY 是「数错色」的正确模式，CYCLE 是「最大状态变化压力」模式。
- **压力阶段的画面不受协议状态控制**：STEADY 固定暗红，CYCLE 走自己的调色板/共享状态。手机写入仍然走完整链路（`rx_access` → 解帧 → reducer → commit → ACK），射频与中断负载是真实的，**只是灯不跟着变**。这是刻意的：颜色必须恒定，肉眼看的是一个已知的帧，任何偏差都算错色。组 3 因此测的是「BLE 写入对 RMT 波形的干扰」，不是「UI 响应」。
- **STEADY 不提交状态**，所以压力期间不会有 NVS 写入；CYCLE 的 commit 会持续重置 500ms debounce，压力期间也几乎不写 flash（结束时写一次）。这是刻意的：避免 flash 操作混进「错色」统计。
- 压力阶段跑在**渲染任务**里（优先级 4，仍低于 NimBLE 主机任务的 21），刷灯句柄仍然只有它持有。BLE 服务照常工作：连接、读 State、写 RX、回 ACK。
- 心跳打印跑在**独立低优先级任务**（优先级 1），不占渲染任务的唤醒节拍；否则每次串口打印都会在 `loop_gap` 最大值里留下几十毫秒的假尖峰。

### 1.3 两个模式分别用来干什么

| 模式 | 灯带外观 | 用途 |
|---|---|---|
| `STEADY` | 恒定暗红（默认 64/255 亮度） | **肉眼判定错色/闪烁必须用这个**：任何一帧变色、变亮、变暗、熄灭都异常 |
| `CYCLE` | 8 色轮转 | 制造最大状态变化压力；用来对比「BLE 活动下是否更容易坏」和组 5 的阻塞时长 |

### 1.4 构建与烧录

仓库路径含中文，ESP-IDF 在中文路径下会卡住，必须用包装脚本。

```bat
REM 构建压力固件并直接选好实验参数
REM 用法: build-rmt-stress.cmd [mem_block] [cycle|steady] [sync|async] [minutes] [brightness]
scripts\build-rmt-stress.cmd 48 steady sync 30

REM 烧录（板子当前端口；不要占用 COM6，那是 #4 肉眼观察用的）
scripts\flash-rmt-stress.cmd COMx

REM 抓日志（115200 8N1），完整日志存到 .scratch/（*.log 已 gitignore）
idf.py -p COMx monitor
```

脚本会在 `%TEMP%\lumen-rmt-stress-07` 里重新生成 `sdkconfig`，保证命令行参数生效；每次运行都会从仓库重新同步源码，不会残留上一次的实验参数。

产品固件仍用 `scripts\build-firmware.cmd`（压力开关默认关闭）。

### 1.5 串口格式（填表时按这个抓）

启动横幅：

```
lumen_stress: issue #7 RMT x BLE 共存压力模式（实验固件，非产品固件）
lumen_stress: reset_reason=2 (POWERON) boot_count=1 (RTC 保留，掉电会清零重计)
lumen_stress: strip: gpio=3 leds=30 mem_block_symbols=48 resolution=10MHz dma=off
lumen_stress: stress: period=50ms pattern=STEADY duration=30min async=off brightness=64 heartbeat=30s start_delay=20s write_ring=1024
```

每 30s 一条心跳：

```
lumen_stress: ---------- 心跳 t=120s ----------
lumen_stress:   refresh    count=600 min=1420us avg=1500us max=2600us
lumen_stress:   async_wait count=0
lumen_stress:   loop_gap   count=599 min=50000us avg=50000us max=70000us
lumen_stress:   win: refresh_err=0 loop_gap_over=0 (阈值=实际周期+5ms)
lumen_stress:   total: refresh=3600 refresh_err=0 last_err=ESP_OK async_wait_err=0 loop_gap_over=0
lumen_stress:   heap: free=... min_free=... largest_block=...
lumen_stress:   ble: connects=1 disconnects=0 last_disc_reason=0 mtu=247 writes=0
lumen_stress:   ble writes: 本窗口无写入 (累计 0)
```

有写入时心跳会多出 `write_gap_us` 行，紧接着批量倾倒写入时间戳：

```
lumen_stress:   ble: connects=1 disconnects=0 last_disc_reason=0 mtu=247 writes=600
lumen_stress:        write_gap_us: count=599 min=48000 max=61000
lumen_stress:   ble writes（本窗口 600 条，格式 t_us:len；丢弃 0）:
lumen_stress:    12000000:8 12005000:8 12010000:8 ...
```

> 心跳里的数值只是格式示例，不是实测数据。`write_gap_us` 与时间戳行只在窗口内有写入时出现。

写入时间戳默认**不逐条打印**，而是存在固件里 1024 条的环形缓冲，心跳时批量倾倒（见上面的 `t_us:len` 行）。

这样 NimBLE 主机任务（优先级 21）不会因为串口打印而卡住——这是「测量不能改变被测对象」的基本要求。

### 1.6 压力阶段结束汇总

```
lumen_stress: ===== 压力阶段结束 t=1812s =====
lumen_stress: 累计 refresh=36000 refresh_err=0 ...
lumen_stress: 提醒：以上仍然只能证明「固件没崩、刷新没报错」；
              错色帧数必须由人眼填入 docs/rmt-ble-stability.md 的表格。
```

---

## 2. 这些指标能证明什么、不能证明什么

**这是本文最重要的一节。** 串口无法证明「灯珠没显示错色」。

| 指标 | 能证明 | 不能证明 |
|---|---|---|
| `refresh` 返回码（`ESP_OK` / 错误） | 驱动调用与 `rmt_tx_wait_all_done` 没报错；RMT 通道/channel 状态正常 | **波形是否被破坏**。RMT 硬件不校验输出波形，ISR 被拖慢导致的数据错位**不会**返回错误 |
| `refresh` 耗时 min/avg/max | 每帧占用渲染任务多久；与 `led_strip` 理论值（30 灯约 1.2ms + 280µs reset）对比是否异常 | 波形正确性 |
| `loop_gap`（唤醒间隔）min/avg/max + 超阈次数 | 渲染任务被高优先级任务（NimBLE/射频/中断）推迟了多久、推迟了多少次 | 推迟发生在哪一帧的**发送过程中**；也不能证明推迟就造成了错色 |
| `async_wait`（组 5） | `refresh_async_done` 阻塞了多久 | 同上 |
| `heap` / `min_free` / `largest_block` | 有无泄漏、碎片化；`mem_block_symbols` 增大带来的堆占用 | 与错色无直接关系 |
| `reset_reason` + `boot_count` | 是否 BROWNOUT（供电）、INT/TASK WDT（任务饿死）、PANIC（崩溃） | 错色**可以完全没有复位**——这正是最坏的形态 |
| BLE `connects` / `disconnects` / `reason` / `mtu` / `writes` / 写入时间戳 | 连接是否稳定、MTU 协商值、每次写入的精确时刻（可与人眼记录的现象对齐） | 证明因果。时间相关 ≠ 因果 |
| 压力前后 `refresh` 累计数 | 实验确实跑了那么久（可与时长交叉验证） | 灯带实际显示内容 |

**可以下的结论上限**：「固件没崩、刷新没报错、渲染周期被拉长到 X ms」。  
**必须由人眼补上的结论**：「灯珠有没有显示错色」。

因此每组的表格都分成 **「固件侧（串口）」** 与 **「肉眼侧（观察/录像）」** 两栏，缺一栏不算完成。

---

## 3. 怎么肉眼判定错色 / 闪烁

这一步如果做错，五组实验全部作废。按下面的做。

### 3.1 准备

- 用 **STEADY 模式**（`pattern=steady`）。CYCLE 模式颜色本来就在变，肉眼看不出哪一帧是错的。
- 默认亮度 64（gamma 后 RGB≈64,0,0，暗红）。先在黑暗房间里确认能看清颜色；如果太暗，用第 5 个参数改亮度重建（例如 `scripts\build-rmt-stress.cmd 48 steady sync 30 96`），**但同一组实验内不得改**，且报告里要注明实际值。
- 房间尽量暗，减少环境光干扰；关掉其他会闪的光源。
- 灯带全部 30 颗都在画面内。

### 3.2 录制（推荐，唯一可靠的数法）

1. 手机固定在支架上，**60fps** 录制（1080p60 或 4K60），画面覆盖整条灯带。
2. 每段录 **10 分钟**，连续录 **3 段** = 30 分钟。
3. 如果手机不支持长录像，退化为：每段 5 分钟 × 6 段，中间不移动机位。
4. 回放逐帧检查（手机相册拖动即可，或在电脑上逐帧）：
   - 出现**非红**的任何一帧（变绿/蓝/白/偏紫、变暗、变亮、熄灭）→ 记 **1 次错色事件**；
   - 连续多帧属于同一次事件 → 只记 1 次；
   - 记录**事件发生的视频时间戳**（精确到秒）。
5. 同时记录串口心跳；把视频时间戳与串口 `t=` 对齐（两边都从固件上电开始，误差 < 2s 即可）。

### 3.3 不录像时（补充手段，漏检率高）

- 用秒表 + 盯着灯带，30 分钟。出现异常就按秒表记时刻。
- 人眼对**整条闪一下**敏感，但对**单颗灯错色**很容易漏。所以不录像的数据只能作为「发现了问题」的证据，**不能作为「没问题」的证明**。
- 报告里必须写明用哪种方式（`录像` / `人眼`）。

### 3.4 判读要点

| 看到什么 | 记作 | 备注 |
|---|---|---|
| 整条瞬间变绿/蓝/白 | 错色 1 次 | 最典型的 RMT 波形损坏 |
| 单颗或尾部几颗变色 | 错色 1 次 | 数据位错位；也可能是 3.3V VIH 边界（见 [led-bringup.md](./led-bringup.md) §3） |
| 整条闪一下（亮度瞬间变化） | 闪烁 1 次 | 单独统计，不与错色混算 |
| 整条熄灭一瞬又亮 | 闪烁 1 次 | 也可能是掉压；对照 `reset_reason` |
| 颜色渐变、拖影 | 不记 | 60fps 采样与 WS2812B 刷新率的混叠效应，不是错色 |
| 上电后第一帧错色 | 不记入 30 分钟窗口 | 供电浪涌，单独记录 |

### 3.5 错色率换算

```
错色率（次/10 分钟） = 错色次数 / 观测分钟数 × 10
```

判定线用的是这个换算值，不是绝对次数。

---

## 4. 五组实验

所有组都用同一份固件，只改构建参数。每组跑完把日志存 `.scratch/rmt-ble-groupN.log`，并填 §5 的对应表格。

### 组 1：BLE 未连接基线

| 项 | 值 |
|---|---|
| 目的 | 没有 BLE 活动时，纯 RMT 刷新是否稳定（对照 #4 的 5 分钟 soak，拉长到 30 分钟） |
| 构建 | `scripts\build-rmt-stress.cmd 48 steady sync 30` |
| 机位 | 手机不连接、不在附近（关掉蓝牙或离开 10m 以外） |
| 时长 | 30 分钟 |
| 看什么 | 错色/闪烁次数；`refresh_err`；`loop_gap` max（应≈50ms，只有 FreeRTOS tick 抖动）；`heap` 是否单调下降 |
| 数据填在 | §5.1 |

### 组 2：BLE 连接空闲

| 项 | 值 |
|---|---|
| 目的 | 连接建立、有连接事件（每 15–30ms 一次）但无写入时是否稳定 |
| 构建 | 同组 1（`48 steady sync 30`） |
| 操作 | 上电后立即用 nRF Connect 连接 `Lumen-XXXX`，**连上后什么都不要做**，保持 30 分钟 |
| 时长 | 30 分钟 |
| 看什么 | 错色/闪烁次数；`loop_gap` max 与超阈次数是否比组 1 变大；`connects=1 disconnects=0`；`mtu` 值 |
| 数据填在 | §5.2 |

> 连接参数请求是 15–30ms、latency 0（`ble_link.c`），所以连接事件本身就有稳定的中断负载。

### 组 3：BLE 高频写入

| 项 | 值 |
|---|---|
| 目的 | 这是判定线所在组：20Hz 持续写入 + 20Hz 刷新 |
| 构建 | 同组 1（`48 steady sync 30`） |
| 操作（二选一） | **A. 小程序拖动**：连上后把亮度滑块来回拖 30 分钟（`utils/ble/throttle` 是 20Hz latest-wins）。`SetBrightness` 在 #9 已实现，写入会真实改变共享状态、回 ACK `0x00`。<br>**B. 手工高频写**：nRF Connect 连上后反复点 Write RX（每秒 15–20 次），发 SetBrightness 帧。 |
| 时长 | **30 分钟（判定线）** |
| 看什么 | 错色/闪烁次数与**发生时刻**；对应时刻的 `ble write` 时间戳；`writes` 累计（应≈20×60×30=36000）；`disconnects` 是否 >0；`loop_gap` max 与超阈次数 |
| 数据填在 | §5.3 |

> 写入用的帧必须是真实协议帧：SetBrightness 是 `A5 01 02 seq 01 bright checksum`，SetColor 是 `A5 01 03 seq 03 R G B checksum`。小程序与 nRF Connect 都按这个发。
> 高频写入时**不要**打开 `CONFIG_LUMEN_STRESS_LOG_WRITES`：那个开关会在主机任务里同步打串口，本身就会制造断连。

### 组 4：`mem_block_symbols` 扫描 48 / 96 / 192 / 384

| 项 | 值 |
|---|---|
| 目的 | 加大 RMT 缓冲能否减少错色 |
| 构建 | `scripts\build-rmt-stress.cmd <值> steady sync 10`，四次 |
| 时长 | 每个值 10 分钟（组 3 的最优值再按组 3 跑满 30 分钟确认） |
| 操作 | 同组 3（BLE 连接 + 20Hz 写入） |
| 看什么 | 错色率（次/10 分钟）；`heap free` 与 `largest_block` 相对 48 的变化；`refresh` avg 耗时变化；`loop_gap` 超阈次数 |
| 数据填在 | §5.4 |

**C3 的硬上限（预期，非实测）**：每个 RMT group 只有 4 个通道 × 48 word = **192 word**。`rmt_tx_register_to_group` 按 `mem_block_symbols/48` 向上取整申请连续内存块：

| `mem_block_symbols` | 申请块数 | 预期结果 |
|---|---|---|
| 48 | 1 | 正常 |
| 96 | 2 | 正常 |
| 192 | 4 | 正常（占满整个 group，其它 RMT 通道不可用） |
| **384** | **8** | **`led_strip_new_rmt_device` 失败（无 8 个连续块）** |

组 4 的 384 因此预期只记录「初始化失败」这一条数据；实验固件在压力模式下已把失败路径改成**打印原因后挂起**，不会进入重启循环。如果实测 384 真的失败，结论写成「384 不可用（硬件上限）」，不是实验失败。

**预期（非实测）**：加大量只改变 ISR 的批量大小，不改变「RMT 编码仍在 ISR 里跑」这一事实。它能降低 ISR 被推迟导致数据错位的概率（一次中断补更多数据、减少中断次数），但**不能消除**。所以组 4 的预期是「可能有改善，不太可能完全消除」。

### 组 5：`refresh_async` + 延迟等待 vs 阻塞 `refresh`

| 项 | 值 |
|---|---|
| 目的 | 对比渲染任务的阻塞形态与丢帧表现 |
| 构建 A | `scripts\build-rmt-stress.cmd 48 steady sync 30` |
| 构建 B | `scripts\build-rmt-stress.cmd 48 steady async 30` |
| 操作 | 同组 3（BLE 连接 + 20Hz 写入） |
| 时长 | 各 30 分钟 |
| 看什么 | 对照 `refresh` 的 count/avg/max 与 `async_wait` 的 count/avg/max；`loop_gap` max；错色次数 |
| 数据填在 | §5.5 |

**预期（非实测）**：`refresh` 同步模式 avg ≈ 1.4–1.5ms；async 模式 `refresh` avg ≈ 几十 µs、`async_wait` avg ≈ 1.4ms，两者之和与同步模式相当。**错色率预期没有改善**——因为 `refresh_async` 没有双缓冲，RMT 编码照样在 ISR 里跑，ISR 被 BLE 拖慢的风险一模一样。组 5 的结论见 §7。

---

## 5. 数据表（**全部待用户实测**）

填写规则：

- 每个格子填实测值；没测就写 `未测`，**不要留空**，也不要用「感觉正常」。
- 「错色」一栏写次数，并在括号里写换算到 10 分钟的比率。
- 每组必须附：串口完整日志路径 + 录像路径（或注明「人眼」）。

### 5.1 组 1：BLE 未连接基线

| 项 | 待填 |
|---|---|
| 日期 / 板子 / 固件 commit | 待用户实测 |
| mem_block_symbols / pattern / refresh | 48 / STEADY / sync |
| 实际时长（min） | 待用户实测 |
| 累计 refresh 数 | 待用户实测 |
| `refresh_err` 累计 | 待用户实测 |
| `refresh` avg / max（µs） | 待用户实测 |
| `loop_gap` min / avg / max（µs） | 待用户实测 |
| `loop_gap_over` 累计 | 待用户实测 |
| heap free 起 / 止 / min | 待用户实测 |
| `reset_reason`（本次启动） | 待用户实测 |
| `boot_count` | 待用户实测 |
| **肉眼：错色次数（次/10min）** | 待用户实测 |
| **肉眼：闪烁次数（次/10min）** | 待用户实测 |
| 观察方式（录像/人眼） | 待用户实测 |
| 日志路径 | 待用户实测 |
| 备注 | |

### 5.2 组 2：BLE 连接空闲

| 项 | 待填 |
|---|---|
| 日期 / 板子 / 固件 commit | 待用户实测 |
| mem_block_symbols / pattern / refresh | 48 / STEADY / sync |
| 实际时长（min） | 待用户实测 |
| `connects` / `disconnects` | 待用户实测 |
| `mtu` | 待用户实测 |
| `refresh_err` 累计 | 待用户实测 |
| `refresh` avg / max（µs） | 待用户实测 |
| `loop_gap` min / avg / max（µs） | 待用户实测 |
| `loop_gap_over` 累计 | 待用户实测 |
| heap free 起 / 止 / min | 待用户实测 |
| `reset_reason` / `boot_count` | 待用户实测 |
| **肉眼：错色次数（次/10min）** | 待用户实测 |
| **肉眼：闪烁次数（次/10min）** | 待用户实测 |
| 观察方式（录像/人眼） | 待用户实测 |
| 日志路径 | 待用户实测 |
| 备注 | |

### 5.3 组 3：BLE 高频写入（**判定线所在**）

| 项 | 待填 |
|---|---|
| 日期 / 板子 / 固件 commit | 待用户实测 |
| mem_block_symbols / pattern / refresh | 48 / STEADY / sync |
| 写入方式（小程序 / nRF Connect） | 待用户实测 |
| 实际时长（min） | 待用户实测 |
| `writes` 累计 / 实测写入频率（Hz） | 待用户实测 |
| `connects` / `disconnects` / 断开原因 | 待用户实测 |
| `refresh_err` 累计 | 待用户实测 |
| `refresh` avg / max（µs） | 待用户实测 |
| `loop_gap` min / avg / max（µs） | 待用户实测 |
| `loop_gap_over` 累计（占 round 的 %） | 待用户实测 |
| `loop_gap` 超过 100ms 的次数（严重抢占） | 待用户实测 |
| heap free 起 / 止 / min | 待用户实测 |
| `reset_reason` / `boot_count` | 待用户实测 |
| **肉眼：错色次数（次/10min）** | 待用户实测 |
| **肉眼：闪烁次数（次/10min）** | 待用户实测 |
| 错色发生时刻（视频时间戳 / 串口 t） | 待用户实测 |
| 观察方式（录像/人眼） | 待用户实测 |
| 日志路径 | 待用户实测 |
| **判定：可接受 / 不可接受** | 待用户实测 |

### 5.4 组 4：`mem_block_symbols` 扫描

| mem_block | 初始化成功？ | heap free（起→止） | largest_block | `refresh` avg/max | `loop_gap` max | `loop_gap_over` | 错色（次/10min） | 闪烁（次/10min） |
|---|---|---|---|---|---|---|---|---|
| 48 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 |
| 96 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 |
| 192 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 | 待用户实测 |
| 384 | 待用户实测（预期失败） | — | — | — | — | — | — | — |

结论（待用户实测后填写）：**推荐的 `mem_block_symbols` = ______，理由：______**

### 5.5 组 5：`refresh_async` + 延迟等待 vs 阻塞 `refresh`

| 项 | sync | async |
|---|---|---|
| `refresh` count / avg / max（µs） | 待用户实测 | 待用户实测 |
| `async_wait` count / avg / max（µs） | — | 待用户实测 |
| `refresh` + `async_wait` 合计 avg（µs） | 待用户实测 | 待用户实测 |
| `loop_gap` min / avg / max（µs） | 待用户实测 | 待用户实测 |
| `loop_gap_over` 累计 | 待用户实测 | 待用户实测 |
| `refresh_err` 累计 | 待用户实测 | 待用户实测 |
| heap free 起 / 止 | 待用户实测 | 待用户实测 |
| 错色（次/10min） | 待用户实测 | 待用户实测 |
| 闪烁（次/10min） | 待用户实测 | 待用户实测 |

结论（待用户实测后填写）：**渲染路径保留 `______`，理由：______**

---

## 6. 判定流程与后续动作

### 6.1 判定顺序（不要跳步）

```
1. 组 1（无 BLE）本身有错色？
   → 是：这不是共存问题，是灯带电气/电平问题。
        回到 docs/led-bringup.md §3（3.3V 驱动 5V 的 VIH 边界）排查，
        共存结论暂不成立，五组实验暂停。
   → 否：继续。

2. 组 2（连接空闲）相对组 1 明显变差？
   → 是：连接事件本身就足以干扰 RMT。这是共存问题成立的最强证据。
   → 否：说明单靠连接事件还不够，压力来自写入侧。

3. 组 3（20Hz 写入）的错色率是否 ≤ 1 次/10 分钟且用户不可感知？
   → 是：可接受（前提是组 4 里没有更差的值被误选）。
   → 否：看组 4。

4. 组 4 中是否有某个 mem_block 值让组 3 达标？
   → 有：选「能达标的最小值」，写进 Kconfig 默认值，回到组 3 复跑 30 分钟确认。
   → 没有（含 48/96/192 全部不达标，或 384 根本初始化不了）：
        不可接受 → 进入 §6.3 SPI 备选评估。

5. 组 5 只影响渲染路径选择，不影响「可接受/不可接受」判定。
```

### 6.2 判定线（照抄票）

- **可接受**：30 分钟高频写入下，**错色帧 ≤ 1 次/10 分钟**，且**用户不会注意到**。
- **不可接受**：肉眼可见闪烁，或错色频率与 BLE 活动明显相关。

「用户不会注意到」的判定补充（避免自欺）：

- 观察者不知道 BLE 何时在写入（盲测：让另一个人控制手机写入）；
- 以「正常使用距离」（1–3m）观察，而不是把脸贴在灯带上；
- 至少 2 名观察者独立判断；
- 只要有一人明确看到闪烁 → 记「可见」，判不可接受。

### 6.3 不可接受时的后续动作

1. 把结论写进 wayfinder map 的 **Not yet specified**，并链接本文件 §5.3/§5.4 的数据。
2. 把 `mem_block_symbols` 的最终实测值写进 `firmware/main/Kconfig.projbuild` 默认值（若仍有可接受值）；若全部不可接受，默认值保持 48 并标注「已验证不足」。
3. 启动 SPI 驱动路线的可行性评估（见 §8）——这是一次**架构变更**，需要新票，不在本票内实现。
4. 期间**不要**把小程序的拖动节流调高或调低来「掩盖」问题：错色是固件/硬件层的，与节流无关。

---

## 7. 组 5 的决定：实现了什么、没实现什么

### 7.1 已经实现的（成本可控、可判定）

`CONFIG_LUMEN_STRESS_REFRESH_ASYNC` 打开后，压力循环用：

```
上一帧：led_strip_refresh_async()        → 立即返回
下一帧：led_strip_refresh_async_done()   → 阻塞到发送完成，然后才 set_pixel
```

这是 `led_strip` 3.1.1 的**唯一合法** async 用法：组件没有双缓冲，发送期间像素缓冲属于在途事务，`done()` 返回前改像素就是未定义行为。

### 7.2 没有实现真双缓冲，以及为什么

`led_strip` 3.1.1 的公开 API 里**没有缓冲交换**：`set_pixel` 直接写驱动内部那块 `pixel_buf`，而 `rmt_transmit` 在发送完成前一直引用同一块内存。要在组件之外做「双缓冲」，必须：

1. 准备两块自己的缓冲，写满一块再交给驱动 —— 但驱动不提供「设置外部缓冲」的接口；
2. 或者绕过 `led_strip`，直接用 `rmt_new_bytes_encoder` + `rmt_transmit` 自己管两块 DMA 缓冲 —— 这已经是**重写驱动**，不是加个 Kconfig 分支。

硬做的风险：

- 把 `pixel_buf` 的地址与生命周期当公开契约，组件升级（3.1.x→3.2）直接失效；
- 一旦 `done()` 与 `set_pixel` 的时序错一次，就是**持续错色**，而且会污染整组实验结果；
- 真正的收益接近 0：渲染任务在刷新期间本来就没有别的活（`set_pixel` 循环是微秒级），把等待挪个位置不会让波形的 ISR 竞争变少。

**结论：本票不做真双缓冲。** 组 5 用「延迟等待」测出阻塞形态的差异就够了；真双缓冲的前置条件是：

1. `espressif/led_strip` 提供双缓冲 API（或我们自己 fork 一个维护分支）；
2. 或者改用 SPI + DMA 后端（DMA 从结构上消除「ISR 喂波形」这一环，见 §8）；
3. 只有在「单帧准备时间 ≥ 几百微秒」时才有收益（例如大量灯珠 + 复杂灯效），当前 30 灯场景不满足。

**这一条要写进结论：组 5 的答案是「async 不改善共存可靠性」，不是「async 更好或更差」。**

---

## 8. SPI 驱动 WS2812 的初步可行性评估（仅评估，未实现）

结论先说：**可行，且 `led_strip` 已经自带 SPI 后端，属于换构造函数的量级，不是重写。** 真正的代价是 SPI 总线被独占。

### 8.1 为什么 SPI 能解决 RMT 的问题

| | RMT（当前） | SPI + DMA |
|---|---|---|
| 波形由谁产生 | CPU 在 ISR 里逐 word 编码 | SPI 外设按内存内容自动移位 |
| BLE 中断延迟的影响 | **直接破坏波形**（ISR 来不及时读到过期数据） | **不影响**：数据已在 DMA 缓冲里，外设自己发 |
| C3 支持 | 无 DMA（硬约束） | 有 GDMA（`SOC_GDMA_SUPPORTED=1`） |
| CPU 占用 | 每帧约 1.2ms 的 ISR | 几乎为 0（DMA 传输） |

### 8.2 编码方式（两条路，推荐第一条）

**路线 A（推荐）：直接用 `led_strip` 自带的 SPI 后端，2.5MHz × 3 bit/bit。**

组件 `led_strip_spi_dev.c` 已经实现并调好：

- SPI 时钟 **2.5MHz**，每个颜色 bit 用 3 个 SPI bit 表示：`1` → `110`，`0` → `100`；
- 每位 0.4µs，一帧 30 灯 = 30×24×3 bit = 2160 bit ≈ **864µs**；
- 对 WS2812B 的时序：`T0H=0.4µs`（规格 0.4±0.15）、`T0L=0.8µs`（0.85±0.15）、`T1H=0.8µs`（0.8±0.15）、`T1L=0.4µs`（0.45±0.15）——**全部在规格中心附近**；
- 初始化时组件会校验实际时钟（要求与 2.5MHz 偏差 < 300kHz）。C3 的 SPI 源时钟 80MHz，80/32 = 2.5MHz **精确命中**；
- `with_dma = true` 时缓冲放内部 SRAM 且可用 GDMA；
- 同一个 handle API（`set_pixel` / `refresh` / `refresh_async` / `clear` / `del`），上层代码几乎不用改。

**路线 B（票里提到的 3.2MHz × 4 bit/bit）**：可以，但**时序余量更小**，只在需要更高刷新率或换 LED 型号时才考虑。

- 3.2MHz → 每个 SPI bit 0.3125µs，4 bit = 1.25µs（正好是 WS2812B 的位周期）；
- 编码必须用 `1110` 表示 `1`（`T1H=0.9375µs`、`T1L=0.3125µs`）、`1000` 表示 `0`（`T0H=0.3125µs`、`T0L=0.9375µs`）；
- 注意**不能用 `1100`**：那会得到 `T1H=0.625µs`，低于 0.65µs 的下限；
- 用 `1110` 时 `T1H` 距离上限 0.95µs 只剩 **12.5ns** 余量，属于「贴着规格跑」，对时钟精度和灯带批次都更敏感；
- 位周期 1.25µs 与 datasheet 完全一致，所以刷新率更长（30 灯仍是 30×24×1.25µs = 900µs，差别不大）。

### 8.3 C3 上的引脚与总线约束

| 约束 | 说明 |
|---|---|
| 可用 SPI 主机 | **只有 `SPI2_HOST`（GPSPI2）**。SPI0/1 接封装内 flash（GPIO12–17），不可用 |
| MOSI 的 IO_MUX 引脚 | `SPI2_IOMUX_PIN_NUM_MOSI = GPIO7`。但 **GPIO7 属于 JTAG（MTCK/MTDO）**，本仓库的引脚规范建议避开 |
| 用 GPIO3 的代价 | 必须走 **GPIO matrix** 路由（`spi_bus_config_t.mosi_io_num = 3` 可以）。2.5MHz 远低于 GPIO matrix 的频率上限，没有实际问题 |
| 总线独占 | `led_strip` 的 SPI 后端**没有 CS 概念**，`led_strip_new_spi_device` 会独占整个 SPI2 总线，不能再挂其它 SPI 设备。当前项目没有其它 SPI 外设，可接受 |
| 引脚冲突 | GPIO18/19（USB）、GPIO20/21（UART0）仍然不能动；数据脚继续 GPIO3，**接线不用改** |
| 电气 | 3.3V 驱动 5V 灯带的 VIH 问题**与驱动方式无关**，画板仍然必须加 74AHCT125 |

### 8.4 与 `led_strip` 的关系（工作量估计）

- 不必新写驱动：`led_strip_new_spi_device()` 已在组件里，3.1.1 版本可用；
- 改动点：
  1. `firmware/main/CMakeLists.txt` 的 `REQUIRES` 加 `esp_driver_spi`；
  2. `create_strip()` 换成 SPI 构造（`spi_bus = SPI2_HOST`、`with_dma = true`）；
  3. Kconfig 加一个 `LUMEN_LED_BACKEND_RMT/SPI` 选择；
  4. host 侧无需改动（`led_strip` 是设备侧依赖）；
- 风险点：
  1. **SPI 与 flash 共用 GDMA**：SPI2 DMA 与 MSPI 的 DMA 通道要共存，极端情况下大传输可能互相排队（需要实测）；
  2. `spi_bus_initialize` 的 `max_transfer_sz` 必须 ≥ 90 字节（30 灯 × 3 B/像素 × 3 SPI B/色字节 = 270 字节），组件已按 `max_leds` 算好；
  3. 灯珠数量上限提高后（`max_leds=64`），一帧 576 字节，仍在 DMA 能力内；
  4. **总线独占**意味着以后不能再用 SPI 接传感器/屏幕；如果产品要加，需要重新评估。
- 预计工作量：**0.5–1 天**（含真机验证与五组回归），前提是 §8.2 路线 A 不需要改组件源码。

### 8.5 何时启动

只有在 §6.1 走到「不可接受」时才启动。若组 3 达标，**不要**为了「更保险」提前换 SPI —— 总线独占是实打实的架构代价。

---

## 9. 已知风险与限制

| 风险 | 说明 | 缓解 |
|---|---|---|
| 压力模式代码进入产品固件 | `CONFIG_LUMEN_RMT_STRESS_MODE` 默认 **n**；关闭时 `stress_metrics.h` 把全部接口定义为空内联函数，`led_engine.c` 里所有压力相关代码在 `#if` 内，`command.h` 也只在压力段引入 | 合并前检查 `sdkconfig.defaults` 不含 `CONFIG_LUMEN_RMT_STRESS_MODE=y`；量产构建用 `scripts\build-firmware.cmd` |
| 压力模式把 `led_engine` 与 `command.h` 耦合 | 只在 `#if CONFIG_LUMEN_RMT_STRESS_MODE` 内 include 与调用，依赖方向（`ble_link → led_engine → state_store`）在默认构建下不变 | 默认构建的 `lumen.bin` 不含这些符号；构建已验证 |
| 串口日志本身影响结果 | 115200 下每行约 5ms。心跳 30s 一条影响可忽略；逐条写入日志会阻塞主机任务 | 默认 `LOG_WRITES=n`；写入时间戳走环形缓冲、心跳批量倾倒 |
| 测量本身改变时序 | 压力循环每帧 3 次互斥锁加锁（约几微秒）+ 每帧一次 `esp_timer_get_time` | 量级远小于 1.4ms 的刷新时间；且五组共用同一套测量代码，组间可比 |
| FreeRTOS tick 量化 | `CONFIG_FREERTOS_HZ=100`，10ms/tick；周期不是 10ms 整数倍时会被取整 | 默认 50ms = 5 tick；判据用「实际周期 + 5ms」而不是配置值 |
| `loop_gap` 不能定位原因 | 只知道「渲染任务被推迟」，不知道是 BLE、flash 还是别的中断 | 用 `ble write` 时间戳做相关性分析；组 2/3 与组 1 对照 |
| `mem_block_symbols` 上限 | C3 只有 192 word；384 预期初始化失败 | 组 4 已把它设计成「记录失败」，固件不再重启循环 |
| 全亮供电干扰 | 全白 30 灯约 1.8A，开发板 USB 供不上，会把掉压混进错色统计 | 压力模式默认亮度 64（暗红 RGB≈64,0,0，电流很小）；**同组内不得改亮度** |
| 3.3V 驱动 5V 本身就临界 | VIH=3.5V > 3.3V，可能单独导致偶发错色 | 组 1 正是用来分离这个因素的；画板必须加 74AHCT125 |

---

## 10. 用户执行清单（与 #7 验收项对应）

| 步骤 | 对应验收项 | 产出 |
|---|---|---|
| 1. `build-rmt-stress.cmd 48 steady sync 30` + 烧录；不连手机跑 30 分钟，录像 | 五组实验都跑过并留下数据（组 1） | §5.1 |
| 2. 同固件，nRF Connect 连上但不动，跑 30 分钟 | 组 2 | §5.2 |
| 3. 同固件，滑块/写入 20Hz，跑 30 分钟，录像 | 判定线：错色 ≤ 1 次/10min 且不可感知 | §5.3 + 结论 |
| 4. 依次构建 96 / 192 / 384 各跑 10 分钟（384 只看初始化失败） | `mem_block_symbols` 推荐值及理由 | §5.4 + 结论 |
| 5. 用最优 mem_block 重建，组 3 再跑 30 分钟确认 | 最终参数写进 Kconfig 默认值 | 更新 `Kconfig.projbuild` |
| 6. `build-rmt-stress.cmd 48 steady async 30` 跑 30 分钟 | 组 5：渲染路径对比 | §5.5 + 结论 |
| 7. 若不可接受：写结论 + 启动 SPI 评估 | 若不可接受，写清 SPI 备选评估 | 本文件 §6.3 / §8 |
| 8. 回传：每组串口完整日志 + 录像/观察记录 + 填好的表格 | 全部 | 本文件 |

**烧录注意**：COM6 归 #4 的肉眼观察与后续验收使用，本票不烧 COM6。请用板子当前实际端口，并在报告里注明端口号。
