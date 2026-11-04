/**
 * #91 / #94 删除设备的「一组动作」。
 *
 * 票面验收要求六处全部清干净，缺任何一步都会留下「删了但还在」的痕迹。
 * 这里用内存存储 + 假会话把整条链验证一遍，并单独确认演示设备的删除标记。
 */

import { describe, expect, it } from "vitest";
import { deleteDeviceFully } from "../utils/control/delete-device";
import {
  DEVICE_CACHE_KEY,
  loadCachedDevice,
  saveCachedDevice,
  type SessionStorage,
} from "../utils/control/device-cache";
import {
  RECENT_DEVICES_KEY,
  forgetDevice,
  loadRecentDevices,
  RECENT_DEVICES_KEY as RECENT_KEY,
} from "../utils/control/device-history";
import {
  DEVICE_REGISTRY_KEY,
  loadRegistry,
  setRemark,
} from "../utils/control/device-registry";
import { DEVICE_PHOTOS_KEY, loadDevicePhotos, setDevicePhoto } from "../utils/control/device-photo";
import { PLAN_DRAFTS_KEY, loadPlanDrafts, savePlanDraft } from "../utils/control/plan-drafts";
import { STRIP_META_KEY, loadStripMeta, setStripName } from "../utils/control/strip-meta";
import { MOCK_DELETED_KEY, loadMockDeleted } from "../utils/control/mock-deleted";
import { MOCK_DEVICES } from "../utils/control/mock-devices";
import type { ControlSession } from "../utils/control/session";

