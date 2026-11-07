/**
 * 场景条（#159）：三个场景的名字、当前选中、改名校验、空态判定。
 *
 * 这些是页面上「点一下切场景」背后所有需要判断的东西，全部是纯函数，所以在
 * 这里直接构造输入断言输出，不必开模拟器。
 */

import { describe, expect, it } from "vitest";
import { MAX_SCENES, NAME_BYTES } from "../utils/protocol/constants";
import {
  activateSceneIndex,
  defaultSceneLabel,
  nameBytesOf,
  sceneBarView,
  sceneLabelOf,
  sceneNameIssue,
} from "../utils/control/scene-bar";
import type { SceneReport } from "../utils/protocol/types";

/** 造一个场景读回（只填这条用例关心的字段）。 */
function scene(
  sceneId: number,
  name: string,
  stepCounts: number[] = [1],
): SceneReport {
  return {
    sceneId,
    name,
    parts: stepCounts.map((stepCount, partId) => ({
      sceneId,
      stripId: 0,
      partId,
      stepCount,
      loop: 0,
      on: true,
    })),
    steps: [],
  };
}

describe("默认名与展示名", () => {
  it("空名回落成「场景 N」（N 从 1 起）", () => {
    expect(defaultSceneLabel(0)).toBe("场景 1");
    expect(defaultSceneLabel(2)).toBe("场景 3");
    expect(sceneLabelOf(0, "")).toBe("场景 1");
    expect(sceneLabelOf(1, null)).toBe("场景 2");
    expect(sceneLabelOf(2, "   ")).toBe("场景 3");
  });

  it("有名字就用名字（去首尾空白）", () => {
    expect(sceneLabelOf(0, "待机")).toBe("待机");
    expect(sceneLabelOf(1, "  战斗  ")).toBe("战斗");
  });
});

describe("改名校验", () => {
  it("空名字被拒（设备允许，但界面不该让按钮变成空白）", () => {
    expect(sceneNameIssue("")).toContain("不能为空");
    expect(sceneNameIssue("   ")).toContain("不能为空");
  });

  it("24 字节以内可以，中文按 3 字节算", () => {
    expect(nameBytesOf("待机")).toBe(6);
    expect(sceneNameIssue("待机")).toBeNull();
    /* 8 个汉字正好 24 字节。 */
    expect(nameBytesOf("一二三四五六七八")).toBe(24);
    expect(sceneNameIssue("一二三四五六七八")).toBeNull();
  });

  it("超过 24 字节被拒并报出实际字节数", () => {
    const issue = sceneNameIssue("一二三四五六七八九"); /* 27 字节 */
    expect(issue).toContain(`${NAME_BYTES} 字节`);
    expect(issue).toContain("27");
  });
});

describe("场景条视图", () => {
  it("三个场景都画出来，当前那个被标记", () => {
    const view = sceneBarView([scene(0, "待机"), scene(1, "战斗"), scene(2, "演出")], 1);
    expect(view.tabs.length).toBe(MAX_SCENES);
    expect(view.tabs.map((tab) => tab.label)).toEqual(["待机", "战斗", "演出"]);
    expect(view.tabs.map((tab) => tab.active)).toEqual([false, true, false]);
    expect(view.activeIndex).toBe(1);
  });

  it("读不到的场景仍然画出来（按钮数不随连接状态跳动）", () => {
    const view = sceneBarView([null, scene(1, "战斗"), undefined], 0);
    expect(view.tabs.length).toBe(MAX_SCENES);
    expect(view.tabs.map((tab) => tab.label)).toEqual(["场景 1", "战斗", "场景 3"]);
    /* 「还不知道」不等于「空的」。 */
    expect(view.tabs[0].hasContent).toBe(false);
    /* 但场景 1 读到了且有步骤，所以整体不是空的。 */
    expect(view.tabs[1].hasContent).toBe(true);
    expect(view.allEmpty).toBe(false);
  });

  it("空名记得它不是用户起的（长按菜单文案据此变）", () => {
    const view = sceneBarView([scene(0, ""), scene(1, "战斗"), scene(2, "")], 0);
    expect(view.tabs.map((tab) => tab.named)).toEqual([false, true, false]);
  });

  it("hasContent 看的是「有部位带了步骤」", () => {
    const view = sceneBarView(
      [scene(0, "A", [0, 0]), scene(1, "B", [3]), scene(2, "C", [0])],
      0,
    );
    expect(view.tabs.map((tab) => tab.hasContent)).toEqual([false, true, false]);
    expect(view.allEmpty).toBe(false);
  });
});

describe("切场景", () => {
  it("切到合法下标就换", () => {
    expect(activateSceneIndex(0, 2)).toBe(2);
    expect(activateSceneIndex(2, 0)).toBe(0);
  });

  it("已经在那个场景 → 返回原值（引用语义：不用刷新）", () => {
    expect(activateSceneIndex(1, 1)).toBe(1);
  });

  it("越界 / 非整数不动", () => {
    expect(activateSceneIndex(0, MAX_SCENES)).toBe(0);
    expect(activateSceneIndex(0, -1)).toBe(0);
    expect(activateSceneIndex(0, 1.5)).toBe(0);
    expect(activateSceneIndex(0, Number.NaN)).toBe(0);
  });
});
