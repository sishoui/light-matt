/**
 * 走查用例组的现场（#128）。
 *
 * 本文件是**唯一**知道测试接缝怎么拼的地方：起网关、扫设备、连上、把会话注入
 * 单例、装全局、按顺序 import 五个页面、给每个页面调 onLoad / onShow、抓
 * 连接期那一帧 0x88 的原始载荷、读现场快照、复位。表与执行器都不碰这些。
 *
 * 接缝一个字不改（`tests/helpers/page-runtime.ts`、`tests/e2e/wx-bridge.mjs`）。
 *
 * ## 「连不上」不是环境问题
 *
 * 「没扫到设备」＝没设备，整组 skip。但「扫到了、连不上」是真实回归，必须红。
 * vitest 会把 `beforeAll` 抛错的文件整份记成 skipped，编排器于是把一次连接
 * 回归报成 SKIP——所以连接失败不抛，交给第一行 `walkthrough.connected` 去断言。
 */

import { startGateway, createWxStub } from "../wx-bridge.mjs";
import { installGlobals, instantiate, waitFor } from "../../helpers/page-runtime";
import { DEVICE_CMD, MAX_SCRIPTS, PLAYBACK_FLAG } from "../../../utils/protocol/constants";
import { hexToBytes } from "../../../utils/protocol/hex";
import { decodeFrame } from "../../../utils/protocol/frame";
import { BleTransport } from "../../../utils/ble/transport";
import { FrameLog } from "../../../utils/ble/log";
import { ControlSession } from "../../../utils/control/session";
import { setSessionForTest } from "../../../utils/control/session-singleton";
import { clearPlanDraftsForDevice } from "../../../utils/control/plan-drafts";
import type { DeviceState, LinkState, SegmentReport } from "../../../utils/protocol/types";
import type { ScriptConfig } from "../../../utils/control/script-plan";
import type {
  ActContext,
  ObserveContext,
  PageHandles,
  PageInstance,
  PageName,
  RestorePoint,
  Step,
} from "./types";

const NAME_PREFIX = "Lumen-";
const SCAN_BUDGET_MS = 25_000;
/** 自动回连实测约 4.9s（1s+2s+4s 退避）；留到 20s。 */
const RECONNECT_BUDGET_MS = 20_000;
/** 0x88 由 `rebuildDeviceConfig()` 异步补；实测不到 1s，留 15s。 */
const DEVICE_INFO_BUDGET_MS = 15_000;

/** 第一行的 id。「扫到但连不上」时只放它过去，让失败落在断言里。 */
export const CONNECT_ROW_ID = "walkthrough.connected";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errorTextOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 连一次，失败就再连一次。
 *
 * Windows 的 BLE 栈偶发在订阅 notify 时抛 `WinError -2147023673`，同一台设备
 * 重连即可（既有 e2e 文件同一套处理）。断言失败绝不被重试掩盖。
 */
async function connectWithRetry(connect: () => Promise<unknown>, attempts = 2): Promise<void> {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await connect();
      return;
    } catch (error) {
      lastError = error;
      if (i + 1 < attempts) {
        await sleep(800);
      }
    }
  }
  throw lastError;
}

/** flags → 循环档（§7.5 位表）。 */
export function loopOfFlags(flags: number): number {
  if ((flags & PLAYBACK_FLAG.LOOP) === 0) {
    return 0;
  }
  return (flags & PLAYBACK_FLAG.LOOP_LAST) !== 0 ? 2 : 1;
}

/** 载荷前两字节按小端解 u16（固件侧就是这么写的，见 protocol.c 的 0x88）。 */
export function firmwareVersionLE(payload: Uint8Array): {
  major: number;
  minor: number;
  value: number;
} {
  const major = payload[0] & 0xff;
  const minor = payload[1] & 0xff;
  return { major, minor, value: major | (minor << 8) };
}

export interface Gate {
  readonly run: boolean;
  readonly why: string;
}

export interface World {
  readonly scanned: boolean;
  readonly connected: boolean;
  readonly deviceName: string;
  readonly deviceId: string;
  readonly connectError: string | null;
  /** 这一行能不能碰设备。 */
  gate(step: Step): Gate;
  contexts(): { act: ActContext; observe: ObserveContext };
  shutdown(): Promise<void>;
}

