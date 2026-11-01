/**
 * 设备同步编排（#44）：把「本地写入 → 后端同步」的先后顺序固定下来。
 *
 * 页面只该问两个问题：「本地列表是什么」和「顺便同步一下」。同步的
 * 重试、身份、后端 id 缓存都不该出现在页面里，所以集中在这一层：
 *
 *  - **本地先写**：备注名先在 device-registry 落盘，再试后端；后端失败只
 *    影响「别的手机看不看得见」，本机行为完全不变（票面验收第 1、3 条）。
 *  - **同步是旁路**：所有方法都不抛错，失败只把 `offline` 置位，页面据此
 *    显示「离线，仅显示本机记录」。
 *  - **后端 id 缓存**：`register` 是幂等的，但每次连接都打一次没必要；
 *    hardwareId → backendId 的映射存在登记表里（`setBackendId`），
 *    它只是「哪个后端行对应这台设备」，不是灯光配置。
 *
 * 纯逻辑 + 注入 api / storage：node 单测直接跑，不碰 wx。
 */

import type {
  DeviceApi,
  IdentityFallback,
  IdentityKind,
  SyncedDevice,
} from "./device-api";
import { clearBackendIds, loadRegistry, resolveEntry, setBackendId, type DeviceRegistry } from "./device-registry";
import type { SessionStorage } from "./device-cache";

/** 本层真正用到的 api 子集；`DeviceApi` 结构上满足它，测试用小桩即可。 */
export interface DeviceSyncApi {
  readonly enabled: boolean;
  ensureIdentity(): Promise<
    | {
        ok: true;
        value: {
          userKey: string;
          identityKind: IdentityKind;
          trusted: boolean;
          /** 后端是否真的认这份身份（#47 回落身份为 false）。 */
          backendBacked?: boolean;
          fallback?: IdentityFallback | null;
        };
      }
    | { ok: false; reason: string }
  >;
  /** 丢掉缓存身份，下次 `ensureIdentity` 重新 `wx.login`（#47 手动重试用）。 */
  forgetIdentity?(): void;
  listDevices(): Promise<
    { ok: true; value: SyncedDevice[] } | { ok: false; reason: string }
  >;
  registerDevice(
    hardwareId: string,
    displayName?: string | null,
  ): Promise<
    | { ok: true; value: { deviceId: number; hardwareId: string; displayName: string | null } }
    | { ok: false; reason: string }
  >;
  renameDevice(deviceId: number, displayName: string): Promise<{ ok: boolean }>;
  deleteDevice(deviceId: number): Promise<{ ok: boolean }>;
  markSeen(
    deviceId: number,
    seen?: { ledCounts?: number[] | null; firmwareVer?: number | null },
  ): Promise<
    { ok: true; value: { id: number } } | { ok: false; reason: string }
  >;
}

/** 一次连接成功后设备的权威事实（State / DeviceInfo）。 */
export interface ConnectedFacts {
  /** 平台 BLE deviceId（本机身份，用于登记表定位）。 */
  deviceId: string;
  /** 设备自报的 6 字节 MAC。没有它就不登记：后端的主键就是它。 */
  hardwareId: string;
  /** 用户在设备页设置的备注名（可选，注册时带上）。 */
  displayName?: string | null;
  /** State.stripCount：不直接上报（后端只认 ledCounts），保留给提示与将来。 */
  stripCount?: number;
  /** State.stripCounts 的前 stripCount 项：作为**非权威**缓存上报。 */
  ledCounts?: number[] | null;
  /** DeviceInfo.firmwareVersion：作为缓存上报。 */
  firmwareVer?: number | null;
}

export class DeviceSync {
  private readonly api: DeviceSyncApi | null;
  private readonly storage: SessionStorage;
  /** 后端明示的身份种类；null = 还没换到 session / 未配置。 */
  private identity: IdentityKind | null = null;
  /** 回落到 local 的原因（#47）；正常身份为 null。 */
  private fallback: IdentityFallback | null = null;
  /** 后端是否认这份身份；回落身份为 false（设备接口直接跳过）。 */
  private backendBacked = true;
  /** 最近一次同步是否因网络/后端不可达失败。 */
  private lastOffline = false;

  constructor(opts: { api: DeviceSyncApi | null; storage: SessionStorage }) {
    this.api = opts.api;
    this.storage = opts.storage;
  }

  /** 同步功能是否可用（未配置后端 = 关闭，不是错误）。 */
  get enabled(): boolean {
    return this.api !== null && this.api.enabled;
  }

