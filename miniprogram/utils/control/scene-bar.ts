/**
 * 场景条（#159）：设备页顶部那一排三个场景。
 *
 * ## 为什么单独一层
 *
 * 「点一下切场景」看着只是一次 `ActivateScene`，但票面有四条验收全在这一排上：
 *
 *  - 每次都从第 1 步重跳（C4：硬切 + 全部重跳）——所以切换后**必须作废**
 *    旧的步号显示，否则界面还在报上一个场景演到第几步；
 *  - 开关状态属于场景（C4 / T9）——切回来时要还原成那个场景自己的开关；
 *  - 场景可命名（C2），名字存在设备上（C3 设备权威）；
 *  - 断线时用缓存渲染、重连后以设备为准（§9.1 第 2 步）。
 *
 * 这四条都是「给状态、算状态」的纯逻辑，放页面里就只能靠模拟器点。所以
 * 收进这里：名字与当前场景 → 三个可以直接渲染的按钮；切换 → 新的选中态；
 * 读回 → 名字覆盖规则。
 *
 * 纯函数、不碰 wx / BLE / 页面。
 */

import { MAX_SCENES, NAME_BYTES } from "../protocol/constants";
import type { SceneReport } from "../protocol/types";

/** 场景条上的一个按钮。 */
export interface SceneTabView {
  sceneId: number;
  /** 按钮上的文字：设备上的名字，空名回落成「场景 N」。 */
  label: string;
  /** 是不是当前激活的那个。 */
  active: boolean;
  /** 这个名字是不是用户起的（决定长按菜单里「改名」的文案）。 */
  named: boolean;
  /** 这个场景有没有内容（三个都空时顶部要有引导）。 */
  hasContent: boolean;
}

/** 场景条的完整视图。 */
export interface SceneBarView {
  tabs: SceneTabView[];
  /** 当前激活的场景号（0 起）。 */
  activeIndex: number;
  /** 三个场景全都还没有内容（新设备 / 刷完固件）。 */
  allEmpty: boolean;
}

/** 场景的默认名（空名时显示它；`sceneId` 0 起，显示时 +1）。 */
export function defaultSceneLabel(sceneId: number): string {
  return `场景 ${sceneId + 1}`;
}

/**
 * 场景名的展示文字。
 *
 * 设备上的名字可以是空串（§7.2 允许 `name_len = 0`），这时退回「场景 N」——
 * 界面上永远不该出现一个空白按钮。
 */
export function sceneLabelOf(sceneId: number, name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length > 0 ? trimmed : defaultSceneLabel(sceneId);
}

/** 名字的 UTF-8 字节数（与 `cmdSceneName` 的校验同一个口径）。 */
export function nameBytesOf(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** 名字能不能提交（≤ 24 字节，且不是全空白）。 */
export function sceneNameIssue(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "名字不能为空";
  }
  const bytes = nameBytesOf(trimmed);
  if (bytes > NAME_BYTES) {
    return `名字超过 ${NAME_BYTES} 字节（当前 ${bytes}）`;
  }
  return null;
}

/**
 * 三个场景的按钮 + 当前选中。
 *
 * `scenes` 是**设备读回**（`session.sceneOf(i)`，读到才有）。读不到的场景
 * 仍然画出来（否则按钮数会随连接状态跳动），名字回落成「场景 N」、
 * `hasContent` 为 false——那是「还不知道」，不是「空的」。
 */
export function sceneBarView(
  scenes: ReadonlyArray<SceneReport | null | undefined>,
  activeIndex: number,
): SceneBarView {
  const tabs: SceneTabView[] = [];
  for (let sceneId = 0; sceneId < MAX_SCENES; sceneId += 1) {
    const scene = scenes[sceneId] ?? null;
    const rawName = scene === null ? "" : scene.name;
    const trimmed = rawName.trim();
    tabs.push({
      sceneId,
      label: sceneLabelOf(sceneId, rawName),
      active: sceneId === activeIndex,
      named: trimmed.length > 0,
      /*
       * 「有内容」= 读到了、且至少有一个部位带了步骤。
       * 读不到时说 false：把不知道当成空会让「三个场景都空」的引导误报。
       */
      hasContent: scene !== null && scene.parts.some((part) => part.stepCount > 0),
    });
  }
  return {
    tabs,
    activeIndex,
    allEmpty: tabs.every((tab) => !tab.hasContent),
  };
}

/**
 * 切换场景：返回新的激活下标，**不做任何别的推断**。
 *
 * 为什么不在这里顺便重置步号 / 还原开关：那些是设备已经做好的事（C4：设备
 * 把全部部位的播放头重置到此刻），页面只需要**丢掉**自己的陈旧派生。
 * 在这里再算一遍等于把同一件事做两个版本。
 *
 * 越界或已经在那个场景 → 返回原值（引用相等 = 什么都不用刷新）。
 */
export function activateSceneIndex(current: number, next: number): number {
  if (!Number.isInteger(next) || next < 0 || next >= MAX_SCENES) {
    return current;
  }
  return next === current ? current : next;
}

/**
 * 读回的场景名要覆盖本地缓存吗（C3：设备权威）。
 *
 * 规则只有一条：**读到了就用设备的**，包括空名（用户在设备端清空过名字）。
 * 读不到（`null`）时保留本地值——那不是「设备上没名字」，是「还没读到」。
 */
export function mergeSceneName(
  cached: string | null | undefined,
  readback: string | null | undefined,
): string {
  if (readback === null || readback === undefined) {
    return cached ?? "";
  }
  return readback;
}

/**
 * 场景条是否该提示「还没有任何编排」。
 *
 * 只有**三个场景全都读到了、且都空**才提示。否则用户刚连上设备（都还没
 * 读回）就会看到一条假的空态。
 */
export function shouldShowEmptyHint(
  scenes: ReadonlyArray<SceneReport | null | undefined>,
): boolean {
  const allRead = scenes.slice(0, MAX_SCENES).every((scene) => scene !== null && scene !== undefined);
  if (!allRead) {
    return false;
  }
  return scenes
    .slice(0, MAX_SCENES)
    .every((scene) => (scene as SceneReport).parts.every((part) => part.stepCount === 0));
}
