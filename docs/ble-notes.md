# BLE 平台能力实测

测试目标：验证微信小程序在 iOS / Android 真机上的扫描、连接、MTU、notify、writeNoResponse 行为，记录平台差异。

## 测试环境

| 项 | 值 |
|---|---|
| 固件 | lumen BLE 回显（临时 fixture，Service UUID `6C756D65-6E00-4B1E-9A3C-000000000001`，广播名 `Lumen-ECHO`） |
| 板子 | ESP32-C3，MAC `cc:8d:a2:c2:56:62`，COM6 |
| 手机 A | 待填：型号 / 系统 / 微信版本 |
| 手机 B | 待填：型号 / 系统 / 微信版本 |

## 固件侧预期

- 广播包：flags + 128-bit Service UUID；扫描响应：`Lumen-ECHO`。
- 小程序写 RX（`...0002`，write-no-response）后，固件把同样的字节 notify 回 TX（`...0003`）。
- State（`...0004`）read 返回 8 字节：`01 80 FF B4 78 1E 00 FF`。
- 串口会打印连接间隔、MTU、每次 RX 长度。

## 测试步骤

1. 微信开发者工具打开 `miniprogram/`，点「预览」或「真机调试」，手机扫码。
2. 页面：点「打开适配器」→「扫描」。
3. 点 `Lumen-ECHO` 连接，观察日志里的 services / characteristics / notify / State。
4. 点「发 20 字节」，确认 `TX <-` 与 `RX ->` 的 hex 完全一致。
5. 依次点「连发 @20ms / @50ms / @100ms」，记录 20 帧里收到多少回显。
6. 点「断开」再「重连」。
7. 关闭手机蓝牙再打开，观察 10001 与自动恢复。
8. 点「复制日志」把面板内容带回。

## 结果

### 已实测（2026-10-30，手机平台待补）

- **连接参数**（固件串口）：`connected itvl=24 latency=0 timeout=500` → 连接间隔 **30ms**，latency 0，超时 5s。
- **MTU**：连接时 23，随后 `mtu updated=256`。
- **单发 20 字节**：`TX <-` 与 `RX ->` 逐字节一致。
- **三轮连发**（每轮 20 帧）全部回显，`notify failed` 0 次：

| 请求间隔 | 实收帧数 | 实际平均间隔 | 时长 |
|---|---|---|---|
| 20ms | 20 | 27ms | 0.51s |
| 50ms | 20 | 55ms | 1.05s |
| 100ms | 20 | 111ms | 2.10s |

- **断开/重连**：串口观察到 3 次连接；断开 `reason=531`，重连后 MTU 再次 23 → 256。
- **待补**：手机平台/型号、deviceId 形态、`setBLEMTU(185)` 的实际回包、services/characteristics properties、State 读回值、权限行为（日志最底部的早期行）。

### Android

- 型号 / 系统 / 微信版本：
- deviceId 形态（MAC / UUID）：
- `setBLEMTU(185)` 结果：
- 20 字节 echo：
- 连发回显数：@20ms / @50ms / @100ms =
- 断线 → 重连：
- 定位权限/蓝牙开关异常：
- 其它：

### iOS

- 型号 / 系统 / 微信版本：
- deviceId 形态（UUID）：
- 是否跳过 `setBLEMTU`：
- 20 字节 echo：
- 连发回显数：@20ms / @50ms / @100ms =
- 断线 → 重连：
- 蓝牙授权异常：
- 其它：

### 固件串口（连接时复制）

```
（粘贴 idf.py monitor 里的 connected / mtu 行）
```

## 结论

- **writeNoResponse 推荐间隔**：**20Hz（50ms）**。实测 20ms 请求也不丢包，但实收间隔被拉到 27ms；50ms 请求实收 55ms，稳定。传输层按「20Hz 上限 + latest-wins」即可，不需要更激进。
- **需要写进传输层的平台分支**：iOS 跳过 `setBLEMTU`；Android 调 `setBLEMTU`（最终值待回包确认）；notify 后先等 500ms 或先读 State 再写。
- **未解释的现象**：断开 `reason=531` 的精确含义待查；MTU 最终 256 与 `setBLEMTU(185)` 的关系待回包确认。
- **是否阻塞 #7**：不阻塞。20Hz 节流 + 串行写已在真机验证。
