# 研究笔记：微信小程序 BLE × ESP32-C3 × WS2812 事实核查

> 调研日期：2026-10-29。来源均为官方文档（developers.weixin.qq.com / docs.espressif.com / 厂商 datasheet）。
> 标注约定：**确定** = 官方文档明文；**不确定** = 官方文档未明说、仅能从间接信息推断；**未找到权威来源** = 查不到，不做推测。

---

## A. 微信小程序 BLE 能力边界

### A1. `wx.writeBLECharacteristicValue` 单次写入长度上限 / 默认 MTU

**结论（确定）**：微信官方不做应用层包长限制，明文写的是「小程序不会对写入数据包大小做限制，但系统与蓝牙设备会限制蓝牙 4.0 单次传输的数据大小……建议每次写入不超过 20 字节」。20 字节 = 默认 ATT MTU 23 − 3 字节 ATT 头，这是 BLE 协议层的实际单次上限。
**结论（确定）**：iOS 上「若单次写入数据过长，iOS 上存在系统不会有任何回调的情况（包括错误回调）」——即 iOS 上超长写入可能既无 success 也无 fail，必须自己按 `maximumWriteValueLength(for:)` 分包。
**结论（确定，旁证）**：Android 官方 `BluetoothGatt#requestMtu` 文档写明 "The default MTU size is 23 bytes"；iOS CoreBluetooth 提供 `maximumWriteValueLength(for:)` 返回单次可写字节数。
来源：https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.html ；https://developers.weixin.qq.com/miniprogram/dev/framework/device/ble.html ；https://developer.android.com/reference/android/bluetooth/BluetoothGatt#requestMtu(int) ；https://developer.apple.com/documentation/corebluetooth/cbperipheral/maximumwritevaluelength(for:)

### A2. `wx.setBLEMTU` 的平台与上限

**结论（确定）**：基础库 2.11.0+；「需在 wx.createBLEConnection 调用成功后调用。**仅安卓系统 5.1 以上版本有效，iOS 因系统限制不支持**」；`mtu` 取值范围 **(22, 512)**，单位 bytes，success/fail 回包回带协商后的 mtu（安卓客户端 8.0.9 起支持该回包字段）。
**结论（确定）**：iOS 侧微信未提供改 MTU 的 API；iOS 由系统自动协商 MTU，应用侧只能通过「单次可写字节数」间接获知。注意：请求 512 不等于实际生效，最终值以回包 `res.mtu` 为准。
**不确定**：微信文档未说明 Android 上协商失败时是否回落到 23，也未给出「建议 MTU 值」。
来源：https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.setBLEMTU.html

### A3. 无响应写（writeNoResponse）能否用 `writeBLECharacteristicValue` 发送

**结论（确定）**：可以。`writeType` 参数（基础库 2.22.0+）合法值 `write`（强制回复写，不支持时报错）/ `writeNoResponse`（强制无回复写，不支持时报错）；不传时「iOS 优先 write，安卓优先 writeNoResponse」。特征是否支持无回复写可用 `wx.getBLEDeviceCharacteristics` 返回的 `properties.writeNoResponse` 判断。
**结论（确定）**：微信未定义 writeNoResponse 的速率/间隔限制，只给两条通用告警：「并行调用多次会存在写失败的可能性」；Android 上在 `notifyBLECharacteristicValueChange` 成功后**立即**调用写接口，部分机型会报 10008。
**不确定**：无响应写在 Android 上的实际发包速率（受连接间隔与 controller 缓冲约束）无官方数值；实践上通常自己串行化 + 20~50ms 节流，属社区经验。
来源：https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.html ；https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.getBLEDeviceCharacteristics.html

### A4. `wx.notifyBLECharacteristicValueChange` 的订阅前提