function stripCountOf(state: DeviceState | null): number {
  return Math.max(1, Math.min(8, state?.stripCount ?? 8));
}

/** 从帧日志里取最近一帧 0x88 的原始载荷（15 字节）。 */
function lastDeviceInfoPayload(session: ControlSession): Uint8Array | null {
  const entries = session.log.snapshot();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.dir !== "rx" || entry.command !== DEVICE_CMD.DEVICE_INFO_REPORT) {
      continue;
    }
    const bytes = hexToBytes(entry.hex);
    if (bytes === null) {
      continue;
    }
    const decoded = decodeFrame(bytes);
    if (decoded.ok) {
      return decoded.payload.slice();
    }
  }
  return null;
}

/** 读现场：电源 / 亮度 / 逐带掩码 / 逐带段数 / 4 槽阶段数 / 逐带分区内容。 */
async function readSnapshotOf(session: ControlSession): Promise<RestorePoint> {
  const state = await session.refreshState();
  const stripCount = stripCountOf(state);
  const segments: SegmentReport[] = [];
  for (let stripId = 0; stripId < stripCount; stripId += 1) {
    const queried = await session.queryStrip(stripId).catch(() => null);
    if (queried !== null && queried.kind === "ok") {
      segments.push(...queried.reports);
    }
  }
  const stageCounts = new Array<number>(MAX_SCRIPTS).fill(0);
  const summaries = await session.queryScriptSummaries().catch(() => null);
  if (summaries !== null && summaries.kind === "ok") {
    for (const summary of summaries.summaries) {
      if (summary.scriptId >= 0 && summary.scriptId < stageCounts.length) {
        stageCounts[summary.scriptId] = Math.max(0, summary.stageCount);
      }
    }
  }
  return {
    power: state.power,
    brightness: state.brightness,
    maxBrightness: state.maxBrightness,
    stripPowerMask: state.stripPowerMask,
    stripSegCounts: state.stripSegCounts.slice(0, stripCount),
    scriptStageCounts: stageCounts,
    loop: loopOfFlags(state.flags) as 0 | 1 | 2,
    segments,
  };
}

