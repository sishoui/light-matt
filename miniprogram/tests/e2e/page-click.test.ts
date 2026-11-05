/**
 * 真机点击链路（#118）：页面自己的事件处理器 → 真实灯控。
 *
 * 与单元层的关系：**驱动逻辑完全一样**，只是把传输层从演示换成
 * `BleTransport` 经 Python 网关连 PC 蓝牙。所以这里验的是单元层永远验不到的
 * 那一段——真实协商出的 MTU、真实分片与 CRC、真实 ACK 往返。
 *
 * 断言仍然只落在外部可观察行为上：页面派生的 `data` 与**设备 State / QueryStrip**。
 *
 * 跑法：
 *   cd miniprogram && npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/page-click.test.ts
 *
 * 设备不在时整层跳过，**输出里能看到跳过条数**（vitest 的 skipped 计数）。
 * 写入结束负责还原现场：停播、清分区、清剧本。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGateway, createWxStub } from "./wx-bridge.mjs";
import { installGlobals, instantiate, waitFor } from "../helpers/page-runtime";

let gateway: any = null;
let device: any = null;
let session: any = null;
let page: any = null;
let captured: any[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tap = (dataset: Record<string, any>) => ({ currentTarget: { dataset } });

/** flags 里的循环档位（§7.5 位表）。 */
function loopOf(flags: number): number {
  if ((flags & 0x01) === 0) {
    return 0;
  }
  return (flags & 0x04) !== 0 ? 2 : 1;
}

beforeAll(async () => {
  const wxStub = createWxStub({ call: (...a: any[]) => gateway.call(...a), ready: Promise.resolve() });
  gateway = startGateway({ onEvent: (msg: any) => wxStub.pump(msg) });
  await gateway.ready;
  wxStub.setGateway(gateway);
  const wx = wxStub.wx;
  globalThis.wx = wx;

  device = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 25_000);
    const handler = (res: any) => {
      const hit = (res.devices || []).find((d: any) => (d.name || "").startsWith("Lumen-"));
      if (hit) {
        clearTimeout(timer);
        wx.offBluetoothDeviceFound(handler);
        resolve(hit);
      }
    };
    wx.onBluetoothDeviceFound(handler);
    wx.startBluetoothDevicesDiscovery({ allowDuplicatesKey: true });
  });
  await wx.stopBluetoothDevicesDiscovery({});
  if (device === null) {
    return;
  }

  const { BleTransport } = await import("../../utils/ble/transport");
  const { ControlSession } = await import("../../utils/control/session");
  const { FrameLog } = await import("../../utils/ble/log");
  const { setSessionForTest } = await import("../../utils/control/session-singleton");

  session = new ControlSession({
    platform: "android",
    devMode: false,
    transportOverride: new BleTransport({
      log: new FrameLog({ mirrorToConsole: false }),
      platform: "android",
    }),
  });
  /* Windows 的 BLE 栈偶发在订阅 notify 时取消（errCode=10000 / WinError
   * -2147023673），同一台设备重连即可。连着重试两次都失败才判失败。 */
  await connectWithRetry(() => session.connect(device.deviceId, device.name));

  /* 页面 onLoad 拿的是 App 级单例，必须先把它指向这条已连接的会话。 */
  setSessionForTest(session);

  captured = installGlobals({ wx });
  await import("../../pages/strip/strip");
  const def = captured[captured.length - 1];
  page = instantiate(def);
  page.onLoad({ strip: "0" });
  page.onShow();
  await waitFor(() => page.data.ready === true, { timeoutMs: 25_000, label: "页面 ready" });

  /* 现场还原要用的快照。 */
  await session.setPlayback(0, 0).catch(() => undefined);
}, 150_000);

afterAll(async () => {
  try {
    if (session !== null) {
      await session.setPlayback(0, 0).catch(() => undefined);
      for (let stripId = 0; stripId < 8; stripId += 1) {
        const queried = await session.queryStrip(stripId).catch(() => null);
        if (queried !== null && queried.kind === "ok") {
          for (const report of queried.reports) {
            await session.clearSegment(stripId, report.segId).catch(() => undefined);
          }
        }
      }
      if (page !== null) {
        await session.clearScript?.(page.currentDraft().scriptId).catch(() => undefined);
      }
      await session.disconnect();
    }
  } finally {
    gateway?.stop();
  }
});

