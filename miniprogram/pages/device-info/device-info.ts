/**
 * 设备详情页（二级页）：GPIO / 灯珠数 / 自检 / 固件版本 / 改名 / 删除。
 *
 * 数据全部来自设备（§9.1），**没有一项来自后端**：
 *  - `State`（37B）：逐带灯珠数、开关位、条数；
 *  - `QueryStripConfig` 0x87：GPIO（只读，来自构建期 Kconfig）；
 *  - `QueryDeviceInfo` 0x88：固件版本、hw_id、能力上限。
 *
 * 灯珠数与 GPIO 都是**逐带**的：本页显示全部条数（含未分配的），
 * 不要拿 strip 0 的值去填别的带——那正是 v2 的缺陷。
 *
 * #44 的落点：hw_id 用于后端登记（会话在 ready 后已写入登记表），改名与删除
 * 在本地先落盘再异步同步。删除只解除登记关系：设备还在，重新扫描仍能连上。
 */

import { errorText, resultText } from "../../utils/ble/errors";
import { createWxStorage } from "../../utils/control/device-cache";
import {
  loadRegistry,
  setRemark,
  setStripEnabled,
  type DeviceRegistry,
} from "../../utils/control/device-registry";
import { getDeviceApi } from "../../utils/control/device-api-singleton";
import { DeviceSync, syncApiOf } from "../../utils/control/device-sync";
import { deleteDeviceFully } from "../../utils/control/delete-device";
import { ControlSession } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { pageThemeData } from "../../utils/control/page-theme";
import { resolveStripMeta } from "../../utils/control/strip-meta";
import { MAX_LEDS, MIN_LEDS, MAX_STRIPS } from "../../utils/protocol/constants";
import type {
  DeviceInfo,
  DeviceState,
  LayoutPart,
  StripConfig,
} from "../../utils/protocol/types";

/** 把任意滑块值钳成合法的灯珠数（整数、1..MAX_LEDS）。 */
function clampLedCount(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_LEDS;
  }
  const rounded = Math.round(value);
  return Math.max(MIN_LEDS, Math.min(MAX_LEDS, rounded));
}

/** 一组灯组的灯珠数之和（摘要区的「共 N 颗」）。 */
function sumStripLeds(counts: readonly number[]): number {
  return counts.reduce((total, count) => total + Math.max(0, count), 0);
}

interface StripInfoRow {
  stripId: number;
  label: string;
  /** 滑块上的值（拖动中只改本地；松手才下发）。 */
  ledCount: number;
  gpioText: string;
  /** 该带是否在 App 界面里可见（本地偏好，不是设备事实）。 */
  visible: boolean;
  /** 这一条的下发反馈（失败原因 / 已生效），就地显示在滑块下方。 */
  ledHint: string;
}

