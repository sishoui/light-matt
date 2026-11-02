/**
 * 段编辑页（二级页，#42）：区间 + 两层灯效 + blend。
 *
 * 本页只做三件事，边界与 spec §3.4 严格一致：
 *  1. **草稿在页面**：所有编辑写到 `this.draft`（`SegmentDraft`），不下发；
 *  2. **提交前拦下**：区间 / 重叠 / 周期下限 / 空层 / 保留位全部由
 *     `utils/control/segment-editor.ts` 判定，`InvalidParam` 不是第一道防线；
 *  3. **设备权威**：点「应用」→ SetSegment → ACK → `QueryStrip(该带)` → 用
 *     设备返回值重建草稿。直接返回 = 丢弃草稿，绝不静默下发。
 *
 * 灯带号来自 URL（灯光页传当前带），页面内所有设备调用都显式带上它；
 * 不存在「缺省灯带 0」的隐式回落——编辑第 3 条带不能碰第 1、2 条。
 *
 * 两层是**定宽**的：`layer1` 为空用 `NO_EFFECT`，UI 上只有「第 1 层 / 第 2 层」
 * 两个入口，不存在第三条层的路径。
 */

import { resultText } from "../../utils/ble/errors";
import {
  BLEND as BLEND_VALUE,
  MAX_PERIOD_MS,
  MAX_SEGMENTS,
  MAX_STRIPS,
  NO_EFFECT,
  SEGMENT_TYPE,
  WAVEFORM,
  WAVEFORM_NAMES,
} from "../../utils/protocol/constants";
import type {
  BlendMode,
  DeviceState,
  EffectLayer,
  LinkState,
  SegmentReport,
  SegmentSpec,
  SegmentTarget,
} from "../../utils/protocol/types";
import { PRESETS, rgbToHex, rgbToSegmentParams, segmentHueSatToRgb } from "../../utils/color/hsv";
import {
  blendEnabled,
  buildLedCells,
  defaultDraft,
  discardDraft,
  draftFromSpec,
  effectiveBlend,
  emptyLayerDraft,
  isDraftDirty,
  layerPeriodFloor,
  parseDraftRange,
  validateDraft,
  type LedCell,
  type SegmentDraft,
} from "../../utils/control/segment-editor";
import { firstFreeSegId, percentOf255, spanText, tailText } from "../../utils/control/segment-view";
import { ControlSession } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { createWxStorage } from "../../utils/control/device-cache";
import { loadTheme, themeClass } from "../../utils/control/theme";
import { queryInt } from "../../utils/control/routes";

/** UI 上的灯效选项（第 2 层多一个「关闭」）。 */
type LayerMode = "static" | "breathing" | "rainbow" | "comet" | "off";

interface ModeOption {
  mode: LayerMode;
  name: string;
  type: number;
}

const LAYER0_MODES: ModeOption[] = [
  { mode: "static", name: "静态", type: SEGMENT_TYPE.STATIC },
  { mode: "breathing", name: "呼吸", type: SEGMENT_TYPE.BREATHING },
  { mode: "rainbow", name: "彩虹", type: SEGMENT_TYPE.RAINBOW },
  { mode: "comet", name: "流光", type: SEGMENT_TYPE.COMET },
];

const LAYER1_MODES: ModeOption[] = [
  ...LAYER0_MODES,
  { mode: "off", name: "关闭", type: NO_EFFECT },
];

/** 每层的展示态（WXML 只读这一份，编辑一律回写到 `this.draft`）。 */
interface LayerView {
  label: string;
  mode: LayerMode;
  /** 该层是否为空（只有第 2 层可能为空）。 */
  empty: boolean;
  /** 折叠态：三个参数组默认都收起，避免一屏堆 20 个控件。 */
  collapsed: boolean;
  modeOptions: ModeOption[];
  colorHex: string;
  periodMs: number;
  periodText: string;
  periodFloor: number;
  minLevel: number;
  minLevelText: string;
  waveform: number;
  waveformOptions: Array<{ value: number; name: string }>;
  span: number;
  spanText: string;
  tail: number;
  tailText: string;
  reverse: boolean;
  breathing: boolean;
  rainbow: boolean;
  comet: boolean;
  /** 每个预设是否等于该层当前色（按 hue+sat 判定，不按 hex 字符串）。 */
  presetSelected: boolean[];
}