  /**
   * `identityKind === "local"` 时设备页要显示「仅本机可见」。
   * 未换过 session 时返回 null（页面不显示提示，因为还不知道）。
   */
  get identityKind(): IdentityKind | null {
    return this.identity;
  }

  /**
   * 设备页顶部的身份提示（#47）。空串 = 正常（openid 或还没换到身份）。
   *
   * 回落路径必须给**可读原因**：`wx.login` 失败与 `invalid_code` 都是
   * 「仅本机可见」，但后者要提示可以点重试重新登录——静默失败才是票面要修的病。
   */
  get identityHint(): string {
    if (this.identity === null) {
      return "";
    }
    if (this.fallback === "login_failed") {
      return "微信登录失败，仅本机可见";
    }
    if (this.fallback === "invalid_code") {
      return "登录已过期，仅本机可见（点重试重新登录）";
    }
    return this.identity === "local" ? "仅本机可见" : "";
  }

  /** 回落原因（测试与页面诊断用）；正常身份为 null。 */
  get fallbackReason(): IdentityFallback | null {
    return this.fallback;
  }

  /** 后端是否认这份身份（`false` = 回落身份，所有后端调用都被跳过）。 */
  get identityBackendBacked(): boolean {
    return this.backendBacked;
  }

  /** 最近一次同步是否离线（页面据此显示顶部提示）。 */
  get offline(): boolean {
    return this.lastOffline;
  }

  /**
   * 换取身份。页面在 onShow 调一次；失败不影响任何本地功能。
   *
   * 返回值只是提示用途：`null` 表示后端不可达 / 未配置。
   */
  async ensureIdentity(): Promise<IdentityKind | null> {
    if (this.api === null || !this.api.enabled) {
      return null;
    }
    const before = this.identity;
    const result = await this.api.ensureIdentity();
    if (!result.ok) {
      this.lastOffline = true;
      return null;
    }
    this.lastOffline = false;
    this.identity = result.value.identityKind;
    this.fallback = result.value.fallback ?? null;
    this.backendBacked = result.value.backendBacked !== false;
    /* #47：身份种类变了（local → openid）意味着后端换了 `users` 行，
     * 登记表里缓存的 backendId 属于**上一个用户**了。不清掉的话
     * markSeen / 改名 / 解绑会打到 404，被误显示成「离线」。 */
    if (before !== null && before !== this.identity) {
      clearBackendIds(this.storage);
    }
    return this.identity;
  }

  /**
   * 忘掉本次身份，下一次 `ensureIdentity` 重新 `wx.login`（#47）。
   *
   * 页面「重试」用：上次登录失败 / code 过期时，重新走一遍才有机会升级成 openid。
   */
  forgetIdentity(): void {
    this.identity = null;
    this.fallback = null;
    this.backendBacked = true;
    this.api?.forgetIdentity?.();
  }

  /**
   * 拉一次后端列表。`null` = 不可达（页面保留本地列表，只加提示）。
   *
   * 成功时把 hardwareId → backendId 写进登记表：之后 rename / delete 不必
   * 再拉一遍列表。
   */
  async refreshRemote(): Promise<SyncedDevice[] | null> {
    if (this.api === null || !this.api.enabled) {
      return null;
    }
    if (this.identity === null) {
      const kind = await this.ensureIdentity();
      if (kind === null) {
        return null;
      }
    }
    if (!this.backendBacked) {
      /* 回落身份：后端没有这个用户，打过去只会 404。不是离线，不打请求。 */
      return null;
    }
    const result = await this.api.listDevices();
    if (!result.ok) {
      this.lastOffline = true;
      return null;
    }
    this.lastOffline = false;
    this.cacheBackendIds(result.value);
    return result.value;
  }

  /**
   * 连接成功后：登记（幂等）+ 报一次 seen。
   *
   * 顺序固定 —— `seen` 需要后端 id，所以先 ensure 注册。两者都失败也不抛错：
   * 本地记录早已写入，BLE 控制不受任何影响。
   */
  async noteConnected(facts: ConnectedFacts): Promise<void> {
    const api = this.api;
    if (api === null || !api.enabled || facts.hardwareId.length === 0) {
      return;
    }
    const backendId = await this.ensureRegistered(facts);
    if (backendId === null) {
      return;
    }
    /* 只上报缓存字段：灯珠数来自 State，固件版本来自 DeviceInfo。
     * 后端把它们当 COALESCE 缓存，不参与任何控制。
     * 未配置的槽位是 0，后端只收正整数数组——先滤掉，否则整条请求被 400。 */
    const ledCounts =
      facts.ledCounts === null || facts.ledCounts === undefined
        ? null
        : facts.ledCounts.filter((n) => Number.isInteger(n) && n > 0);
    const result = await api.markSeen(backendId, {
      ledCounts: ledCounts !== null && ledCounts.length > 0 ? ledCounts : null,
      firmwareVer: facts.firmwareVer ?? null,
    });
    this.lastOffline = !result.ok;
  }

