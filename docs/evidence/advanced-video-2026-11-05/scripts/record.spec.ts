/**
 * 进阶灯效逐步录制：驱动真实页面处理器 → 真实 BLE → 真实灯带，
 * 并在每个「值得看」的时刻往 marks.jsonl 写一条带绝对时间戳的标记。
 *
 * 标记的 `t` 与相机进程的 `frame_times` 用同一个时钟（`Date.now()/1000`
 * 对齐 `time.time()`，两者都是 Unix 时间），事后按时间切视频窗口。
 *
 * 每个步骤录两段：
 *   A. `click` —— 只点，不下发。这是**用户今天在 App 里点完的真实画面**。
 *   B. `apply` —— 再调页面自己的 `applyAdvanced()`。这是**这套编排本身对不对**。
 *
 * 环境变量：
 *   ADV_OUT  录制作业目录（默认 .test-run-tmp/adv-video/run）
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startGateway, createWxStub } from "../../tests/e2e/wx-bridge.mjs";
import { installGlobals, instantiate, waitFor } from "../../tests/helpers/page-runtime";

const OUT = resolve(process.env.ADV_OUT || "../.test-run-tmp/adv-video/run");
const MARKS = resolve(OUT, "marks.jsonl");

let gateway: any = null;
let wxStub: any = null;
let session: any = null;
let page: any = null;
const results: any[] = [];

const tap = (dataset: Record<string, any>) => ({ currentTarget: { dataset } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

/** 写一条标记。`phase` 区分「点完」与「应用后」。 */
function mark(step: string, phase: "click" | "apply" | "note", note: string, extra: any = {}) {
  const rec = { t: now(), step, phase, note, ...extra };
  appendFileSync(MARKS, `${JSON.stringify(rec)}\n`, "utf-8");
  console.log(`MARK ${step} ${phase} — ${note}`);
}

/** 读设备权威状态（不经页面缓存）。 */
async function dev() {
  const s = await session.refreshState();
  const q = await session.queryStrip(0);
  const reps = q.kind === "ok" ? q.reports : [];
  return {
    flags: s.flags,
    playback: s.playbackState,
    stage: s.stageIndex,
    scriptId: s.scriptId,
    segs: s.stripSegCounts?.[0] ?? 0,
    layerTypes: reps.map((r: any) => r.layer0.type),
    overlayTypes: reps.map((r: any) => r.layer1?.type ?? 0xff),
    ranges: reps.map((r: any) => `${r.start}-${r.end}`),
    // 完整层参数：光看类型无法区分「亮度 40」和「亮度 100」
    layers: reps.map((r: any) => ({
      l0: { ...r.layer0 },
      l1: { ...r.layer1 },
      blend: r.blend,
    })),
  };
}

/** 只比「会影响出光」的字段：类型变了、参数变了、或者分区变了。 */
function visualKey(s: any): string {
  return JSON.stringify([
    s.layerTypes,
    s.overlayTypes,
    s.ranges,
    (s.layers || []).map((l: any) => [l.l0, l.l1, l.blend]),
    s.flags & 0x05,
  ]);
}


/**
 * 一个步骤：先录「只点了」，再录「应用了」。
 *
 * `action` 里放的是**页面自己的事件处理器**，不是重写的调用顺序。
 */