/**
 * 连一次，失败就重连一次（只在连接这一步重试，断言失败绝不被掩盖）。
 *
 * Windows 的 BLE 栈偶发在订阅 notify 时取消（`errCode=10000` /
 * `WinError -2147023673 操作已被用户取消`）。实测发布级那次 21 里红了 1 条，
 * 紧接着整层重跑 21/21——环境抖动，但它和真实缺陷在报告里长得一样。
 */
async function connectWithRetry(connect: () => Promise<any>, attempts = 2) {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await connect();
    } catch (error) {
      lastError = error;
      if (i + 1 < attempts) {
        await sleep(800);
      }
    }
  }
  throw lastError;
}

/** 只有扫到设备才跑；没有设备时 vitest 会计入 skipped，不会显示成通过。 */
const itReal = (name: string, fn: () => unknown, timeout: number) =>
  it(name, async (ctx) => {
    if (device === null) {
      ctx.skip();
    }
    return fn();
  }, timeout);

describe("#118 真机点击链路", () => {
  itReal("扫到设备、连上、页面就绪", () => {
    expect(device.name).toMatch(/^Lumen-/);
    expect(session.deviceState).toBeTruthy();
    expect(page.data.ready).toBe(true);
  }, 60_000);

  itReal("页面点击「进阶」后，页面真的给出时间轴与循环三档", async () => {
    page.onModeTap(tap({ mode: "advanced" }));
    await sleep(400);
    expect(page.data.mode).toBe("advanced");
    expect(page.data.steps.length).toBeGreaterThan(0);
    expect(page.data.loopChoices).toHaveLength(3);
  }, 90_000);

  itReal("划选分区并应用后，真实设备读回同一区间", async () => {
    page.onStepAdd();
    await sleep(300);
    page.onZoneAdd();
    await sleep(400);
    page.onPickerCellTap(tap({ index: "0" }));
    await sleep(200);
    page.onPickerCellTap(tap({ index: "9" }));
    await sleep(200);
    expect(page.data.pickerCanConfirm).toBe(true);
    page.onPickerConfirm();
    await sleep(500);

    await page.applyAdvanced();
    await sleep(2500);
    await session.setPlayback(0, 0).catch(() => undefined);
    await sleep(800);

    const queried = await session.queryStrip(0);
    expect(queried.kind).toBe("ok");
    const reports = queried.kind === "ok" ? queried.reports : [];
    expect(
      reports.some((r: any) => r.start === 0 && r.end === 9),
      `设备应能读回 0-9，实际 ${reports.map((r: any) => `${r.start}-${r.end}`).join(", ") || "无"}`,
    ).toBe(true);
  }, 150_000);

  itReal("循环三档：点一档，真实设备的循环位就变到那一档", async () => {
    for (const mode of [1, 2, 0] as const) {
      page.onLoopTap(tap({ value: String(mode) }));
      /* 等这一次下发收尾，不然两次 applyAdvanced 会在 BLE 上并发被拒。 */
      await waitFor(() => page.data.applying !== true, {
        timeoutMs: 25_000,
        intervalMs: 200,
        label: `第 ${mode} 档下发收尾`,
      }).catch(() => undefined);

      const fresh = await session.refreshState();
      expect(loopOf(fresh.flags), `点第 ${mode} 档后设备 flags=0x${fresh.flags.toString(16)}`).toBe(
        mode,
      );
      expect(page.currentDraft().loop, "草稿也要记下这一档").toBe(mode);
    }
  }, 180_000);

  itReal("收尾：设备回到干净状态", async () => {
    await session.setPlayback(0, 0).catch(() => undefined);
    for (let stripId = 0; stripId < 8; stripId += 1) {
      const queried = await session.queryStrip(stripId);
      if (queried.kind === "ok") {
        for (const report of queried.reports) {
          await session.clearSegment(stripId, report.segId).catch(() => undefined);
        }
      }
    }
    await sleep(800);
    const fresh = await session.refreshState();
    expect(fresh.stripSegCounts.every((count: number) => count === 0)).toBe(true);
  }, 120_000);
});
