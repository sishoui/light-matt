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
import type { DeviceState, LinkState, SegmentReport } from "../../utils/protocol/types";

/** 编辑档位：简单（点效果卡）/ 进阶（后续票）。 */
type StripMode = "simple" | "advanced";

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
    });
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
  },

  onUnload() {
    /* 二级页会被真正卸载；会话属于 App，绝不 destroy。 */
    this.unsubscribe();
    this.clearQuickTimer();
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
    this.setData({
      ledCount: 0,
      ledText: "连接后显示灯珠数",
      planSub: "读取中…",
      quickCards: buildQuickCardViews(null),
      simpleParams: null,
      quickDisabledReason: this.disabledReason(),
      quickHint: "",
      applyError: "",
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
    }
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
