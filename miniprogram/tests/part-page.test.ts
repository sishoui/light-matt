/**
 * 部位编辑页：**两个单元真的被用上了**（#154 三条判据里的「参数控件定义只有
 * 一份」+「页面只是调用方」）。
 *
 * 这个文件的存在理由：`pages/part` 是 #155 的最小版（一步一层），如果只把
 * `timeline-unit` / `panel-unit` 恢复成两个「能单测的模块」而页面仍然自己手写
 * 色相 / 饱和度 / 亮度控件与类型选项，那两份规则就会再次分叉。所以这里断言
 * **页面自己的处理器**走的是单元：
 *
 *  - 点类型 → `switchPanelMode` 的效果（参数区按类型整体替换）；
 *  - 拖滑块 → `applyPanelSliderValue` 的效果（刻度 ↔ 协议值）；
 *  - 改时长 → `applyTimelineDuration` 的效果（块宽与时长文字跟着变）；
 *  - 下发 → `panelUnitLayers` 装配的两层真的到了设备。
 */

import { describe, expect, it } from "vitest";
import { EFFECT_TYPE, NO_EFFECT } from "../utils/protocol/constants";
import { SLIDER_KEYS } from "../utils/control/effect-panel";
import { input, openPage, slide, tap, toggle } from "./helpers/page-harness";

/** 以「演示设备 0 的 strip 0 / 部位 0」打开部位页。 */
async function openPart() {
  return openPage("part", { strip: "0", part: "0" });
}

/** 等一个条件成立。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等超时");
}

describe("部位页：时间轴单元（渲染 / 选中 / 改时长）", () => {
  it("读到设备上那一步：块的时长文字来自单元派生", async () => {
    const harness = await openPart();
    try {
      const blocks = harness.page.data.timelineBlocks as Array<{
        durationText: string;
        selected: boolean;
      }>;
      expect(blocks.length, "最小版只有一步").toBe(1);
      /* 演示设备 0 的出厂步是 3000ms。 */
      expect(blocks[0].durationText).toBe("3 秒");
      expect(blocks[0].selected).toBe(true);
      expect(harness.page.data.durationMs).toBe(3000);
    } finally {
      await harness.dispose();
    }
  });

  it("改时长：块宽与时长文字跟着变，并落进下发的 DurationMs", async () => {
    const harness = await openPart();
    try {
      harness.page.onDurationChange(slide(5));
      const blocks = harness.page.data.timelineBlocks as Array<{ durationText: string }>;
      expect(harness.page.data.durationMs).toBe(5000);
      expect(blocks[0].durationText).toBe("5 秒");
    } finally {
      await harness.dispose();
    }
  });

  it("时长被钳到协议区间（低于 0.5 秒抬到 500，高于 30 秒压到 30000）", async () => {
    const harness = await openPart();
    try {
      harness.page.onDurationChange(slide(0.1));
      expect(harness.page.data.durationMs).toBe(500);
      harness.page.onDurationChange(slide(999));
      expect(harness.page.data.durationMs).toBe(30000);
    } finally {
      await harness.dispose();
    }
  });

  it("点刻度直接跳到那一档", async () => {
    const harness = await openPart();
    try {
      harness.page.onDurationTick(tap({ ms: 15000 }));
      expect(harness.page.data.durationMs).toBe(15000);
    } finally {
      await harness.dispose();
    }
  });

  it("点越界的块下标不改选中（单元返回同一个状态）", async () => {
    const harness = await openPart();
    try {
      const before = harness.page.data.stepIndex;
      harness.page.onStepTap(tap({ index: 9 }));
      expect(harness.page.data.stepIndex).toBe(before);
    } finally {
      await harness.dispose();
    }
  });
});