  /**
   * 改名：本地已经写过，这里只同步。
   *
   * 只对「后端已知」的设备发 PATCH；只有后端记录、本机没连过的设备没有
   * deviceId，也就没法在本地存储备注——它们的名字由后端保存。
   */
  async pushRemark(facts: { deviceId: string; hardwareId: string }): Promise<boolean> {
    const api = this.api;
    if (api === null || !api.enabled) {
      return false;
    }
    const registry = loadRegistry(this.storage);
    const entry = resolveEntry(registry, facts);
    const remark = entry?.remark;
    if (remark === undefined || remark.length === 0) {
      return false;
    }
    if (this.identity === null) {
      /* 先确认身份：回落身份时后端没有这个用户，PATCH 只会 404。 */
      if ((await this.ensureIdentity()) === null) {
        return false;
      }
    }
    if (!this.backendBacked) {
      /* 本地备注早已落盘，这里只是「别的手机看不看得到」。 */
      return false;
    }
    const backendId =
      entry?.backendId ?? (await this.ensureRegistered({ ...facts, displayName: remark }));
    if (backendId === null) {
      this.lastOffline = true;
      return false;
    }
    const result = await api.renameDevice(backendId, remark);
    this.lastOffline = !result.ok;
    if (result.ok) {
      this.cacheBackendId(facts.deviceId, facts.hardwareId, backendId);
    }
    return result.ok;
  }

  /**
   * 删除：只解除后端关联。设备记录本身保留（别的手机可能还登记着），
   * 重新扫描仍能连上（票面验收第 7 条）。
   */
  async unlink(backendId: number | null): Promise<boolean> {
    const api = this.api;
    if (api === null || !api.enabled || backendId === null) {
      return false;
    }
    if (this.identity === null) {
      /* 先确认身份：回落身份时 DELETE 也只会 404。 */
      if ((await this.ensureIdentity()) === null) {
        return false;
      }
    }
    if (!this.backendBacked) {
      return false;
    }
    const result = await api.deleteDevice(backendId);
    this.lastOffline = !result.ok;
    return result.ok;
  }

  /** 清掉离线标记（页面手动重试前调用）。 */
  clearOffline(): void {
    this.lastOffline = false;
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  /** 返回后端 id：先确认身份，再查本地映射，没有再 register（幂等）。 */
  private async ensureRegistered(facts: ConnectedFacts): Promise<number | null> {
    const api = this.api;
    if (api === null) {
      return null;
    }
    if (this.identity === null) {
      const kind = await this.ensureIdentity();
      if (kind === null) {
        return null;
      }
    }
    if (!this.backendBacked) {
      /* 回落身份：后端没有这个用户，register 也一定失败。不是离线。 */
      return null;
    }
    const registry = loadRegistry(this.storage);
    const cached = resolveEntry(registry, facts)?.backendId;
    if (cached !== undefined) {
      return cached;
    }
    const result = await api.registerDevice(facts.hardwareId, facts.displayName ?? null);
    if (!result.ok) {
      this.lastOffline = true;
      return null;
    }
    this.lastOffline = false;
    this.cacheBackendId(facts.deviceId, facts.hardwareId, result.value.deviceId);
    return result.value.deviceId;
  }

  private cacheBackendId(deviceId: string, hardwareId: string, backendId: number): void {
    try {
      setBackendId(this.storage, { deviceId, hardwareId }, backendId);
    } catch {
      /* 映射写不进去只影响下次要多打一次 register（幂等），不影响功能。 */
    }
  }

  private cacheBackendIds(devices: readonly SyncedDevice[]): void {
    for (const device of devices) {
      try {
        setBackendId(this.storage, { hardwareId: device.hardwareId }, device.id);
      } catch {
        /* 同上 */
      }
    }
  }

  /** 从最近一次读到的 State 取逐带灯珠数（只作后端缓存）。 */
  /* 逐带灯珠数由页面在 noteConnected 的 facts 里给出：本层不依赖 Session，
   * 也就不必猜「当前 State 是哪台设备的」。 */

  /** 仅供测试观察：当前登记表快照。 */
  registry(): DeviceRegistry {
    return loadRegistry(this.storage);
  }
}

/** `DeviceApi` → `DeviceSyncApi` 的结构转换（生产路径用）。 */
export function syncApiOf(api: DeviceApi | null): DeviceSyncApi | null {
  return api === null ? null : api;
}
