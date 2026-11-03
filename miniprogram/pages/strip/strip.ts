/**
 * 灯组详情页（二级页）：query `strip` 指明是哪一组（#64）。
 *
 * ## 本页的职责
 *
 * 用户从设备页的灯组卡片点进来，只想改**这一条灯组**长什么样。本票实现
 * 「简单档」：九张成品效果卡（三列）+ 色相 / 饱和度 / 亮度三个滑块，底部只有
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
 * ## 亮度滑块
 *
 * 逐光区亮度是协议 v4 的层字段 `level`（0-100，票 #69 接通）。滑块松手即写进
 * 光区草稿并发给设备；它只作用于**这一条灯组的这个光区**，与设备全局亮度无关
 * （全局亮度会串到别的灯组）。
 */

import { errorText, resultText } from "../../utils/ble/errors";
import type { LinkDetail } from "../../utils/ble/transport";
import { ConnectCancelledError } from "../../utils/ble/transport";
import { createWxStorage, type SessionStorage } from "../../utils/control/device-cache";
import { deviceKeyOf } from "../../utils/control/device-history";
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
  applyChoice,
  applyPanelToZone,
  applySlider,
  buildEffectPanel,
  buildTypeViews,
  HUE_RAMP_GRADIENT,
  layersCheck,
  PANEL_EMPTY_PLAN_GUIDE,
  PANEL_EMPTY_STEP_GUIDE,
  PANEL_FACTS,
  PANEL_NO_ZONE_GUIDE,
  PANEL_TYPE_OPTIONS,
  isPanelSliderKey,
  panelCheck,
  panelTypeOf,
  paramsFromLayer,
  switchPanelType,
  type PanelChoiceView,
  type PanelSliderView,
  type PanelType,
} from "../../utils/control/effect-panel";
import { planIsEmpty, PLAN_CAPACITY_NOTE, planUserMessage } from "../../utils/control/plan-editor";
import {
  affectedZoneCount,
  clampLedCount,
  draftZoneRanges,
  planShrink,
  shrinkConfirmText,
  shrinkDraft,
} from "../../utils/control/led-count-plan";
import { ledCountResultHint } from "../../utils/control/ledCount";
import { loadPlanDrafts, removePlanDraft, savePlanDraft } from "../../utils/control/plan-drafts";
import {
  addPlan,
  buildPlanTabs,
  createEmptyPlanDraft,
  deletePlan,
  initialPlanIds,
  planDeviceSummary,
  planIdsFromSources,
  planIsPlaying,
  planTabSummary,
  plansFull,
  selectionAfterDelete,
  visiblePlanIds,
  type PlanTabView,
} from "../../utils/control/plan-slots";
import { zonesFromReports } from "../../utils/control/zone-editor";
import { checkScriptBlobBytes } from "../../utils/control/script-plan";
import { draftCapacityBytes, draftToScriptConfig } from "../../utils/control/script-view";
import {
  applyPickerEnd,
  applyPickerStart,
  buildPickerCells,
  commitPicker,
  createPickerState,
  deletePickerZone,
  otherZones,
  PICKER_COLUMNS,
  pickerCheck,
  pickerOptionLed,
  pickerOptions,
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
import type { ControlSession, ScriptResult } from "../../utils/control/session";
import { getSession, isMockSession } from "../../utils/control/session-singleton";
import { statusView } from "../../utils/control/status-view";
import {
  buildSimpleParams,
  clampLevel,
  hueFromDegrees,
  inferSimpleState,
  LEVEL_DEFAULT,
  levelAfterCardTap,
  levelDraftFromDevice,
  satFromPercent,
  type SimpleParamView,
} from "../../utils/control/strip-simple";
import { loadTheme, themeClass, type ThemeMode } from "../../utils/control/theme";
import {
  chooseGap,
  clampDuration,
  COMPACT_BLOCK_GAP_PX,
  DEFAULT_STEP_MS,
  dragFollowOffset,
  dragTapSuppressUntil,
  dragTargetAtRects,
  durationText,
  durationTicks,
  layoutBlocks,
  LONG_PRESS_MS,
  MAX_STEPS,
  MIN_BLOCK_PX,
  selectionAfterMove,
  tapSuppressedAt,
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
  zoneAxisGuide,
  zoneAxisSummary,
  zoneRangeDetail,
  type ZoneAxisBlock,
} from "../../utils/control/zone-axis";
import type { ScriptDraft } from "../../utils/control/script-view";
import { layerFromFlat } from "../../utils/control/segment-model";
import { MAX_LEDS, MAX_SCRIPTS, MIN_LEDS, NO_EFFECT, SEGMENT_TYPE } from "../../utils/protocol/constants";
import type {
  DeviceState,
  EffectLayer,
  LinkState,
  SegmentConfig,
  SegmentReport,
  SegmentSpec,
} from "../../utils/protocol/types";

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

/**
 * 二次确认（缩小灯珠数前）。`wx.showModal` 的 fail 也当取消——绝不因为一次
 * 弹窗失败就擅自改动用户编排。
 */
function showModal(title: string, content: string, confirmText: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      confirmText,
      cancelText: "取消",
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
}

/**
 * 面板草稿的默认层（静态、暖白、满亮）。
 *
 * 抽成函数而不是字面量：`EffectLayer` 的字段随协议版本增长（v4 多了 `level`），
 * 页面里四处重复的 6 字段字面量会各漏一个。返回副本，避免共享实例被就地改。
 */
function defaultPanelLayer(): EffectLayer {
  return {
    type: SEGMENT_TYPE.STATIC,
    hue: 7281,
    sat: 255,
    periodMs: 0,
    p5: 0,
    flags: 0,
    level: 100,
  };
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
    /* 灯珠数滑块（#79）：拖动只改本地，松手才下发；缩小越界要二次确认。 */
    ledMin: MIN_LEDS,
    ledMax: MAX_LEDS,
    /** 滑块值：下界是 1，「还没读到」时显示 1（0 在滑块上没有位置）。 */
    ledSliderValue: 1,
    ledBusy: false,
    ledHint: "",
    /* 只读的诊断行：滑块值与设备值的差别（拖动中 / 下发失败后）。 */
    ledPending: false,
    /* 方案（#83）：按需增长的 tab 行，默认只有一套（①）。 */
    planSlot: 0,
    /** 当前显示 / 编辑的方案编号（设备上的编号，页面内部用）。 */
    planTabs: [] as PlanTabView[],
    /** 「+ 新建方案」是否可用（四套都在用时禁用）。 */
    planCanAdd: false,
    /** 删除中的方案编号（-1 = 没有进行中的删除）；按钮据此转圈并防重入。 */
    planDeleting: -1,
    /** 方案操作的就地反馈（删除被拒的原因 / 满四套的提示）；空串 = 不显示。 */
    planHint: "",

    /* ---- 简单 / 进阶 ---- */
    mode: "simple" as StripMode,

    /* ---- 进阶档：时间轴 + 时长（#65） ---- */
    steps: [] as TimelineBlockView[],
    stepCount: 0,
    stepIndex: 0,
    stepCanAdd: false,
    timelineSummary: "",
    /* 块宽之和 + 间隙永远等于容器宽（#76）：不滚动，只可能在窄容器上收紧间隙。 */
    timelineCompact: false,
    stepDurationSeconds: 1,
    stepDurationText: "1 秒",
    durationTicks: [] as DurationTickView[],
    stepHint: "",
    /**
     * 提交重排的那一帧关掉块过渡（#82）。
     *
     * 块 key 是下标，重排后同一个节点换了内容；让内联 transform 从跟手位置
     * 过渡回原位，会看到「已经换过内容的块」飞回去。这一帧直接落位，下一帧
     * 再把过渡还回来。
     */
    timelineSettling: false,

    /* ---- 进阶档：光区轴（#66） ---- */
    zoneBlocks: [] as ZoneAxisBlock[],
    zoneSummary: "",
    zoneCount: 0,
    zoneCanAdd: false,
    maxZones: MAX_ZONES,
    selectedSegId: -1,
    selectedZoneText: "",
    /** 选中区间的数字核对（「第 0–19 颗 · 20 颗」，#77）；未选中为空串。 */
    selectedZoneRangeDetail: "",
    /** 零光区时的引导（#77）；有光区时为空串。 */
    zoneGuide: "",
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
    /* 起点 / 终点两个数字滚轮（#78）：候选只来自与锚点连通的连续空闲段。 */
    pickerStartLabels: [] as string[],
    pickerStartIndex: 0,
    pickerStartText: "",
    pickerStartHint: "",
    pickerEndLabels: [] as string[],
    pickerEndIndex: 0,
    pickerEndText: "",
    pickerEndDisabled: true,
    pickerEndHint: "",

    /* ---- 简单档：九张成品卡（#81 三列） ---- */
    quickCards: [] as QuickCardView[],
    simpleParams: null as SimpleParamView | null,
    quickDisabledReason: "",
    quickBusy: false,
    quickHint: "",

    /* ---- 进阶档：效果面板（#67 / #80） ---- */
    /** 七个等宽效果类型按钮（静态 / 呼吸 / 彩虹 / 流光 / 爆闪 / 心跳 / 熄灭）。 */
    panelTypes: buildTypeViews("static"),
    panelType: "static" as PanelType,
    /** 参数区滑块（按类型整体替换）。 */
    panelSliders: [] as PanelSliderView[],
    /** 参数区选择控件（波形 / 方向 / 占空比）。 */
    panelChoices: [] as PanelChoiceView[],
    /** 预览色块（拖色相 / 饱和度时的即时反馈）。 */
    panelColorHex: "",
    /** 一行摘要（「呼吸 · 2 秒 · 最暗 40% · 正弦」）。 */
    panelSummary: "",
    /**
     * 没有旋钮时的说明（只有「熄灭」用得到：它下发全零参数块，
     * 界面上没有任何可调项，只说明这一片是黑的）。
     */
    panelNotice: "",
    /** 当前选中的光区是否可编辑（否则只有引导文字）。 */
    panelHasZone: false,
    /** 没得编辑时的引导（方案为空 / 这一步为空 / 没选中光区）。 */
    panelGuide: "",
    /** 色相滑轨的彩虹渐变。 */
    hueRamp: HUE_RAMP_GRADIENT,
    /** 界面必须告知的两条事实（内容只存在本机 / 换机要重编）。 */
    panelFacts: PANEL_FACTS,
    /** 面板上的一次性反馈（切换类型 / 选控件）。 */
    panelHint: "",

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
  /** 简单档的亮度草稿（v4 的层亮度 0-100；松手即下发）。 */
  levelDraft: LEVEL_DEFAULT,
  /** 参数松手后的防抖定时器（只发最后一次）。 */
  quickTimer: null as ReturnType<typeof setTimeout> | null,
  /** 防抖代次：旧一轮在 await 后静默退出。 */
  quickEpoch: 0,
  /** 有改动还没成功写进设备（写失败 / 拖动中）。 */
  dirty: false,
  /** 4 个方案编号的步骤数（设备摘要）；null = 还没读回来。 */
  planStepCounts: null as number[] | null,
  /** 方案摘要读取代次（并发读时旧一轮作废）。 */
  planEpoch: 0,
  /**
   * 当前**显示哪几套方案**（升序，最长 4）。
   *
   * #83 起方案按需增长：这是「tab 行上有什么」的唯一真相，由本机草稿与
   * 设备摘要的并集推出（`planIdsFromSources`），新建 / 删除时手动更新。
   * 它不是 `drafts` 的下标——`drafts` 永远按设备编号定位，删掉②后 ③ 仍占
   * 下标 3，这样设备上的方案不会因为删一套而整体搬家。
   */
  planIds: [] as number[],
  /**
   * 上一次重画 tab 时的「正在播放的方案编号」；-1 = 没有播放。
   *
   * State 是 20Hz 的，只有这个值真的变了才重画 tab（否则每帧重建数组）。
   */
  planPlayingId: -1,

  /* ---- 进阶档：时间轴与光区的本地草稿（#65 / #66，不进设备） ---- */
  /** 4 个方案槽位各自的草稿（`ScriptDraft`：步骤 → 光区）；进阶档的唯一真相。 */
  drafts: [] as ScriptDraft[],
  /** 哪些槽位是**用户自己的**草稿（读过落盘 / 本次会话改过），摘要以它为准。 */
  draftOwned: [false, false, false, false] as boolean[],
  /** 草稿落盘用的设备键（hardwareId 优先）；空串 = 设备身份还没确定。 */
  draftsKey: "",
  /** 时间轴选中步骤的下标（0 起）。 */
  timelineIndex: 0,
  /** 时间轴容器（现在就是时间轴行）的宽度（px）；0 = 还没测量。 */
  timelineContainerWidth: 0,
  /** 长按定时器：到时进入拖动状态。 */
  longPressTimer: null as ReturnType<typeof setTimeout> | null,
  /** 拖动中的源下标；-1 = 没有拖动。 */
  dragFrom: -1,
  /** 拖动落点下标；-1 = 没在拖。 */
  dragTo: -1,
  /**
   * 被拖块「跟手指走」的横向位移（px）。
   *
   * 由纯函数 `dragFollowOffset` 算出后原样传进 `layoutBlocks`；页面只记这个
   * 数字，不自己算位移规则。
   */
  dragFollow: 0,
  /** 进入拖动那一刻的指尖横坐标；`dragFollow` 的零点。 */
  dragStartX: 0,
  /** 这一次触摸是否已经拖出时间轴（出界松手 = 取消，不提交顺序）。 */
  dragOutside: false,
  /**
   * 触摸代次：每次按下 / 抬起 / 取消自增。
   *
   * 长按进入拖动前要先异步量块矩形；代次变了说明这次触摸已经结束，回调不能
   * 再挂拖动状态（否则会留下一个「幽灵拖动」，下次移动凭空拖起一块）。
   */
  dragEpoch: 0,
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
  /** 面板参数属于「哪一步 × 哪个光区」；变化时从草稿重新读层（保住未下发的亮度草稿）。 */
  panelKey: "",
  /** 面板当前的效果类型（同时镜像到 `data.panelType` 给 WXML）。 */
  panelMode: "static" as PanelType,
  /** 面板的本地参数草稿（颜色 / 亮度跨类型保留）。 */
  panelParams: paramsFromLayer("static", {
    type: SEGMENT_TYPE.STATIC,
    hue: 7281,
    sat: 255,
    periodMs: 0,
    p5: 0,
    flags: 0,
    level: 100,
  }),
  /**
   * 灯珠数滑块上「用户拖过但还没松手 / 还没下发成功」的值（#79）。
   *
   * 设备 State 是 20Hz 的：拖动期间若把 `stripCounts` 同步回滑块，手指还没松开
   * 数字就会跳回旧值。松手提交成功后清空，交还给设备权威值。
   * `null` = 没有本地草稿。
   */
  ledDraft: null as number | null,
  /** 面板的一次性反馈（`data.panelHint` 的镜像，换目标时清空）。 */
  panelHintText: "",
  /**
   * 逐光区的亮度草稿（`panelKey → level`）。
   *
   * v4 起 `level` 有落盘位置（`layer0.level`），所以这张表只剩一个用途：
   * 记住**用户刚拖过、但还没写进设备**的滑块值，跨「切光区再切回来」不丢。
   * 一旦落进草稿/设备，`paramsFromLayer` 会从层里读回来，不再依赖这张表。
   */
  panelLevels: {} as Record<string, number>,

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
    this.planIds = initialPlanIds();
    this.planPlayingId = -1;
    this.drafts = createAdvancedDrafts();
    this.draftOwned = [false, false, false, false];
    this.draftsKey = "";
    this.timelineIndex = 0;
    this.timelineContainerWidth = 0;
    this.longPressTimer = null;
    this.dragFrom = -1;
    this.dragTo = -1;
    this.dragFollow = 0;
    this.dragStartX = 0;
    this.dragOutside = false;
    this.dragEpoch = 0;
    this.blockRects = [];
    this.timelineLeft = 0;
    this.dragTapUntil = 0;
    this.timelineMeasured = false;
    this.pickedSegId = -1;
    this.picker = createPickerState(null);
    this.panelKey = "";
    this.panelMode = "static";
    this.panelParams = paramsFromLayer("static", defaultPanelLayer());
    this.panelHintText = "";
    this.panelLevels = {};
    this.ledDraft = null;

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
      quickCards: buildQuickCardViews(null),
      durationTicks: durationTicks(),
    });
    this.renderPlans();
    this.renderTimeline();
    /* 草稿落盘：设备身份已知时把上次的编排读回来（冷启动不丢）。 */
    this.ensureDraftsLoaded();
  },

  onShow() {
    const expected = themeClass(loadTheme(createWxStorage()));
    if (this.data.themeClass !== expected) {
      this.setData({ themeClass: expected });
    }
    this.subscribe();
    this.syncFromSession();
    /* 回到本页时设备身份可能已经补齐（0x88 是异步的）：补读一次草稿。 */
    this.ensureDraftsLoaded();
    void this.session?.onShow();
    void this.ensureConnected();
  },

  onHide() {
    this.unsubscribe();
    /* 防抖定时器不属于界面：页面隐藏后它还会跑一次，可能对已断开的设备白发一帧。 */
    this.clearQuickTimer();
    this.clearLongPress();
    /* 拖动状态也不跨页面存活：回来时不该有一块还「浮在半空」。 */
    this.resetDragState();
  },

  onUnload() {
    /* 二级页会被真正卸载；会话属于 App，绝不 destroy。 */
    this.unsubscribe();
    this.clearQuickTimer();
    this.clearLongPress();
    this.resetDragState();
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
      /* 固件版本 / 硬件号由会话在 ready 后异步补齐：到位后补一次标题，并把
       * 草稿的存储键从 deviceId 升级到 hardwareId（iOS 换 UUID 后的稳定键）。 */
      session.onDeviceConfig(() => {
        this.applyDeviceName();
        this.ensureDraftsLoaded();
      }),
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
    /* 0x88 读回来之后设备键才稳定（hardwareId）：这里再读一次草稿。 */
    this.ensureDraftsLoaded();
  },

  /** 设备权威的 State → 灯珠数 / 标题 / 参数区可用性。 */
  applyDeviceState(state: DeviceState) {
    const ledCount = state.stripCounts[this.data.stripId] ?? 0;
    const changed = ledCount !== this.data.ledCount;
    /* 滑块值：有本地草稿（拖动中 / 确认框弹着）时以它为准，否则跟随设备权威值。
     * 拖动期间设备每帧上报旧值，跟着它走滑块就会在手指下跳。
     * 滑块下界是 1，所以「还没读到」时显示 1 而不是 0（0 在滑块上没有位置）。 */
    const sliderValue = Math.max(1, this.ledDraft ?? ledCount);
    if (changed || sliderValue !== this.data.ledSliderValue) {
      this.setData({
        ledCount,
        ledSliderValue: sliderValue,
        ledPending: this.ledDraft !== null && this.ledDraft !== ledCount,
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
    /* 播放态也在 State 里：只有「哪套在播」真的变了才重画 tab（20Hz 下不动）。 */
    const playingId =
      state.playbackState !== 0 && state.scriptId < MAX_SCRIPTS ? state.scriptId : -1;
    if (playingId !== this.planPlayingId) {
      this.planPlayingId = playingId;
      this.renderPlans();
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
    /* 进阶草稿**不丢**：它已经落盘（`lumen.planDrafts.v1`）。这里只是把内存
     * 镜像换回默认值并清掉设备键，避免把上一台设备的编排当成这一台的；
     * 下次 ready 时 `ensureDraftsLoaded` 会按键把草稿读回来。 */
    this.drafts = createAdvancedDrafts();
    this.draftOwned = [false, false, false, false];
    this.draftsKey = "";
    this.planIds = initialPlanIds();
    this.planPlayingId = -1;
    this.timelineIndex = 0;
    this.pickedSegId = -1;
    this.resetPanel();
    this.ledDraft = null;
    this.setData({
      ledCount: 0,
      ledSliderValue: 1,
      ledPending: false,
      ledHint: "",
      ledText: "连接后显示灯珠数",
      planHint: "",
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
      selectedZoneRangeDetail: "",
      zoneGuide: "",
      zoneHint: "",
      pickerOpen: false,
      pickerCells: [],
      panelTypes: buildTypeViews("static"),
      panelType: "static",
      panelSliders: [],
      panelChoices: [],
      panelColorHex: "",
      panelSummary: "",
      panelNotice: "",
      panelHasZone: false,
      panelGuide: "",
      panelHint: "",
    });
    this.renderPlans({ planHint: "" });
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
    /* 进进阶档才渲染时间轴：块的宽度依赖真实容器宽，行不在 DOM 里就量不到。 */
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
   * 时间轴块的派生（`layoutBlocks` 的唯一调用点）。
   *
   * 抽出来是为了拖动：`touchmove` 只需要重画块（位移 / 落点），不必重算光区轴
   * 与效果面板。两条路径共用这一个函数，块宽与位移规则因此不会分叉。
   */
  timelineBlocksOf(timelineSteps: ReturnType<typeof timelineStepsOf>): {
    blocks: TimelineBlockView[];
    gapPx: number | undefined;
  } {
    /* 容器宽度没量到之前不能算像素（会把首帧算成每个块几像素），退回时长权重 +
     * CSS 最小宽度；量到之后行宽恒等于容器宽，块宽在容器内部按比例 / 最小宽度
     * 分配——任何步骤数都不出容器，页面不滚动（#76）。 */
    const measured = this.timelineContainerWidth > 0;
    const durations = timelineSteps.map((step) => clampDuration(step.durationMs));
    const rowWidth = timelineRowWidth(durations, this.timelineContainerWidth);
    /* 8px 间隙放不下最小块宽时收紧到 4px（`layoutBlocks` 也按同一规则兜底）。 */
    const gapPx = measured ? chooseGap(timelineSteps.length, rowWidth, MIN_BLOCK_PX) : undefined;
    const blocks = layoutBlocks(timelineSteps, {
      widthPx: measured ? rowWidth : 0,
      ...(gapPx === undefined ? {} : { gapPx }),
      selected: this.timelineIndex,
      dragIndex: this.dragFrom >= 0 ? this.dragFrom : -1,
      dropIndex: this.dragFrom >= 0 ? this.dragTo : -1,
      followPx: this.dragFrom >= 0 ? this.dragFollow : 0,
      ledCount: this.stripLedCount(),
    });
    return { blocks, gapPx };
  },

  /**
   * 拖动中的轻量重绘：只更新 `steps`（块宽不会变，但位移与落点会）。
   *
   * 用 `setData` 的路径串而不是整页派生：`touchmove` 每秒几十次，重算光区轴
   * 与效果面板纯属浪费，而且会拖慢跟手。
   */
  renderDragBlocks(): void {
    const draft = this.currentDraft();
    const { blocks } = this.timelineBlocksOf(timelineStepsOf(draft, this.data.stripId));
    this.setData({ steps: blocks });
  },

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
    const { blocks, gapPx } = this.timelineBlocksOf(timelineSteps);
    const durations = timelineSteps.map((step) => clampDuration(step.durationMs));
    const durationMs = this.currentDurationMs();
    const totalMs = durations.reduce((sum, ms) => sum + ms, 0);
    const zones = stepZonesOf(draft, this.timelineIndex, stripId);
    const axisZones = axisZonesOf(zones);
    const selected = selectedZoneAfter(axisZones, this.pickedSegId);
    this.pickedSegId = selected;
    const selectedInput = axisZones.find((zone) => zone.segId === selected);
    /* 效果面板与两条轴来自同一份草稿：选中哪一块、这一块是什么效果，都由这里一次算好。 */
    const panel = this.panelData();
    this.setData({
      ...panel,
      steps: blocks,
      stepCount: timelineSteps.length,
      stepIndex: this.timelineIndex,
      stepCanAdd: canAddStepStage(draft),
      timelineCompact: gapPx === COMPACT_BLOCK_GAP_PX,
      /* 默认恢复过渡；只有提交重排那一帧由 `patch` 临时关掉（#82）。 */
      timelineSettling: false,
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
      /*
       * 这一行只讲「选中了哪一块、下一步做什么」；具体颗数交给下面单独的
       * `selectedZoneRangeDetail`（#77）。两行都写数字时必然一个 0 基一个
       * 1 基，用户会看到两个不一样的范围。
       */
      selectedZoneText:
        selectedInput === undefined
          ? axisZones.length === 0
            ? "点「+ 新增」划出第一个光区"
            : "点一块选中它，再点一次改范围"
          : `已选中光区 ${selectedInput.segId + 1} · 再点一次改范围`,
      /* 轴下方的数字核对（#77）：与设备上的区间同一口径（0 基闭区间）。 */
      selectedZoneRangeDetail:
        selectedInput === undefined
          ? ""
          : zoneRangeDetail(selectedInput.start, selectedInput.end),
      zoneGuide: zoneAxisGuide(axisZones.length, ledCount),
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

  /**
   * 写回当前槽位的草稿；新对象才替换（引用相等 = 什么都没变）。
   *
   * 三件事一起做：内存镜像、`draftOwned` 标记、落盘。落盘是「内容只存在本机」
   * 这句承诺的唯一实现——不在这里写，断线或重启就会丢。
   */
  setDraft(next: ScriptDraft): void {
    if (next === this.currentDraft()) {
      return;
    }
    const slot = this.data.planSlot;
    this.drafts = this.drafts.map((draft, index) => (index === slot ? next : draft));
    this.draftOwned[slot] = true;
    this.saveDraft(slot, next);
    /* tab 摘要跟着草稿走：用户一画光区，对应 tab 立刻从「空白」变成「n 步」。 */
    this.renderPlans();
  },

  /**
   * 草稿落盘要用的设备键（hardwareId 优先，与 `device-history.deviceKeyOf` 同口径）。
   *
   * 为什么键必须稳定：iOS 上 deviceId 会变，按它存等于每次换机就丢编排。
   * hardwareId 只有 0x88 读回来后才有，所以可能在页面生命周期中从「不稳定」
   * 迁移到「稳定」一次——`ensureDraftsLoaded` 负责这次迁移。
   * 身份完全未知时返回空串（调用方据此不落盘）。
   */
  deviceKeyForDrafts(): string {
    const session = this.session;
    const info = session?.deviceInfo ?? null;
    if (info !== null && info.hwId.length > 0) {
      return deviceKeyOf({ deviceId: session?.transport.currentDeviceId ?? "", hardwareId: info.hwId });
    }
    const cached = session?.cachedDevice ?? null;
    if (cached !== null && cached.deviceId.length > 0) {
      return deviceKeyOf({ deviceId: cached.deviceId });
    }
    const live = session?.transport.currentDeviceId ?? "";
    return live.length > 0 ? deviceKeyOf({ deviceId: live }) : "";
  },

  /**
   * 按当前设备键把草稿读回内存（进页面 / ready / identity 变化时调用）。
   *
   * 分工：
   *  - 键没变 → 什么都不做（本次会话的编辑就是最新的，别用旧存储覆盖它）；
   *  - 键变了 → 先把内存里**用户自己的**草稿迁到新键，再读新键；
   *  - 读不到 → 保留默认草稿（不把「没存过」当成「用户清空了」）。
   *
   * `draftOwned` 是这件事的判据：只有真正被编辑过（或从存储读回的）槽位才迁移，
   * 否则会把「设备上其实有方案」的槽位用空白默认草稿覆盖掉存储。
   *
   * #75 起草稿是**设备级**的（键 `deviceKey#slot`，没有灯组维度）：读回的是
   * 整份方案（含其它灯组的光区切片），本页只展示 / 修改 `stripId` 那一片。
   * 这样两套灯组看到的是同一份方案，写入时后写的那组不会把前一组清掉。
   */
  ensureDraftsLoaded(): void {
    const storage = this.storage;
    const key = this.deviceKeyForDrafts();
    if (storage === null || key.length === 0) {
      return;
    }
    if (key === this.draftsKey) {
      return;
    }
    /* 键变了：把用户自己的草稿迁到新键（deviceId → hardwareId 的升级）。 */
    if (this.draftsKey.length > 0) {
      for (let slot = 0; slot < this.drafts.length; slot += 1) {
        if (this.draftOwned[slot] === true) {
          savePlanDraft(storage, key, slot, this.drafts[slot]);
        }
      }
    }
    this.draftsKey = key;
    const stored = loadPlanDrafts(storage, key);
    if (stored === null) {
      /* 新键没有历史：保留内存里的（迁移上来的部分），其余仍是默认草稿。 */
      this.planIds = visiblePlanIds(this.planIds, null, this.localPlanIds());
      if (!this.planIds.includes(this.data.planSlot)) {
        this.setData({ planSlot: this.planIds[0] ?? 0 });
      }
      this.renderPlans();
      return;
    }
    this.drafts = this.drafts.map((draft, slot) => {
      const loaded = stored[slot];
      if (loaded === null || loaded === undefined) {
        /* 该槽位没存过：保留内存里的（可能是刚迁移上来的用户草稿）。 */
        return draft;
      }
      this.draftOwned[slot] = true;
      return loaded;
    });
    /* 落盘里有几套方案，tab 行就该有几套（设备摘要还没读回来时也成立）。 */
    this.planIds = visiblePlanIds(this.planIds, this.planStepCountsRecord(), this.localPlanIds());
    if (!this.planIds.includes(this.data.planSlot)) {
      this.setData({ planSlot: this.planIds[0] ?? 0 });
    }
    this.renderPlans();
    /* 已经在进阶档时（0x88 晚到 / 从后台回来）要重画两条轴，否则屏幕上还是默认草稿。 */
    if (this.data.mode === "advanced") {
      this.timelineIndex = Math.min(
        this.timelineIndex,
        Math.max(0, this.currentDraft().stages.length - 1),
      );
      this.pickedSegId = -1;
      this.panelKey = "";
      this.renderTimeline();
    }
  },

  /**
   * 把某个槽位写进存储（键未知时静默跳过，绝不编造键）。
   *
   * 写的是**整份设备级草稿**：内存里的草稿是从存储读回来的（含其它灯组的
   * 切片），而编辑只经过 `writeStepZones` 替换「当前步骤 × 当前灯组」那一片，
   * 所以其它灯组 / 其它步骤原样落盘。
   */
  saveDraft(slot: number, draft: ScriptDraft): void {
    const storage = this.storage;
    const key = this.draftsKey.length > 0 ? this.draftsKey : this.deviceKeyForDrafts();
    if (storage === null || key.length === 0) {
      return;
    }
    this.draftsKey = key;
    savePlanDraft(storage, key, slot, draft);
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

  // ---------------- 灯珠数滑块（#79） ----------------

  /** 拖动中：**只改本地值**，不下发（每帧发会撞上 0x05 Busy）。 */
  onLedCountChanging(e: WechatMiniprogram.SliderChanging) {
    const value = clampLedCount(Number(e.detail.value));
    this.ledDraft = value;
    this.setData({
      ledSliderValue: value,
      ledPending: value !== this.data.ledCount,
      ledHint: "",
    });
  },

  /**
   * 松手：缩小且这条灯组有越界光区 / 草稿时先确认；确认后下发并就地清理。
   *
   * 只改**当前灯组**：其它灯组的灯珠数与光区一个字节都不动。
   */
  async onLedCountChange(e: WechatMiniprogram.SliderChange) {
    const session = this.session;
    const value = clampLedCount(Number(e.detail.value));
    const current = this.stripLedCount();
    this.ledDraft = value;
    this.setData({
      ledSliderValue: value,
      ledPending: value !== current,
      ledHint: "",
    });
    if (session === null || !this.data.ready || this.data.ledBusy) {
      this.backToDeviceLedCount();
      return;
    }
    if (value === current) {
      this.backToDeviceLedCount();
      return;
    }

    /* 缩小前的本地预检：设备光区 + 4 套草稿，数出会越界的个数。改大永远 0。
     * 设备光区**现读一次**（不只用缓存的 `segmentReports`）：确认文案里的数字
     * 必须与设备上真实存在的段对得上。读失败就按缓存算。 */
    let deviceZones = zonesFromReports(
      this.segmentReports.filter((report) => report.stripId === this.data.stripId),
    );
    if (value < current) {
      const fresh = await session.queryStrip(this.data.stripId);
      if (fresh.kind === "ok") {
        deviceZones = zonesFromReports(
          fresh.reports.filter((report) => report.stripId === this.data.stripId),
        );
      }
      const affected = affectedZoneCount(
        deviceZones,
        draftZoneRanges(this.drafts, this.data.stripId),
        value,
      );
      if (affected > 0) {
        const confirmed = await showModal(
          "缩短灯组会截断光区",
          shrinkConfirmText(affected, value),
          "继续缩短",
        );
        if (!confirmed) {
          /* 取消：设备与草稿都不动。 */
          this.backToDeviceLedCount();
          return;
        }
      }
    }

    await this.applyLedCount(value, current, deviceZones);
  },

  /** 滑块回到设备权威值（取消 / 无效拖动 / 下发失败）。 */
  backToDeviceLedCount(): void {
    this.ledDraft = null;
    this.setData({
      ledSliderValue: Math.max(1, this.stripLedCount()),
      ledPending: false,
    });
  },

  /**
   * 下发当前灯组的灯珠数。
   *
   * 成功：清理草稿（截断 / 删除越界光区）并把截断后的光区写回设备。
   * 失败：**就地显示原因并保留原灯珠数**（草稿一个字节都不动）。
   */
  async applyLedCount(
    value: number,
    current: number,
    deviceZones: readonly SegmentSpec[],
  ): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    const stripId = this.data.stripId;
    this.setData({ ledBusy: true, ledHint: "正在应用…" });
    try {
      /* 只改这一条：`setLedCount` 的 stripId 显式传当前组。 */
      const result = await session.setLedCount(value, stripId);
      if (result.kind === "ok") {
        const applied = result.state.stripCounts[stripId] ?? value;
        this.ledDraft = null;
        this.setData({
          ledSliderValue: applied,
          ledPending: false,
          ledCount: applied,
          ledText: applied > 0 ? `${applied} 颗灯珠` : "还没读到灯珠数量",
          ledHint: `已设为 ${applied} 颗`,
        });
        if (value < current) {
          /* 缩小：草稿与设备上的光区同步截断（截到新末尾、完全越界的删除）。 */
          this.shrinkDraftsForStrip(applied);
          await this.rewriteClampedZones(deviceZones, applied);
          if (this.data.mode === "advanced") {
            this.renderTimeline();
          }
        }
        return;
      }
      if (result.kind === "ack-error") {
        const hint = ledCountResultHint(result.ack.resultCode) || "设置失败";
        this.failLedCount(current, hint);
        return;
      }
      if (result.kind === "stale") {
        this.backToDeviceLedCount();
        return;
      }
      this.failLedCount(current, `设置失败：${result.message}`);
    } finally {
      this.setData({ ledBusy: false });
    }
  },

  /** 失败：就地显示原因，滑块保留原灯珠数。 */
  failLedCount(current: number, hint: string): void {
    this.ledDraft = null;
    this.setData({
      ledSliderValue: current,
      ledPending: false,
      ledHint: hint,
    });
    wx.showToast({ title: hint, icon: "none" });
  },

  /**
   * 把当前灯组在 4 套草稿里的越界光区按新长度清理并落盘。
   *
   * 只碰 `stripId` 那一片（`shrinkDraft` 的语义）；其它灯组、其它槽位原样保留。
   * 当前槽位走 `setDraft`（顺带更新右上角摘要），其余槽位直接落盘。
   */
  shrinkDraftsForStrip(newLedCount: number): void {
    const stripId = this.data.stripId;
    const currentSlot = this.data.planSlot;
    for (let slot = 0; slot < this.drafts.length; slot += 1) {
      const draft = this.drafts[slot];
      const result = shrinkDraft(draft, stripId, newLedCount);
      if (!result.changed) {
        continue;
      }
      if (slot === currentSlot) {
        this.setDraft(result.draft);
      } else {
        this.drafts = this.drafts.map((item, index) => (index === slot ? result.draft : item));
        this.draftOwned[slot] = true;
        this.saveDraft(slot, result.draft);
      }
    }
  },

  /**
   * 把被截断的光区按新终点重新写回设备（只写当前灯组）。
   *
   * 固件在数量变更时会把 `end >= new_count` 的段整段 prune 掉（不自动缩短，
   * protocol-v4 §7.2），所以确认后只需把「截断版」写回去——`SetSegment` 按
   * (灯组, 槽位) 覆盖同一格，不与保留的段冲突。写失败只就地提示，不回滚
   * 已经成功的灯珠数。
   */
  async rewriteClampedZones(zones: readonly SegmentSpec[], newLedCount: number): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    const plan = planShrink(zones, newLedCount);
    if (plan.clamped.length === 0) {
      return;
    }
    try {
      for (const zone of plan.clamped) {
        const ack = await session.setSegment(zone);
        if (!ack.ok) {
          this.setData({ ledHint: `灯珠数已改；光区写回失败（${resultText(ack.resultCode)}）` });
          return;
        }
      }
      await this.refreshSegments();
    } catch (err) {
      this.setData({ ledHint: `灯珠数已改；光区写回失败（${errorText(err)}）` });
    }
  },

  // ---------------- 进阶档：效果面板（#67） ----------------

  /**
   * 面板的派生数据（`setData` 片段）。
   *
   * 两件事在这里发生：
   *
   *  1. **换目标时从草稿重新读层**。`panelKey = 方案:步骤:光区`，一变就把那一片
   *     `layer0`（含 v4 的 `level`）读成面板草稿；没变就**保留**页面上的草稿——
   *     拖动中的读数不该被一次重画冲掉；
   *  2. **没得编辑时给引导**。方案为空 / 这一步为空 / 有光区但没选中，三种情况
   *     文案不同：一片空白会让人以为界面坏了。
   */
  panelData(): Record<string, unknown> {
    const zones = this.currentZones();
    const zone = zones.find((item) => item.segId === this.pickedSegId) ?? null;
    const key = `${this.data.planSlot}:${this.timelineIndex}:${zone === null ? -1 : zone.segId}`;
    if (key !== this.panelKey) {
      this.panelKey = key;
      this.panelHintText = "";
      if (zone === null) {
        this.panelMode = "static";
        this.panelParams = paramsFromLayer("static", defaultPanelLayer());
      } else {
        this.panelMode = panelTypeOf(zone.layer0.type);
        this.panelParams = paramsFromLayer(this.panelMode, zone.layer0);
      }
      /* 还没写进草稿的滑块值：按目标记在页面里，切回来还在。 */
      const remembered = this.panelLevels[key];
      if (remembered !== undefined) {
        this.panelParams = { ...this.panelParams, level: remembered };
      }
    }
    const view = buildEffectPanel(this.panelMode, this.panelParams);
    let guide = "";
    if (zone === null) {
      if (zones.length > 0) {
        guide = PANEL_NO_ZONE_GUIDE;
      } else {
        guide = planIsEmpty(this.currentDraft()) ? PANEL_EMPTY_PLAN_GUIDE : PANEL_EMPTY_STEP_GUIDE;
      }
    }
    return {
      panelTypes: view.types,
      panelType: view.type,
      /* 没有可编辑的光区时不留任何滑块 / 选择控件：用户不该看到一个改不动的旋钮，
       * 引导文字会告诉他下一步做什么。 */
      panelSliders: zone === null ? [] : view.sliders,
      panelChoices: zone === null ? [] : view.choices,
      /* 预览色块与摘要也只在真有可编辑的光区时才显示：没有目标时的「静态 · 40°」
       * 是一句凭空捏造的描述。 */
      panelColorHex: zone === null ? "" : view.colorHex,
      panelSummary: zone === null ? "" : view.summary,
      /* 「熄灭」没有任何旋钮：说明必须跟着光区一起出现 / 消失，否则没选中光区时
       * 它会变成一句凭空捏造的描述。 */
      panelNotice: zone === null ? "" : view.notice,
      panelHasZone: zone !== null,
      panelGuide: guide,
      panelFacts: PANEL_FACTS,
      hueRamp: HUE_RAMP_GRADIENT,
      panelHint: this.panelHintText,
    };
  },

  /** 面板的一次性反馈：私有字段与 `data` 一起写，重画时不会又冒出来 / 又消失。 */
  setPanelHint(text: string): void {
    this.panelHintText = text;
    this.setData({ panelHint: text });
  },

  /** 清掉面板的一次性反馈。 */
  clearPanelHint(): void {
    this.setPanelHint("");
  },

  /** 面板草稿回到「静态 + 默认色」（断开 / 换目标 / 无选中时用）。 */
  resetPanel(): void {
    this.panelKey = "";
    this.panelMode = "static";
    this.panelParams = paramsFromLayer("static", defaultPanelLayer());
    /* 亮度草稿属于「这台设备的这条灯组」：断开后连表一起作废。 */
    this.panelLevels = {};
    this.clearPanelHint();
  },

  /** 只重画面板（拖滑块时用：不动时间轴与光区轴，拖动才跟手）。 */
  renderPanel(patch: Record<string, unknown> = {}): void {
    this.setData({ ...this.panelData(), ...patch });
  },

  /**
   * 把面板草稿写进「当前步骤 × 当前灯组 × 当前光区」的那一片。
   *
   * 装配走 `applyPanelToZone` → `zone-model.buildZoneSpec`：叠加层为空时叠加方式
   * 归一为覆盖、两层定宽、深拷贝——面板只改效果，不顺手把叠加层弄丢。
   *
   * 写入前先过 `panelCheck`：频率过快 / 节奏过快或过慢在本地就拦住，
   * 草稿保持原样、界面给出一行原因（不会悄悄把越界值写进去）。
   *
   * 返回是否真的写进了草稿——调用方据此决定要不要清掉提示。
   */
  commitPanel(): boolean {
    const segId = this.pickedSegId;
    if (segId < 0) {
      return false;
    }
    const zones = this.currentZones();
    if (!zones.some((zone) => zone.segId === segId)) {
      return false;
    }
    const check = panelCheck(this.panelMode, this.panelParams);
    if (!check.ok) {
      this.setPanelHint(check.message);
      return false;
    }
    this.applyStepZones(applyPanelToZone(zones, segId, this.panelMode, this.panelParams));
    return true;
  },

  /** 点七个效果类型按钮之一：参数区整体替换，颜色与亮度保留。 */
  onPanelTypeTap(e: WechatMiniprogram.TouchEvent) {
    const type = String(e.currentTarget.dataset.type ?? "") as PanelType;
    if (!PANEL_TYPE_OPTIONS.some((option) => option.type === type)) {
      return;
    }
    /* 没有可编辑的光区时类型行是灰的（点不动），这里再挡一次渲染层的意外事件。 */
    if (this.data.panelHasZone !== true || type === this.panelMode) {
      return;
    }
    /* 先换算再改类型：`switchPanelType` 需要知道「从哪个类型切过来」。
     * 切换后的默认值一定在区间内，所以这里不会触发预检拒绝。 */
    this.panelParams = switchPanelType(this.panelParams, this.panelMode, type);
    this.panelMode = type;
    /* 类型是离散动作：立刻落进草稿（但不写设备——写设备只走「应用并播放」）。 */
    if (this.commitPanel()) {
      this.setPanelHint("颜色已经保留，其余参数按新效果重置了");
    }
    this.renderTimeline();
  },

  /** 滑块拖动中：只改本地草稿与预览色块（绝不逐帧写设备）。 */
  onPanelSliderChanging(e: WechatMiniprogram.SliderChanging) {
    this.applyPanelSlider(String((e.currentTarget.dataset as { key?: string }).key ?? ""), Number(e.detail.value));
  },

  /** 松开滑块：落进草稿（写设备仍然只走「应用并播放」）。 */
  onPanelSliderChange(e: WechatMiniprogram.SliderChange) {
    const key = String((e.currentTarget.dataset as { key?: string }).key ?? "");
    if (this.applyPanelSlider(key, Number(e.detail.value))) {
      /* 被预检拦住时保留原因（`commitPanel` 已经写进 hint），别在这里抹掉。 */
      if (this.commitPanel()) {
        this.clearPanelHint();
      }
      this.renderTimeline();
    }
  },

  /** 滑块值 → 面板草稿（返回是否真的变了）。 */
  applyPanelSlider(key: string, value: number): boolean {
    if (!isPanelSliderKey(key) || !Number.isFinite(value)) {
      return false;
    }
    const next = applySlider(this.panelParams, key, value);
    this.panelParams = next;
    if (key === "level") {
      this.panelLevels[this.panelKey] = next.level;
    }
    if (this.data.mode === "advanced") {
      this.renderPanel();
    }
    return true;
  },

  /** 波形 / 方向 / 占空比：点一下就是一次离散改动，直接落进草稿。 */
  onPanelChoiceTap(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? "");
    const value = Number(e.currentTarget.dataset.value);
    if (key !== "waveform" && key !== "direction" && key !== "duty") {
      return;
    }
    if (!Number.isFinite(value) || this.data.panelHasZone !== true) {
      return;
    }
    this.panelParams = applyChoice(this.panelParams, key, value);
    if (this.commitPanel()) {
      this.clearPanelHint();
    }
    this.renderTimeline();
  },

  /**
   * 量时间轴行的真实宽度。
   *
   * 块的宽度按「容器宽 - 间隙」分配，容器宽度只能问渲染层。量到之后立刻重算
   * 一次，动画才会从「时长比例」平滑过渡到「像素」。行本身是 `width: 100%`，
   * 所以量到的就是可用宽度——它只影响块宽，不影响是否滚动（#76：永不滚动）。
   */
  measureTimeline(force = false): void {
    if (this.timelineMeasured && !force) {
      return;
    }
    wx.createSelectorQuery()
      .select(".timeline-row")
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
    if (tapSuppressedAt(Date.now(), this.dragTapUntil)) {
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
   * 手指按下：记住起点并起长按定时器。
   *
   * 定时器到点才进入拖动状态——直接按下变拖动会与「点一下选中」抢事件，用户
   * 也没法「先看一眼再点」。300 毫秒（`LONG_PRESS_MS`，#82）。
   *
   * `dragStartX` 是「跟手位移」的零点：等待期间手指若有轻微移动，就跟着更新，
   * 于是块抬起的那一刻位移正好是 0，不会先跳一下。
   *
   * 进入拖动时先量块的屏幕位置，再挂上拖动状态：测量必须在**没有 transform**
   * 的情况下做，否则被拖块的 1.06 放大也会进矩形，命中范围就偏了。
   */
  onStepTouchStart(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= this.currentDraft().stages.length) {
      return;
    }
    const touch = firstTouch(e);
    this.dragStartX = touch === null ? 0 : touch.clientX;
    this.clearLongPress();
    /*
     * 代次：测量是异步的（`boundingClientRect` 要等一个渲染回合）。若手指在
     * 测量回来之前就抬起，回调里再挂拖动状态会留下一个「幽灵拖动」——下一次
     * 移动就凭空拖起来。代次在 touchstart / touchend / cancel 都自增，回调
     * 只在代次没变时生效。
     */
    this.dragEpoch += 1;
    const epoch = this.dragEpoch;
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      if (epoch !== this.dragEpoch) {
        return;
      }
      /* 先量后挂：测量必须在**没有 transform** 的时候做，被拖块的 1.06 放大
       * 会进矩形，命中范围就偏了。 */
      this.measureBlockRects(() => {
        if (epoch !== this.dragEpoch) {
          return;
        }
        this.dragFrom = index;
        this.dragTo = index;
        this.dragFollow = 0;
        this.dragOutside = false;
        this.timelineIndex = index;
        this.renderTimeline({ stepHint: "拖到目标位置松手" });
      });
    }, LONG_PRESS_MS);
  },

  /** 量所有时间轴块的屏幕矩形（拖动落点换算的基准）；量完回调。 */
  measureBlockRects(done?: () => void): void {
    wx.createSelectorQuery()
      .selectAll(".timeline-block")
      .boundingClientRect((rects) => {
        const list = Array.isArray(rects) ? rects : rects ? [rects] : [];
        this.blockRects = list.map((rect) => {
          const box = rect as WechatMiniprogram.BoundingClientRectCallbackResult;
          return { left: box.left, right: box.right };
        });
        done?.();
      })
      .exec();
  },

  /**
   * 拖动中：被拖块跟手指走，落点预览跟着变（顺序还没提交）。
   *
   * 位移量与落点全部交给纯函数（`dragFollowOffset` / `dragTargetAtRects`），
   * 页面只搬运数字——「看到的位移」和「实际的落点」因此不会成为两套真相。
   */
  onStepTouchMove(e: WechatMiniprogram.TouchEvent) {
    const touch = firstTouch(e);
    if (touch === null) {
      return;
    }
    /* 还没长按到点：手指在动就把零点跟着挪，抬起那一刻不会跳。 */
    if (this.dragFrom < 0) {
      this.dragStartX = touch.clientX;
      return;
    }
    const follow = dragFollowOffset(this.dragStartX, touch.clientX, this.blockRects, this.dragFrom);
    const target = dragTargetAtRects(this.blockRects, touch.clientX);
    /* 拖出时间轴 = 取消：不给让位预览，也不高亮落点（松手后原地回弹）。 */
    const nextTo = target.outside || target.index < 0 ? this.dragFrom : target.index;
    const followChanged = Math.round(follow * 2) !== Math.round(this.dragFollow * 2);
    const targetChanged = nextTo !== this.dragTo;
    const outsideChanged = target.outside !== this.dragOutside;
    if (!followChanged && !targetChanged && !outsideChanged) {
      return;
    }
    this.dragFollow = follow;
    this.dragTo = nextTo;
    this.dragOutside = target.outside;
    /* 只重画块：光区轴与效果面板在拖动中没变，不必跟着重算（跟手更顺）。 */
    this.renderDragBlocks();
  },

  onStepTouchEnd() {
    this.clearLongPress();
    const from = this.dragFrom;
    const to = this.dragTo;
    const outside = this.dragOutside;
    /* 定时器没到点就没有进入拖动：这次触摸只是「按住了一下」，不改顺序。
     * 拖过（无论有没有真的换位置）都要让随后的 tap 闭嘴。 */
    const dragged = from >= 0;
    /* 触摸已经结束：清状态并作废任何还在路上的长按回调。 */
    this.resetDragState();
    if (!dragged) {
      return;
    }
    this.dragTapUntil = dragTapSuppressUntil(Date.now());
    /* 拖到自身位置或拖出时间轴：不产生顺序变化，块正常回弹。 */
    if (to < 0 || from === to || outside) {
      this.renderTimeline({ stepHint: outside ? "拖出时间轴，已取消" : "" });
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
    /*
     * 提交重排的那一帧不要过渡（`timelineSettling`）：块的 key 是下标，重排后
     * 同一个节点会换成别的内容；让内联 transform 从「跟手位置」过渡回原位，
     * 会看到一块已经换过内容的块（幽灵）飞回去。这一帧直接落位，下一帧再把
     * 过渡还回来——松手后看到的就是「顺序已经变了，块都在最终位置」。
     *
     * 取消（拖回原位 / 拖出时间轴）不走这里：那种情况节点内容没换，150ms 的
     * 过渡正是「回弹」本身。
     */
    this.renderTimeline(
      { stepHint: `已把第 ${from + 1} 个步骤挪到第 ${to + 1} 位`, timelineSettling: true },
      () => this.setData({ timelineSettling: false }),
    );
  },

  onStepTouchCancel() {
    this.clearLongPress();
    if (this.dragFrom >= 0) {
      this.dragTapUntil = dragTapSuppressUntil(Date.now());
    }
    this.resetDragState();
    this.renderTimeline();
  },

  /**
   * 清空拖动状态（抬指 / 取消 / 页面隐藏都走这里）。
   *
   * 单独一个方法是为了不漏字段：漏掉 `dragFollow` 会让块停在半路；同时自增
   * `dragEpoch`——还在路上的「长按 → 量矩形 → 挂拖动」回调据此作废，否则会
   * 留下一个「幽灵拖动」，下次移动凭空拖起一块。
   */
  resetDragState() {
    this.dragEpoch += 1;
    this.dragFrom = -1;
    this.dragTo = -1;
    this.dragFollow = 0;
    this.dragOutside = false;
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

  /** 重画弹窗（唯一派生入口：格子、区间文字、滚轮、能否确定、标题）。 */
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
    /* 滚轮值域只来自与锚点连通的连续空闲段（#78）：被别的光区占着的序号
     * 根本不在候选里，所以选不出非法区间。回显文案由纯函数给出——点格子
     * 跨过别人的光区时那一端不在候选里，滚轮仍如实显示它（同时确定是灰的）。 */
    const options = pickerOptions(this.picker, { ledCount, others });
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
      pickerStartLabels: options.startLabels,
      pickerStartIndex: options.startIndex,
      pickerStartText: options.startText,
      pickerStartHint: options.startLeds.length > 0 ? "" : "没有空闲灯珠",
      pickerEndLabels: options.endLabels,
      pickerEndIndex: options.endIndex,
      pickerEndText: options.endText,
      pickerEndDisabled: options.endDisabled,
      pickerEndHint: options.run === null ? "没有空闲灯珠" : "先点一颗灯珠做起点",
      ...patch,
    });
  },

  /** 起点滚轮：把选中的候选映射回灯珠下标，再交给纯函数改状态。 */
  onPickerStartChange(e: WechatMiniprogram.PickerChange) {
    const option = Number(e.detail.value);
    const ledCount = this.currentLedCount();
    const others = otherZones(this.currentZones(), this.picker.segId);
    const led = pickerOptionLed(pickerOptions(this.picker, { ledCount, others }).startLeds, option);
    if (led < 0) {
      return;
    }
    const next = applyPickerStart(this.picker, led, { ledCount, others });
    if (next === this.picker) {
      return;
    }
    this.picker = next;
    this.renderPicker();
  },

  /** 终点滚轮：锚点未定时不可用（`applyPickerEnd` 会原样返回状态）。 */
  onPickerEndChange(e: WechatMiniprogram.PickerChange) {
    const option = Number(e.detail.value);
    const ledCount = this.currentLedCount();
    const others = otherZones(this.currentZones(), this.picker.segId);
    const led = pickerOptionLed(pickerOptions(this.picker, { ledCount, others }).endLeds, option);
    if (led < 0) {
      return;
    }
    const next = applyPickerEnd(this.picker, led, { ledCount, others });
    if (next === this.picker) {
      return;
    }
    this.picker = next;
    this.renderPicker();
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
    this.setData({
      pickerOpen: false,
      pickerError: "",
      pickerCells: [],
      pickerStartLabels: [],
      pickerStartText: "",
      pickerStartHint: "",
      pickerEndLabels: [],
      pickerEndText: "",
      pickerEndDisabled: true,
      pickerEndHint: "",
    });
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

  // ---------------- 方案（#83：按需增长的槽位） ----------------

  /**
   * 本机**有草稿**的方案编号（tab 行的第一份线索）。
   *
   * 只算 `draftOwned` 的槽位：默认草稿（`createAdvancedDrafts` 造出来的 4 份
   * 空壳）不是「用户有这一套」，把它们算进来又变成四个永远占着的坑。
   */
  localPlanIds(): number[] {
    const ids: number[] = [];
    for (let slot = 0; slot < this.drafts.length; slot += 1) {
      if (this.draftOwned[slot] === true) {
        ids.push(slot);
      }
    }
    return ids;
  },

  /** 设备摘要的编号 → 步骤数（`planIdsFromSources` 的输入）。 */
  planStepCountsRecord(): Record<number, number> | null {
    if (this.planStepCounts === null) {
      return null;
    }
    const record: Record<number, number> = {};
    for (let slot = 0; slot < this.planStepCounts.length; slot += 1) {
      record[slot] = this.planStepCounts[slot];
    }
    return record;
  },

  /**
   * 某一个方案 tab 的摘要（界面上只出现「空白」或「n 步」）。
   *
   * 优先级：
   *  1. **用户自己的草稿**（有光区才算有内容）——它是进阶档的真相；
   *  2. 设备摘要（`planStepCounts`）——没动过的方案反映「灯控上有什么」；
   *  3. 都没读到 → 「空白」（不是「读取中…」：新建的方案本来就是空的）。
   */
  planSummaryOf(slot: number): string {
    if (this.draftOwned[slot] === true) {
      const draft = this.drafts[slot];
      if (draft !== undefined) {
        return planTabSummary(draft);
      }
    }
    if (this.planStepCounts !== null) {
      return planDeviceSummary(this.planStepCounts[slot] ?? 0);
    }
    return "空白";
  },

  /**
   * 重画方案 tab 行（唯一派生入口）。
   *
   * 三件事：本机草稿与设备摘要的并集 → 摘要文案 → 播放态。「播放态」取设备
   * State（不是本地猜的）：删除正在播的方案时要靠它决定先停播。
   */
  renderPlans(patch: Record<string, unknown> = {}): void {
    if (this.planIds.length === 0) {
      this.planIds = initialPlanIds();
    }
    const summaries: Record<number, string> = {};
    for (const id of this.planIds) {
      summaries[id] = this.planSummaryOf(id);
    }
    const state = this.session?.deviceState ?? null;
    const playingId =
      state !== null && state.playbackState !== 0 && state.scriptId < MAX_SCRIPTS ? state.scriptId : null;
    this.setData({
      planTabs: buildPlanTabs(this.planIds, this.data.planSlot, summaries, playingId),
      /*
       * 新建要求**已经读到设备摘要**（`planStepCounts !== null`）：否则不知道
       * 哪些槽位被占，新建会覆盖设备上已有的方案（见 onPlanAdd）。
       */
      planCanAdd: this.data.ready && this.planStepCounts !== null && !plansFull(this.planIds),
      ...patch,
    });
  },

  /** 切到某一套方案（顶部 tab）：时间轴 / 光区轴 / 效果面板整体跟着换。 */
  onPlanTap(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.planId);
    if (!Number.isInteger(id) || id === this.data.planSlot || this.data.planDeleting >= 0) {
      return;
    }
    if (!this.planIds.includes(id)) {
      return;
    }
    this.setData({ planSlot: id, planHint: "" });
    /* 换方案 = 换一份草稿：步骤下标与光区选中都要重新落到合法值。 */
    this.timelineIndex = 0;
    this.pickedSegId = -1;
    this.panelKey = "";
    this.renderPlans();
    if (this.data.mode === "advanced") {
      this.renderTimeline();
    }
  },

  /**
   * 「+ 新建方案」：占用当前未被使用的最小方案编号，建一份空草稿并选中它。
   *
   * 「未使用」要同时算上**设备上已有的方案**：本机没草稿时设备方案不显示，
   * 但它们确实占着编号，拿它当空位会覆盖别人下发过的内容。所以分配用并集
   * （`planIdsFromSources`，把当前 tab 表也算进去）。
   *
   * **必须先读到设备摘要**：`planStepCounts === null` 表示还没连上灯控（或读
   * 失败），此时"哪些槽位被占"完全未知。`planIdsFromSources` 只能看到本机
   * 草稿，会把一个上一台/上一次会话下发过方案的槽位当成空位发出去，
   * 随后的「应用并播放」就**覆盖掉设备上已有的方案**——用户没打算删的东西
   * 就没了。所以这里直接拦住，而不是猜一个空位。
   *
   * 四套都在用时按钮是禁用的；这里再兜一次（防重入 / 事件漏判），并就地提示。
   */
  onPlanAdd() {
    if (this.data.planDeleting >= 0) {
      return;
    }
    if (!this.data.ready || this.planStepCounts === null) {
      this.setData({ planHint: "先连上灯控读取方案，再新建" });
      return;
    }
    const reserved = planIdsFromSources(this.planStepCountsRecord(), this.planIds);
    const added = addPlan(reserved);
    if (added === null) {
      this.setData({ planHint: "最多四套方案；先删掉一套再新建" });
      return;
    }
    const draft = createEmptyPlanDraft(added.id);
    this.drafts = this.drafts.map((item, index) => (index === added.id ? draft : item));
    this.draftOwned[added.id] = true;
    this.saveDraft(added.id, draft);
    this.planIds = visiblePlanIds(this.planIds, this.planStepCountsRecord(), this.localPlanIds());
    this.timelineIndex = 0;
    this.pickedSegId = -1;
    this.panelKey = "";
    this.setData({ planSlot: added.id, planHint: "" });
    this.renderPlans();
    if (this.data.mode === "advanced") {
      this.renderTimeline();
    }
  },

  /**
   * 删除当前正在显示的那套方案（先二次确认）。
   *
   * 顺序是票面要求的：
   *  1. 二次确认（用户点「取消」什么都不动）；
   *  2. **设备先清**：`ClearScript` 失败就**保留本机草稿**并就地显示原因——
   *     绝不出现「本机没了但设备还在」的静默不一致；
   *  3. 设备清成功后才删本机草稿与 tab，并重读摘要。
   *
   * 删的正是正在播放的那套时，设备侧清空会同时停播（协议语义），这里也
   * 主动停一次兜底：旧固件不认识 0x1E 时会回 UnknownCommand，此时若已经
   * 在播，停播仍然是对的（用户删的就是这套）。
   */
  async onPlanDelete() {
    const target = this.data.planSlot;
    if (this.data.planDeleting >= 0) {
      return;
    }
    const confirmed = await showModal(
      `删除方案 ${this.planTabLabel(target)}？`,
      "方案会从灯控上一起清掉，这个操作不能撤销。",
      "删除",
    );
    if (!confirmed) {
      return;
    }
    this.setData({ planDeleting: target, planHint: "" });
    try {
      const session = this.session;
      if (session === null || !this.data.ready) {
        /* 未连接时不能清设备：**本机草稿保留**，如实说清原因。
         * 这条与「设备拒绝」同一口径——绝不出现「本机没了但设备还在」。 */
        this.setData({ planHint: "未连接灯控，暂时不能删除（设备上的方案清不掉）" });
        return;
      }
      {
        /* 删除正在播放的这套：先停下，避免设备停在一个不存在的方案上。 */
        const state = session.deviceState;
        if (state !== null && planIsPlaying(state, target)) {
          await session.setPlayback(0, (state.flags & 0x01) === 1);
        }
        const cleared = await session.clearScript(target);
        if (cleared.kind === "ack-error") {
          this.setData({
            planHint: `没能从灯控上清掉（${resultText(cleared.ack.resultCode)}）；本机编排已保留`,
          });
          return;
        }
        if (cleared.kind === "error") {
          this.setData({ planHint: `没能从灯控上清掉（${cleared.message}）；本机编排已保留` });
          return;
        }
        if (cleared.kind === "stale") {
          this.setData({ planHint: "连接已经切换，这次删除的结果已放弃；本机编排已保留" });
          return;
        }
        if (cleared.state !== undefined && cleared.state !== null) {
          this.applyDeviceState(cleared.state);
        }
      }

      /* 设备已清：本机草稿与 tab 一起撤掉。 */
      const before = this.planIds;
      const nextSelection = selectionAfterDelete(before, target, target);
      this.removeLocalPlan(target);
      this.planIds = deletePlan(before, target);
      if (this.planIds.length === 0) {
        /* 删光了：补一套空白方案，页面永远有东西可编辑。 */
        const empty = createEmptyPlanDraft(0);
        this.drafts = this.drafts.map((item, index) => (index === 0 ? empty : item));
        this.draftOwned[0] = true;
        this.saveDraft(0, empty);
        this.planIds = initialPlanIds();
        this.setData({ planSlot: 0 });
      } else if (nextSelection !== null) {
        this.setData({ planSlot: nextSelection });
      }
      this.timelineIndex = 0;
      this.pickedSegId = -1;
      this.panelKey = "";
      this.renderPlans();
      if (this.data.mode === "advanced") {
        this.renderTimeline();
      }
      if (this.data.ready) {
        await this.refreshPlanSlots();
      }
    } finally {
      this.setData({ planDeleting: -1 });
    }
  },

  /** 删除本机这一套草稿（内存镜像 + 落盘），别的方案与编号原样保留。 */
  removeLocalPlan(slot: number): void {
    this.draftOwned[slot] = false;
    this.drafts = this.drafts.map((draft, index) =>
      index === slot ? createEmptyPlanDraft(slot) : draft,
    );
    const storage = this.storage;
    const key = this.draftsKey.length > 0 ? this.draftsKey : this.deviceKeyForDrafts();
    if (storage !== null && key.length > 0) {
      removePlanDraft(storage, key, slot);
    }
  },

  /** 方案 tab 的圈码（确认框标题用；界面上的 tab 文案在 `buildPlanTabs`）。 */
  planTabLabel(id: number): string {
    const tab = this.data.planTabs.find((item) => item.id === id);
    return tab === undefined ? "" : tab.label;
  },

  /** 读回 4 个方案编号的步骤数（QueryScript 只回摘要，内容无法读回）。 */
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
      /* 设备上有的方案（哪怕本机没草稿）也要出现在 tab 上才能删得掉。 */
    this.planIds = visiblePlanIds(this.planIds, this.planStepCountsRecord(), this.localPlanIds());
      if (!this.planIds.includes(this.data.planSlot)) {
        this.setData({ planSlot: this.planIds[0] ?? 0 });
      }
    } else {
      this.planStepCounts = null;
    }
    this.renderPlans();
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
      /* 只回填颜色与亮度（hue / sat / level 是精确的协议值）；其它档位设备上无法唯一反推。 */
      this.quickParams = { hue: inferred.hue, sat: inferred.sat };
      /* 熄灭卡读回的 level 恒为 0（协议要求），不能当成用户的亮度选择——
       * 否则从熄灯切回亮灯时会「拖了亮度也还是全黑」。 */
      this.levelDraft = levelDraftFromDevice(inferred.cardId, inferred.level, this.levelDraft);
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
    /* 换卡时参数回到该卡默认值（把呼吸的最暗档带进流光没有意义）。
     * 亮度草稿保留用户值；只有设备上读回过 0（熄灭卡）时才回到默认满亮，
     * 否则点了「暖白常亮」还是会全黑。熄灭卡本身不发光，草稿留着没用也不坏。 */
    this.quickParams = {};
    this.levelDraft = levelAfterCardTap(this.levelDraft);
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
   * 三个滑块（色相 / 饱和度 / 亮度）松手都立刻下发——亮度是 v4 的层字段
   * `level`，写的是**这一条灯组**，与全局亮度无关。
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
      /* v4：亮度是逐光区的层字段，真实写进这一条灯组（不碰全局亮度）。 */
      const spec = buildQuickSpec(card, this.quickParams, stripId, ledCount, this.levelDraft);
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
   * 简单档：有未写入的改动（或设备上不是「整组一张卡」）→ 先写入，成功后再播放。
   * 进阶档：把当前步骤 × 当前灯组的光区写进设备（`replaceStepZonesInList`
   * 语义：只替换这一片，别的灯组 / 别的步骤一字不动），再播放整套方案。
   *
   * 两种档位写入失败都在按钮下方就地显示原因，不弹模态。已经在播放时只给提示，
   * 不重复发播放命令。
   */
  async onApplyAndPlay() {
    const session = this.session;
    const reason = this.disabledReason();
    if (session === null || reason !== "") {
      if (reason !== "") {
        this.setData({ applyError: reason });
      }
      return;
    }
    if (this.data.applying) {
      return;
    }
    if (this.data.mode === "advanced") {
      await this.applyAdvanced();
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

  /**
   * 进阶档的「应用并播放」：先写实时光区，再**下发整份方案**并播放。
   *
   * ## 为什么会话里必须下发方案
   *
   * 固件只在「有一套已提交并启用的方案」时才按方案渲染：没有 `ScriptCommit`
   * + `ActivateScript`，播放头根本没有东西可放，第 2..N 步永远播不到、时长
   * 拖拽条对设备没有任何作用。只写「当前步骤 × 当前灯组」的实时光区只能让
   * 第 1 步亮起来——那是早期实现漏掉的一步，也是 4 个方案槽位变成纯装饰的原因。
   *
   * ## 顺序（两步都要，各有用途）
   *
   *  0. **纯本地预检**（一帧都不发）：`draftToScriptConfig` 展开 → 校验 → 容量；
   *  1. 写入前若在播放 → 先停（设备按方案渲染时实时光区不可见）；
   *  2. **实时光区**：`queryStrip` 读回 → 清掉这一组 → 按草稿逐个 `setSegment`。
   *     这一份是「停止播放时看到的东西」：用户按停止后回落的画面。
   *     清空时先快照，中途失败尽力还原（否则用户看到灯直接灭了）；
   *  3. **整份方案**：`downloadScript(script, { activate: true, loop })`；
   *  4. `setPlayback(1, loop)` 从第 1 步开始播（`activate` 只启用，不等于播）。
   *
   * 预检放在最前面是有意的：草稿本身非法时一帧都不发，设备上的灯保持原样，
   * 用户看到的只是按钮下方一行原因，而不是「灯先闪了一下又报错」。
   *
   * 预检失败与写入失败都落在 `applyError`（按钮下方就地显示），不弹模态。
   * 方案写入失败时**不还原**实时光区：那一步已经成功，用户想要的画面已经写进去了，
   * 只把「方案没提交」这个原因如实说出来。
   */
  async applyAdvanced(): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    const draft = this.currentDraft();
    if (planIsEmpty(draft)) {
      this.setData({ applyError: PANEL_EMPTY_PLAN_GUIDE });
      return;
    }
    /* 当前步骤可能本来就是空的（多步骤方案里「这一步让灯组熄一下」），
     * 这不该拦住整份方案的下发；只有整份方案为空才拒绝。 */
    const zones = this.currentZones();
    const stripId = this.data.stripId;
    this.setPanelHint("");
    this.setData({ applying: true, applyError: "" });
    /* 写入前先快照设备上这一组的光区：清空之后任何一帧失败都能**尽力还原**。 */
    let restore: SegmentSpec[] = [];
    try {
      /* ⓪ 预检（纯本地）。草稿非法时一帧都不发，设备上的灯保持原样。 */
      const script = draftToScriptConfig(draft, session.deviceState?.stripCount ?? 1);
      const precheck = session.validateScriptForDevice(script);
      if (!precheck.ok) {
        this.setData({ applyError: planUserMessage(precheck.message) });
        return;
      }
      /* 新灯效的区间（爆闪 10Hz / 心跳 40-120 BPM）由 `layersCheck` 兜住：
       * 草稿可能来自设备读回或旧版本落盘，不只是这一次的滑块输入。 */
      const layers = script.stages.flatMap((stage) =>
        stage.segments.flatMap((segment) =>
          "layer0" in segment
            ? [segment.layer0, segment.layer1]
            : [layerFromFlat(segment as SegmentConfig)],
        ),
      );
      const layerGate = layersCheck(layers.filter((layer) => layer.type !== NO_EFFECT));
      if (!layerGate.ok) {
        this.setData({ applyError: layerGate.message });
        return;
      }
      /* 容量预检与旧页同口径：只量**这次要写的那一套**。设备上其它槽位的
       * 内容读不回来（只有 4 字节摘要），合计超限只能由设备在 Commit 时发现，
       * 走 `ScriptTooLarge` 的专门文案。 */
      const capacity = checkScriptBlobBytes(
        draftCapacityBytes(this.drafts, [], script.scriptId, script.stripCount),
      );
      if (!capacity.ok) {
        this.setData({
          applyError: `${planUserMessage(capacity.message)}（${PLAN_CAPACITY_NOTE}）`,
        });
        return;
      }

      const state = session.deviceState;
      const loop = state !== null && (state.flags & 0x01) === 1;
      if (state !== null && state.playbackState !== 0) {
        await session.setPlayback(0, loop);
      }

      /* ① 当前步骤 × 当前灯组：先读回、清掉这一组的旧光区，再逐个写。
       * 这一步即使 `zones` 为空也照做——「这一步让这条灯组熄一下」是合法的
       * 编排，实时画面（停止播放后的回落）必须与草稿一致。 */
      try {
        const current = await session.queryStrip(stripId);
        if (current.kind === "ok") {
          this.segmentReports = current.reports.filter((report) => report.stripId === stripId);
        }
        restore = this.segmentReports.map((report) => ({
          stripId: report.stripId,
          segId: report.segId,
          start: report.start,
          end: report.end,
          blend: report.blend,
          layer0: { ...report.layer0 },
          layer1: { ...report.layer1 },
        }));
        for (const report of this.segmentReports) {
          const cleared = await session.clearSegment(stripId, report.segId);
          if (!cleared.ok) {
            throw new Error(resultText(cleared.resultCode));
          }
        }
        for (const zone of zones) {
          const ack = await session.setSegment(zone);
          if (!ack.ok) {
            throw new Error(resultText(ack.resultCode));
          }
        }
      } catch (err) {
        this.setData({ applyError: `写入失败：${errorText(err)}` });
        await this.restoreZones(restore);
        return;
      }

      /* ② 整份方案：写入即启用（`activate`），播放单独走下一帧。 */
      const uploaded = await session.downloadScript(script, { activate: true, loop });
      if (uploaded.kind !== "ok") {
        this.setData({ applyError: this.scriptFailureText(uploaded) });
        await this.refreshSegments();
        return;
      }

      /* ③ 播放（读回的 State 是权威，用它刷播放态）。 */
      const played = await session.setPlayback(1, loop);
      if (played.kind !== "ok") {
        this.setData({ applyError: this.scriptFailureText(played) });
        await this.refreshSegments();
        return;
      }
      if (played.state !== undefined && played.state !== null) {
        this.applyDeviceState(played.state);
      }
      this.setPanelHint("方案已写入并开始播放");
      await this.refreshSegments();
      await this.refreshPlanSlots();
    } finally {
      this.setData({ applying: false });
    }
  },

  /** `ScriptResult` 的非 ok 分支 → 按钮下方的一行原因（术语已换成人话）。 */
  scriptFailureText(result: Exclude<ScriptResult, { kind: "ok" }>): string {
    if (result.kind === "ack-error") {
      return `写入被拒绝（${resultText(result.ack.resultCode)}），灯控上的上一套方案仍可用`;
    }
    if (result.kind === "stale") {
      return "连接已经切换，这次写入的结果已丢弃";
    }
    if (result.kind === "too-large") {
      return `${planUserMessage(result.message)}；灯控上的上一套方案仍可用`;
    }
    return planUserMessage(result.message);
  },

  /**
   * 尽力把写入前的光区写回去（失败路径用，**不再报错**）。
   *
   * 「清空 → 逐个写」之间任何一帧失败都会让这一组变暗；先快照再还原，用户最多
   * 看到灯闪一下，而不是莫名其妙全灭。还原本身失败就算了——原来的错误更重要。
   */
  async restoreZones(zones: readonly SegmentSpec[]): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    try {
      const stripId = this.data.stripId;
      const current = await session.queryStrip(stripId);
      if (current.kind === "ok") {
        for (const report of current.reports.filter((item) => item.stripId === stripId)) {
          await session.clearSegment(stripId, report.segId);
        }
      }
      for (const zone of zones) {
        await session.setSegment(zone);
      }
    } catch {
      /* 还原失败不改变已显示的原始原因。 */
    }
    await this.refreshSegments();
  },
});
