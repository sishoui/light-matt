/**
 * 进阶灯效逐步录制（第九轮，#120 之后的版本）。
 *
 * 与上一版（`advanced-video-2026-11-05`）的关键差别：**每一步只录一次**。
 * 上一版每步录两段（「只点」和「点后应用」），因为那时只有循环三档会写设备。
 * 现在 #125 之后每个控件点完就下发，所以「只点」就是完整行为，不存在
 * 「点了没反应」的那一段。
 *
 * 标记的 `t` 与相机进程的 `frame_times` 用同一个时钟（Unix 时间），
 * 事后按时间切窗口。
 *
 * 环境变量：ADV_OUT 录制作业目录（默认 .test-run-tmp/adv-scope/run）
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startGateway, createWxStub } from "../../tests/e2e/wx-bridge.mjs";
import { installGlobals, instantiate, waitFor } from "../../tests/helpers/page-runtime";

const OUT = resolve(process.env.ADV_OUT || "../.test-run-tmp/adv-scope/run");
const MARKS = resolve(OUT, "marks.jsonl");

let gateway: any = null;
let wxStub: any = null;
let session: any = null;
let page: any = null;
const results: any[] = [];

const tap = (dataset: Record<string, any>) => ({ currentTarget: { dataset } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

function mark(step: string, note: string, extra: any = {}) {
  appendFileSync(MARKS, `${JSON.stringify({ t: now(), step, note, ...extra })}\n`, "utf-8");
  console.log(`MARK ${step} — ${note}`);
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
    animMask: s.stripAnimMask,
    segCounts: s.stripSegCounts?.slice(0, 8),
    /* 方案级信息：loop 与各步时长在设备侧只有摘要，QueryStrip 看不到，
     * 但它们确实是「这一下有没有生效」的一部分。 */
    loopFlags: s.flags & 0x05,
    layerTypes: reps.map((r: any) => r.layer0.type),
    overlayTypes: reps.map((r: any) => r.layer1?.type ?? 0xff),
    ranges: reps.map((r: any) => `${r.start}-${r.end}`),
    layers: reps.map((r: any) => ({ l0: { ...r.layer0 }, l1: { ...r.layer1 }, blend: r.blend })),
  };
}

function visualKey(s: any): string {
  return JSON.stringify([
    s.layerTypes,
    s.overlayTypes,
    s.ranges,
    (s.layers || []).map((l: any) => [l.l0, l.l1, l.blend]),
    s.loopFlags,
  ]);
}

/**
 * 一个步骤：点一下，等自动下发收尾，核对设备是否真的变了。
 *
 * `expectChange` 为 true 的步骤必须让设备读回变化——这正是上一版里那 17 项
 * 「点完设备无写入」的反面。
 */
async function step(
  id: string,
  title: string,
  action: () => void | Promise<void>,
  opts: { expectChange?: boolean; holdMs?: number } = {},
) {
  const hold = opts.holdMs ?? 4000;
  const before = await dev();

  await action();
  /* #125：点完自动下发。等它收尾（含防抖与在途补发）。 */
  await waitFor(() => page.data.applying !== true, { timeoutMs: 30_000, intervalMs: 150 })
    .catch(() => undefined);
  await sleep(600);

  const after = await dev();
  const changed = visualKey(before) !== visualKey(after);
  mark(id, title, { before, after, changed });
  await sleep(hold);

  results.push({
    id,
    title,
    changed,
    expectChange: opts.expectChange === true,
    before,
    after,
    applyError: page.data.applyError,
  });
}