**结论（确定）**：「必须设备的特征支持 notify 或者 indicate 才可以成功调用」；且「必须先启用 wx.notifyBLECharacteristicValueChange 才能监听到设备 characteristicValueChange 事件」。参数 `state: true` 启用，`type` 可选 `notification` / `indication`（文档表格中 `type` 默认值标为 `indication`）。
**结论（确定）**：订阅成功 ≠ 有数据；「订阅操作成功后需要设备主动更新特征的 value，才会触发 wx.onBLECharacteristicValueChange 回调」——设备侧必须真正 notify（NimBLE 里即 `ble_gatts_notify_custom` / `ble_gatts_chr_updated`）。
**结论（确定）**：Android 上 notify 成功**立刻** write 会触发 10008，需要间隔（先做一次读或延时）再写。
来源：https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.notifyBLECharacteristicValueChange.html

### A5. Android 定位权限 / 蓝牙开关；iOS 额外要求

**结论（确定，Android）**：`wx.startBluetoothDevicesDiscovery` 明文「安卓 6.0 及以上版本，无定位权限或定位开关未打开时，无法进行设备搜索」；安卓 8.0.16 前是「调用成功但扫不到设备」（静默失败），8.0.16 起会返回错误。这是**扫描**的限制，连接/读写本身不要求定位权限。
**结论（确定）**：蓝牙开关未开或设备不支持 BLE 时 `wx.openBluetoothAdapter` 返回 errCode **10001**，但「此时小程序蓝牙模块已经初始化完成」，仍可调用所有 API 并监听 `wx.onBluetoothAdapterStateChange`——所以 10001 不是致命错误，应等开关打开。
**结论（确定，iOS）**：`wx.openBluetoothAdapter` 需要用户授权 `scope.bluetooth`；iOS 需对主机/从机模式**分别**调用一次并指定 `mode`（`central` / `peripheral`）；iOS 的 fail 回调带 state：0 未知 / 1 重置中 / 2 不支持 / 3 未授权 / 4 未开启。iOS 无定位权限要求（Beacon 例外，Beacon 要求微信有系统位置权限）。
来源：https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.startBluetoothDevicesDiscovery.html ；https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.openBluetoothAdapter.html ；https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/authorize.html ；https://developers.weixin.qq.com/miniprogram/dev/framework/device/beacon.html

### A6. 测试号是否可用 BLE 全量 API；真机调试 vs 预览

**结论（确定）**：测试号文档只说「为方便开发者开发和体验小程序、小游戏的各种能力……以及真机预览体验」，未列举任何能力黑名单；测试号用其 appid 在开发者工具建项目、点预览即可真机体验。
**结论（确定）**：能跑 BLE 的只有真机。BLE 框架文档明确「开发者工具上只能模拟**部分**蓝牙接口能力，完整功能请使用真机调试」，并要求「在各端的真机都进行调试」。
**结论（确定）**：真机调试 2.0 有版本门槛：Android 微信 ≥ 8.0.6、iOS 微信 ≥ 8.0.8，基础库 ≥ 2.18.1，且真机系统必须与所选机型一致；「预览」无调试器（只有 console 需打开调试模式）。
**未找到权威来源**：测试号在 BLE/隐私接口上的具体限制清单（官方未公开逐项限制），以及「预览 vs 真机调试」在 BLE 行为上的差异说明。
来源：https://developers.weixin.qq.com/miniprogram/dev/devtools/sandbox.html ；https://developers.weixin.qq.com/miniprogram/dev/framework/device/bluetooth.html ；https://developers.weixin.qq.com/miniprogram/dev/devtools/remote-debug-2.html

### A7. 常见错误码语义（尤其 10006 / 10008）