async function step(
  id: string,
  title: string,
  action: () => void | Promise<void>,
  opts: { apply?: boolean; holdMs?: number; writesOnClick?: boolean } = {},
) {
  const apply = opts.apply !== false;
  /* 动态效果（呼吸 / 流星 / 心跳）要留够时间让相机拍到至少一轮，
   * 否则「录了但看不出」会被误判成「没生效」。 */
  const hold = opts.holdMs ?? 5000;
  /* 循环三档是「改完立即下发」，点一下就会写设备；其余编辑只进草稿。 */
  const writesOnClick = opts.writesOnClick === true;
  const before = await dev();

  await action();
  await waitFor(() => page.data.applying !== true, { timeoutMs: 20000, intervalMs: 150 }).catch(() => undefined);

  // ---- A：只点了，不下发 ----
  if (writesOnClick) {
    await waitFor(async () => visualKey(await dev()) !== visualKey(before), {
      timeoutMs: 12000, intervalMs: 200, label: "循环档位落到设备",
    }).catch(() => undefined);
  }
  const afterClick = await dev();
  mark(id, "click", title, { before, afterClick });
  await sleep(hold);

  let afterApply: any = null;
  if (apply) {
    mark(id, "note", `${title} → 开始应用`);
    await page.applyAdvanced();
    await waitFor(() => page.data.applying !== true, { timeoutMs: 30000, intervalMs: 150 }).catch(() => undefined);
    afterApply = await dev();
    mark(id, "apply", `${title}（应用后）`, { afterApply });
    await sleep(hold);
  }

  results.push({
    id,
    title,
    before,
    afterClick,
    afterApply,
    writesOnClick,
    clickChanged: visualKey(before) !== visualKey(afterClick),
    visualChanged: afterApply ? visualKey(before) !== visualKey(afterApply) : null,
    pageMode: page.data.mode,
    panelMode: page.panelMode,
  });
}

