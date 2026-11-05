/**
 * 复杂方案的**小程序代理**真机验收：走产品代码（ControlSession +
 * BleTransport + 帧编解码）经 Python 网关连真实 ESP32。
 *
 * 与裸帧测试的区别：这条路验的是「小程序会不会把方案发对」——剧本展开、
 * 校验、帧序、失败回滚全是产品代码；裸帧测的是「固件契约对不对」。
 *
 * 覆盖：3 阶段 / 6 分区 / 4 个双层 / 混用相加·相乘·覆盖 / 循环三档。
 *
 * 跑法：
 *   cd miniprogram && npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/complex-plan.test.ts
 * 设备不在时自动 skip。**所有写入都会在 finally 里还原**。
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { startGateway, createWxStub } from "./wx-bridge.mjs";

let gateway;
let wxStub = null;
let device = null;
let session = null;
/** 现场快照：每条带的静态段（还原用）。 */
let backupStrips = [];
let backupState = null;
/** 测试用的剧本槽位：用 1，绝不碰用户在用的 0。 */
const SID = 1;

const TYPE = { STATIC: 0x00, BREATH: 0x01, RAINBOW: 0x02, COMET: 0x03, STROBE: 0x04, HEARTBEAT: 0x05, OFF: 0x06 };
const BLEND = { OVER: 0x00, MULTIPLY: 0x01, ADD: 0x02 };

const L = (type, hue, sat, periodMs, p5, flags, level) => ({ type, hue, sat, periodMs, p5, flags, level });
const EMPTY = L(0xff, 0, 0, 0, 0, 0, 0);

/** 3 阶段方案：每阶段多分区，4 个走双层。 */
function buildScript() {
  return {
    scriptId: SID,
    stripCount: 8,
    stages: [
      {
        durationMs: 3000,
        segments: [
          { stripId: 0, segId: 0, start: 0, end: 9, blend: BLEND.ADD,
            layer0: L(TYPE.STATIC, 1000, 255, 0, 0, 0, 100),
            layer1: L(TYPE.BREATH, 43690, 255, 1000, 0, 0, 40) },
          { stripId: 0, segId: 1, start: 10, end: 19, blend: BLEND.OVER,
            layer0: L(TYPE.RAINBOW, 0, 255, 800, 0, 0, 100), layer1: EMPTY },
          { stripId: 0, segId: 2, start: 20, end: 29, blend: BLEND.OVER,
            layer0: L(TYPE.STATIC, 21845, 255, 0, 0, 0, 100),
            layer1: L(TYPE.STROBE, 0, 255, 250, 128, 0, 60) },
        ],
      },
      {
        durationMs: 2000,
        segments: [
          { stripId: 0, segId: 0, start: 0, end: 14, blend: BLEND.MULTIPLY,
            layer0: L(TYPE.BREATH, 12000, 255, 1200, 10, 0, 80),
            layer1: L(TYPE.RAINBOW, 0, 255, 600, 0, 0, 50) },
          { stripId: 0, segId: 1, start: 15, end: 29, blend: BLEND.ADD,
            layer0: L(TYPE.STATIC, 54613, 255, 0, 0, 0, 100),
            layer1: L(TYPE.HEARTBEAT, 0, 255, 1000, 0, 1, 70) },
        ],
      },
      {
        durationMs: 1000,
        segments: [
          { stripId: 0, segId: 0, start: 0, end: 29, blend: BLEND.OVER,
            layer0: L(TYPE.RAINBOW, 0, 255, 1000, 1, 0, 100), layer1: EMPTY },
        ],
      },
    ],
  };
}

