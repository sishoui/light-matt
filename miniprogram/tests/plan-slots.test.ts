/**
 * 方案槽位的纯算术（#83）。
 *
 * 这一层锁的是「按需增长的方案」的全部规则，页面只转发事件：
 *  1. 空表起步**只有一套**（①），不是四个永远占着的坑；
 *  2. 新建取**最小未占用**的编号，四套都在用时返回 null（按钮据此禁用）；
 *  3. 删除**不重排**：删掉②就剩①③④，显示的是它们各自的编号；
 *  4. 删除后再次新建会**复用**被腾出来的编号；
 *  5. tab 文案只有「空白」与「n 步」，界面上不出现协议词。
 *
 * 纯函数：不碰存储、不碰 BLE，可直接单测。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  addPlan,
  buildPlanTabs,
  createEmptyPlanDraft,
  deletePlan,
  initialPlanIds,
  MAX_PLANS,
  planDeviceSummary,
  planIdsFromSources,
  planIsPlaying,
  planNumberLabel,
  planTabSummary,
  plansFull,
  selectionAfterDelete,
  smallestFreePlanId,
  visiblePlanIds,
} from "../utils/control/plan-slots";
import { planIsEmpty } from "../utils/control/plan-editor";
import { BLEND, NO_EFFECT, SEGMENT_TYPE } from "../utils/protocol/constants";

describe("方案编号：空表与最小空位", () => {
  it("空表起步只有一套（①）", () => {
    expect(initialPlanIds()).toEqual([0]);
    expect(initialPlanIds()).toHaveLength(1);
  });

  it("新建取当前未被使用的最小值", () => {
    expect(smallestFreePlanId([])).toBe(0);
    expect(smallestFreePlanId([0])).toBe(1);
    expect(smallestFreePlanId([0, 2])).toBe(1);
    expect(smallestFreePlanId([1, 2, 3])).toBe(0);
    expect(smallestFreePlanId([0, 1, 2])).toBe(3);
  });

  it("四套都在用时没有空位", () => {
    expect(MAX_PLANS).toBe(4);
    expect(smallestFreePlanId([0, 1, 2, 3])).toBeNull();
    expect(plansFull([0, 1, 2, 3])).toBe(true);
    expect(plansFull([0, 1, 2])).toBe(false);
  });

  it("非法 / 重复 / 越界的编号不影响分配", () => {
    expect(smallestFreePlanId([0, 0, 1])).toBe(2);
    expect(smallestFreePlanId([9, -1, Number.NaN] as number[])).toBe(0);
  });

  it("addPlan 返回新表与被选中的编号；满时返回 null", () => {
    expect(addPlan([0])).toEqual({ ids: [0, 1], id: 1 });
    expect(addPlan([0, 2])).toEqual({ ids: [0, 1, 2], id: 1 });
    expect(addPlan([0, 1, 2, 3])).toBeNull();
  });

  it("删除后再次新建能复用被腾出来的编号", () => {
    const left = deletePlan([0, 1, 2], 1);
    expect(left).toEqual([0, 2]);
    const added = addPlan(left);
    expect(added).not.toBeNull();
    expect(added!.id).toBe(1);
    expect(added!.ids).toEqual([0, 1, 2]);
  });
});

describe("方案删除：不重排编号", () => {
  it("删掉②就剩①③④，显示的是它们各自的编号", () => {
    expect(deletePlan([0, 1, 2, 3], 1)).toEqual([0, 2, 3]);
  });

  it("删掉最后一套时表可以为空（页面据此决定是否补一套空白）", () => {
    expect(deletePlan([0], 0)).toEqual([]);
    expect(deletePlan([2], 2)).toEqual([]);
  });

  it("删不存在的编号是无操作", () => {
    expect(deletePlan([0, 2], 1)).toEqual([0, 2]);
  });

  it("表始终升序且去重", () => {
    expect(deletePlan([3, 0, 2, 0], 0)).toEqual([2, 3]);
  });
});

describe("方案删除后的选中项", () => {
  it("删的不是当前方案时选中不变", () => {
    expect(selectionAfterDelete([0, 1, 2, 3], 1, 3)).toBe(3);
  });

  it("删掉当前方案时优先选下一个", () => {
    expect(selectionAfterDelete([0, 1, 2, 3], 1, 1)).toBe(2);
    expect(selectionAfterDelete([0, 1, 3], 1, 1)).toBe(3);
  });

  it("删掉最后一个时回退到前一个", () => {
    expect(selectionAfterDelete([0, 1, 3], 3, 3)).toBe(1);
  });

  it("删掉唯一一套时没有可选项", () => {
    expect(selectionAfterDelete([1], 1, 1)).toBeNull();
  });
});

describe("方案 tab 文案", () => {
  it("新建的「一步但无光区」方案标「空白」（不是「1 步」）", () => {
    expect(planTabSummary(createEmptyPlanDraft(0))).toBe("空白");
  });

  it("有光区时说步数", () => {
    const draft = createEmptyPlanDraft(0);
    draft.stages[0].segments.push({
      stripId: 0,
      segId: 0,
      start: 0,
      end: 9,
      blend: BLEND.OVER,
      layer0: {
        type: SEGMENT_TYPE.STATIC,
        hue: 1000,
        sat: 255,
        periodMs: 0,
        p5: 0,
        flags: 0,
        level: 100,
      },
      layer1: {
        type: NO_EFFECT,
        hue: 0,
        sat: 0,
        periodMs: 0,
        p5: 0,
        flags: 0,
        level: 0,
      },
    });
    draft.stages.push({ durationInput: "1000", segments: [] });
    draft.stages.push({ durationInput: "1000", segments: [] });
    expect(planTabSummary(draft)).toBe("3 步");
  });

  it("只有设备摘要时 0 步就是「空白」", () => {
    expect(planDeviceSummary(0)).toBe("空白");
    expect(planDeviceSummary(1)).toBe("1 步");
    expect(planDeviceSummary(4)).toBe("4 步");
    expect(planDeviceSummary(-1)).toBe("空白");
    expect(planDeviceSummary(Number.NaN)).toBe("空白");
  });

  it("编号是圈码，不是内部数字", () => {
    expect(planNumberLabel(0)).toBe("①");
    expect(planNumberLabel(1)).toBe("②");
    expect(planNumberLabel(2)).toBe("③");
    expect(planNumberLabel(3)).toBe("④");
    /* 越界不崩（页面不会出现，但纯函数要有边界）。 */
    expect(planNumberLabel(4)).toBe("⑤");
    expect(planNumberLabel(-3)).toBe("①");
  });

  it("buildPlanTabs 组装 label / 摘要 / 选中 / 播放态", () => {
    const tabs = buildPlanTabs(
      [0, 2, 3],
      2,
      { 0: "空白", 2: "3 步", 3: "1 步" },
      3,
    );
    expect(tabs).toEqual([
      { id: 0, label: "①", summary: "空白", selected: false, playing: false },
      { id: 2, label: "③", summary: "3 步", selected: true, playing: false },
      { id: 3, label: "④", summary: "1 步", selected: false, playing: true },
    ]);
  });

  it("缺摘要的 tab 不编造内容", () => {
    const tabs = buildPlanTabs([0, 1], 0, {}, null);
    expect(tabs.map((tab) => tab.summary)).toEqual(["空白", "空白"]);
  });
});

