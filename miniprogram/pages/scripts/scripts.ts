/**
 * 剧本页（tab 3）：阶段时间轴，跨带预览。
 *
 * 这一票把 #32 的剧本编辑从旧单页搬过来并**保持功能可用**；#45 会把它扩成
 * 时间轴编辑器（增删 / 重排、每带摘要、读回摘要）。当前形态：
 *  - 4 套剧本槽位（只切草稿的 id，不动设备）；
 *  - 最多 8 个阶段，每阶段一个时长输入；
 *  - 「把当前段加进阶段」用**灯光页选中的段**（会话里的 activeSegment），
 *    参数取设备刚读回的段配置（设备是权威，不复制页面里的临时值）；
 *  - 下发 = Begin → Stage/Segment… → Commit → Activate（script-plan 纯函数），
 *    进度以每帧 ACK 为权威；失败由 session 尽力 Abort，设备保留上一套可用配置。
 *
 * 灯带维度：剧本跨带，所以 `stripCount` 取设备的 `State.stripCount`，段也各自
 * 带自己的 `stripId`（不写死 0）。
 *
 * #45 的已知缺口（本票不修，避免越界改 script-view 的签名）：
 *  - `upsertStageSegment` 目前只按 segId 去重，没有把 stripId 算进键里；
 *    跨带同号槽位会互相覆盖。#45 要改成 (stripId, segId)。
 *  - 没有阶段重排，也没有 `QueryScript` 摘要读回。
 */

import { resultText } from "../../utils/ble/errors";
import type { LinkDetail } from "../../utils/ble/transport";
import {
  addStage,
  buildScriptStageRows,
  createScriptDraft,
  draftInvalidStageCount,
  draftToScriptConfig,
  downloadProgressText,
  playbackView,
  removeStage,
  setStageDuration,
  setStageSegments,
  typeName,
  upsertStageSegment,
  type ScriptDraft,
  type ScriptStageRow,
} from "../../utils/control/script-view";
import { MAX_SCRIPTS, MAX_STAGES } from "../../utils/protocol/constants";
import { ControlSession } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { statusView } from "../../utils/control/status-view";
import { TAB_ROUTES, switchTabTo } from "../../utils/control/routes";
import type { DeviceState, LinkState, SegmentConfig, SegmentReport } from "../../utils/protocol/types";

