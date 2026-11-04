/**
 * 灯组元数据（#94）：用户给「第 N 条灯组」起的名字与封面。
 *
 * ## 为什么单独一个存储键
 *
 * 灯组名与封面是**本机数据**，和设备的灯效配置无关：
 *  - 设备的段配置在设备里，协议里没有「灯组叫什么」这回事；
 *  - 同一条灯组在不同手机上可以叫不同名字（就像设备备注名）。
 *
 * 键由**设备稳定标识 + 灯组号**组成：`deviceKey#stripId`。deviceKey 是
 * hardwareId 优先（与 `device-history.deviceKeyOf` 一致），所以 iOS 换了
 * UUID 之后名字与封面仍然跟着走。
 *
 * ## 默认值
 *
 * 没设置过时：名字是「灯组 N」，封面是**按灯组号对素材取模固定分配**的占位图
 * ——同一灯组每次都拿到同一张，不会每次进页面都换图。
 *
 * 纯逻辑 + 注入存储，不碰 wx，可在 node 里直接测。
 */

import type { SessionStorage } from "./device-cache";

/** 存储键（含版本，避免读到旧结构）。 */
export const STRIP_META_KEY = "lumen.stripMeta.v1";

/** 一条灯组的用户元数据（都存在同一个 map 里）。 */
export interface StripMeta {
  /** 用户起的名字；空串表示用默认名。 */
  name?: string;
  /** 自定义封面的本地永久路径；空串表示用占位图。 */
  photo?: string;
}

/** `deviceKey#stripId` → 元数据。 */
export type StripMetaMap = Record<string, StripMeta>;

/**
 * 默认名的前缀。`displayName` 与它拼接：`灯组 1`（从 1 编号，与界面一致）。
 */
export const DEFAULT_STRIP_NAME_PREFIX = "灯组";

/**
 * 占位封面素材（按灯组号取模）。
 *
 * 路径相对于小程序根目录。三张抽象光照图已经存在于 `assets/devices/`，
 * 直接复用而不是新增图片：它们本来就是「灯光氛围」的抽象图，做灯组占位
 * 不至于误导（不像真实照片会让人以为那是这台设备的现场照）。
 */
export const STRIP_PLACEHOLDER_PHOTOS: readonly string[] = [
  "/assets/devices/desk.webp",
  "/assets/devices/living.webp",
  "/assets/devices/bedroom.webp",
];

/** 一条灯组的完整解析结果（页面直接渲染）。 */
export interface ResolvedStripMeta {
  stripId: number;
  /** 展示名：用户起的名字，或默认「灯组 N」。 */
  name: string;
  /** 展示封面：用户选的图，或按灯组号固定分配的占位图。 */
  photo: string;
  /** 名字是不是用户起的（决定菜单里显示「修改」还是「设置」）。 */
  nameIsCustom: boolean;
  /** 封面是不是用户选的（决定「移除封面」是否可点）。 */
  photoIsCustom: boolean;
}

/** 组合键：`deviceKey#stripId`。stripId 必须是 0-7 的整数。 */
export function stripMetaKey(deviceKey: string, stripId: number): string {
  return `${deviceKey}#${stripId}`;
}

/** 默认名（从 1 编号）。 */
export function defaultStripName(stripId: number): string {
  return `${DEFAULT_STRIP_NAME_PREFIX} ${stripId + 1}`;
}

/** 默认占位封面：按灯组号取模，保证同一灯组每次都是同一张。 */
export function defaultStripPhoto(stripId: number): string {
  if (STRIP_PLACEHOLDER_PHOTOS.length === 0) {
    return "";
  }
  const index = ((stripId % STRIP_PLACEHOLDER_PHOTOS.length) + STRIP_PLACEHOLDER_PHOTOS.length) %
    STRIP_PLACEHOLDER_PHOTOS.length;
  return STRIP_PLACEHOLDER_PHOTOS[index];
}

function isValidMeta(value: unknown): value is StripMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const meta = value as { name?: unknown; photo?: unknown };
  if (meta.name !== undefined && typeof meta.name !== "string") {
    return false;
  }
  if (meta.photo !== undefined && typeof meta.photo !== "string") {
    return false;
  }
  return true;
}

/** 读表；损坏或结构不对一律按空表处理（元数据丢了不该影响控制）。 */
export function loadStripMeta(storage: SessionStorage): StripMetaMap {
  const raw = storage.get(STRIP_META_KEY);
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
  const out: StripMetaMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isValidMeta(value)) {
      out[key] = value;
    }
  }
  return out;
}

