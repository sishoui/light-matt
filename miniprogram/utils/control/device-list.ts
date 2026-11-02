/**
 * #44 设备页的列表派生（`utils/control/device-list.ts`）。
 *
 * 票面要求：
 *  - 「我的设备」= 本地记录 + 后端列表，**按 hardwareId 去重**，本地备注名优先；
 *  - 「附近设备」= 实时扫描结果，**按 hardwareId 与「我的设备」去重**，已知的标「已知」；
 *  - 本地优先：网络失败时这一层完全不变，只少掉后端那部分。
 *
 * 为什么单独成模块：合并规则（谁覆盖谁、按什么键去重）是最容易写错的地方，
 * 而页面代码在 node 里跑不起来。这里纯函数、零 wx 依赖。
 *
 * 关键约束：**后端字段不是设备当前配置**。`ledCounts` / `firmwareVer` 只用于
 * 「离线时列表能显示点东西」，必须带 `source: "backend-cache"` 标记，UI 才能
 * 如实标注。设备连接后的真实值来自 State / Query*。
 */

import type { RecentDevice } from "./device-history";
import type { DeviceRegistryEntry } from "./device-registry";
import type { SyncedDevice } from "./device-api";
import type { DiscoveredDevice } from "../protocol/types";

/**
 * 「我的设备」一行。
 *
 * `name` 的优先级：**本地备注名 > 后端备注名 > 广播名 > deviceId**。
 * 本地的永远赢——用户在这台手机上改的名字就是这台手机的答案（后端按 user 存，
 * 两台手机各自看到自己的名字，这正是验收项）。
 */
export interface MyDeviceRow {
  /** 去重键：hardwareId 优先，未知时 deviceId。 */
  key: string;
  /** 设备自报的 hardwareId（不知道时为 null；UI 显示「—」）。 */
  hardwareId: string | null;
  /** 连接时必须用的平台 deviceId；只有后端记录时为 null（需要先扫描）。 */
  deviceId: string | null;
  /** 展示名（见类型注释的优先级）。 */
  name: string;
  /** 是否只来自后端（本机没连过）：连接前需要先扫到它。 */
  remoteOnly: boolean;
  /** 后端记录 id（没有登记过为 null，改名/删除要用）。 */
  backendId: number | null;
  /**
   * 灯带数事实。优先级：本次连接读到的 State > 上次连接的本地快照 > 后端缓存。
   * `source` 说明它来自哪一层，UI 必须如实标注（后两者都**不是**当前配置）。
   */
  stripCount: number | null;
  stripCountSource: "device" | "last-session" | "backend-cache" | "unknown";
  /** 逐带灯珠数（只有后端缓存会给；仅作离线展示）。 */
  ledCounts: number[] | null;
  /** 固件版本。来源与 stripCount 同理。 */
  firmwareVer: number | null;
  firmwareSource: "device" | "last-session" | "backend-cache" | "unknown";
  /** 最后连接 / 见过的时间（毫秒）；未知为 0。 */
  lastSeenAt: number;
}

/** 「附近设备」一行：实时扫描结果 + 已知 / 重复标记。 */
export interface NearbyDeviceRow {
  deviceId: string;
  name: string;
  rssi: number;
  /**
   * 是否已在「我的设备」里（按广播名匹配；本机 deviceId 匹配也置真）。
   * UI 标「已知」——它说明这台用户其实认识，不是新设备。
   */
  known: boolean;
  /**
   * 是否与本机某条记录是**同一台**（deviceId 精确命中）。
   *
   * 页面把这类行从「附近设备」里隐去：上面「我的设备」已经有可连接的一行，
   * 重复列出只会让用户不知道该点哪个。只有广播名匹配（另一台手机登记过 /
   * UUID 变了）才保留并标「已知」——那种设备本机没有可点的行。
   */
  duplicate: boolean;
  /** 是否是当前连接的这台。 */
  current: boolean;
}

