/**
 * 首页卡片派生（`utils/control/home-view.ts`）。
 *
 * 这些规则是交互契约的一部分，页面代码在 node 里跑不起来，所以在这里锁死：
 *  - 选中项在设备被删除后必须能自愈（否则大卡停在已消失的设备上）；
 *  - 「已连接 / 开灯」才显示光晕，离线设备必须给中性灰（不假装有灯光颜色）；
 *  - 亮度百分比来自设备 State，不是写死的常量。
 */

import { describe, expect, it } from "vitest";
import {
  buildHomeView,
  glowStyle,
  hexAlpha,
  pickSelectedKey,
  thumbnailsOf,
} from "../utils/control/home-view";
import type { RecentDevice } from "../utils/control/device-history";
import type { DeviceRegistryEntry } from "../utils/control/device-registry";
import { baseState } from "./helpers/state";
import { MOCK_DEVICES } from "../utils/control/mock-devices";

const HW_A = "AA:BB:CC:DD:EE:01";
const HW_B = "AA:BB:CC:DD:EE:02";

function recent(overrides: Partial<RecentDevice> = {}): RecentDevice {
  return {
    deviceId: "DEV-A",
    hardwareId: HW_A,
    name: "Lumen-1A2B",
    lastConnectedAt: 2000,
    ...overrides,
  };
}

function registryEntry(overrides: Partial<DeviceRegistryEntry> = {}): DeviceRegistryEntry {
  return { deviceId: "DEV-A", hardwareId: HW_A, stripMask: 0xff, ...overrides };
}

describe("buildHomeView", () => {
  it("没有设备时给空态", () => {
    const view = buildHomeView({
      recent: [],
      registry: [],
      currentDeviceId: "",
      state: null,
      selectedKey: "",
    });
    expect(view.empty).toBe(true);
    expect(view.current).toBeNull();
    expect(view.cards).toEqual([]);
  });

  it("备注名优先于广播名", () => {
    const view = buildHomeView({
      recent: [recent()],
      registry: [registryEntry({ remark: "书桌" })],
      currentDeviceId: "",
      state: null,
      selectedKey: "",
    });
    expect(view.current?.name).toBe("书桌");
    expect(view.current?.initial).toBe("书");
  });

  it("已连接且开灯：光晕 > 0，颜色是中性底色（v5 的 State 不再报 RGB）", () => {
    const state = baseState({ power: 1, brightness: 200, maxBrightness: 200 });
    const view = buildHomeView({
      recent: [recent()],
      registry: [registryEntry()],
      currentDeviceId: "DEV-A",
      state,
      selectedKey: "",
    });
    const card = view.current;
    expect(card?.connected).toBe(true);
    expect(card?.tone).toBe("on");
    expect(card?.glow).toBeGreaterThan(0);
    /* v5 的 State 是 32 字节且不含颜色摘要（§7.3），首页大卡只能用中性底色。
     * 以前那个颜色是 strip0/seg0 的投影，本来也不代表整台设备。 */
    expect(card?.colorHex.toUpperCase()).toBe("#8E8E93");
    expect(card?.brightnessPercent).toBe(100);
  });

  it("未连接：中性灰、无光晕、状态文案是「未连接」", () => {
    const view = buildHomeView({
      recent: [recent()],
      registry: [registryEntry()],
      currentDeviceId: "",
      state: null,
      selectedKey: "",
    });
    const card = view.current;
    expect(card?.connected).toBe(false);
    expect(card?.tone).toBe("offline");
    expect(card?.glow).toBe(0);
    expect(card?.colorHex).toBe("#8e8e93");
    expect(card?.brightnessPercent).toBeNull();
    expect(glowStyle(card!)).toBe("");
  });

  it("已连接但关灯：tone=off，且没有光晕", () => {
    const state = baseState({ power: 0, brightness: 80 });
    const view = buildHomeView({
      recent: [recent()],
      registry: [registryEntry()],
      currentDeviceId: "DEV-A",
      state,
      selectedKey: "",
    });
    expect(view.current?.tone).toBe("off");
    expect(view.current?.glow).toBe(0);
    expect(view.current?.powerOn).toBe(false);
  });

  it("返回的卡片里只有一张被标为 selected", () => {
    const view = buildHomeView({
      recent: [
        recent({ deviceId: "DEV-A", hardwareId: HW_A, lastConnectedAt: 3000 }),
        recent({ deviceId: "DEV-B", hardwareId: HW_B, lastConnectedAt: 2000 }),
      ],
      registry: [],
      currentDeviceId: "",
      state: null,
      selectedKey: "",
    });
    expect(view.cards).toHaveLength(2);
    expect(view.cards.filter((card) => card.selected)).toHaveLength(1);
  });

  it("小图行排除大卡那台", () => {
    const view = buildHomeView({
      recent: [
        recent({ deviceId: "DEV-A", hardwareId: HW_A, lastConnectedAt: 3000 }),
        recent({ deviceId: "DEV-B", hardwareId: HW_B, lastConnectedAt: 2000 }),
      ],
      registry: [],
      currentDeviceId: "",
      state: null,
      selectedKey: "",
    });
    const thumbs = thumbnailsOf(view.cards.map((card) => ({ ...card, glowStyle: "" })));
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0].key).not.toBe(view.selectedKey);
  });
});

