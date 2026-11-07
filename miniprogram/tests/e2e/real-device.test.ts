/**
 * 真机 e2e：在 Node 里跑**真实的小程序传输层与会话层**，连**真实的 ESP32**。
 *
 * 链路：node 测试 → 子进程 Python `ble-gateway.py`（bleak）→ PC 蓝牙 → ESP32-C3
 * 被测代码是产品代码本身（`BleTransport` / `ControlSession` / 帧编解码），
 * 只把 `wx` 换成了转发网关的桩。
 *
 * 跑法：
 *   cd miniprogram && npm run test:ble
 * 设备不在时用例会 skip 并说明原因，不会假装通过。
 */

import { beforeAll, afterAll, describe, expect, it, beforeEach } from "vitest";

import { startGateway, createWxStub } from "./wx-bridge.mjs";

let gateway;
let wxStub = null;
/** 扫到的设备（null = 没有设备，后续真机用例 skip）。 */
let device = null;

const NAME_PREFIX = "Lumen-";

/**
 * 连一次，失败就重连一次。
 *
 * Windows 的 BLE 栈偶发在订阅 notify 时抛
 * `errCode=10000 … OSError: [WinError -2147023673] 操作已被用户取消`，
 * 同一台设备同一条命令重连即可（实测：发布级那次 21 里红了 1 条，紧接着
 * 整层重跑 21/21）。这是环境抖动，不是产品行为——但它会让整层在发布报告里
 * 变成 ❌，和真实缺陷长得一模一样。所以在这里收敛：两次都失败才可能是真问题。
 *
 * **只在连接这一步重试**：断言失败绝不被重试掩盖。
 */
async function connectWithRetry(connect: () => Promise<any>, attempts = 2) {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await connect();
    } catch (error) {
      lastError = error;
      if (i + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
  }
  throw lastError;
}

beforeAll(async () => {
  /*
   * 只创建一个 stub：它是全局 wx 的唯一实现，网关事件通过它派发给
   * transport 注册的监听器。早先每个用例各建一个，导致事件派发到了
   * 另一个实例上，表现为「写成功但永远收不到 ACK」。
   */
  wxStub = createWxStub({
    call: (...a) => gateway.call(...a),
    ready: Promise.resolve(),
  });
  gateway = startGateway({ onEvent: (msg) => wxStub.pump(msg) });
  await gateway.ready;
  wxStub.setGateway(gateway);
  globalThis.wx = wxStub.wx;
}, 60_000);

afterAll(async () => {
  gateway?.stop();
});

/** 扫描直到出现 Lumen 设备；超时返回 null。 */
async function discover(timeoutMs = 25_000) {
  const wx = wxStub.wx;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const handler = (res) => {
      const hit = (res.devices || []).find((d) => (d.name || "").startsWith(NAME_PREFIX));
      if (hit) {
        clearTimeout(timer);
        wx.offBluetoothDeviceFound(handler);
        resolve(hit);
      }
    };
    wx.onBluetoothDeviceFound(handler);
    wx.startBluetoothDevicesDiscovery({ allowDuplicatesKey: true });
  });
}

/* 有设备才跑，没有就 skip —— 必须让输出出现 skipped 计数，
 * 否则「8 passed」会让人误以为在没设备时也验证过了。 */
const itReal = (name, fn, timeout) =>
  it(name, async (ctx) => {
    if (!device) ctx.skip();
    return fn();
  }, timeout);

describe("真机 e2e（PC 蓝牙 → ESP32-C3）", () => {
  it("网关能扫到 Lumen 设备", async () => {
    device = await discover();
    if (!device) {
      console.warn("[e2e] 没扫到 Lumen 设备，真机用例将 skip（检查设备上电 / 未被占用）");
      return;
    }
    expect(device.deviceId).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i);
    expect(device.name).toMatch(/^Lumen-/);
  }, 40_000);

  itReal("BleTransport 连接后读到 32 字节 State，且 MTU ≥ 23", async () => {
    if (!device) return;
    const { BleTransport } = await import("../../utils/ble/transport");
    const { FrameLog } = await import("../../utils/ble/log");

    const transport = new BleTransport({
      log: new FrameLog({ mirrorToConsole: false }),
      platform: "android",
    });
    const state = await connectWithRetry(() => transport.connect(device.deviceId, device.name));

    /* State 是 v5 契约的核心：32 字节、8 带（§7.3）。这些字段错一个，
     * 后续所有逐带 UI 都会跟着错。 */
    expect(state.stripCount).toBeGreaterThanOrEqual(1);
    expect(state.stripCount).toBeLessThanOrEqual(8);
    expect(state.maxBrightness).toBeGreaterThan(0);
    expect(state.brightness).toBeLessThanOrEqual(state.maxBrightness);
    expect(state.stripLedCounts.length).toBeGreaterThanOrEqual(state.stripCount);
    expect(state.partCounts.length).toBeGreaterThanOrEqual(state.stripCount);

    await transport.disconnect();
  }, 60_000);

  itReal("ControlSession 真实往返：SetPower / SetBrightness 都收到 ACK", async () => {
    if (!device) return;
    const { BleTransport } = await import("../../utils/ble/transport");
    const { ControlSession } = await import("../../utils/control/session");
    const { FrameLog } = await import("../../utils/ble/log");

    const session = new ControlSession({
      platform: "android",
      devMode: false,
      transportOverride: new BleTransport({
        log: new FrameLog({ mirrorToConsole: false }),
        platform: "android",
      }),
    });

    await connectWithRetry(() => session.connect(device.deviceId, device.name));

    const power = await session.setPower(true);
    expect(power.kind).toBe("ok");

    /* 亮度走 20Hz latest-wins 通道，没有 setBrightness：
     * commitBrightness 是「松手提交」，会立即 flush 保证最终值落地。 */
    session.commitBrightness(60);
    /* flush 之后 ACK 异步回来，等它落地再读 State。 */
    await new Promise((r) => setTimeout(r, 600));
    const state = await session.refreshState();
    expect(state.brightness).toBe(60);

    await session.disconnect();
  }, 90_000);
});


