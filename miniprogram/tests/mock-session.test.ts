/**
 * 演示模式下的**会话级**连通性（端到端，不经过页面）——v5 形状。
 *
 * 首页的「点大卡 → 连上 → 进设备页」整条链路依赖：会话把 `MockTransport` 当成
 * 一个普通传输层用，`connect` 之后 State / DeviceInfo / StripConfig / 布局 /
 * 场景都能读回，命令能写下去。这里直接断言这条链路，避免页面层掩盖住底层缺陷。
 *
 * v4 的 `mock-session.test.ts` 还测了「快捷档 / 清空方案 / 整组分区」——那些
 * 随「分区 / 剧本」模型退役了（见报告里的删除清单）。**留下来的是跨版本不变
 * 的那部分**：连接、扫描、设备列表、自检、逐组灯珠数、开关与亮度、身份。
 *
 * 只替换 storage（spec 允许的假件）；传输层是产品代码本身（MockTransport）。
 */

import { describe, expect, it, vi } from "vitest";
import { ControlSession } from "../utils/control/session";
import { MockTransport } from "../utils/ble/mock-transport";
import type { BleTransport } from "../utils/ble/transport";
import { MOCK_DEVICES } from "../utils/control/mock-devices";
import { seedMockDevices } from "../utils/control/mock-mode";
import { createSessionStorage } from "./helpers/storage";
import { loadRecentDevices } from "../utils/control/device-history";
import { loadRegistry } from "../utils/control/device-registry";
import { LOOP } from "../utils/protocol/constants";

const A = MOCK_DEVICES[0];
const B = MOCK_DEVICES[1];

interface Harness {
  session: ControlSession;
  transport: MockTransport;
}

function makeSession(): Harness {
  const transport = new MockTransport();
  const session = new ControlSession({
    platform: "other",
    devMode: false,
    storage: createSessionStorage(),
    transportOverride: transport as unknown as BleTransport,
    reconnectDelaysMs: [],
  });
  return { session, transport };
}

describe("演示模式：连接与会话链路", () => {
  it("connect 之后会话进入 ready，且能读到设备状态", async () => {
    const { session } = makeSession();
    try {
      const state = await session.connect(A.deviceId, A.broadcastName);
      expect(session.linkState).toBe("ready");
      expect(state.power).toBe(A.power);
      expect(state.brightness).toBe(A.brightness);
      expect(session.transport.currentDeviceId).toBe(A.deviceId);
    } finally {
      await session.disconnect();
    }
  });

  it("连接后 QueryDeviceInfo / QueryStripConfig 都拿到设备权威值", async () => {
    const { session } = makeSession();
    try {
      await session.connect(A.deviceId, A.broadcastName);
      const info = await session.queryDeviceInfo();
      expect(info.kind).toBe("ok");
      if (info.kind !== "ok") return;
      expect(info.info.hwId).toBe(A.hwId);
      expect(info.info.maxLeds).toBeGreaterThan(0);

      const config = await session.queryStripConfig();
      expect(config.kind).toBe("ok");
      if (config.kind !== "ok") return;
      expect(config.config.channels.length).toBeGreaterThan(0);
      /* 演示设备 0 有两条带：前两条已分配。 */
      expect(config.config.channels.filter((channel) => channel.assigned).length).toBe(2);
    } finally {
      await session.disconnect();
    }
  });

  it("queryLayout 读回该链的部位（设备权威）", async () => {
    const { session } = makeSession();
    try {
      await session.connect(A.deviceId, A.broadcastName);
      const result = await session.queryLayout(0);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.layout.parts.length).toBe(2);
      expect(result.layout.parts.map((part) => part.partId).sort()).toEqual([0, 1]);
    } finally {
      await session.disconnect();
    }
  });

  it("queryScene 读回部位头 + 每步 + 收尾（三段）", async () => {
    const { session } = makeSession();
    try {
      await session.connect(A.deviceId, A.broadcastName);
      const result = await session.queryScene(0);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.scene.parts.length).toBeGreaterThan(0);
      expect(result.scene.steps.length).toBeGreaterThan(0);
      /* 每一步都属于一个真实部位，且步号从 0 起。 */
      const first = result.scene.steps.find(
        (step) => step.stripId === 0 && step.partId === 0,
      );
      expect(first?.stepIndex).toBe(0);
    } finally {
      await session.disconnect();
    }
  });

  it("setPower / setBrightness 真的改设备状态", async () => {
    const { session } = makeSession();
    try {
      await session.connect(A.deviceId, A.broadcastName);
      const off = await session.setPower(A.power === 1 ? false : true);
      expect(off.kind).toBe("ok");
      if (off.kind !== "ok") return;
      expect(off.state.power).toBe(A.power === 1 ? 0 : 1);

      const on = await session.setPower(A.power === 1);
      expect(on.kind).toBe("ok");
      if (on.kind !== "ok") return;
      expect(on.state.power).toBe(A.power);

      session.commitBrightness(150);
      await new Promise((r) => setTimeout(r, 120));
      expect(session.deviceState?.brightness).toBe(150);
    } finally {
      await session.disconnect();
    }
  });

  it("自检命令成功返回，且不改设备状态（设备侧临时覆盖）", async () => {
    const { session } = makeSession();
    try {
      await session.connect(A.deviceId, A.broadcastName);
      const before = session.deviceState;
      const result = await session.selfTest();
      expect(result.kind).toBe("ok");
      expect(session.deviceState).toEqual(before);
    } finally {
      await session.disconnect();
    }
  });

  it("switchTo 换设备：状态换新", async () => {
    const { session } = makeSession();
    try {
      await session.connect(A.deviceId, A.broadcastName);
      const state = await session.switchTo(B.deviceId, B.broadcastName);
      expect(session.transport.currentDeviceId).toBe(B.deviceId);
      expect(state.brightness).toBe(B.brightness);
      /* B 的灯组数与 A 不同（这是「逐组真实」的前提）。 */
      expect(state.stripLedCounts[0]).toBe(B.stripCounts[0]);
    } finally {
      await session.disconnect();
    }
  });

  it("disconnect 之后会话回到 idle，状态被清空", async () => {
    const { session } = makeSession();
    await session.connect(A.deviceId, A.broadcastName);
    await session.disconnect();
    expect(session.linkState).toBe("idle");
    expect(session.deviceState).toBeNull();
    expect(session.deviceInfo).toBeNull();
    expect(session.stripConfigs).toBeNull();
  });
});

