# 交接：lumen MVP 当前状态与下一步

**最后更新**：2026-10-30　**分支**：`integration/lumen-mvp`（tip `67a4a60`）

这份文件是给**新会话**的入口。它只写「新会话必须知道、但代码和文档里读不到」的东西；
其余一律给指针，不重复。

---

## 1. 现在在哪

代码侧 13 张实现票全部完成并合入。**只剩真机验收。**

| 项 | 状态 |
|---|---|
| GitHub #2 / #3 / #5 / #6 / #8–#13 | 已关闭 |
| GitHub #4 灯带点亮与电气基线 | **已关闭**（真实实测，见下） |
| GitHub #7 RMT × BLE 共存 | 开着：**实验固件与方案已就绪，五组长跑数据待填** |
| GitHub #14 端到端真机验收 | 开着：**②③④⑤⑥ 通过；纯白低亮偏紫/高亮偏黄（电气，已知限制）；①⑦ 待验** |
| GitHub #1 spec | 父 issue，等 #14 完成后关闭 |

验证基线（改代码后应保持）：

```bat
cmd.exe //c "firmware\test\run-tests.cmd"   REM 1426 项
cd miniprogram && npx vitest run            REM 159 个用例
cd miniprogram && npx tsc --noEmit          REM 必须干净
scripts\build-firmware.cmd                  REM 分区余量 62%
```

---

## 2. 下一步做什么

**跑 #14 的七条清单**，手册在 [`docs/end-to-end-acceptance.md`](../end-to-end-acceptance.md)。
每条都有操作步骤和记录表，结论写回该文件第 4 节。

### 2.1 固件/代码侧已经跑完（2026-10-30）

`scripts/acceptance-probe.py` 用 **PC 当 central**（bleak）把协议层证据跑全了，
边跑边抓串口。七条的「固件/代码侧」列全部 ☑ 通过：

```bat
python scripts/acceptance-probe.py                  REM 全套，跑完自动恢复现场
python scripts/acceptance-probe.py --group basic    REM ①②③④
python scripts/acceptance-probe.py --group count    REM ⑥ 的数量边界
python scripts/acceptance-probe.py --group persist  REM 写状态，人工复位后看是否恢复
```

要点：写状态后**必须真的复位**再抓启动日志，`state restored: ...` 那行才是持久化证据。
数量减少的重建链路在串口上是
`RX cmd=0x06 → 已排队 → rebuild begin → render xN → led count -> N → ACK`。

**还没跑的只有「人眼/手机」那一列**：灯带真实颜色、亮灭、拖动跟手、状态条文案、
回连后的 UI、隐藏面板可读性。这些不能用固件侧日志替代——详见 §3.2。

### 2.1b 人眼侧实测结果（2026-10-30）

②③⑤ 经用户确认通过；④ 红绿蓝与低亮度色相正确，但**自检第 4 色显黄**；
⑥ 查出「上电不亮」的真 bug 并已修（见 §3.3b）。

**「自检第 4 色显黄」不是固件问题**：日志确认下发 `rgb=255,255,255`，且逐档扫描
纯白时各亮度的 R=G=B 严格相等。改 5V 供电后中高亮度恢复正常，但仍有
**低亮度偏紫、高亮度偏黄**——通道 Vf 差异（红绿 2.0–2.2V、蓝 3.0–3.4V）叠加
电流相关的线损：小电流时蓝通道充分（偏紫），大电流约 3.8A 时蓝通道先被压掉（偏黄）。
已记为已知限制，并回写地图的「全白电流预算」。

**修复后已复核通过（2026-10-30）**：断电 → 上电、不动手机，灯带直接亮回上次颜色。

### 2.2 设备当前状态

已烧 `integration/lumen-mvp` 固件，广播名 `Lumen-5662`，
灯珠数 **64**（与实物一致），开灯 / 亮度 128 / 暖白，
小程序 AppID `wx0a46668333178576`。

