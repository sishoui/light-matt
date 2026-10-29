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

- writeNoResponse 推荐间隔：
- 需要写进传输层的平台分支：
- 未解释的现象：
- 是否阻塞 #7（小程序传输层与 codec）：
