/**
 * 设备详情页（二级页）：从首页大卡进入，本页承担原来的「灯光控制」。
 *
 * ## 为什么灯光并入设备详情（本轮交互改版的决定）
 *
 * 原来的 tab 结构是「设备 / 灯光 / 剧本」，用户要先在设备页连上、再切到灯光页
 * 才能控制，而「这台设备」与「它的灯光」在概念上是一件事。改版后：
 *   首页（大卡 + 小图）→ 点大卡 → 本页（这台灯控的全部控制）
 *
 * #58 起「剧本」tab 也删除了：灯效方案就在本页的「自定义」档里编，
 * 底部只剩「设备 / 发现」两项，不再有一个需要先选段才能用的第二编辑器。
 *
 * ## 进入时的连接语义
 *
 * 首页只负责「浏览」，所以本页必须自己把目标设备连上：
 *  - 已连着它 → 什么都不做；
 *  - 连着别的设备 → `switchTo`（主动切换，失败停在未连接并给重试）；
 *  - 没连着 → `connect`。
 *
 * ## 关键不变量（沿用原灯光页）
 *
 *  - **灯带是显式参数**：所有设备调用都传 `data.stripId`；
 *  - **切换灯带只是重新读**：切带不清设备配置、不清登记表，只 `queryStrip(新带)`；
 *  - **每带灯珠数逐带真实**：chips 的灯珠数来自 `State.stripCounts[i]`；
 *  - 启用掩码只过滤 chips，隐藏一条带不丢它的段。
 */

import { errorText, resultText } from "../../utils/ble/errors";
import type { LinkDetail } from "../../utils/ble/transport";
import { ConnectCancelledError } from "../../utils/ble/transport";
import {
  brightnessPercent as percentOf,
  clampBrightness,
  effectiveMaxBrightness,
} from "../../utils/control/brightness";
import { createWxStorage, type SessionStorage } from "../../utils/control/device-cache";
import {
  enabledStripIds,
  loadRegistry,
  type DeviceRegistry,
} from "../../utils/control/device-registry";
import {
  brightnessHintText,
  brightnessViewPatch,
  powerLabelText,
} from "../../utils/control/view-model";
import { COLOR_UI_INTERVAL_MS } from "../../utils/control/wheel-view";
import {
  buildStripChips,
  pickStripId,
  stripChipSummary,
  type StripChip,
} from "../../utils/control/strip-chips";
import { ControlSession } from "../../utils/control/session";
import { getSession, isMockSession } from "../../utils/control/session-singleton";
import { loadTheme, themeClass, type ThemeMode } from "../../utils/control/theme";
import { PAGE_ROUTES, pushTo, queryText } from "../../utils/control/routes";
import { statusView } from "../../utils/control/status-view";
import { PRESETS, rgbToSegmentParams } from "../../utils/color/hsv";
import { MAX_STRIPS, NO_EFFECT } from "../../utils/protocol/constants";
import {
  buildQuickCardViews,
  buildQuickPanel,
  buildQuickSpec,
  inferQuickCard,
  quickCardOf,
  quickPresetFlags,
  type QuickCardView,
  type QuickParams,
  type QuickPanelView,
} from "../../utils/control/quick-effects";
import type {
  DeviceState,
  EffectLayer,
  LinkState,
  SegmentReport,
  SegmentSpec,
  StripConfig,
} from "../../utils/protocol/types";
import {
  addZone,
  cellFromRatio,
  checkZoneAdd,
  defaultZoneLayer,
  draftConflicts,
  dragRange,
  EMPTY_DRAG,
  removeZone,
  resizeZone,
  setZoneLayer0,
  setZoneOverlay,
  splitParts,
  splitWhole,
  zonesFromReports,
  type DragState,
} from "../../utils/control/zone-editor";
import { readZone } from "../../utils/control/zone-model";
import {
  buildZoneCells,
  zonesSummary,
  type ZoneCell,
} from "../../utils/control/effect-layout";
import {
  BLEND_OPTIONS,
  MAIN_MODE_OPTIONS,
  applyLayerType,
  layerModeOf,
  type LayerMode,
} from "../../utils/control/effect-view";
import {
  clampPlan,
  createPlanState,
  currentPlanDraft,
  currentStep,
  nearestDurationLabel,
  PLAN_CAPACITY_NOTE,
  PLAN_READBACK_NOTE,
  replaceStepZones,
  STEP_DURATION_OPTIONS,
  stripsOfStep,
  zoneCountOfStep,
  zonesOfStep,
  MAX_PLAN_STEPS,
  type PlanState,
} from "../../utils/control/plan-editor";
import {
  addStage,
  createScriptDrafts,
  draftCapacityBytes,
  moveStage,
  removeStage,
  setStageDuration,
  draftToScriptConfig,
  type ScriptDraft,
} from "../../utils/control/script-view";
import { checkScriptBlobBytes } from "../../utils/control/script-plan";
import {
  planTransition,
  saveCustomSnapshot,
  type CustomSnapshot,
} from "../../utils/control/effect-mode";
import { MAX_SCRIPTS } from "../../utils/protocol/constants";
import type { ScriptConfig } from "../../utils/control/script-plan";
import { blendName } from "../../utils/control/effect-view";
import { rgbToHex, segmentHueSatToRgb } from "../../utils/color/hsv";

/** 灯珠条上一格的展示形状（WXML 直接渲染）。 */
interface ZoneCellView extends ZoneCell {
  /** 灯珠编号（从 1 显示）。 */
  label: string;
}

/** 光区列表的一行。 */
interface ZoneRow {
  segId: number;
  /** 「光区 1」（从 1 编号）。 */
  title: string;
  /** 「0–13」。 */
  rangeText: string;
  /** 主效果名（静态 / 呼吸 / 彩虹 / 流光）。 */
  modeName: string;
  /** 叠加效果名；没有叠加层为空串。 */
  overlayName: string;
  /** 叠加方式名（只有叠加层存在时才有意义）。 */
  blendName: string;
  hex: string;
  pendingDelete: boolean;
}

/** 方案槽位标签。 */
interface PlanTab {
  planId: number;
  label: string;
  active: boolean;
}

/** 步骤行。 */
interface StepRow {
  index: number;
  title: string;
  durationLabel: string;
  summary: string;
  active: boolean;
  first: boolean;
  last: boolean;
}

/** chip 的展示形状 = 纯视图模型 + 一行摘要文本。 */
interface StripChipView extends StripChip {
  summary: string;
}

