/**
 * 走查表（#128）：唯一的「走查内容」。
 *
 * 每一行是「用户做了什么」+「界面说了什么」+「设备做了什么」。顺序是一条真实
 * 用户的旅程：`step` 行继承上一步的现场，`probe` 行自清理，`settle` 行收尾。
 *
 * 12 个 `ticket` 位 = 规格 #127 的 12 处对不上，分布在 8 个仍然存在的票号上。
 * 修好一张票就把对应行的 `expectation` 改成 `must-hold`——那一刻它会先红一次
 * （`judge` 的第三格），逼你确认分歧真的消失了。
 */

import { SEGMENT_TYPE } from "../../../utils/protocol/constants";
import { layerModeNameOf } from "../../../utils/control/effect-view";
import { simpleEffectIdOfType, simpleEffectOf } from "../../../utils/control/simple-effects";
import { PANEL_EMPTY_PLAN_GUIDE, PANEL_EMPTY_STEP_GUIDE } from "../../../utils/control/effect-panel";
import { planIsEmpty, zonesOfStep } from "../../../utils/control/plan-editor";
import type { SegmentReport } from "../../../utils/protocol/types";
import {
  AGREE,
  capability,
  deviceReading,
  snapshotReading,
  uiReading,
  type ActContext,
  type Judgement,
  type ObserveContext,
  type Sample,
  type Step,
} from "./types";
import { loopOfFlags } from "./world";

/** 点一下：小程序给的是 `{ currentTarget: { dataset } }`。 */
const tap = (dataset: Record<string, unknown>) => ({ currentTarget: { dataset } });
/** 滑块拖动：小程序给的是 `{ detail: { value } }`。 */
const slide = (value: number) => ({ detail: { value } });

/** 简单档参数区标题里不该再出现的旧色卡名（#135）。 */
const OLD_CARD_NAMES = ["暖白", "冷蓝", "紫色氛围", "流光", "爆闪白", "心跳暖红", "熄灭黑"];

/**
 * 跨 act / observe 的一点点事实。
 *
 * `observe` 只能读世界，不能读 `act` 的局部变量；而「tap 之前 power 是什么」
 * 只有 act 那一刻知道。按行 id 记在一个小表里，比给上下文加一个写通道干净。
 */
const facts = new Map<string, unknown>();
const remember = <T>(id: string, value: T): T => {
  facts.set(id, value);
  return value;
};
const recall = <T>(id: string): T | undefined => facts.get(id) as T | undefined;

async function idle(act: ActContext, page: keyof ActContext["pages"], field: string): Promise<void> {
  /* 页面自己的「忙」标记：等它落下再读设备，否则会读到下发前的那一帧。 */
  await act.waitPageIdle(page, field, 40_000).catch(() => undefined);
}

/** 设备上这一组的分区（`queryStrip` 读回，不是页面缓存）。 */
async function stripZones(observe: ObserveContext, stripId: number): Promise<SegmentReport[]> {
  const reports = await observe.queryStrip(stripId);
  return reports.filter((report) => report.stripId === stripId);
}

/** 最新下发方案里某一步、某一组的段数；`-1` = 没有这一步。 */
function stageZoneCount(script: { stages: { segments: readonly { stripId: number }[] }[] } | null, stageIndex: number, stripId: number): number {
  const stage = script === null ? undefined : script.stages[stageIndex];
  if (stage === undefined) {
    return -1;
  }
  return stage.segments.filter((segment) => segment.stripId === stripId).length;
}

/** 方案形状的一行摘要（阶段数与分区总数）。 */
function shapeOf(script: { stages: readonly { segments: readonly unknown[] }[] } | null): string {
  if (script === null) {
    return "还没下发过方案";
  }
  const segments = script.stages.reduce((sum, stage) => sum + stage.segments.length, 0);
  return `stages=${script.stages.length} segments=${segments}`;
}

function holds(ok: boolean, why: string): Judgement {
  return ok ? AGREE : { agrees: false, blame: "ui", why };
}

/**
 * 给当前步骤画一个分区（让方案非空，`applyAdvanced` 才会下发）。
 *
 * 当前步骤已经有分区时直接返回：再画一个同区间会被重叠预检拒掉，于是
 * 「什么都没发生」——那是测试自己的操作错误，不是产品行为。
 */
async function addZoneOn(act: ActContext, end = "4"): Promise<void> {
  const page = act.pages.strip;
  if (page.currentZones().length > 0) {
    return;
  }
  page.onZoneAdd();
  await act.sleep(200);
  page.onPickerCellTap(tap({ index: "0" }));
  await act.sleep(150);
  page.onPickerCellTap(tap({ index: end }));
  await act.sleep(150);
  page.onPickerConfirm();
  await idle(act, "strip", "applying");
  await act.sleep(800);
}