beforeAll(async () => {
  wxStub = createWxStub({ call: (...a) => gateway.call(...a), ready: Promise.resolve() });
  gateway = startGateway({ onEvent: (msg) => wxStub.pump(msg) });
  await gateway.ready;
  wxStub.setGateway(gateway);
  globalThis.wx = wxStub.wx;

  const wx = wxStub.wx;
  device = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 25_000);
    const handler = (res) => {
      const hit = (res.devices || []).find((d) => (d.name || "").startsWith("Lumen-"));
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
  if (device === null) return;

  const { BleTransport } = await import("../../utils/ble/transport");
  const { ControlSession } = await import("../../utils/control/session");
  const { FrameLog } = await import("../../utils/ble/log");
  session = new ControlSession({
    platform: "android",
    devMode: false,
    transportOverride: new BleTransport({ log: new FrameLog({ mirrorToConsole: false }), platform: "android" }),
  });
  await session.connect(device.deviceId, device.name);

  /* 备份现场：先停播，把静态配置读出来。 */
  await session.setPlayback(0, 0).catch(() => undefined);
  backupState = session.latestState;
  for (let s = 0; s < 8; s++) {
    const r = await session.queryStrip(s).catch(() => null);
    backupStrips.push(r && r.kind === "ok" ? r.reports : []);
  }
}, 120_000);

afterAll(async () => {
  if (session !== null) {
    /* 还原：清测试剧本、清 strip0 测试段、把静态段写回备份。 */
    await session.setPlayback(0, 0).catch(() => undefined);
    await session.clearScript(SID).catch(() => undefined);
    for (let s = 0; s < 8; s++) {
      for (let seg = 0; seg < 8; seg++) {
        await session.clearSegment(s, seg).catch(() => undefined);
      }
    }
    const saved = backupStrips;
    for (let s = 0; s < saved.length; s++) {
      for (const r of saved[s] ?? []) {
        await session.setSegment({
          stripId: s, segId: r.segId, start: r.start, end: r.end, blend: r.blend,
          layer0: r.layer0, layer1: r.layer1,
        }).catch(() => undefined);
      }
    }
    if (backupState !== null) {
      await session.activateScript(backupState.scriptId, 0).catch(() => undefined);
    }
    await session.disconnect();
  }
  gateway?.stop();
});

const itReal = (name, fn, timeout) =>
  it(name, async (ctx) => {
    if (device === null) ctx.skip();
    return fn();
  }, timeout);

