# 真机 e2e：在电脑上跑通 BLE 全链路（2026-11-02）

**目标**：没有手机、没有真机预览的前提下，在电脑上验证**小程序真实的传输层与会话层**
连着**真实的 ESP32-C3** 能跑通。

**结果**：**8/8 通过**，连续两遍可重复。

---

## 0. 为什么能这么做

微信开发者工具的蓝牙是桩实现（实测 `createBLEConnection` 直接回
「开发者工具暂时不支持此 API 调试，请使用真机进行开发」），而 `noble` 在
Node 24 上 `node-gyp` 编译失败。

但 `ControlSession` 本来就支持 `transportOverride` 注入，且 `createWxStorage`
在没有 `wx` 时会安全降级。所以换一个思路：

```
node 测试（vitest）
  └─ globalThis.wx = 转发桩   ← 只替换 wx，不改一行产品代码
       └─ 子进程 scripts/ble-gateway.py（bleak）
            └─ PC 蓝牙 → ESP32-C3
```

**跑的是产品代码本身**：`transport.ts`、`session.ts`、`frame-codec.ts`、`chunk`
逻辑、`LatestWinsThrottle` 全都没改。替换的只有最底层的 `wx.*`。

这比「写一个假 transport」有价值得多：假 transport 只能验证调用顺序，这里验证的是
**真实的 MTU、分片、CRC、ACK 时序**。

---

## 1. 实测结果

```
Test Files  1 passed (1)
     Tests  8 passed (8)
  Duration  14.1s
```

| # | 用例 | 验证什么 |
|---|---|---|
| 1 | 网关能扫到 Lumen 设备 | 真实扫描，设备 `CC:8D:A2:C2:56:62` |
| 2 | BleTransport 连接后读到 37 字节 State | v3 契约核心；MTU=247 → 分片容量 180 |
| 3 | ControlSession 真实往返 | `SetPower` / `commitBrightness` 都收到真 ACK，亮度读回 60 |
| 4 | 段下发后读回逐字节一致 | **21B 两层定宽编码全链路**：type/hue/period 原样回来 |
| 5 | 非法参数在客户端就被拦下 | 单层带 `blend≠0` 抛 `RangeError`，不发请求 |
| 6 | 超出灯珠数的段被设备拒绝 | `end=60` 客户端不知道实物长度，设备回 `InvalidParam (1)` |
| 7 | 每带开关只影响该带 | `pmask` bit1 翻转，其它位不动 |
| 8 | QueryDeviceInfo 返回真实 MAC 与 caps | `hwId` 匹配 MAC 格式，`maxStrips=8`，两层有、fade 无 |

关键实测数字：

```
MTU                 : 247（分片容量 180 字节 / 数据 179 字节）
State 长度          : 37 字节
段报告              : 21 字节，两层字段逐项一致
设备拒绝行为        : end=60 → result=1 (InvalidParam)
```

---

## 2. 防假通过：设备不在时真的 skip

把设备名前缀改成不存在的值后：

```
Tests  1 passed | 7 skipped (8)
```

**不是 8 passed。** 第一版写成 `if (!device) return;`，结果没设备时显示
「8 passed」——看起来像全验过了。改成 `itReal` + `ctx.skip()` 才能真正区分。

> 这是本轮第二个「差点自欺」的地方。第一个是模拟器的 `startBluetoothDevicesDiscovery`
> 返回成功但扫到 0 个设备。

---

## 3. 过程中修掉的三个真问题

| 问题 | 现象 | 根因 |
|---|---|---|
| 网关 properties 格式错 | `RX 不支持 writeNoResponse（固件与协议不匹配）` | 小程序要的是**对象** `{read,write,notify,writeNoResponse}`，我先写成了数组；且 `name.replace("-","NoResponse")` 把 `write-without-response` 变成 `writeNoResponseNoResponseNoResponse` |
| 网关 stdin 阻塞 | `scan_start` 永远不返回 | Windows ProactorEventLoop 不支持 `connect_read_pipe` 对 stdin；`sys.stdin.readline()` 阻塞会把扫描回调一起卡死。改成线程读 + asyncio 队列 |
| stub 双实例 | 写成功但永远收不到 ACK | 测试里建了两个 stub，网关事件派发到了另一个实例。改成全局单例 |

---

## 4. 与开发者工具模拟器的分工

两套手段覆盖不同层，**都要保留**：

| | 开发者工具模拟器 | 本真机 e2e |
|---|---|---|
| 页面渲染、提示文案、入口显隐 | ✅ 唯一手段 | ❌ |
| 真实 BLE 连接 / 协议 / 分片 | ❌ 桩实现 | ✅ 唯一手段 |
| `wx` 平台差异（Android/iOS） | 部分 | ❌ |

所以 `npm test`（607 用例）与 `npm run test:ble`（8 用例）是互补的，
不是替代关系。

---

## 5. 复现

```bash
# 前置：设备上电、未被占用；Python 有 bleak
python -m pip install bleak

cd miniprogram
npm run test:ble          # 真机 e2e（8 用例，约 15s）
npx vitest run            # 常规单测（607 用例，不含 e2e）
```

配置分离是刻意的：`vitest.config.ts` 只跑 `tests/*.test.ts`，
`vitest.e2e.config.ts` 只跑 `tests/e2e/**`。混在一起会让 `npm test`
在没有设备的机器上失败，或者更糟——假装通过。

---

## 6. 仍未覆盖的

1. **iOS 平台差异**：桩固定 `platform: "android"`，iOS 走系统协商 MTU 的路径没验。
2. **分片写入的真实触发**：本机 MTU 247，21B 段是单片。要测分片得强制小 MTU
   （`--mtu` 参数未实现，bleak 也不能主动协商）。
3. **断线重连**：`Reconnect` 状态机在单测里有覆盖，真机拔电重连本轮没跑。
4. **20Hz 节流的真实节奏**：`commitBrightness` 只验了最终值落地，没测连续拖动时的
   实际帧率。