describe("演示模式：扫描", () => {
  it("扫描结果里包含三台演示设备", async () => {
    const { session } = makeSession();
    try {
      const seen: string[][] = [];
      session.onDevices((list) => seen.push(list.map((device) => device.deviceId)));
      await session.scan();
      expect(seen[0]).toHaveLength(3);
      await session.stopScan();
    } finally {
      vi.useRealTimers();
      await session.disconnect();
    }
  });

  it("扫描出的三台与 spec 的 deviceId 一致（列表派生依赖它）", async () => {
    const { session } = makeSession();
    try {
      const seen: string[][] = [];
      session.onDevices((list) => seen.push(list.map((device) => device.deviceId)));
      await session.scan();
      const first = seen[0] ?? [];
      for (const spec of MOCK_DEVICES) {
        expect(first, `${spec.remark} 应在扫描结果里`).toContain(spec.deviceId);
      }
      await session.stopScan();
    } finally {
      vi.useRealTimers();
      await session.disconnect();
    }
  });
});

describe("演示模式：播种写进真实存储键", () => {
  it("seedMockDevices 之后 recentDevices 立即可见（设备列表派生依赖它）", () => {
    const storage = createSessionStorage();
    seedMockDevices(storage);
    const recent = loadRecentDevices(storage);
    expect(recent.length).toBe(MOCK_DEVICES.length);
    for (const spec of MOCK_DEVICES) {
      expect(recent.map((entry) => entry.deviceId)).toContain(spec.deviceId);
    }
  });

  it("播种也写登记表（备注名与掩码在同一个键里）", () => {
    const storage = createSessionStorage();
    seedMockDevices(storage);
    const registry = loadRegistry(storage);
    expect(registry.devices.length).toBe(MOCK_DEVICES.length);
    const first = registry.devices.find((entry) => entry.deviceId === A.deviceId);
    expect(first?.remark).toBe(A.remark);
  });

  it("连接成功后写入最近连过列表（与真机同一条路径）", async () => {
    const { session } = makeSession();
    try {
      await session.connect(A.deviceId, A.broadcastName);
      const recent = session.recentDevices;
      expect(recent.map((entry) => entry.deviceId)).toContain(A.deviceId);
    } finally {
      await session.disconnect();
    }
  });
});

describe("演示模式：逐灯组灯珠数", () => {
  it("设备 B 的灯组长度确实与 A 不同（前提成立，否则本组测试无意义）", () => {
    expect(B.stripCounts[0]).not.toBe(A.stripCounts[0]);
  });

  it("会话按灯组给出真实灯珠数，与 strip 0 不同", async () => {
    const { session } = makeSession();
    try {
      await session.connect(A.deviceId, A.broadcastName);
      expect(session.stripLedCount(0)).toBe(A.stripCounts[0]);
      expect(session.stripLedCount(1)).toBe(A.stripCounts[1]);
      expect(session.stripLedCount(1)).not.toBe(session.stripLedCount(0));
    } finally {
      await session.disconnect();
    }
  });

  it("灯组开关按掩码读回（不是全局 power 的别名）", async () => {
    const { session } = makeSession();
    try {
      await session.connect(A.deviceId, A.broadcastName);
      expect(session.stripPower(0)).toBe((A.stripPowerMask & 0x01) !== 0);
      expect(session.stripPower(1)).toBe((A.stripPowerMask & 0x02) !== 0);
      /* 2 号带在掩码里是关的。 */
      expect(session.stripPower(2)).toBe(false);
    } finally {
      await session.disconnect();
    }
  });
});

describe("演示模式：循环三档在会话层生效", () => {
  it("setScenePart 的三档都能读到（不是布尔）", async () => {
    const { session } = makeSession();
    try {
      await session.connect(A.deviceId, A.broadcastName);
      for (const loop of [LOOP.NONE, LOOP.ALL, LOOP.LAST]) {
        const write = await session.setScenePart(0, 0, 0, 1, loop, true);
        expect(write.kind, `loop=${loop}`).toBe("ok");
        const read = await session.queryScene(0);
        expect(read.kind).toBe("ok");
        if (read.kind !== "ok") return;
        const part = read.scene.parts.find((item) => item.stripId === 0 && item.partId === 0);
        expect(part?.loop, `读回 loop=${loop}`).toBe(loop);
      }
    } finally {
      await session.disconnect();
    }
  });
});
