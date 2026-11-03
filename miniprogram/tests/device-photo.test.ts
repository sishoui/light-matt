/**
 * 设备封面（用户自定义图片）的存储逻辑。
 *
 * 这里只测**纯逻辑**：读写映射、按 deviceKey 取值、清除。
 * `wx.chooseMedia` / `saveFile` 那部分只在真机跑，靠模拟器人工验证。
 *
 * 为什么值得单测：封面是「用户做的决定」，一旦按错键（比如用 deviceId 而
 * 不是 hardwareId），iOS 换 UUID 后封面就整体丢失，而现象只是「图没了」，
 * 很难归因。
 */

import { describe, expect, it } from "vitest";
import {
  clearDevicePhoto,
  DEVICE_PHOTOS_KEY,
  loadDevicePhotos,
  photoKeyOf,
  setDevicePhoto,
} from "../utils/control/device-photo";
import { createSessionStorage } from "./helpers/storage";

describe("设备封面存储", () => {
  it("没有记录时返回空映射", () => {
    expect(loadDevicePhotos(createSessionStorage())).toEqual({});
  });

  it("写入后能按 deviceKey 读回", () => {
    const storage = createSessionStorage();
    setDevicePhoto(storage, "AA:BB:CC:DD:EE:01", "wxfile://cover-1.jpg");
    expect(photoKeyOf(loadDevicePhotos(storage), "AA:BB:CC:DD:EE:01")).toBe("wxfile://cover-1.jpg");
  });

  it("不同设备互不覆盖", () => {
    const storage = createSessionStorage();
    setDevicePhoto(storage, "KEY-A", "a.jpg");
    setDevicePhoto(storage, "KEY-B", "b.jpg");
    const photos = loadDevicePhotos(storage);
    expect(photos["KEY-A"]).toBe("a.jpg");
    expect(photos["KEY-B"]).toBe("b.jpg");
  });

  it("重复设置同一台设备是替换而不是新增", () => {
    const storage = createSessionStorage();
    setDevicePhoto(storage, "KEY-A", "old.jpg");
    setDevicePhoto(storage, "KEY-A", "new.jpg");
    const photos = loadDevicePhotos(storage);
    expect(Object.keys(photos)).toHaveLength(1);
    expect(photos["KEY-A"]).toBe("new.jpg");
  });

  it("清除只影响目标设备", () => {
    const storage = createSessionStorage();
    setDevicePhoto(storage, "KEY-A", "a.jpg");
    setDevicePhoto(storage, "KEY-B", "b.jpg");
    const next = clearDevicePhoto(storage, "KEY-A");
    expect(next["KEY-A"]).toBeUndefined();
    expect(next["KEY-B"]).toBe("b.jpg");
    expect(loadDevicePhotos(storage)["KEY-B"]).toBe("b.jpg");
  });

  it("没设过封面的设备返回空串（页面据此用渐变兜底）", () => {
    expect(photoKeyOf({}, "KEY-A")).toBe("");
  });

  it("空 key / 空路径不会被写入", () => {
    const storage = createSessionStorage();
    setDevicePhoto(storage, "", "a.jpg");
    setDevicePhoto(storage, "KEY-A", "");
    expect(loadDevicePhotos(storage)).toEqual({});
  });

  it("存储内容损坏时按空映射处理（不抛错、不影响控制）", () => {
    const broken = createSessionStorage({ [DEVICE_PHOTOS_KEY]: "{not json" });
    expect(loadDevicePhotos(broken)).toEqual({});

    const wrongShape = createSessionStorage({ [DEVICE_PHOTOS_KEY]: "[1,2,3]" });
    expect(loadDevicePhotos(wrongShape)).toEqual({});

    const badValues = createSessionStorage({
      [DEVICE_PHOTOS_KEY]: JSON.stringify({ "KEY-A": "ok.jpg", "KEY-B": 123, "KEY-C": "" }),
    });
    expect(loadDevicePhotos(badValues)).toEqual({ "KEY-A": "ok.jpg" });
  });

  it("写入结果可被下一次 load 原样读出（往返一致）", () => {
    const storage = createSessionStorage();
    setDevicePhoto(storage, "A4:CF:12:9B:3E:01", "wxfile://device-cover-A4.jpg");
    const roundTrip = loadDevicePhotos(createSessionStorage({ [DEVICE_PHOTOS_KEY]: storage.get(DEVICE_PHOTOS_KEY)! }));
    expect(roundTrip).toEqual({ "A4:CF:12:9B:3E:01": "wxfile://device-cover-A4.jpg" });
  });
});