export const WALKTHROUGH: readonly Step[] = [
  {
    id: "walkthrough.connected",
    kind: "step",
    does: "扫到设备、连上，五个页面都装上并 ready",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      /* 连接已经在 beforeAll 里做过。world 在「扫到了但连不上」时只放行本行，
       * 于是连接回归落在这里的断言里，而不是被 vitest 记成整份 skipped。 */
      await ctx.waitPageReady("home", 20_000);
    },
    async observe(o) {
      const state = await o.refreshState();
      return {
        ui: uiReading("home.statusText", o.pages.home.data.statusText),
        device: deviceReading(
          "refreshState",
          "power/brightness/stripCount",
          `${state.power}/${state.brightness}/${state.stripCount}`,
        ),
      };
    },
    compare(sample) {
      const ok = String(sample.ui.value).startsWith("已连接");
      return holds(ok, "首页状态条没写「已连接」，说明页面没拿到 ready");
    },
  },

  /* ---------------- 基线：今天就该通过的四条 ---------------- */
  {
    id: "baseline.home-power-key",
    kind: "step",
    does: "点首页大卡的电源键，设备真的换开关状态",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      const before = ctx.pages.home.data.current?.powerOn === true;
      /* 页面自己的处理器：读 State → SetPower → 回执写进 powerHint。 */
      await ctx.pages.home.onPowerTap();
      await idle(ctx, "home", "busy");
      await ctx.sleep(400);
      await ctx.waitMirror((state) => (state.power === 1) !== before, "电源位翻转", 10_000);
    },
    async observe(o) {
      /* 断言用确定读回：`deviceState` 是 20Hz 镜像，会与页面读数错开一帧。 */
      const state = await o.refreshState();
      const home = o.pages.home;
      return {
        ui: uiReading("home.powerHint", `hint=${JSON.stringify(home.data.powerHint)} busy=${home.data.busy}`),
        device: deviceReading("refreshState", "power", state.power),
      };
    },
    compare(sample) {
      const ui = String(sample.ui.value);
      const power = sample.device.value as number;
      if (power !== 1 && power !== 0) {
        return { agrees: false, blame: "device", why: `power 不是 0/1（收到 ${String(power)}）` };
      }
      if (!/灯光已打开|灯光已关闭/.test(ui)) {
        return { agrees: false, blame: "ui", why: `电源键没有给出就地反馈（${ui}）` };
      }
      const saidOn = ui.includes("灯光已打开");
      return saidOn === (power === 1)
        ? AGREE
        : { agrees: false, blame: "ui", why: `提示说「${saidOn ? "打开" : "关闭"}」，设备 power=${power}` };
    },
  },
  {
    id: "baseline.home-brightness",
    kind: "step",
    does: "拖首页大卡的亮度滑条，设备亮度落到那一档",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      const max = await ctx.deviceMaxBrightness();
      /* 拖到上限的一半：不碰 0（0 会让下一次开灯走「恢复亮度」分支）。 */
      const target = Math.max(1, Math.round(max / 2));
      const home = ctx.pages.home;
      home.onBrightnessChanging(slide(target));
      home.onBrightnessChange(slide(target));
      await ctx.sleep(800);
      await ctx.waitMirror((state) => state.brightness === target, `亮度落到 ${target}`, 10_000);
    },
    async observe(o) {
      const state = await o.refreshState();
      return {
        ui: uiReading("home.brightnessSlider", o.pages.home.data.brightnessSlider),
        device: deviceReading("refreshState", "brightness", state.brightness),
      };
    },
    compare(sample) {
      const ui = sample.ui.value as number;
      const device = sample.device.value as number;
      return ui === device ? AGREE : { agrees: false, blame: "ui", why: `滑条停在 ${ui}，设备是 ${device}` };
    },
  },
  {
    id: "baseline.device-strip-switch",
    kind: "step",
    does: "在设备页关掉第 2 条灯组，只有那一条的掩码位变化",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      await ctx.pages.device.onStripPowerChange({
        currentTarget: { dataset: { stripId: 1 } },
        detail: { value: false },
      });
      await ctx.waitMirror((state) => (state.stripPowerMask & 0x02) === 0, "第 2 条灯组关掉", 10_000);
    },
    async observe(o) {
      const state = await o.refreshState();
      const card = (o.pages.device.data.stripCards as any[]).find((item) => item.stripId === 1);
      return {
        ui: uiReading("device.stripCards[1].on", card === undefined ? "缺卡片" : card.on),
        device: deviceReading(
          "refreshState",
          "stripPowerMask",
          `bit1=${(state.stripPowerMask & 0x02) !== 0} mask=0x${state.stripPowerMask.toString(16)}`,
        ),
      };
    },
    compare(sample) {
      const ui = sample.ui.value as boolean | string;
      const device = String(sample.device.value);
      if (ui === "缺卡片") {
        return { agrees: false, blame: "ui", why: "设备页没有第 2 条灯组的卡片" };
      }
      return ui === false && device.includes("bit1=false")
        ? AGREE
        : { agrees: false, blame: "ui", why: `开关显示 ${String(ui)}，设备 ${device}` };
    },
  },
  {
    id: "baseline.simple-mode-effect",
    kind: "step",
    does: "在灯组页简单档选「呼吸」，设备上这一组变成呼吸类型",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      const page = ctx.pages.strip;
      page.onModeTap(tap({ mode: "simple" }));
      await ctx.sleep(200);
      page.onEffectRowTap();
      await ctx.sleep(100);
      page.onEffectPick(tap({ id: "breathe" }));
      await idle(ctx, "strip", "quickBusy");
      await ctx.sleep(600);
    },
    async observe(o) {
      const zones = await stripZones(o, 0);
      const row = (o.pages.strip.data.effectRows as any[])[0];
      return {
        ui: uiReading("strip.effectRows[0].value", row === undefined ? "缺灯效行" : row.value),
        device: deviceReading(
          "queryStrip",
          "strip0.layer0.type",
          zones.length === 0
            ? "无分区"
            : `0x${zones[0].layer0.type.toString(16)} ${layerModeNameOf(zones[0].layer0.type)}`,
        ),
      };
    },
    compare(sample) {
      const ui = String(sample.ui.value);
      const device = String(sample.device.value);
      const want = `0x${SEGMENT_TYPE.BREATHING.toString(16)} `;
      return device.includes(want) && ui === "呼吸"
        ? AGREE
        : { agrees: false, blame: "ui", why: `界面写「${ui}」，设备 ${device}` };
    },
  },

  /* ---------------- 12 项发现 ---------------- */

  /* 发现 8（#135）：简单档首开冒充常亮。必须排在其它简单档写入之前——它要的是
   * 「这一组设备上零分区、页面又没选过灯效」那一刻。 */
  {
    id: "strip.simple.first-open-honest",
    ticket: "#135",
    kind: "probe",
    does: "设备上这一组零分区时，简单档的灯效行不该写「常亮」",
        expectation: { kind: "must-hold" },
    async act(ctx) {
      /* `neutralise()` 由执行器先调：停播 + 清分区。这里重开一次页面，
       * 让它从「设备上什么都没有」重新派生（重开 = 重新 onLoad + onShow）。 */
      const page = ctx.pages.strip;
      page.onLoad({ strip: "0" });
      page.onShow();
      await ctx.sleep(600);
      await ctx.waitPageReady("strip", 15_000).catch(() => undefined);
      await ctx.sleep(400);
    },
    async observe(o) {
      const zones = await stripZones(o, 0);
      const row = (o.pages.strip.data.effectRows as any[])[0];
      return {
        ui: uiReading("strip.effectRows[0].value", row === undefined ? "缺灯效行" : row.value),
        device: deviceReading("queryStrip", "strip0.zones", zones.length),
      };
    },
    compare(sample) {
      const ui = String(sample.ui.value);
      const zones = sample.device.value as number;
      if (zones > 0) {
        return { agrees: false, blame: "device", why: `设备上还有 ${zones} 个分区，这一行的前提不成立` };
      }
      return ui === "未设置"
        ? AGREE
        : { agrees: false, blame: "ui", why: `设备零分区，灯效行却写「${ui}」` };
    },
  },

  /* 发现 6（#133）：没有删步骤。协议里没有「删单一步」的命令，所以设备值是
   * 一份能力说明：界面上根本没有入口，就是这条证据本身。 */
  {
    id: "strip.advanced.delete-step-exists",
    ticket: "#133",
    kind: "probe",
    does: "进阶档里能不能删掉一个步骤",
    expectation: {
      kind: "known-divergence",
      ticket: "#133",
      note: "页面上没有删除步骤的入口；`removeStepStage` 有实现、零调用点",
    },
    async act(ctx) {
      ctx.pages.strip.onModeTap(tap({ mode: "advanced" }));
      await ctx.sleep(300);
    },
    async observe(o) {
      const page = o.pages.strip;
      return {
        ui: uiReading(
          "strip.onStepDelete",
          typeof page.onStepDelete === "function" ? "有处理器" : "无入口",
        ),
        device: {
          side: "device",
          from: "capability",
          at: "协议里的删步骤命令",
          value: capability("没有删除单一步骤的命令（只能整套重写方案）"),
        },
      };
    },
    compare(sample) {
      return String(sample.ui.value) === "有处理器"
        ? AGREE
        : { agrees: false, blame: "ui", why: "页面没有删除步骤的处理器，用户加错一步撤不掉" };
    },
  },

  /* 发现 5（#133）：加空步骤让灯黑一帧。 */
  {
    id: "strip.advanced.add-step-inherits",
    ticket: "#133",
    kind: "probe",
    does: "在进阶档加一个步骤，新步骤不该是零分区",
    expectation: {
      kind: "known-divergence",
      ticket: "#133",
      note: "新步骤 `segments` 为空，轮到它时整组黑一帧",
    },
    async act(ctx) {
      const page = ctx.pages.strip;
      page.onModeTap(tap({ mode: "advanced" }));
      await ctx.sleep(300);
      page.onStepTap(tap({ index: 0 }));
      await ctx.sleep(150);
      /* 先让整份方案非空：空方案时 `applyAdvanced` 一帧都不发。 */
      await addZoneOn(ctx);
      page.onStepAdd();
      await ctx.sleep(200);
      /* 加步骤本身不下发（#125 只在改动落到草稿后由离散动作触发）。改一个
       * 时长是真实用户紧接着会做的事，同时把整份方案（含新步骤）送出去。 */
      page.onDurationChange(slide(3));
      await idle(ctx, "strip", "applying");
      await ctx.sleep(900);
    },
    async observe(o) {
      const page = o.pages.strip;
      const script = o.lastScript();
      const lastStage = page.currentDraft().stages.length - 1;
      return {
        ui: uiReading("strip.stepCount", page.data.stepCount),
        device: deviceReading(
          "lastDownloadedScript",
          `stages[${lastStage}].segments(strip0)`,
          stageZoneCount(script, lastStage, 0),
        ),
      };
    },
    compare(sample) {
      const ui = sample.ui.value as number;
      const zones = sample.device.value as number;
      if (zones < 0) {
        return { agrees: false, blame: "device", why: "最新下发的方案里没有最后一步" };
      }
      return ui >= 2 && zones > 0
        ? AGREE
        : { agrees: false, blame: "ui", why: `界面有 ${ui} 个步骤，最后一步在设备方案里是 ${zones} 段` };
    },
  },

  /* 发现 10（#139）：简单档改色静默改写方案。 */
  {
    id: "strip.simple.recolor-keeps-plan",
    ticket: "#139",
    kind: "probe",
    does: "方案在播时在简单档改色，界面要说清「停了播放」，方案内容不该被改写",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      const page = ctx.pages.strip;
      page.onModeTap(tap({ mode: "advanced" }));
      await ctx.sleep(300);
      page.onStepTap(tap({ index: 0 }));
      await ctx.sleep(150);
      await addZoneOn(ctx);
      await ctx.waitMirror((state) => state.playbackState === 1, "方案开始播放", 15_000);

      page.onModeTap(tap({ mode: "simple" }));
      await ctx.sleep(200);
      page.onEffectRowTap();
      await ctx.sleep(100);
      page.onEffectPick(tap({ id: "rainbow" }));
      await idle(ctx, "strip", "quickBusy");
      await ctx.sleep(900);
    },
    async observe(o) {
      const state = await o.refreshState();
      return {
        ui: uiReading("strip.quickHint", o.pages.strip.data.quickHint),
        device: deviceReading(
          "lastDownloadedScript",
          "playbackState + 方案形状",
          `playback=${state.playbackState} ${shapeOf(o.lastScript())}`,
        ),
      };
    },
    compare(sample) {
      const hint = String(sample.ui.value);
      const device = String(sample.device.value);
      /* 票面的裁决：改色 = 停止播放并转为实时灯效，不重下方案、不恢复播放。 */
      if (!device.includes("playback=0")) {
        return {
          agrees: false,
          blame: "ui",
          why: `改色之后设备仍在播（${device}）；票面要求停播转实时灯效`,
        };
      }
      return hint.includes("已停止播放") || hint.includes("停播")
        ? AGREE
        : { agrees: false, blame: "ui", why: `设备已停播，但提示被覆盖成「${hint}」，用户看不到「你刚停掉了方案」` };
    },
  },

  /* 发现 2（#130）：自动回连后电源键失效。真断线、真回连。 */
  {
    id: "home.power-after-reconnect",
    ticket: "#130",
    kind: "probe",
    does: "掉线自动回连之后，首页电源键仍然能关灯",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      await ctx.waitLink("ready");
      const home = ctx.pages.home;
      home.onShow();
      await ctx.sleep(300);

      await ctx.disturb("drop-link");
      await ctx.waitLink("idle", 10_000);
      /* 1s/2s/4s 退避，实测约 4.9s；给 20s。 */
      await ctx.waitLink("ready", 20_000);
      await ctx.sleep(600);

      remember("home.power-after-reconnect.powerBefore", home.data.current?.powerOn === true);
      await home.onPowerTap();
      await ctx.sleep(1200);
    },
    async observe(o) {
      const state = await o.refreshState();
      const home = o.pages.home;
      const before = recall<boolean>("home.power-after-reconnect.powerBefore") === true;
      return {
        ui: uiReading(
          "home.busy/powerHint",
          `busy=${home.data.busy} powerHint=${JSON.stringify(home.data.powerHint)}`,
        ),
        device: deviceReading(
          "refreshState",
          "power",
          `tap 前=${before ? 1 : 0} tap 后=${state.power}${(state.power === 1) === before ? "（没翻转）" : "（已翻转）"}`,
        ),
      };
    },
    compare(sample) {
      const ui = String(sample.ui.value);
      const device = String(sample.device.value);
      /* 判据只看设备：点电源键**必须**翻转开关，没翻转就是界面没把这一下做出去。
       * `busy=true` 是机制（`onPowerTap` 第一条就 return），写进归因里。
       * 注意 hint 可能不是空串而是上一行留下的旧句子（同一次进程里首页只有
       * 一个实例），所以「静默」不能靠 hint 为空来判。 */
      if (device.includes("（已翻转）")) {
        return AGREE;
      }
      return {
        agrees: false,
        blame: "ui",
        why: `点下去电源位没翻转（${device}）；${ui.includes("busy=true") ? "busy 卡在 true，`onPowerTap` 静默返回" : "界面没有给出任何可执行的动作"}，屏幕上的提示是「${ui.split("powerHint=")[1] ?? ""}」`,
      };
    },
  },

  /* 发现 3（#131）：已连接时扫描拆掉连接。 */
  {
    id: "home.scan-keeps-link",
    ticket: "#131",
    kind: "probe",
    does: "已连接时扫一次再停止，连接不该被拆掉",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      await ctx.waitLink("ready");
      const discover = ctx.pages.discover;
      discover.onShow();
      await ctx.sleep(200);
      await discover.onScanTap();
      await ctx.sleep(900);
      /* 再点一次 = 停止扫描（同一按钮的三态）。 */
      await discover.onScanTap();
      await ctx.sleep(900);
    },
    async observe(o) {
      const link = o.linkState();
      const alive = await o.queryStateOk();
      return {
        ui: uiReading("home.statusText", o.pages.home.data.statusText),
        device: deviceReading(
          "refreshState",
          "linkState + QueryState",
          `${link} queryState=${alive ? "通" : "不通"}`,
        ),
      };
    },
    compare(sample) {
      const device = String(sample.device.value);
      if (!device.startsWith("ready")) {
        return { agrees: false, blame: "ui", why: `扫完停扫后链路是 ${device}，而设备其实一直连着` };
      }
      return device.includes("queryState=通")
        ? AGREE
        : { agrees: false, blame: "device", why: `链路报 ready，但 QueryState 不通（${device}）` };
    },
  },

  /* 发现 4（#131）：状态条写「停止」却跳转。 */
  {
    id: "home.status-action-does-what-it-says",
    ticket: "#131",
    kind: "probe",
    does: "首页状态条写「停止」时点它，扫描真的停下",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      /* 上一条可能把链路留在 scanning 或 idle：先归一，再从干净状态起扫。
       * 这一行要验的是「文案与行为同源」，前提必须是**一次新的扫描**。 */
      await ctx.waitLink("ready").catch(() => undefined);
      const discover = ctx.pages.discover;
      discover.onShow();
      await ctx.sleep(200);
      /* 还在扫就先停，否则下一次 onScanTap 是「停止」而不是「开始」。 */
      if (!ctx.isScanning()) {
        await discover.onScanTap();
        await ctx.waitLink("scanning", 10_000).catch(() => undefined);
      }
      const home = ctx.pages.home;
      /* #131：已连接时的扫描不拆链路，`linkState` 是 scanning 而连接仍在。
       * 首页要在**扫描进行中**那一刻重算状态条，才能看到「停止」。 */
      home.onShow();
      await ctx.sleep(300);
      /* 记下**点之前**那一刻的文案：点完之后扫描已经停了，状态条必然变成
       * 「设备」——那不是不一致，那正是这一下生效了。 */
      const tappedAction = String(home.data.statusAction);
      remember("home.status-action-does-what-it-says.tappedAction", tappedAction);
      if (tappedAction === "停止") {
        home.onStatusTap();
      }
      await ctx.sleep(1200);
      /* 不留现场：下面的行要的是干净链路。刻意**不**在这里停扫——
       * 那会把这条发现唯一能看到的证据抹掉。 */
    },
    async observe(o) {
      const link = o.linkState();
      return {
        ui: uiReading("home.statusAction（点击前）", recall("home.status-action-does-what-it-says.tappedAction") ?? ""),
        device: deviceReading("refreshState", "点完之后 linkState", link),
      };
    },
    compare(sample) {
      const action = String(sample.ui.value);
      const link = String(sample.device.value);
      if (action !== "停止") {
        return { agrees: false, blame: "ui", why: `扫描中状态条动作是「${action}」而不是「停止」，前提不成立` };
      }
      return link === "scanning"
        ? { agrees: false, blame: "ui", why: "点了写着「停止」的状态条，链路仍是 scanning（扫描没停）" }
        : AGREE;
    },
  },

  /* 发现 12（#131，记录项）：发现页空态指向反向按钮。 */
  {
    id: "discover.empty-hint-matches-button",
    ticket: "#131",
    kind: "probe",
    does: "发现页扫描中的空态提示不指向一个已经变成「停止扫描」的按钮",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      const discover = ctx.pages.discover;
      discover.onShow();
      await ctx.sleep(200);
      /* 上一条发现可能把链路留在 scanning（那正是它的证据）。只在没在扫时开扫。 */
      await ctx.waitLink("scanning", 800).catch(async () => {
        await discover.onScanTap();
      });
      await ctx.waitLink("scanning", 10_000);
      await ctx.sleep(1200);
    },
    async observe(o) {
      const page = o.pages.discover;
      const link = o.linkState();
      return {
        ui: uiReading("discover.emptyHint", page.data.emptyHint),
        device: deviceReading(
          "refreshState",
          "scanLabel + linkState",
          `scanLabel=${page.data.scanLabel} link=${link}`,
        ),
      };
    },
    compare(sample) {
      const hint = String(sample.ui.value);
      const device = String(sample.device.value);
      if (!device.includes("link=scanning")) {
        return { agrees: false, blame: "device", why: `这一行要求扫描中，实际 ${device}` };
      }
      const pointsAway = hint.includes("重新扫描") && device.includes("scanLabel=停止扫描");
      return pointsAway
        ? { agrees: false, blame: "ui", why: `按钮是「停止扫描」，提示却让人点「重新扫描」（${hint}）` }
        : AGREE;
    },
  },

  /* 发现 9（#137）：进阶档引导指错地方。
   *
   * grounding 实测：停在空步骤、其它步骤有内容时，`panelData` 给出的是
   * `PANEL_EMPTY_STEP_GUIDE`（正确文案）。规格描述的路径没有复现，本轮的探针
   * 也没有。所以这一行不挂 known-divergence：断言仍然是真断言（三级引导互斥且
   * 指向当前这一步），今天成立，将来判据被改回「只看方案级」时会变红。
   * 票号保留，`validateTable` 的 12 个发现位因此不缩水。 */
  {
    id: "strip.advanced.guide-right-level",
    ticket: "#137",
    kind: "probe",
    does: "停在一个空步骤上时，面板引导说的是「这一步」而不是「整套方案」",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      const page = ctx.pages.strip;
      page.onModeTap(tap({ mode: "advanced" }));
      await ctx.sleep(300);
      page.onStepTap(tap({ index: 0 }));
      await ctx.sleep(150);
      /* 第 1 步有分区 → 整份方案非空。 */
      await addZoneOn(ctx);
      /* 再走到一个空步骤上。 */
      page.onStepAdd();
      await ctx.sleep(200);
      page.onStepTap(tap({ index: page.data.stepCount - 1 }));
      await ctx.sleep(400);
    },
    async observe(o) {
      const page = o.pages.strip;
      const draft = page.currentDraft();
      const stepIndex = page.data.stepIndex as number;
      const stepZones = zonesOfStep(draft.stages[stepIndex], 0).length;
      const otherContent = draft.stages.some(
        (stage: { segments: readonly unknown[] }, index: number) =>
          index !== stepIndex && stage.segments.length > 0,
      );
      return {
        ui: uiReading("strip.panelGuide", page.data.panelGuide),
        device: deviceReading(
          "lastDownloadedScript",
          "planEmpty/stepZones/otherSteps",
          `planEmpty=${planIsEmpty(draft)} stepZones=${stepZones} otherSteps=${otherContent}`,
        ),
      };
    },
    compare(sample) {
      const guide = String(sample.ui.value);
      const device = String(sample.device.value);
      if (!device.includes("stepZones=0")) {
        return guide === ""
          ? AGREE
          : { agrees: false, blame: "ui", why: `这一步有分区，面板却写「${guide}」` };
      }
      if (device.includes("planEmpty=true")) {
        return guide === PANEL_EMPTY_PLAN_GUIDE
          ? AGREE
          : { agrees: false, blame: "ui", why: `整份方案为空，引导应是「${PANEL_EMPTY_PLAN_GUIDE}」，实际「${guide}」` };
      }
      return guide === PANEL_EMPTY_STEP_GUIDE
        ? AGREE
        : {
            agrees: false,
            blame: "ui",
            why: `方案里其它步骤有内容（${device}），引导应是「${PANEL_EMPTY_STEP_GUIDE}」，实际「${guide}」`,
          };
    },
  },

  /* 发现 7（#135）：简单档名字两套。 */
  {
    id: "strip.simple.name-single-source",
    ticket: "#135",
    kind: "probe",
    does: "简单档的参数区标题与灯效行用的是同一个名字",
        expectation: { kind: "must-hold" },
    async act(ctx) {
      const page = ctx.pages.strip;
      page.onModeTap(tap({ mode: "simple" }));
      await ctx.sleep(200);
      page.onEffectRowTap();
      await ctx.sleep(100);
      page.onEffectPick(tap({ id: "comet" }));
      await idle(ctx, "strip", "quickBusy");
      await ctx.sleep(700);
    },
    async observe(o) {
      const page = o.pages.strip;
      const zones = await stripZones(o, 0);
      const type = zones.length === 0 ? null : zones[0].layer0.type;
      const id = type === null ? null : simpleEffectIdOfType(type);
      const deviceName =
        type === null ? "无分区" : id === null ? `未知类型 0x${type.toString(16)}` : simpleEffectOf(id)?.name ?? "未知";
      const row = (page.data.effectRows as any[])[0]?.value ?? "";
      const title = page.data.simpleParams?.title ?? "";
      return {
        ui: uiReading("strip.simpleParams.title", `${title}（灯效行 ${row}）`),
        device: deviceReading("queryStrip", "strip0.layer0.type→名字", deviceName),
      };
    },
    compare(sample) {
      const ui = String(sample.ui.value);
      const device = String(sample.device.value);
      const title = ui.split("（")[0];
      const dirty = OLD_CARD_NAMES.find((word) => title.includes(word));
      if (dirty !== undefined) {
        return {
          agrees: false,
          blame: "ui",
          why: `参数区标题还在用旧色卡名「${dirty}」（${ui}），设备上是「${device}」`,
        };
      }
      return title.includes(device)
        ? AGREE
        : { agrees: false, blame: "ui", why: `标题「${ui}」与设备上的「${device}」对不上` };
    },
  },

  /* 发现 1（#129）：固件版本按大端解析。 */
  {
    id: "deviceinfo.firmware-version",
    ticket: "#129",
    kind: "probe",
    does: "设备信息页的固件版本与设备自报的字节一致",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      const page = ctx.pages.deviceInfo;
      page.onShow();
      for (let i = 0; i < 60 && page.data.firmwareText === "—"; i += 1) {
        await ctx.sleep(100);
      }
    },
    async observe(o): Promise<Sample<string, string>> {
      const payload = o.rawDeviceInfoPayload();
      if (payload === null) {
        throw new Error("帧日志里没有 0x88 的原始载荷");
      }
      /* 独立真值：载荷前两字节按**小端**解（固件就是这么写的）。 */
      const le = (payload[0] & 0xff) | ((payload[1] & 0xff) << 8);
      return {
        ui: uiReading("deviceInfo.firmwareText", o.pages.deviceInfo.data.firmwareText),
        device: deviceReading(
          "frameLog",
          "0x88 payload[0..1] 按小端",
          `v${le >> 8}.${le & 0xff}（0x${le.toString(16).padStart(4, "0")}）`,
        ),
      };
    },
    compare(sample) {
      const ui = String(sample.ui.value);
      const device = String(sample.device.value);
      const noOf = (text: string): number | null => {
        const found = /0x([0-9a-fA-F]{4})/.exec(text);
        return found === null ? null : parseInt(found[1], 16);
      };
      const deviceVersion = noOf(device);
      if (deviceVersion === null) {
        return { agrees: false, blame: "device", why: `设备侧解析不出 0x 版本号（${device}）` };
      }
      return noOf(ui) === deviceVersion
        ? AGREE
        : { agrees: false, blame: "ui", why: `界面写「${ui}」，设备字节按小端是「${device}」` };
    },
  },

  /* 发现 11（#140）：亮度百分比口径。 */
  {
    id: "home.brightness.percent-honest",
    ticket: "#140",
    kind: "probe",
    does: "首页亮度滑条的原始值旁边标出了设备上限，两个数字不再互相矛盾",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      const max = await ctx.deviceMaxBrightness();
      const target = Math.max(1, Math.round(max / 2));
      const home = ctx.pages.home;
      home.onShow();
      await ctx.sleep(300);
      home.onBrightnessChanging(slide(target));
      home.onBrightnessChange(slide(target));
      await ctx.sleep(800);
      await ctx.waitMirror((state) => state.brightness === target, `亮度落到 ${target}`, 10_000);
    },
    async observe(o) {
      const state = await o.refreshState();
      const home = o.pages.home;
      return {
        ui: uiReading(
          "home.brightnessSlider/max/percent + 上限文案",
          `${home.data.brightnessSlider}/${home.data.brightnessMax}/${home.data.brightnessPercent}% caption=${JSON.stringify(home.data.brightnessHint ?? "")}`,
        ),
        device: deviceReading(
          "refreshState",
          "brightness/maxBrightness",
          `${state.brightness}/${state.maxBrightness}`,
        ),
      };
    },
    compare(sample) {
      const ui = String(sample.ui.value);
      const device = String(sample.device.value);
      const [deviceBrightness, deviceMax] = device.split("/").map(Number);
      const caption = /caption=(".*")$/.exec(ui)?.[1] ?? "";
      const [uiSlider, uiMax, uiPercentRaw] = ui.split(" ")[0].split("/");
      const uiPercent = Number(uiPercentRaw.replace("%", ""));
      if (!Number.isFinite(deviceBrightness) || !Number.isFinite(deviceMax) || deviceMax <= 0) {
        return { agrees: false, blame: "device", why: `设备亮度读数不可用（${device}）` };
      }
      if (Number(uiSlider) !== deviceBrightness || Number(uiMax) !== deviceMax) {
        return {
          agrees: false,
          blame: "ui",
          why: `滑条 ${uiSlider}/${uiMax} 与设备 ${deviceBrightness}/${deviceMax} 对不上`,
        };
      }
      /* 票面的判据：上限必须以可见文字标出，否则「100」与「50%」并列无解。 */
      const capped = caption.includes("上限") || caption.includes(String(deviceMax));
      if (!capped) {
        return {
          agrees: false,
          blame: "ui",
          why: `滑条是 ${deviceBrightness}/${deviceMax}，旁边写 ${uiPercent}% 却没有一处说明上限是 ${deviceMax}`,
        };
      }
      return AGREE;
    },
  },

  /* ---------------- 剩下的基线：循环三档与回连后仍可控 ---------------- */
  {
    id: "baseline.advanced-loop-tristate",
    kind: "step",
    does: "进阶档点「全部循环」和「最后一步循环」，设备 flags 各落到那一档",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      const page = ctx.pages.strip;
      page.onModeTap(tap({ mode: "advanced" }));
      await ctx.sleep(300);
      page.onStepTap(tap({ index: 0 }));
      await ctx.sleep(150);
      /* 循环档要随整份方案下发才到得了设备（空方案时 `applyAdvanced` 一帧不发）。 */
      await addZoneOn(ctx);
      for (const mode of [1, 2] as const) {
        page.onLoopTap(tap({ value: String(mode) }));
        await idle(ctx, "strip", "applying");
        await ctx.sleep(1000);
      }
    },
    async observe(o) {
      const state = await o.refreshState();
      const choices = o.pages.strip.data.loopChoices as any[];
      return {
        ui: uiReading(
          "strip.loopChoices",
          choices.map((item) => `${item.label}${item.selected ? "*" : ""}`).join("|"),
        ),
        device: deviceReading(
          "refreshState",
          "flags→loop",
          `${loopOfFlags(state.flags)}（flags=0x${state.flags.toString(16)}）`,
        ),
      };
    },
    compare(sample) {
      const ui = String(sample.ui.value);
      const device = String(sample.device.value);
      const selected = (/([^|*]+)\*/.exec(ui) ?? [])[1] ?? "";
      const want =
        selected === "最后一步循环" ? "2" : selected === "全部循环" ? "1" : selected === "不循环" ? "0" : null;
      if (want === null) {
        return { agrees: false, blame: "ui", why: `循环三档里没有选中项（${ui}）` };
      }
      return device.startsWith(want)
        ? AGREE
        : { agrees: false, blame: "ui", why: `界面选中「${selected}」，设备 flags 是 ${device}` };
    },
  },
  {
    id: "baseline.post-reconnect-recovery",
    kind: "step",
    does: "回连之后设备仍读得通，首页也说「已连接」",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      await ctx.waitLink("ready");
      await ctx.sleep(300);
    },
    async observe(o) {
      const state = await o.refreshState();
      const alive = await o.queryStateOk();
      return {
        ui: uiReading("home.statusText", o.pages.home.data.statusText),
        device: deviceReading(
          "refreshState",
          "power/brightness + QueryState",
          `power=${state.power} brightness=${state.brightness} queryState=${alive ? "通" : "不通"}`,
        ),
      };
    },
    compare(sample) {
      const ui = String(sample.ui.value);
      const device = String(sample.device.value);
      if (!device.includes("queryState=通")) {
        return { agrees: false, blame: "device", why: `回连之后设备读不通（${device}）` };
      }
      return ui.startsWith("已连接")
        ? AGREE
        : { agrees: false, blame: "ui", why: `设备读得通，首页却写「${ui}」` };
    },
  },

  /* ---------------- 收尾 ---------------- */
  {
    id: "walkthrough.settle",
    kind: "settle",
    does: "收尾：逐带段数回到 0，电源 / 亮度 / 逐带掩码回到走查开始时",
    expectation: { kind: "must-hold" },
    async act(ctx) {
      await ctx.restoreDevice();
      await ctx.sleep(500);
    },
    async observe(o) {
      const state = await o.refreshState();
      const point = o.snapshot();
      const counts: number[] = [];
      for (let stripId = 0; stripId < state.stripCount; stripId += 1) {
        counts.push((await stripZones(o, stripId)).length);
      }
      return {
        ui: snapshotReading(
          "snapshot(power/brightness/mask)",
          `${point.power}/${point.brightness}/${point.maxBrightness} mask=0x${point.stripPowerMask.toString(16)}`,
        ),
        device: deviceReading(
          "refreshState",
          "逐带段数 + power/brightness/mask",
          `segs=[${counts.join(",")}] power=${state.power} brightness=${state.brightness}/${state.maxBrightness} mask=0x${state.stripPowerMask.toString(16)}`,
        ),
      };
    },
    compare(sample) {
      const device = String(sample.device.value);
      const ui = String(sample.ui.value);
      const segMatch = /segs=\[([^\]]*)\]/.exec(device);
      if (segMatch === null) {
        return { agrees: false, blame: "device", why: `读不到逐带段数（${device}）` };
      }
      const counts = segMatch[1].split(",").filter((part) => part !== "").map(Number);
      if (counts.some((count) => count !== 0)) {
        return {
          agrees: false,
          blame: "device",
          why: `逐带段数没有回到 0：${device}——残留的段会让下一次写入因区间重叠被拒`,
        };
      }
      const wantPower = Number(ui.split("/")[0]);
      const wantBrightness = Number(ui.split("/")[1]);
      const havePower = Number(/power=(\d+)/.exec(device)?.[1]);
      const haveBrightness = Number(/brightness=(\d+)/.exec(device)?.[1]);
      if (havePower !== wantPower || haveBrightness !== wantBrightness) {
        return {
          agrees: false,
          blame: "device",
          why: `电源/亮度没回到快照：想要 power=${wantPower} brightness=${wantBrightness}，实际 ${device}`,
        };
      }
      return AGREE;
    },
  },
];