describe("进阶灯效逐步录制", () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(MARKS, "", "utf-8");

    wxStub = createWxStub({ call: (...a: any[]) => gateway.call(...a), ready: Promise.resolve() } as any);
    gateway = startGateway({ onEvent: (msg: any) => wxStub.pump(msg) });
    await gateway.ready;
    wxStub.setGateway(gateway);
    const wx = wxStub.wx;
    globalThis.wx = wx;

    const { BleTransport } = await import("../../utils/ble/transport");
    const { ControlSession } = await import("../../utils/control/session");
    const { FrameLog } = await import("../../utils/ble/log");
    const { setSessionForTest } = await import("../../utils/control/session-singleton");

    const device = await new Promise((resolve2) => {
      const timer = setTimeout(() => resolve2(null), 25_000);
      const handler = (res: any) => {
        const hit = (res.devices || []).find((d: any) => (d.name || "").startsWith("Lumen-"));
        if (hit) { clearTimeout(timer); wx.offBluetoothDeviceFound(handler); resolve2(hit); }
      };
      wx.onBluetoothDeviceFound(handler);
      wx.startBluetoothDevicesDiscovery({ allowDuplicatesKey: true });
    });
    if (!device) throw new Error("没扫到 Lumen 设备");

    session = new ControlSession({
      platform: "android",
      devMode: false,
      transportOverride: new BleTransport({ log: new FrameLog({ mirrorToConsole: false }), platform: "android" }),
    });
    await session.connect((device as any).deviceId, (device as any).name);
    setSessionForTest(session);

    // 起点归一：8 带全开、亮度适中、清掉残留方案
    await session.setPower(true).catch(() => undefined);
    await session.commitBrightness(150);
    for (let s = 0; s < 8; s += 1) {
      const q = await session.queryStrip(s);
      if (q.kind === "ok") {
        for (const r of q.reports) await session.clearSegment(s, r.segId).catch(() => undefined);
      }
    }
    await session.setPlayback(0, 0).catch(() => undefined);

    const captured = installGlobals({ wx });
    await import("../../pages/strip/strip");
    page = instantiate(captured[captured.length - 1]);
    page.onLoad({ strip: "0" });
    page.onShow();
    await waitFor(() => page.data.ready === true, { timeoutMs: 25_000, label: "页面 ready" });
  }, 180_000);

  afterAll(async () => {
    writeFileSync(resolve(OUT, "results.json"), JSON.stringify(results, null, 2), "utf-8");
    try {
      if (session) {
        await session.setPlayback(0, 0).catch(() => undefined);
        for (let s = 0; s < 8; s += 1) {
          const q = await session.queryStrip(s);
          if (q.kind === "ok") {
            for (const r of q.reports) await session.clearSegment(s, r.segId).catch(() => undefined);
          }
        }
        await session.disconnect();
      }
    } finally {
      gateway?.stop();
    }
  });

  it("录制全部步骤", async () => {
    /* 让相机真正开录后再打标记：它要先测 1.5s 帧率才开 writer，
     * 早打的标记会落在片头之前。 */
    writeFileSync(resolve(OUT, "go"), String(now()), "utf-8");
    await sleep(5000);

    // 0 起点
    mark("00-baseline", "note", "起点：无分区、无方案、关灯");
    await sleep(2000);

    // 1 切到进阶
    await step("01-mode-advanced", "点「进阶」", () => page.onModeTap(tap({ mode: "advanced" })), { apply: false });

    // 2 加步骤
    await step("02-step-add", "点「加步骤」", () => page.onStepAdd(), { apply: false });

    // 3 划一个分区（弹窗两步点 + 确定）
    await step("03-zone-add", "点「加分区」→ 划选整条灯带 → 确定", async () => {
      page.onZoneAdd();
      await sleep(250);
      page.onPickerCellTap(tap({ index: "0" }));
      await sleep(150);
      page.onPickerCellTap(tap({ index: String(page.currentLedCount() - 1) }));
      await sleep(150);
      page.onPickerConfirm();
      await sleep(300);
    });

    // 选中刚划的分区（两层编辑器才出现）
    const zones = page.currentZones();
    await step("04-zone-select", "选中分区", () => page.onBubbleZoneTap(tap({ segId: String(zones[0].segId) })), { apply: false });

    // 5..11 七个灯效逐个。「常亮」是面板默认值，点到它不会有变化，
    // 所以排在中间（先离开默认值再回来）；「空」放到最后：它把这一片变黑。
    const effects: Array<[string, string]> = [
      ["breathing", "呼吸"],
      ["rainbow", "彩虹"],
      ["comet", "流星"],
      ["strobe", "爆闪"],
      ["heartbeat", "心跳"],
      ["flicker", "随机闪烁"],
      ["static", "常亮"],
    ];

    let i = 5;
    for (const [type, name] of effects) {
      const id = `${String(i).padStart(2, "0")}-effect-${type}`;
      await step(id, `点灯效「${name}」`, () => page.onPanelTypeTap(tap({ type })));
      i += 1;
    }

    // 12 参数：亮度滑块（在「常亮」上最能看出来）
    await step("12-param-level", "把分区亮度拖到 40", () => {
      page.onPanelTypeTap(tap({ type: "static" }));
      page.onPanelSliderChange({ currentTarget: { dataset: { key: "level" } }, detail: { value: 40 } } as any);
    });

    // 13 参数：色相
    await step("13-param-hue", "把色相拖到 210°", () => {
      page.onPanelSliderChange({ currentTarget: { dataset: { key: "hue" } }, detail: { value: 210 } } as any);
    });

    // 14 特效层
    await step("14-overlay-comet", "特效层选「流星」", () => page.onOverlayTypeTap(tap({ value: "comet" })));

    // 15 混合方式：从默认的「覆盖」改成「相加」（0x02）才看得出来
    await step("15-overlay-blend", "混合方式改成「相加」", () => page.onOverlayBlendTap(tap({ value: 2 })));

    // 16 循环三档：点一下就是一次下发（writesOnClick），不需要再「应用」
    await step("16-loop-none", "循环「不循环」", () => page.onLoopTap(tap({ value: "0" })), { apply: false, writesOnClick: true });
    await step("17-loop-all", "循环「全部循环」", () => page.onLoopTap(tap({ value: "1" })), { apply: false, writesOnClick: true });
    await step("18-loop-last", "循环「最后一步循环」", () => page.onLoopTap(tap({ value: "2" })), { apply: false, writesOnClick: true });

    // 19 时长
    await step("19-duration", "步骤时长改到 1.5 秒", () => {
      page.onDurationChange({ detail: { value: 1.5 } } as any);
    });

    // 20 最后才点「空」：它把这一片熄掉
    await step("20-effect-off", "点灯效「空」", () => page.onPanelTypeTap(tap({ type: "off" })));

    // 收尾
    await session.setPlayback(0, 0).catch(() => undefined);
    mark("20-end", "note", "收尾：停播");
    await sleep(1500);
  }, 900_000);
});
