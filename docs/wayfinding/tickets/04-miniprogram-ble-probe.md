# 04：小程序 BLE 探测（最小可连）

**类型**：`wayfinder:prototype`（HITL）

## Question

小程序能不能扫到我们的设备、连上、协商 MTU、订阅 notify、写一帧数据并且设备收到？

这一票**故意不依赖固件业务代码**——用一个只回显的最小 GATT 服务即可。目的是把小程序侧 BLE 的全部平台差异（权限、MTU、deviceId 形态、notify 注册时机）在业务逻辑进来之前摸清楚。

### 要验证的

1. `wx.openBluetoothAdapter` / `wx.startBluetoothDevicesDiscovery` 带 serviceId 过滤能扫到
2. `wx.createBLEConnection` 成功率，以及 **iOS 上 deviceId 是 UUID 还是 MAC**
3. `wx.setBLEMTU` 在 Android 是否可用、iOS 是否需要跳过；协商前后单包可写长度实际是多少
4. `wx.notifyBLECharacteristicValueChange` 必须在 `createBLEConnection` 之后、且要等回调成功才能收通知（这个顺序错了会静默丢通知）
5. `write-no-response` 属性下 `wx.writeBLECharacteristicValue` 能否发，连续快发的实际表现
6. Android 的定位权限 + 系统蓝牙开关、iOS 的蓝牙授权，分别怎么处理
7. 断线时 `onBLEConnectionStateChange` 的触发时机，以及断线后重连是否需要重新订阅

## Blocked by

- 【开发环境就绪】——微信开发者工具要能真机预览

## 交付

- `miniprogram/` 下的最小可跑页面（一个按钮：扫描 → 连接 → 发测试帧 → 看回显）
- `docs/ble-notes.md`：iOS / Android 实测差异记录，特别是上面第 2、3、5、7 条

## 验收

- [ ] Android 真机能扫到并连上，MTU 协商结果记录在案
- [ ] iOS 真机能扫到并连上，deviceId 形态记录在案
- [ ] 发出一帧，设备回显被 notify 收到
- [ ] 断线 → 重连流程走通一次
- [ ] `docs/ble-notes.md` 里写清两端差异与踩到的坑