describe("真机 e2e：协议语义（真 BLE）", () => {
  let session = null;

  beforeAll(async () => {
    if (!device) return;
    const { BleTransport } = await import("../../utils/ble/transport");
    const { ControlSession } = await import("../../utils/control/session");
    const { FrameLog } = await import("../../utils/ble/log");
    session = new ControlSession({
      platform: "android",
      devMode: false,
      transportOverride: new BleTransport({
        log: new FrameLog({ mirrorToConsole: false }),
        platform: "android",
      }),
    });
    await connectWithRetry(() => session.connect(device.deviceId, device.name));
  }, 90_000);

  afterAll(async () => {
    await session?.disconnect();
  });

  itReal("布局往返：写整条 1 部位 → 读回一致 → 再读场景", async () => {
    if (!session) return;
    const state = await session.refreshState();
    const ledCount = state.stripLedCounts[0] ?? 0;
    if (ledCount < 1) {
      console.warn("[e2e] strip 0 没有灯珠，跳过布局往返");
      return;
    }
    /* 整份重写：一个部位覆盖整条，1 个段。 */
    const write = await session.writeLayout(0, [
      {
        stripId: 0,
        partId: 0,
        nameLen: 0,
        name: "",
        segCount: 1,
        /* #158 起 LayoutPart 带相位（每部位一份，S6）：缺了它构造器会拒。 */
        phase: 0,
        segs: [[0, ledCount - 1]],
      },
    ]);
    expect(write.kind).toBe("ok");

    const layout = await session.queryLayout(0);
    expect(layout.kind).toBe("ok");
    if (layout.kind !== "ok") return;
    expect(layout.layout.parts).toHaveLength(1);
    expect(layout.layout.parts[0].segs).toEqual([[0, ledCount - 1]]);

    const scene = await session.queryScene(state.activeScene);
    expect(scene.kind).toBe("ok");
  }, 60_000);

  itReal("越界段被设备拒绝（客户端不知道实物长度，只能设备兜底）", async () => {
    if (!session) return;
    /* end=100 在协议 uint8 范围内（客户端只校验 ≤ 255），但远超该带实际灯珠数。
     * 这正是「客户端无从判断、必须由设备拒绝」的那一类。 */
    const before = await session.queryLayout(0);
    if (before.kind !== "ok") return;
    const result = await session.writeLayout(0, [
      { stripId: 0, partId: 0, nameLen: 0, name: "", segCount: 1, segs: [[0, 100]] },
    ]);
    /* 整份写入里只要有一帧被拒，就是失败（命令层 / 设备拦下都算）。 */
    expect(result.kind).not.toBe("ok");
  }, 30_000);

  itReal("每带开关只影响该带", async () => {
    if (!session) return;
    const off = await session.setStripPower(1, false);
    expect(off.kind).toBe("ok");
    const st = await session.refreshState();
    expect((st.stripPowerMask & 0x02)).toBe(0);

    const on = await session.setStripPower(1, true);
    expect(on.kind).toBe("ok");
    const st2 = await session.refreshState();
    expect((st2.stripPowerMask & 0x02)).toBe(2);
  }, 40_000);

  itReal("QueryDeviceInfo 返回真实 MAC 与 caps", async () => {
    if (!session) return;
    const info = await session.queryDeviceInfo();
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.info.firmwareVersion).toBeGreaterThan(0);
    expect(info.info.maxStrips).toBe(8);
    expect(info.info.maxParts).toBe(8);
    expect(info.info.maxScenes).toBe(3);
    expect(info.info.supportsTwoLayers).toBe(true);
    expect(info.info.fadeImplemented).toBe(false);
    expect(info.info.hwId).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i);
  }, 30_000);
});
