/**
 * #92 发现页与添加设备表单的规则。
 *
 * 锁三件事（都是用户可感知的行为，页面代码在 node 里跑不起来）：
 *  1. 搜索只匹配名称、不区分大小写、不匹配设备标识；
 *  2. 表单名称预填优先级：已有备注 > 已有名称 > 广播名；
 *  3. 「已添加过」的判定（deviceId 精确 / 广播名跨手机）。
 */

import { describe, expect, it } from "vitest";
import {
  buildAddPrefill,
  buildDiscoverRows,
  filterScanRows,
  matchesQuery,
  normalizeQuery,
  prefillName,
  signalBars,
  signalText,
} from "../utils/control/add-device";
import type { ScanRow } from "../utils/control/device-list";
import type { DeviceRegistryEntry } from "../utils/control/device-registry";

function row(overrides: Partial<ScanRow> & { deviceId: string }): ScanRow {
  return {
    name: "Lumen-9B77",
    displayName: null,
    rssi: -60,
    known: false,
    current: false,
    rssiText: "-60 dBm",
    ...overrides,
  };
}

function entry(overrides: Partial<DeviceRegistryEntry> & { deviceId: string }): DeviceRegistryEntry {
  return { stripMask: 0xff, ...overrides };
}

describe("搜索匹配", () => {
  it("去首尾空白、不区分大小写", () => {
    expect(normalizeQuery("  Lumen  ")).toBe("lumen");
    expect(matchesQuery(row({ deviceId: "a" }), "lumen")).toBe(true);
    expect(matchesQuery(row({ deviceId: "a" }), "LUMEN")).toBe(true);
    expect(matchesQuery(row({ deviceId: "a" }), "  lum ")).toBe(true);
  });

  it("匹配本机备注名（用户起的名字）", () => {
    const target = row({ deviceId: "a", name: "Lumen-9B77", displayName: "客厅灯带" });
    expect(matchesQuery(target, "客厅")).toBe(true);
    expect(matchesQuery(target, "灯带")).toBe(true);
  });

  it("**不**匹配设备标识（UUID / 广播名的 hex 部分不算名称）", () => {
    const target = row({ deviceId: "AA:BB:CC:DD:EE:FF", name: "" });
    expect(matchesQuery(target, "AA:BB")).toBe(false);
    expect(matchesQuery(target, "bb:cc")).toBe(false);
  });

  it("空搜索词匹配全部（保持信号降序）", () => {
    const rows = [
      row({ deviceId: "a", rssi: -40 }),
      row({ deviceId: "b", rssi: -80 }),
    ];
    expect(filterScanRows(rows, "   ").map((item) => item.deviceId)).toEqual(["a", "b"]);
  });

  it("过滤后不改变相对顺序", () => {
    const rows = [
      row({ deviceId: "a", name: "Lumen-A", rssi: -40 }),
      row({ deviceId: "b", name: "Other", rssi: -50 }),
      row({ deviceId: "c", name: "Lumen-C", rssi: -70 }),
    ];
    expect(filterScanRows(rows, "lumen").map((item) => item.deviceId)).toEqual(["a", "c"]);
  });

  it("没有匹配时返回空数组", () => {
    const rows = [row({ deviceId: "a", name: "Lumen-A" })];
    expect(filterScanRows(rows, "zzz")).toEqual([]);
  });
});

describe("表单名称预填优先级", () => {
  it("已有备注 > 已有名称 > 广播名", () => {
    expect(prefillName({ remark: "客厅", displayName: "旧的", broadcastName: "Lumen-1" })).toBe("客厅");
    expect(prefillName({ remark: "", displayName: "旧的", broadcastName: "Lumen-1" })).toBe("旧的");
    expect(prefillName({ remark: null, displayName: null, broadcastName: "Lumen-1" })).toBe("Lumen-1");
  });

  it("空白备注不算备注（不会把名字预填成空串）", () => {
    expect(prefillName({ remark: "   ", displayName: "", broadcastName: "Lumen-1" })).toBe("Lumen-1");
  });

  it("广播名去首尾空白", () => {
    expect(prefillName({ broadcastName: "  Lumen-2  " })).toBe("Lumen-2");
  });
});

