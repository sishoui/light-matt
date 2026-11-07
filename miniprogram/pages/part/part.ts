/**
 * 部位编辑器（二级页，docs/protocol-v5.md §6.1 / §6.2）。
 *
 * ## 为什么单独一页
 *
 * 一个部位的编辑有**两个互不相干的维度**，放在设备页的展开区里会挤成一团：
 *
 *  1. **结构**（布局，0x20–0x23）：这个名字覆盖哪几颗灯珠；
 *  2. **内容**（场景，0x25–0x27）：它在当前场景里的时间轴与两层灯效。
 *
 * ## 页面只做三件事
 *
 * 派生与规则全部在可独立驱动的单元里（#154 的两条判据）：
 *
 *  - **时间轴单元**（`timeline-unit`）：给一组步骤 → 渲染、选中、长按重排、改时长；
 *    本页的最小版只有一步，所以「渲染 / 选中 / 改时长」三条真的在用，
 *    长按重排随 #156 / #157 的多步骤 UI 一起接上（单元本身已能独立驱动）。
 *  - **效果面板单元**（`panel-unit`）：给一层效果 → 切类型、改参数、回读。
 *
 * 页面自己只剩：读设备、把手势交给单元、把单元结果塞进 `setData`、下发。
 *
 * ## 两条写入路径的语义差别（必须在界面上说清）
 *
 *  - **布局**是整份替换（§6.1：`LayoutWrite` 会清空该链的部位），所以改名字
 *    要连同段一起重写，并且**所有链的时钟会被重置**（那是唯一允许打断时钟的
 *    操作）；
 *  - **场景**是单步增量（§6.2：`SceneStep` 直接写 RAM、2 秒防抖落盘），所以
 *    改一层效果不会打断时钟（E2：「编辑不打断时钟」）。
 *
 * 失败原因显示在页面顶部（`applyError`），与 #125 在灯组页的口径一致。
 */

import { errorText, resultText } from "../../utils/ble/errors";
import { pageThemeData } from "../../utils/control/page-theme";
import { createWxStorage } from "../../utils/control/device-cache";
import { queryInt } from "../../utils/control/routes";
import { ControlSession } from "../../utils/control/session";
import { getSession, isMockSession } from "../../utils/control/session-singleton";
import {
  applyPanelChoiceValue,
  applyPanelSliderValue,
  createPanelUnit,
  newStepLayers,
  panelUnitCheck,
  panelUnitLayers,
  panelUnitView,
  selectPanelStep,
  setPanelUnitHint,
  switchPanelMode,
  type PanelTarget,
  type PanelUnit,
} from "../../utils/control/panel-unit";
import {
  PANEL_EMPTY_STEP_GUIDE,
  PANEL_TYPE_OPTIONS,
  type PanelType,
} from "../../utils/control/effect-panel";
import {
  applyTimelineDuration,
  clampTimelineSelection,
  createTimelineUnit,
  selectTimelineStep,
  setTimelineDuration,
  setTimelineLedCount,
  timelineStepDurationMs,
  timelineUnitView,
  type TimelineUnit,
} from "../../utils/control/timeline-unit";
import {
  MAX_STEPS as TIMELINE_MAX_STEPS,
  addStep,
  durationTicks,
  moveBlock,
  removeStep,
  selectionAfterMove,
  type TimelineStep,
} from "../../utils/control/timeline";
import {
  LOOP,
  MAX_PARTS,
  MAX_PART_SEGS,
  MAX_STEPS,
  NAME_BYTES,
  STEP_MAX_MS,
  STEP_MIN_MS,
} from "../../utils/protocol/constants";
import {
  gridColumns,
  gridIndexAtPoint,
  gridRowsView,
  lineBlocks,
  findConflict,
  mergeDeclaredParts,
  normalizeRange,
  partPixelCount,
  rangeTextOf as segsRangeTextOf,
  replaceSeg,
  addSeg,
  validateLayout,
  withSegs,
  type CellRect,
  type GridRowView,
  type LineBlock,
  type PartSeg,
  type SegConflict,
} from "../../utils/control/part-layout";
import type {
  LayoutPart,
  ScenePartReport,
  SceneStepReport,
} from "../../utils/protocol/types";

/** 循环三档的展示名（§7.5）。 */
const LOOP_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: LOOP.NONE, label: "不循环" },
  { value: LOOP.ALL, label: "全部循环" },
  { value: LOOP.LAST, label: "最后一步循环" },
];