export async function bootWorld(): Promise<World> {
  let gateway: any = null;
  let device: { deviceId: string; name: string } | null = null;
  let connectError: string | null = null;
  let rawInfo: Uint8Array | null = null;
  let snapshot: RestorePoint | null = null;
  let pageHandles: PageHandles | null = null;

  /* wx-bridge.mjs 是 ESM 辅助件、没有类型声明：两处入口按它实际收的形状显式标一下。 */
  const wxStub = createWxStub({
    call: (...a: any[]) => gateway.call(...a),
    ready: Promise.resolve(),
  } as any);
  gateway = startGateway({ onEvent: (msg: any) => wxStub.pump(msg) } as any);
  await gateway.ready;
  wxStub.setGateway(gateway);
  const wx = wxStub.wx;
  (globalThis as any).wx = wx;

  device = (await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), SCAN_BUDGET_MS);
    const handler = (res: any) => {
      const hit = (res.devices || []).find((d: any) => (d.name || "").startsWith(NAME_PREFIX));
      if (hit) {
        clearTimeout(timer);
        wx.offBluetoothDeviceFound(handler);
        resolve(hit);
      }
    };
    wx.onBluetoothDeviceFound(handler);
    wx.startBluetoothDevicesDiscovery({ allowDuplicatesKey: true });
  })) as { deviceId: string; name: string } | null;
  await wx
    .stopBluetoothDevicesDiscovery({})
    .catch(() => undefined);

  const found = device;

  if (found === null) {
    /* 没设备：不装页面、不连、不读。整组 skip，本文件 0 passed。 */
    const noDevice: World = {
      scanned: false,
      connected: false,
      deviceName: "",
      deviceId: "",
      connectError: null,
      gate: () => ({ run: false, why: "没扫到 Lumen 设备" }),
      contexts: () => {
        throw new Error("没扫到 Lumen 设备：走查用例组整组跳过");
      },
      shutdown: async () => {
        gateway?.stop();
      },
    };
    return noDevice;
  }

  const live = new ControlSession({
    platform: "android",
    devMode: false,
    transportOverride: new BleTransport({
      log: new FrameLog({ mirrorToConsole: false }),
      platform: "android",
    }),
  });

  try {
    await connectWithRetry(() => live.connect(found.deviceId, found.name));
  } catch (error) {
    connectError = errorTextOf(error);
  }

  const deadLinkReason = (): string =>
    connectError === null
      ? `链路不在 ready（当前 ${live.linkState}）`
      : `连不上设备 ${found.name}（${found.deviceId}）：${connectError}`;

  if (connectError === null) {
    /* 0x88 到得比 ready 晚。自己查一次，不依赖「连接期那一帧还在环形缓冲里」。 */
    await waitFor(() => live.deviceInfo !== null, {
      timeoutMs: DEVICE_INFO_BUDGET_MS,
      label: "session.deviceInfo 就位",
    }).catch(() => undefined);
    await live.queryDeviceInfo().catch(() => undefined);
    rawInfo = lastDeviceInfoPayload(live);
  }

  /* 页面 onLoad 拿的是 App 级单例，必须先把它指向这条会话。 */
  setSessionForTest(live);

  /* `installGlobals` 每次调用都会换一个新的 captured 数组，所以只装一次，
   * 然后按顺序 import、从末尾取。 */
  const captured = installGlobals({ wx });
  const home = await openPage(captured, () => import("../../../pages/home/home"), {});
  const devicePage = await openPage(captured, () => import("../../../pages/device/device"), {});
  const strip = await openPage(captured, () => import("../../../pages/strip/strip"), { strip: "0" });
  const deviceInfo = await openPage(
    captured,
    () => import("../../../pages/device-info/device-info"),
    {},
  );
  const discover = await openPage(captured, () => import("../../../pages/discover/discover"), {});
  pageHandles = { home, device: devicePage, strip, deviceInfo, discover };
  const pages = pageHandles;

  /** 链路不在 ready 时先连回来（收尾与 probe 行开工前都要这条）。 */
  const ensureReady = async (): Promise<void> => {
    if (live.linkState === "ready") {
      return;
    }
    await live.stopScan().catch(() => undefined);
    await connectWithRetry(() => live.connect(found.deviceId, found.name));
  };

  /**
   * 停播 + 逐带清分区 + 清掉这一步写下的方案草稿。
   *
   * 草稿会落在 wx 桩的内存 Map（`lumen.planDrafts.v1`）里，并串到下一段故事：
   * 上一个 probe 画过 0–4，下一个 probe 在同一区间再画就会被重叠预检拒掉，
   * 于是整份方案不下发、播放头也不动——那是**测试现场**的脏，不是产品行为。
   *
   * `point` 为 null 时到此为止，电源 / 亮度 / 掩码原样；非 null 时一并恢复。
   * 幂等：连跑两次结果相同。每步独立 catch——中途任何一条失败都不该让剩下的
   * 步骤整段不跑。
   */
  const resetDevice = async (point: RestorePoint | null): Promise<void> => {
    await ensureReady();
    const loop = (point?.loop ?? 0) as 0 | 1 | 2;
    await live.setPlayback(0, loop).catch(() => undefined);
    for (let stripId = 0; stripId < stripCountOf(live.deviceState); stripId += 1) {
      const queried = await live.queryStrip(stripId).catch(() => null);
      if (queried === null || queried.kind !== "ok") {
        continue;
      }
      for (const report of queried.reports) {
        await live.clearSegment(stripId, report.segId).catch(() => undefined);
      }
    }
    if (point === null) {
      /* 只清设备、不动电源：还要清掉本进程里留下的方案草稿，见方法头。 */
      resetDrafts(strip);
      return;
    }
    /* 分区内容写回快照：走查不该毁掉板子上原有的静态配置。 */
    for (const report of point.segments) {
      await live
        .setSegment({
          stripId: report.stripId,
          segId: report.segId,
          start: report.start,
          end: report.end,
          blend: report.blend,
          layer0: { ...report.layer0 },
          layer1: { ...report.layer1 },
        })
        .catch(() => undefined);
    }
    /* 走查为了跑起来而写的方案：快照里没有、现在有的槽位要清掉，否则重跑时
     * 播放头与 `lastDownloadedScript` 都从别人的现场开始。 */
    const summaries = await live.queryScriptSummaries().catch(() => null);
    if (summaries !== null && summaries.kind === "ok") {
      for (const summary of summaries.summaries) {
        const before = point.scriptStageCounts[summary.scriptId] ?? 0;
        if (before === 0 && summary.stageCount > 0) {
          await live.clearScript(summary.scriptId).catch(() => undefined);
        }
      }
    }
    /* 电源与亮度一起恢复：只复位掩码会把用户的灯关掉、把亮度抹成 0。 */
    await live.setPower(point.power === 1).catch(() => undefined);
    live.commitBrightness(point.brightness);
    await sleep(300);
    for (let stripId = 0; stripId < stripCountOf(live.deviceState); stripId += 1) {
      const want = (point.stripPowerMask & (1 << stripId)) !== 0;
      if (want !== live.stripPower(stripId)) {
        await live.setStripPower(stripId, want).catch(() => undefined);
      }
    }
    await sleep(200);
  };

  /**
   * 清掉页面内存与存储里留下的方案草稿（`lumen.planDrafts.v1`）。
   *
   * 不清会串到下一段故事：上一个 probe 在同一区间画过分区，下一个 probe 再画
   * 就被重叠预检挡住、整份方案不下发、播放头也不动——那是现场的脏，不是产品行为。
   */
  const resetDrafts = (page: PageInstance): void => {
    try {
      const storage = page.storage;
      const key = typeof page.deviceKeyForDrafts === "function" ? page.deviceKeyForDrafts() : "";
      if (storage !== null && storage !== undefined && key.length > 0) {
        clearPlanDraftsForDevice(storage, key);
      }
    } catch {
      /* 草稿清理失败不该让 probe 行变成一次「设备坏了」的假结论 */
    }
    page.onLoad?.({ strip: "0" });
    page.onShow?.();
  };

  if (connectError === null) {
    await waitFor(() => home.data.ready === true, { timeoutMs: 30_000, label: "首页 ready" }).catch(
      () => undefined,
    );
    await waitFor(
      () => devicePage.data.ready === true,
      { timeoutMs: 30_000, label: "设备页 ready" },
    ).catch(() => undefined);
    await waitFor(() => strip.data.ready === true, { timeoutMs: 30_000, label: "灯组页 ready" }).catch(
      () => undefined,
    );
    /* 设备信息页没有 ready 标记：固件栏从「—」变成真值才是读完了。 */
    await waitFor(() => deviceInfo.data.firmwareText !== "—", {
      timeoutMs: DEVICE_INFO_BUDGET_MS,
      label: "设备信息页固件栏",
    }).catch(() => undefined);
    await sleep(300);

    /* 先归一化再记快照：板子上留着上次的分区时，先清掉再走查。
     * 拒绝在脏板上走查会让人无从入手。 */
    await resetDevice(null);
    snapshot = await readSnapshotOf(live);
  }

  const snapshotOfRows = snapshot;

  const handles = (): PageHandles => {
    if (pages === null) {
      throw new Error("页面还没装上");
    }
    return pages;
  };

  const act: ActContext = {
    get pages(): PageHandles {
      return handles();
    },
    async disturb(kind: "drop-link") {
      if (kind !== "drop-link") {
        throw new Error(`不认识的扰动：${String(kind)}`);
      }
      /* 网关真的断 bleak client → disconnected_callback → 传输层 markLinkLost
       * → 会话层按 1s/2s/4s 退避回连。这是唯一可用的真实断线触发点。 */
      await gateway.call("disconnect", {});
    },
    async waitLink(state: LinkState, timeoutMs = RECONNECT_BUDGET_MS) {
      await waitFor(() => live.linkState === state, {
        timeoutMs,
        label: `链路变成 ${state}（当前 ${live.linkState}）`,
      });
    },
    isScanning() {
      return live.linkState === "scanning";
    },
    async waitPageReady(pageName: PageName, timeoutMs = 30_000) {
      await waitFor(() => handles()[pageName].data.ready === true, {
        timeoutMs,
        label: `${pageName} 页 ready`,
      });
    },
    async waitPageIdle(pageName: PageName, field: string, timeoutMs = 30_000) {
      await waitFor(() => handles()[pageName].data[field] !== true, {
        timeoutMs,
        label: `${pageName}.${field} 落下`,
      });
    },
    async waitMirror(pred, label, timeoutMs = 15_000) {
      await waitFor(
        () => {
          const state = live.deviceState;
          return state !== null && pred(state);
        },
        { timeoutMs, label },
      );
    },
    async deviceMaxBrightness() {
      /* 这一处读回只用来挑「拖到哪」，不是断言值。 */
      const fresh = await live.refreshState();
      return fresh.maxBrightness;
    },
    async neutralise() {
      await resetDevice(null);
    },
    async restoreDevice() {
      await resetDevice(snapshotOfRows);
    },
    sleep,
  };

  const observe: ObserveContext = {
    get pages(): PageHandles {
      return handles();
    },
    mirror() {
      const state = live.deviceState;
      if (state === null) {
        throw new Error(deadLinkReason());
      }
      return state;
    },
    async refreshState() {
      if (live.linkState !== "ready") {
        throw new Error(deadLinkReason());
      }
      return live.refreshState();
    },
    async queryStrip(stripId: number) {
      if (live.linkState !== "ready") {
        throw new Error(deadLinkReason());
      }
      const result = await live.queryStrip(stripId);
      if (result.kind === "ok") {
        return result.reports;
      }
      throw new Error(
        result.kind === "ack-error"
          ? `QueryStrip(${stripId}) 被拒绝（结果码 ${result.ack.resultCode}）`
          : `QueryStrip(${stripId}) 失败：${result.kind === "error" ? result.message : result.kind}`,
      );
    },
    lastScript(): ScriptConfig | null {
      return live.lastDownloadedScript;
    },
    deviceInfo() {
      return live.deviceInfo;
    },
    rawDeviceInfoPayload() {
      return rawInfo === null ? null : rawInfo.slice();
    },
    linkState() {
      return live.linkState;
    },
    async queryStateOk() {
      if (live.linkState !== "ready") {
        return false;
      }
      const ack = await live.queryState().catch(() => null);
      return ack !== null && ack.ok;
    },
    snapshot() {
      if (snapshotOfRows === null) {
        throw new Error(deadLinkReason());
      }
      return snapshotOfRows;
    },
  };

  return {
    scanned: true,
    connected: connectError === null,
    deviceName: found.name,
    deviceId: found.deviceId,
    connectError,
    gate(step: Step): Gate {
      if (connectError !== null && step.id !== CONNECT_ROW_ID) {
        return { run: false, why: `扫到了设备但连不上：${connectError}` };
      }
      return { run: true, why: "" };
    },
    contexts: () => ({ act, observe }),
    shutdown: async () => {
      /* 兜住「跑到一半进程被杀」：不抛、不断言。收尾断言在最后一行——
       * `afterAll` 抛错时 vitest 的 numFailedTests 仍是 0，编排器会把一次
       * 收尾失败报成 PASS。 */
      try {
        if (connectError === null && live.linkState === "ready") {
          await resetDevice(snapshotOfRows);
        }
      } catch {
        /* 见上：这里不再制造第二条结论 */
      }
      try {
        await live.disconnect();
      } catch {
        /* 已断开 */
      }
      gateway?.stop();
    },
  };
}

/**
 * import 一个页面模块并实例化。
 *
 * `import` 走缓存：同一模块第二次 import 不会再调 `Page({...})`，所以每个
 * 页面只在这里打开一次，之后所有行共用同一个实例——页面私有状态因此跨行
 * 保留，这正是「像真用户一样」需要的。
 */
async function openPage(
  captured: any[],
  load: () => Promise<unknown>,
  onLoadOptions: Record<string, string | undefined>,
): Promise<PageInstance> {
  const before = captured.length;
  await load();
  if (captured.length === before) {
    throw new Error("页面模块没有注册 Page({...})");
  }
  const page = instantiate(captured[captured.length - 1]) as PageInstance;
  page.onLoad?.(onLoadOptions);
  page.onShow?.();
  return page;
}