describe("pickSelectedKey", () => {
  const cards = [
    { key: HW_A, deviceId: "DEV-A", connected: false },
    { key: HW_B, deviceId: "DEV-B", connected: true },
  ] as never[];

  it("保留用户上次的选择", () => {
    expect(pickSelectedKey(cards, HW_A, "DEV-B")).toBe(HW_A);
  });

  it("上次选的设备已被删除：退到当前连接的设备", () => {
    expect(pickSelectedKey(cards, "GONE", "DEV-B")).toBe(HW_B);
  });

  it("没有连接记录：退到第一台", () => {
    expect(pickSelectedKey(cards, "", "")).toBe(HW_A);
  });

  it("空列表返回空串（页面据此显示空态）", () => {
    expect(pickSelectedKey([], HW_A, "DEV-A")).toBe("");
  });
});

describe("hexAlpha / glowStyle", () => {
  it("#RRGGBB + alpha 变成 rgba", () => {
    expect(hexAlpha("#ffb478", 0.5)).toBe("rgba(255, 180, 120, 0.5)");
  });

  it("非法色值退回中性灰而不是抛错", () => {
    expect(hexAlpha("nope", 0.5)).toBe("rgba(142, 142, 147, 0.5)");
  });

  it("光晕样式里带设备颜色与透明度", () => {
    const style = glowStyle({
      key: "k",
      deviceId: "d",
      name: "n",
      initial: "n",
      connected: true,
      selected: true,
      statusText: "",
      metaText: "",
      tone: "on",
      colorHex: "#ffb478",
      glow: 0.5,
      powerOn: true,
      brightnessPercent: 50,
    });
    expect(style).toContain("radial-gradient");
    expect(style).toContain("rgba(255, 180, 120");
  });
});

describe("卡片封面图（photo）", () => {
  it("演示设备带自己的照片路径", () => {
    const spec = MOCK_DEVICES[0];
    const view = buildHomeView({
      recent: [
        {
          deviceId: spec.deviceId,
          hardwareId: spec.hwId,
          name: spec.broadcastName,
          lastConnectedAt: 1000,
        },
      ],
      registry: [],
      currentDeviceId: "",
      state: null,
      selectedKey: "",
    });
    expect(view.current?.photo).toBe(spec.photo);
    expect(view.current?.photo).toMatch(/^\/assets\/devices\/.+\.webp$/);
  });

  it("真实设备没有照片时返回空串（页面用设备色兜底，不假装有照片）", () => {
    const view = buildHomeView({
      recent: [{ deviceId: "REAL:01", hardwareId: "11:22:33:44:55:66", lastConnectedAt: 1000 }],
      registry: [],
      currentDeviceId: "",
      state: null,
      selectedKey: "",
    });
    expect(view.current?.photo).toBe("");
  });

  it("三台演示设备的照片互不相同", () => {
    const photos = MOCK_DEVICES.map((spec) => spec.photo);
    expect(new Set(photos).size).toBe(photos.length);
  });

  it("照片文件真实存在（防止路径写错只在真机上 404）", async () => {
    const { existsSync } = await import("node:fs");
    const { dirname, join, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const spec of MOCK_DEVICES) {
      const file = join(root, spec.photo.replace(/^\//, ""));
      expect(existsSync(file), `照片文件不存在：${spec.photo}`).toBe(true);
    }
  });
});

describe("用户自定义封面优先于演示图", () => {
  const spec = MOCK_DEVICES[0];

  function build(photos: Record<string, string>) {
    return buildHomeView({
      recent: [
        {
          deviceId: spec.deviceId,
          hardwareId: spec.hwId,
          name: spec.broadcastName,
          lastConnectedAt: 1000,
        },
      ],
      registry: [],
      currentDeviceId: "",
      state: null,
      selectedKey: "",
      photos,
    });
  }

  it("用户选过图：用用户的图，并标记为用户所选", () => {
    const view = build({ [spec.hwId]: "wxfile://my-cover.jpg" });
    expect(view.current?.photo).toBe("wxfile://my-cover.jpg");
    expect(view.current?.photoIsUserPicked).toBe(true);
  });

  it("用户没选过：退回演示图，且不标记为用户所选", () => {
    const view = build({});
    expect(view.current?.photo).toBe(spec.photo);
    expect(view.current?.photoIsUserPicked).toBe(false);
  });

  it("换成别的设备的图不会串到这台（按 hardwareId 精确匹配）", () => {
    const view = build({ "DE:AD:BE:EF:00:99": "wxfile://other.jpg" });
    expect(view.current?.photo).toBe(spec.photo);
    expect(view.current?.photoIsUserPicked).toBe(false);
  });
});
