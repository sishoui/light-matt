/**
 * 段编辑页（二级页，#41 基础版）：区间 + 灯效类型 + 颜色，草稿从设备读。
 *
 * **这一票只做基础可用形态**；#42 会把它扩成完整编辑器（两层 + blend、LED
 * 可视化、周期下限的即时拒绝、draft 生命周期细化）。这里保留的语义必须与
 * spec §3.4 一致，否则 #42 无从接手：
 *  - 进入页面时从设备读该带该段的当前值填草稿；
 *  - 点「应用」→ 下发 → 等 ACK → 重新 `QueryStrip(该带)` → **用设备返回值
 *    覆盖草稿**（设备是权威）；
 *  - 用户直接返回 = 丢弃草稿，**不静默下发**。
 *
 * 灯带号来自 URL（灯光页把当前带传过来），页面内所有调用都显式带上它。
 */

import { resultText } from "../../utils/ble/errors";
import type { LinkState } from "../../utils/protocol/types";
import {
  ANIMATION_MIN_PERIOD_MS,
  BREATHING_MIN_PERIOD_MS,
  MAX_PERIOD_MS,
  MAX_SEGMENTS,
  SEGMENT_TYPE,
  WAVEFORM,
  WAVEFORM_NAMES,
} from "../../utils/protocol/constants";
import { segmentReverse } from "../../utils/protocol/commands";
import { PRESETS, rgbToHsv, segmentHueSatToRgb } from "../../utils/color/hsv";
import {
  breathingLabel,
  cometLabel,
  firstFreeSegId,
  overlapError,
  parseRangeInput,
  rainbowLabel,
  spanText,
  tailText,
} from "../../utils/control/segment-view";
import { ControlSession } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { queryInt } from "../../utils/control/routes";
import type { RGB, SegmentReport, SegmentTarget } from "../../utils/protocol/types";

/** 本页编辑的四类灯效（与协议 SEGMENT_TYPE 一一对应）。 */
type EditMode = "static" | "breathing" | "rainbow" | "comet";

const MODE_OPTIONS: Array<{ mode: EditMode; name: string; type: number }> = [
  { mode: "static", name: "静态", type: SEGMENT_TYPE.STATIC },
  { mode: "breathing", name: "呼吸", type: SEGMENT_TYPE.BREATHING },
  { mode: "rainbow", name: "彩虹", type: SEGMENT_TYPE.RAINBOW },
  { mode: "comet", name: "流光", type: SEGMENT_TYPE.COMET },
];