**结论（确定）**：0 ok；-1 already connect；10000 not init（未初始化蓝牙适配器）；10001 not available（适配器不可用，通常蓝牙未开）；10002 no device；10003 connection fail；10004 no service；10005 no characteristic；10006 no connection；10007 property not support；10008 system error；10009 system not support（Android 特有，系统 < 4.3）；10012 operate time out（连接超时）；10013 invalid_data（deviceId 为空/格式错）。
**结论（确定，10006 触发场景）**：`createBLEConnection` 文档明文「若对未连接的设备或已断开连接的设备调用数据读写操作的接口，会返回 10006 错误，建议进行重连操作」。即连接被系统/设备断开后继续写 → 10006，正确处理是监听 `onBLEConnectionStateChange` 后重连，而不是重试写。
**结论（确定，10008 触发场景）**：定义是「其余所有系统上报的异常」（兜底码），文档给出的已知触发场景是 Android 上 notify 成功后立即 write；另外连接未成对关闭会累积成 Android state 133 GATT ERROR（属同类系统层异常）。
来源：https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.createBLEConnection.html ；https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.html ；https://developers.weixin.qq.com/miniprogram/dev/framework/device/ble.html

### A8. 小程序同时连接设备数量限制

**未找到权威来源**：微信官方 BLE 全套文档（framework/device/ble、bluetooth、各 API 页）均无「同时连接设备数上限」的数字，只有「并行调用多次会存在写失败的可能性」这类间接提示。**不要把它写成某个具体数字。**
**结论（确定）**：数量上限实际由手机 OS 决定——Android 因机型/协议栈而异（常见 4~7 但无官方统一值），iOS CoreBluetooth 官方文档亦未公布硬上限。**不确定**：任何具体数字都属经验值。
**结论（确定，设备侧对照）**：真正可控的是 ESP32-C3 这端：Bluedroid `BT_ACL_CONNECTIONS` 默认 4（范围 1~9）；NimBLE `BT_NIMBLE_MAX_CONNECTIONS` 默认 3（范围 1~9）；controller `BT_CTRL_BLE_MAX_ACT` 默认 6（范围 1~10），每个实例约 828 B，且 C3 最多 10 个实例（含 ADV/SCAN），故「只用一个 ADV 时最多可连 9 台」。
来源：https://developers.weixin.qq.com/miniprogram/dev/framework/device/ble.html ；https://github.com/espressif/esp-idf/blob/v5.5/components/bt/host/bluedroid/Kconfig.in ；https://github.com/espressif/esp-idf/blob/v5.5/components/bt/host/nimble/Kconfig.in ；https://github.com/espressif/esp-idf/blob/v5.5/components/bt/controller/esp32c3/Kconfig.in

---

## B. ESP-IDF 侧（v5.5，目标 ESP32-C3）

### B9. NimBLE 与 Bluedroid 的取舍 / NimBLE GATT server 组成

**结论（确定）**：官方口径——Bluedroid 是**默认**栈，同时支持 Classic 与 BLE，需要两种技术时选它；NimBLE 仅 BLE，**「requires less heap and flash size」**，适合资源受限场景。ESP32-C3 上 Bluedroid 也只有 BLE（不支持 Classic），所以「要 Classic」这条理由在 C3 上不成立，NimBLE 是自然选择。
**不确定**：官方文档**没有给出两者的具体 flash/RAM 数字**（只有定性描述）。任何 KB 级数字需自行 `idf.py size` 实测，不要引用二手数值当官方结论。
**结论（确定）**：NimBLE + Bluedroid 共用同一套 ESP Bluetooth Controller（VHCI），所以射频/共存/最大连接数等 controller 层参数两者一致；API 成熟度上 Bluedroid 生态资料更多，NimBLE 直接沿用 Apache Mynewt 上游 API（`ble_gap_*` / `ble_gatts_*`），且官方 `bleprph` 示例完整。
**结论（确定，NimBLE GATT server 标准组件顺序）**：`nvs_flash_init()` → `nimble_port_init()` → 填 `ble_hs_cfg`（`reset_cb`、`sync_cb`、`gatts_register_cb`、`store_status_cb`，以及 `sm_*` 安全参数）→ `ble_svc_gap_init()` / `ble_svc_gatt_init()` → 用 `struct ble_gatt_svc_def` 数组描述服务/特征 → `ble_gatts_count_cfg()` + `ble_gatts_add_svcs()` → `ble_svc_gap_device_name_set()` → `nimble_port_freertos_init(host_task)` → 在 `sync_cb` 里 `ble_gap_adv_start()` → 主机任务里 `nimble_port_run()`。
来源：https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32c3/api-reference/bluetooth/index.html ；https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32c3/api-guides/ble/overview.html ；https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32c3/api-reference/bluetooth/nimble/index.html ；https://github.com/espressif/esp-idf/blob/v5.5/examples/bluetooth/nimble/bleprph/tutorial/bleprph_walkthrough.md ；https://github.com/espressif/esp-idf/blob/v5.5/examples/bluetooth/nimble/bleprph/main/gatt_svr.c

