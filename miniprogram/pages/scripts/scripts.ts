/**
 * 剧本页（tab 3）：阶段时间轴 + 跨带预览 + 设备摘要读回。
 *
 * #45 把 #32 的剧本编辑扩成时间轴编辑器：
 *  - 每阶段一张卡片：时长可改、可删、可上移 / 下移、可加阶段；
 *  - 卡片上给出**跨带摘要**（哪几条带、各几个段），不逐颗预览像素；
 *  - 4 套剧本槽位各自独立编辑 / 下发 / 激活；
 *  - 下发前做容量预检（§10.4），超限直接提示且**不发请求**；
 *  - 连上后 QueryScript 读回 4 个槽位的**摘要**（v3 没有整份读回）。
 *
 * **v3 没有「读回整份剧本」的命令**：QueryScript 只回 4 字节
 * （script_id / stage_count / flags / active），拿不到阶段时长、段区间与灯效。
 * 所以页面必须诚实地告诉用户：摘要是设备权威，但**内容读不回来，编辑后要
 * 重新下发**才生效。这不是本票的偷懒，而是协议契约的边界（coordinator 裁定）。
 *
 * fade：格式预留且 caps.bit1 == 0，数据里恒为 0，**不提供过渡 UI**。
 *
 * 灯带维度：剧本跨带，`stripCount` 取设备 `State.stripCount`，段各自带 `stripId`。
 */

import { resultText } from "../../utils/ble/errors";
import type { LinkDetail } from "../../utils/ble/transport";
import {
  addStage,
  buildScriptStageRows,
  createScriptDrafts,
  draftInvalidStageCount,
  draftCapacityBytes,
  draftToScriptConfig,
  downloadProgressText,
  moveStage,
  playbackView,
  removeStage,
  replaceScriptDraft,
  scriptDraftOf,
  scriptSummaryRow,
  setStageDuration,
  setStageSegments,
  SUMMARY_ONLY_NOTE,
  summaryReadErrorText,
  typeName,
  upsertStageSegment,
  type ScriptDraft,
  type ScriptStageRow,
  type ScriptSummaryRow,
} from "../../utils/control/script-view";
import { checkScriptBlobBytes, SCRIPT_BLOB_MAX_BYTES } from "../../utils/control/script-plan";
import { MAX_SCRIPTS, MAX_STAGES } from "../../utils/protocol/constants";
import { ControlSession } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { createWxStorage } from "../../utils/control/device-cache";
import { loadTheme, themeClass } from "../../utils/control/theme";
import { statusView } from "../../utils/control/status-view";
import { PAGE_ROUTES, TAB_ROUTES, pushTo, switchTabTo } from "../../utils/control/routes";
import type {
  DeviceState,
  LinkState,
  SegmentReport,
  SegmentSpec,
} from "../../utils/protocol/types";