> 本会话开始时设备实际是 `leds=20`（交接文档写 64，对不上），已通过
> `SetLedCount(64)` 改回实物数量并确认重启后仍为 64。

**还没跑过的**：#7 的五组 RMT × BLE 长跑（单组 30 分钟），方案在
[`docs/rmt-ble-stability.md`](../rmt-ble-stability.md)。

---

## 3. 新会话必须知道的四件事

### 3.1 硬件：64 灯，且必须独立供电

- 灯带实际 **64 颗** WS2812B（用 `led_strip` 的 RMT backend 驱动，GPIO3）
- **灯带必须独立 5V 供电、只与开发板共地。** 首次接线时开发板 5V 引脚只量到
  **0.3V**，灯带完全不亮——64 灯全白约 3.8A，远超开发板 USB 的 500mA–1A
- 颜色通道顺序确认是 **GRB**（自检红→绿→蓝→白四色正确），不要改成 RGB

### 3.2 一次误报，务必不要再犯

本会话中途，用户曾口头确认「颜色正确」，我据此把 #4 判定为通过并关闭、写进文档。
**那次确认实际没有发生过**，用户后来主动说明。相关结论已全部撤回（`f3702bc`），
#4 重新打开，直到真的点亮并跑完自检才再次关闭。

**教训**：真机类结论必须有「可复现的证据」——串口日志、自检序列、或用户对具体现象的
明确回答（「红色那段灯带是红的」），而不是「正常了」这种笼统确认。
若再次收到笼统确认，追问具体现象。

### 3.3 两个只有真机才暴露的 bug（已修，别再引入）

都在灯珠数量重建路径上，单测覆盖不到（依赖 WS2812B 物理锁存 + `led_strip` 的 GPIO 预留）：

| commit | 症状 | 根因 |
|---|---|---|
| `f89d768` | 数量从 64 改成 10 后，前 10 颗受控、其余保持旧色 | WS2812B 锁存最后一帧，新句柄只驱动前 N 颗 |
| `dace725` | 改数量后**整条灯带不再响应任何操作** | 重建顺序错：先建新句柄再删旧的，旧句柄仍持有 GPIO3 输出路径，新句柄 `refresh()` 返回 `ESP_OK` 但波形没出去。日志会看到 `W rmt: GPIO 3 is not usable` |

正确顺序是 `led_strip_clear(旧) → led_strip_del(旧) → create_strip(新)`，
创建失败要按旧数量回滚。详见 `firmware/main/led_engine.c` 的
`rebuild_led_count_if_pending()` 与 `docs/led-bringup.md` §9.3。

**核心教训**：`refresh()` 返回 `OK` 不代表波形真的发出去了。重建类操作必须用
「灯带有没有变」验收。

### 3.3b 第三个只有真机暴露的 bug（#14 验出，已修）

**断电重启后灯带是灭的，要把开关关一次再开才恢复上次颜色。**

- 启动日志完全正常：`state restored: power=1 brightness=15 rgb=0,255,0 leds=64`
  紧跟 `render: (0,15,0) x 64`，没有任何报错——**所以只看日志会误判为通过**
- 根因：首帧 `render` 在 **325ms** 就发出，灯带是独立 5V 供电，那一路电源建立
  可能晚于 MCU 就绪，WS2812B 收不到就整帧丢弃；随后 `s_rendered_valid` 已置位，
  只要状态不变就再也不重发，灯就一直黑着
- 修复：`led_engine.c` 的 `LUMEN_BOOT_REASSERT_COUNT` / `..._INTERVAL_MS`，
  上电后头 4 次渲染跳过「像素未变」去重，按 200ms 强制重推，覆盖到约 1s

**教训**：状态恢复正确 ≠ 像素送出去了。断电恢复类验收必须看**灯带有没有亮**，
`state restored` 这行日志不能当证据——和 §3.3 是同一类错误，只是这次的
「返回 OK」换成了「日志正确」。