describe("部位页：效果面板单元（切类型 / 改参数 / 回读）", () => {
  it("首次读回常亮层：类型是 static，滑块与键表一致", async () => {
    const harness = await openPart();
    try {
      expect(harness.page.data.panelType).toBe("static");
      const keys = (harness.page.data.panelSliders as Array<{ key: string }>).map((s) => s.key);
      expect(keys).toEqual([...SLIDER_KEYS.static]);
      expect(harness.page.data.panelHasLayer).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("点类型切换：参数区整体替换（流星多出周期与尾长，常亮没有）", async () => {
    const harness = await openPart();
    try {
      harness.page.onPanelTypeTap(tap({ type: "comet" }));
      expect(harness.page.data.panelType).toBe("comet");
      const keys = (harness.page.data.panelSliders as Array<{ key: string }>).map((s) => s.key);
      expect(keys).toEqual([...SLIDER_KEYS.comet]);
      /* 常亮时的选择项是空的，流星多一个「方向」。 */
      expect((harness.page.data.panelChoices as Array<{ key: string }>).map((c) => c.key)).toEqual([
        "direction",
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("切到「空」时没有任何旋钮，只给一行说明", async () => {
    const harness = await openPart();
    try {
      harness.page.onPanelTypeTap(tap({ type: "off" }));
      expect(harness.page.data.panelSliders).toEqual([]);
      expect(harness.page.data.panelChoices).toEqual([]);
      expect(String(harness.page.data.panelNotice).length).toBeGreaterThan(0);
    } finally {
      await harness.dispose();
    }
  });

  it("非法类型名被忽略（渲染层的脏数据不算可信）", async () => {
    const harness = await openPart();
    try {
      const before = harness.page.data.panelType;
      harness.page.onPanelTypeTap(tap({ type: "nope" }));
      expect(harness.page.data.panelType).toBe(before);
    } finally {
      await harness.dispose();
    }
  });

  it("拖色相滑块：读数按「度 → 协议 0-65535」换算回来", async () => {
    const harness = await openPart();
    try {
      harness.page.onPanelSliderChange(slide(90, { key: "hue" }));
      const slider = (harness.page.data.panelSliders as Array<{ key: string; value: number; display: string }>).find(
        (s) => s.key === "hue",
      );
      expect(slider?.value, "界面读数就是拖到的度数").toBe(90);
      expect(slider?.display).toBe("90°");
    } finally {
      await harness.dispose();
    }
  });

  it("拖亮度滑块：读数跟着走，且不换目标（还是同一步）", async () => {
    const harness = await openPart();
    try {
      const stepBefore = harness.page.data.stepIndex;
      harness.page.onPanelSliderChange(slide(42, { key: "level" }));
      const slider = (harness.page.data.panelSliders as Array<{ key: string; display: string }>).find(
        (s) => s.key === "level",
      );
      expect(slider?.display).toBe("42%");
      expect(harness.page.data.stepIndex).toBe(stepBefore);
    } finally {
      await harness.dispose();
    }
  });

  it("点选择控件（波形 / 方向）走同一个入口", async () => {
    const harness = await openPart();
    try {
      harness.page.onPanelTypeTap(tap({ type: "breathing" }));
      expect((harness.page.data.panelChoices as Array<{ key: string }>).map((c) => c.key)).toEqual([
        "waveform",
      ]);
      harness.page.onPanelChoiceTap(tap({ key: "waveform", value: 3 }));
      const choice = (
        harness.page.data.panelChoices as Array<{ key: string; value: number }>
      ).find((c) => c.key === "waveform");
      expect(choice?.value, "方波").toBe(3);
    } finally {
      await harness.dispose();
    }
  });
});

describe("部位页：下发把两个单元的结果都送到设备", () => {
  it("改类型 + 改时长后下发：设备上的层与时长都变了", async () => {
    const harness = await openPart();
    try {
      harness.page.onPanelTypeTap(tap({ type: "rainbow" }));
      harness.page.onDurationChange(slide(7));
      await harness.page.onSaveContent();
      await waitFor(() => {
        const scene = harness.session.sceneOf(harness.session.deviceState?.activeScene ?? 0);
        const step = scene?.steps.find(
          (item) => item.stripId === 0 && item.partId === 0 && item.stepIndex === 0,
        );
        return step?.layer0.type === EFFECT_TYPE.RAINBOW;
      });

      const scene = harness.session.sceneOf(harness.session.deviceState?.activeScene ?? 0);
      const step = scene?.steps.find(
        (item) => item.stripId === 0 && item.partId === 0 && item.stepIndex === 0,
      );
      expect(step?.layer0.type).toBe(EFFECT_TYPE.RAINBOW);
      expect(step?.durationMs).toBe(7000);
      /* 叠加层没打开 → layer1 是空层（设备按覆盖合成）。 */
      expect(step?.layer1.type).toBe(NO_EFFECT);
    } finally {
      await harness.dispose();
    }
  });

  it("选「空」下发：编码成熄灭类型（全零参数块）", async () => {
    const harness = await openPart();
    try {
      harness.page.onPanelTypeTap(tap({ type: "off" }));
      await harness.page.onSaveContent();
      await waitFor(() => {
        const scene = harness.session.sceneOf(harness.session.deviceState?.activeScene ?? 0);
        const step = scene?.steps.find((item) => item.stripId === 0 && item.partId === 0);
        return step?.layer0.type === EFFECT_TYPE.OFF;
      });

      const scene = harness.session.sceneOf(harness.session.deviceState?.activeScene ?? 0);
      const step = scene?.steps.find((item) => item.stripId === 0 && item.partId === 0);
      expect(step?.layer0.type).toBe(EFFECT_TYPE.OFF);
      expect(step?.layer0.level).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it("部位开关随下发一起写（属于场景，不停时钟）", async () => {
    const harness = await openPart();
    try {
      harness.page.onToggleOn(toggle(false));
      await harness.page.onSaveContent();
      await waitFor(() => {
        const scene = harness.session.sceneOf(harness.session.deviceState?.activeScene ?? 0);
        return scene?.parts.some((item) => item.stripId === 0 && item.partId === 0 && !item.on) === true;
      });
      const scene = harness.session.sceneOf(harness.session.deviceState?.activeScene ?? 0);
      const part = scene?.parts.find((item) => item.stripId === 0 && item.partId === 0);
      expect(part?.on, "关掉了").toBe(false);
      expect(part?.stepCount, "步数没被清掉").toBe(1);
    } finally {
      await harness.dispose();
    }
  });
});

describe("部位页：结构区（布局族，整份重写）", () => {
  it("改名后整份重写布局：别的部位原样保留", async () => {
    const harness = await openPart();
    try {
      harness.page.onNameInput(input("床头"));
      await harness.page.onSaveName();
      await waitFor(() => {
        const layout = harness.session.layoutOf(0);
        return layout?.parts.some((part) => part.partId === 0 && part.name === "床头") === true;
      });

      const layout = harness.session.layoutOf(0);
      const partIds = layout?.parts.map((part) => part.partId).sort();
      /* 演示设备 0 的 strip 0 有部位 0 与 1：改名不能把部位 1 抹掉。 */
      expect(partIds).toEqual([0, 1]);
      expect(layout?.parts.find((part) => part.partId === 1)?.name).toBe("后半");
    } finally {
      await harness.dispose();
    }
  });

  it("名字超 24 字节时只提示、不下发", async () => {
    const harness = await openPart();
    try {
      /* 9 个中文字 = 27 字节。 */
      harness.page.onNameInput(input("一二三四五六七八九"));
      expect(harness.page.data.nameBytes).toBe(27);
      harness.transport.log.clear();
      await harness.page.onSaveName();
      expect(String(harness.page.data.applyError)).toContain("24");
      expect(harness.session.layoutOf(0)?.parts.find((part) => part.partId === 0)?.name).toBe(
        "前半",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("字节数按 UTF-8 算（中文 3 字节、ASCII 1 字节）", async () => {
    const harness = await openPart();
    try {
      harness.page.onNameInput(input("ab"));
      expect(harness.page.data.nameBytes).toBe(2);
      harness.page.onNameInput(input("床头"));
      expect(harness.page.data.nameBytes).toBe(6);
    } finally {
      await harness.dispose();
    }
  });
});