Page({
  data: {
    themeClass: "",
    statusText: "未连接",
    statusSub: "点「发现」连接设备",
    statusAction: "发现",
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
      secondLayer: boolean;
    }>,
    scriptActiveStage: 0,
    scriptMaxStages: MAX_STAGES,
    scriptBusy: false,
    scriptHintText: "",

    /** 容量预检（§10.4）：本地草稿预估字节 / 上限。 */
    scriptEstimatedBytes: 0,
    scriptCapacityLimit: SCRIPT_BLOB_MAX_BYTES,
    scriptOverCapacity: false,

    /** 设备上 4 个槽位的摘要（v3 只能读摘要）。 */
    scriptSummaries: [] as ScriptSummaryRow[],
    summaryBusy: false,
    summaryNote: SUMMARY_ONLY_NOTE,
    summaryErrorText: "",

    // 下发进度（每帧 ACK 为权威；0x86 只作旁证）
    scriptProgressPercent: -1,
    scriptProgressText: "",
    scriptDeviceFrames: -1,

    // 播放控制（State 是权威）
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
  /** 4 个槽位各一份独立草稿（切 id 不覆盖别套）。 */
  drafts: [] as ScriptDraft[],
  unsubscribers: [] as Array<() => void>,
  /** 已读到的设备摘要（切剧本时重绘用；不参与编辑）。 */
  deviceSummaries: [] as ScriptSummaryRow[],

  /** 当前编辑的草稿（按 data.scriptId 取）。 */
  currentDraft(): ScriptDraft | null {
    return this.drafts.length === 0 ? null : scriptDraftOf(this.drafts, this.data.scriptId);
  },

  /** 把编辑后的草稿写回槽位数组。 */
  storeDraft(draft: ScriptDraft): void {
    this.drafts = replaceScriptDraft(this.drafts, draft);
  },

  onLoad() {
    /* 页面私有状态（不进 data）。Page() 不保证对象字面量字段会被复制到
     * 实例上，所以在这里显式兜底。 */
    this.unsubscribers = [];
    this.deviceSummaries = [];

    this.session = getSession();
    this.drafts = createScriptDrafts();
    this.syncRows();
    this.setData({ themeClass: themeClass(loadTheme(createWxStorage())) });
  },

  onShow() {
    this.subscribe();
    this.syncFromSession();
    this.syncTabBar();
    this.setData({ themeClass: themeClass(loadTheme(createWxStorage())) });
    /* 回到页面就刷新摘要：设备可能在别处（或断电重启后）变了。 */
    if (this.data.ready) {
      void this.refreshSummaries();
    }
  },

  /** 自定义 tabBar 的选中态（索引与 app.json 顺序一致）。 */
  syncTabBar() {
    const tabBar = this.getTabBar?.();
    if (tabBar !== undefined && tabBar !== null) {
      tabBar.setData({ selected: 1 });
    }
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
        if (scriptId !== this.data.scriptId) {
          return;
        }
        this.setData({ scriptDeviceFrames: frames });
      }),
    ];
  },

  unsubscribe() {
    /* onUnload 可能先于 onLoad 的初始化跑到，undefined 兜底。 */
    for (const off of this.unsubscribers ?? []) {
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
    const wasReady = this.data.ready;
    this.setData({ ...view, ready: state === "ready" });
    /* 首次连上 / 重连成功：读一次摘要（§9.1 的重建顺序最后一步）。 */
    if (!wasReady && state === "ready") {
      void this.refreshSummaries();
    } else if (wasReady && state !== "ready") {
      /* 断线：摘要描述的是上一台设备，必须清掉，别让用户以为还在。 */
      this.deviceSummaries = [];
      this.setData({ scriptSummaries: [], summaryErrorText: "" });
    }
  },

  applyDeviceState(state: DeviceState) {
    const stageTotal = this.currentDraft()?.stages.length ?? 0;
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

  // ---------------- 设备摘要读回 ----------------

  async refreshSummaries() {
    const session = this.session;
    if (session === null || this.data.summaryBusy) {
      return;
    }
    this.setData({ summaryBusy: true });
    try {
      const result = await session.queryScriptSummaries();
      if (result.kind === "ok") {
        this.deviceSummaries = result.summaries.map(scriptSummaryRow);
        this.setData({
          scriptSummaries: this.deviceSummaries,
          summaryErrorText: "",
        });
        return;
      }
      if (result.kind === "stale") {
        return;
      }
      /* 部分读回：已读到的照常显示，读不到的用错误行说明。 */
      this.deviceSummaries = result.summaries.map(scriptSummaryRow);
      this.setData({
        scriptSummaries: this.deviceSummaries,
        summaryErrorText: summaryReadErrorText(result.message),
      });
    } finally {
      this.setData({ summaryBusy: false });
    }
  },

  // ---------------- 草稿 ----------------

  syncRows(patch: Record<string, unknown> = {}) {
    const draft = this.currentDraft();
    if (draft === null) {
      return;
    }
    /*
     * 容量预检放在每次草稿变更后：用户改一个数字就能看到有没有超。
     * 比较的是「4 个槽位合计」（§10.4），但只把设备上已提交的槽位算进来
     * ——设备不让我们读回别套的内容，本机草稿是唯一替代；从没下发的草稿
     * 在设备上只占 1 字节，算进来会误拦。当前这套一定参与。
     */
    const committedIds = this.deviceSummaries
      .filter((row) => row.committed)
      .map((row) => row.scriptId);
    const estimate = draftCapacityBytes(
      this.drafts,
      committedIds,
      draft.scriptId,
      this.stripCountForScripts(),
    );
    this.setData({
      scriptStageRows: buildScriptStageRows(draft, this.data.scriptActiveStage),
      currentStageSegments: this.segmentCellsOf(draft, this.data.scriptActiveStage),
      scriptId: draft.scriptId,
      scriptEstimatedBytes: estimate,
      scriptOverCapacity: estimate > SCRIPT_BLOB_MAX_BYTES,
      ...patch,
    });
  },

  /** 当前阶段的段（给 WXML 画删除按钮；摘要文本仍由 script-view 生成）。 */
  segmentCellsOf(
    draft: ScriptDraft,
    stageIndex: number,
  ): Array<{
    key: string;
    stripId: number;
    segId: number;
    rangeText: string;
    typeText: string;
    secondLayer: boolean;
  }> {
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
      typeText: typeName("layer0" in seg ? seg.layer0.type : seg.type),
      secondLayer: "layer0" in seg && seg.layer1.type !== 0xff,
    }));
  },

  onScriptIdTap(e: WechatMiniprogram.TouchEvent) {
    const scriptId = Number(e.currentTarget.dataset.scriptId ?? -1);
    if (!Number.isInteger(scriptId) || scriptId < 0 || scriptId >= MAX_SCRIPTS) {
      return;
    }
    /*
     * 4 套剧本各自独立草稿：切 id 只切「编哪一套」，不覆盖其它槽位。
     * 必须先改 data.scriptId（currentDraft 按它取值），再重画行。
     */
    this.setData({ scriptId, scriptActiveStage: 0 });
    this.syncRows({ scriptHintText: "" });
  },

  onScriptStageTap(e: WechatMiniprogram.TouchEvent) {
    const draft = this.currentDraft();
    const index = Number(e.currentTarget.dataset.stage ?? -1);
    if (draft === null || index < 0 || index >= draft.stages.length) {
      return;
    }
    this.setData({ scriptActiveStage: index });
    this.syncRows();
  },

  onScriptStageDurationInput(e: WechatMiniprogram.Input) {
    const draft = this.currentDraft();
    if (draft === null) {
      return;
    }
    const index = Number(e.currentTarget.dataset.stage ?? -1);
    this.storeDraft(setStageDuration(draft, index, String(e.detail.value ?? "")));
    this.syncRows({ scriptHintText: "" });
  },

  onScriptAddStage() {
    const draft = this.currentDraft();
    if (draft === null) {
      return;
    }
    const next = addStage(draft);
    if (next === draft) {
      wx.showToast({ title: `最多 ${MAX_STAGES} 个阶段`, icon: "none" });
      return;
    }
    this.storeDraft(next);
    this.syncRows({ scriptHintText: "" });
  },

  onScriptRemoveStage(e: WechatMiniprogram.TouchEvent) {
    const draft = this.currentDraft();
    if (draft === null) {
      return;
    }
    const index = Number(e.currentTarget.dataset.stage ?? -1);
    const next = removeStage(draft, index);
    if (next === draft) {
      wx.showToast({ title: "至少保留 1 个阶段", icon: "none" });
      return;
    }
    this.storeDraft(next);
    this.setData({
      scriptActiveStage: Math.min(this.data.scriptActiveStage, next.stages.length - 1),
    });
    this.syncRows({ scriptHintText: "" });
  },

  /**
   * 阶段重排（上移 / 下移）。
   *
   * 顺序就是设备上的播放顺序，所以这里只改草稿数组并保持「当前编辑阶段」
   * 跟随被移动的那一张：用户点了它，重排后仍应该停在它上面。
   */
  onScriptMoveStage(e: WechatMiniprogram.TouchEvent) {
    const draft = this.currentDraft();
    if (draft === null) {
      return;
    }
    const index = Number(e.currentTarget.dataset.stage ?? -1);
    const delta = Number(e.currentTarget.dataset.delta ?? 0);
    const next = moveStage(draft, index, delta);
    if (next === draft) {
      return;
    }
    this.storeDraft(next);
    this.setData({ scriptActiveStage: index + delta });
    this.syncRows({ scriptHintText: "" });
  },

  /**
   * 把**灯光页选中的段**加进当前阶段。
   *
   * 段参数取设备刚读回的段配置（`session.segmentsOf(stripId)`）：用户在灯光页
   * 拖动过颜色时以设备为准，不在这里重复一套参数 UI。槽位按 (strip, seg) 计，
   * 同一槽位是替换（upsert），重复点只更新参数。两层段原样保留（layer1 / blend）。
   */
  onScriptAddSegment() {
    const session = this.session;
    const draft = this.currentDraft();
    if (session === null || draft === null || !this.data.ready) {
      return;
    }
    const target = session.activeSegment;
    if (target === null) {
      wx.showToast({ title: "先在设备控制页选一个段", icon: "none" });
      return;
    }
    const report = session.segmentsOf(target.stripId).find((item) => item.segId === target.segId);
    if (report === undefined) {
      wx.showToast({ title: "该段已不存在，请回设备控制页刷新", icon: "none" });
      return;
    }
    const stageIndex = this.data.scriptActiveStage;
    const stage = draft.stages[stageIndex];
    if (stage === undefined) {
      return;
    }

    /* 剧本里的段必须带自己的 stripId（跨带），不继承「当前带」。 */
    const segment = specFromReport(report);
    const segments = upsertStageSegment(stage.segments, segment);
    this.storeDraft(setStageSegments(draft, stageIndex, segments));
    this.syncRows({
      scriptHintText: `阶段 ${stageIndex + 1}：灯带 ${segment.stripId + 1} 段 ${segment.segId} 已加入`,
    });
  },

  onScriptRemoveSegment(e: WechatMiniprogram.TouchEvent) {
    const draft = this.currentDraft();
    if (draft === null) {
      return;
    }
    const segId = Number(e.currentTarget.dataset.segId ?? -1);
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    const stageIndex = this.data.scriptActiveStage;
    const stage = draft.stages[stageIndex];
    if (stage === undefined || segId < 0 || stripId < 0) {
      return;
    }
    /* 槽位是 (strip, seg)：只挑掉这一条，别的带同号槽位不受影响。 */
    const keep = stage.segments.filter(
      (seg) => !(seg.segId === segId && seg.stripId === stripId),
    );
    if (keep.length === stage.segments.length) {
      return;
    }
    this.storeDraft(setStageSegments(draft, stageIndex, keep));
    this.syncRows({
      scriptHintText: `已从阶段 ${stageIndex + 1} 删除灯带 ${stripId + 1} 的段 ${segId}`,
    });
  },

  /** 清空本阶段的段（阶段仍保留，播到它时整条熄灭）。 */
  onScriptClearStageSegments() {
    const draft = this.currentDraft();
    if (draft === null) {
      return;
    }
    const stageIndex = this.data.scriptActiveStage;
    this.storeDraft(setStageSegments(draft, stageIndex, []));
    this.syncRows({ scriptHintText: `阶段 ${stageIndex + 1} 的段已清空` });
  },

  // ---------------- 下发 ----------------

  async onScriptDownload() {
    const session = this.session;
    const draft = this.currentDraft();
    if (session === null || this.data.scriptBusy || !this.data.ready || draft === null) {
      return;
    }

    const invalidStages = draftInvalidStageCount(draft);
    if (invalidStages > 0) {
      const message = `有 ${invalidStages} 个阶段的时长非法（必须是 1-65535 的整数，0 不行）`;
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

    /* 容量预检（§10.4）：超限直接提示，一帧都不发。 */
    const committedIds = this.deviceSummaries
      .filter((row) => row.committed)
      .map((row) => row.scriptId);
    const capacity = checkScriptBlobBytes(
      draftCapacityBytes(this.drafts, committedIds, script.scriptId, script.stripCount),
    );
    if (!capacity.ok) {
      this.setData({ scriptHintText: capacity.message });
      wx.showToast({ title: capacity.message, icon: "none" });
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
          scriptHintText: `剧本 ${script.scriptId + 1} 已下发并激活（阶段数 / 激活态已按设备摘要刷新）`,
        });
        if (result.state !== undefined && result.state !== null) {
          this.applyDeviceState(result.state);
        }
        /* 内容变了，摘要也要重读（stage_count 可能不同）。 */
        void this.refreshSummaries();
        return;
      }
      if (result.kind === "stale") {
        this.setData({ scriptHintText: "连接已切换，下发结果已丢弃" });
        return;
      }
      if (result.kind === "too-large") {
        /* 设备明示 ScriptTooLarge：配置未变，必须说清楚（预检是按单套算的）。 */
        this.setData({
          scriptProgressPercent: -1,
          scriptHintText: `${result.message}；上一套剧本仍可用`,
        });
        wx.showToast({ title: "剧本过大，设备未保存", icon: "none" });
        return;
      }
      const message =
        result.kind === "ack-error"
          ? `下发被设备拒绝（${resultText(result.ack.resultCode)}），上一套剧本仍可用`
          : result.message;
      this.setData({ scriptProgressPercent: -1, scriptHintText: message });
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
    /* 只改本地期望值；下次 play / activate 时随命令下发（设备在 State 里回报）。 */
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
        void this.refreshSummaries();
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

  /** 去当前设备的控制页（剧本是设备级功能，控制面板在详情页）。 */
  onGoLight() {
    pushTo(PAGE_ROUTES.device);
  },

  /** 导航栏右侧动作：已连接进控制页，否则去发现页。 */
  onNavAction() {
    if (this.data.ready) {
      this.onGoLight();
      return;
    }
    this.onGoDevices();
  },
});

/**
 * 设备 SegmentReport → 可下发的两层段。
 *
 * v3 的报告本身就是 `SegmentSpec` + layer0 的扁平投影，所以这里直接取两层
 * 权威字段（layer0 / layer1 / blend），**不**退化成扁平配置——否则剧本里
 * 的第二层会在「加入阶段」时被静默丢掉，激活后与直接设段的视觉不一致。
 */
function specFromReport(report: SegmentReport): SegmentSpec {
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
