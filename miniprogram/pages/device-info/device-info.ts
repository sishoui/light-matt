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
import { deviceKeyOf } from "../../utils/control/device-history";
import {
  affectedZoneCount,
  clampLedCount,
  draftZoneRanges,
  planShrink,
  shrinkConfirmText,
  shrinkDraft,
  sumStripLeds,
} from "../../utils/control/led-count-plan";
import { ledCountResultHint } from "../../utils/control/ledCount";
import { loadPlanDrafts, savePlanDraft } from "../../utils/control/plan-drafts";
import { deleteDeviceFully } from "../../utils/control/delete-device";
import { ControlSession } from "../../utils/control/session";
import { getSession } from "../../utils/control/session-singleton";
import { pageThemeData } from "../../utils/control/page-theme";
import { resolveStripMeta } from "../../utils/control/strip-meta";
import { zonesFromReports } from "../../utils/control/zone-editor";
import { MAX_LEDS, MIN_LEDS, MAX_STRIPS } from "../../utils/protocol/constants";
import type { DeviceInfo, DeviceState, SegmentSpec, StripConfig } from "../../utils/protocol/types";
import type { ScriptDraft } from "../../utils/control/script-view";

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
      const deviceCount = state?.stripCounts[stripId] ?? 0;
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
          : `灯珠 ${info.maxLeds} · 灯组 ${info.maxStrips} · 分区 ${info.maxSegments} · 步骤 ${info.maxStages} · 方案 ${info.maxScripts}`,
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

    /* 缩小才需要预检；改大永远不动任何已有分区（`planShrink` 对改大 0 命中）。 */
    let knownZones: SegmentSpec[] = [];
    if (value < current) {
      const precheck = await this.shrinkPlanOf(stripId, value);
      knownZones = precheck.deviceZones;
      if (precheck.affected > 0) {
        const confirmed = await showConfirm(
          "缩短灯组会截断分区",
          shrinkConfirmText(precheck.affected, value),
          "继续缩短",
        );
        if (!confirmed) {
          /* 取消：设备与草稿都不动，滑块回到设备值。 */
          this.backToDeviceValue(stripId);
          return;
        }
      }
    }

    const applied = await this.applyLedCount(stripId, value, current);
    if (applied !== true || value >= current) {
      return;
    }
    /* 设备在数量变更时会 prune 掉越界的旧分区（不自动缩短），确认后把截断过
     * 的那几条重新写回去，灯组仍能正常应用并播放。 */
    await this.rewriteClampedZones(stripId, knownZones, value);
  },

  /** 滑块回到设备权威值（取消 / 无效拖动 / 未连接）。 */
  backToDeviceValue(stripId: number): void {
    delete this.ledDrafts[stripId];
    this.patchStripRow(stripId, { ledCount: this.deviceLedCount(stripId), ledHint: "" });
  },

  /** 设备权威的某条灯珠数（未连接 / 没读到按 0）。 */
  deviceLedCount(stripId: number): number {
    return this.session?.deviceState?.stripCounts[stripId] ?? 0;
  },

  /** 一条 stripRow 的局部更新（`stripId` 找不到时什么都不做）。 */
  patchStripRow(stripId: number, patch: Partial<StripInfoRow>): void {
    const stripRows = this.data.stripRows.map((row) =>
      row.stripId === stripId ? { ...row, ...patch } : row,
    );
    this.setData({ stripRows, ledTotal: sumStripLeds(stripRows.map((row) => row.ledCount)) });
  },

  /**
   * 缩小前的本地预检：这条灯组的设备分区 + 落盘草稿里有多少会越界。
   *
   * **一帧都不发**。设备分区读不到时只按草稿算（读失败不该把缩小的路堵死，
   * 也不该谎报「没有越界」——草稿那一半仍然会数）。
   */
  async shrinkPlanOf(
    stripId: number,
    newLedCount: number,
  ): Promise<{ affected: number; deviceZones: SegmentSpec[] }> {
    const session = this.session;
    let deviceZones: SegmentSpec[] = [];
    if (session !== null) {
      const result = await session.queryStrip(stripId);
      if (result.kind === "ok") {
        deviceZones = zonesFromReports(result.reports.filter((item) => item.stripId === stripId));
      }
    }
    const drafts = this.draftsOfDevice();
    const affected = affectedZoneCount(deviceZones, draftZoneRanges(drafts, stripId), newLedCount);
    return { affected, deviceZones };
  },

  /**
   * 本机落盘的 4 套草稿（读不到时视为空表）。
   *
   * 草稿是设备级的（#75），键为 hardwareId 优先的设备键；空槽位以空数组计入。
   */
  draftsOfDevice(): ScriptDraft[] {
    const storage = createWxStorage();
    const key = this.draftKeyOfDevice();
    if (key.length === 0) {
      return [];
    }
    try {
      const loaded = loadPlanDrafts(storage, key);
      return loaded === null ? [] : loaded.filter((draft): draft is ScriptDraft => draft !== null);
    } catch {
      return [];
    }
  },

  /** 草稿落盘用的设备键（hardwareId 优先；身份未知时为空串）。 */
  draftKeyOfDevice(): string {
    const deviceId = this.data.deviceId;
    if (deviceId.length === 0) {
      return "";
    }
    const hardwareId = this.hardwareIdOf(deviceId);
    return deviceKeyOf({ deviceId, ...(hardwareId === null ? {} : { hardwareId }) });
  },

  /**
   * 下发新的灯珠数。
   *
   * 成功：把落盘草稿里这条灯组越界的分区按新长度清理并写回，滑块交还设备值。
   * 失败：**就地显示原因并保留原灯珠数**（草稿一个字节都不动——设备还是旧
   * 长度，先截断草稿就等于替用户丢编排）。
   */
  async applyLedCount(stripId: number, value: number, current: number): Promise<boolean | null> {
    const session = this.session;
    if (session === null) {
      return null;
    }
    this.setData({ ledBusyStripId: stripId });
    this.patchStripRow(stripId, { ledHint: "正在应用…" });
    try {
      /* stripId 显式传：改的是用户拖的那一条带，不是 strip 0。 */
      const result = await session.setLedCount(value, stripId);
      if (result.kind === "ok") {
        const applied = result.state.stripCounts[stripId] ?? value;
        delete this.ledDrafts[stripId];
        this.patchStripRow(stripId, {
          ledCount: applied,
          ledHint: `灯组 ${stripId + 1} 已设为 ${applied} 颗`,
        });
        /* 只有缩小才可能让草稿里的分区越界；改大一个字节都不动。 */
        if (applied < current) {
          await this.persistShrunkDrafts(stripId, applied);
        }
        return true;
      }
      if (result.kind === "ack-error") {
        const hint = ledCountResultHint(result.ack.resultCode) || "设置失败";
        this.revertLedCount(stripId, current, hint);
        return false;
      }
      if (result.kind === "stale") {
        this.backToDeviceValue(stripId);
        return null;
      }
      this.revertLedCount(stripId, current, `设置失败：${result.message}`);
      return false;
    } finally {
      this.setData({ ledBusyStripId: -1 });
    }
  },

  /** 失败：就地显示原因，滑块 **保留原灯珠数**。 */
  revertLedCount(stripId: number, current: number, hint: string): void {
    delete this.ledDrafts[stripId];
    this.patchStripRow(stripId, { ledCount: current, ledHint: hint });
    wx.showToast({ title: hint, icon: "none" });
  },

  /**
   * 把这条灯组落盘草稿里越界的分区按新长度清理并写回。
   *
   * 只动这条灯组那一片（`shrinkDraft` 只碰 `stripId`）；其它灯组原样保留。
   * 落盘失败只影响本机草稿，不回滚已经成功的设备数量。
   */
  async persistShrunkDrafts(stripId: number, newLedCount: number): Promise<void> {
    const storage = createWxStorage();
    const key = this.draftKeyOfDevice();
    if (key.length === 0) {
      return;
    }
    try {
      const loaded = loadPlanDrafts(storage, key);
      if (loaded === null) {
        return;
      }
      for (let slot = 0; slot < loaded.length; slot += 1) {
        const draft = loaded[slot];
        if (draft === null) {
          continue;
        }
        const result = shrinkDraft(draft, stripId, newLedCount);
        if (result.changed) {
          savePlanDraft(storage, key, slot, result.draft);
        }
      }
    } catch {
      /* 存储异常不影响设备侧结果：下一次编辑会再写一遍。 */
    }
  },

  /**
   * 把被截断的分区按新终点重新写回设备。
   *
   * 设备在数量变更时已经把 `end >= new_count` 的段整段 prune 掉了
   * （protocol-v4 §7.2：不自动缩短，整段丢弃），所以确认后只需把「截断版」
   * 写回去——`SetSegment` 按 (灯组, 槽位) 覆盖同一格，不会与保留的段重叠。
   * 写失败只就地提示，不回滚已经成功的灯珠数。
   */
  async rewriteClampedZones(
    stripId: number,
    zones: readonly SegmentSpec[],
    newLedCount: number,
  ): Promise<void> {
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
          this.patchStripRow(stripId, {
            ledHint: `灯珠数已改；分区写回失败（${resultText(ack.resultCode)}）`,
          });
          return;
        }
      }
    } catch (err) {
      this.patchStripRow(stripId, { ledHint: `灯珠数已改；分区写回失败（${errorText(err)}）` });
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