/** 后端缓存里的灯带数 → 展示用（> MAX_STRIPS 的越界项直接丢弃）。 */
function sanitizeLedCounts(value: number[] | null): number[] | null {
  if (value === null) {
    return null;
  }
  const out = value.filter((n) => Number.isInteger(n) && n > 0);
  return out.length > 0 ? out : null;
}

export interface BuildMyDevicesInput {
  /** 会话的本地「最近连过」列表（已排序）；可为空。 */
  recent: readonly RecentDevice[];
  /** 本地登记表（备注名 / hardwareId）。 */
  registry: readonly DeviceRegistryEntry[];
  /** 后端列表；后端失败时传空数组（或 null），列表只剩本地部分。 */
  backend: readonly SyncedDevice[] | null;
  /**
   * 当前**已连接**设备的实时事实（State.stripCount / DeviceInfo）。
   *
   * 只有这台设备的 deviceId 匹配时才覆盖缓存字段：其余设备显示的都是
   * 「上次 / 后端」的快照，UI 必须让用户看得出区别。
   */
  live?: {
    deviceId: string;
    stripCount: number;
    firmwareVer: number | null;
  } | null;
}

/**
 * 合并本地与后端，按 hardwareId 去重（未知 hwId 时退回 deviceId）。
 *
 * 合并顺序（后写覆盖先写，用于时间/名称）：
 *  1. 后端记录先放（它们是「跨手机可见」的那部分）；
 *  2. 本地「最近连过」再覆盖（本机的连接时间更贴近用户的实际使用）；
 *  3. 本地备注名最后覆盖名字。
 *
 * 结果按 `lastSeenAt` 降序——最近用过的排最上面，与「最近连过」的语义一致。
 */