describe("进阶灯效逐步录制（第九轮）", () => {
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
        await session.setPower(false).catch(() => undefined);
        await session.disconnect();
      }
    } finally {
      gateway?.stop();
    }
  });

  it("录制全部步骤", async () => {
    writeFileSync(resolve(OUT, "go"), String(now()), "utf-8");
    await sleep(5000);

    mark("00-baseline", "起点：无分区、无方案");
    await sleep(2000);

    await step("01-mode-advanced", "点「进阶」", () => page.onModeTap(tap({ mode: "advanced" })), {
      holdMs: 2000,
    });

    await step("02-step-add", "点「加步骤」", () => page.onStepAdd(), { holdMs: 2000 });

    /* 划整条灯带当分区：确认的那一刻就下发（#125 的离散动作）。 */
    await step(
      "03-zone-confirm",
      "画分区 0-29 → 确定（确认即下发）",
      async () => {
        page.onZoneAdd();
        await sleep(250);
        page.onPickerCellTap(tap({ index: "0" }));
        await sleep(150);
        page.onPickerCellTap(tap({ index: String(page.currentLedCount() - 1) }));
        await sleep(150);
        page.onPickerConfirm();
      },
      { expectChange: true },
    );

    await step(
      "04-zone-select",
      "点分区气泡选中它",
      () => {
        const zones = page.currentZones();
        page.onBubbleZoneTap(tap({ segId: String(zones[0].segId) }));
      },
      { holdMs: 2000 },
    );

    /* 七个灯效逐个点：每一个都必须让设备读回的层类型变。 */
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
      await step(`${String(i).padStart(2, "0")}-effect-${type}`, `点灯效「${name}」（点完即下发）`, () =>
        page.onPanelTypeTap(tap({ type })),
        { expectChange: true, holdMs: 5000 },
      );
      i += 1;
    }

    /* 滑块：拖动中不下发，松手才下发。录这一段是为了看「拖动时灯不动」。 */
    await step(
      "12-param-level",
      "亮度滑块松手 → 40",
      () => {
        page.onPanelTypeTap(tap({ type: "static" }));
        for (const v of [90, 70, 50, 40]) {
          page.onPanelSliderChanging({ currentTarget: { dataset: { key: "level" } }, detail: { value: v } } as any);
        }
        page.onPanelSliderChange({ currentTarget: { dataset: { key: "level" } }, detail: { value: 40 } } as any);
      },
      { expectChange: true },
    );

    await step(
      "13-param-hue",
      "色相滑块松手 → 210°",
      () =>
        page.onPanelSliderChange({
          currentTarget: { dataset: { key: "hue" } },
          detail: { value: 210 },
        } as any),
      { expectChange: true },
    );

    await step("14-overlay-comet", "特效层选「流星」", () => page.onOverlayTypeTap(tap({ value: "comet" })), {
      expectChange: true,
    });

    await step("15-overlay-blend", "混合方式改「相加」", () => page.onOverlayBlendTap(tap({ value: 2 })), {
      expectChange: true,
    });

    /* 16：此刻设备已经是「不循环」（上一步的 flags 就是 0），再点同一档是
     * 幂等的，读回不会变——所以这里不要求 change，只录「点了没坏东西」。 */
    await step("16-loop-none", "循环「不循环」（已是这一档，幂等）", () => page.onLoopTap(tap({ value: "0" })), {
      holdMs: 2000,
    });
    await step("17-loop-all", "循环「全部循环」", () => page.onLoopTap(tap({ value: "1" })), {
      expectChange: true,
      holdMs: 2000,
    });
    await step("18-loop-last", "循环「最后一步循环」", () => page.onLoopTap(tap({ value: "2" })), {
      expectChange: true,
      holdMs: 2000,
    });

    /* 19：时长写进方案 blob，协议**读不回来**（QueryScript 只有步数摘要），
     * 所以这一步只能确认「点完不报错、画面不被破坏」，不能断言读回值。
     * 这一点由 `docs/protocol-v4.md` §9.6 的已知限制解释。 */
    await step(
      "19-duration",
      "步骤时长松手 → 1.5 秒（时长读不回来，只验不报错）",
      () => page.onDurationChange({ detail: { value: 1.5 } } as any),
      { holdMs: 2000 },
    );

    await step("20-effect-off", "点灯效「空」", () => page.onPanelTypeTap(tap({ type: "off" })), {
      expectChange: true,
    });

    await session.setPlayback(0, 0).catch(() => undefined);
    mark("21-end", "收尾：停播");
    await sleep(1500);
  }, 900_000);
});