describe("正在播放的方案", () => {
  it("播放中且编号一致才算在播", () => {
    expect(planIsPlaying({ scriptId: 2, playbackState: 1 }, 2)).toBe(true);
    expect(planIsPlaying({ scriptId: 2, playbackState: 2 }, 2)).toBe(true);
  });

  it("停止 / 别的方案 / 未连接都不算", () => {
    expect(planIsPlaying({ scriptId: 2, playbackState: 0 }, 2)).toBe(false);
    expect(planIsPlaying({ scriptId: 2, playbackState: 1 }, 3)).toBe(false);
    expect(planIsPlaying(null, 2)).toBe(false);
  });
});

describe("由草稿与设备摘要推出方案表", () => {
  it("两边都没有时只有一套空白（①）", () => {
    expect(planIdsFromSources(null, [])).toEqual([0]);
    expect(planIdsFromSources({}, [])).toEqual([0]);
  });

  it("本机草稿与设备摘要取并集（升序）", () => {
    expect(planIdsFromSources({ 0: 3, 2: 1 }, [0])).toEqual([0, 2]);
    expect(planIdsFromSources({ 3: 2 }, [1])).toEqual([1, 3]);
  });

  it("设备上 0 步的方案不算「有内容」，不会凭空多出一个 tab", () => {
    expect(planIdsFromSources({ 0: 0, 1: 2 }, [])).toEqual([1]);
  });

  it("删掉某套之后两边都没有它，于是它不会复活", () => {
    /* 删除前的状态：本机有 0/1/3，设备上 0 与 3 有内容。 */
    const before = planIdsFromSources({ 0: 2, 3: 1 }, [0, 1, 3]);
    expect(before).toEqual([0, 1, 3]);
    /* 删掉 1 号（只在本机）后剩 0/3。 */
    const after = planIdsFromSources({ 0: 2, 3: 1 }, deletePlan(before, 1));
    expect(after).toEqual([0, 3]);
  });
});