Page({
  data: {
    statusText: "未连接",
    statusSub: "点「设备」连接",
    statusAction: "设备",
    linkClass: "link-idle",
    ready: false,

    scriptIdOptions: [0, 1, 2, 3],
    scriptId: 0,
    scriptStageRows: [] as ScriptStageRow[],
    /** 当前编辑阶段的段（删除按钮用；摘要文本仍来自 script-view）。 */
    currentStageSegments: [] as Array<{
      key: string;
      stripId: number;
      segId: number;
      rangeText: string;
      typeText: string;
    }>,
    scriptActiveStage: 0,
    scriptMaxStages: MAX_STAGES,
    scriptBusy: false,
    scriptHintText: "",

    // 下发进度（每帧 ACK 为权威；0x86 只作旁证）
    scriptProgressPercent: -1,
    scriptProgressText: "",
    scriptDeviceFrames: -1,

    // 播放控制（State 字节 12 是权威）
    playbackText: "停止",
    playbackStageText: "无激活剧本",
    playbackState: 0,
    playbackLoop: true,
    playbackActive: false,
    playbackBusy: false,

    stripCountValue: 1,
    version: "0.3.0",
  },

  session: null as ControlSession | null,
  draft: null as ScriptDraft | null,
  unsubscribers: [] as Array<() => void>,

  onLoad() {
    this.session = getSession();
    this.draft = createScriptDraft();
    this.syncRows();
  },

  onShow() {
    this.subscribe();
    this.syncFromSession();
  },

  onHide() {
    this.unsubscribe();
  },

  onUnload() {
    this.unsubscribe();
    this.session = null;
  },

  subscribe() {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.unsubscribers = [
      session.onLink((state, detail) => this.applyLink(state, detail)),
      session.onState((state) => this.applyDeviceState(state)),
      /* 设备侧 ScriptProgress(0x86) 只是「确实收到了」的旁证，不进进度条。 */
      session.transport.onScriptProgress((scriptId, frames) => {
        if (scriptId !== this.draft?.scriptId) {
          return;
        }
        this.setData({ scriptDeviceFrames: frames });
      }),
    ];
  },

  unsubscribe() {
    for (const off of this.unsubscribers) {
      off();
    }
    this.unsubscribers = [];
  },

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
      detail?.deviceName ?? session?.cachedDevice?.name ?? "",
      detail?.message,
      session?.reconnectPending ?? false,
      (session?.cachedDevice ?? null) !== null,
    );
    this.setData({ ...view, ready: state === "ready" });
  },

  applyDeviceState(state: DeviceState) {
    const stageTotal = this.draft?.stages.length ?? 0;
    const playback = playbackView(
      state.playbackState,
      state.stageIndex,
      state.flags,
      state.scriptId,
      stageTotal,
    );
    this.setData({
      stripCountValue: Math.max(1, state.stripCount),
      playbackText: playback.text,
      playbackStageText: playback.stageText,
      playbackState: playback.state,
      playbackLoop: playback.loop,
      playbackActive: playback.active,
    });
  },

  // ---------------- 草稿 ----------------

  syncRows(patch: Record<string, unknown> = {}) {
    const draft = this.draft;
    if (draft === null) {
      return;
    }
    this.setData({
      scriptStageRows: buildScriptStageRows(draft, this.data.scriptActiveStage),
      currentStageSegments: this.segmentCellsOf(draft, this.data.scriptActiveStage),
      scriptId: draft.scriptId,
      ...patch,
    });
  },

  /** 当前阶段的段（给 WXML 画删除按钮；摘要文本仍由 script-view 生成）。 */
  segmentCellsOf(
    draft: ScriptDraft,
    stageIndex: number,
  ): Array<{ key: string; stripId: number; segId: number; rangeText: string; typeText: string }> {
    const stage = draft.stages[stageIndex];
    if (stage === undefined) {
      return [];
    }
    return stage.segments.map((seg) => ({
      /* key 必须带 stripId：跨带同号槽位是两个不同的段。 */
      key: `${seg.stripId}-${seg.segId}`,
      stripId: seg.stripId,
      segId: seg.segId,
      rangeText: `${seg.start}-${seg.end}`,
      typeText: typeName(seg.type),
    }));
  },

  onScriptIdTap(e: WechatMiniprogram.TouchEvent) {
    if (this.draft === null) {
      return;
    }
    const scriptId = Number(e.currentTarget.dataset.scriptId ?? -1);
    if (!Number.isInteger(scriptId) || scriptId < 0 || scriptId >= MAX_SCRIPTS) {
      return;
    }
    this.draft = { ...this.draft, scriptId };
    this.syncRows({ scriptHintText: "" });
  },

  onScriptStageTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.stage ?? -1);
    if (this.draft === null || index < 0 || index >= this.draft.stages.length) {
      return;
    }
    this.setData({ scriptActiveStage: index });
    this.syncRows();
  },

  onScriptStageDurationInput(e: WechatMiniprogram.Input) {
    if (this.draft === null) {
      return;
    }
    const index = Number(e.currentTarget.dataset.stage ?? -1);
    this.draft = setStageDuration(this.draft, index, String(e.detail.value ?? ""));
    this.syncRows({ scriptHintText: "" });
  },

  onScriptAddStage() {
    if (this.draft === null) {
      return;
    }
    const next = addStage(this.draft);
    if (next === this.draft) {
      wx.showToast({ title: `最多 ${MAX_STAGES} 个阶段`, icon: "none" });
      return;
    }
    this.draft = next;
    this.syncRows({ scriptHintText: "" });
  },

  onScriptRemoveStage(e: WechatMiniprogram.TouchEvent) {
    if (this.draft === null) {
      return;
    }
    const index = Number(e.currentTarget.dataset.stage ?? -1);
    const next = removeStage(this.draft, index);
    if (next === this.draft) {
      wx.showToast({ title: "至少保留 1 个阶段", icon: "none" });
      return;
    }
    this.draft = next;
    this.setData({
      scriptActiveStage: Math.min(this.data.scriptActiveStage, next.stages.length - 1),
    });
    this.syncRows({ scriptHintText: "" });
  },

  /**
   * 把**灯光页选中的段**加进当前阶段。
   *
   * 段参数取设备刚读回的段配置（`session.segmentsOf(stripId)`）：用户在灯光页
   * 拖动过颜色时以设备为准，不在这里重复一套参数 UI。同一槽位是替换（upsert），
   * 重复点只更新参数。
   */
  onScriptAddSegment() {
    const session = this.session;
    const draft = this.draft;
    if (session === null || draft === null || !this.data.ready) {
      return;
    }
    const target = session.activeSegment;
    if (target === null) {
      wx.showToast({ title: "先在灯光页选一个段", icon: "none" });
      return;
    }
    const report = session.segmentsOf(target.stripId).find((item) => item.segId === target.segId);
    if (report === undefined) {
      wx.showToast({ title: "该段已不存在，请回灯光页刷新", icon: "none" });
      return;
    }
    const stageIndex = this.data.scriptActiveStage;
    const stage = draft.stages[stageIndex];
    if (stage === undefined) {
      return;
    }

    /* 剧本里的段必须带自己的 stripId（跨带），不继承「当前带」。 */
    const segment = configFromReport(report);
    const segments = upsertStageSegment(stage.segments, segment);
    this.draft = setStageSegments(draft, stageIndex, segments);
    this.syncRows({
      scriptHintText: `阶段 ${stageIndex + 1}：灯带 ${segment.stripId + 1} 段 ${segment.segId} 已加入`,
    });
  },

  onScriptRemoveSegment(e: WechatMiniprogram.TouchEvent) {
    if (this.draft === null) {
      return;
    }
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    const stageIndex = this.data.scriptActiveStage;
    const stage = this.draft.stages[stageIndex];
    if (stage === undefined || segId < 0) {
      return;
    }
    /* 先按 (stripId, segId) 精确挑掉那条，再交给 removeStageSegment 做整体过滤：
     * script-view 现在只按 segId 去重，跨带同号槽位要在这里区分（#45 改进）。 */
    const keep = stage.segments.filter(
      (seg) => !(seg.segId === segId && (stripId < 0 || seg.stripId === stripId)),
    );
    if (keep.length === stage.segments.length) {
      return;
    }
    this.draft = setStageSegments(this.draft, stageIndex, keep);
    this.syncRows({
      scriptHintText: `已从阶段 ${stageIndex + 1} 删除段 ${segId}`,
    });
  },

  /** stage-row 里「删本阶段最后加入的段」之外的入口：清空本阶段的段。 */
  onScriptClearStageSegments() {
    if (this.draft === null) {
      return;
    }
    const stageIndex = this.data.scriptActiveStage;
    this.draft = setStageSegments(this.draft, stageIndex, []);
    this.syncRows({ scriptHintText: `阶段 ${stageIndex + 1} 的段已清空` });
  },

  // ---------------- 下发 ----------------

  async onScriptDownload() {
    const session = this.session;
    const draft = this.draft;
    if (session === null || this.data.scriptBusy || !this.data.ready || draft === null) {
      return;
    }

    const invalidStages = draftInvalidStageCount(draft);
    if (invalidStages > 0) {
      const message = `有 ${invalidStages} 个阶段的时长非法（必须是 1-65535 的整数）`;
      this.setData({ scriptHintText: message });
      wx.showToast({ title: message, icon: "none" });
      return;
    }

    const script = draftToScriptConfig(draft, this.stripCountForScripts());
    const precheck = session.validateScriptForDevice(script);
    if (!precheck.ok) {
      this.setData({ scriptHintText: precheck.message });
      wx.showToast({ title: precheck.message, icon: "none" });
      return;
    }

    this.setData({
      scriptBusy: true,
      scriptProgressPercent: 0,
      scriptProgressText: downloadProgressText("准备下发", 0, 0),
      scriptDeviceFrames: -1,
      scriptHintText: "正在下发…",
    });

    try {
      const result = await session.downloadScript(
        script,
        { activate: true, loop: this.data.playbackLoop },
        (view) => {
          this.setData({
            scriptProgressPercent: view.percent,
            scriptProgressText: downloadProgressText(view.label, view.done, view.total),
          });
        },
      );

      if (result.kind === "ok") {
        this.setData({
          scriptProgressPercent: 100,
          scriptProgressText: "下发完成",
          scriptHintText: `剧本 ${script.scriptId + 1} 已下发并激活`,
        });
        if (result.state !== undefined && result.state !== null) {
          this.applyDeviceState(result.state);
        }
        return;
      }
      if (result.kind === "stale") {
        this.setData({ scriptHintText: "连接已切换，下发结果已丢弃" });
        return;
      }
      const message =
        result.kind === "ack-error"
          ? `下发被设备拒绝（${resultText(result.ack.resultCode)}），上一套剧本仍可用`
          : result.kind === "invalid"
            ? result.message
            : result.message;
      this.setData({ scriptHintText: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ scriptBusy: false });
    }
  },

  async onPlaybackTap(e: WechatMiniprogram.TouchEvent) {
    const session = this.session;
    if (session === null || this.data.playbackBusy || !this.data.ready) {
      return;
    }
    const action = Number(e.currentTarget.dataset.action ?? -1);
    if (action !== 0 && action !== 1 && action !== 2) {
      return;
    }
    this.setData({ playbackBusy: true });
    try {
      const result = await session.setPlayback(action as 0 | 1 | 2, this.data.playbackLoop);
      if (result.kind === "ok" && result.state !== undefined && result.state !== null) {
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
      this.setData({ playbackBusy: false });
    }
  },

  onPlaybackLoopChange(e: WechatMiniprogram.SwitchChange) {
    this.setData({ playbackLoop: Boolean(e.detail.value) });
  },

  async onScriptActivate() {
    const session = this.session;
    if (session === null || this.data.scriptBusy || !this.data.ready) {
      return;
    }
    this.setData({ scriptBusy: true });
    try {
      const result = await session.activateScript(this.data.scriptId, this.data.playbackLoop);
      if (result.kind === "ok" && result.state !== undefined && result.state !== null) {
        this.applyDeviceState(result.state);
        this.setData({ scriptHintText: `已激活剧本 ${this.data.scriptId + 1}` });
        return;
      }
      if (result.kind === "ack-error") {
        /* 设备未提交该 id → InvalidParam：明确告诉用户先下发。 */
        this.setData({
          scriptHintText: `剧本 ${this.data.scriptId + 1} 尚未在设备上提交，请先下发`,
        });
        wx.showToast({ title: "该剧本需要先下发", icon: "none" });
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.setData({ scriptBusy: false });
    }
  },

  /** 草稿声明的灯带数 = 设备 State.stripCount（剧本跨带）。 */
  stripCountForScripts(): number {
    return Math.max(1, this.data.stripCountValue);
  },

  onGoDevices() {
    switchTabTo(TAB_ROUTES.devices);
  },

  onGoLight() {
    switchTabTo(TAB_ROUTES.light);
  },
});

/** 设备上的段配置 → 剧本里的扁平段（保持类型与参数，stripId 原样）。 */
function configFromReport(report: SegmentReport): SegmentConfig {
  return {
    stripId: report.stripId,
    segId: report.segId,
    start: report.start,
    end: report.end,
    type: report.type,
    hue: report.hue,
    sat: report.sat,
    periodMs: report.periodMs,
    p5: report.p5,
    flags: report.flags,
  };
}
