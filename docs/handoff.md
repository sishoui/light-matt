# 交接：lumen MVP 当前状态与下一步

**最后更新**：2026-10-30　**分支**：`integration/lumen-mvp`（已推送到 origin，见 `git log -1`）

这份文件是给**新会话**的入口。它只写「新会话必须知道、但代码和文档里读不到」的东西；
其余一律给指针，不重复。

---

## 1. 现在在哪

**MVP 已完成并通过 #14 真机验收。** 剩下的是三个未验证项（见下），不是主要工作量。

| 项 | 状态 |
|---|---|
| GitHub #2 / #3 / #5 / #6 / #8–#13 | 已关闭 |
| GitHub #4 灯带点亮与电气基线 | **已关闭**（真实实测，见下） |
| GitHub #7 RMT × BLE 共存 | **跳过实测（用户决定）——未验证，不是通过** |
| GitHub #14 端到端真机验收 | **已关闭：七条全部通过** |
| GitHub #1 spec | 父 issue，已关闭 |

> **最大的未验证项**：RMT × BLE 共存（#7）。方案、实验固件、判定工具都在，
> 只是没跑那 2.5 小时长跑。若真机出现「偶发闪一下 / 单颗灯变色」，
> 第一嫌疑就是它——补跑清单已写成一份自包含步骤发在
> [GitHub #7 的最新评论](https://github.com/sishoui/light-matt/issues/7#issuecomment-6524474831)，
> 照着做即可（含跑完烧回产品固件）。
>
> **另外三项也没验**：iOS 全链路（无 iOS 设备，用户现有 iPad，下阶段补测）、
> 小程序切后台回前台的静默回连、改灯珠数量时的毫秒级黑屏。逐条见
> [`end-to-end-acceptance.md`](../end-to-end-acceptance.md) §3。不要因为 §4 七条全绿就以为只剩 #7。

验证基线（改代码后应保持）：

```bat
cmd.exe //c "firmware\test\run-tests.cmd"   REM 1426 项
cd miniprogram && npx vitest run            REM 159 个用例
cd miniprogram && npx tsc --noEmit          REM 必须干净
scripts\build-firmware.cmd                  REM 分区余量 62%
```

---

## 2. 现在在哪 / 下一步

**MVP 已完成。** #14 七条全部通过，记录在
[`docs/end-to-end-acceptance.md`](../end-to-end-acceptance.md) 第 1、4 节。

**最大的未验证项是 #7（RMT × BLE 共存），用户决定跳过。** 这不是通过，是未验证。
方案、实验固件、判定工具都留在 [`docs/rmt-ble-stability.md`](../rmt-ble-stability.md)，
随时可以补跑：

```bat
scripts\build-rmt-stress.cmd 48 steady sync 30
scripts\flash-rmt-stress.cmd COMx   REM 板子当前端口，别照抄 COM6
python scripts\analyze-strip-video.py --selftest
```

完整、自包含的补跑清单（准备 → 五组操作 → 录像数错色 → 判定 → 收尾）已发在
[GitHub #7 的最新评论](https://github.com/sishoui/light-matt/issues/7#issuecomment-6524474831)。

补跑完记得用 `scripts\build-firmware.cmd` + `scripts\flash-firmware.cmd COMx` 烧回产品固件
（压力固件是另一套构建，别把它留在板子上）。

**产品固件现状**：`max_brightness = 200`（#14 供电结论，见 §2.2）。

### 2.1 #14 是怎么验的（复现方式）

固件/代码侧用 `scripts/acceptance-probe.py`（PC 当 central，bleak）跑协议，
边跑边抓串口，两边按 seq 对齐：

```bat
python scripts/acceptance-probe.py                  REM 全套，跑完自动恢复现场
python scripts/acceptance-probe.py --group basic    REM ①②③④
python scripts/acceptance-probe.py --group count    REM ⑥ 的数量边界
python scripts/acceptance-probe.py --group persist  REM 写状态，人工复位后看是否恢复
```

要点：写状态后**必须真的复位**再抓启动日志，`state restored: ...` 那行才是持久化证据。

人眼/手机侧（① ② ③ ④ ⑤ ⑥ ⑦ 的实际现象）由用户逐条确认。**追问要具体到现象**，
不要接受「都正常」——本仓库已经因此误报过一次（见 §3.2）。

### 2.2 人眼侧的关键结果

- ② ③ ⑤ ⑥ ⑦ 全部通过。
- ④ 红绿蓝与低亮度色相正确。**纯白有色偏**：低亮度偏紫、高亮度偏黄。
  固件侧逐档扫描确认 R=G=B 严格相等，所以不是 gamma 或通道顺序问题，
  而是通道 Vf 差异（红绿 2.0–2.2V、蓝 3.0–3.4V）叠加电流相关线损。
  已记为已知限制，回写地图「全白电流预算」。
- ⑦ 的日志同时验证了校验和、ACK seq 逐帧对应、State read 的 8 字节解析。
- ① 的已知限制：断开后点状态条**直接重连缓存设备**，不展示设备列表，
  用户无法主动切换设备。已回写地图「多设备管理」。

### 2.3 #7 已经准备好的判定工具

`scripts/analyze-strip-video.py` 解决「人眼数不清错色」这个关键弱点：

```bash
python scripts/analyze-strip-video.py --selftest            # 先验证判定逻辑本身
python scripts/analyze-strip-video.py rmt-g3-1.mp4 --segments 64
```

它把灯带切成 N 段、每段单独建滚动基线，所以**单颗灯错色也能抓到**。
自检覆盖 4 个用例（含曝光漂移+抖动下仍能抓真错色，且 0 假阳性）。
约 1100 fps，30 分钟录像 1.6 分钟分析完。

**必须每 10 分钟分段跑**，不要合并 30 分钟：脚本判断的是「这一帧和周围不一样」，
持续错色会在约 1 秒后被基线当成新常态。

### 2.4 设备当前状态

已烧 `integration/lumen-mvp` 固件，广播名 `Lumen-5662`，
灯珠数 **64**（与实物一致），`max_brightness=200`，小程序 AppID `wx0a46668333178576`。

> 本会话开始时设备实际是 `leds=20`（交接文档写 64，对不上），已通过
> `SetLedCount(64)` 改回实物数量并确认重启后仍为 64。
>
> `max_brightness=200` 来自 `8d8eb26`；该 commit 的 message 记录了当次验证
> （`state restored ... max=200`、brightness 84 输出 `(84,84,84)`），
> 但**本会话没有重新上机核对**。下次连上先读一次 State 确认第 7 字节是 200。
> **不要再用 255 的旧固件跑验收。**

**#7 跑之前注意**：实验固件与产品固件是两套构建，`scripts\build-rmt-stress.cmd`
只改临时副本，不碰仓库的 `sdkconfig.defaults`。跑完用 `build-firmware.cmd` 烧回产品固件。

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

- **iOS 全链路未测**（MVP 验收时无设备）。iOS 分支按官方文档实现：跳过 `setBLEMTU`、
  超长写静默失败、`state` 0-4 映射文案。**用户现有 iPad，下阶段补测。**
- **全白 255 的长期供电**没专门测，且已不成问题：亮度上限已定为
  `max_brightness=200`，不会输出 255。按亮度折算 64 灯全白约 **3.0A**（255 时实测
  3.8A，线性折算，未单独实测）。
- **`refresh_async` 的真双缓冲**没做：`led_strip` 3.1.1 没有缓冲交换 API，
  硬做等于重写驱动，收益接近零（见 rmt-ble-stability.md §7.2）。
- **预设点击会点亮灯带**（`SetAll(power=1)`），这是有意为之——关灯态点颜色
  看不到效果，等于没有验收基准。若要改成「只换色不点亮」，改 `session.applyPreset`。
- 页面文件较大（`session.ts` 约 1000 行、`transport.ts` 约 1075 行）。
  代码审查判断「可拆但非必须」，验收后再做。
