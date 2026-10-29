# 04：小程序 BLE 探测（最小可连）

**类型**：`wayfinder:prototype`（HITL）

## Question

小程序能不能扫到我们的设备、连上、协商 MTU、订阅 notify、写一帧数据并且设备收到？

这一票**故意不依赖固件业务代码**——用一个只回显的最小 GATT 服务即可。目的是把小程序侧 BLE 的全部平台差异（权限、MTU、deviceId 形态、notify 注册时机）在业务逻辑进来之前摸清楚。

### 要验证的

1. `wx.openBluetoothAdapter` / `wx.startBluetoothDevicesDiscovery` 带 serviceId 过滤能扫到
2. `wx.createBLEConnection` 成功率，以及 **iOS 上 deviceId 是 UUID 还是 MAC**
3. `wx.setBLEMTU` 在 Android 是否可用、iOS 是否必须跳过；协商前后单包可写长度实际是多少
4. `wx.notifyBLECharacteristicValueChange` 必须在 `createBLEConnection` 之后、且要等回调成功才能收通知（这个顺序错了会静默丢通知）
5. `write-no-response` 属性下 `wx.writeBLECharacteristicValue` 能否发，连续快发的实际表现
6. Android 的定位权限 + 系统蓝牙开关、iOS 的蓝牙授权，分别怎么处理
7. 断线时 `onBLEConnectionStateChange` 的触发时机，以及断线后重连是否需要重新订阅

### 研究已经确认的部分（不用再验，直接采信）

这些已在 [研究笔记](../research/ble-and-firmware-facts.md) A1-A7 中由官方文档确认，本票只需在设计上采纳，不必花时间复核：

- 单次写入上限 20 字节（ATT MTU 23 − 3）
- `wx.setBLEMTU` **仅 Android 5.1+ 有效**；iOS 无此 API，只能靠 `maximumWriteValueLength` 间接获知
- **iOS 超长写入静默失败**，无错误回调 → 客户端只能自己分包
- `writeType` 需显式指定 `writeNoResponse`（基础库 2.22.0+）；**并行多次写会失败**，必须串行化
- **Android 上 notify 成功后立刻 write 会报 10008** → 初始化序列里要塞间隔或先 read 一次
- `10006` = 连接已断，应重连而非重试写；`10001` = 适配器不可用，**不是致命错误**，模块已初始化，等 `onBluetoothAdapterStateChange`
- Android 6.0+ 无定位权限时**扫不到设备**（8.0.16 前还是静默失败）

### 本票真正要摸的（官方文档没写）

- Android / iOS 真机上 `setBLEMTU` 实际协商到多少
- `writeNoResponse` 的连续发送安全间隔（官方无数字）
- 国产 Android 机型的定位权限弹窗与蓝牙开关异常行为
- iOS 缓存设备记录导致的「连不上」要如何处理（从系统设置删设备是否有效）
- 微信 BLE 同时连接设备数上限（**官方完全没有数字**，只能实测）

### 不做

不做业务逻辑，不做协议解析。只验证「能不能连上、能不能收发」。

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
- [ ] 摸清 `writeNoResponse` 连续发送的安全间隔（给出推荐值）
- [ ] 记录国产 Android 机型的权限/开关异常行为（若有）
