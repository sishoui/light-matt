/**
 * 灯组详情页（二级页）：query `strip` 指明是哪一组（#64）。
 *
 * ## 本页的职责
 *
 * 用户从设备页的灯组卡片点进来，只想改**这一条灯组**长什么样。本票实现
 * 「简单档」：六张成品效果卡 + 色相 / 饱和度 / 亮度三个滑块，底部只有
 * 一个「应用并播放」。进阶编排（时间轴 / 光区分段）在 #65–#67，本页先给
 * 占位说明。
 *
 * ## 语义：整组覆盖
 *
 * 点一张卡 = 这一组整体变成该效果。协议要求同一条灯组的光区互不重叠，
 * 所以**写入前先读回并清掉槽位 0 以外的所有光区**（`clearSegment`），再
 * `setSegment(buildQuickSpec(...))`。漏掉这一步，多光区的灯组会被设备回
 * `InvalidParam`，用户点了卡片却毫无变化——这是票面点名的陷阱 #3。
 *
 * 写成功后重新 `queryStrip`，界面以设备读回值为准（`syncQuickFromDevice`）：
 * 只有「整组一个光区、从 0 覆盖到最后一颗、无叠加层」时才回填成某张卡。
 *
 * ## 亮度滑块的临时状态
 *
 * 逐光区亮度 `level` 是协议 v4 才有的字段，小程序编解码还没升到 v4（#69）。
 * 所以滑块与草稿照做，但**不下发**，也不映射到设备全局亮度（会串到别的组）；
 * 滑块下方标注「固件更新后可用」。
 */

import { errorText, resultText } from "../../utils/ble/errors";
import type { LinkDetail } from "../../utils/ble/transport";
import { ConnectCancelledError } from "../../utils/ble/transport";
import { createWxStorage, type SessionStorage } from "../../utils/control/device-cache";
import {
  addStepStage,
  advancedDraftOf,
  canAddStepStage,
  createAdvancedDrafts,
  moveStepStage,
  removeStepStage,
  seedStepFromReports,
  setStageDurationMs,
  stageDurationMs,
  stepZonesOf,
  timelineStepsOf,
  writeStepZones,
} from "../../utils/control/advanced-draft";
import {
  buildPickerCells,
  commitPicker,
  createPickerState,
  deletePickerZone,
  otherZones,
  PICKER_COLUMNS,
  pickerCheck,
  pickerRangeText,
  pickerTap,
  type LedPickerCell,
  type PickerState,
} from "../../utils/control/led-picker";
import {
  buildQuickCardViews,
  buildQuickSpec,
  quickCardOf,
  type QuickCardView,
  type QuickParams,
} from "../../utils/control/quick-effects";
import { queryInt } from "../../utils/control/routes";
import type { ControlSession } from "../../utils/control/session";
import { getSession, isMockSession } from "../../utils/control/session-singleton";
import { statusView } from "../../utils/control/status-view";
import {
  buildSimpleParams,
  clampLevel,
  cyclePlanSlot,
  hueFromDegrees,
  inferSimpleState,
  LEVEL_DEFAULT,
  planSlotLabel,
  planSlotSub,
  satFromPercent,
  type SimpleParamView,
} from "../../utils/control/strip-simple";
import { loadTheme, themeClass, type ThemeMode } from "../../utils/control/theme";
import {
  blockIndexAtRects,
  clampDuration,
  DEFAULT_STEP_MS,
  durationText,
  durationTicks,
  layoutBlocks,
  LONG_PRESS_MS,
  MAX_STEPS,
  selectionAfterMove,
  timelineRowWidth,
  type DurationTickView,
  type TimelineBlockView,
} from "../../utils/control/timeline";
import {
  axisColorMap,
  axisZonesOf,
  buildZoneAxis,
  canAddZoneAt,
  MAX_ZONES,
  selectedZoneAfter,
  zoneAxisSummary,
  type ZoneAxisBlock,
} from "../../utils/control/zone-axis";
import type { ScriptDraft } from "../../utils/control/script-view";
import { MAX_LEDS } from "../../utils/protocol/constants";
import type { DeviceState, LinkState, SegmentReport } from "../../utils/protocol/types";

/** 编辑档位：简单（点效果卡）/ 进阶（时间轴 + 光区）。 */
type StripMode = "simple" | "advanced";

/**
 * 触摸事件里的第一个触点。
 *
 * `touchend` 的 `touches` 已经空了，坐标在 `changedTouches` 里；两者都查一遍
 * 比在每个处理器里各写一次分支清楚。拿不到坐标返回 null（不是给 0）。
 */
function firstTouch(e: WechatMiniprogram.TouchEvent): { clientX: number; clientY: number } | null {
  const lists = [e.touches, e.changedTouches];
  for (const list of lists) {
    const touch = list?.[0];
    if (touch !== undefined && Number.isFinite(touch.clientX)) {
      return { clientX: touch.clientX, clientY: touch.clientY ?? 0 };
    }
  }
  return null;
}