Page({
  data: {
    themeClass: "",
    mock: false,

    statusText: "未连接",
    statusSub: "正在连接…",
    statusAction: "取消",
    linkClass: "link-idle",
    ready: false,
    /** 顶部标题（设备备注名 / 广播名）。 */
    deviceName: "",
    deviceId: "",
    /** 目标设备尚未连上时的提示（例如切换失败）。 */
    connectHint: "",
    connectBusy: false,

    // 灯带切换器
    stripChips: [] as StripChipView[],
    stripId: -1,
    stripTitle: "—",
    stripHint: "连接后选择灯组",

    // 总闸
    power: 0 as 0 | 1,
    powerBusy: false,
    powerLabel: "已关",

    // 选中灯带的独立开关（SetStripPower 0x1B）
    stripOn: false,
    stripPowerBusy: false,

    // 亮度
    brightness: 0,
    brightnessDisplay: 0,
    brightnessPercent: 0,
    maxBrightness: 255,
    brightnessHintText: "连接后可调节",

    ledCount: 0,
    stripCount: 0,

    /* ---------------- 灯效编辑（#54） ---------------- */
    /** 编辑档位：快捷（点结果）/ 自定义（编排）。 */
    effectMode: "quick" as "quick" | "custom",
    quickCards: [] as QuickCardView[],
    quickPanel: null as QuickPanelView | null,
    quickPresetFlags: [] as boolean[],
    quickPresets: PRESETS,
    /** 当前灯效的一行摘要（设备控制页要求：打开就知道现在亮的是什么）。 */
    effectSummary: "还没有灯效",
    /** 不做动画时（未连接 / 未选灯组）卡片区禁用并给出原因。 */
    quickDisabledReason: "",
    quickBusy: false,
    quickHint: "",

    /* ---------------- 自定义档（#55 / #56） ---------------- */
    /** 灯珠条：一格一颗灯珠，带归属光区与冲突标记。 */
    zoneCells: [] as ZoneCellView[],
    /** 当前步骤里本灯组的光区（列表）。 */
    zoneRows: [] as ZoneRow[],
    /** 拖选中的区间文本（「12–27」）；不在拖选时为空。 */
    draftRangeText: "",
    /** 拖选与已有光区冲突（立刻变红，且不写入设备）。 */
    draftConflict: false,
    /** 光区数量 / 上限提示。 */
    zoneHintText: "",
    /** 正在二次确认删除的光区槽位（-1 = 无）。 */
    pendingDeleteSegId: -1,
    /** 数字精修入口是否展开。 */
    editRangeOpen: false,
    editStartText: "",
    editEndText: "",
    /** 当前编辑的是哪个光区（-1 = 新建）。 */
    editSegId: -1,
    /** 一键切分的按钮（整条 / 前半 / 后半 / 均分 2-4）。 */
    splitButtons: [
      { id: "whole", label: "整条" },
      { id: "firstHalf", label: "前半" },
      { id: "secondHalf", label: "后半" },
      { id: "two", label: "均分 2" },
      { id: "three", label: "均分 3" },
      { id: "four", label: "均分 4" },
    ] as Array<{ id: string; label: string }>,
    /** 方案槽位（1-4）与步骤列表（#56 接入，这里先给出数据形状）。 */
    planTabs: [] as PlanTab[],
    planId: 0,
    stepRows: [] as StepRow[],
    /** 主效果的四个选项与叠加方式（WXML 直接渲染）。 */
    mainModes: MAIN_MODE_OPTIONS.map((option) => ({ mode: option.mode, name: option.name })),
    blendOptions: BLEND_OPTIONS.map((option) => ({ value: option.value, name: option.name })),
    /** 光区可用颜色（预设色 → 协议 hue/sat，WXML 直接下发） */
    zonePresets: PRESETS.map((preset) => ({
      name: preset.name,
      hex: preset.hex,
      ...rgbToSegmentParams(preset.rgb),
    })),
    stepIndex: 0,
    stepDurationLabel: "1 秒",
    stepDurationOptions: [] as Array<{ value: number; label: string; active: boolean }>,
    planSummaryText: "",
    planNote: "",
    stepBusy: false,
    stepHint: "",
    writingPlan: false,
    playingPlan: false,
    /** 自定义档整体是否不可用（未连接 / 未选组）。 */
    customDisabledReason: "",
    /** 自定义档的说明行。 */
    customHint: "",
  },

  session: null as ControlSession | null,
  pageReady: false,
  lastBrightnessUiAt: 0,
  /** 设备权威的光区列表（当前灯组，最近一次 QueryStrip）。 */
  segmentReports: [] as SegmentReport[],
  registry: null as DeviceRegistry | null,
  storage: null as SessionStorage | null,
  unsubscribers: [] as Array<() => void>,
  /** 从首页带过来的设备 key（hardwareId 优先，空表示「连当前已连接的」）。 */
  targetKey: "",
  themeMode: "system" as ThemeMode,
  /** 是否已经为这台设备发起过连接（避免 onShow 重复连接）。 */
  autoConnectTried: false,
  /** 快捷档每张卡的参数（按灯组隔离，切带不串档）。 */
  quickParamsByStrip: new Map<number, QuickParams>(),
  /** 快捷档当前选中的卡（按灯组隔离）。 */
  quickCardByStrip: new Map<number, string>(),
  /** 300ms 防抖的定稿定时器（参数拖动时只发最后一次）。 */
  quickTimer: null as ReturnType<typeof setTimeout> | null,
  /** 防止「防抖期间又点卡片」把旧参数写出去。 */
  quickEpoch: 0,

  /** 自定义档：方案槽位 → 步骤 → 光区的三级草稿。 */
  plan: null as PlanState | null,
  /** 拖动划选的锚点 / 指尖（不落 data，避免每帧 setData）。 */
  drag: EMPTY_DRAG as DragState,
  /** 自定义档写入的防抖定时器（拖动区间后短暂防抖再写）。 */
  zoneTimer: null as ReturnType<typeof setTimeout> | null,
  zoneEpoch: 0,
  /** 当前步骤的光区（设备已确认那一份，作为编辑基础）。 */
  stepZones: [] as SegmentSpec[],
  /** 灯珠条的实测左边界与宽度（触摸坐标换算用）。 */
  ledBarLeft: 0,
  ledBarWidth: 0,

  onLoad(options: Record<string, string | undefined>) {
    /* 页面私有状态（不进 data）。Page() 不保证对象字面量字段会被复制到
     * 实例上，所以在这里显式兜底——漏掉会让 onLoad / onUnload 抛
     * TypeError 并中断整页的事件绑定。 */
    this.unsubscribers = [];
    this.segmentReports = [];
    this.pageReady = false;
    this.lastBrightnessUiAt = 0;
    this.targetKey = "";
    this.autoConnectTried = false;
    this.registry = null;
    this.quickParamsByStrip = new Map<number, QuickParams>();
    this.quickCardByStrip = new Map<number, string>();
    this.quickTimer = null;
    this.quickEpoch = 0;
    this.plan = null;
    this.drag = EMPTY_DRAG;
    this.zoneTimer = null;
    this.zoneEpoch = 0;
    this.stepZones = [];
    this.ledBarLeft = 0;
    this.ledBarWidth = 0;

    const storage = createWxStorage();
    this.storage = storage;
    this.themeMode = loadTheme(storage);
    this.registry = loadRegistry(storage);
    this.targetKey = queryText(options, "key", "");

    this.session = getSession();

    this.setData({
      themeClass: themeClass(this.themeMode),
      mock: isMockSession(),
    });

    this.applyTargetName();
  },

  onReady() {
    this.pageReady = true;
  },

  onShow() {
    this.subscribe();
    this.syncFromSession();
    void this.session?.onShow();
    void this.ensureConnected();
    if (this.data.ready) {
      /* 段列表是设备权威、且设备不会主动上报：每次进页面重读当前带。 */
      if (this.data.stripId >= 0) {
        void this.refreshSegments();
      }
    }
  },

  onHide() {
    this.unsubscribe();
  },

  onUnload() {
    /* 二级页会被真正卸载；但会话属于 App，绝不 destroy。 */
    this.unsubscribe();
    this.session = null;
    this.storage = null;
  },

  subscribe() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.unsubscribers = [
      session.onLink((state, detail) => this.applyLink(state, detail)),
      session.onState((state) => this.applyDeviceState(state)),
      /* §9.1 的第 2、3 步由会话异步补：读完（或确认读不到）再重画 chips，
       * 不用固定延时猜 GPIO 什么时候到。 */
      session.onDeviceConfig(() => {
        void this.refreshStripChips();
        this.applyTargetName();
      }),
      /* #48：节流通道读不回完整 spec 时不会下发，但也没有 await 结果可看；
       * 会话用这条通道把原因送过来，本页弹一次提示（不假装改色成功）。 */
      session.onSegmentHint((message) => {
        this.setData({ colorHintText: message });
        wx.showToast({ title: message, icon: "none" });
      }),
    ];
  },

  unsubscribe() {
    for (const off of this.unsubscribers ?? []) {
      off();
    }
    this.unsubscribers = [];
  },

  reloadRegistry() {
    if (this.storage === null) {
      return;
    }
    this.registry = loadRegistry(this.storage);
  },

  // ---------------- 目标设备与连接 ----------------

  /**
   * 把 `key` 解析成可连接的 deviceId。
   *
   * key 是 hardwareId 优先的稳定标识（见 device-history.deviceKeyOf）；
   * 只有后端记录的设备没有本机 deviceId，本页无法连接，返回 null 并提示。
   */
  resolveTarget(): { deviceId: string; name: string } | null {
    const session = this.session;
    const registry = this.registry ?? { devices: [] };
    const key = this.targetKey;
    if (key.length === 0) {
      const deviceId = session?.transport.currentDeviceId ?? "";
      return deviceId.length > 0 ? { deviceId, name: this.data.deviceName } : null;
    }
    const recent = session?.recentDevices ?? [];
    const match =
      recent.find((entry) => entry.deviceId === key || entry.hardwareId === key) ?? null;
    if (match !== null) {
      const entry = registry.devices.find(
        (item) =>
          item.deviceId === match.deviceId ||
          (match.hardwareId !== undefined && item.hardwareId === match.hardwareId),
      );
      return {
        deviceId: match.deviceId,
        name: entry?.remark ?? match.name ?? match.deviceId,
      };
    }
    /* 登记表里只有 deviceId（没连过）的条目也认，方便从发现页直达。 */
    const entry = registry.devices.find(
      (item) => item.deviceId === key || item.hardwareId === key,
    );
    if (entry !== undefined) {
      return { deviceId: entry.deviceId, name: entry.remark ?? entry.deviceId };
    }
    return null;
  },

  /** 标题优先显示备注名（登记表），其次连接名，最后 deviceId。 */
  applyTargetName() {
    const session = this.session;
    const registry = this.registry ?? { devices: [] };
    const target = this.resolveTarget();
    const deviceId = target?.deviceId ?? session?.transport.currentDeviceId ?? "";
    const entry = registry.devices.find((item) => item.deviceId === deviceId);
    const name =
      entry?.remark ??
      target?.name ??
      session?.deviceInfo?.hwId ??
      (deviceId.length > 0 ? deviceId : "设备");
    this.setData({ deviceName: name, deviceId });
  },

  /**
   * 进入页面时确保连着目标设备。
   *
   * 只做一次：连接失败后不自动重试（避免和用户手动点重试打架），
   * 由页面上的提示条提供重试入口。
   */
  async ensureConnected() {
    const session = this.session;
    if (session === null || this.autoConnectTried) {
      return;
    }
    const target = this.resolveTarget();
    if (target === null) {
      this.setData({ connectHint: "这台设备本机没有连接记录，请到「发现」页扫描" });
      return;
    }
    this.autoConnectTried = true;
    if (session.linkState === "ready" && session.transport.currentDeviceId === target.deviceId) {
      return;
    }
    if (session.linkState === "connecting" || session.linkState === "initializing") {
      return;
    }
    this.setData({ connectBusy: true, connectHint: "" });
    try {
      if (session.linkState === "ready") {
        await session.switchTo(target.deviceId, target.name);
      } else {
        await session.connect(target.deviceId, target.name);
      }
      this.applyTargetName();
    } catch (err) {
      if (err instanceof ConnectCancelledError) {
        return;
      }
      this.setData({ connectHint: `连接失败：${errorText(err)}` });
    } finally {
      this.setData({ connectBusy: false });
    }
  },

  /** 手动重试连接（提示条点击）。 */
  async onRetryConnect() {
    this.autoConnectTried = false;
    this.setData({ connectHint: "" });
    await this.ensureConnected();
  },

  // ---------------- 状态与派生视图 ----------------

  /** 进页面时把会话已有状态铺到界面（切页回来不闪空态）。 */
  syncFromSession() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.registry = loadRegistry(createWxStorage());
    this.applyLink(session.linkState);
    const state = session.deviceState;
    if (state !== null) {
      this.applyDeviceState(state);
    }
  },

  applyLink(state: LinkState, detail?: LinkDetail) {
    const session = this.session;
    const view = statusView(
      state,
      detail?.deviceName ?? session?.cachedDevice?.name ?? this.data.deviceName,
      detail?.message,
      session?.reconnectPending ?? false,
      (session?.cachedDevice ?? null) !== null,
    );
    const ready = state === "ready";
    this.setData({ ...view, ready });
    if (!ready) {
      this.clearDeviceViews();
      if (state === "idle" && !this.autoConnectTried) {
        void this.ensureConnected();
      }
      return;
    }
    this.applyTargetName();
    /* §9.1 的引脚表由会话在 ready 时异步补齐：这里先按 State 画一版，
     * 读完时 onDeviceConfig 会再触发一次 chips 重画（GPIO 到位）。 */
    const current = session?.deviceState;
    if (current !== null && current !== undefined) {
      this.applyDeviceState(current);
    }
  },

  /** 设备权威的 State → 开关 / 亮度 / 灯带 chips / 段列表。 */
  applyDeviceState(state: DeviceState) {
    const max = effectiveMaxBrightness(state.maxBrightness);
    const brightness = clampBrightness(state.brightness, max);
    this.setData({
      power: state.power,
      powerLabel: powerLabelText(state.power, brightness),
      brightness,
      brightnessDisplay: brightness,
      brightnessPercent: percentOf(brightness, max),
      maxBrightness: max,
      brightnessHintText: brightnessHintText(brightness, this.data.ready),
      ledCount: state.ledCount,
      stripCount: state.stripCount,
    });
    this.applyStripSelection(state);
    void this.refreshStripChips();
  },

  /**
   * 按 State + 登记表算出「当前该操作哪条带」，并把界面切过去。
   *
   * 三条规则（协调者裁定）：
   *  - 当前带仍可见 → 保持（切页回来不跳带）；
   *  - 当前带被隐藏 → 退到第一条可见带；
   *  - 一条都没有 → -1，页面显示空态且不发任何写命令。
   */
  applyStripSelection(state: DeviceState) {
    const enabled = this.visibleStripIds(state);
    const next = pickStripId(state, enabled, this.data.stripId);
    const changed = next !== this.data.stripId;
    if (changed) {
        this.setData({ stripId: next });
    }
    if (next >= 0 && this.session !== null) {
      /* 会话记住选择（跨页保留），但本页所有调用仍显式传 stripId。 */
      this.session.setActiveStripId(next);
    }
    this.applyStripPowerView(state);
    this.setData({
      stripTitle: next >= 0 ? `灯组 ${next + 1}` : "无可见灯组",
      stripHint:
        next >= 0
          ? "切换只重新读灯控，不会清掉任何配置"
          : "在「发现」页打开至少一条灯组的显示开关",
    });
    if (changed) {
      void this.refreshSegments();
    }
  },

  /** 可见的灯带号：`State.stripCount` 截断后套用 App 本地启用掩码。 */
  visibleStripIds(state: DeviceState | null): number[] {
    if (state === null) {
      return [];
    }
    const deviceId = this.session?.transport.currentDeviceId ?? "";
    if (deviceId.length === 0) {
      /* 还没拿到 deviceId（极短窗口）：按「全显示」处理，避免空白页。 */
      const ids: number[] = [];
      for (let id = 0; id < Math.min(state.stripCount, MAX_STRIPS); id += 1) {
        ids.push(id);
      }
      return ids;
    }
    return enabledStripIds(this.registry ?? { devices: [] }, deviceId, state.stripCount);
  },

  /** 灯带切换器：逐带真实灯珠数 / GPIO / 开关 / 段数 / 动画标记。 */
  async refreshStripChips() {
    const session = this.session;
    const state = session?.deviceState ?? null;
    if (session === null || state === null) {
      this.setData({ stripChips: [] });
      return;
    }
    const config: StripConfig | null = session.stripConfigs;
    const chips = buildStripChips({
      state,
      config,
      enabled: this.visibleStripIds(state),
      selectedStripId: this.data.stripId,
    }).map((chip) => ({ ...chip, summary: stripChipSummary(chip) }));
    this.setData({ stripChips: chips });
  },

  /** 选中灯的独立开关显示（SetStripPower 的本地镜像）。 */
  applyStripPowerView(state: DeviceState | null) {
    const stripId = this.data.stripId;
    if (state === null || stripId < 0) {
      this.setData({ stripOn: false });
      return;
    }
    this.setData({ stripOn: (state.stripPowerMask & (1 << stripId)) !== 0 });
  },

  clearDeviceViews() {
    this.segmentReports = [];
    this.setData({
      power: 0,
      powerLabel: "已关",
      brightness: 0,
      brightnessDisplay: 0,
      brightnessPercent: 0,
      brightnessHintText: "连接后可调节",
      maxBrightness: effectiveMaxBrightness(undefined),
      colorHintText: "连接后可调节",
      selectedPreset: "",
      stripChips: [],
      stripId: -1,
      stripTitle: "—",
      stripHint: "连接后选择灯组",
      stripOn: false,
      ledCount: 0,
      stripCount: 0,
      quickCards: [],
      quickPanel: null,
      quickDisabledReason: "连接灯控后才能调灯效",
      effectSummary: "还没有灯效",
    });
  },

  // ---------------- 灯带切换 ----------------

  /**
   * 点 chip 切带。
   *
   * **只重新读**：不动设备配置、不动登记表、不重置其他带的段。
   * 顺序按 §9.1：State 已有 → QueryStrip(新带)。
   */
  async onStripTap(e: WechatMiniprogram.TouchEvent) {
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    if (stripId < 0 || stripId === this.data.stripId) {
      return;
    }
    const session = this.session;
    if (session === null) {
      return;
    }
    session.setActiveStripId(stripId);
    this.setData({
      stripId,
      stripTitle: `灯组 ${stripId + 1}`,
      colorHintText: "点一个段改颜色",
    });
    this.applyStripPowerView(session.deviceState);
    await this.refreshSegments();
    await this.refreshStripChips();
    /* 换灯组：快捷参数按组隔离，重画一次就不会带着上一组的值。 */
    this.renderQuick({ quickHint: "" });
  },

  /** 当前灯带的设备独立开关（SetStripPower 0x1B）。 */
  async onToggleStripPower() {
    const session = this.session;
    const stripId = this.data.stripId;
    if (session === null || stripId < 0 || this.data.stripPowerBusy) {
      return;
    }
    this.setData({ stripPowerBusy: true });
    try {
      const result = await session.setStripPower(stripId, !this.data.stripOn);
      if (result.kind === "ok") {
        this.applyDeviceState(result.state);
        return;
      }
      if (result.kind === "ack-error") {
        wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.setData({ stripPowerBusy: false });
    }
  },

  // ---------------- 总闸 ----------------

  async onTogglePower() {
    const session = this.session;
    if (session === null || !this.data.ready || this.data.powerBusy) {
      return;
    }
    this.setData({ powerBusy: true });
    try {
      const result = await session.setPower(this.data.power !== 1);
      if (result.kind === "ok") {
        this.applyDeviceState(result.state);
        wx.vibrateShort?.({ type: "light", fail: () => undefined });
        return;
      }
      if (result.kind === "ack-error") {
        wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
        void this.rereadState();
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.setData({ powerBusy: false });
    }
  },

  // ---------------- 亮度 ----------------

  onBrightnessChanging(e: WechatMiniprogram.SliderChanging) {
    const value = Number(e.detail.value);
    if (!Number.isFinite(value)) {
      return;
    }
    const now = Date.now();
    if (now - this.lastBrightnessUiAt >= COLOR_UI_INTERVAL_MS) {
      this.lastBrightnessUiAt = now;
      this.setBrightnessView(value, false);
    }
    this.session?.queueBrightness(value);
  },

  onBrightnessChange(e: WechatMiniprogram.SliderChange) {
    const value = Number(e.detail.value);
    if (!Number.isFinite(value)) {
      return;
    }
    this.setBrightnessView(value, true);
    this.session?.commitBrightness(value);
  },

  setBrightnessView(rawValue: number, bindValue: boolean) {
    this.setData(
      brightnessViewPatch(rawValue, this.data.maxBrightness, this.data.ready, bindValue),
    );
  },

  // ---------------- 光区（设备权威，只用于摘要与快捷档反推） ----------------

  /**
   * 从设备读回**当前灯组**的光区列表。
   *
   * 收窄后的设备页不再展示光区明细，但有两件事仍然依赖它：
   *  - 「当前灯效」摘要要知道现在有几个光区 / 是不是某张快捷卡；
   *  - 自定义档的预览与恢复要以设备真实值为起点。
   *
   * `stripId` 显式传给会话：读哪条灯组是本页的决定。切组后必须重读。
   */
  async refreshSegments(): Promise<void> {
    const session = this.session;
    const stripId = this.data.stripId;
    if (session === null || !this.data.ready || stripId < 0) {
      return;
    }
    const result = await session.queryStrip(stripId);
    if (result.kind !== "ok") {
      if (result.kind === "error") {
        this.setData({ quickHint: result.message });
      }
      return;
    }
    /* 只保留属于这条灯组的报告（设备回报的 stripId 是权威，防御脏数据）。 */
    this.segmentReports = result.reports.filter((report) => report.stripId === stripId);
    this.syncQuickFromDevice();
  },

  /** 进设备信息页（身份 / 固件 / 灯珠数 / 自检 / 改名 / 断开 / 删除）。 */
  onGoDeviceInfo() {
    if (!this.data.ready) {
      wx.showToast({ title: "先连接设备", icon: "none" });
      return;
    }
    pushTo(PAGE_ROUTES.deviceInfo);
  },

  // ---------------- 编辑档位（快捷 / 自定义） ----------------

  /**
   * 切换编辑档位。
   *
   * #57 把「切走前存快照 / 切回时恢复编排」接在这里；本轮（#54）只有快捷档
   * 完整，自定义档先给出占位说明。
   */
  /**
   * 切换编辑档位（#57）。
   *
   * 三条规则来自票面，且都由 `planTransition` 决定（纯函数，有单测）：
   *  - 自定义 → 快捷：**先存快照**再切；
   *  - 快捷 → 自定义且无快照：空白编排（第一次进）；
   *  - 快捷 → 自定义且有快照：恢复并轻提示「已恢复你之前的编排」。
   *
   * 已在快捷档再点快捷**不存快照**——否则快捷档的整组配置会覆盖真正的编排。
   */
  onModeTap(e: WechatMiniprogram.TouchEvent) {
    const mode = String(e.currentTarget.dataset.mode ?? "");
    if (mode !== "quick" && mode !== "custom") {
      return;
    }
    if (mode === this.data.effectMode) {
      return;
    }
    const deviceKey = this.deviceKey();
    const stripId = this.data.stripId;
    const transition = planTransition(this.data.effectMode, mode, deviceKey, stripId);

    if (transition.kind === "to-quick") {
      if (transition.shouldSave && stripId >= 0) {
        /* 快照存的是**完整编排**（4 槽 × 步骤 × 光区），不只是当前步骤。 */
        this.persistSnapshot(deviceKey, stripId);
      }
      this.setData({ effectMode: "quick", quickHint: "", stepHint: "" });
      this.renderQuick();
      return;
    }

    if (transition.restore !== null) {
      this.restoreSnapshot(transition.restore);
      this.setData({
        effectMode: "custom",
        quickHint: "",
        stepHint: "已恢复你之前的编排",
      });
    } else {
      this.setData({ effectMode: "custom", quickHint: "", stepHint: "" });
      /* 第一次进：用设备读回的光区给当前步骤铺底，用户看到的是现在灯在亮的样子。 */
      this.seedStepFromDevice();
    }
    this.renderCustom();
    if (transition.restore !== null) {
      wx.showToast({ title: "已恢复你之前的编排", icon: "none" });
      /* 恢复后把当前步骤预览到设备（用户马上能看到编排生效）。
       * quiet：不要用「已预览」覆盖掉「已恢复」这条更重要的提示。 */
      void this.previewStep(true);
    }
  },

  /** 当前设备的稳定 key（hardwareId 优先，未连接时为空）。 */
  deviceKey(): string {
    const session = this.session;
    const info = session?.deviceInfo;
    if (info !== null && info !== undefined && info.hwId.length > 0) {
      return info.hwId;
    }
    return session?.transport.currentDeviceId ?? "";
  },

  /** 把当前完整编排写进内存快照（含当前步骤的光区 + 全部方案草稿）。 */
  persistSnapshot(deviceKey: string, stripId: number): void {
    const plan = clampPlan(this.ensurePlan());
    saveCustomSnapshot(deviceKey, stripId, {
      zones: zonesOfStep(currentStep(plan), stripId),
      planId: plan.planId,
      stepIndex: plan.stepIndex,
      drafts: plan.drafts,
    });
  },

  /** 从快照恢复编排（深拷贝，改草稿不污染快照）。 */
  restoreSnapshot(snapshot: CustomSnapshot): void {
    const drafts = snapshot.drafts ?? createScriptDrafts();
    this.plan = clampPlan({
      drafts,
      planId: snapshot.planId,
      stepIndex: snapshot.stepIndex,
    });
    this.drag = EMPTY_DRAG;
  },

  /** 当前步骤在本组还没有光区时，用设备读回值铺底。 */
  seedStepFromDevice(): void {
    const plan = clampPlan(this.ensurePlan());
    const draft = currentPlanDraft(plan);
    if (draft === null || this.stepZones.length > 0) {
      return;
    }
    const zones = zonesFromReports(this.segmentReports);
    if (zones.length === 0) {
      return;
    }
    const drafts = plan.drafts.slice();
    drafts[plan.planId] = replaceStepZones(draft, plan.stepIndex, this.data.stripId, zones);
    this.plan = { ...plan, drafts };
  },

  /** 「当前灯效」摘要点击：滚到编辑区（摘要本身就是入口）。 */
  onEffectSummaryTap() {
    if (!this.data.ready) {
      wx.showToast({ title: "先连接灯控", icon: "none" });
      return;
    }
    wx.pageScrollTo?.({ selector: ".mode-switch", duration: 220, fail: () => undefined });
  },

  // ---------------- 快捷档（#54） ----------------
  // 语义：点一张卡 = 整组变成该效果。所以每次下发都是「一个覆盖整组的
  // 单层光区」，`SetSegment` 是绝对值命令，重复下发只覆盖自己 → 防抖安全。

  /** 当前灯组可用的快捷参数（没有记录时用卡片默认值）。 */
  quickParamsOf(cardId: string | null): QuickParams {
    if (cardId === null) {
      return {};
    }
    return this.quickParamsByStrip.get(this.data.stripId) ?? {};
  },

  /* ================= 自定义档（#55 光区 / #56 方案与步骤） ================= */

  /** 自定义档是否可用 + 不可用的原因。 */
  customDisabledReasonOf(): string {
    if (!this.data.ready) {
      return "连接灯控后才能编排";
    }
    if (this.data.stripId < 0) {
      return "先在「发现」页打开至少一条灯组";
    }
    if (this.data.ledCount < 1) {
      return "还没读到这组的灯珠数量，稍等片刻";
    }
    return "";
  },

  /** 确保三级草稿存在（第一次进自定义档时按设备真实值初始化）。 */
  ensurePlan(): PlanState {
    if (this.plan === null) {
      this.plan = createPlanState(createScriptDrafts());
    }
    return this.plan;
  },

  /** 重画整个自定义档（面包屑 / 步骤 / 光区列表 / 灯珠条）。 */
  renderCustom(patch: Record<string, unknown> = {}): void {
    const disabled = this.customDisabledReasonOf();
    const plan = clampPlan(this.ensurePlan());
    this.plan = plan;
    const draft = currentPlanDraft(plan);
    const step = currentStep(plan);
    const stripId = this.data.stripId;
    const ledCount = this.data.ledCount;

    /* 光区以「当前步骤 × 当前灯组」为准；没有草稿时用设备读回值铺底。 */
    const zones = zonesOfStep(step, stripId);
    this.stepZones = zones;

    const draftRange = dragRange(this.drag);
    const cells = buildZoneCells(
      ledCount,
      zones.map((zone) => ({ segId: zone.segId, start: zone.start, end: zone.end })),
      new Map(zones.map((zone) => [zone.segId, rgbToHex(segmentHueSatToRgb(zone.layer0.hue, zone.layer0.sat))])),
      draftRange,
    ).map((cell) => ({ ...cell, label: String(cell.index + 1) }));

    const stepRows: StepRow[] = (draft?.stages ?? []).map((item, index) => {
      const count = zoneCountOfStep(item, stripId);
      const strips = stripsOfStep(item);
      const durationValue = Number(item.durationInput);
      return {
        index,
        title: `步骤 ${index + 1}`,
        durationLabel: nearestDurationLabel(Number.isFinite(durationValue) ? durationValue : 1000),
        summary:
          item.segments.length === 0
            ? "还没排光区"
            : count > 0
              ? `${count} 个光区`
              : `${strips.length} 个灯组有光区（本组 0 个）`,
        active: index === plan.stepIndex,
        first: index === 0,
        last: index === (draft?.stages.length ?? 1) - 1,
      };
    });

    const durationValue = step === null ? 1000 : Number(step.durationInput);
    const current = Number.isFinite(durationValue) ? durationValue : 1000;
    const activeLabel = nearestDurationLabel(current);
    const zoneHintText = this.zoneHintTextOf(zones.length, ledCount, zones);

    this.setData({
      customDisabledReason: disabled,
      planTabs: Array.from({ length: MAX_SCRIPTS }, (_, planId) => ({
        planId,
        label: `方案 ${planId + 1}`,
        active: planId === plan.planId,
      })),
      planId: plan.planId,
      stepRows,
      stepIndex: plan.stepIndex,
      stepDurationLabel: activeLabel,
      stepDurationOptions: STEP_DURATION_OPTIONS.map((option) => ({
        ...option,
        active: option.label === activeLabel,
      })),
      zoneCells: cells,
      zoneRows: zones.map((zone) => ({
        segId: zone.segId,
        title: `光区 ${zone.segId + 1}`,
        rangeText: `${zone.start}–${zone.end}`,
        modeName: modeNameOf(zone.layer0.type),
        overlayName: zone.layer1.type === NO_EFFECT ? "" : modeNameOf(zone.layer1.type),
        blendName: zone.layer1.type === NO_EFFECT ? "" : blendName(zone.blend),
        hex: rgbToHex(segmentHueSatToRgb(zone.layer0.hue, zone.layer0.sat)),
        pendingDelete: zone.segId === this.data.pendingDeleteSegId,
      })),
      draftRangeText:
        draftRange === null ? "" : `${draftRange.start}–${draftRange.end}`,
      draftConflict:
        draftRange !== null &&
        draftConflicts(
          zones.map((zone) => ({ segId: zone.segId, start: zone.start, end: zone.end })),
          draftRange,
        ),
      zoneHintText,
      planSummaryText: `方案 ${plan.planId + 1} · 步骤 ${plan.stepIndex + 1} / ${Math.max(1, draft?.stages.length ?? 1)}`,
      planNote: PLAN_READBACK_NOTE,
      customHint: disabled,
      ...patch,
    });
    this.syncEffectSummary();
  },

  /** 光区提示（数量上限 / 熄灭灯珠）。 */
  zoneHintTextOf(count: number, ledCount: number, zones: readonly SegmentSpec[]): string {
    if (this.data.ledCount < 1) {
      return "";
    }
    const summary = zonesSummary(
      ledCount,
      zones.map((zone) => ({ segId: zone.segId, start: zone.start, end: zone.end })),
    );
    return count >= 8 ? `${summary} · 已达上限 8 个` : summary;
  },

  /** 设备控制页的「当前灯效」摘要（自定义档时显示方案/步骤）。 */
  syncEffectSummary(): void {
    if (this.data.effectMode !== "custom") {
      return;
    }
    const plan = clampPlan(this.ensurePlan());
    const draft = currentPlanDraft(plan);
    const total = Math.max(1, draft?.stages.length ?? 1);
    const playing = (this.session?.deviceState?.playbackState ?? 0) === 1;
    this.setData({
      effectSummary: `方案 ${plan.planId + 1} · 步骤 ${plan.stepIndex + 1} / ${total}${playing ? " · 播放中" : ""}`,
    });
  },

  /** 换方案槽位（每套独立草稿，互不覆盖）。 */
  onPlanTabTap(e: WechatMiniprogram.TouchEvent) {
    const planId = Number(e.currentTarget.dataset.planId ?? -1);
    if (!Number.isInteger(planId) || planId < 0 || planId >= MAX_SCRIPTS) {
      return;
    }
    this.plan = clampPlan({ ...this.ensurePlan(), planId, stepIndex: 0 });
    this.drag = EMPTY_DRAG;
    this.renderCustom({ stepHint: "", pendingDeleteSegId: -1 });
    /* 换方案时把该方案当前步骤的光区预览到设备（票面：编辑步骤时实时预览）。 */
    void this.previewStep();
  },

  onStepTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.step ?? -1);
    const plan = this.ensurePlan();
    const draft = currentPlanDraft(plan);
    if (draft === null || index < 0 || index >= draft.stages.length) {
      return;
    }
    this.plan = { ...plan, stepIndex: index };
    this.drag = EMPTY_DRAG;
    this.renderCustom({ stepHint: "", pendingDeleteSegId: -1 });
    void this.previewStep();
  },

  onStepAdd() {
    const plan = clampPlan(this.ensurePlan());
    const draft = currentPlanDraft(plan);
    if (draft === null) {
      return;
    }
    const next = addStage(draft);
    if (next === draft) {
      wx.showToast({ title: `最多 ${MAX_PLAN_STEPS} 个步骤`, icon: "none" });
      return;
    }
    const drafts = plan.drafts.slice();
    drafts[plan.planId] = next;
    this.plan = { ...plan, drafts, stepIndex: next.stages.length - 1 };
    this.renderCustom({ stepHint: "" });
  },

  onStepRemove(e: WechatMiniprogram.TouchEvent) {
    const plan = clampPlan(this.ensurePlan());
    const draft = currentPlanDraft(plan);
    const index = Number(e.currentTarget.dataset.step ?? -1);
    if (draft === null) {
      return;
    }
    const next = removeStage(draft, index);
    if (next === draft) {
      wx.showToast({ title: "至少保留 1 个步骤", icon: "none" });
      return;
    }
    const drafts = plan.drafts.slice();
    drafts[plan.planId] = next;
    this.plan = { ...plan, drafts, stepIndex: Math.min(plan.stepIndex, next.stages.length - 1) };
    this.renderCustom({ stepHint: "" });
  },

  onStepMove(e: WechatMiniprogram.TouchEvent) {
    const plan = clampPlan(this.ensurePlan());
    const draft = currentPlanDraft(plan);
    const index = Number(e.currentTarget.dataset.step ?? -1);
    const delta = Number(e.currentTarget.dataset.delta ?? 0);
    if (draft === null) {
      return;
    }
    const next = moveStage(draft, index, delta);
    if (next === draft) {
      return;
    }
    const drafts = plan.drafts.slice();
    drafts[plan.planId] = next;
    this.plan = { ...plan, drafts, stepIndex: index + delta };
    this.renderCustom({ stepHint: "" });
  },

  /** 改步骤时长（人话档位；协议里是毫秒，界面不出现这个词）。 */
  onStepDurationTap(e: WechatMiniprogram.TouchEvent) {
    const value = Number(e.currentTarget.dataset.ms ?? -1);
    if (!Number.isInteger(value) || value <= 0) {
      return;
    }
    const plan = clampPlan(this.ensurePlan());
    const draft = currentPlanDraft(plan);
    if (draft === null) {
      return;
    }
    const next = setStageDuration(draft, plan.stepIndex, String(value));
    const drafts = plan.drafts.slice();
    drafts[plan.planId] = next;
    this.plan = { ...plan, drafts };
    this.renderCustom({ stepHint: "" });
  },

  /** 把当前步骤 × 当前灯组的光区换成新列表（并写进草稿）。 */
  applyZones(zones: readonly SegmentSpec[], hint = ""): void {
    const plan = clampPlan(this.ensurePlan());
    const draft = currentPlanDraft(plan);
    if (draft === null) {
      return;
    }
    const next = replaceStepZones(draft, plan.stepIndex, this.data.stripId, zones);
    const drafts = plan.drafts.slice();
    drafts[plan.planId] = next;
    this.plan = { ...plan, drafts };
    this.renderCustom({ stepHint: hint });
    this.scheduleStepPreview();
  },

  /**
   * 步骤预览：把当前步骤、当前灯组的光区实时写进设备。
   *
   * 票面要求「编辑某步骤时它的光区实时写入设备作为预览」。两个约束：
   *  - 方案正在播放时实时光区不可见 → 先停止并提示；
   *  - 写失败要读回设备真实值（不能留假画面）。
   */
  scheduleStepPreview(): void {
    this.zoneEpoch += 1;
    const epoch = this.zoneEpoch;
    if (this.zoneTimer !== null) {
      clearTimeout(this.zoneTimer);
      this.zoneTimer = null;
    }
    this.zoneTimer = setTimeout(() => {
      this.zoneTimer = null;
      if (epoch !== this.zoneEpoch) {
        return;
      }
      void this.previewStep();
    }, 300);
  },

  async previewStep(quiet = false): Promise<void> {
    const session = this.session;
    const stripId = this.data.stripId;
    if (session === null || this.customDisabledReasonOf() !== "" || stripId < 0) {
      return;
    }
    try {
      const state = session.deviceState;
      if (state !== null && state.playbackState !== 0) {
        await session.setPlayback(0, (state.flags & 0x01) !== 0);
        this.setData({ stepHint: "已停止方案播放，改为预览" });
      }
      /*
       * 预览 = 用设备读回的真实光区做基线，再清掉本组的全部光区，然后
       * 按草稿逐条写回。清空是必须的：协议不允许重叠，而且草稿可能删掉了
       * 某个旧光区——不清的话旧光区会留在设备上，预览与草稿不一致。
       */
      const queried = await session.queryStrip(stripId);
      if (queried.kind !== "ok") {
        return;
      }
      const existing = queried.reports.filter((report) => report.stripId === stripId);
      for (const report of existing) {
        const cleared = await session.clearSegment(stripId, report.segId);
        if (!cleared.ok) {
          throw new Error(resultText(cleared.resultCode));
        }
      }
      for (const zone of this.stepZones) {
        const ack = await session.setSegment(zone);
        if (!ack.ok) {
          throw new Error(resultText(ack.resultCode));
        }
      }
      if (!quiet) {
        this.setData({ stepHint: "已预览本步骤的光区" });
      }
      await this.refreshSegments();
    } catch (err) {
      const message = errorText(err);
      this.setData({ stepHint: `预览失败：${message}` });
      wx.showToast({ title: `预览失败：${message}`, icon: "none" });
      await this.refreshSegments();
    }
  },

  // ---------------- 光区：拖动划选 ----------------

  /** 触摸开始：按比例换算成灯珠下标，作为锚点。 */
  async onZoneTouchStart(e: WechatMiniprogram.TouchEvent) {
    if (this.customDisabledReasonOf() !== "") {
      return;
    }
    /* 必须先测量再换算：宽度为 0 时 cellAt 返回 -1，拖动会整个失效。 */
    await this.measureLedBar();
    const index = this.cellAt(e);
    if (index < 0) {
      return;
    }
    this.drag = { anchor: index, cursor: index };
    this.renderCustom();
  },

  onZoneTouchMove(e: WechatMiniprogram.TouchEvent) {
    if (this.drag.anchor === null) {
      return;
    }
    const index = this.cellAt(e);
    if (index < 0 || index === this.drag.cursor) {
      return;
    }
    this.drag = { anchor: this.drag.anchor, cursor: index };
    this.renderCustom();
  },

  /** 松手：确认划出的区间（冲突 / 非法时**不写入设备**，就地提示）。 */
  onZoneTouchEnd() {
    const range = dragRange(this.drag);
    this.drag = EMPTY_DRAG;
    if (range === null) {
      this.renderCustom();
      return;
    }
    this.openRangeEditor(-1, range.start, range.end);
  },

  /** 把触摸点换算成灯珠下标（按灯珠条实测宽度做比例换算）。 */
  cellAt(e: WechatMiniprogram.TouchEvent): number {
    const touch = (e.touches?.[0] ?? e.changedTouches?.[0]) as
      | { clientX?: number; pageX?: number; x?: number }
      | undefined;
    const ledCount = this.data.ledCount;
    if (touch === undefined || ledCount < 1) {
      return -1;
    }
    const x = Number(touch.clientX ?? touch.pageX ?? touch.x ?? Number.NaN);
    if (!Number.isFinite(x) || this.ledBarWidth <= 0) {
      return -1;
    }
    return cellFromRatio((x - this.ledBarLeft) / this.ledBarWidth, ledCount);
  },

  /**
   * 实测灯珠条的位置与宽度。
   *
   * 触摸事件里的坐标是视口坐标，而 `boundingClientRect` 给的也是视口坐标，
   * 两者相减就是条内偏移——页面滚动、不同机型宽度都不影响。
   */
  measureLedBar(): Promise<void> {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .select(".led-bar")
        .boundingClientRect((rect) => {
          const box = rect as { left?: number; width?: number } | null;
          this.ledBarLeft = Number(box?.left ?? 0);
          this.ledBarWidth = Number(box?.width ?? 0);
          resolve();
        })
        .exec();
    });
  },

  // ---------------- 光区：快捷切分 ----------------

  onSplitTap(e: WechatMiniprogram.TouchEvent) {
    if (this.customDisabledReasonOf() !== "") {
      return;
    }
    const id = String(e.currentTarget.dataset.id ?? "");
    const stripId = this.data.stripId;
    const ledCount = this.data.ledCount;
    let zones: SegmentSpec[];
    if (id === "whole" || id === "firstHalf" || id === "secondHalf") {
      zones = splitWhole(id, ledCount, stripId, this.stepZones.map(readZone));
    } else if (id === "two" || id === "three" || id === "four") {
      const parts = id === "two" ? 2 : id === "three" ? 3 : 4;
      zones = splitParts(parts, ledCount, stripId, this.stepZones.map(readZone));
    } else {
      return;
    }
    this.applyZones(zones, "已按新的划分重建光区");
  },

  // ---------------- 光区：增删改 ----------------

  /** 数字精修入口：展开并填入当前值。 */
  onZoneEditTap(e: WechatMiniprogram.TouchEvent) {
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    const zone = this.stepZones.find((item) => item.segId === segId);
    if (zone === undefined) {
      return;
    }
    this.openRangeEditor(segId, zone.start, zone.end);
  },

  openRangeEditor(segId: number, start: number, end: number): void {
    this.setData({
      editRangeOpen: true,
      editSegId: segId,
      editStartText: String(start),
      editEndText: String(end),
      pendingDeleteSegId: -1,
    });
  },

  onEditStartInput(e: WechatMiniprogram.Input) {
    this.setData({ editStartText: String(e.detail.value ?? "") });
  },

  onEditEndInput(e: WechatMiniprogram.Input) {
    this.setData({ editEndText: String(e.detail.value ?? "") });
  },

  /** 确认区间：新建或改已有的那个（非法 / 重叠就地提示，一帧不发）。 */
  onRangeConfirm() {
    const start = Number(this.data.editStartText);
    const end = Number(this.data.editEndText);
    const stripId = this.data.stripId;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      wx.showToast({ title: "起点与终点都要填整数", icon: "none" });
      return;
    }
    if (start < 0 || end < 0 || start > end) {
      wx.showToast({ title: "区间不合法：起点不能大于终点", icon: "none" });
      return;
    }
    if (end > Math.max(0, this.data.ledCount - 1)) {
      wx.showToast({ title: `终点不能超过第 ${this.data.ledCount} 颗`, icon: "none" });
      return;
    }
    if (this.data.editSegId >= 0) {
      const next = resizeZone(this.stepZones, this.data.editSegId, start, end);
      if (next === null) {
        wx.showToast({ title: "与其它光区重叠，请调整", icon: "none" });
        return;
      }
      const zones = this.stepZones.map((zone) => (zone.segId === next.segId ? next : zone));
      this.setData({ editRangeOpen: false });
      this.applyZones(zones, "光区区间已更新");
      return;
    }
    const added = addZone(this.stepZones, stripId, start, end);
    if (added === null) {
      const check = checkZoneAdd(
        this.stepZones.map((zone) => ({ segId: zone.segId, start: zone.start, end: zone.end })),
        start,
        end,
      );
      wx.showToast({ title: check.message || "不能新增这个光区", icon: "none" });
      return;
    }
    this.setData({ editRangeOpen: false });
    this.applyZones([...this.stepZones, added], "已新增光区");
  },

  onRangeCancel() {
    this.setData({ editRangeOpen: false });
  },

  /** 删除光区：先二次确认，确认后该段熄灭、其余不动。 */
  onZoneDeleteTap(e: WechatMiniprogram.TouchEvent) {
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    if (segId < 0) {
      return;
    }
    if (this.data.pendingDeleteSegId !== segId) {
      this.setData({ pendingDeleteSegId: segId });
      this.renderCustom();
      return;
    }
    const next = removeZone(this.stepZones, segId);
    this.setData({ pendingDeleteSegId: -1 });
    this.applyZones(next, `光区 ${segId + 1} 已删除（其灯珠熄灭）`);
  },

  onZoneDeleteCancel() {
    this.setData({ pendingDeleteSegId: -1 });
    this.renderCustom();
  },

  /** 换主效果（四种灯效之一）。保留颜色，按类型重置参数。 */
  onZoneModeTap(e: WechatMiniprogram.TouchEvent) {
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    const mode = String(e.currentTarget.dataset.mode ?? "") as LayerMode;
    const zone = this.stepZones.find((item) => item.segId === segId);
    if (zone === undefined) {
      return;
    }
    const layer = applyModeToLayer(zone.layer0, mode);
    /* 只在防抖里写一次：连续点不同灯效不该发一堆积压帧。 */
    const zones = this.stepZones.map((item) =>
      item.segId === segId ? { ...item, layer0: layer, layer1: { ...item.layer1 } } : item,
    );
    this.applyZones(zones, "");
  },

  /** 改光区颜色（预设色块）。 */
  onZoneColorTap(e: WechatMiniprogram.TouchEvent) {
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    const hue = Number(e.currentTarget.dataset.hue ?? -1);
    const sat = Number(e.currentTarget.dataset.sat ?? -1);
    if (segId < 0 || !Number.isInteger(hue) || !Number.isInteger(sat)) {
      return;
    }
    const zones = setZoneLayer0(this.stepZones, segId, {
      ...(this.stepZones.find((zone) => zone.segId === segId)?.layer0 ?? defaultZoneLayer()),
      hue,
      sat,
    });
    this.applyZones(zones, "");
  },

  /** 叠加效果：开 / 关（关 = 叠加方式强制覆盖）。 */
  onZoneOverlayToggle(e: WechatMiniprogram.TouchEvent) {
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    const zone = this.stepZones.find((item) => item.segId === segId);
    if (zone === undefined) {
      return;
    }
    const hasOverlay = zone.layer1.type !== NO_EFFECT;
    const zones = hasOverlay
      ? setZoneOverlay(this.stepZones, segId, null, 0)
      : setZoneOverlay(
          this.stepZones,
          segId,
          applyModeToLayer(
            { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0 },
            "rainbow",
          ),
          0,
        );
    this.applyZones(zones, hasOverlay ? "叠加效果已关闭" : "已开启叠加效果");
  },

  /** 叠加方式（覆盖 / 相乘 / 相加）。 */
  onZoneBlendTap(e: WechatMiniprogram.TouchEvent) {
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    const blend = Number(e.currentTarget.dataset.blend ?? -1);
    const zone = this.stepZones.find((item) => item.segId === segId);
    if (zone === undefined || zone.layer1.type === NO_EFFECT) {
      return;
    }
    if (!BLEND_OPTIONS.some((option) => option.value === blend)) {
      return;
    }
    this.applyZones(setZoneOverlay(this.stepZones, segId, zone.layer1, blend), "");
  },

  // ---------------- 方案：写入灯控 / 播放 ----------------

  /**
   * 写入灯控：整套方案提交到设备并启用（**不自动播放**）。
   *
   * 三道预检在发第一帧之前：时长合法、区间合法、容量不超 16KB。
   */
  async onPlanWrite() {
    const session = this.session;
    const plan = clampPlan(this.ensurePlan());
    const draft = currentPlanDraft(plan);
    if (session === null || draft === null || !this.data.ready || this.data.writingPlan) {
      return;
    }
    const script = draftToConfig(draft, Math.max(1, this.data.stripCount));
    const precheck = session.validateScriptForDevice(script);
    if (!precheck.ok) {
      this.setData({ stepHint: precheck.message });
      wx.showToast({ title: precheck.message, icon: "none" });
      return;
    }
    const capacity = checkScriptBlobBytes(
      draftCapacityBytes(plan.drafts, [], plan.planId, script.stripCount),
    );
    if (!capacity.ok) {
      const message = `${capacity.message}（${PLAN_CAPACITY_NOTE}）`;
      this.setData({ stepHint: message });
      wx.showToast({ title: capacity.message, icon: "none" });
      return;
    }

    this.setData({ writingPlan: true, stepHint: "正在写入灯控…" });
    try {
      /* 写入前若方案在播放，先停止（否则用户看不到写入后的静态画面）。 */
      const state = session.deviceState;
      if (state !== null && state.playbackState !== 0) {
        await session.setPlayback(0, (state.flags & 0x01) !== 0);
      }
      const result = await session.downloadScript(script, {
        /* 写入即启用（「启用这套方案」），但不自动播放。 */
        activate: true,
        loop: state !== null && (state.flags & 0x01) !== 0,
      });
      if (result.kind === "ok") {
        this.setData({ stepHint: `方案 ${plan.planId + 1} 已写入灯控并启用` });
        void this.refreshSegments();
        return;
      }
      if (result.kind === "stale") {
        this.setData({ stepHint: "连接已切换，写入结果已丢弃" });
        return;
      }
      const message =
        result.kind === "too-large"
          ? `${result.message}；设备上的上一套方案仍可用`
          : result.kind === "ack-error"
            ? `写入被拒绝（${resultText(result.ack.resultCode)}），设备上的上一套方案仍可用`
            : result.message;
      this.setData({ stepHint: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ writingPlan: false });
    }
  },

  /** 播放 / 暂停 / 停止（State 是权威）。 */
  async onPlanPlayback(e: WechatMiniprogram.TouchEvent) {
    const session = this.session;
    const action = Number(e.currentTarget.dataset.action ?? -1);
    if (session === null || !this.data.ready || this.data.playingPlan) {
      return;
    }
    if (action !== 0 && action !== 1 && action !== 2) {
      return;
    }
    this.setData({ playingPlan: true });
    try {
      const loop = ((session.deviceState?.flags ?? 0) & 0x01) !== 0;
      const result = await session.setPlayback(action as 0 | 1 | 2, loop);
      if (result.kind === "ok") {
        this.syncEffectSummary();
        return;
      }
      if (result.kind === "ack-error") {
        wx.showToast({ title: resultText(result.ack.resultCode), icon: "none" });
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.setData({ playingPlan: false });
    }
  },

  /** 重画卡片 + 参数区 + 摘要。 */  renderQuick(patch: Record<string, unknown> = {}): void {
    const cardId = this.quickCardByStrip.get(this.data.stripId) ?? null;
    const params = this.quickParamsOf(cardId);
    const disabledReason = this.quickDisabledReasonOf();
    this.setData({
      quickCards: buildQuickCardViews(cardId, params),
      quickPanel: buildQuickPanel(cardId, params),
      quickPresetFlags: quickPresetFlags(params),
      quickDisabledReason: disabledReason,
      effectSummary: this.effectSummaryText(cardId, params),
      ...patch,
    });
  },

  /** 为什么不能点（未连接 / 没有灯组 / 灯珠数未知）。 */
  quickDisabledReasonOf(): string {
    if (!this.data.ready) {
      return "连接灯控后才能调灯效";
    }
    if (this.data.stripId < 0) {
      return "先在「发现」页打开至少一条灯组";
    }
    if (this.data.ledCount < 1) {
      return "还没读到这组的灯珠数量，稍等片刻";
    }
    return "";
  },

  /** 设备控制页要显示的一行「现在亮的是什么」。 */
  effectSummaryText(cardId: string | null, params: QuickParams): string {
    if (this.data.effectMode === "custom") {
      return "自定义编排（点这里继续编辑）";
    }
    const card = cardId === null ? null : quickCardOf(cardId);
    if (card === null) {
      return this.segmentReports.length > 0 ? `${this.segmentReports.length} 个光区` : "还没有灯效";
    }
    const extra = Object.keys(params).length > 0 ? "" : "";
    return `${card.name}${extra}`;
  },

  /** 从设备读回的段推断「现在大概是哪张卡」（判断不出就不高亮）。 */
  syncQuickFromDevice(): void {
    const stripId = this.data.stripId;
    if (stripId < 0) {
      return;
    }
    /* 整组只有一个覆盖全条的光区时，才有「某张快捷卡」可言。 */
    const reports = this.segmentReports;
    if (reports.length !== 1) {
      if (!this.quickCardByStrip.has(stripId)) {
        this.quickCardByStrip.delete(stripId);
      }
      this.renderQuick();
      return;
    }
    const only = reports[0];
    const coversWhole = only.start === 0 && only.end >= Math.max(0, this.data.ledCount - 1);
    const inferred = coversWhole && only.layer1.type === NO_EFFECT ? inferQuickCard(only.layer0) : null;
    if (inferred === null) {
      this.quickCardByStrip.delete(stripId);
    } else {
      this.quickCardByStrip.set(stripId, inferred);
      /* 从设备反推时也把参数回填成设备真实值，界面不显示「默认档」骗用户。 */
      this.quickParamsByStrip.set(stripId, this.paramsFromLayer(only));
    }
    this.renderQuick();
  },

  /** 设备的一层灯效 → 快捷档参数（只取该形态能表达的档位）。 */
  paramsFromLayer(report: SegmentReport): QuickParams {
    const layer = report.layer0;
    const params: QuickParams = { hue: layer.hue, sat: layer.sat };
    return params;
  },

  onQuickCardTap(e: WechatMiniprogram.TouchEvent) {
    const cardId = String(e.currentTarget.dataset.cardId ?? "");
    const card = quickCardOf(cardId);
    if (card === null || this.quickDisabledReasonOf() !== "" || this.data.quickBusy) {
      return;
    }
    /* 换卡时参数回到该卡默认值：把「呼吸的最暗档」带进「流光」是没有意义的。 */
    this.quickCardByStrip.set(this.data.stripId, card.id);
    this.quickParamsByStrip.set(this.data.stripId, {});
    this.renderQuick({ quickHint: "" });
    this.scheduleQuickWrite(true);
  },

  /** 参数选择（三档按钮）。 */
  onQuickChoiceTap(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? "");
    const value = String(e.currentTarget.dataset.value ?? "");
    if (key !== "speed" && key !== "level" && key !== "tail" && key !== "direction") {
      return;
    }
    const cardId = this.quickCardByStrip.get(this.data.stripId) ?? null;
    if (cardId === null || this.quickDisabledReasonOf() !== "") {
      return;
    }
    const params = { ...this.quickParamsOf(cardId), [key]: value } as QuickParams;
    this.quickParamsByStrip.set(this.data.stripId, params);
    this.renderQuick();
    this.scheduleQuickWrite(false);
  },

  /** 颜色预设（同一套色块，选中态由协议值反推）。 */
  onQuickPresetTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index ?? -1);
    const preset = PRESETS[index];
    const cardId = this.quickCardByStrip.get(this.data.stripId) ?? null;
    if (preset === undefined || cardId === null || this.quickDisabledReasonOf() !== "") {
      return;
    }
    const converted = rgbToSegmentParams(preset.rgb);
    this.quickParamsByStrip.set(this.data.stripId, {
      ...this.quickParamsOf(cardId),
      hue: converted.hue,
      sat: converted.sat,
    });
    this.renderQuick();
    this.scheduleQuickWrite(false);
  },

  /** 彩虹饱和度（0-100 → 协议 sat 0-255）。 */
  onQuickSaturationChanging(e: WechatMiniprogram.SliderChanging) {
    this.applyQuickSaturation(Number(e.detail.value), false);
  },

  onQuickSaturationChange(e: WechatMiniprogram.SliderChange) {
    this.applyQuickSaturation(Number(e.detail.value), true);
  },

  applyQuickSaturation(percent: number, commit: boolean) {
    const cardId = this.quickCardByStrip.get(this.data.stripId) ?? null;
    if (cardId === null || !Number.isFinite(percent) || this.quickDisabledReasonOf() !== "") {
      return;
    }
    const sat = Math.max(0, Math.min(255, Math.round((percent / 100) * 255)));
    this.quickParamsByStrip.set(this.data.stripId, {
      ...this.quickParamsOf(cardId),
      sat,
    });
    this.renderQuick();
    /* 拖动期间不写设备（会连发几十帧），松手才写。 */
    if (commit) {
      this.scheduleQuickWrite(true);
    }
  },

  /**
   * 300ms 防抖写入（票面：改动后 300ms 内设备状态更新，无需按钮）。
   *
   * `immediate` 用于「点卡片 / 松手」这类离散操作：它们没有后续拖动，
   * 等 300ms 只是让界面显得迟钝，所以立刻写。
   */
  scheduleQuickWrite(immediate: boolean) {
    this.quickEpoch += 1;
    const epoch = this.quickEpoch;
    if (this.quickTimer !== null) {
      clearTimeout(this.quickTimer);
      this.quickTimer = null;
    }
    const fire = () => {
      this.quickTimer = null;
      if (epoch !== this.quickEpoch) {
        return;
      }
      void this.writeQuick();
    };
    if (immediate) {
      fire();
      return;
    }
    this.quickTimer = setTimeout(fire, 300);
  },

  /**
   * 把当前卡片 + 参数写成「整组单层光区」并发给设备。
   *
   * 两个必须做对的地方：
   *  1. **方案播放期间实时光区不可见** → 先 `SetPlayback(stop)` 并提示；
   *  2. **失败要如实** → 重新 `queryStrip` 读回设备真实值刷新界面，绝不
   *     留一个假的成功画面。
   */
  async writeQuick(): Promise<void> {
    const session = this.session;
    const stripId = this.data.stripId;
    const cardId = this.quickCardByStrip.get(stripId) ?? null;
    const card = cardId === null ? null : quickCardOf(cardId);
    if (session === null || card === null || this.quickDisabledReasonOf() !== "") {
      return;
    }
    if (this.data.quickBusy) {
      /* 正在写：让本轮防抖再来一次（不并发发帧）。 */
      this.scheduleQuickWrite(false);
      return;
    }
    this.setData({ quickBusy: true });
    try {
      /* 方案播放中：设备按 active_segments 渲染，实时光区看不见。 */
      const state = session.deviceState;
      if (state !== null && state.playbackState !== 0) {
        await session.setPlayback(0, state.flags & 0x01 ? true : false);
        this.setData({ quickHint: "已停止方案，改为实时灯效" });
        wx.showToast({ title: "已停止方案，改为实时灯效", icon: "none" });
      }
      const ledCount = this.data.ledCount > 0 ? this.data.ledCount : this.session?.stripLedCount(stripId) ?? 0;
      const spec = buildQuickSpec(card, this.quickParamsOf(cardId), stripId, ledCount);
      /*
       * 协议要求同带光区不重叠（§9.2「调用方需先清段」），而快捷档的语义是
       * 「整组变成这一个效果」。所以先清掉这条灯组上除槽位 0 以外的光区，
       * 否则多光区的灯组会被设备回 InvalidParam——用户点了卡片却毫无变化。
       */
      const others = this.segmentReports.filter(
        (report) => report.stripId === stripId && report.segId !== 0,
      );
      for (const report of others) {
        const cleared = await session.clearSegment(stripId, report.segId);
        if (!cleared.ok) {
          throw new Error(resultText(cleared.resultCode));
        }
      }
      const ack = await session.setSegment(spec);
      if (!ack.ok) {
        throw new Error(resultText(ack.resultCode));
      }
      this.setData({ quickHint: `${card.name} 已生效` });
      /* 写成功后重新读回，段列表 / 摘要以设备为准。 */
      await this.refreshSegments();
      await this.refreshStripChips();
    } catch (err) {
      /* 失败：读回真实状态并说明原因（不保留假的成功画面）。 */
      const message = errorText(err);
      this.setData({ quickHint: `写入失败：${message}` });
      wx.showToast({ title: `写入失败：${message}`, icon: "none" });
      await this.refreshSegments();
    } finally {
      this.setData({ quickBusy: false });
    }
  },

  async rereadState() {
    try {
      const state = await this.session?.refreshState();
      if (state !== undefined) {
        this.applyDeviceState(state);
      }
    } catch {
      /* 读失败等下一次 State 同步纠正。 */
    }
  },
});