### B10. ESP32-C3FH4 规格与受限 GPIO

**结论（确定，datasheet v2.4）**：ESP32-C3FH4 = 4 MB **封装内** flash、QFN32 5×5、22 个 GPIO、环境温度 −40~105 °C、芯片版本 **v0.4**（注意：datasheet 把 `ESP32-C3FH4X` 标为 Recommended，`FH4AZ` 为 NRND；FH4/FH4X 的差别主要是 rev 与 16/22 GPIO，FH4X/FH4AZ 的 pin19~24 不 bonding）。
**结论（确定）**：CPU 为单核 32-bit RISC-V，最高 160 MHz（CoreMark 483.27）；无线为 2.4 GHz Wi-Fi 802.11b/g/n + Bluetooth 5 LE，带**内置 Wi-Fi/BLE 共存机制共享同一天线**，BLE 最大发射 20 dBm。
**结论（确定，RMT）**：`soc_caps.h`：`SOC_RMT_GROUPS=1`、`SOC_RMT_CHANNELS_PER_GROUP=4`（其中 TX 候选 2、RX 候选 2）、每通道 48 words（4 B/word）内存；**没有 `SOC_RMT_SUPPORT_DMA`** —— 即 **C3 的 RMT 不支持 DMA**（S3 有，C6/ESP32 也没有）。
**结论（确定，GPIO 红黄名单）**：strapping = **GPIO2 / GPIO8 / GPIO9**（GPIO9 内部弱上拉，默认值为 1；GPIO2 建议外部上拉以躲 power-up glitch）；不建议用：**GPIO12~GPIO17**（SPI0/1 接 flash）、**GPIO11**（VDD_SPI，除非 flash 外部供电）、**GPIO18/19**（USB Serial/JTAG）、**GPIO20/21**（UART0）、**GPIO4~GPIO7**（JTAG）。GPIO0/1 是 XTAL_32K 脚但可作普通 IO；默认驱动能力 GPIO2/3/4/5 为 10 mA，GPIO18/19 为 40 mA，其余 20 mA。
来源：https://www.espressif.com/sites/default/files/documentation/esp32-c3_datasheet_en.pdf （Table 1-1、2-1、2-7、3-1、3-3）https://github.com/espressif/esp-idf/blob/v5.5/components/soc/esp32c3/include/soc/soc_caps.h ；https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32c3/api-reference/peripherals/gpio.html

### B11. led_strip（espressif/led_strip，RMT backend）用法要点与限制