Page({
  data: {
    /* 主题三件套（themeClass / dark / accentColor）由 onLoad 铺进去；
     * 这里给默认值，避免首帧读到 undefined。 */
    themeClass: "",
    dark: false,
    mock: false,

    /* ---- 身份 ---- */
    deviceName: "",
    stripId: 0,
    partId: 0,
    /** 标题：部位名或「部位 N」。 */
    title: "部位",
    ready: false,

    /* ---- 结构区（布局，0x21 / 0x23） ---- */
    /** 名字输入框（落盘前只是本地草稿）。 */
    nameInput: "",
    /** 名字字节数 / 上限（UTF-8，中文 3 字节）。 */
    nameBytes: 0,
    nameLimit: NAME_BYTES,
    /** 覆盖的灯珠描述（由 `part-layout` 派生）。 */
    rangeText: "—",
    pixelCount: 0,
    /** 这条链的灯珠数（布局改动的上下文）。 */
    stripLedCount: 0,
    /** 线视图：各部位占的灯珠段（空闲灯珠不产生块 → 灰缝）。 */
    lineBlocks: [] as LineBlock[],
    /** 已覆盖的灯珠数 / 本链总颗数（线视图下方的一行说明）。 */
    coveredCount: 0,
    /** 一个部位的段数 / 上限。 */
    segCount: 0,
    segLimit: MAX_PART_SEGS,
    /** 部位数 / 上限（这条链还塞不塞得下新部位）。 */
    partCount: 0,
    partLimit: MAX_PARTS,

    /* ---- 方格弹窗（U5 / U7） ---- */
    gridOpen: false,
    /** 方格表折成的行（`gridRowsView` 的输出，页面不自己拼状态）。 */
    gridRows: [] as GridRowView[],
    gridColumns: 10,
    /** 本次拖选按住的区间（松手前为草稿）。 */
    draftStartText: "—",
    draftEndText: "—",
    /** 草稿压到别的部位时的提示（S4：整体拒绝）。 */
    draftConflict: "",
    /** 起止数字滚轮的候选（显示用的 1 起颗号；`picker` 的 value 是它的下标）。 */
    pixelOptions: [] as string[],
    /** 滚轮当前值：**0 起下标**（= 物理灯珠序号），显示时 +1。 */
    startIndex: 0,
    endIndex: 0,
    /** 编辑的是哪一段（-1 = 新增）。 */
    editingSegIndex: -1,

    /* ---- 内容区（场景，0x25 / 0x26） ---- */
    /** 当前场景号（State 报的是权威值）。 */
    sceneId: 0,
    sceneLabel: "场景 1",
    /** 本部位在这个场景里的步数。 */
    stepCount: 0,
    stepIndex: 0,
    /** 时间轴的块（`timelineUnitView` 的输出，页面不自己算宽）。 */
    timelineBlocks: [] as ReturnType<typeof timelineUnitView>["blocks"],
    timelineTotalMs: 0,
    timelineCanAdd: false,
    /** 还能不能删（至少留一步）。 */
    timelineCanRemove: false,
    timelineMax: TIMELINE_MAX_STEPS,
    /** 时长条的三个刻度（0.5 / 15 / 30 秒）：标签与位置都由纯函数算好。 */
    durationTicks: durationTicks(),
    /** 时长（毫秒），滑块用 STEP_MIN_MS-STEP_MAX_MS。 */
    durationMs: 3000,
    durationMin: STEP_MIN_MS,
    durationMax: STEP_MAX_MS,
    /** 循环档位。 */
    loopIndex: 0,
    loopOptions: LOOP_OPTIONS.map((item) => item.label),
    /** 部位开关（属于场景）。 */
    on: true,

    /* ---- 效果面板（`panelUnitView` 的输出） ---- */
    panelTypes: [] as ReturnType<typeof panelUnitView>["panelTypes"],
    panelType: "static" as PanelType,
    panelSliders: [] as ReturnType<typeof panelUnitView>["panelSliders"],
    panelChoices: [] as ReturnType<typeof panelUnitView>["panelChoices"],
    panelColorHex: "",
    panelSummary: "",
    panelNotice: "",
    panelHasLayer: false,
    panelGuide: PANEL_EMPTY_STEP_GUIDE,
    hueRamp: "",
    panelHint: "",
    /** 叠加层（第二层）的选项 / 摘要；本票只读展示，编辑留给 #158。 */
    overlayChoices: [] as ReturnType<typeof panelUnitView>["overlayChoices"],
    overlayChoice: "none" as ReturnType<typeof panelUnitView>["overlayChoice"],
    overlayEnabled: false,
    overlaySummary: "",
    overlaySliders: [] as ReturnType<typeof panelUnitView>["overlaySliders"],
    overlayChoices2: [] as ReturnType<typeof panelUnitView>["overlayChoices2"],
    overlayColorHex: "",
    /** 原生控件的激活色（不读 CSS 变量）。 */
    accentColor: "",

    /* ---- 反馈 ---- */
    /** 写入失败原因（页面顶部）。 */
    applyError: "",
    /** 正在下发。 */
    busy: false,
    /** 离线（不能写）时的提示。 */
    hint: "",
  },

  /* ---- 页面私有字段（必须在 onLoad 显式初始化） ---- */
  session: null as ControlSession | null,
  storage: null as ReturnType<typeof createWxStorage> | null,
  themeMode: "system" as "system" | "light" | "dark",
  /** 站点（当前部位）的布局快照，改名时要整份重写。 */
  layoutParts: [] as LayoutPart[],
  /** 当前场景里该部位的时间轴头（步数 / 循环 / 开关）。 */
  scenePart: null as ScenePartReport | null,
  /** 当前场景里该部位的全部步骤（按步号升序，#157）。 */
  sceneSteps: [] as SceneStepReport[],
  /** 当前步骤的两层（只读快照，改一层时另一层原样带回）。 */
  stepSnapshot: null as SceneStepReport | null,
  /** 时间轴单元的交互状态（选中 / 容器宽 / 拖动）。 */
  timeline: createTimelineUnit(),
  /** 效果面板单元（类型 / 参数草稿 / 叠加层 / 亮度记忆）。 */
  panel: createPanelUnit(),
  /** 时间轴模型（本票只有一步；多步骤随 #156 / #157）。 */
  timelineSteps: [] as TimelineStep[],
  /** 写入代次：连点保存时旧一轮静默退出。 */
  applyEpoch: 0,
  /** 订阅解绑。 */
  unsubscribers: [] as Array<() => void>,
  /** 方格表：本次拖选的锚点（-1 = 没有在拖）。 */
  gridAnchor: -1,
  /** 方格表：本次拖选当前的落点（-1 = 没有选区）。 */
  gridCursor: -1,
  /** 方格表每一格的屏幕矩形（拖选开始时量一次，之后全按它命中）。 */
  gridRects: [] as CellRect[],
  /** 方格表的可用宽度（px）；0 = 还没量到。 */
  gridWidth: 0,

  onLoad(options: Record<string, string | undefined>) {
    /* 私有字段显式兜底：Page() 不保证对象字面量字段会被复制到实例上
     * （见 AGENTS.md 的第二个陷阱）。漏掉会让 onLoad 抛错并中断事件绑定。 */
    this.session = null;
    this.storage = null;
    this.themeMode = "system";
    this.layoutParts = [];
    this.scenePart = null;
    this.sceneSteps = [];
    this.stepSnapshot = null;
    this.timeline = createTimelineUnit();
    this.panel = createPanelUnit();
    this.timelineSteps = [];
    this.applyEpoch = 0;
    this.unsubscribers = [];
    this.gridAnchor = -1;
    this.gridCursor = -1;
    this.gridRects = [];
    this.gridWidth = 0;

    const storage = createWxStorage();
    this.storage = storage;
    const theme = pageThemeData(storage);
    this.themeMode = theme.dark ? "dark" : "light";

    const stripId = queryInt(options, "strip", -1);
    const partId = queryInt(options, "part", -1);
    if (stripId < 0 || partId < 0) {
      this.setData({ ...theme, hint: "缺少灯组 / 部位参数", applyError: "无法打开这个部位" });
      return;
    }

    this.session = getSession();
    this.setData({
      ...theme,
      mock: isMockSession(),
      stripId,
      partId,
      title: `部位 ${partId + 1}`,
    });

    this.unsubscribers.push(
      this.session.onState(() => {
        void this.load();
      }),
    );
    void this.load();
  },

  onShow() {
    /* 每次显示都重读主题（「跟随系统」可能在设置页里改过）。 */
    const storage = this.storage;
    if (storage !== null) {
      const theme = pageThemeData(storage);
      this.themeMode = theme.dark ? "dark" : "light";
      this.setData(theme);
    }
    if (this.session !== null) {
      void this.load();
    }
  },

  onUnload() {
    for (const off of this.unsubscribers) {
      off();
    }
    this.unsubscribers = [];
    this.applyEpoch += 1;
  },

  /**
   * 读权威数据并铺界面（§9.1 第 3/4 步）。
   *
   * 两个来源分别是布局（结构）与场景（内容）；任一读不到只影响对应区块，
   * 不让整页变成空白——`applyError` 会说明是哪一半没读到。
   */
  async load(): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    const ready = session.linkState === "ready";
    const stripId = this.data.stripId;
    const partId = this.data.partId;
    if (!ready) {
      this.setData({ ready: false, hint: "设备未连接" });
      return;
    }
    const state = session.deviceState;
    const sceneId = state?.activeScene ?? 0;
    const stripLedCount = state?.stripLedCounts[stripId] ?? 0;

    /* 1) 布局：这条链的全部部位（改名要整份重写，所以必须拿全）。 */
    const layout = await session.queryLayout(stripId);
    if (layout.kind === "stale") {
      return;
    }
    if (layout.kind !== "ok") {
      this.setData({
        ready: true,
        hint: "读不到布局",
        applyError: layout.kind === "error" ? layout.message : "读不到布局",
      });
      return;
    }
    /*
     * §7.2：读回**只报有段的部位**。删掉某个部位的最后一段后它会消失，
     * 但设备上仍在（`State.partCounts` 里有）——按声明数补回，否则这个部位
     * 再也回不来（用户会看到「部位已不存在」）。
     */
    const parts = mergeDeclaredParts(
      layout.layout.parts,
      state?.partCounts[stripId] ?? 0,
      stripId,
    );
    const part = parts.find((item) => item.partId === partId) ?? null;
    this.layoutParts = parts;
    if (part === null) {
      this.setData({ ready: true, hint: "这个部位已经不存在", applyError: "部位已不存在" });
      return;
    }

    /* 2) 场景：当前激活那个（§9.1 第 4 步：只读当前）。 */
    let scene = session.sceneOf(sceneId);
    if (scene === null) {
      const read = await session.queryScene(sceneId);
      if (read.kind === "stale") {
        return;
      }
      scene = read.kind === "ok" ? read.scene : null;
    }
    const scenePart =
      scene === null
        ? null
        : (scene.parts.find((item) => item.stripId === stripId && item.partId === partId) ??
          null);
    this.scenePart = scenePart;
    this.sceneSteps =
      scene === null
        ? []
        : scene.steps
            .filter((item) => item.stripId === stripId && item.partId === partId)
            .sort((a, b) => a.stepIndex - b.stepIndex);

    /*
     * 3) 时间轴模型：**整条时间轴**（#157 起每个部位 0–8 步）。
     *
     * 设备上 0 步时给一个默认步——否则用户面对的是空时间轴，连时长条都没得调。
     * 这只是本地草稿，要点「下发」才会真的建出那一步。
     */
    const steps: TimelineStep[] =
      this.sceneSteps.length === 0
        ? [{ durationMs: 3000, zones: [] }]
        : this.sceneSteps.map((item) => ({ durationMs: item.durationMs, zones: [] }));
    this.timelineSteps = steps;
    this.timeline = setTimelineLedCount(this.timeline, stripLedCount);
    this.timeline = clampTimelineSelection(this.timeline, steps.length);
    const timeline = timelineUnitView(steps, this.timeline);

    /* 4) 效果面板绑到**当前选中的那一步**（选别的块就换一组参数）。 */
    const stepIndex = timeline.selected;
    this.stepSnapshot = this.stepAt(stepIndex);
    const target: PanelTarget = { sceneId, stripId, partId, stepIndex, layer: 0 };
    this.panel = selectPanelStep(this.panel, target, this.stepSnapshot);
    const panel = panelUnitView(this.panel, { hasLayer: this.stepSnapshot !== null });

    const name = part.name;
    const blocks = lineBlocks(parts, stripLedCount, partId);
    this.setData({
      ready: true,
      hint: "",
      deviceName: session.cachedDevice?.name ?? "",
      title: name.length > 0 ? name : `部位 ${partId + 1}`,
      nameInput: name,
      nameBytes: nameBytesOf(name),
      rangeText: segsRangeTextOf(part.segs, stripLedCount),
      pixelCount: partPixelCount(part),
      stripLedCount,
      lineBlocks: blocks,
      coveredCount: coveredPixels(blocks),
      segCount: part.segs.length,
      segLimit: MAX_PART_SEGS,
      partCount: parts.length,
      partLimit: MAX_PARTS,
      sceneId,
      sceneLabel: sceneId === 0 ? "场景 1" : `场景 ${sceneId + 1}`,
      stepCount: scenePart?.stepCount ?? 0,
      stepIndex: timeline.selected,
      timelineBlocks: timeline.blocks,
      timelineTotalMs: timeline.totalMs,
      timelineCanAdd: timeline.canAdd,
      loopIndex: loopIndexOf(scenePart?.loop ?? LOOP.NONE),
      on: scenePart?.on ?? false,
      durationMs: timelineStepDurationMs(steps, timeline.selected),
      ...panel,
    });
  },

  /* ---------------- 时间轴（`timeline-unit`） ---------------- */

  /** 点一块选中（多步骤时才有第二块；本票的列表只有一步）。 */
  onStepTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index ?? -1);
    const next = selectTimelineStep(this.timeline, index, this.timelineSteps.length);
    if (next === this.timeline) {
      return;
    }
    this.timeline = next;
    /* 选中别的步 → 效果面板换那一组的参数（每步两层各一份）。 */
    this.stepSnapshot = this.stepAt(next.selected);
    this.panel = selectPanelStep(
      this.panel,
      {
        sceneId: this.data.sceneId,
        stripId: this.data.stripId,
        partId: this.data.partId,
        stepIndex: next.selected,
        layer: 0,
      },
      this.stepSnapshot,
    );
    this.applyTimelineToData();
    this.applyPanelToData();
  },

  /**
   * 加一步（≤8）。
   *
   * 新步默认 1 秒、常亮——「点一下就有东西」而不是面对一个空块。加完立刻选中它，
   * 用户接着调的就是这一步。
   */
  onAddStep() {
    const result = addStep(this.timelineSteps);
    if (result === null) {
      this.setData({ applyError: `一个部位最多 ${MAX_STEPS} 步` });
      return;
    }
    this.timelineSteps = result.steps;
    this.timeline = selectTimelineStep(this.timeline, result.selected, result.steps.length);
    this.stepSnapshot = null;
    this.applyTimelineToData();
    void this.pushSteps();
  },

  /** 删掉选中的那一步（0 步 = 本场景不演，由「循环/开关」之外的另一条路）。 */
  onRemoveStep() {
    if (this.timelineSteps.length <= 1) {
      this.setData({ applyError: "至少留一步（要停演就把循环关掉或关掉这个部位）" });
      return;
    }
    const result = removeStep(this.timelineSteps, this.timeline.selected, this.timeline.selected);
    this.timelineSteps = result.steps;
    this.timeline = clampTimelineSelection(this.timeline, result.steps.length);
    this.stepSnapshot = this.stepAt(this.timeline.selected);
    this.applyTimelineToData();
    void this.pushSteps();
  },

  /** 长按拖动结束后重排（`moveBlock` + `selectionAfterMove`）。 */
  onStepReorder(e: { detail?: { from?: number; to?: number } }) {
    const from = Number(e.detail?.from ?? -1);
    const to = Number(e.detail?.to ?? -1);
    if (from < 0 || to < 0 || from === to) {
      return;
    }
    const reordered = moveBlock([...this.timelineSteps], from, to);
    if (reordered === this.timelineSteps) {
      return;
    }
    this.timelineSteps = reordered;
    this.timeline = {
      ...this.timeline,
      selected: selectionAfterMove(this.timeline.selected, from, to),
    };
    this.stepSnapshot = this.stepAt(this.timeline.selected);
    this.applyTimelineToData();
    void this.pushSteps();
  },

  /** 时长滑块（秒）：落进模型并刷新块宽。 */
  onDurationChange(e: WechatMiniprogram.SliderChange) {
    const seconds = Number(e.detail.value);
    const next = applyTimelineDuration(this.timelineSteps, this.timeline.selected, seconds);
    if (next === this.timelineSteps) {
      return;
    }
    this.timelineSteps = next;
    this.applyTimelineToData();
  },

  /** 时长条的三个刻度（点一下直接跳到那一档）。 */
  onDurationTick(e: WechatMiniprogram.TouchEvent) {
    const durationMs = Number(e.currentTarget.dataset.ms ?? 0);
    const next = setTimelineDuration(this.timelineSteps, this.timeline.selected, durationMs);
    if (next === this.timelineSteps) {
      return;
    }
    this.timelineSteps = next;
    this.applyTimelineToData();
  },

  /** 时间轴的派生（`timelineUnitView` 的唯一调用点）。 */
  applyTimelineToData() {
    const view = timelineUnitView(this.timelineSteps, this.timeline);
    this.setData({
      stepIndex: view.selected,
      timelineBlocks: view.blocks,
      timelineTotalMs: view.totalMs,
      timelineCanAdd: view.canAdd,
      timelineCanRemove: view.stepCount > 1,
      stepCount: view.stepCount,
      durationMs: timelineStepDurationMs(this.timelineSteps, view.selected),
    });
  },

  /** 设备上某一步的两层（0 步 / 越界给 null）。 */
  stepAt(stepIndex: number): SceneStepReport | null {
    return this.sceneSteps.find((item) => item.stepIndex === stepIndex) ?? null;
  },

  /**
   * 把整条时间轴写回设备（#157：加 / 删 / 重排步骤之后）。
   *
   * 顺序是协议规定的：先 `ScenePart` 声明步数（**步数真变了才清空步骤**，
   * §6.2），再逐步 `SceneStep`。所以这里必须先把步数写够，否则后面的
   * `SceneStep` 会因为 `step_index >= step_count` 被拒。
   *
   * 与 #125 同一条口径：失败原因显示在页面顶部；成功刷新读回缓存。
   * 下发期间**不阻塞**用户继续编辑——代次号让旧一轮在 await 之后静默退出。
   */
  async pushSteps(): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    const sceneId = this.data.sceneId;
    const stripId = this.data.stripId;
    const partId = this.data.partId;
    const stepCount = this.timelineSteps.length;
    this.applyEpoch += 1;
    const epoch = this.applyEpoch;
    this.setData({ busy: true, applyError: "" });
    try {
      const head = await session.setScenePart(
        sceneId,
        stripId,
        partId,
        stepCount,
        LOOP_OPTIONS[this.data.loopIndex]?.value ?? LOOP.NONE,
        this.data.on,
      );
      if (epoch !== this.applyEpoch) {
        return;
      }
      if (head.kind === "ack-error" || head.kind === "error") {
        this.setData({ applyError: describeFailure(head) });
        return;
      }
      for (let index = 0; index < stepCount; index += 1) {
        const existing = this.stepAt(index);
        const layers = existing === null ? newStepLayers() : {
          layer0: existing.layer0,
          layer1: existing.layer1,
        };
        const written = await session.setSceneStep({
          sceneId,
          stripId,
          partId,
          stepIndex: index,
          durationMs: timelineStepDurationMs(this.timelineSteps, index),
          layer0: layers.layer0,
          layer1: layers.layer1,
        });
        if (epoch !== this.applyEpoch) {
          return;
        }
        if (written.kind === "ack-error" || written.kind === "error") {
          this.setData({ applyError: describeFailure(written) });
          return;
        }
      }
      await this.load();
    } catch (err) {
      this.setData({ applyError: errorText(err) });
    } finally {
      if (epoch === this.applyEpoch) {
        this.setData({ busy: false });
      }
    }
  },

  /* ---------------- 效果面板（`panel-unit`） ---------------- */

  /** 换效果类型（只改主效果；叠加层留给 #158）。 */
  onPanelTypeTap(e: WechatMiniprogram.TouchEvent) {
    const type = String(e.currentTarget.dataset.type ?? "") as PanelType;
    if (!PANEL_TYPE_OPTIONS.some((option) => option.type === type)) {
      return;
    }
    const next = switchPanelMode(this.panel, type);
    if (next === this.panel) {
      return;
    }
    this.panel = next;
    this.applyPanelToData();
  },

  /** 主效果的滑块（色相 / 饱和度 / 亮度 / 周期 / 最低亮 / 跨度 / 尾长 / 频率 / 节奏 / 密度）。 */
  onPanelSliderChange(e: WechatMiniprogram.SliderChange) {
    const key = String(e.currentTarget.dataset.key ?? "");
    const next = applyPanelSliderValue(this.panel, key, Number(e.detail.value));
    if (next === this.panel) {
      return;
    }
    this.panel = next;
    this.applyPanelToData();
  },

  /** 主效果的选择控件（波形 / 方向 / 占空比 / 脉冲）。 */
  onPanelChoiceTap(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key ?? "");
    const value = Number(e.currentTarget.dataset.value ?? Number.NaN);
    const next = applyPanelChoiceValue(this.panel, key, value);
    if (next === this.panel) {
      return;
    }
    this.panel = next;
    this.applyPanelToData();
  },

  /** 面板的派生（`panelUnitView` 的唯一调用点）。 */
  applyPanelToData() {
    const view = panelUnitView(this.panel, { hasLayer: this.stepSnapshot !== null });
    this.setData({ ...view });
  },

  /* ---------------- 结构区（布局） ---------------- */

  /** 名字输入：只记本地草稿与字节数（没按保存就不下发）。 */
  onNameInput(e: WechatMiniprogram.Input) {
    const text = String(e.detail.value ?? "").slice(0, 24);
    this.setData({ nameInput: text, nameBytes: nameBytesOf(text) });
  },

  /**
   * 点线视图上的一段 → 弹「编辑 / 删除」（U6）。
   *
   * 只对**本部位**的段弹菜单：别的部位的段点不动——要改它们得先进那个部位，
   * 这是「编辑只改这一段」的边界。
   */
  onLineBlockTap(e: WechatMiniprogram.TouchEvent) {
    const dataset = e.currentTarget.dataset as { partId?: number | string; segIndex?: number | string };
    const partId = Number(dataset.partId ?? -1);
    const segIndex = Number(dataset.segIndex ?? -1);
    if (partId !== this.data.partId || segIndex < 0) {
      return;
    }
    const seg = this.currentPart()?.segs[segIndex];
    if (seg === undefined) {
      return;
    }
    wx.showActionSheet({
      itemList: ["编辑这一段", "删除这一段"],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.openGrid(segIndex);
        } else if (res.tapIndex === 1) {
          void this.removeSeg(segIndex);
        }
      },
      fail: () => undefined,
    });
  },

  /** 打开方格弹窗（-1 = 新增一段）。 */
  onOpenGridAdd() {
    if (this.data.segCount >= this.data.segLimit) {
      this.setData({ applyError: `一个部位最多 ${this.data.segLimit} 段` });
      return;
    }
    this.openGrid(-1);
  },

  /** 打开方格弹窗（-1 = 新增一段）。 */
  openGrid(segIndex: number) {    const ledCount = this.data.stripLedCount;
    if (ledCount < 1) {
      this.setData({ applyError: "这条灯组没有灯珠" });
      return;
    }
    const seg = segIndex >= 0 ? this.currentPart()?.segs[segIndex] : undefined;
    this.gridAnchor = -1;
    this.gridCursor = -1;
    this.gridRects = [];
    this.setData({
      gridOpen: true,
      editingSegIndex: segIndex,
      /* 候选是显示文本（1 起）；picker 的 value 是它的下标 = 物理序号。 */
      pixelOptions: Array.from({ length: ledCount }, (_, index) => String(index + 1)),
      startIndex: seg?.[0] ?? 0,
      endIndex: seg?.[1] ?? 0,
      draftStartText: seg === undefined ? "—" : String(seg[0] + 1),
      draftEndText: seg === undefined ? "—" : String(seg[1] + 1),
      draftConflict: "",
    });
    this.refreshGrid(null);
    /* 折列要按真实宽度算：等弹窗渲染出来再量一次。 */
    this.measureGrid();
  },

  /** 关掉方格弹窗（拖动中的草稿一并丢弃）。 */
  onGridClose() {
    this.gridAnchor = -1;
    this.gridCursor = -1;
    this.gridRects = [];
    this.setData({ gridOpen: false, draftConflict: "" });
  },

  /**
   * 量方格表的宽度与每一格的矩形。
   *
   * 为什么现在就在 Node 里也能跑通：`createSelectorQuery` 缺失（单测 / 老基础库）
   * 时只跳过几何，列数按未测量兜底，拖选仍能靠 `dataset.index` 工作。
   */
  measureGrid() {
    const query = wx.createSelectorQuery?.();
    if (query === undefined) {
      return;
    }
    query
      .select(".grid-wrap")
      .boundingClientRect()
      .selectAll(".grid-cell")
      .boundingClientRect()
      .exec((results: Array<any>) => {
        if (!this.data.gridOpen) {
          return;
        }
        const wrap = results?.[0];
        const cells = results?.[1];
        if (Array.isArray(cells)) {
          this.gridRects = cells.map((rect: any, position: number) => ({
            index: Number(rect.id ?? position),
            left: Number(rect.left),
            top: Number(rect.top),
            right: Number(rect.right),
            bottom: Number(rect.bottom),
          }));
        }
        if (wrap !== undefined && Number(wrap.width) > 0) {
          this.gridWidth = Number(wrap.width);
          const columns = gridColumns(this.data.stripLedCount, this.gridWidth);
          if (columns !== this.data.gridColumns) {
            this.setData({ gridColumns: columns });
            /* 折行变了，矩形要重量。 */
            if (Array.isArray(cells) && cells.length > 0) {
              this.measureGrid();
            }
          }
        }
        this.refreshGrid(this.draftSeg());
      });
  },

  /** 方格表按下：记锚点。 */
  onGridTouchStart(e: WechatMiniprogram.TouchEvent) {
    const index = this.gridIndexFromEvent(e);
    if (index < 0) {
      return;
    }
    this.gridAnchor = index;
    this.gridCursor = index;
    this.applyDraft([index, index]);
  },

  /** 方格表拖动：更新落点（手指在两行之间时取最近一格）。 */
  onGridTouchMove(e: WechatMiniprogram.TouchEvent) {
    if (this.gridAnchor < 0) {
      return;
    }
    /*
     * 有矩形就按屏幕坐标命中（最准）；没有矩形（还没量到 / 量测被跳过）时
     * 退回 `dataset.index` —— 那是每格自己带的序号，不依赖几何。
     * 真机上 `touches[0]` 一定在；这里不因它缺失就直接返回，否则量测一旦
     * 失败整个拖选就完全没反应。
     */
    const index = this.gridIndexFromEvent(e);
    if (index < 0) {
      return;
    }
    const range = normalizeRange(this.gridAnchor, index);
    if (range === null) {
      return;
    }
    if (this.gridCursor === index) {
      return;
    }
    this.gridCursor = index;
    this.applyDraft(range);
  },

  /** 方格表松手：草稿留着供「确认新增 / 保存」，锚点清掉。 */
  onGridTouchEnd() {
    if (this.gridAnchor < 0) {
      return;
    }
    this.gridAnchor = -1;
  },

  /** 滚轮微调：起点 / 终点各一个（U7）。`detail.value` 就是物理灯珠序号（0 起）。 */
  onStartPick(e: WechatMiniprogram.PickerChange) {
    this.applyDraft(normalizeRange(Number(e.detail.value), this.data.endIndex));
  },

  onEndPick(e: WechatMiniprogram.PickerChange) {
    this.applyDraft(normalizeRange(this.data.startIndex, Number(e.detail.value)));
  },

  /**
   * 确认这一段（新增或保存编辑）。
   *
   * 冲突已经在草稿阶段显示出来了（`draftConflict`），但**这里还要再判一次**：
   * 从画斜纹到用户按确认之间，用户可能切到别处又回来，缓存里的布局可能已经
   * 变了（例如设备页那边加了部位）。所以「能不能提交」以这一刻的布局为准。
   */
  async onGridConfirm() {
    const seg = this.draftSeg();
    if (seg === null) {
      this.setData({ draftConflict: "先拖选或滚动选择一段灯珠" });
      return;
    }
    const parts = this.layoutParts;
    const ledCount = this.data.stripLedCount;
    const editing = this.data.editingSegIndex;
    const result =
      editing >= 0
        ? replaceSeg(parts, this.data.partId, editing, seg, ledCount)
        : addSeg(parts, this.data.partId, seg, ledCount);
    if ("error" in result) {
      /* 两处都写：弹窗里就地提示，顶部的 `applyError` 关掉弹窗后还看得见。 */
      this.setData({ draftConflict: result.error, applyError: result.error });
      return;
    }
    const ok = await this.commitLayout(withSegs(parts, this.data.partId, result.segs), "区间已保存");
    if (ok) {
      this.onGridClose();
    }
  },

  /** 删除一段（点线视图上的段 → 删除）：那几颗灯变黑。 */
  async removeSeg(segIndex: number) {
    const parts = this.layoutParts;
    const result = replaceSeg(parts, this.data.partId, segIndex, null, this.data.stripLedCount);
    if ("error" in result) {
      this.setData({ applyError: result.error });
      return;
    }
    await this.commitLayout(withSegs(parts, this.data.partId, result.segs), "已删除这一段");
  },

  /** 当前编辑的部位（缓存里的布局）。 */
  currentPart(): LayoutPart | null {
    return this.layoutParts.find((item) => item.partId === this.data.partId) ?? null;
  },

  /** 草稿区间对应的 `[start, end]`（0 起）；两轮值相等时仍给单颗段。 */
  draftSeg(): PartSeg | null {
    const start = this.data.draftStartText;
    const end = this.data.draftEndText;
    if (start === "—" || end === "—") {
      return null;
    }
    return normalizeRange(Number(start) - 1, Number(end) - 1);
  },

  /** 把草稿区间落进界面并刷新方格 + 冲突提示。 */
  applyDraft(range: PartSeg | null) {
    if (range === null) {
      return;
    }
    const parts = this.layoutParts;
    const editing = this.data.editingSegIndex;
    const conflict = findConflict(
      parts,
      range,
      editing >= 0 ? { partId: this.data.partId, segIndex: editing } : null,
    );
    this.setData({
      draftStartText: String(range[0] + 1),
      draftEndText: String(range[1] + 1),
      startIndex: range[0],
      endIndex: range[1],
      draftConflict: conflict === null ? "" : segConflictText(conflict),
    });
    this.refreshGrid(range);
  },

  /** 重画方格表的行（`gridRowsView` 的唯一调用点）。 */
  refreshGrid(draft: PartSeg | null) {
    const parts = this.layoutParts;
    const editing = this.data.editingSegIndex;
    const conflict =
      draft === null
        ? null
        : findConflict(
            parts,
            draft,
            editing >= 0 ? { partId: this.data.partId, segIndex: editing } : null,
          );
    this.setData({
      gridRows: gridRowsView(
        this.data.stripLedCount,
        this.data.gridColumns,
        parts,
        this.data.partId,
        draft,
        conflict,
      ),
    });
  },

  /** 触摸事件 → 格子序号（没有矩形时的退路：靠 `dataset.index`）。 */
  gridIndexFromEvent(e: WechatMiniprogram.TouchEvent): number {
    const touch = e.touches?.[0] ?? e.changedTouches?.[0];
    if (touch !== undefined && this.gridRects.length > 0) {
      const hit = gridIndexAtPoint(
        this.gridRects,
        Number(touch.clientX),
        Number(touch.clientY),
      );
      if (hit >= 0) {
        return hit;
      }
    }
    const dataset = (e.currentTarget.dataset ?? {}) as { index?: number | string };
    const index = Number(dataset.index ?? -1);
    return Number.isInteger(index) && index >= 0 ? index : -1;
  },

  /**
   * 提交一份布局（整份重写 + 立即落盘）。
   *
   * 本地先跑一遍与固件同一份的校验：能在这里拦下的（越界 / 重叠 / 超段数）
   * 就不发帧——设备回 `InvalidParam` 时用户只看到一句错误码，看不出是哪一段。
   * 返回是否成功（弹窗据此决定要不要关）。
   */
  async commitLayout(parts: LayoutPart[], okText: string): Promise<boolean> {
    const session = this.session;
    if (session === null || this.data.busy) {
      return false;
    }
    const issue = validateLayout(parts, this.data.stripLedCount);
    if (issue !== null) {
      this.setData({ applyError: issue.message, draftConflict: issue.message });
      return false;
    }
    this.applyEpoch += 1;
    const epoch = this.applyEpoch;
    this.setData({ busy: true, applyError: "" });
    try {
      const result = await session.writeLayout(this.data.stripId, parts);
      if (epoch !== this.applyEpoch) {
        return false;
      }
      if (result.kind === "ok" || result.kind === "storage") {
        if (result.kind === "storage") {
          this.setData({ applyError: "已生效但未保存到设备（存储失败）" });
        } else {
          wx.showToast({ title: okText, icon: "none" });
        }
        await this.load();
        return true;
      }
      this.setData({ applyError: describeFailure(result) });
      return false;
    } catch (err) {
      this.setData({ applyError: errorText(err) });
      return false;
    } finally {
      this.setData({ busy: false });
    }
  },

  /**
   * 保存名字（**布局族**：整份重写 + 立即落盘）。
   *
   * 为什么整份重写：`LayoutWrite` 会清空该链的全部部位（§6.1 第 1 条），
   * 所以「只改一个名字」也必须把其它部位原样带上，否则它们会被抹掉。
   */
  async onSaveName() {
    const session = this.session;
    if (session === null || this.data.busy) {
      return;
    }
    const name = this.data.nameInput.trim();
    if (nameBytesOf(name) > NAME_BYTES) {
      this.setData({ applyError: `名字超过 ${NAME_BYTES} 字节` });
      return;
    }
    const parts = this.layoutParts.map((part) =>
      part.partId === this.data.partId
        ? { ...part, name, nameLen: nameBytesOf(name) }
        : { ...part },
    );
    await this.commitLayout(parts, "名字已保存");
  },

  /* ---------------- 内容区（场景） ---------------- */

  /** 部位开关（属于场景；只灭灯、不停时钟）。 */
  onToggleOn(e: WechatMiniprogram.SwitchChange) {
    this.setData({ on: Boolean(e.detail.value) });
  },

  /** 循环三档（§7.5）。 */
  onLoopChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ loopIndex: Number(e.detail.value) });
  },

  /**
   * 保存内容（**场景族**：ScenePart + SceneStep，单步增量）。
   *
   * 顺序固定（§6.2）：先写时间轴头（步数 / 循环 / 开关），再写这一步的两层。
   * 步数不变时设备**不会**清空已有步骤，所以「只改颜色」不会抹掉时间轴。
   */
  async onSaveContent() {
    const session = this.session;
    if (session === null || this.data.busy) {
      return;
    }
    /* 本地预检：越界的频率 / 节奏一帧都不发，原因就地显示。 */
    const check = panelUnitCheck(this.panel);
    if (!check.ok) {
      this.setData({ applyError: check.message });
      return;
    }

    const sceneId = this.data.sceneId;
    const stripId = this.data.stripId;
    const partId = this.data.partId;
    const stepCount = Math.max(
      1,
      Math.min(MAX_STEPS, this.data.stepCount === 0 ? 1 : this.data.stepCount),
    );
    const loop = LOOP_OPTIONS[this.data.loopIndex]?.value ?? LOOP.NONE;
    /* 时长与两层都来自各自的单元（页面不再自己算参数）。 */
    const durationMs = timelineStepDurationMs(this.timelineSteps, this.timeline.selected);
    const layers = panelUnitLayers(this.panel);

    this.applyEpoch += 1;
    const epoch = this.applyEpoch;
    this.setData({ busy: true, applyError: "" });
    try {
      /* 1) 时间轴头。步数从 0 → 1 会建出第一步；之后改循环 / 开关不动时间轴。 */
      const head = await session.setScenePart(
        sceneId,
        stripId,
        partId,
        stepCount,
        loop,
        this.data.on,
      );
      if (epoch !== this.applyEpoch) {
        return;
      }
      if (head.kind === "ack-error" || head.kind === "error" || head.kind === "storage") {
        this.setData({ applyError: describeFailure(head) });
        return;
      }

      /* 2) 这一步的两层：都由面板单元装配（主效果 + 叠加层）。 */
      const step = await session.setSceneStep({
        sceneId,
        stripId,
        partId,
        stepIndex: this.timeline.selected,
        durationMs,
        layer0: layers.layer0,
        layer1: layers.layer1,
      });
      if (epoch !== this.applyEpoch) {
        return;
      }
      if (step.kind === "ok" || step.kind === "storage") {
        if (step.kind === "storage") {
          this.panel = setPanelUnitHint(this.panel, "已生效但未保存到设备");
          this.setData({ applyError: "已生效但未保存到设备" });
        } else {
          wx.showToast({ title: "已下发", icon: "none" });
        }
        await this.load();
        return;
      }
      this.setData({ applyError: describeFailure(step) });
    } catch (err) {
      this.setData({ applyError: errorText(err) });
    } finally {
      this.setData({ busy: false });
    }
  },

  /** 退回设备页（导航栏返回键在 nav-bar 里；这里给一个显式的按钮）。 */
  onBack() {
    wx.navigateBack({ fail: () => undefined });
  },

  /** 关掉顶部的失败提示。 */
  onDismissApplyError() {
    if (this.data.applyError.length === 0) {
      return;
    }
    this.setData({ applyError: "" });
  },
});