describe("小程序代理：复杂方案（多阶段 / 多分区 / 双层 / 循环）", () => {
  itReal("扫到设备并连上", () => {
    expect(device.name).toMatch(/^Lumen-/);
    expect(session.latestState).toBeTruthy();
    expect(session.latestState.stripCount).toBeGreaterThanOrEqual(1);
  }, 60_000);

  itReal("ControlSession.downloadScript 接受这套 3 阶段方案", async () => {
    const script = buildScript();
    const validation = session.validateScriptForDevice(script);
    expect(validation.ok, validation.message).toBe(true);

    const result = await session.downloadScript(script, { activate: true, loop: 1 });
    expect(result.kind, JSON.stringify(result)).toBe("ok");
    expect(result.plan.frameCount).toBeGreaterThan(0);

    /* 帧序必须是 Begin → 各 Stage/Segment → Commit → Activate。 */
    const kinds = result.plan.steps.map((s) => s.kind);
    expect(kinds[0]).toBe("begin");
    expect(kinds[kinds.length - 1]).toBe("activate");
    expect(kinds).toContain("commit");
    expect(kinds.filter((k) => k === "segment").length).toBe(6);
  }, 120_000);

  itReal("下发后 QueryScript 摘要与设计一致（3 阶段、已激活）", async () => {
    const summary = await session.queryScript(SID);
    expect(summary.kind).toBe("ok");
    if (summary.kind !== "ok") return;
    expect(summary.summary.stageCount).toBe(3);
    expect(summary.summary.active).toBe(true);
  }, 60_000);

  itReal("播放推进：阶段序列 0→1→2→0（loop=1 全部循环）", async () => {
    await session.setPlayback(1, 1);
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      const st = await session.refreshState().catch(() => null);
      if (st) {
        if (seen.length === 0 || seen[seen.length - 1] !== st.stageIndex) seen.push(st.stageIndex);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(seen[0]).toBe(0);
    expect(seen).toEqual(expect.arrayContaining([0, 1, 2]));
    /* 全部循环：播完最后一阶段后必须回到 0。 */
    expect(seen.slice(seen.indexOf(2))).toContain(0);
  }, 60_000);

  itReal("loop=0 不循环：停在最后阶段，playback 归 0", async () => {
    await session.setPlayback(1, 0);
    let st = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000) {
      st = await session.refreshState().catch(() => null);
      if (st && st.playbackState === 0 && st.stageIndex === 2) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(st).toBeTruthy();
    expect(st.stageIndex).toBe(2);
    expect(st.playbackState).toBe(0);
  }, 60_000);

  itReal("每个阶段的生效分区数与设计一致（3 / 2 / 1）", async () => {
    const expected = { 0: 3, 1: 2, 2: 1 };
    for (const [stageStr, want] of Object.entries(expected)) {
      const want_stage = Number(stageStr);
      await session.setPlayback(0, 0);
      await session.activateScript(SID, 1);
      await session.setPlayback(1, 1);
      let st = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 12_000) {
        st = await session.refreshState().catch(() => null);
        if (st && st.stageIndex === want_stage && st.playbackState === 1) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(st, `没到达阶段 ${want_stage}`).toBeTruthy();
      await session.setPlayback(2, 1); /* 暂停，冻结在该阶段 */
      const frozen = await session.refreshState();
      /* State 的 stripSegCounts 报的是「当前生效」配置。 */
      expect(frozen.stripSegCounts[0], `阶段 ${want_stage} 的 strip0 分区数`).toBe(want);
      /*
       * 其余 7 条带：剧本里没有它们，所以**不该被方案接管**（#122）。
       *
       * 以前这里断言「全为 0」——那是方案接管整个设备时的旧行为。现在未参与
       * 的带报告的是**自己的实时分区数**（设备现场本来就有的，见 backupStrips），
       * 所以正确的判据是「等于开工前那一条的段数」，不是 0。
       *
       * 这正好把两个行为钉在一起：方案不动别人（数量不变），而且 State 报的
       * 是这一帧真正渲染的配置（不是整份方案）。
       */
      for (let s = 1; s < 8; s++) {
        const liveCount = (backupStrips[s] ?? []).length;
        expect(frozen.stripSegCounts[s], `阶段 ${want_stage} 的 strip${s} 应保持实时分区数`).toBe(
          liveCount,
        );
      }
    }
  }, 180_000);

  /**
   * 循环三档的整个判定。
   *
   * loop=2（最后一步循环）是 #98 新增的；本机这台设备烧的是 #98 之前的构建，
   * 会在协议层回 InvalidParam。两条都要钉住：
   *  - 客户端**会把 2 发出去**（不静默钳成 0/1，那样用户永远得不到 2 的效果）；
   *  - 旧固件**安全拒绝**（ack-error + resultCode 1），且不破坏已有配置。
   * 旧固件拒绝不是失败——把它断言成「要么成功要么被拒且配置未变」，
   * 换到新固件后同一用例自动转成「必须成功」。
   */
  itReal("loop=2：支持则生效，不支持则安全拒绝且不改配置", async () => {
    const before = await session.refreshState();
    const res = await session.activateScript(SID, 2);
    const after = await session.refreshState();

    if (res.kind === "ok") {
      /* 新固件：#98 已烧入，flags bit2 必须置位。 */
      expect(after.flags & 0x04, "loop=2 应置 flags.bit2").toBe(0x04);
      expect(after.flags & 0x01, "loop=2 也应保持 bit0 循环中").toBe(0x01);
    } else {
      /* 旧固件：必须明确拒绝，且配置原样。 */
      expect(res.kind).toBe("ack-error");
      if (res.kind === "ack-error") {
        expect(res.ack.resultCode).toBe(1); /* InvalidParam */
      }
      expect(after.scriptId, "被拒后激活剧本不变").toBe(before.scriptId);
      expect(after.stageIndex, "被拒后播放头不变").toBe(before.stageIndex);
    }
  }, 60_000);

  itReal("其他 7 条引脚的静态配置未被写入", async () => {
    for (let s = 1; s < 8; s++) {
      const r = await session.queryStrip(s);
      expect(r.kind).toBe("ok");
      const before = backupStrips[s] ?? [];
      expect(r.reports.length, `strip${s} 段数`).toBe(before.length);
      for (let i = 0; i < before.length; i++) {
        expect(r.reports[i].start).toBe(before[i].start);
        expect(r.reports[i].end).toBe(before[i].end);
        expect(r.reports[i].layer0.type).toBe(before[i].layer0.type);
        expect(r.reports[i].layer0.hue).toBe(before[i].layer0.hue);
      }
    }
  }, 120_000);
});