function memoryStorage(initial: Record<string, string> = {}): SessionStorage {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

/** 只实现删除路径用到的会话面（transport / disconnect / forgetRecent）。 */
function fakeSession(
  currentDeviceId: string,
  storage: SessionStorage,
  opts: { failDisconnect?: boolean } = {},
) {
  const calls: string[] = [];
  const forgotten: string[] = [];
  const session = {
    calls,
    forgotten,
    get transport() {
      return { currentDeviceId };
    },
    async disconnect() {
      calls.push("disconnect");
      if (opts.failDisconnect === true) {
        throw new Error("boom");
      }
    },
    forgetRecent(deviceId: string, hardwareId?: string) {
      forgotten.push(hardwareId === undefined ? deviceId : `${deviceId}|${hardwareId}`);
      forgetDevice(storage, deviceId, hardwareId);
    },
  };
  return session as unknown as ControlSession & { calls: string[]; forgotten: string[] };
}

/* 刻意避开 MOCK_DEVICES 的 ID：那个前缀会被当成演示设备。 */
const DEVICE_ID = "C8:2B:96:11:22:33";
const HW_ID = "AA:BB:CC:11:22:33";

/** 铺满六处存储的「脏」现场。 */
function dirtyStorage(): SessionStorage {
  const storage = memoryStorage();
  saveCachedDevice(storage, DEVICE_ID, "客厅");
  storage.set(
    RECENT_KEY,
    JSON.stringify([
      {
        deviceId: DEVICE_ID,
        hardwareId: HW_ID,
        name: "客厅",
        lastConnectedAt: 1,
        stripCount: 2,
        firmwareVer: 0x0400,
      },
    ]),
  );
  setRemark(storage, DEVICE_ID, "客厅");
  setDevicePhoto(storage, HW_ID, "/tmp/cover.jpg");
  setDevicePhoto(storage, DEVICE_ID, "/tmp/cover-old.jpg");
  setStripName(storage, HW_ID, 0, "书桌");
  setStripName(storage, HW_ID, 1, "床头");
  savePlanDraft(storage, HW_ID, 0, {
    scriptId: 0,
    stageCount: 1,
    loop: false,
    stages: [],
  } as never);
  return storage;
}

describe("删除设备：六处全部清干净", () => {
  it("断开连接 + 清缓存 + 清最近 + 清登记 + 清草稿 + 清灯组元数据 + 清封面", async () => {
    const storage = dirtyStorage();
    const session = fakeSession(DEVICE_ID, storage);

    const result = await deleteDeviceFully({
      storage,
      deviceId: DEVICE_ID,
      hardwareId: HW_ID,
      session,
    });

    /* 1. 断开。 */
    expect(result.disconnected).toBe(true);
    expect(session.calls).toContain("disconnect");
    /* 2. 上次设备。 */
    expect(loadCachedDevice(storage)).toBeNull();
    expect(storage.get(DEVICE_CACHE_KEY)).toBeNull();
    /* 3. 最近记录。 */
    expect(session.forgotten.length).toBe(1);
    expect(loadRecentDevices(storage)).toEqual([]);
    /* 4. 登记表。 */
    expect(loadRegistry(storage).devices).toEqual([]);
    /* 5. 方案草稿。 */
    expect(result.planDraftsCleared).toBeGreaterThan(0);
    expect(loadPlanDrafts(storage, HW_ID)).toBeNull();
    /* 6. 灯组元数据。 */
    expect(loadStripMeta(storage)).toEqual({});
    /* 7. 封面映射（两个键都清）。 */
    expect(loadDevicePhotos(storage)).toEqual({});
    expect(result.photosDeleted).toBe(2);
    /* 演示设备标记：真机不该写。 */
    expect(result.mock).toBe(false);
    expect(loadMockDeleted(storage)).toEqual([]);
  });

  it("连的是别的设备时不断开（不误伤当前连接）", async () => {
    const storage = dirtyStorage();
    const session = fakeSession("OTHER:DEV:ID", storage);
    const result = await deleteDeviceFully({
      storage,
      deviceId: DEVICE_ID,
      hardwareId: HW_ID,
      session,
    });
    expect(result.disconnected).toBe(false);
    expect(session.calls).not.toContain("disconnect");
    /* 记录照样清。 */
    expect(loadRegistry(storage).devices).toEqual([]);
  });

  it("断开抛错也继续清记录（设备可能已经自己断了）", async () => {
    const storage = dirtyStorage();
    const session = fakeSession(DEVICE_ID, storage, { failDisconnect: true });
    const result = await deleteDeviceFully({
      storage,
      deviceId: DEVICE_ID,
      hardwareId: HW_ID,
      session,
    });
    expect(result.disconnected).toBe(false);
    expect(loadRegistry(storage).devices).toEqual([]);
    expect(loadCachedDevice(storage)).toBeNull();
  });

  it("会话为 null 时仍清存储（页面还没拿到会话）", async () => {
    const storage = dirtyStorage();
    const result = await deleteDeviceFully({
      storage,
      deviceId: DEVICE_ID,
      hardwareId: HW_ID,
      session: null,
    });
    expect(loadRegistry(storage).devices).toEqual([]);
    expect(loadCachedDevice(storage)).toBeNull();
    expect(result.disconnected).toBe(false);
  });

  it("只清这台设备，别的设备原样保留", async () => {
    const storage = dirtyStorage();
    const otherId = "C8:2B:96:44:55:66";
    setRemark(storage, otherId, "卧室");
    setStripName(storage, "OTHER-HW", 0, "别人的灯组");
    setDevicePhoto(storage, otherId, "/tmp/other.jpg");

    await deleteDeviceFully({ storage, deviceId: DEVICE_ID, hardwareId: HW_ID, session: null });

    const registry = loadRegistry(storage);
    expect(registry.devices.map((entry) => entry.deviceId)).toEqual([otherId]);
    expect(loadStripMeta(storage)["OTHER-HW#0"]).toEqual({ name: "别人的灯组" });
    expect(loadDevicePhotos(storage)[otherId]).toBe("/tmp/other.jpg");
  });

  it("只剩后端记录（没有 deviceId）时也能清 hardwareId 侧的资产", async () => {
    const storage = memoryStorage();
    setStripName(storage, HW_ID, 0, "书桌");
    setDevicePhoto(storage, HW_ID, "/tmp/hw-cover.jpg");

    const result = await deleteDeviceFully({
      storage,
      deviceId: "",
      hardwareId: HW_ID,
      session: null,
    });

    expect(loadStripMeta(storage)).toEqual({});
    expect(loadDevicePhotos(storage)).toEqual({});
    expect(result.photosDeleted).toBe(1);
  });
});

describe("演示设备：记住「显式删除过」", () => {
  const mockId = MOCK_DEVICES[0].deviceId;

  it("删演示设备会写标记，真机不写", async () => {
    const storage = memoryStorage();
    const mock = await deleteDeviceFully({
      storage,
      deviceId: mockId,
      hardwareId: MOCK_DEVICES[0].hwId,
      session: null,
    });
    expect(mock.mock).toBe(true);
    expect(loadMockDeleted(storage)).toContain(mockId);

    const real = memoryStorage();
    await deleteDeviceFully({
      storage: real,
      deviceId: DEVICE_ID,
      hardwareId: HW_ID,
      session: null,
    });
    expect(loadMockDeleted(real)).toEqual([]);
  });

  it("标记持久化在独立键里，不与登记表混在一起", async () => {
    const storage = memoryStorage();
    await deleteDeviceFully({
      storage,
      deviceId: mockId,
      hardwareId: MOCK_DEVICES[0].hwId,
      session: null,
    });
    expect(storage.get(MOCK_DELETED_KEY)).toContain(mockId);
    expect(loadRegistry(storage).devices).toEqual([]);
  });
});

describe("存储键保持稳定（避免读到旧结构）", () => {
  it("删除涉及的所有键名都带版本号（.v1 或历史遗留的 .v2）", () => {
    for (const key of [
      DEVICE_CACHE_KEY,
      RECENT_DEVICES_KEY,
      DEVICE_REGISTRY_KEY,
      DEVICE_PHOTOS_KEY,
      PLAN_DRAFTS_KEY,
      STRIP_META_KEY,
      MOCK_DELETED_KEY,
    ]) {
      expect(/\.v\d+$/.test(key), key).toBe(true);
    }
  });
});