const WAVEFORM_OPTIONS = [
  { value: WAVEFORM.SINE, name: WAVEFORM_NAMES[WAVEFORM.SINE] },
  { value: WAVEFORM.TRIANGLE, name: WAVEFORM_NAMES[WAVEFORM.TRIANGLE] },
  { value: WAVEFORM.SAWTOOTH, name: WAVEFORM_NAMES[WAVEFORM.SAWTOOTH] },
  { value: WAVEFORM.SQUARE, name: WAVEFORM_NAMES[WAVEFORM.SQUARE] },
];

/** blend 选项（顺序 = 协议值）。 */
const BLEND_OPTIONS: Array<{ value: BlendMode; name: string; hint: string }> = [
  { value: BLEND_VALUE.OVER, name: "覆盖", hint: "第 2 层直接替换第 1 层" },
  { value: BLEND_VALUE.MULTIPLY, name: "相乘", hint: "两层相乘：明暗叠加、颜色不变形" },
  { value: BLEND_VALUE.ADD, name: "相加", hint: "两层相加，更亮（可能过曝到白）" },
];

Page({
  data: {
    themeClass: "",
    ready: false,
    linkText: "未连接",
    stripId: 0,
    stripTitle: "灯带 1",
    segId: -1,
    segLabel: "新建",
    /** 该带真实灯珠数（State.stripCounts[stripId]）。 */
    ledCount: 0,

    startInput: "",
    endInput: "",
    cells: [] as LedCell[],
    existingText: "同带已有段：无",
    hint: "",
    /** 实时预检结果（每次编辑都刷新，提交前就已可见）。 */
    issueText: "",
    canApply: false,
    busy: false,

    layerViews: [] as LayerView[],
    /** 第 2 层是否启用（决定 blend 控件是否可用）。 */
    blendEnabled: false,
    blendOptions: BLEND_OPTIONS,
    blend: BLEND_VALUE.OVER as BlendMode,
    blendHint: BLEND_OPTIONS[0].hint,

    presetList: PRESETS,
    maxPeriod: MAX_PERIOD_MS,
  },

  session: null as ControlSession | null,
  /** 编辑中的草稿——唯一真相；`data` 只是它的展示镜像。 */
  draft: null as SegmentDraft | null,
  /** 设备权威的段（QueryStrip(该带)）；`null` = 新建段。 */
  deviceSpec: null as SegmentSpec | null,
  /** 该带已有段（只保留同带，防脏数据）。 */
  reports: [] as SegmentReport[],
  /**
   * 是否拿到了合法的灯带号。
   *
   * `data.stripId` 的初始值是 0（WXML 需要它），但它是**占位**：URL 没带
   * 灯带时不能拿这个 0 去查/写 strip 0——那正是「编辑别的带却改到第 0 条」
   * 的旧缺陷。所有设备调用前都先看这个标志。
   */
  hasStrip: false,
  /** 是否已从设备加载过一次（后台回来不要冲掉正在编辑的草稿）。 */
  loadedOnce: false,
  /**
   * 读回的串行队列。
   *
   * `queryStrip` 的收集器是单槽的：并发两次查询会互相覆盖，最后拿到的那份
   * 可能不是自己发的命令。进入页面时 onShow 与 onLink 都可能触发读回，
   * 「应用」之后还要求**这次**读回真的完成（草稿要按设备值刷新），所以用
   * 队列串行并要求调用方 await。
   */
  reloadChain: Promise.resolve() as Promise<void>,
  /** 页面已卸载：异步回调回来时不再 setData（避免卸载后的幽灵更新）。 */
  unloaded: false,
  /** 两层的折叠态（页面级偏好：重画时不能把用户刚展开的组又收起来）。 */
  collapsed: [false, true] as [boolean, boolean],
  unsubscribers: [] as Array<() => void>,

  onLoad(options: Record<string, string | undefined>) {
    /* 页面私有状态（不进 data）。Page() 不保证对象字面量字段会被复制到
     * 实例上，所以必须在**任何提前 return 之前**兜底：本页有「URL 参数
     * 越界就 return」的分支，若初始化放在它后面，onUnload 会因
     * `this.unsubscribers` 为 undefined 而抛错，整个页面事件绑定失效。 */
    this.unsubscribers = [];
    this.reports = [];
    this.collapsed = [false, true];
    this.draft = null;
    this.deviceSpec = null;
    this.hasStrip = false;
    this.loadedOnce = false;
    this.unloaded = false;
    this.reloadChain = Promise.resolve();

    const session = getSession();
    this.session = session;
    this.setData({ themeClass: themeClass(loadTheme(createWxStorage())) });
    const stripId = queryInt(options, "stripId", -1);
    const rawSegId = queryInt(options, "segId", -1);
    /* 越界的 URL 参数按「新建 / 无灯带」处理：命令行构造器会抛 RangeError，
     * 但页面不该把一个手改的 URL 变成一次崩溃。 */
    if (stripId < 0 || stripId >= MAX_STRIPS) {
      this.setData({ hint: "没有指定灯带，请从设备控制页进入" });
      return;
    }
    const segId = rawSegId >= 0 && rawSegId < MAX_SEGMENTS ? rawSegId : -1;
    this.hasStrip = true;
    /* 灯带号先落进 data：后续所有设备调用都用它（绝不回落到 strip 0）。 */
    this.setData({
      stripId,
      segId,
      stripTitle: `灯带 ${stripId + 1}`,
      segLabel: segId >= 0 ? `段 ${segId}` : "新建",
    });
    /* 先放一份空草稿（灯珠数未知 = 区间留空）：`onShow` 随后才读设备，
     * 未连上时页面也不会是空白。 */
    this.draft = defaultDraft(stripId, 0);
    this.render({ keepHint: true });
  },

  onShow() {
    this.subscribe();
    /* 回到本页时设备可能被系统断开：让会话自己复核一次（不打断扫描）。 */
    void this.session?.onShow();
    /* 只有第一次加载才读设备；从后台回来时用户可能正在编辑，不能冲掉草稿。 */
    if (!this.loadedOnce) {
      void this.reload();
      return;
    }
    this.syncLink();
  },

  onHide() {
    this.unsubscribe();
  },

  onUnload() {
    /* 离开页面即丢弃草稿：清空引用即可，**绝不**在用户没点「应用」时静默下发
     * （spec §3.4）。设备值没有被改过，所以「丢弃」不需要任何补偿动作。 */
    this.unsubscribe();
    this.unloaded = true;
    this.session = null;
    this.draft = null;
    this.deviceSpec = null;
  },

  subscribe() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.unsubscribers = [
      session.onLink((state) => this.handleLink(state)),
      session.onState((state) => this.applyDeviceState(state)),
    ];
  },

  /**
   * 连接态变化。
   *
   * 重新进入 ready（首次连接 / 断线回来 / 换设备）意味着设备可能重启过：
   * 草稿没被改过就直接按设备值重建；用户正在编辑则保留草稿并明确提示
   * ——**绝不**把未应用的草稿当作设备值显示（那是双向的谎话）。
   */
  handleLink(state: LinkState) {
    this.syncLink();
    if (state !== "ready") {
      return;
    }
    /* 页面还没读到过设备值（刚进页 / 之前没连上）：占位草稿不算「用户的改动」，
     * 必须按设备值重建，否则用户会看到一份从未生效的空白区间。 */
    if (!this.loadedOnce) {
      void this.reload();
      return;
    }
    const draft = this.draft;
    const dirty =
      draft !== null && isDraftDirty(draft, this.deviceSpec, this.data.ledCount, this.data.stripId);
    if (!dirty) {
      void this.reload();
      return;
    }
    this.setData({ hint: "连接已恢复；未应用的草稿保留在本页，应用后才会下发" });
  },

  unsubscribe() {
    /* onUnload 可能先于 onLoad 的初始化跑到，undefined 兜底。 */
    for (const off of this.unsubscribers ?? []) {
      off();
    }
    this.unsubscribers = [];
  },

  /** 链接 / State 变化只刷新「连接态 + 灯珠数」，不动草稿。 */
  syncLink() {
    const session = this.session;
    const link: LinkState = session?.linkState ?? "idle";
    const state = session?.deviceState ?? null;
    this.setData({
      ready: link === "ready" && state !== null,
      linkText: link === "ready" ? "已连接" : "未连接",
      ledCount: this.stripLedCount(state),
    });
    /* 「应用」按钮的可用性取决于连接态，而它由 render 统一算：断线后必须
     * 立刻变成不可点，不能等下一次编辑才刷新。 */
    this.render({ keepHint: true });
  },

  /**
   * State 变化：只同步连接态与该带灯珠数。
   *
   * 灯珠数变了（用户在设备页改过）要重画一次可视化与预检，否则灯珠条长度
   * 与草稿区间会对不上；草稿本身不重读——编辑中的用户不该被后台刷新清掉。
   */
  applyDeviceState(state: DeviceState) {
    const ledCount = this.stripLedCount(state);
    const changed = ledCount !== this.data.ledCount;
    this.setData({
      ready: this.session?.linkState === "ready",
      ledCount,
    });
    if (changed && this.draft !== null) {
      this.render({ keepHint: true });
    }
  },

  /** 该带真实灯珠数：`State.stripCounts[stripId]`，不是 strip 0 的复制。 */
  stripLedCount(state: DeviceState | null): number {
    if (state === null || !this.hasStrip) {
      return 0;
    }
    const stripId = this.data.stripId;
    return state.stripCounts[stripId] ?? 0;
  },

  /**
   * 读 State（灯珠数）+ QueryStrip(该带)（段列表），并用设备值重建草稿。
   *
   * 进入页面 / 应用成功 / 删除成功都走这一条路径：设备永远是权威。
   */
  reload(): Promise<void> {
    const run = this.reloadChain.then(async () => {
      const session = this.session;
      if (session === null || this.unloaded || !this.hasStrip) {
        return;
      }
      await this.reloadNow(session);
    });
    /* 队列本身吞掉异常（一次读失败不能卡死后续读回），返回值仍把错误抛给调用方。 */
    this.reloadChain = run.catch(() => undefined);
    return run;
  },

  /** 真正的读回（由 `reload` 串行化，不直接调用）。 */
  async reloadNow(session: ControlSession): Promise<void> {
    const link = session.linkState;
    const state = session.deviceState;
    const ready = link === "ready" && state !== null;
    this.setData({
      ready,
      linkText: ready ? "已连接" : "未连接",
      ledCount: this.stripLedCount(state),
    });
    if (!ready) {
      this.setData({ hint: "设备未连接：回到设备控制页连接后再来" });
      this.render({ keepHint: true });
      return;
    }
    const stripId = this.data.stripId;
    const result = await session.queryStrip(stripId);
    if (this.unloaded) {
      return;
    }
    if (result.kind !== "ok") {
      if (result.kind === "error") {
        this.setData({ hint: `读取段失败：${result.message}` });
      }
      return;
    }
    /* 设备回报的 stripId 是权威：防御脏数据，绝不让别的带混进来。 */
    this.reports = result.reports.filter((item) => item.stripId === stripId);
    const segId = this.data.segId;
    const current = this.reports.find((item) => item.segId === segId);
    this.deviceSpec = current === undefined ? null : specOf(current);
    this.draft =
      this.deviceSpec === null
        ? defaultDraft(stripId, this.data.ledCount)
        : draftFromSpec(this.deviceSpec);
    this.loadedOnce = true;
    /* 第 2 层为空时收起（没有可编辑参数）；有第二层时展开，让设备值可见。 */
    this.collapsed = [false, this.deviceSpec === null || this.deviceSpec.layer1.type === NO_EFFECT];
    this.setData({
      segId: this.deviceSpec === null ? -1 : segId,
      hint:
        this.deviceSpec === null
          ? `新建段：该带 ${this.data.ledCount} 颗灯珠`
          : `已从设备读取段 ${segId}`,
    });
    this.render({ keepHint: true });
  },

  // ---------------- 表单：区间 ----------------

  onStartInput(e: WechatMiniprogram.Input) {
    if (this.draft === null) {
      return;
    }
    this.draft.startText = String(e.detail.value ?? "");
    this.render({ keepHint: true });
  },

  onEndInput(e: WechatMiniprogram.Input) {
    if (this.draft === null) {
      return;
    }
    this.draft.endText = String(e.detail.value ?? "");
    this.render({ keepHint: true });
  },

  // ---------------- 表单：层 ----------------

  /** 点灯效类型（第 2 层的「关闭」= 置空层）。 */
  onLayerModeTap(e: WechatMiniprogram.TouchEvent) {
    const draft = this.draft;
    if (draft === null) {
      return;
    }
    const index = layerIndexOf(e);
    const type = Number(e.currentTarget.dataset.type ?? -1);
    if (index === null) {
      return;
    }
    if (type === NO_EFFECT) {
      /* 只有第 2 层能被关闭；第 1 层必填（UI 上不提供关闭入口）。 */
      if (index === 1) {
        draft.layer1 = emptyLayerDraft();
        /* 空层没有可编辑参数，收起；blend 也随之被强制为覆盖。 */
        this.collapsed = [this.collapsed[0], true];
      }
    } else {
      const layer = index === 0 ? draft.layer0 : draft.layer1;
      applyLayerType(layer, type);
      if (index === 0) {
        draft.layer0 = layer;
      } else {
        draft.layer1 = layer;
        /* 启用第 2 层后展开它的参数，否则用户看不到刚打开的是什么。 */
        this.collapsed = [this.collapsed[0], false];
      }
    }
    this.render({ keepHint: true });
  },

  /** 折叠 / 展开某层的参数组。空层没有可折叠的内容（它永远展开）。 */
  onLayerCollapse(e: WechatMiniprogram.TouchEvent) {
    const index = layerIndexOf(e);
    if (index === null || this.layerAt(index).type === NO_EFFECT) {
      return;
    }
    const next: [boolean, boolean] = [this.collapsed[0], this.collapsed[1]];
    next[index] = !next[index];
    this.collapsed = next;
    this.render({ keepHint: true });
  },

  onLayerPeriodChange(e: WechatMiniprogram.SliderChange) {
    const index = layerIndexOf(e);
    if (index === null) {
      return;
    }
    const raw = Number(e.detail.value ?? 0);
    /* 不在这里静默钳位：用户拖到 300ms 的呼吸必须**看见**下限提示，
     * 而不是被悄悄改成 334ms（那样「应用」成功也解释不清发生了什么）。
     * 真正的拒绝由 `validateDraft` 在提交前给出。 */
    const period = Number.isInteger(raw) ? Math.max(0, raw) : 0;
    this.mutateLayer(index, (layer) => {
      layer.periodMs = period;
    });
  },

  onLayerMinLevelChange(e: WechatMiniprogram.SliderChange) {
    const index = layerIndexOf(e);
    if (index === null) {
      return;
    }
    const value = clampByte(Number(e.detail.value ?? 0));
    this.mutateLayer(index, (layer) => {
      layer.p5 = value;
    });
  },

  onLayerSpanChange(e: WechatMiniprogram.SliderChange) {
    const index = layerIndexOf(e);
    if (index === null) {
      return;
    }
    const value = clampByte(Number(e.detail.value ?? 0));
    this.mutateLayer(index, (layer) => {
      layer.p5 = value;
    });
  },

  onLayerTailChange(e: WechatMiniprogram.SliderChange) {
    const index = layerIndexOf(e);
    if (index === null) {
      return;
    }
    const value = clampByte(Number(e.detail.value ?? 0));
    this.mutateLayer(index, (layer) => {
      layer.p5 = value;
    });
  },

  onLayerWaveformTap(e: WechatMiniprogram.TouchEvent) {
    const index = layerIndexOf(e);
    const waveform = Number(e.currentTarget.dataset.value ?? WAVEFORM.SINE);
    if (index === null || waveform < 0 || waveform > 3) {
      return;
    }
    this.mutateLayer(index, (layer) => {
      /* 波形占 flags bit1-2，bit0 是保留的反向位。 */
      layer.flags = ((waveform & 0x03) << 1) | (layer.flags & 0x01);
    });
  },

  onLayerReverseTap(e: WechatMiniprogram.TouchEvent) {
    const index = layerIndexOf(e);
    if (index === null) {
      return;
    }
    const reverse = Number(e.currentTarget.dataset.value ?? 0) !== 0;
    this.mutateLayer(index, (layer) => {
      /* bit0 = 方向（彩虹 / 流光）；呼吸层只是保留位，保持为 0。 */
      layer.flags = reverse ? (layer.flags | 0x01) : (layer.flags & 0xfe);
    });
  },

  /** 预设：只改该层草稿的基准色（hue+sat），点「应用」才下发。 */
  onLayerPresetTap(e: WechatMiniprogram.TouchEvent) {
    const index = layerIndexOf(e);
    const preset = this.data.presetList[Number(e.currentTarget.dataset.index ?? -1)];
    if (index === null || preset === undefined) {
      return;
    }
    const params = rgbToSegmentParams(preset.rgb);
    this.mutateLayer(index, (layer) => {
      layer.hue = params.hue;
      layer.sat = params.sat;
    });
  },

  // ---------------- blend ----------------

  onBlendTap(e: WechatMiniprogram.TouchEvent) {
    const draft = this.draft;
    if (draft === null) {
      return;
    }
    /* 单层时控件禁用：即使事件漏过（老基础库），也拒绝写入。 */
    if (!blendEnabled(draft.layer1)) {
      wx.showToast({ title: "只有一层时混合方式只能是覆盖", icon: "none" });
      return;
    }
    const value = Number(e.currentTarget.dataset.value ?? BLEND_VALUE.OVER);
    if (value !== BLEND_VALUE.OVER && value !== BLEND_VALUE.MULTIPLY && value !== BLEND_VALUE.ADD) {
      return;
    }
    draft.blend = value;
    this.render();
  },

  // ---------------- 应用 ----------------

  /**
   * 应用草稿：本地预检 → 下发 → 等 ACK → 重新 QueryStrip → 用设备值覆盖草稿。
   *
   * 预检失败时**一帧都不发**：这是票面「客户端预校验」的核心，设备回
   * InvalidParam 只能是兜底，不能是主要反馈路径。
   */
  async onApply() {
    const session = this.session;
    const draft = this.draft;
    if (session === null || draft === null || this.data.busy) {
      return;
    }
    if (!this.data.ready || !this.hasStrip) {
      this.setData({ hint: "设备未连接" });
      return;
    }

    const validation = validateDraft(draft, {
      ledCount: this.data.ledCount,
      existing: this.reports,
    });
    if (!validation.ok || validation.spec === null) {
      this.setData({ hint: validation.message, issueText: validation.message });
      wx.showToast({ title: validation.message, icon: "none" });
      return;
    }

    /* 槽位：有选中段就替换它；否则占第一个空闲槽位（绝不静默覆盖别的段）。 */
    let segId = this.data.segId >= 0 ? this.data.segId : draft.segId;
    if (segId < 0) {
      segId = firstFreeSegId(this.reports.map((item) => item.segId));
      if (segId < 0) {
        const message = `这条带最多 ${MAX_SEGMENTS} 段，请先删掉一段`;
        this.setData({ hint: message, issueText: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
    }
    const spec: SegmentSpec = { ...validation.spec, segId };

    const target: SegmentTarget = {
      stripId: spec.stripId,
      segId,
      start: spec.start,
      end: spec.end,
    };
    session.setActiveSegment(target);

    this.setData({ busy: true, hint: "正在下发…" });
    try {
      const ack = await session.setSegment(spec);
      if (this.unloaded) {
        return;
      }
      if (!ack.ok) {
        const message = rejectHint(ack.resultCode);
        this.setData({ hint: message, issueText: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      /* 设备权威：ACK 只代表「已写入」，读回的值才是草稿的新基线。 */
      this.setData({ segId, segLabel: `段 ${segId}`, hint: "已生效，正在读回设备值…" });
      await this.reload();
      this.setData({ hint: `段 ${segId} 已生效（已按设备返回值刷新）` });
    } catch (err) {
      const message = errMessage(err);
      this.setData({ hint: message, issueText: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      if (!this.unloaded) {
        this.setData({ busy: false });
      }
    }
  },

  /** 删除当前段：ClearSegment + 重读该带（只动这一条带）。 */
  async onDelete() {
    const session = this.session;
    const segId = this.data.segId;
    if (session === null || this.data.busy || !this.hasStrip) {
      return;
    }
    if (segId < 0) {
      this.setData({ hint: "这是新建段，没有可删除的设备段" });
      return;
    }
    this.setData({ busy: true, hint: "正在删除…" });
    try {
      const ack = await session.clearSegment(this.data.stripId, segId);
      if (this.unloaded) {
        return;
      }
      if (!ack.ok) {
        const message = rejectHint(ack.resultCode);
        this.setData({ hint: message, issueText: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      /* 删除后不再有「当前段」：页面回到新建态，段列表以重读为准。 */
      this.setData({ segId: -1, segLabel: "新建" });
      await this.reload();
      this.setData({ hint: `段 ${segId} 已删除（已按设备返回值刷新）` });
    } catch (err) {
      const message = errMessage(err);
      this.setData({ hint: message, issueText: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      if (!this.unloaded) {
        this.setData({ busy: false });
      }
    }
  },

  /**
   * 直接返回：丢弃草稿（不静默下发），回到灯光页。
   *
   * 有未应用的改动时先确认：草稿会被**丢掉**而不是偷偷发出去，这一点要让
   * 用户明确知道（spec §3.4）。
   */
  onCancel() {
    const draft = this.draft;
    const dirty =
      draft !== null && isDraftDirty(draft, this.deviceSpec, this.data.ledCount, this.data.stripId);
    if (!dirty) {
      this.leave();
      return;
    }
    wx.showModal({
      title: "放弃改动？",
      content: "未应用的改动会被丢弃，设备状态保持不变。",
      confirmText: "丢弃",
      cancelText: "继续编辑",
      success: (res) => {
        if (res.confirm) {
          this.leave();
        }
      },
    });
  },

  /** 真正离开：先把草稿还原成设备值（本地不留残影），再返回。 */
  leave() {
    if (this.draft !== null) {
      this.draft = discardDraft(this.draft, this.deviceSpec, this.data.stripId, this.data.ledCount);
    }
    wx.navigateBack({ fail: () => undefined });
  },

  // ---------------- 内部 ----------------

  /** 取某一层（0 / 1）；草稿还没建立时返回空层（调用方只读，不会写回）。 */
  layerAt(index: 0 | 1): EffectLayer {
    const draft = this.draft;
    if (draft === null) {
      return emptyLayerDraft();
    }
    return index === 0 ? draft.layer0 : draft.layer1;
  },

  /** 只改某一层，然后重画 + 重新预检。`mutate` 直接改草稿里的那一层。 */
  mutateLayer(index: 0 | 1, mutate: (layer: EffectLayer) => void) {
    const draft = this.draft;
    if (draft === null) {
      return;
    }
    const layer = { ...this.layerAt(index) };
    mutate(layer);
    if (index === 0) {
      draft.layer0 = layer;
    } else {
      draft.layer1 = layer;
    }
    this.render();
  },

  /**
   * 把草稿重新投影到 `data`：区间输入、逐灯珠可视化、两层控件、blend、实时预检。
   *
   * 每一处编辑都走这里，所以「重叠 / 周期过短」在用户松手时就已经显示，
   * 不需要先点一次应用。
   */
  render(opts: { keepHint?: boolean } = {}) {
    const draft = this.draft;
    /* 页面已卸载 / 草稿已丢弃：异步回调不要再往里写（卸载后 setData 无意义）。 */
    if (draft === null || this.unloaded) {
      return;
    }
    const range = parseDraftRange(draft, this.data.ledCount);
    const validation = validateDraft(draft, {
      ledCount: this.data.ledCount,
      existing: this.reports,
    });
    const cells = buildLedCells({
      ledCount: this.data.ledCount,
      start: range.ok ? range.start : -1,
      end: range.ok ? range.end : -1,
      segId: draft.segId,
      stripId: draft.stripId,
      existing: this.reports,
    });
    const blendOn = blendEnabled(draft.layer1);
    const blend = effectiveBlend(draft);
    const hints = BLEND_OPTIONS.filter((option) => option.value === blend);

    this.setData({
      startInput: draft.startText,
      endInput: draft.endText,
      cells,
      layerViews: [
        layerView(draft.layer0, 0, this.collapsed[0]),
        layerView(draft.layer1, 1, this.collapsed[1]),
      ],
      blendEnabled: blendOn,
      blend,
      blendHint: blendOn ? (hints[0]?.hint ?? "") : "第 2 层关闭时固定为覆盖",
      existingText: existingTextOf(this.reports, this.data.stripId),
      /* 未连接时不显示「灯珠数量未知」这类预检噪音：本页根本不能提交。 */
      issueText: validation.ok || !this.data.ready ? "" : validation.message,
      canApply: validation.ok && this.data.ready,
      /* 每次编辑都清掉上一次操作的提示：屏幕上只留「当前为什么不能应用」。 */
      ...(opts.keepHint ? {} : { hint: "" }),
    });
  },
});

// ---------------- 纯辅助（只做展示派生 / 事件解析） ----------------

function layerIndexOf(e: WechatMiniprogram.BaseEvent): 0 | 1 | null {
  const raw = Number(e.currentTarget.dataset.layer ?? -1);
  return raw === 0 || raw === 1 ? raw : null;
}

/** 切换灯效类型时保留颜色，按新类型的语义重置参数（静态层清零）。 */
function applyLayerType(layer: EffectLayer, type: number): void {
  if (layer.type === type) {
    return;
  }
  layer.type = type;
  if (type === SEGMENT_TYPE.STATIC) {
    layer.periodMs = 0;
    layer.p5 = 0;
    layer.flags = 0;
    return;
  }
  if (type === SEGMENT_TYPE.BREATHING) {
    /* 呼吸只有波形位 (bit1-2)，方向位清零。 */
    layer.flags = layer.flags & 0x06;
  } else {
    /* 彩虹 / 流光只有方向位 (bit0)，波形位清零。 */
    layer.flags = layer.flags & 0x01;
  }
  /* 周期：从静态（恒 0）切到动画时给一个可感知的默认值，否则「周期 0 = 静止」
   * 会让人以为新灯效没生效；已有的非 0 周期抬到新类型的下限之上
   * （从 200ms 的彩虹切到呼吸不会立刻产生一条非法草稿）。 */
  if (layer.periodMs === 0) {
    layer.periodMs = type === SEGMENT_TYPE.BREATHING ? 1000 : 1200;
  } else {
    layer.periodMs = Math.max(layer.periodMs, layerPeriodFloor(type));
  }
}

/** 一层 → 视图（WXML 只读）。`collapsed` 由页面持有，重画不会丢。 */
function layerView(layer: EffectLayer, index: 0 | 1, collapsed: boolean): LayerView {
  const empty = layer.type === NO_EFFECT;
  const mode = modeOf(layer.type);
  const rgb = segmentHueSatToRgb(layer.hue, layer.sat);
  const periodFloor = layerPeriodFloor(layer.type);
  return {
    label: index === 0 ? "第 1 层（必填）" : "第 2 层（可选）",
    mode,
    empty,
    /* 空层永远展开：否则「第 2 层」只剩一行标题，用户找不到打开它的入口。 */
    collapsed: collapsed && !empty,
    modeOptions: index === 0 ? LAYER0_MODES : LAYER1_MODES,
    colorHex: rgbToHex(rgb),
    periodMs: layer.periodMs,
    periodText: empty ? "—" : layer.periodMs === 0 ? "静止" : `${layer.periodMs}ms`,
    periodFloor,
    minLevel: layer.p5,
    minLevelText: percentOf255(layer.p5),
    waveform: (layer.flags >> 1) & 0x03,
    waveformOptions: WAVEFORM_OPTIONS,
    span: layer.p5,
    spanText: spanText(layer.p5),
    tail: layer.p5,
    tailText: tailText(layer.p5),
    reverse: (layer.flags & 0x01) !== 0,
    breathing: mode === "breathing",
    rainbow: mode === "rainbow",
    comet: mode === "comet",
    /* 用预设的 hue+sat 反推再比，而不是比 hex：hex 是 RGB 展示值，
     * 与协议里的 hue/sat 之间有一次量化，永远对不齐。 */
    presetSelected: PRESETS.map((preset) => {
      const params = rgbToSegmentParams(preset.rgb);
      return params.hue === layer.hue && params.sat === layer.sat;
    }),
  };
}

function modeOf(type: number): LayerMode {
  switch (type) {
    case SEGMENT_TYPE.BREATHING:
      return "breathing";
    case SEGMENT_TYPE.RAINBOW:
      return "rainbow";
    case SEGMENT_TYPE.COMET:
      return "comet";
    case NO_EFFECT:
      return "off";
    default:
      return "static";
  }
}

/** 段报告 → 可下发的 spec（去掉扁平兼容字段，两层原样带过来）。 */
function specOf(report: SegmentReport): SegmentSpec {
  return {
    stripId: report.stripId,
    segId: report.segId,
    start: report.start,
    end: report.end,
    blend: report.blend,
    layer0: { ...report.layer0 },
    layer1: { ...report.layer1 },
  };
}

/** 同带已有段的一句话摘要（重叠提示的上下文，也用于「这条带已被占满」）。 */
function existingTextOf(reports: readonly SegmentReport[], stripId: number): string {
  const same = reports.filter((item) => item.stripId === stripId);
  if (same.length === 0) {
    return "同带已有段：无";
  }
  const parts = same
    .slice()
    .sort((a, b) => a.segId - b.segId)
    .map((item) => `段${item.segId} ${item.start}-${item.end}`);
  return `同带已有段：${parts.join("，")}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 滑块值是浮点 / 越界时都可能出现；落草稿前先钳成协议的 0-255。 */
function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** 段命令被拒时的可读原因（与灯光页同一套话术）。 */
function rejectHint(resultCode: number): string {
  switch (resultCode) {
    case 0x01:
      return "设备拒绝：区间越界 / 与其它段重叠 / 层参数非法（周期过短、空层 0、单层带 blend）";
    case 0x02:
      return "该灯效需要升级固件";
    case 0x04:
      return "协议长度不符（固件与小程序版本不一致）";
    default:
      return `设置失败：${resultText(resultCode)}`;
  }
}