describe("实际显示的方案表（首次进入只有一套）", () => {
  it("本机没有任何草稿时，即使设备上留着旧方案也只显示一套", () => {
    expect(visiblePlanIds([0], { 0: 3, 2: 1 }, [])).toEqual([0]);
    expect(visiblePlanIds([0], null, [])).toEqual([0]);
  });

  it("本机一旦有草稿，就按并集显示（设备上的旧方案因此删得掉）", () => {
    expect(visiblePlanIds([0], { 0: 3, 2: 1 }, [0])).toEqual([0, 2]);
  });

  it("本机草稿是空表时不会把设备方案当成「本机有」", () => {
    expect(visiblePlanIds([0], { 1: 2 }, [])).toEqual([0]);
  });

  it("屏幕上已有的那套不会被一次刷新抹掉（新建后①还在）", () => {
    /* 新建②后本机只有②被标记为有草稿；① 仍在 current 里，必须保留。 */
    expect(visiblePlanIds([0, 1], null, [1])).toEqual([0, 1]);
  });

  it("删除时页面显式去掉那一套，之后的合并不会把它加回来", () => {
    const left = deletePlan([0, 1, 2], 1);
    expect(visiblePlanIds(left, { 0: 2, 1: 0, 2: 1 }, [0, 2])).toEqual([0, 2]);
  });
});

describe("新建方案的空草稿", () => {
  it("一套一步、没有任何光区（界面因此显示「空白」）", () => {
    const draft = createEmptyPlanDraft(2);
    expect(draft.scriptId).toBe(2);
    expect(draft.stages).toHaveLength(1);
    expect(draft.stages[0].segments).toEqual([]);
    expect(planIsEmpty(draft)).toBe(true);
  });
});

/**
 * 界面上不出现协议词与内部编号（#83 票面）。
 *
 * 这里静态扫 WXML：用户在灯组页只会看到「① / 空白 / n 步 / 新建 / 删除」，
 * 看不到 `script_id`、`槽位`、`阶段`。规则放在纯逻辑测试旁边，因为它锁的
 * 正是「方案这一块的措辞」。
 */
describe("方案界面不出现协议词", () => {
  const raw = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "pages", "strip", "strip.wxml"),
    "utf8",
  );
  /* 注释不是界面：先剥掉 `<!-- ... -->` 再查（注释里出现「下发」等词无妨）。 */
  const source = raw.replace(/<!--[\s\S]*?-->/g, "");

  it("没有 script_id / 槽位 / 阶段 / 剧本 / 下发 / 激活", () => {
    const forbidden = ["script_id", "scriptId", "槽位", "阶段", "剧本", "下发", "激活"];
    for (const word of forbidden) {
      expect(source.includes(word), `strip.wxml 出现了协议词「${word}」`).toBe(false);
    }
  });

  it("方案按钮用的是数字与摘要这两个字段（#95 起固定三个圆形按钮）", () => {
    expect(source).toContain("{{item.label}}");
    expect(source).toContain("{{planCircles[planSlot].summary}}");
    /* #95：没有新增 / 删除入口。 */
    expect(source).not.toContain("+ 新建");
  });
});

/**
 * 一轮完整的「新建 → 切换 → 删除 → 再新建」在视图模型上的样子。
 *
 * 这是渲染层的等价物：页面只把这里的结果塞进 `setData`，所以只要这里的
 * tab 与摘要正确，「新建 / 删除后 tab 与设备摘要同步变化」就成立。
 */
