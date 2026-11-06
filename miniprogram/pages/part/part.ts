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
  durationTicks,
  type TimelineStep,
} from "../../utils/control/timeline";
import {
  LOOP,
  MAX_STEPS,
  NAME_BYTES,
  STEP_MAX_MS,
  STEP_MIN_MS,
} from "../../utils/protocol/constants";
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
    /** 覆盖的灯珠描述（只读；改区间是后续票）。 */
    rangeText: "—",
    pixelCount: 0,
    /** 这条链的灯珠数（布局改动的上下文）。 */
    stripLedCount: 0,

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

  onLoad(options: Record<string, string | undefined>) {
    /* 私有字段显式兜底：Page() 不保证对象字面量字段会被复制到实例上
     * （见 AGENTS.md 的第二个陷阱）。漏掉会让 onLoad 抛错并中断事件绑定。 */
    this.session = null;
    this.storage = null;
    this.themeMode = "system";
    this.layoutParts = [];
    this.scenePart = null;
    this.stepSnapshot = null;
    this.timeline = createTimelineUnit();
    this.panel = createPanelUnit();
    this.timelineSteps = [];
    this.applyEpoch = 0;
    this.unsubscribers = [];

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
    const parts = layout.layout.parts;
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
    const step =
      scene === null || scenePart === null
        ? null
        : (scene.steps.find(
            (item) =>
              item.stripId === stripId && item.partId === partId && item.stepIndex === 0,
          ) ?? null);
    this.stepSnapshot = step;

    /* 3) 时间轴模型：本票只有「设备上那一步」（0 步时给一个默认步）。 */
    const steps: TimelineStep[] =
      step === null ? [{ durationMs: 3000, zones: [] }] : [{ durationMs: step.durationMs, zones: [] }];
    this.timelineSteps = steps;
    this.timeline = setTimelineLedCount(this.timeline, stripLedCount);
    this.timeline = clampTimelineSelection(this.timeline, steps.length);
    const timeline = timelineUnitView(steps, this.timeline);

    /* 4) 效果面板：一次读回两层（`panel-unit` 负责主效果与叠加层）。 */
    const target: PanelTarget = { sceneId, stripId, partId, stepIndex: 0, layer: 0 };
    this.panel = selectPanelStep(this.panel, target, step);
    const panel = panelUnitView(this.panel, { hasLayer: step !== null });

    const name = part.name;
    this.setData({
      ready: true,
      hint: "",
      deviceName: session.cachedDevice?.name ?? "",
      title: name.length > 0 ? name : `部位 ${partId + 1}`,
      nameInput: name,
      nameBytes: nameBytesOf(name),
      rangeText: rangeTextOf(part, stripLedCount),
      pixelCount: partPixelCount(part),
      stripLedCount,
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
    this.applyTimelineToData();
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
      durationMs: timelineStepDurationMs(this.timelineSteps, view.selected),
    });
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
    this.applyEpoch += 1;
    const epoch = this.applyEpoch;
    this.setData({ busy: true, applyError: "" });
    try {
      const result = await session.writeLayout(this.data.stripId, parts);
      if (epoch !== this.applyEpoch) {
        return;
      }
      if (result.kind === "ok") {
        wx.showToast({ title: "名字已保存", icon: "none" });
        await this.load();
        return;
      }
      this.setData({ applyError: describeFailure(result) });
    } catch (err) {
      this.setData({ applyError: errorText(err) });
    } finally {
      this.setData({ busy: false });
    }
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

/** 部位覆盖的灯珠描述（区间按用户视角从 1 编号）。 */
function rangeTextOf(part: LayoutPart, ledCount: number): string {
  if (part.segs.length === 0) {
    return "未划灯珠";
  }
  const pieces = part.segs.map(([start, end]) => `${start + 1}–${end + 1}`);
  if (
    part.segs.length === 1 &&
    part.segs[0][0] === 0 &&
    part.segs[0][1] >= Math.max(0, ledCount - 1)
  ) {
    return `${pieces[0]}（整条）`;
  }
  return pieces.join("、");
}

function partPixelCount(part: LayoutPart): number {
  let total = 0;
  for (const [start, end] of part.segs) {
    if (end >= start) {
      total += end - start + 1;
    }
  }
  return total;
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