function writeStripMeta(storage: SessionStorage, map: StripMetaMap): void {
  storage.set(STRIP_META_KEY, JSON.stringify(map));
}

/** 取一条灯组的元数据；没有返回空对象（不造默认值，默认值由 resolve 负责）。 */
export function getStripMeta(
  storage: SessionStorage,
  deviceKey: string,
  stripId: number,
): StripMeta {
  return loadStripMeta(storage)[stripMetaKey(deviceKey, stripId)] ?? {};
}

/**
 * 设置灯组名。空串 / 空白等价于「恢复默认名」（删掉字段，与读出结构对称）。
 */
export function setStripName(
  storage: SessionStorage,
  deviceKey: string,
  stripId: number,
  name: string | null,
): StripMetaMap {
  const map = { ...loadStripMeta(storage) };
  const key = stripMetaKey(deviceKey, stripId);
  const current = { ...(map[key] ?? {}) };
  const trimmed = name === null ? "" : name.trim();
  if (trimmed.length > 0) {
    current.name = trimmed;
  } else {
    delete current.name;
  }
  if (current.name === undefined && current.photo === undefined) {
    delete map[key];
  } else {
    map[key] = current;
  }
  writeStripMeta(storage, map);
  return map;
}

/** 设置灯组封面。空串等价于「恢复默认占位图」。 */
export function setStripPhoto(
  storage: SessionStorage,
  deviceKey: string,
  stripId: number,
  photo: string | null,
): StripMetaMap {
  const map = { ...loadStripMeta(storage) };
  const key = stripMetaKey(deviceKey, stripId);
  const current = { ...(map[key] ?? {}) };
  const trimmed = photo === null ? "" : photo.trim();
  if (trimmed.length > 0) {
    current.photo = trimmed;
  } else {
    delete current.photo;
  }
  if (current.name === undefined && current.photo === undefined) {
    delete map[key];
  } else {
    map[key] = current;
  }
  writeStripMeta(storage, map);
  return map;
}

/** 解析一条灯组的展示形态（名字与封面各自的默认值兜底）。 */
export function resolveStripMeta(
  storage: SessionStorage,
  deviceKey: string,
  stripId: number,
): ResolvedStripMeta {
  const meta = getStripMeta(storage, deviceKey, stripId);
  const customName = (meta.name ?? "").trim();
  const customPhoto = (meta.photo ?? "").trim();
  return {
    stripId,
    name: customName.length > 0 ? customName : defaultStripName(stripId),
    photo: customPhoto.length > 0 ? customPhoto : defaultStripPhoto(stripId),
    nameIsCustom: customName.length > 0,
    photoIsCustom: customPhoto.length > 0,
  };
}

/** 一台设备的全部灯组解析结果（按灯组号升序）。 */
export function resolveStripMetas(
  storage: SessionStorage,
  deviceKey: string,
  stripIds: readonly number[],
): ResolvedStripMeta[] {
  return stripIds.map((stripId) => resolveStripMeta(storage, deviceKey, stripId));
}

/**
 * 删掉一台设备的全部灯组元数据（删除设备时调用）。
 *
 * 按 `deviceKey#` 前缀清理：只删这台设备的，别的设备的灯组名必须留着。
 * 返回**被删掉的封面文件路径**——调用方负责删文件（本模块不碰文件系统，
 * 与 `device-photo` 的分工保持一致）。
 */
export function clearStripMetaForDevice(
  storage: SessionStorage,
  deviceKey: string,
): { map: StripMetaMap; removedPhotos: string[] } {
  if (deviceKey.length === 0) {
    return { map: loadStripMeta(storage), removedPhotos: [] };
  }
  const map = loadStripMeta(storage);
  const prefix = `${deviceKey}#`;
  const removedPhotos: string[] = [];
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const photo = (map[key].photo ?? "").trim();
    if (photo.length > 0) {
      removedPhotos.push(photo);
    }
    delete map[key];
    changed = true;
  }
  if (changed) {
    writeStripMeta(storage, map);
  }
  return { map, removedPhotos };
}

/**
 * 按设备前缀统计条目数（测试与「删除确认」文案用）。
 */
export function countStripMetaForDevice(storage: SessionStorage, deviceKey: string): number {
  const prefix = `${deviceKey}#`;
  return Object.keys(loadStripMeta(storage)).filter((key) => key.startsWith(prefix)).length;
}