describe("方案 tab 的行为了（新建 / 删除 / 复用）", () => {
  /** 一套有光区的草稿（标题说「n 步」）。 */
  function filledDraft(scriptId: number, steps: number) {
    const draft = createEmptyPlanDraft(scriptId);
    draft.stages = Array.from({ length: steps }, () => ({
      durationInput: "1000",
      segments: [
        {
          stripId: 0,
          segId: 0,
          start: 0,
          end: 9,
          blend: BLEND.OVER,
          layer0: {
            type: SEGMENT_TYPE.STATIC,
            hue: 1000,
            sat: 255,
            periodMs: 0,
            p5: 0,
            flags: 0,
            level: 100,
          },
          layer1: {
            type: NO_EFFECT,
            hue: 0,
            sat: 0,
            periodMs: 0,
            p5: 0,
            flags: 0,
            level: 0,
          },
        },
      ],
    }));
    return draft;
  }

  /** 页面里 `renderPlans` 的等价物：只从草稿与设备摘要算 tab。 */
  function tabsOf(
    ids: readonly number[],
    drafts: Record<number, ReturnType<typeof createEmptyPlanDraft>>,
    deviceCounts: Record<number, number> | null,
    selected: number,
  ) {
    const summaries: Record<number, string> = {};
    for (const id of ids) {
      const draft = drafts[id];
      summaries[id] = draft === undefined
        ? planDeviceSummary(deviceCounts?.[id] ?? 0)
        : planTabSummary(draft);
    }
    return buildPlanTabs(ids, selected, summaries, null);
  }

  it("首次进入：一个 tab「① 空白」", () => {
    const ids = visiblePlanIds(initialPlanIds(), null, []);
    const tabs = tabsOf(ids, {}, null, 0);
    expect(tabs.map((tab) => `${tab.label} ${tab.summary}`)).toEqual(["① 空白"]);
    expect(tabs.map((tab) => tab.selected)).toEqual([true]);
  });

  it("点「+ 新建」后是两套、新的一套被选中且仍是空白", () => {
    const first = filledDraft(0, 2);
    const added = addPlan([0])!;
    const drafts = { 0: first, [added.id]: createEmptyPlanDraft(added.id) };
    const ids = visiblePlanIds([0, added.id], null, [added.id]);
    const tabs = tabsOf(ids, drafts, null, added.id);
    expect(tabs.map((tab) => `${tab.label} ${tab.summary}`)).toEqual(["① 2 步", "② 空白"]);
    expect(tabs.find((tab) => tab.selected)?.id).toBe(1);
  });

  it("删掉②之后剩①③（编号不重排），设备摘要同步变空白", () => {
    /* 三套；② 与 ③ 都下发过（设备摘要 2 / 1 步）。 */
    const ids = [0, 1, 2];
    const drafts = { 0: filledDraft(0, 3) };
    const before = tabsOf(ids, drafts, { 0: 3, 1: 2, 2: 1 }, 1);
    expect(before.map((tab) => `${tab.label} ${tab.summary}`)).toEqual([
      "① 3 步",
      "② 2 步",
      "③ 1 步",
    ]);

    const left = deletePlan(ids, 1);
    /* ② 已从设备清空（0 步），③ 仍是 1 步。 */
    const after = tabsOf(left, drafts, { 0: 3, 1: 0, 2: 1 }, 2);
    expect(after.map((tab) => `${tab.label} ${tab.summary}`)).toEqual(["① 3 步", "③ 1 步"]);
    /* 删掉当前选中的②后，选中移到③（原位置后面的那一个）。 */
    expect(selectionAfterDelete(ids, 1, 1)).toBe(2);
  });

  it("删除后再新建复用②，编号回到 ①②③", () => {
    const left = deletePlan([0, 1, 2], 1);
    const added = addPlan(left)!;
    expect(added.id).toBe(1);
    const ids = visiblePlanIds(left, null, added.ids);
    const tabs = tabsOf(ids, { 0: filledDraft(0, 2), [added.id]: createEmptyPlanDraft(1) }, null, 1);
    expect(tabs.map((tab) => `${tab.label} ${tab.summary}`)).toEqual(["① 2 步", "② 空白", "③ 空白"]);
  });

  it("四套都在用时不再增加 tab，且「+ 新建」禁用", () => {
    const ids = [0, 1, 2, 3];
    expect(plansFull(ids)).toBe(true);
    expect(addPlan(ids)).toBeNull();
    expect(tabsOf(ids, {}, null, 0)).toHaveLength(4);
  });
});
