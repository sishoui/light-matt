/**
 * 设备封面图（用户自定义）。
 *
 * ## 为什么单独一层
 *
 * 封面是**用户对这台设备做的决定**（和备注名、灯带显隐同类），不是设备状态，
 * 所以它跟 `device-registry` 平级、单独一个存储键，按 `deviceKey`（hardwareId
 * 优先）取值——这样 iOS 换 UUID 后仍认得出是同一台设备。
 *
 * ## 文件为什么要落盘
 *
 * `wx.chooseMedia` 只给**临时路径**，小程序重启后就失效。所以选完必须
 * `saveFile` 到 `wx.env.USER_DATA_PATH`，再把**永久路径**记进存储。
 * 换图时删掉旧文件，否则用户余额（10MB）会被旧封面慢慢吃光。
 *
 * 纯逻辑（读写映射）与 wx 调用分开：前者可在 node 里直接测，后者只在
 * 真机/模拟器的函数体内部执行。
 */

import type { SessionStorage } from "./device-cache";

/** 存储键（含版本，避免读到旧结构）。 */
export const DEVICE_PHOTOS_KEY = "lumen.devicePhotos.v1";

/** deviceKey → 本地永久文件路径。 */
export type DevicePhotoMap = Record<string, string>;

/** 读映射；损坏或结构不对一律按空处理（封面丢了不该影响控制）。 */
export function loadDevicePhotos(storage: SessionStorage): DevicePhotoMap {
  const raw = storage.get(DEVICE_PHOTOS_KEY);
  if (raw === null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: DevicePhotoMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

/** 写入一张封面，返回新映射（不可变，方便调用方直接 setData）。 */
export function setDevicePhoto(
  storage: SessionStorage,
  deviceKey: string,
  filePath: string,
): DevicePhotoMap {
  const next = { ...loadDevicePhotos(storage) };
  if (deviceKey.length === 0 || filePath.length === 0) {
    return next;
  }
  next[deviceKey] = filePath;
  storage.set(DEVICE_PHOTOS_KEY, JSON.stringify(next));
  return next;
}

/** 移除一张封面，返回新映射。 */
export function clearDevicePhoto(storage: SessionStorage, deviceKey: string): DevicePhotoMap {
  const next = { ...loadDevicePhotos(storage) };
  delete next[deviceKey];
  storage.set(DEVICE_PHOTOS_KEY, JSON.stringify(next));
  return next;
}

/** 取某台设备的封面；没有就是空串（调用方用渐变兜底）。 */
export function photoKeyOf(photos: DevicePhotoMap, deviceKey: string): string {
  return photos[deviceKey] ?? "";
}

/**
 * 让用户选一张图并落盘，返回**永久路径**；用户取消返回 null。
 *
 * 只在真机/模拟器里调用。换图时先删旧文件，避免 USER_DATA_PATH 被占满。
 *
 * 失败时不抛给页面（封面是装饰，不该阻断控制）：返回 null 由调用方提示。
 */
export async function pickDevicePhoto(deviceKey: string, previous: string): Promise<string | null> {
  if (typeof wx === "undefined") {
    return null;
  }
  const chosen = await chooseImage();
  if (chosen === null) {
    return null;
  }
  const saved = await persistImage(chosen, deviceKey);
  if (saved === null) {
    return null;
  }
  /* 新文件已就位，再删旧的：顺序反了会在保存失败时丢掉原图。 */
  if (previous.length > 0 && previous !== saved) {
    removeFile(previous);
  }
  return saved;
}

/** 把永久封面文件删掉（用户点「移除封面」时）。 */
export function deleteDevicePhotoFile(filePath: string): void {
  if (filePath.length > 0) {
    removeFile(filePath);
  }
}

/** 选图：相册或拍照，压缩后的单张。取消 / 失败都返回 null。 */
function chooseImage(): Promise<string | null> {
  return new Promise((resolve) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sizeType: ["compressed"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const file = res.tempFiles?.[0];
        const path = file?.tempFilePath ?? "";
        resolve(path.length > 0 ? path : null);
      },
      fail: () => resolve(null),
    });
  });
}

/** 临时路径 → USER_DATA_PATH 下的永久文件。失败返回 null。 */
function persistImage(tempFilePath: string, deviceKey: string): Promise<string | null> {
  return new Promise((resolve) => {
    let base: string;
    try {
      base = wx.env.USER_DATA_PATH;
    } catch {
      resolve(null);
      return;
    }
    const safeKey = deviceKey.replace(/[^A-Za-z0-9]/g, "_");
    const target = `${base}/device-cover-${safeKey}.jpg`;
    wx.getFileSystemManager().saveFile({
      tempFilePath,
      filePath: target,
      success: (res) => resolve(res.savedFilePath ?? target),
      fail: () => {
        /* 同一个 filePath 已存在时 saveFile 会失败：先删再存一次。 */
        wx.getFileSystemManager().unlink({
          filePath: target,
          complete: () => {
            wx.getFileSystemManager().saveFile({
              tempFilePath,
              filePath: target,
              success: (res) => resolve(res.savedFilePath ?? target),
              fail: () => resolve(null),
            });
          },
        });
      },
    });
  });
}

function removeFile(filePath: string): void {
  try {
    wx.getFileSystemManager().unlink({ filePath, fail: () => undefined });
  } catch {
    /* 文件已不存在或 FS 不可用：忽略。 */
  }
}