/** 灯效类型 → 用户看到的名称（四种灯效 + 空层）。 */
function modeNameOf(type: number): string {
  switch (layerModeOf(type)) {
    case "breathing":
      return "呼吸";
    case "rainbow":
      return "彩虹";
    case "comet":
      return "流光";
    case "off":
      return "关闭";
    default:
      return "静态";
  }
}

/**
 * 把一层灯效切到指定档位（保留颜色）。
 *
 * 复用 `effect-view.applyLayerType` 的规则：静态清零、呼吸只留波形位、
 * 彩虹/流光只留方向位、周期抬到类型下限之上。区别是这里返回**新对象**——
 * 草稿里的层不能被就地改（否则撤销 / 快照会一起变）。
 */
function applyModeToLayer(layer: EffectLayer, mode: LayerMode): EffectLayer {
  const option = MAIN_MODE_OPTIONS.find((item) => item.mode === mode);
  if (option === undefined) {
    return { ...layer };
  }
  /* 传副本进去：统一规则会就地改类型并重置参数，草稿里的层不能被就地改。 */
  return applyLayerType({ ...layer }, option.type);
}

/** 草稿 → 下发配置（时长非法时用 0，让校验给出具体原因）。 */
function draftToConfig(draft: ScriptDraft, stripCount: number): ScriptConfig {
  return draftToScriptConfig(draft, stripCount);
}