Page({
  data: {
    themeClass: "",
    mock: false,

    /* ---- 连接 ---- */
    statusText: "未连接",
    statusSub: "正在连接…",
    statusAction: "取消",
    linkClass: "link-idle",
    ready: false,
    deviceName: "",
    subtitle: "",
    connectHint: "",
    connectBusy: false,

    /* ---- 顶部：灯组名 + 灯珠数 + 方案按钮 ---- */
    stripId: 0,
    title: "灯组",
    ledCount: 0,
    ledText: "连接后显示灯珠数",
    planSlot: 0,
    planLabel: "方案 ①",
    planSub: "读取中…",

    /* ---- 简单 / 进阶 ---- */
    mode: "simple" as StripMode,

    /* ---- 进阶档：时间轴 + 时长（#65） ---- */
    steps: [] as TimelineBlockView[],
    stepCount: 0,
    stepIndex: 0,
    stepCanAdd: false,
    timelineSummary: "",
    timelineRowStyle: "width: 100%;",
    timelineScrollable: false,
    stepDurationSeconds: 1,
    stepDurationText: "1 秒",
    durationTicks: [] as DurationTickView[],
    stepHint: "",

    /* ---- 进阶档：光区轴（#66） ---- */
    zoneBlocks: [] as ZoneAxisBlock[],
    zoneSummary: "",
    zoneCount: 0,
    zoneCanAdd: false,
    maxZones: MAX_ZONES,
    selectedSegId: -1,
    selectedZoneText: "",
    zoneHint: "",

    /* ---- 进阶档：灯珠弹窗（#66） ---- */
    pickerOpen: false,
    pickerCells: [] as LedPickerCell[],
    pickerColumns: PICKER_COLUMNS,
    pickerRangeText: "",
    pickerError: "",
    pickerCanConfirm: false,
    /** 新建还是改已有光区（按钮文案与「删除」的可用性）。 */
    pickerEditing: false,
    pickerTitle: "选一段灯珠",
    pickerLedText: "",

    /* ---- 简单档：六张成品卡 ---- */
    quickCards: [] as QuickCardView[],
    simpleParams: null as SimpleParamView | null,
    quickDisabledReason: "",
    quickBusy: false,
    quickHint: "",

    /* ---- 底部：应用并播放 ---- */
    applying: false,
    applyError: "",
  },

  session: null as ControlSession | null,
  storage: null as SessionStorage | null,
  unsubscribers: [] as Array<() => void>,
  themeMode: "system" as ThemeMode,
  /** 是否已经为这台设备发起过连接（避免 onShow 重复连接）。 */
  autoConnectTried: false,
  /** 设备权威的光区列表（当前灯组，最近一次 QueryStrip）。 */
  segmentReports: [] as SegmentReport[],
  /** 当前选中的效果卡；null = 设备上不是「整组一张卡」。 */
  quickCardId: null as string | null,
  /** 当前卡片的 HSV 草稿（协议值，不是滑块刻度）。 */
  quickParams: {} as QuickParams,
  /** 亮度草稿：本票只记录、不下发。 */
  levelDraft: LEVEL_DEFAULT,
  /** 参数松手后的防抖定时器（只发最后一次）。 */
  quickTimer: null as ReturnType<typeof setTimeout> | null,
  /** 防抖代次：旧一轮在 await 后静默退出。 */
  quickEpoch: 0,
  /** 有改动还没成功写进设备（写失败 / 拖动中）。 */
  dirty: false,
  /** 4 个方案槽位的步骤数；null = 还没读回来。 */
  planStepCounts: null as number[] | null,
  /** 方案摘要读取代次（并发读时旧一轮作废）。 */
  planEpoch: 0,

  /* ---- 进阶档：时间轴与光区的本地草稿（#65 / #66，不进设备） ---- */
  /** 4 个方案槽位各自的草稿（`ScriptDraft`：步骤 → 光区）；进阶档的唯一真相。 */
  drafts: [] as ScriptDraft[],
  /** 时间轴选中步骤的下标（0 起）。 */
  timelineIndex: 0,
  /** 时间轴容器（scroll-view）的宽度（px）；0 = 还没测量。 */
  timelineContainerWidth: 0,
  /** 时间轴行实际宽度（px）= max(容器宽, 块数 × 40 + 间隙)；拖动的坐标换算用它。 */
  timelineWidth: 0,
  /** 长按定时器：到时进入拖动状态。 */
  longPressTimer: null as ReturnType<typeof setTimeout> | null,
  /** 拖动中的源下标；-1 = 没有拖动。 */
  dragFrom: -1,
  /** 拖动落点下标；-1 = 没在拖。 */
  dragTo: -1,
  /** 拖动开始时量到的块屏幕矩形（按顺序）。 */
  blockRects: [] as Array<{ left: number; right: number }>,
  /** 时间轴容器左边缘（px，屏幕坐标），只用于诊断。 */
  timelineLeft: 0,
  /** 这次触摸已经变成了拖动：紧接着的 tap 不能改选中（时间戳自愈，不会永久吞掉点击）。 */
  dragTapUntil: 0,
  /** 已经做过测量的标记（不需要每次 setData 后重新测量）。 */
  timelineMeasured: false,
  /** 光区轴选中的槽位；-1 = 没选中。 */
  pickedSegId: -1,
  /** 灯珠弹窗的选择状态（纯数据，规则在 `led-picker`）。 */
  picker: { segId: null, anchor: null, cursor: null } as PickerState,

  onLoad(options: Record<string, string | undefined>) {
    /* 私有状态显式兜底：Page() 不保证对象字面量字段被复制到实例上，漏掉会让
     * onShow 的调用链抛错并中断整页事件绑定（见 AGENTS.md 的页面字段陷阱）。 */
    this.session = null;
    this.storage = null;
    this.unsubscribers = [];
    this.themeMode = "system";
    this.autoConnectTried = false;
    this.segmentReports = [];
    this.quickCardId = null;
    this.quickParams = {};
    this.levelDraft = LEVEL_DEFAULT;
    this.quickTimer = null;
    this.quickEpoch = 0;
    this.dirty = false;
    this.planStepCounts = null;
    this.planEpoch = 0;
    this.drafts = createAdvancedDrafts();
    this.timelineIndex = 0;
    this.timelineContainerWidth = 0;
    this.timelineWidth = 0;
    this.longPressTimer = null;
    this.dragFrom = -1;
    this.dragTo = -1;
    this.blockRects = [];
    this.timelineLeft = 0;
    this.dragTapUntil = 0;
    this.timelineMeasured = false;
    this.pickedSegId = -1;
    this.picker = createPickerState(null);

    const storage = createWxStorage();
    this.storage = storage;
    this.themeMode = loadTheme(storage);
    this.session = getSession();

    const stripId = queryInt(options, "strip", 0);
    this.setData({
      themeClass: themeClass(this.themeMode),
      mock: isMockSession(),
      stripId,
      title: `灯组 ${stripId + 1}`,
      planLabel: planSlotLabel(0),
      quickCards: buildQuickCardViews(null),
      durationTicks: durationTicks(),
    });
    this.renderTimeline();
  },

  onShow() {
    const expected = themeClass(loadTheme(createWxStorage()));
    if (this.data.themeClass !== expected) {
      this.setData({ themeClass: expected });
    }
    this.subscribe();
    this.syncFromSession();
    void this.session?.onShow();
    void this.ensureConnected();
  },

  onHide() {
    this.unsubscribe();
    /* 防抖定时器不属于界面：页面隐藏后它还会跑一次，可能对已断开的设备白发一帧。 */
    this.clearQuickTimer();
    this.clearLongPress();
  },

  onUnload() {
    /* 二级页会被真正卸载；会话属于 App，绝不 destroy。 */
    this.unsubscribe();
    this.clearQuickTimer();
    this.clearLongPress();
    this.session = null;
    this.storage = null;
  },

  subscribe() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.unsubscribe();
    this.unsubscribers = [
      session.onLink((state, detail) => this.applyLink(state, detail)),
      session.onState((state) => this.applyDeviceState(state)),
      /* 固件版本 / 硬件号由会话在 ready 后异步补齐：到位后补一次标题。 */
      session.onDeviceConfig(() => this.applyDeviceName()),
    ];
  },

  unsubscribe() {
    for (const off of this.unsubscribers ?? []) {
      off();
    }
    this.unsubscribers = [];
  },

  // ---------------- 连接 ----------------

  /** 目标设备：本机缓存的最后连接（本页只从设备页进来，没有额外的 key）。 */
  resolveTarget(): { deviceId: string; name: string } | null {
    const session = this.session;
    const cached = session?.cachedDevice ?? null;
    if (cached !== null) {
      return { deviceId: cached.deviceId, name: cached.name ?? "" };
    }
    const deviceId = session?.transport.currentDeviceId ?? "";
    return deviceId.length > 0 ? { deviceId, name: "" } : null;
  },

  /** 进入页面时确保连着设备（与设备页同一套语义，只自动尝试一次）。 */
  async ensureConnected() {
    const session = this.session;
    if (session === null || this.autoConnectTried) {
      return;
    }
    const target = this.resolveTarget();
    if (target === null) {
      this.setData({ connectHint: "这台设备还没有连接记录，请先到「发现」页连上它" });
      return;
    }
    this.autoConnectTried = true;
    if (
      session.linkState === "ready" &&
      session.transport.currentDeviceId === target.deviceId
    ) {
      return;
    }
    if (
      session.linkState === "connecting" ||
      session.linkState === "initializing" ||
      session.linkState === "scanning"
    ) {
      return;
    }
    this.setData({ connectBusy: true, connectHint: "" });
    try {
      if (session.linkState === "ready") {
        await session.switchTo(target.deviceId, target.name);
      } else {
        await session.connect(target.deviceId, target.name);
      }
      this.applyDeviceName();
    } catch (err) {
      if (err instanceof ConnectCancelledError) {
        return;
      }
      this.setData({ connectHint: `连接失败：${errorText(err)}` });
    } finally {
      this.setData({ connectBusy: false });
    }
  },

  /** 提示条 / 状态条上的重连（已连接时什么都不做）。 */
  async onRetryConnect() {
    if (this.data.ready) {
      return;
    }
    this.autoConnectTried = false;
    this.setData({ connectHint: "" });
    await this.ensureConnected();
  },

  // ---------------- 状态与派生 ----------------

  /** 进页面时把会话已有状态铺到界面（切页回来不闪空态）。 */
  syncFromSession() {
    const session = this.session;
    if (session === null) {
      return;
    }
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
    /* 已连接时状态条不写「点击查看设备」——本页没有设备页可跳，那会是一条死提示。 */
    this.setData({
      ...view,
      ...(ready ? { statusSub: "灯效以灯控为准", statusAction: "" } : {}),
      ready,
    });
    if (!ready) {
      this.clearStripViews();
      if (state === "idle" && !this.autoConnectTried) {
        void this.ensureConnected();
      }
      return;
    }
    this.applyDeviceName();
    const current = session?.deviceState;
    if (current !== null && current !== undefined) {
      this.applyDeviceState(current);
    }
    /* ready 是状态跳变（不是 20Hz 事件）：这里补一次完整派生，把
     * `clearStripViews` 留下的「未连接」原因换成真实可用性。 */
    this.renderQuick();
    /* 光区与方案摘要都不在 State 里、设备也不会主动上报：进页面各读一次。 */
    void this.refreshSegments();
    void this.refreshPlanSlots();
  },

  /** 设备权威的 State → 灯珠数 / 标题 / 参数区可用性。 */
  applyDeviceState(state: DeviceState) {
    const ledCount = state.stripCounts[this.data.stripId] ?? 0;
    const changed = ledCount !== this.data.ledCount;
    if (changed) {
      this.setData({
        ledCount,
        ledText: ledCount > 0 ? `${ledCount} 颗灯珠` : "还没读到灯珠数量",
      });
    }
    this.applyDeviceName();
    /* State 事件是 20Hz 的（拖全局亮度时每帧都来）：只有灯珠数变化才重算
     * 卡片 / 参数区，否则每帧重建数组会让本页滑块拖动发卡。 */
    if (changed) {
      this.renderQuick();
      /* 缩略色带按灯珠数换算比例：灯珠数变了要重画时间轴。 */
      if (this.data.mode === "advanced") {
        this.renderTimeline();
      }
    }
  },

  /** 标题副行：设备名（本机缓存的名字优先）。 */
  applyDeviceName() {
    const session = this.session;
    const info = session?.deviceInfo ?? null;
    const name =
      session?.cachedDevice?.name ??
      (info !== null && info.hwId.length > 0 ? `Lumen-${info.hwId.slice(-4)}` : "");
    if (name !== this.data.deviceName) {
      this.setData({ deviceName: name, subtitle: name });
    }
  },

  /** 当前灯组的灯珠数（设备权威）：一律取 `stripCounts[stripId]`。 */
  stripLedCount(): number {
    const state = this.session?.deviceState;
    if (state === null || state === undefined) {
      return 0;
    }
    return state.stripCounts[this.data.stripId] ?? 0;
  },

  /** 未连接 / 灯珠数未知时不能动手。 */
  disabledReason(): string {
    if (!this.data.ready) {
      return "连接灯控后才能调灯效";
    }
    if (this.stripLedCount() < 1) {
      return "还没读到这组的灯珠数量，稍等片刻";
    }
    return "";
  },

  /** 断开 / 切设备时清空本页派生态（不编造上一次的画面）。 */
  clearStripViews() {
    this.segmentReports = [];
    this.quickCardId = null;
    this.quickParams = {};
    this.dirty = false;
    this.planStepCounts = null;
    /* 进阶草稿属于「这台设备的这条灯组」：断开后一律作废，免得下次连上另一台
     * 设备时把上一台的编排当成它的。 */
    this.drafts = createAdvancedDrafts();
    this.timelineIndex = 0;
    this.pickedSegId = -1;
    this.setData({
      ledCount: 0,
      ledText: "连接后显示灯珠数",
      planSub: "读取中…",
      quickCards: buildQuickCardViews(null),
      simpleParams: null,
      quickDisabledReason: this.disabledReason(),
      quickHint: "",
      applyError: "",
      zoneBlocks: [],
      zoneCount: 0,
      zoneSummary: "还没有光区",
      zoneCanAdd: false,
      selectedSegId: -1,
      zoneHint: "",
      pickerOpen: false,
      pickerCells: [],
    });
  },

  // ---------------- 档位切换 ----------------

  /** 「简单 / 进阶」分段控件：整体替换内容区，状态留在内存里不丢。 */
  onModeTap(e: WechatMiniprogram.TouchEvent) {
    const mode = String(e.currentTarget.dataset.mode ?? "");
    if (mode !== "simple" && mode !== "advanced") {
      return;
    }
    if (mode === this.data.mode) {
      return;
    }
    this.setData({ mode });
    if (mode === "simple") {
      /* 切回来时用内存里的卡片 / 参数重画一次（进阶档可能改过设备）。 */
      this.renderQuick({ quickHint: "" });
      return;
    }
    /* 第一次进进阶档：把灯控现在的光区填进当前步骤，用户从「现在的样子」改，
     * 而不是面对一条空白。已有草稿的步骤不会被覆盖。 */
    this.seedAdvancedFromDevice();
    /* 进进阶档才渲染时间轴：块的宽度依赖真实行宽，行不在 DOM 里就量不到。 */
    this.renderTimeline();
    this.measureTimeline(true);
  },

  /** 把设备读回的当前灯组光区填进当前步骤（只填空步骤，不覆盖草稿）。 */
  seedAdvancedFromDevice(): void {
    const reports = this.segmentReports;
    if (reports.length === 0) {
      return;
    }
    const draft = this.currentDraft();
    const next = seedStepFromReports(draft, this.timelineIndex, this.data.stripId, reports);
    if (next !== draft) {
      this.setDraft(next);
    }
  },

  // ---------------- 进阶档：时间轴（#65） ----------------

  /**
   * 重画进阶档（唯一派生入口）：时间轴 + 光区轴一起算。
   *
   * 两条轴必须来自**同一份草稿**：分开各自派生迟早会出现「轴上三段、块里
   * 两条色带」。所以只有这一个入口，任何一步改动都走它。
   *
   * 只调纯函数 + 一次 `setData`：拖时长条时块宽跟着变，但页面结构不动，
   * 所以拖动是连续的。
   */
  renderTimeline(patch: Record<string, unknown> = {}, callback?: () => void): void {
    const ledCount = this.stripLedCount();
    const stripId = this.data.stripId;
    const draft = this.currentDraft();
    const timelineSteps = timelineStepsOf(draft, stripId);
    /* 容器宽度没量到之前不能算像素（会把首帧算成 88px），退回时长权重 +
     * CSS 最小宽度；量到之后按「容器宽 / 保底下限 / 比例下限」三者取大分配。 */
    const measured = this.timelineContainerWidth > 0;
    const durations = timelineSteps.map((step) => clampDuration(step.durationMs));
    const rowWidth = timelineRowWidth(durations, this.timelineContainerWidth);
    this.timelineWidth = rowWidth;
    const blocks = layoutBlocks(timelineSteps, {
      widthPx: measured ? rowWidth : 0,
      selected: this.timelineIndex,
      dragIndex: this.dragFrom >= 0 ? this.dragFrom : -1,
      dropIndex: this.dragFrom >= 0 ? this.dragTo : -1,
      ledCount,
    });
    const durationMs = this.currentDurationMs();
    const totalMs = durations.reduce((sum, ms) => sum + ms, 0);
    /* 拖动期间关掉横向滚动：否则手指一横移，滚动容器先动、块纹丝不动，
     * 长按拖动就永远读不出落点。松手后恢复。 */
    const scrollable =
      measured && rowWidth > this.timelineContainerWidth && this.dragFrom < 0;
    const zones = stepZonesOf(draft, this.timelineIndex, stripId);
    const axisZones = axisZonesOf(zones);
    const selected = selectedZoneAfter(axisZones, this.pickedSegId);
    this.pickedSegId = selected;
    const selectedInput = axisZones.find((zone) => zone.segId === selected);
    this.setData({
      steps: blocks,
      stepCount: timelineSteps.length,
      stepIndex: this.timelineIndex,
      stepCanAdd: canAddStepStage(draft),
      timelineRowStyle: measured ? `width: ${rowWidth}px;` : "width: 100%;",
      timelineScrollable: scrollable,
      timelineSummary:
        timelineSteps.length === 0
          ? "还没有步骤"
          : `${timelineSteps.length} 个步骤 · 共 ${durationText(totalMs)}`,
      stepDurationSeconds: durationMs / 1000,
      stepDurationText: durationText(durationMs),
      zoneSummary: zoneAxisSummary(axisZones, ledCount),
      zoneCount: axisZones.length,
      zoneCanAdd: canAddZoneAt(axisZones),
      selectedSegId: selected,
      selectedZoneText:
        selectedInput === undefined
          ? axisZones.length === 0
            ? "点「+ 新增」划出第一个光区"
            : "点一块选中它，再点一次改范围"
          : `光区 ${selectedInput.segId + 1} · 第 ${selectedInput.start + 1}–${selectedInput.end + 1} 颗`,
      zoneBlocks: buildZoneAxis({ zones: axisZones, ledCount, selectedSegId: selected }),
      ...patch,
    }, callback);
  },

  /** 当前方案槽位的草稿（进阶档的唯一真相）。 */
  currentDraft(): ScriptDraft {
    if (this.drafts.length === 0) {
      this.drafts = createAdvancedDrafts();
    }
    return advancedDraftOf(this.drafts, this.data.planSlot);
  },

  /** 写回当前槽位的草稿；新对象才替换（引用相等 = 什么都没变）。 */
  setDraft(next: ScriptDraft): void {
    if (next === this.currentDraft()) {
      return;
    }
    const slot = this.data.planSlot;
    this.drafts = this.drafts.map((draft, index) => (index === slot ? next : draft));
  },

  /** 当前步骤里当前灯组的光区。 */
  currentZones() {
    return stepZonesOf(this.currentDraft(), this.timelineIndex, this.data.stripId);
  },

  /** 当前步骤的时长（毫秒，已钳位）。 */
  currentDurationMs(): number {
    const stage = this.currentDraft().stages[this.timelineIndex];
    return stage === undefined ? clampDuration(DEFAULT_STEP_MS) : stageDurationMs(stage);
  },

  /** 当前灯组的灯珠数（门禁：没读到就不能划光区）。 */
  currentLedCount(): number {
    return Math.min(this.stripLedCount(), MAX_LEDS);
  },

  /**
   * 量时间轴滚动容器的真实宽度。
   *
   * 块的宽度按「行宽 - 间隙」分配，容器宽度只能问渲染层。量到之后立刻重算
   * 一次，动画才会从「时长比例」平滑过渡到「像素」。
   */
  measureTimeline(force = false): void {
    if (this.timelineMeasured && !force) {
      return;
    }
    wx.createSelectorQuery()
      .select(".timeline-scroll")
      .boundingClientRect((rect) => {
        /* 容器不在 DOM 里（还在简单档）时回调给 null：保持未测量状态。 */
        if (!rect) {
          this.timelineMeasured = false;
          return;
        }
        const box = rect as WechatMiniprogram.BoundingClientRectCallbackResult;
        this.timelineMeasured = true;
        this.timelineLeft = box.left;
        const width = Math.round(box.width);
        if (!Number.isFinite(width) || width <= 0) {
          return;
        }
        if (width === this.timelineContainerWidth) {
          this.renderTimeline();
          return;
        }
        this.timelineContainerWidth = width;
        this.renderTimeline();
      })
      .exec();
  },

  /** 点时间轴的块：选中它，下方的时长与光区跟着切换。 */
  onStepTap(e: WechatMiniprogram.TouchEvent) {
    /* 拖动刚松手：这一次点击是同一次触摸的尾巴，不能改选中。
     * 用时间戳而不是布尔量——卡在 true 会让整条时间轴从此点不动。 */
    if (Date.now() < this.dragTapUntil) {
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= this.currentDraft().stages.length) {
      return;
    }
    if (index === this.timelineIndex) {
      return;
    }
    this.timelineIndex = index;
    /* 换步骤后原来选中的光区可能不存在了：让 `selectedZoneAfter` 重新挑一个。 */
    this.renderTimeline({ stepHint: "" });
  },

  /**
   * 手指按下：起长按定时器。
   *
   * 定时器到点才进入拖动状态——直接按下变拖动会与横向滚动打架，用户也没法
   * 「先看一眼再点」。380 毫秒是票面的约数。
   *
   * 进入拖动时顺手量一次所有块的屏幕位置：落点换算用这些真实矩形，而不是
   * 「容器左边缘 + 滚动量」的推算——行比容器宽时后者会因为惯性滚动和 1px
   * 取整而错位，用户会觉得「拖到右边那个块上却换了别的」。
   */
  onStepTouchStart(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= this.currentDraft().stages.length) {
      return;
    }
    this.clearLongPress();
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      this.dragFrom = index;
      this.dragTo = index;
      this.timelineIndex = index;
      this.renderTimeline({ stepHint: "拖到目标位置松手" }, () => this.measureBlockRects());
    }, LONG_PRESS_MS);
  },

  /** 量所有时间轴块的屏幕矩形（拖动落点换算的基准）。 */
  measureBlockRects(): void {
    wx.createSelectorQuery()
      .selectAll(".timeline-block")
      .boundingClientRect((rects) => {
        const list = Array.isArray(rects) ? rects : rects ? [rects] : [];
        this.blockRects = list.map((rect) => {
          const box = rect as WechatMiniprogram.BoundingClientRectCallbackResult;
          return { left: box.left, right: box.right };
        });
      })
      .exec();
  },

  /** 拖动中：把指尖坐标命中到某个块（只是预览，顺序还没改）。 */
  onStepTouchMove(e: WechatMiniprogram.TouchEvent) {
    if (this.dragFrom < 0) {
      return;
    }
    const touch = firstTouch(e);
    if (touch === null) {
      return;
    }
    /* 用拖动开始时量到的块屏幕矩形做命中：行比容器宽（八个步骤）时也准，
     * 不受横向滚动与 1px 取整影响。 */
    const target = blockIndexAtRects(this.blockRects, touch.clientX);
    if (target < 0 || target === this.dragTo) {
      return;
    }
    this.dragTo = target;
    this.renderTimeline();
  },

  /** 拖动落点命中：指尖坐标 → 块下标（行比容器宽时也准，屏幕坐标直比）。 */
  dropIndexAt(clientX: number): number {
    return blockIndexAtRects(this.blockRects, clientX);
  },

  onStepTouchEnd() {
    this.clearLongPress();
    const from = this.dragFrom;
    const to = this.dragTo;
    /* 定时器没到点就没有进入拖动：这次触摸只是「按住了一下」，不改顺序。
     * 拖过（无论有没有真的换位置）都要让随后的 tap 闭嘴。 */
    const dragged = from >= 0;
    this.dragFrom = -1;
    this.dragTo = -1;
    if (!dragged) {
      return;
    }
    this.dragTapUntil = Date.now() + 300;
    if (to < 0 || from === to) {
      this.renderTimeline({ stepHint: "" });
      return;
    }
    const draft = this.currentDraft();
    const moved = moveStepStage(draft, from, to);
    /* `moveStepStage` 对越界 / 自身返回同一个对象：引用没变就是没挪动。 */
    if (moved === draft) {
      this.renderTimeline({ stepHint: "" });
      return;
    }
    const selected = selectionAfterMove(this.timelineIndex, from, to);
    this.setDraft(moved);
    this.timelineIndex = selected;
    this.renderTimeline({
      stepHint: `已把第 ${from + 1} 个步骤挪到第 ${to + 1} 位`,
    });
  },

  onStepTouchCancel() {
    this.clearLongPress();
    if (this.dragFrom >= 0) {
      this.dragTapUntil = Date.now() + 300;
    }
    this.dragFrom = -1;
    this.dragTo = -1;
    this.renderTimeline();
  },

  clearLongPress() {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  },

  /** 「+ 加步骤」：新增一个默认时长的空步骤并选中它；8 个步骤后不可用。 */
  onStepAdd() {
    const draft = this.currentDraft();
    if (!canAddStepStage(draft)) {
      this.renderTimeline({ stepHint: `最多 ${MAX_STEPS} 个步骤` });
      return;
    }
    const next = addStepStage(draft);
    this.setDraft(next);
    this.timelineIndex = next.stages.length - 1;
    this.pickedSegId = -1;
    this.renderTimeline({ stepHint: "" });
  },

  /** 删掉当前步骤（至少留一个）。 */
  onStepRemove() {
    const draft = this.currentDraft();
    const next = removeStepStage(draft, this.timelineIndex);
    if (next === draft) {
      this.renderTimeline({ stepHint: "至少要留一个步骤" });
      return;
    }
    this.setDraft(next);
    this.timelineIndex = Math.max(0, Math.min(next.stages.length - 1, this.timelineIndex));
    this.pickedSegId = -1;
    this.renderTimeline({ stepHint: "" });
  },
  /** 拖时长条：块宽实时跟着变（拖动中也走 `renderTimeline`，只是不写设备）。 */
  onDurationChanging(e: WechatMiniprogram.SliderChanging) {
    this.applyDuration(Number(e.detail.value));
  },

  onDurationChange(e: WechatMiniprogram.SliderChange) {
    this.applyDuration(Number(e.detail.value));
  },

  /**
   * 时长条的值（秒）→ 当前步骤的时长。
   *
   * 滑块步进 0.5 秒，但真机上仍可能给出 0.4999 之类的值：`setStageDurationMs`
   * 会再钳一次，所以这里只管传。
   */
  applyDuration(seconds: number) {
    const draft = this.currentDraft();
    if (draft.stages.length === 0 || !Number.isFinite(seconds)) {
      return;
    }
    const next = setStageDurationMs(draft, this.timelineIndex, seconds * 1000);
    if (next === draft) {
      return;
    }
    this.setDraft(next);
    this.renderTimeline();
  },

  /** 点时长条的刻度（0.5 / 15 / 30 秒），直接把当前步骤设到那一档。 */
  onDurationTickTap(e: WechatMiniprogram.TouchEvent) {
    const ms = Number(e.currentTarget.dataset.ms);
    if (!Number.isFinite(ms)) {
      return;
    }
    this.applyDuration(ms / 1000);
  },

  // ---------------- 进阶档：光区轴（#66） ----------------

  /**
   * 点光区轴上的一块。
   *
   * 第一次点只**选中**它（选中态是 2px 描边）；再点已选中的那一块才打开
   * 弹窗改范围。分成两步是因为窄光区（30 颗时可能只有 20px）一次点击既要
   * 选中又要开弹窗，用户就永远看不到「选中」这件事。灰条（没被覆盖的
   * 部分）点不动。
   */
  onZoneAxisTap(e: WechatMiniprogram.TouchEvent) {
    const segId = Number(e.currentTarget.dataset.segId);
    if (!Number.isInteger(segId) || segId < 0) {
      return;
    }
    if (segId === this.pickedSegId) {
      this.openPicker(segId);
      return;
    }
    this.pickedSegId = segId;
    this.renderTimeline({ zoneHint: "" });
  },

  /** 长按光区块：直接打开弹窗改它的范围（跳过一次「再点一下」）。 */
  onZoneAxisLongPress(e: WechatMiniprogram.TouchEvent) {
    const segId = Number(e.currentTarget.dataset.segId);
    if (!Number.isInteger(segId) || segId < 0) {
      return;
    }
    this.pickedSegId = segId;
    this.openPicker(segId);
  },

  /** 「+ 新增」：打开灯珠弹窗，从空白开始选。8 个光区后不可用。 */
  onZoneAdd() {
    const reason = this.disabledReason();
    if (reason !== "") {
      this.renderTimeline({ zoneHint: reason });
      return;
    }
    if (!canAddZoneAt(axisZonesOf(this.currentZones()))) {
      this.renderTimeline({ zoneHint: `每组最多 ${MAX_ZONES} 个光区，请先删掉一个` });
      return;
    }
    this.openPicker(null);
  },

  /** 「改范围」：对当前选中的光区打开弹窗；没选中时给提示。 */
  onZoneEditSelected() {
    if (this.pickedSegId < 0) {
      this.renderTimeline({ zoneHint: "先点一块光区" });
      return;
    }
    this.openPicker(this.pickedSegId);
  },

  /** 打开灯珠弹窗（`segId === null` = 新建）。 */
  openPicker(segId: number | null) {
    const ledCount = this.currentLedCount();
    if (ledCount < 1) {
      this.renderTimeline({ zoneHint: "还没读到这组的灯珠数量，稍等片刻" });
      return;
    }
    const zones = this.currentZones();
    const existing =
      segId === null
        ? null
        : zones.find((zone) => zone.segId === segId) ?? null;
    if (segId !== null && existing === null) {
      this.renderTimeline({ zoneHint: "这个光区不在了，请重新选" });
      return;
    }
    this.picker = createPickerState(
      segId,
      existing === null ? null : { start: existing.start, end: existing.end },
    );
    this.renderPicker({ pickerError: "", pickerOpen: true });
  },

  /** 重画弹窗（唯一派生入口：格子、区间文字、能否确定、标题）。 */
  renderPicker(patch: Record<string, unknown> = {}): void {
    const ledCount = this.currentLedCount();
    const zones = this.currentZones();
    const others = otherZones(zones, this.picker.segId);
    const colors = axisColorMap(zones);
    const check = pickerCheck(this.picker, {
      ledCount,
      others,
      zoneCount: zones.length,
    });
    /* 冲突在弹窗里**当场**显示：用户划到别人的格子上时立刻看到原因，
     * 而不是按了确定才被拒。`patch` 放在后面，提交失败的专门文案可以覆盖它。 */
    this.setData({
      pickerOpen: true,
      pickerCells: buildPickerCells(this.picker, { ledCount, others, colors }),
      pickerColumns: PICKER_COLUMNS,
      pickerRangeText: pickerRangeText(this.picker),
      pickerError: check.ok ? "" : check.message,
      pickerCanConfirm: check.ok,
      pickerEditing: this.picker.segId !== null,
      pickerTitle: this.picker.segId === null ? "新增光区" : "改光区范围",
      pickerLedText: `这组一共 ${ledCount} 颗灯珠`,
      ...patch,
    });
  },

  /** 点弹窗里的一颗灯珠（第一次设锚点、第二次定区间、同一颗两次取消）。 */
  onPickerCellTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const ledCount = this.currentLedCount();
    const others = otherZones(this.currentZones(), this.picker.segId);
    const outcome = pickerTap(this.picker, index, { ledCount, others });
    /* 属于其它光区的格子「点不动」：状态一点不变（灰底与小色点已经说明归属）。 */
    if (outcome.disabled) {
      return;
    }
    this.picker = outcome.state;
    /* 不传 pickerError：由 `renderPicker` 按新状态重新判定（跨过别人的格子
     * 时立刻报重叠，取消后错误自动消失）。 */
    this.renderPicker();
  },

  /** 确定：把区间写进「当前步骤 × 当前灯组」，只替换这一片。 */
  onPickerConfirm() {
    const ledCount = this.currentLedCount();
    const zones = this.currentZones();
    const result = commitPicker(this.picker, zones, this.data.stripId, ledCount);
    if (result.error !== "") {
      /* 失败：弹窗保留、不落草稿（票面硬要求），错误就地显示。 */
      this.renderPicker({ pickerError: result.error });
      return;
    }
    if (!result.changed) {
      this.closePicker({ zoneHint: "范围没变" });
      return;
    }
    const before = new Set(zones.map((zone) => zone.segId));
    const added = this.picker.segId === null;
    this.applyStepZones(result.zones);
    this.pickedSegId = this.lastSegIdOf(result.zones, this.picker.segId, before);
    this.closePicker({
      zoneHint: added ? "已新增一个光区" : "范围已更新",
    });
  },

  /** 删除：只对已有光区可用（新建状态下按钮隐藏）。 */
  onPickerDelete() {
    const segId = this.picker.segId;
    if (segId === null) {
      return;
    }
    const zones = this.currentZones();
    const next = deletePickerZone(zones, segId);
    if (next === zones) {
      this.closePicker({ zoneHint: "这个光区已经不在了" });
      return;
    }
    this.applyStepZones(next);
    this.pickedSegId = -1;
    this.closePicker({ zoneHint: "已删掉这个光区" });
  },

  /** 把光区列表写进「当前步骤 × 当前灯组」（多灯组语义只在这一处落地）。 */
  applyStepZones(zones: Parameters<typeof writeStepZones>[3]): void {
    const draft = this.currentDraft();
    this.setDraft(writeStepZones(draft, this.timelineIndex, this.data.stripId, zones));
  },

  /** 取消：什么都不改。 */
  onPickerCancel() {
    this.closePicker({});
  },

  /** 点遮罩：等同取消（不会误删正在划的选择——选择本来就只存在弹窗里）。 */
  onPickerMaskTap() {
    this.closePicker({});
  },

  /** 弹窗自身的点击：吃掉，别冒泡到遮罩上变成取消。 */
  onPickerStopPropagation() {
    /* 空实现就是它的全部职责（`catchtap` 已经阻止冒泡）。 */
  },

  /** 关掉弹窗并重画两条轴。 */
  closePicker(patch: Record<string, unknown> = {}): void {
    this.picker = createPickerState(null);
    this.setData({ pickerOpen: false, pickerError: "", pickerCells: [] });
    this.renderTimeline(patch);
  },

  /**
   * 提交后的选中的槽位：新建取「这次加进去的那一个」，修改保持原槽位。
   *
   * `addZone` 占的是最小空闲槽位，所以要在新旧集合的差里找；找不到就退回
   * 原值（页面不会崩，只是没选中）。`before` 由调用方在写入前取好——写入
   * 之后 `currentZones()` 已经是新的了。
   */
  lastSegIdOf(
    next: readonly { segId: number }[],
    previous: number | null,
    before: ReadonlySet<number>,
  ): number {
    if (previous !== null && next.some((zone) => zone.segId === previous)) {
      return previous;
    }
    const fresh = next.find((zone) => !before.has(zone.segId));
    return fresh === undefined ? previous ?? -1 : fresh.segId;
  },

  // ---------------- 方案槽位 ----------------

  /** 顶部「方案 ①」按钮：点一下轮换到下一个槽位。 */
  onPlanSlotTap() {
    const next = cyclePlanSlot(this.data.planSlot);
    this.setData({
      planSlot: next,
      planLabel: planSlotLabel(next),
      planSub: this.planSubOf(next),
    });
    /* 换方案 = 换一份草稿：步骤下标与光区选中都要重新落到合法值。 */
    this.timelineIndex = 0;
    this.pickedSegId = -1;
    if (this.data.mode === "advanced") {
      this.renderTimeline();
    }
  },

  planSubOf(slot: number): string {
    if (this.planStepCounts === null) {
      return "读取中…";
    }
    return planSlotSub(this.planStepCounts[slot] ?? 0);
  },

  /** 读回 4 个槽位的步骤数（QueryScript 只回摘要，内容无法读回）。 */
  async refreshPlanSlots(): Promise<void> {
    const session = this.session;
    if (session === null || !this.data.ready) {
      return;
    }
    this.planEpoch += 1;
    const epoch = this.planEpoch;
    const result = await session.queryScriptSummaries();
    if (epoch !== this.planEpoch) {
      return;
    }
    if (result.kind === "ok") {
      const counts = [0, 0, 0, 0];
      for (const summary of result.summaries) {
        if (summary.scriptId >= 0 && summary.scriptId < counts.length) {
          counts[summary.scriptId] = Math.max(0, summary.stageCount);
        }
      }
      this.planStepCounts = counts;
    } else {
      this.planStepCounts = null;
    }
    this.setData({ planSub: this.planSubOf(this.data.planSlot) });
  },

  // ---------------- 简单档：读取与派生 ----------------

  /** 从设备读回当前灯组的光区（设备权威；进页面与写后各读一次）。 */
  async refreshSegments(): Promise<void> {
    const session = this.session;
    const stripId = this.data.stripId;
    if (session === null || !this.data.ready) {
      return;
    }
    const result = await session.queryStrip(stripId);
    if (result.kind !== "ok") {
      if (result.kind === "error") {
        this.setData({ quickHint: result.message });
      }
      return;
    }
    this.segmentReports = result.reports.filter((report) => report.stripId === stripId);
    this.syncQuickFromDevice();
  },

  /** 重画卡片 + 参数区（唯一派生入口）。 */
  renderQuick(patch: Record<string, unknown> = {}): void {
    this.setData({
      quickCards: buildQuickCardViews(this.quickCardId, this.quickParams),
      simpleParams: buildSimpleParams(this.quickCardId, this.quickParams, this.levelDraft),
      quickDisabledReason: this.disabledReason(),
      ...patch,
    });
  },

  /**
   * 从设备读回值推断「现在是哪张卡」。
   *
   * 只有整组一个光区、覆盖到最后一颗、无叠加层时才回填；否则清掉选中态，
   * 免得界面一直高亮一个设备上早就不存在的效果。
   */
  syncQuickFromDevice() {
    const inferred = inferSimpleState(this.segmentReports, this.stripLedCount());
    if (inferred === null) {
      this.quickCardId = null;
      this.quickParams = {};
    } else {
      this.quickCardId = inferred.cardId;
      /* 只回填颜色（hue / sat 是精确的协议值）；其它档位设备上无法唯一反推。 */
      this.quickParams = { hue: inferred.hue, sat: inferred.sat };
    }
    this.renderQuick();
  },

  // ---------------- 简单档：交互 ----------------

  /** 点一张效果卡：这一组整体变成该效果（立刻写入设备）。 */
  onQuickCardTap(e: WechatMiniprogram.TouchEvent) {
    const cardId = String(e.currentTarget.dataset.cardId ?? "");
    const card = quickCardOf(cardId);
    if (card === null || this.disabledReason() !== "" || this.data.quickBusy) {
      return;
    }
    this.quickCardId = card.id;
    /* 换卡时参数回到该卡默认值（把呼吸的最暗档带进流光没有意义）。 */
    this.quickParams = {};
    this.dirty = true;
    this.renderQuick({ quickHint: "" });
    this.scheduleQuickWrite(true);
  },

  onParamChanging(e: WechatMiniprogram.SliderChanging) {
    this.applyParam(this.paramKeyOf(e), Number(e.detail.value), false);
  },

  onParamChange(e: WechatMiniprogram.SliderChange) {
    this.applyParam(this.paramKeyOf(e), Number(e.detail.value), true);
  },

  /** 滑块自己的 key（hue / sat / level）：一个处理器服务三个滑块。 */
  paramKeyOf(e: WechatMiniprogram.SliderChange | WechatMiniprogram.SliderChanging): string {
    return String((e.currentTarget.dataset as { key?: string } | undefined)?.key ?? "");
  },

  /**
   * 应用一个参数。
   *
   * 拖动中只改本地草稿（逐帧写设备会连发几十帧）；松手（`commit`）才写。
   * 亮度只记录草稿：`level` 是协议 v4 字段，本票不下发。
   */
  applyParam(key: string, value: number, commit: boolean) {
    if (this.quickCardId === null || this.disabledReason() !== "" || !Number.isFinite(value)) {
      return;
    }
    if (key === "hue") {
      this.quickParams = { ...this.quickParams, hue: hueFromDegrees(value) };
    } else if (key === "sat") {
      this.quickParams = { ...this.quickParams, sat: satFromPercent(value) };
    } else if (key === "level") {
      this.levelDraft = clampLevel(value);
      this.renderQuick();
      if (commit) {
        this.setData({ quickHint: "亮度已记下，固件更新后才会生效" });
      }
      return;
    } else {
      return;
    }
    this.dirty = true;
    this.renderQuick();
    if (commit) {
      this.scheduleQuickWrite(true);
    }
  },

  clearQuickTimer() {
    if (this.quickTimer !== null) {
      clearTimeout(this.quickTimer);
      this.quickTimer = null;
    }
  },

  /** 防抖写：松手 / 点卡这类离散动作立刻写，拖动期间只发最后一次。 */
  scheduleQuickWrite(immediate: boolean) {
    this.quickEpoch += 1;
    const epoch = this.quickEpoch;
    this.clearQuickTimer();
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
    this.quickTimer = setTimeout(fire, 250);
  },

  /**
   * 把当前卡片 + 参数写成「整组单层光区」并发给设备。
   *
   * 顺序必须是这样（票面陷阱 #3）：
   *  1. 先 `queryStrip` 读回设备上的真实光区（不信任本地缓存）；
   *  2. 清掉槽位 0 以外的**所有**光区——协议要求同组光区不重叠，不清就被拒；
   *  3. 再 `SetSegment` 写整组（槽位 0，区间 0..n-1）；
   *  4. 重新读回，界面以设备为准（失败也读，绝不保留假的成功画面）。
   */
  async writeQuick(): Promise<void> {
    const session = this.session;
    const stripId = this.data.stripId;
    const card = this.quickCardId === null ? null : quickCardOf(this.quickCardId);
    if (session === null || card === null || this.disabledReason() !== "") {
      return;
    }
    if (this.data.quickBusy) {
      /* 正在写：让本轮防抖再来一次（不并发发帧）。 */
      this.scheduleQuickWrite(false);
      return;
    }
    this.setData({ quickBusy: true, applyError: "" });
    try {
      /* 播放中设备按方案渲染，实时光区看不见：先停，再写入。 */
      const state = session.deviceState;
      if (state !== null && state.playbackState !== 0) {
        await session.setPlayback(0, (state.flags & 0x01) !== 0);
        this.setData({ quickHint: "已停止播放，改为实时灯效" });
      }

      const current = await session.queryStrip(stripId);
      if (current.kind === "ok") {
        this.segmentReports = current.reports.filter((report) => report.stripId === stripId);
      }

      const others = this.segmentReports.filter((report) => report.segId !== 0);
      for (const report of others) {
        const cleared = await session.clearSegment(stripId, report.segId);
        if (!cleared.ok) {
          throw new Error(resultText(cleared.resultCode));
        }
      }

      const ledCount = this.stripLedCount();
      const spec = buildQuickSpec(card, this.quickParams, stripId, ledCount);
      const ack = await session.setSegment(spec);
      if (!ack.ok) {
        throw new Error(resultText(ack.resultCode));
      }

      this.dirty = false;
      this.setData({ quickHint: `${card.name} 已生效` });
      await this.refreshSegments();
    } catch (err) {
      const message = errorText(err);
      this.dirty = true;
      this.setData({ quickHint: `写入失败：${message}` });
      await this.refreshSegments();
    } finally {
      this.setData({ quickBusy: false });
    }
  },

  // ---------------- 应用并播放 ----------------

  /**
   * 底部唯一的主按钮。
   *
   * 有未写入的改动（或设备上不是「整组一张卡」）→ 先写入；成功后再播放。
   * 写入失败就在按钮下方就地显示原因，不弹模态。已经在播放时只给提示，
   * 不重复发播放命令。
   */
  async onApplyAndPlay() {
    const session = this.session;
    /* 进阶档的时间轴还写不进设备（光区在 #66 / #67）：按下去会误写简单档
     * 的那张卡，所以这里直接拒绝并说明原因。 */
    if (this.data.mode === "advanced") {
      wx.showToast({ title: "光区接上后才能播放进阶编排", icon: "none" });
      return;
    }
    const reason = this.disabledReason();
    if (session === null || reason !== "") {
      if (reason !== "") {
        wx.showToast({ title: reason, icon: "none" });
      }
      return;
    }
    if (this.data.applying) {
      return;
    }
    if (this.quickCardId === null) {
      this.setData({ applyError: "先在上方选一张效果卡" });
      return;
    }
    this.setData({ applying: true, applyError: "" });
    try {
      /* 写整组：有改动，或设备上不是「整组一张卡」（多光区 / 叠加层）。 */
      if (this.dirty || this.segmentReports.length !== 1) {
        await this.writeQuick();
        if (this.dirty) {
          this.setData({ applyError: this.data.quickHint || "写入失败，请稍后重试" });
          return;
        }
      }
      const state = session.deviceState;
      if (state !== null && state.playbackState === 1) {
        this.setData({ quickHint: "已经在播放了" });
        return;
      }
      const loop = state !== null && (state.flags & 0x01) === 1;
      const result = await session.setPlayback(1, loop);
      if (result.kind === "ok") {
        if (result.state !== undefined && result.state !== null) {
          this.applyDeviceState(result.state);
        }
        this.setData({ quickHint: "正在播放" });
        return;
      }
      if (result.kind === "ack-error") {
        this.setData({ applyError: resultText(result.ack.resultCode) });
        return;
      }
      if (result.kind === "error") {
        this.setData({ applyError: result.message });
      }
    } finally {
      this.setData({ applying: false });
    }
  },
});