Page({
  data: {
    ready: false,
    linkText: "未连接",
    stripId: 0,
    stripTitle: "灯带 1",
    segId: -1,
    /** 该带真实灯珠数（State.stripCounts[stripId]，不是 strip 0 的复制）。 */
    ledCount: 0,

    startInput: "",
    endInput: "",
    hint: "",
    busy: false,

    mode: "static" as EditMode,
    modeOptions: MODE_OPTIONS,
    // 呼吸参数
    breathingPeriod: 1000,
    breathingPeriodText: "1000ms",
    breathingMinLevel: 0,
    breathingMinLevelText: "0%",
    breathingWaveform: WAVEFORM.SINE as number,
    waveformOptions: [
      { value: WAVEFORM.SINE, name: WAVEFORM_NAMES[WAVEFORM.SINE] },
      { value: WAVEFORM.TRIANGLE, name: WAVEFORM_NAMES[WAVEFORM.TRIANGLE] },
      { value: WAVEFORM.SAWTOOTH, name: WAVEFORM_NAMES[WAVEFORM.SAWTOOTH] },
      { value: WAVEFORM.SQUARE, name: WAVEFORM_NAMES[WAVEFORM.SQUARE] },
    ],
    breathingMinPeriod: BREATHING_MIN_PERIOD_MS,
    // 彩虹 / 流光参数（p5 按类型解释）
    animPeriod: 1200,
    animPeriodText: "1200ms",
    animSpan: 255,
    animSpanText: "整圈",
    animTail: 64,
    animTailText: "拖尾 25%",
    animReverse: false,
    animMinPeriod: ANIMATION_MIN_PERIOD_MS,
    maxPeriod: MAX_PERIOD_MS,

    // 颜色草稿（用户空间 RGB，不下 gamma）
    colorHex: "#ffffff",
    colorSaturation: 0,
    presetList: PRESETS,
    breathingVisible: false,
    animVisible: false,

    /** 该带已有段的区间（重叠预检用；设备仍是权威）。 */
    existingRows: [] as Array<{ segId: number; start: number; end: number }>,
  },

  session: null as ControlSession | null,
  /** 设备权威的段列表（编辑目标是其中一条）。 */
  reports: [] as SegmentReport[],
  /** 未应用的颜色草稿；色环/预设只改它，点「应用」才下发。 */
  draftRgb: { r: 255, g: 255, b: 255 } as RGB,

  onLoad(options: Record<string, string | undefined>) {
    const session = getSession();
    this.session = session;
    const stripId = queryInt(options, "stripId", -1);
    const segId = queryInt(options, "segId", -1);
    if (stripId < 0) {
      this.setData({ hint: "没有指定灯带，请从灯光页进入" });
      return;
    }
    this.setData({ stripId, segId, stripTitle: `灯带 ${stripId + 1}` });
    void this.reload();
  },

  onShow() {
    /* 从后台回来：设备可能被断开，或别处改过段；重读一次（草稿随之刷新）。 */
    void this.reload();
  },

  onUnload() {
    /* 离开页面即丢弃草稿：**绝不**在用户没点「应用」时静默下发（spec §3.4）。 */
    this.session = null;
  },

  /** 读 State（灯珠数）+ QueryStrip(该带)（段列表），并填草稿。 */
  async reload() {
    const session = this.session;
    if (session === null) {
      return;
    }
    const state = session.deviceState;
    const link: LinkState = session.linkState;
    const ready = link === "ready" && state !== null;
    this.setData({
      ready,
      linkText: ready ? "已连接" : "未连接",
      ledCount: state?.stripCounts[this.data.stripId] ?? 0,
    });
    if (!ready) {
      this.setData({ hint: "设备未连接：回到灯光页连接后再来" });
      return;
    }

    const result = await session.queryStrip(this.data.stripId);
    if (result.kind !== "ok") {
      if (result.kind === "error") {
        this.setData({ hint: `读取段失败：${result.message}` });
      }
      return;
    }
    this.reports = result.reports.filter((report) => report.stripId === this.data.stripId);
    this.setData({
      existingRows: this.reports.map((report) => ({
        segId: report.segId,
        start: report.start,
        end: report.end,
      })),
    });
    this.fillDraftFromDevice();
  },

  /** 用设备权威值填草稿（进入页面 / 应用成功 / 重读后都走这里）。 */
  fillDraftFromDevice() {
    const segId = this.data.segId;
    const report = this.reports.find((item) => item.segId === segId);
    if (report === undefined) {
      /* 新建：预填一个建议区间（0 到该带灯珠数-1）。 */
      const last = Math.max(0, this.data.ledCount - 1);
      this.setData({
        startInput: this.data.ledCount > 0 ? "0" : "",
        endInput: this.data.ledCount > 0 ? String(last) : "",
        hint: `新建段：该带 ${this.data.ledCount} 颗灯珠`,
      });
      return;
    }

    const rgb = segmentHueSatToRgb(report.hue, report.sat);
    this.draftRgb = rgb;
    const hsv = rgbToHsv(rgb);
    const type = report.type;
    const mode: EditMode =
      type === SEGMENT_TYPE.BREATHING
        ? "breathing"
        : type === SEGMENT_TYPE.RAINBOW
          ? "rainbow"
          : type === SEGMENT_TYPE.COMET
            ? "comet"
            : "static";
    this.setData({
      startInput: String(report.start),
      endInput: String(report.end),
      colorHex: reportToHex(rgb),
      colorSaturation: Math.round(hsv.s * 100),
      mode,
      breathingVisible: mode === "breathing",
      animVisible: mode === "rainbow" || mode === "comet",
      breathingPeriod: type === SEGMENT_TYPE.BREATHING ? report.periodMs : 1000,
      breathingPeriodText:
        type === SEGMENT_TYPE.BREATHING && report.periodMs === 0
          ? "静止"
          : `${type === SEGMENT_TYPE.BREATHING ? report.periodMs : 1000}ms`,
      breathingMinLevel: type === SEGMENT_TYPE.BREATHING ? report.p5 : 0,
      breathingMinLevelText: percentText(type === SEGMENT_TYPE.BREATHING ? report.p5 : 0),
      breathingWaveform: type === SEGMENT_TYPE.BREATHING ? (report.flags >> 1) & 0x03 : WAVEFORM.SINE,
      animPeriod: mode === "static" || mode === "breathing" ? 1200 : report.periodMs,
      animPeriodText:
        mode === "static" || mode === "breathing"
          ? "1200ms"
          : report.periodMs === 0
            ? "静止"
            : `${report.periodMs}ms`,
      animSpan: mode === "rainbow" ? report.p5 : 255,
      animSpanText: spanText(mode === "rainbow" ? report.p5 : 255),
      animTail: mode === "comet" ? report.p5 : 64,
      animTailText: tailText(mode === "comet" ? report.p5 : 64),
      animReverse: segmentReverse(report.flags),
      hint: [
        `段 ${report.segId}：${labelOf(report)}`,
        `${report.start}-${report.end}`,
      ].join(" · "),
    });
  },

  // ---------------- 表单 ----------------

  onStartInput(e: WechatMiniprogram.Input) {
    this.setData({ startInput: String(e.detail.value ?? ""), hint: "" });
  },

  onEndInput(e: WechatMiniprogram.Input) {
    this.setData({ endInput: String(e.detail.value ?? ""), hint: "" });
  },

  onModeTap(e: WechatMiniprogram.TouchEvent) {
    const raw = String(e.currentTarget.dataset.mode ?? "static");
    const mode: EditMode =
      raw === "breathing" || raw === "rainbow" || raw === "comet" ? raw : "static";
    this.setData({
      mode,
      breathingVisible: mode === "breathing",
      animVisible: mode === "rainbow" || mode === "comet",
    });
  },

  onBreathingPeriodChange(e: WechatMiniprogram.SliderChange) {
    const raw = Number(e.detail.value ?? 0);
    const period = raw === 0 ? 0 : Math.max(raw, BREATHING_MIN_PERIOD_MS);
    this.setData({
      breathingPeriod: period,
      breathingPeriodText: period === 0 ? "静止" : `${period}ms`,
    });
  },

  onBreathingMinLevelChanging(e: WechatMiniprogram.SliderChange) {
    const value = clampByte(Number(e.detail.value ?? 0));
    this.setData({ breathingMinLevel: value, breathingMinLevelText: percentText(value) });
  },

  onBreathingMinLevelChange(e: WechatMiniprogram.SliderChange) {
    const value = clampByte(Number(e.detail.value ?? 0));
    this.setData({ breathingMinLevel: value, breathingMinLevelText: percentText(value) });
  },

  onWaveformTap(e: WechatMiniprogram.TouchEvent) {
    const value = Number(e.currentTarget.dataset.value ?? WAVEFORM.SINE);
    if (value < 0 || value > 3) {
      return;
    }
    this.setData({ breathingWaveform: value });
  },

  onAnimPeriodChange(e: WechatMiniprogram.SliderChange) {
    const raw = Number(e.detail.value ?? 0);
    const period = raw === 0 ? 0 : Math.max(raw, ANIMATION_MIN_PERIOD_MS);
    this.setData({
      animPeriod: period,
      animPeriodText: period === 0 ? "静止" : `${period}ms`,
    });
  },

  onAnimSpanChange(e: WechatMiniprogram.SliderChange) {
    const span = clampByte(Number(e.detail.value ?? 0));
    this.setData({ animSpan: span, animSpanText: spanText(span) });
  },

  onAnimTailChange(e: WechatMiniprogram.SliderChange) {
    const tail = clampByte(Number(e.detail.value ?? 0));
    this.setData({ animTail: tail, animTailText: tailText(tail) });
  },

  onAnimReverseTap(e: WechatMiniprogram.TouchEvent) {
    this.setData({ animReverse: Number(e.currentTarget.dataset.value ?? 0) !== 0 });
  },

  /** 预设：只改草稿颜色，点「应用」才下发（草稿与设备解耦，spec §3.4）。 */
  onPresetTap(e: WechatMiniprogram.TouchEvent) {
    const preset = this.data.presetList[Number(e.currentTarget.dataset.index ?? -1)];
    if (preset === undefined) {
      return;
    }
    this.draftRgb = preset.rgb;
    this.setData({ colorHex: preset.hex });
  },

  // ---------------- 应用 ----------------

  /**
   * 应用草稿：本地预检 → 下发 → ACK → 重新 QueryStrip → 用设备值覆盖草稿。
   *
   * 失败（含设备 InvalidParam）时**不改草稿区间**，也不假装成功；设备是权威。
   */
  async onApply() {
    const session = this.session;
    if (session === null || this.data.busy) {
      return;
    }
    if (!this.data.ready) {
      this.setData({ hint: "设备未连接" });
      return;
    }

    const parsed = parseRangeInput(this.data.startInput, this.data.endInput, this.data.ledCount);
    if (!parsed.ok) {
      this.setData({ hint: parsed.message });
      wx.showToast({ title: parsed.message, icon: "none" });
      return;
    }

    /* 重叠预检：改自己时忽略自己的旧区间（槽位相同 = 替换）。 */
    const conflict = overlapError(parsed.start, parsed.end, this.data.existingRows, this.data.segId);
    if (conflict !== null) {
      const message = `与其它段冲突：${conflict}（区间不能重叠）`;
      this.setData({ hint: message });
      wx.showToast({ title: conflict, icon: "none" });
      return;
    }

    /* 槽位：有选中段就用它；否则取第一个空闲槽位（绝不静默覆盖别的段）。 */
    let segId = this.data.segId;
    if (segId < 0) {
      segId = firstFreeSegId(this.data.existingRows.map((row) => row.segId));
      if (segId < 0) {
        const message = `最多 ${MAX_SEGMENTS} 段，请先在灯光页删除一段`;
        this.setData({ hint: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
    }

    const target: SegmentTarget = {
      stripId: this.data.stripId,
      segId,
      start: parsed.start,
      end: parsed.end,
    };
    session.setActiveSegment(target);

    this.setData({ busy: true, hint: "正在下发…" });
    try {
      const result = await this.sendModeSegment(target, this.draftRgb);
      if (result.kind === "ok") {
        this.setData({ segId, hint: "已生效，正在读回设备值…" });
        /* 设备权威：重新读该带，用返回值覆盖草稿。 */
        await this.reload();
        return;
      }
      if (result.kind === "ack-error") {
        const message = rejectHint(result.ack.resultCode);
        this.setData({ hint: message });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      if (result.kind === "stale") {
        this.setData({ hint: "连接已切换，结果已丢弃" });
        return;
      }
      this.setData({ hint: result.message });
      wx.showToast({ title: result.message, icon: "none" });
    } finally {
      this.setData({ busy: false });
    }
  },

  /** 按当前模式下发（四类共用 session 的参数化入口）。 */
  async sendModeSegment(
    target: SegmentTarget,
    rgb: RGB,
  ): Promise<Awaited<ReturnType<ControlSession["setSegmentColor"]>>> {
    const session = this.session;
    if (session === null) {
      return { kind: "error", message: "设备未连接" };
    }
    switch (this.data.mode) {
      case "breathing":
        return session.setSegmentBreathing(
          target,
          rgb,
          this.data.breathingPeriod,
          this.data.breathingMinLevel,
          this.data.breathingWaveform,
        );
      case "rainbow":
        return session.setSegmentRainbow(
          target,
          rgb,
          this.data.animPeriod,
          this.data.animSpan,
          this.data.animReverse,
        );
      case "comet":
        return session.setSegmentComet(
          target,
          rgb,
          this.data.animPeriod,
          this.data.animTail,
          this.data.animReverse,
        );
      default:
        return session.setSegmentColor(target, rgb);
    }
  },

  /** 直接返回：丢弃草稿（不静默下发），回到灯光页。 */
  onCancel() {
    wx.navigateBack({ fail: () => undefined });
  },
});

/** 段的可读标签（设备值是权威，这里只做展示）。 */
function labelOf(report: SegmentReport): string {
  switch (report.type) {
    case SEGMENT_TYPE.BREATHING:
      return `呼吸 · ${breathingLabel(report)}`;
    case SEGMENT_TYPE.RAINBOW:
      return `彩虹 · ${rainbowLabel(report)}`;
    case SEGMENT_TYPE.COMET:
      return `流光 · ${cometLabel(report)}`;
    default:
      return "静态";
  }
}

function reportToHex(rgb: RGB): string {
  const to = (value: number) => clampByte(value).toString(16).padStart(2, "0");
  return `#${to(rgb.r)}${to(rgb.g)}${to(rgb.b)}`;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(255, Math.max(0, Math.round(value)));
}

function percentText(value: number): string {
  return `${Math.round((clampByte(value) / 255) * 100)}%`;
}

/** 段命令被拒时的可读原因（与灯光页同一套话术）。 */
function rejectHint(resultCode: number): string {
  switch (resultCode) {
    case 0x01:
      return "设备拒绝：区间越界、与其它段重叠、保留了非法标志位，或周期过短";
    case 0x02:
      return "该灯效需要升级固件";
    case 0x04:
      return "协议长度不符（固件与小程序版本不一致）";
    default:
      return `设置失败：${resultText(resultCode)}`;
  }
}