describe("「已添加过」判定", () => {
  it("deviceId 精确命中 → 已添加，预填备注名", () => {
    const prefill = buildAddPrefill({
      row: row({ deviceId: "dev-1", name: "Lumen-1" }),
      registry: [entry({ deviceId: "dev-1", remark: "书桌" })],
      photo: "/tmp/cover.jpg",
      broadcastName: "Lumen-1",
    });
    expect(prefill.alreadyAdded).toBe(true);
    expect(prefill.name).toBe("书桌");
    expect(prefill.photo).toBe("/tmp/cover.jpg");
  });

  it("广播名跨手机命中 → 也已添加（另一台手机登记过）", () => {
    const prefill = buildAddPrefill({
      row: row({ deviceId: "new-uuid", name: "lumen-1" }),
      registry: [entry({ deviceId: "old-uuid", remark: "Lumen-1" })],
      photo: "",
      broadcastName: "lumen-1",
    });
    expect(prefill.alreadyAdded).toBe(true);
    expect(prefill.name).toBe("Lumen-1");
  });

  it("没登记过 → 不是已添加，预填广播名", () => {
    const prefill = buildAddPrefill({
      row: row({ deviceId: "dev-9", name: "Lumen-9" }),
      registry: [entry({ deviceId: "dev-1", remark: "书桌" })],
      photo: "",
      broadcastName: "Lumen-9",
    });
    expect(prefill.alreadyAdded).toBe(false);
    expect(prefill.name).toBe("Lumen-9");
  });

  it("空登记表不会误判（也不抛错）", () => {
    const prefill = buildAddPrefill({
      row: row({ deviceId: "dev-1", name: "Lumen-1" }),
      registry: [],
      photo: "",
      broadcastName: "Lumen-1",
    });
    expect(prefill.alreadyAdded).toBe(false);
    expect(prefill.name).toBe("Lumen-1");
  });

  it("备注为空的登记记录仍算「已添加过」（用户加过但没改名）", () => {
    const prefill = buildAddPrefill({
      row: row({ deviceId: "dev-1", name: "Lumen-1" }),
      registry: [entry({ deviceId: "dev-1" })],
      photo: "",
      broadcastName: "Lumen-1",
    });
    expect(prefill.alreadyAdded).toBe(true);
    expect(prefill.name).toBe("Lumen-1");
  });
});

describe("信号条", () => {
  it("四档分界", () => {
    expect(signalBars(-50)).toBe(4);
    expect(signalBars(-58)).toBe(4);
    expect(signalBars(-59)).toBe(3);
    expect(signalBars(-70)).toBe(3);
    expect(signalBars(-71)).toBe(2);
    expect(signalBars(-82)).toBe(2);
    expect(signalBars(-83)).toBe(1);
    expect(signalBars(-100)).toBe(1);
  });

  it("最弱也给一格（不会一格都没有）", () => {
    for (const rssi of [-120, -110, -100, -95]) {
      expect(signalBars(rssi)).toBeGreaterThanOrEqual(1);
    }
  });

  it("文案与格数一致", () => {
    expect(signalText(-50)).toBe("信号很强");
    expect(signalText(-65)).toBe("信号良好");
    expect(signalText(-75)).toBe("信号一般");
    expect(signalText(-95)).toBe("信号较弱");
  });
});

describe("清单行视图", () => {
  it("每行给出封面、首字、格数与 rssi 文本", () => {
    const views = buildDiscoverRows({
      rows: [row({ deviceId: "dev-1", name: "Lumen-1", rssi: -50 })],
      photoOf: () => "/cover.png",
    });
    expect(views.length).toBe(1);
    expect(views[0]).toMatchObject({
      deviceId: "dev-1",
      primary: "Lumen-1",
      photo: "/cover.png",
      signalBars: 4,
      rssiText: "-50 dBm",
      initial: "L",
    });
    expect(views[0].bars.map((bar) => bar.lit)).toEqual([true, true, true, true]);
  });

  it("没有广播名时用 deviceId 兜底，不渲染空名称", () => {
    const views = buildDiscoverRows({
      rows: [row({ deviceId: "AA:BB", name: "", rssi: -90 })],
      photoOf: () => "",
    });
    expect(views[0].primary).toBe("AA:BB");
    expect(views[0].photo).toBe("");
    expect(views[0].signalBars).toBe(1);
  });

  it("格数与 lit 布尔一一对应（wx:key 用的是 index）", () => {
    const views = buildDiscoverRows({
      rows: [row({ deviceId: "dev-1", rssi: -75 })],
      photoOf: () => "",
    });
    expect(views[0].bars).toEqual([
      { index: 0, lit: true },
      { index: 1, lit: true },
      { index: 2, lit: false },
      { index: 3, lit: false },
    ]);
  });

  it("known / current 原样传递（页面据此显示徽标）", () => {
    const views = buildDiscoverRows({
      rows: [row({ deviceId: "a", known: true, current: true })],
      photoOf: () => "",
    });
    expect(views[0].known).toBe(true);
    expect(views[0].current).toBe(true);
  });
});