**结论（确定）**：用法——填 `led_strip_config_t`（`strip_gpio_num`、`max_leds`、`led_model=LED_MODEL_WS2812`、`color_component_format=LED_STRIP_COLOR_COMPONENT_FMT_GRB`、`invert_out`）+ `led_strip_rmt_config_t`（`clk_src`、`resolution_hz` 默认 10 MHz、`mem_block_symbols` 默认 **48**（非 ESP32/S2）、`with_dma`），`led_strip_new_rmt_device()`；之后 `led_strip_set_pixel*()` + `led_strip_refresh()`（或 `refresh_async` / `refresh_async_done`）+ `led_strip_clear()` / `led_strip_del()`。
**结论（确定，无硬性长度上限）**：组件未定义最大灯数；`max_leds` 只决定 `calloc(max_leds * bytes_per_pixel)` 的堆占用，越界写像素返回 `ESP_ERR_INVALID_ARG`；RMT 通道不足时 `led_strip_new_rmt_device` 报错。
**结论（确定，阻塞性）**：`led_strip_refresh()` **是阻塞的**（内部 `rmt_transmit` + `rmt_tx_wait_all_done(-1)` + `rmt_disable`）；`led_strip_refresh_async()` 非阻塞但**没有双缓冲**——在 `led_strip_refresh_async_done()` 返回前不得再改像素；`set_pixel+refresh` 非原子，多任务访问需自己加锁（并发 refresh 第二个任务拿 `ESP_ERR_INVALID_STATE`）。
**结论（确定，关键风险）**：C3 无 RMT DMA → 编码在 ISR 里逐块跑；README 明写「if the RMT interrupt is delayed or not serviced in time (e.g. if Wi-Fi interrupt happens on the same CPU core), the RMT transaction will be corrupted and the LEDs will display incorrect colors」。刷新耗时可按 30 µs/灯（800 kbps × 24 bit）+ 约 280 µs reset 估算（数据手册 ≥50 µs，驱动用 280 µs）——属算术推导（不确定项仅指具体数值随灯数线性变化）。
来源：https://espressif.github.io/idf-extra-components/latest/led_strip/index.html ；https://components.espressif.com/components/espressif/led_strip ；https://github.com/espressif/idf-extra-components/blob/master/led_strip/src/led_strip_rmt_dev.c ；https://github.com/espressif/idf-extra-components/blob/master/led_strip/src/led_strip_rmt_encoder.c

### B12. RMT 驱动 WS2812 与 BLE 射频共存是否有时序干扰

**结论（确定，官方有相关说明，但对象是「中断」不是「射频本身」）**：ESP-IDF RMT FAQ 明确「The encoding for the RMT transmission is carried out within the ISR context」；若编码被「interrupt latency and preemptive interrupts」拖慢，发送器会读到过期数据。官方给出的四条缓解措施之一原文是「**Install the RMT driver on a separate CPU core to avoid competing for the same CPU resources with other interrupt heavy peripherals (e.g. WiFi, Bluetooth)**」——**ESP32-C3 是单核，这条措施不可用**，只能靠加大 `mem_block_symbols`（48 的整数倍）、把编码函数放 IRAM、以及（若芯片支持）开 DMA（C3 不支持）。
**结论（确定，射频层）**：C3 只有一个 2.4 GHz 射频，Wi-Fi 与 BLE 采用时分复用 + 优先级仲裁；BLE Connected 与 Wi-Fi STA Connected 场景下每个共存周期内 Wi-Fi 与 BLE 各占约 50% 时间片——即 BLE 连接事件会周期性占用射频/中断资源，这正是上面「ISR 被拖慢」的现实诱因。
**不确定 / 未找到权威来源**：官方**没有**任何「RMT 波形会因 BLE 射频活动本身（而非中断延迟）产生时序抖动」的量化说明或 errata；也没有给出「BLE 连接间隔 vs WS2812 刷新失败率」的官方数据。led_strip README 只举了 Wi-Fi 的例子，BLE 属同类推断。
来源：https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32c3/api-reference/peripherals/rmt.html （FAQ 段）https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32c3/api-guides/coexist.html ；https://github.com/espressif/idf-extra-components/blob/master/led_strip/README.md

### B13. 3.3V 逻辑驱动 5V 供电 WS2812B 的电平风险与方案