/** 名字的 UTF-8 字节数（与构造器的校验同一个口径）。 */
function nameBytesOf(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** 线视图所有块盖住的灯珠数（空闲灯珠不计）。 */
function coveredPixels(blocks: readonly LineBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    total += block.end - block.start + 1;
  }
  return total;
}

/** 草稿压到别的部位时的提示（说清被占的是哪几颗、属于谁）。 */
function segConflictText(conflict: SegConflict): string {
  return `第 ${conflict.overlap[0] + 1}–${conflict.overlap[1] + 1} 颗已被部位 ${conflict.partId + 1} 占用`;
}

function loopIndexOf(loop: number): number {
  const index = LOOP_OPTIONS.findIndex((item) => item.value === loop);
  return index < 0 ? 0 : index;
}

/** 写命令失败的统一文案（StorageFailed 单独说「已生效但未保存」）。 */
function describeFailure(result: {
  kind: string;
  message?: string;
  ack?: { resultCode: number };
}): string {
  if (result.kind === "storage") {
    return "已生效但未保存到设备（存储失败）";
  }
  if (result.kind === "ack-error" && result.ack !== undefined) {
    return resultText(result.ack.resultCode);
  }
  if (result.kind === "error") {
    return result.message ?? "写入失败";
  }
  if (result.kind === "stale") {
    return "连接已切换，这次写入作废";
  }
  return "写入失败";
}

/** 两个单元的类型留在这里可读（页面私有字段的注解来源）。 */
export type PartPageUnits = { timeline: TimelineUnit; panel: PanelUnit };