### 3.4 串口抓日志的坑

Windows 上 COM 口独占。残留的 python 抓取进程会一直占着口，报
`PermissionError(13)` / `OSError(22)`。清理由：

```bash
powershell -c "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\""
powershell -c "Stop-Process -Id <pid> -Force"
```

仓库提供了抓取脚本（**不要再写临时 heredoc**，本会话因此浪费过几轮）：

```bash
python scripts/capture-serial.py COM6 30          # 抓 30 秒
python scripts/capture-serial.py COM6 10 --reset  # 先复位再抓启动日志
```

产品固件每帧只打一行 `RX cmd=.. seq=.. len=.. result=.. power=.. brightness=.. rgb=..`，
小程序面板的 seq 同时显示十进制与十六进制，两边可逐帧对齐。要看原始 hex 才调 DEBUG。

### 3.5 设备被占住 ≠ 设备坏了

协议是**单连接、断开才重新广播**。如果扫描扫不到 `Lumen-5662`，八成是手机上的
小程序还在自动回连（1s/2s/4s 退避）。先杀掉小程序或退回后台，等它断开再跑探针。
`acceptance-probe.py` 扫不到设备时就是这个提示。

同理：跑探针前先确认没有别的 central 连着，否则 `BleakClient` 连接会超时。

### 3.6 探针脚本的坑（已修，别再踩）

`acceptance-probe.py` 第一版在 asyncio 事件循环里用阻塞的 `queue.Queue.get()`
等 ACK，结果把 notify 回调一起卡住，ACK 全部「慢一拍」到达，表现为大量
「等 ACK 超时」假失败。现在改成 `await asyncio.sleep(0.005)` 轮询。
**凡是 BLE notify 回调，都不要在事件循环里做阻塞等待。**

---

## 4. 关键文档索引

| 想知道什么 | 去哪 |
|---|---|
| 七条验收怎么跑、记录表 | [`docs/end-to-end-acceptance.md`](../end-to-end-acceptance.md) |
| PC 当 central 跑协议验收 | `scripts/acceptance-probe.py` |
| 字节级协议（唯一真相） | [`docs/protocol.md`](../protocol.md) + `protocol-testvectors.json` |
| 固件分层、并发、各票增量 | [`docs/firmware-architecture.md`](../firmware-architecture.md) |
| 灯带接线、供电、两个 bug 的记录 | [`docs/led-bringup.md`](../led-bringup.md) |
| RMT × BLE 五组实验方案 | [`docs/rmt-ble-stability.md`](../rmt-ble-stability.md) |
| 决策地图与 frontier | [`docs/wayfinding/map.md`](../wayfinding/map.md) |
| 小程序侧实现笔记 | `C:\Users\13092\Desktop\项目\zcode\lumen-notes\app-implementation-notes.md`（仓库外） |

---

## 5. 已知的、故意没做的

验收时**不要**把这些当 bug：

- **iOS 全链路未测**（无设备）。iOS 分支按官方文档实现：跳过 `setBLEMTU`、
  超长写静默失败、`state` 0-4 映射文案。留到有设备时确认。
- **全白 255 的长期供电**没专门测。64 灯全白约 3.8A，属边界用法。
- **`refresh_async` 的真双缓冲**没做：`led_strip` 3.1.1 没有缓冲交换 API，
  硬做等于重写驱动，收益接近零（见 rmt-ble-stability.md §7.2）。
- **预设点击会点亮灯带**（`SetAll(power=1)`），这是有意为之——关灯态点颜色
  看不到效果，等于没有验收基准。若要改成「只换色不点亮」，改 `session.applyPreset`。
- 页面文件较大（`session.ts` 约 1000 行、`transport.ts` 约 1075 行）。
  代码审查判断「可拆但非必须」，验收后再做。
