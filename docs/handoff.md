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
| GitHub #14 端到端真机验收 | 开着：**当前唯一的主线任务** |
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

设备当前状态：已烧 `integration/lumen-mvp` 固件，广播名 `Lumen-5662`，
灯珠数已设为 **64**（与实物一致），小程序 AppID `wx0a46668333178576`。

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

---

## 4. 关键文档索引

| 想知道什么 | 去哪 |
|---|---|
| 七条验收怎么跑、记录表 | [`docs/end-to-end-acceptance.md`](../end-to-end-acceptance.md) |
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