Page({
  data: {
    themeClass: "",
    /** 实际深色（含「跟随系统」解析）。 */
    dark: false,
    /** 原生 slider / switch 的激活色（不读 CSS 变量）。 */
    accentColor: "",
    ready: false,
    deviceName: "",
    deviceId: "",
    hwId: "—",
    firmwareText: "—",
    capsText: "—",
    limitsText: "—",
    stripRows: [] as StripInfoRow[],
    selfTestBusy: false,
    disconnectBusy: false,
    hint: "",

    /* ---- 灯珠数量（#79）：每组一条 1–100 的滑块，顶部显示只读总数 ---- */
    ledTotal: 0,
    ledMin: MIN_LEDS,
    ledMax: MAX_LEDS,
    /** 正在下发的那一条（-1 = 空闲）；其余滑块保持可拖。 */
    ledBusyStripId: -1,

    // 改名 / 删除（#44）
    remarkInput: "",
    remarkBusy: false,
    deleteBusy: false,
    identityHint: "",
  },

  session: null as ControlSession | null,
  sync: null as DeviceSync | null,
  registry: null as DeviceRegistry | null,
  /**
   * 正在拖动但还没松手的灯珠数（`stripId → 本地值`）。
   *
   * 设备 State 是 20Hz 的：拖动期间若把 `stripCounts` 同步回滑块，手指还没
   * 松开数字就会跳回旧值。松手提交成功后清空，交还给设备权威值。
   */
  ledDrafts: {} as Record<number, number>,

  onLoad() {
    /* 页面私有状态显式兜底：Page() 不保证对象字面量字段被复制到实例上。 */
    this.registry = null;
    this.ledDrafts = {};

    this.session = getSession();
    this.sync = new DeviceSync({ api: syncApiOf(getDeviceApi()), storage: createWxStorage() });
    this.reloadRegistry();
    this.setData({ ...pageThemeData(createWxStorage()) });
    void this.reload();
  },

  onShow() {
    this.reloadRegistry();
    this.setData({ ...pageThemeData(createWxStorage()) });
    void this.reload();
  },

  onUnload() {
    /* 会话属于 App：本页只丢自己的引用。 */
    this.session = null;
  },

  reloadRegistry() {
    try {
      this.registry = loadRegistry(createWxStorage());
    } catch {
      this.registry = { devices: [] };
    }
  },

  /** 读 State + 引脚表 + 设备身份（都是设备权威，失败只是缺一栏）。 */
  async reload() {
    const session = this.session;
    if (session === null) {
      return;
    }
    const ready = session.linkState === "ready";
    const deviceId = session.transport.currentDeviceId ?? "";
    this.setData({
      ready,
      deviceId,
      deviceName: session.cachedDevice?.name ?? "",
      remarkInput: this.remarkOf(deviceId) ?? "",
    });
    if (!ready) {
      this.setData({ hint: "设备未连接" });
      return;
    }

    /* 引脚表 / 设备身份：会话在 ready 时已补过；这里只在缺失时补读一次
     * （旧固件不支持时读失败，对应栏显示「—」，不影响其他信息）。 */
    let config: StripConfig | null = session.stripConfigs;
    if (config === null) {
      const res = await session.queryStripConfig();
      config = res.kind === "ok" ? res.config : null;
    }
    let info: DeviceInfo | null = session.deviceInfo;
    if (info === null) {
      const res = await session.queryDeviceInfo();
      info = res.kind === "ok" ? res.info : null;
    }

    const state: DeviceState | null = session.deviceState;
    const stripCount = Math.max(1, Math.min(MAX_STRIPS, state?.stripCount ?? 1));
    const registry = this.registry ?? { devices: [] };

    const previousRows = new Map(this.data.stripRows.map((row) => [row.stripId, row]));
    const stripRows: StripInfoRow[] = [];
    for (let stripId = 0; stripId < Math.min(stripCount, MAX_STRIPS); stripId += 1) {
      const channel = config?.channels[stripId];
      const gpioText =
        channel === undefined || !channel.assigned
          ? "未分配"
          : channel.gpio === 0xff
            ? "未分配"
            : `GPIO ${channel.gpio}`;
      const deviceCount = state?.stripLedCounts[stripId] ?? 0;
      /* 拖动中的本地值优先：State 是 20Hz 的，跟着它走会让滑块在手指下跳。
       * 松手提交后 `ledDrafts` 清空，这里自然回到设备权威值。 */
      const draft = this.ledDrafts[stripId];
      /* #94：设备信息页与设备页、灯组页读**同一个来源**的灯组名。 */
      const meta =
        this.data.deviceId.length > 0
          ? resolveStripMeta(
              createWxStorage(),
              this.draftKeyOfDevice(),
              stripId,
            )
          : null;
      stripRows.push({
        stripId,
        label: meta?.name ?? `灯组 ${stripId + 1}`,
        /* 逐带真实值：设备 State，不复制 strip 0。 */
        ledCount: draft ?? deviceCount,
        gpioText,
        visible: this.visibleInApp(registry, deviceId, stripId),
        /* 重新读取时保留上一次的下发反馈（失败原因不该因为一次刷新而消失）。 */
        ledHint: previousRows.get(stripId)?.ledHint ?? "",
      });
    }

    const counts = stripRows.map((row) => row.ledCount);

    this.setData({
      stripRows,
      ledTotal: sumStripLeds(counts),
      hwId: info?.hwId ?? "—",
      firmwareText:
        info === null
          ? "—"
          : `v${info.firmwareMajor}.${info.firmwareMinor}（0x${info.firmwareVersion.toString(16).padStart(4, "0")}）`,
      capsText:
        info === null
          ? "—"
          : `${info.supportsTwoLayers ? "支持两层叠加" : "不支持两层"} · ${
              info.fadeImplemented ? "支持渐变" : "硬切"
            }`,
      limitsText:
        info === null
          ? "—"
          : `灯珠 ${info.maxLeds} · 灯组 ${info.maxStrips} · 部位 ${info.maxParts} · ` +
            `每部位段数 ${info.maxPartSegs} · 步骤 ${info.maxSteps} · 场景 ${info.maxScenes}`,
    });

    /* hwId 由会话在 ready 后写入登记表；重读一次让备注字段反映最新记录。 */
    if (info !== null && info.hwId.length > 0 && deviceId.length > 0) {
      this.reloadRegistry();
      this.setData({ remarkInput: this.remarkOf(deviceId) ?? "" });
    }
    /* 身份提示：未配置 / 不可达时 sync 自己返回 null，这里不阻塞。 */
    void this.sync?.ensureIdentity().then(() => this.updateIdentityHint());
  },

  /** 该带是否在本机界面可见（App 本地偏好，永不下发）。 */
  visibleInApp(registry: DeviceRegistry, deviceId: string, stripId: number): boolean {
    if (deviceId.length === 0) {
      return true;
    }
    const entry = registry.devices.find((item) => item.deviceId === deviceId);
    if (entry === undefined) {
      return true;
    }
    return (entry.stripMask & (1 << stripId)) !== 0;
  },

  remarkOf(deviceId: string): string | null {
    const entry = this.registry?.devices.find((item) => item.deviceId === deviceId);
    return entry?.remark ?? null;
  },

  // ---------------- 自检 ----------------

  async onSelfTest() {
    const session = this.session;
    if (session === null || !this.data.ready || this.data.selfTestBusy) {
      return;
    }
    this.setData({ selfTestBusy: true });
    try {
      const result = await session.selfTest();
      if (result.kind === "ok") {
        wx.showToast({ title: "自检：红 → 绿 → 蓝 → 白", icon: "none" });
        return;
      }
      if (result.kind === "ack-error") {
        wx.showToast({ title: `自检失败：${resultText(result.ack.resultCode)}`, icon: "none" });
        return;
      }
      if (result.kind === "error") {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } finally {
      this.setData({ selfTestBusy: false });
    }
  },

  // ---------------- 灯珠数量（#79：每组一条滑块） ----------------

  /**
   * 拖动中：**只改本地值**，不下发。
   *
   * SetLedCount 要重建设备的 led_strip 句柄（ACK 上限 3000ms），逐帧发会把
   * 设备刷屏；所以 `bindchanging` 只更新 `data.stripRows` 与总数。
   */
  onLedCountChanging(e: WechatMiniprogram.SliderChanging) {
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    if (!Number.isInteger(stripId) || stripId < 0) {
      return;
    }
    const value = clampLedCount(Number(e.detail.value));
    this.ledDrafts[stripId] = value;
    this.patchStripRow(stripId, { ledCount: value, ledHint: "" });
  },

  /**
   * 松手：新增 / 缩小 / 改大三条路径。
   *
   * 缩小且这条灯组有越界的分区或草稿时，先弹二次确认（文案带数量）；
   * 取消则设备与草稿都不动，滑块回到设备值。
   */
  async onLedCountChange(e: WechatMiniprogram.SliderChange) {
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    if (!Number.isInteger(stripId) || stripId < 0) {
      return;
    }
    const session = this.session;
    const value = clampLedCount(Number(e.detail.value));
    const current = this.deviceLedCount(stripId);
    /* 拖动中的本地值先记下：确认框弹着的时候 State 事件不该把它冲掉。 */
    this.ledDrafts[stripId] = value;
    this.patchStripRow(stripId, { ledCount: value, ledHint: "" });
    if (session === null || !this.data.ready || this.data.ledBusyStripId >= 0) {
      this.backToDeviceValue(stripId);
      return;
    }
    if (value === current) {
      this.backToDeviceValue(stripId);
      return;
    }

    /*
     * 缩小才需要预检；改大永远不动任何已有部位（v5 的几何只在布局里，
     * 所以「会越界几个部位」只需要读一次布局，§6.1）。
     */
    let knownParts: LayoutPart[] = [];
    if (value < current) {
      const precheck = await this.shrinkPlanOf(stripId, value);
      knownParts = precheck.parts;
      if (precheck.affected > 0) {
        const confirmed = await showConfirm(
          "缩短灯组会截断部位",
          this.shrinkConfirmTextOf(precheck.affected, value),
          "继续缩短",
        );
        if (!confirmed) {
          /* 取消：设备与布局都不动，滑块回到设备值。 */
          this.backToDeviceValue(stripId);
          return;
        }
      }
    }

    const applied = await this.applyLedCountValue(stripId, value, current);
    if (applied !== true || value >= current) {
      return;
    }
    /* 设备在数量变更时会 prune 掉越界的旧段（不自动缩短），确认后把截断过
     * 的那几个部位重新写回去。 */
    await this.rewriteClampedParts(stripId, knownParts, value);
  },

  /**
   * 下发某条灯组的灯珠数（SetLedCount 0x06），成功才更新本地值。
   *
   * 返回值是「是否真的改成了」：
   *  - `true`  = 设备已按新数量重建并持久化；
   *  - `false` = 未下发 / 被拒 / 失败（界面已按设备值回位）。
   *
   * 设备会 prune 掉越界的段（不自动缩短），所以成功之后调用方要把截断过的
   * 布局段写回去（`rewriteClampedParts`）。
   */
  async applyLedCountValue(
    stripId: number,
    value: number,
    current: number,
  ): Promise<boolean> {
    const session = this.session;
    if (session === null || !this.data.ready) {
      this.backToDeviceValue(stripId);
      return false;
    }
    if (value === current) {
      this.backToDeviceValue(stripId);
      return false;
    }
    this.setData({ ledBusyStripId: stripId });
    this.patchStripRow(stripId, { ledHint: "正在下发…" });
    try {
      const result = await session.setLedCount(value, stripId);
      if (result.kind === "ok") {
        delete this.ledDrafts[stripId];
        /* 设备权威值已经变了：整页重读一次（引脚 / 身份 / 逐带灯珠数同一份快照）。 */
        await this.reload();
        this.patchStripRow(stripId, { ledHint: "" });
        return true;
      }
      if (result.kind === "ack-error") {
        this.patchStripRow(stripId, { ledHint: resultText(result.ack.resultCode) });
        this.backToDeviceValue(stripId);
        return false;
      }
      if (result.kind === "error") {
        this.patchStripRow(stripId, { ledHint: result.message });
        this.backToDeviceValue(stripId);
        return false;
      }
      /* stale：旧连接的回执，界面按设备值回位即可。 */
      this.backToDeviceValue(stripId);
      return false;
    } finally {
      this.setData({ ledBusyStripId: -1 });
    }
  },

  /** 滑块回到设备权威值（取消 / 无效拖动 / 未连接）。 */
  backToDeviceValue(stripId: number): void {
    delete this.ledDrafts[stripId];
    this.patchStripRow(stripId, { ledCount: this.deviceLedCount(stripId), ledHint: "" });
  },

  /** 设备权威的某条灯珠数（未连接 / 没读到按 0）。 */
  deviceLedCount(stripId: number): number {
    return this.session?.deviceState?.stripLedCounts[stripId] ?? 0;
  },

  /** 一条 stripRow 的局部更新（`stripId` 找不到时什么都不做）。 */
  patchStripRow(stripId: number, patch: Partial<StripInfoRow>): void {
    const stripRows = this.data.stripRows.map((row) =>
      row.stripId === stripId ? { ...row, ...patch } : row,
    );
    this.setData({ stripRows, ledTotal: sumStripLeds(stripRows.map((row) => row.ledCount)) });
  },

  /**
   * 缩小前的本地预检：这条灯组的**布局**里有多少部位会越界。
   *
   * **一帧都不发**（除了读布局本身）。v5 的几何只有布局一处（§6.2：场景不含
   * 几何），所以「哪几颗灯珠/哪个部位被截掉」只需要看布局——比 v4 的
   * 「设备段 + 落盘草稿两边都要数」简单一层。
   *
   * 读不到布局时按「不影响」处理：读失败不该把缩小的路堵死，也不该谎报
   * 「没有越界」——`LayoutCommit` 与设备的 prune 会给出权威结果。
   */
  async shrinkPlanOf(
    stripId: number,
    newLedCount: number,
  ): Promise<{ affected: number; parts: LayoutPart[] }> {
    const session = this.session;
    if (session === null) {
      return { affected: 0, parts: [] };
    }
    const result = await session.queryLayout(stripId);
    if (result.kind !== "ok") {
      return { affected: 0, parts: [] };
    }
    const parts = result.layout.parts;
    const affected = parts.filter((part) =>
      part.segs.some(([, end]) => end >= newLedCount),
    ).length;
    return { affected, parts };
  },

  /**
   * 缩短确认框的正文（**一帧都不发**的纯文案）。
   *
   * 「不自动缩短、整段失效」是设备侧的既定语义（§6.1：丢掉而不裁剪），
   * 所以文案必须提前说清楚「这些部位会整段黑掉」，而不是「会变短」。
   */
  shrinkConfirmTextOf(affected: number, newLedCount: number): string {
    return (
      `有 ${affected} 个部位的灯珠落在第 ${newLedCount + 1} 颗之后。` +
      "缩短后这些段会整段失效（不会被自动裁剪），对应的灯珠变成灰缝。"
    );
  },

  /**
   * 本机草稿：**v5 已经没有本地方案草稿**（`lumen.planDrafts.v1` 随「剧本 /
   * 方案」模型退役，编辑内容存在设备的场景里）。
   *
   * 保留这个空实现是为了让缩小预检的调用点不改形状——它现在只需要看布局。
   */
  draftsOfDevice(): never[] {
    return [];
  },

  /** 草稿键（v5 无草稿，恒为空串；保留以便调用点不变）。 */
  draftKeyOfDevice(): string {
    return "";
  },

  /**
   * 缩短后把被截断的**布局段**按新终点写回设备。
   *
   * v5 的几何只在布局里（§6.2：场景不含几何），所以这里只需要重写布局。
   * 设备在数量变更时已经把 `end >= new_count` 的段整段 prune 掉了
   * （§6.1：不自动缩短，整段丢弃），确认后把「截断版」写回去即可。
   *
   * 写失败只就地提示，不回滚已经成功的灯珠数。
   */
  async rewriteClampedParts(
    stripId: number,
    parts: readonly LayoutPart[],
    newLedCount: number,
  ): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    const clamped = parts
      .map((part) => {
        const segs = part.segs.filter(([start]) => start < newLedCount);
        /* 端点越过新上限的段按新上限截断（用户已确认过这一步）。 */
        const trimmed = segs.map(([start, end]) => [
          start,
          Math.min(end, newLedCount - 1),
        ] as [number, number]);
        return { ...part, segs: trimmed, segCount: trimmed.length };
      })
      .filter((part) => part.segs.length > 0);
    if (clamped.length === 0) {
      return;
    }
    try {
      const result = await session.writeLayout(stripId, clamped);
      if (result.kind === "ack-error") {
        this.patchStripRow(stripId, {
          ledHint: `灯珠数已改；布局写回失败（${resultText(result.ack.resultCode)}）`,
        });
        return;
      }
      if (result.kind === "error") {
        this.patchStripRow(stripId, { ledHint: `灯珠数已改；布局写回失败（${result.message}）` });
      }
    } catch (err) {
      this.patchStripRow(stripId, {
        ledHint: `灯珠数已改；布局写回失败（${errorText(err)}）`,
      });
    }
  },

  // ---------------- 显示的灯组（App 本地偏好，永不下发） ----------------

  /**
   * 灯组显隐开关（裁决 §7：从发现页搬到本页，与逐组灯珠数同页）。
   *
   * 这是**本机偏好**：WS2812B 无法回报物理接线，设备判断不了某条带是否真的
   * 插着。隐藏只是从设备页的灯组切换器里去掉，设备上的分区配置一个字节都
   * 不动，存储仍是 `lumen.deviceRegistry.v1` 的 `stripMask`。
   */
  async onTrimStrip(e: WechatMiniprogram.SwitchChange) {
    const deviceId = this.data.deviceId;
    const stripId = Number(e.currentTarget.dataset.stripId ?? -1);
    if (!deviceId || stripId < 0) {
      return;
    }
    try {
      this.registry = setStripEnabled(createWxStorage(), deviceId, stripId, Boolean(e.detail.value));
      const rows = this.data.stripRows.map((row) =>
        row.stripId === stripId ? { ...row, visible: Boolean(e.detail.value) } : row,
      );
      this.setData({ stripRows: rows });
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    }
  },

  // ---------------- 改名（本地先写，后端后同步） ----------------

  onRemarkInput(e: WechatMiniprogram.Input) {
    this.setData({ remarkInput: String(e.detail.value ?? "") });
  },

  async onRename() {
    const deviceId = this.data.deviceId;
    if (!deviceId || this.data.remarkBusy) {
      return;
    }
    this.setData({ remarkBusy: true });
    try {
      const storage = createWxStorage();
      this.registry = setRemark(storage, deviceId, this.data.remarkInput);
      this.setData({
        hint: "备注名已保存（仅本机；稍后同步到后端）",
      });
      wx.showToast({ title: "已保存", icon: "none" });

      /* 同步旁路：失败只影响别的手机看不看得见，本地已生效。 */
      const hardwareId = this.hardwareIdOf(deviceId);
      if (hardwareId !== null) {
        void this.sync
          ?.pushRemark({ deviceId, hardwareId })
          .then(() => this.updateIdentityHint());
      }
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    } finally {
      this.setData({ remarkBusy: false });
    }
  },

  hardwareIdOf(deviceId: string): string | null {
    const entry = this.registry?.devices.find((item) => item.deviceId === deviceId);
    if (entry?.hardwareId !== undefined && entry.hardwareId.length > 0) {
      return entry.hardwareId;
    }
    return this.session?.deviceInfo?.hwId ?? null;
  },

  updateIdentityHint() {
    const sync = this.sync;
    if (sync === null || !sync.enabled) {
      this.setData({ identityHint: "" });
      return;
    }
    /* #47：文案由同步层给（含「微信登录失败 / 登录已过期」的可读原因）。 */
    this.setData({ identityHint: sync.identityHint });
  },

  // ---------------- 断开 / 删除 ----------------

  async onDisconnect() {
    const session = this.session;
    if (session === null || this.data.disconnectBusy) {
      return;
    }
    this.setData({ disconnectBusy: true });
    try {
      await session.disconnect();
      wx.showToast({ title: "已断开", icon: "none" });
      setTimeout(() => {
        wx.navigateBack({ fail: () => undefined });
      }, 300);
    } finally {
      this.setData({ disconnectBusy: false });
    }
  },

  /**
   * 删除这台设备：解除后端关联 + 删本机记录。
   *
   * 设备本体不受影响（票面验收第 7 条）：它仍会出现在扫描结果里，
   * 点一下就能重新连上并重新登记。
   */
  async onDelete() {
    const deviceId = this.data.deviceId;
    if (!deviceId || this.data.deleteBusy) {
      return;
    }
    const confirmed = await showConfirm(
      "删除这台设备？",
      "本机会断开连接、清掉登记与封面；设备上的灯光配置不受影响，重新扫描仍能连上。",
    );
    if (!confirmed) {
      return;
    }
    this.setData({ deleteBusy: true });
    try {
      const hardwareId = this.hardwareIdOf(deviceId) ?? "";
      const backendId =
        this.registry?.devices.find((item) => item.deviceId === deviceId)?.backendId ?? null;
      /* 删除是**一组动作**（#91）：与「我的」页走同一个实现，语义只有一份。 */
      await deleteDeviceFully({
        storage: createWxStorage(),
        deviceId,
        hardwareId,
        session: this.session,
      });
      this.reloadRegistry();
      this.setData({ remarkInput: "", hint: "已删除本机记录" });
      /* 后端只解除关联：设备行保留，重新扫描仍可登记。 */
      void this.sync?.unlink(backendId);
      wx.showToast({ title: "已删除", icon: "none" });
    } catch (err) {
      wx.showToast({ title: errorText(err), icon: "none" });
    } finally {
      this.setData({ deleteBusy: false });
    }
  },
});

function showConfirm(
  title: string,
  content: string,
  confirmText: string = "删除",
): Promise<boolean> {
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