export function buildMyDevices(input: BuildMyDevicesInput): MyDeviceRow[] {
  const byKey = new Map<string, MyDeviceRow>();
  const registryByDeviceId = new Map(input.registry.map((entry) => [entry.deviceId, entry]));
  const remarkByHardwareId = new Map<string, string>();
  for (const entry of input.registry) {
    if (entry.hardwareId !== undefined && entry.remark !== undefined && entry.remark.length > 0) {
      remarkByHardwareId.set(entry.hardwareId, entry.remark);
    }
  }

  /* 1. 后端记录。 */
  for (const device of input.backend ?? []) {
    const key = device.hardwareId;
    byKey.set(key, {
      key,
      hardwareId: device.hardwareId,
      /* 后端不知道平台 deviceId：连接前必须先扫到这台。 */
      deviceId: null,
      name: device.displayName ?? device.hardwareId,
      remoteOnly: true,
      backendId: device.id,
      /* 后端缓存里没有「灯带数」字段，只有逐带灯珠数；条数从数组长度推。 */
      stripCount: device.ledCounts === null ? null : device.ledCounts.length,
      stripCountSource: device.ledCounts === null ? "unknown" : "backend-cache",
      ledCounts: sanitizeLedCounts(device.ledCounts),
      firmwareVer: device.firmwareVer,
      firmwareSource: device.firmwareVer === null ? "unknown" : "backend-cache",
      lastSeenAt: device.lastSeenAt,
    });
  }

  /* 2. 本地「最近连过」覆盖 / 新增。 */
  for (const entry of input.recent) {
    const hardwareId = entry.hardwareId ?? null;
    const key = hardwareId ?? entry.deviceId;
    const existing = byKey.get(key);
    const remark = remarkOf(registryByDeviceId.get(entry.deviceId), hardwareId, remarkByHardwareId);
    const live =
      input.live !== null && input.live !== undefined && input.live.deviceId === entry.deviceId
        ? input.live
        : null;

    /* 条数与固件：本次连接 > 上次本地快照 > 已有的（可能是后端缓存）。 */
    const stripCount = live?.stripCount ?? entry.stripCount ?? existing?.stripCount ?? null;
    const stripCountSource: MyDeviceRow["stripCountSource"] =
      live !== null
        ? "device"
        : entry.stripCount !== undefined
          ? "last-session"
          : existing?.stripCountSource ?? "unknown";
    const firmwareVer = live?.firmwareVer ?? entry.firmwareVer ?? existing?.firmwareVer ?? null;
    const firmwareSource: MyDeviceRow["firmwareSource"] =
      live !== null && live.firmwareVer !== null
        ? "device"
        : entry.firmwareVer !== undefined
          ? "last-session"
          : existing?.firmwareSource ?? "unknown";

    byKey.set(key, {
      key,
      hardwareId,
      deviceId: entry.deviceId,
      /* 本地名优先级：备注 > 广播名 > 已有名字（后端备注）> deviceId。 */
      name: remark ?? (entry.name !== undefined && entry.name.length > 0 ? entry.name : null) ??
        existing?.name ?? entry.deviceId,
      remoteOnly: false,
      backendId: existing?.backendId ?? null,
      stripCount,
      stripCountSource,
      /* 逐带灯珠数只在后端有；本地记录不缓存它（设备才是权威）。
       * 已连接的设备连上了就以 State 为准，后端的旧数组不再展示。 */
      ledCounts: live !== null ? null : existing?.ledCounts ?? null,
      firmwareVer,
      firmwareSource,
      lastSeenAt: Math.max(entry.lastConnectedAt, existing?.lastSeenAt ?? 0),
    });
  }

  /* 3. 本地备注名最后覆盖（即使只有后端记录，只要登记表里按 hwId 有备注）。 */
  for (const row of byKey.values()) {
    if (row.hardwareId === null) {
      continue;
    }
    const remark = remarkByHardwareId.get(row.hardwareId);
    if (remark !== undefined) {
      row.name = remark;
    }
  }

  return Array.from(byKey.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

function remarkOf(
  entry: DeviceRegistryEntry | undefined,
  hardwareId: string | null,
  remarkByHardwareId: ReadonlyMap<string, string>,
): string | null {
  if (entry?.remark !== undefined && entry.remark.length > 0) {
    return entry.remark;
  }
  if (hardwareId !== null) {
    return remarkByHardwareId.get(hardwareId) ?? null;
  }
  return null;
}

export interface BuildNearbyInput {
  /** 实时扫描结果。 */
  discovered: readonly DiscoveredDevice[];
  /** 「我的设备」的合并结果（去重基准）。 */
  mine: readonly MyDeviceRow[];
  /** 当前连接的 deviceId（高亮用）。 */
  currentDeviceId?: string | null;
}

/**
 * 「附近设备」：扫描结果中去掉已知设备、标出已知项。
 *
 * 去重**不能**依赖 hardwareId：扫描阶段只有平台 deviceId 与广播名，hwId 要连上
 * 才读得到。所以这里用两条线索：
 *  1. deviceId 精确匹配（本机连过的记录）；
 *  2. 广播名与本机记录里的 `name` 相同（跨手机识别同一台的最弱但唯一可用线索）。
 * 对「只有后端记录」的设备（没有 deviceId），只能靠广播名——这正是它
 * `remoteOnly` 的原因：扫到才能连。
 */
export function buildNearby(input: BuildNearbyInput): NearbyDeviceRow[] {
  const knownDeviceIds = new Set<string>();
  const knownNames = new Set<string>();
  for (const row of input.mine) {
    if (row.deviceId !== null) {
      knownDeviceIds.add(row.deviceId);
    }
    if (row.name.length > 0) {
      knownNames.add(row.name.toUpperCase());
    }
  }

  return input.discovered.map((device) => {
    const duplicate = knownDeviceIds.has(device.deviceId);
    return {
      deviceId: device.deviceId,
      name: device.name,
      rssi: device.rssi,
      known:
        duplicate || (device.name.length > 0 && knownNames.has(device.name.toUpperCase())),
      duplicate,
      current: device.deviceId === (input.currentDeviceId ?? null),
    };
  });
}