**结论（确定，datasheet）**：WS2812B 的 DIN 输入阈值是 **VIH = 0.7 × VDD**、VIL = 0.3 × VDD；VDD = 5 V 时 VIH = **3.5 V**，高于 ESP32-C3 的 3.3 V 输出高电平（≈VDD=3.3 V）→ **在规格上不满足，属「能用但不保证」的临界状态**。另外 DIN 绝对最大输入为 −0.5~VDD+0.5 V，5 V 供电下 3.3 V 不会过压。
**结论（确定，Adafruit 官方教程）**：「If using a 3.3V microcontroller you must use a logic level shifter such as a **74AHCT125** or **74HCT245**」；唯一例外是「If you are powering your NeoPixels with 3.7v directly from a LiPoly cell, a 3.3v data signal is OK」。同页建议首灯并 **500~1000 µF / ≥6.3 V** 电容、数据线串 **300~500 Ω** 电阻（电阻放在靠近灯珠一端）。
**不确定（社区做法，非官方）**：把灯带供电降到 ~4.0~4.3 V 可让 VIH 落到 2.8~3.0 V 而免掉电平转换——原理成立（0.7×4.0=2.8 V），但**未找到 Espressif/Worldsemi 的官方背书**，且会牺牲亮度与颜色一致性。
**补充（确定）**：74AHCT125/74HCT245 需 5 V 供电、TTL 电平输入（VIH=2.0 V），3.3 V 输入可被正确识别；不要用 74HC125（CMOS 输入，5 V 供电时 VIH≈3.5 V，同样不满足）。
来源：https://cdn-shop.adafruit.com/datasheets/WS2812B.pdf （Electrical Characteristics：VIH 0.7VDD / VIL 0.3VDD）https://learn.adafruit.com/adafruit-neopixel-uberguide/best-practices

---

## C. 顺带核实（WS2812B 器件参数）

### C14. 单灯电流、刷新率上限、VIH 规格

**结论（确定，datasheet）**：数据速率 **800 kbps**、每像素 24 bit → 单灯传输时间 ≈ 30 µs；「scan frequency not less than **400 Hz/s**」；「When the refresh rate is 30 fps, cascade number are not less than **1024** points」；复位低电平 **>50 µs**；T0H 0.4 µs ±150 ns、T1H 0.8 µs ±150 ns、T0L 0.85 µs ±150 ns、T1L 0.45 µs ±150 ns（TH+TL = 1.25 µs ±600 ns）。
**结论（确定，datasheet 未给电流）**：WS2812B 官方 datasheet **没有**「每灯最大电流」条目（只有 R/G/B 正向电压 2.0~2.2 V / 3.0~3.4 V）。行业通用值是 **60 mA/灯全白**（3 通道 × 20 mA），来源为 Adafruit 官方教程：「Each individual NeoPixel draws up to **60 milliamps** at maximum brightness white」；配电源按 20 mA/灯 ×数量 ÷1000 估安培，要绝对裕量则用 60。
**结论（确定，算术推导）**：刷新率上限 = 1 / (N × 30 µs + 280 µs reset)；例如 30 灯 ≈ 1.18 ms → 理论 ~845 Hz，实际受 BLE/Wi-Fi 中断与 RMT 无 DMA 影响，远达不到；数据手册给的 400 Hz 是器件最低保证而非上限。
**结论（确定）**：VIH = 0.7 VDD、VIL = 0.3 VDD（同 B13）；5 V 供电下 VIH = 3.5 V。
来源：https://cdn-shop.adafruit.com/datasheets/WS2812B.pdf ；https://learn.adafruit.com/adafruit-neopixel-uberguide/powering-neopixels

---

## 附：本笔记中「未找到权威来源 / 不确定」清单（决策前需实测或另行确认）

1. 微信 BLE 同时连接设备数上限（A8）——官方无数字，只有 OS 层面限制。
2. 测试号在 BLE/隐私接口上的逐项限制（A6）——官方未公开清单。
3. iOS 上微信单次写入的实际字节数（A1/A2）——只能运行时调 `maximumWriteValueLength` 获取。
4. writeNoResponse 的安全发送间隔/速率（A3）——无官方数值。
5. NimBLE vs Bluedroid 的具体 flash/RAM 差值（B9）——官方仅定性，需 `idf.py size` 实测。
6. RMT×BLE 时序干扰的量化数据与 errata（B12）——官方只说明中断延迟风险。
7. 「降供电电压免电平转换」的官方背书（B13）——仅社区做法。
8. ESP32-C3FH4（rev v0.4，非 X）是否为目标量产料——datasheet 明确 FH4X 才是 Recommended，需与硬件方案确认。
