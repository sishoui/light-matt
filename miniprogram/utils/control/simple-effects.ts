/**
 * 简单档的八个灯效（#96 / #100）。
 *
 * ## 为什么名字里不带颜色
 *
 * 用户是来选**灯效**的，不是来选颜色的。早期的九张卡叫「暖白常亮 / 冷蓝氛围 /
 * 紫色氛围 / 爆闪白 / 心跳暖红 / 熄灭黑」——那是色卡，不是效果清单。现在名字
 * 只说效果本身，颜色由下方的色相 / 饱和度滑块决定。
 *
 * 唯一的例外是**彩虹**：它本身就是彩色的，改名叫「彩色常亮」只会更糊涂。
 *
 * ## 八个（票面明确）
 *
 * 空 / 常亮 / 呼吸 / 彩虹 / 流星 / 爆闪 / 心跳 / 随机闪烁
 *
 * 「脉冲」并入心跳（用单 / 双脉冲开关表达）；「熄灭」在界面上叫「空」——
 * 不亮就是空，不需要另一个词。
 */

import { SEGMENT_TYPE } from "../protocol/constants";

/** 简单档的一个灯效（也是进阶档两层的候选）。 */
export interface SimpleEffect {
  /** 稳定 id（草稿与选中态用它）。 */
  id: string;
  /** 界面上显示的名字（**不带颜色**）。 */
  name: string;
  /** 一行说明（滚轮里的副标题）。 */
  hint: string;
  /** 协议类型；`null` 表示「空」（编码为熄灭，见 `effectTypeOf`）。 */
  type: number;
}

/** 八个灯效（顺序就是滚轮里的顺序）。 */
export const SIMPLE_EFFECTS: readonly SimpleEffect[] = [
  {
    id: "empty",
    name: "空",
    hint: "不发光，留给另一层",
    type: null as unknown as number,
  },
  {
    id: "solid",
    name: "常亮",
    hint: "整组一个颜色，最省电",
    type: SEGMENT_TYPE.STATIC,
  },
  {
    id: "breathe",
    name: "呼吸",
    hint: "缓亮缓暗",
    type: SEGMENT_TYPE.BREATHING,
  },
  {
    id: "rainbow",
    name: "彩虹",
    hint: "颜色沿灯组铺开并流动",
    type: SEGMENT_TYPE.RAINBOW,
  },
  {
    id: "comet",
    name: "流星",
    hint: "亮点拖着尾巴跑动",
    type: SEGMENT_TYPE.COMET,
  },
  {
    id: "strobe",
    name: "爆闪",
    hint: "高频闪烁，够醒目",
    type: SEGMENT_TYPE.STROBE,
  },
  {
    id: "heartbeat",
    name: "心跳",
    hint: "一明一暗像心跳",
    type: SEGMENT_TYPE.HEARTBEAT,
  },
  {
    id: "flicker",
    name: "随机闪烁",
    hint: "零星亮点随机亮灭",
    type: SEGMENT_TYPE.FLICKER,
  },
];

/** 按 id 取灯效；未知返回 null。 */
export function simpleEffectOf(id: string): SimpleEffect | null {
  return SIMPLE_EFFECTS.find((effect) => effect.id === id) ?? null;
}

/** 按协议类型反查灯效 id（设备读回时用）；未知类型返回 null。 */
export function simpleEffectIdOfType(type: number): string | null {
  if (type === SEGMENT_TYPE.OFF) {
    return "empty";
  }
  return SIMPLE_EFFECTS.find((effect) => effect.type === type)?.id ?? null;
}

/**
 * 「空」的协议编码：既有的「熄灭」类型（#100 的裁决）。
 *
 * 协议要求每段的背景层必须是真实灯效，所以「空」只能写成 OFF 类型；
 * 它输出恒为黑，等价于「这一层不贡献光」。
 */
export function emptyEffectType(): number {
  return SEGMENT_TYPE.OFF;
}

/**
 * 灯效 id → 实际写进协议的 type。
 *
 * `empty` 走 OFF；其余就是 `effect.type`。
 */
export function effectTypeOf(id: string): number {
  const effect = simpleEffectOf(id);
  if (effect === null) {
    return SEGMENT_TYPE.STATIC;
  }
  return effect.id === "empty" ? emptyEffectType() : effect.type;
}

/** 一行式列表的展示行（左名称 / 右当前值）。 */
export interface EffectRowView {
  /** 行标识（设置项名，不是某个具体灯效）。 */
  key: string;
  /** 左侧名称。 */
  label: string;
  /** 右侧当前值（「呼吸」）。 */
  value: string;
}

/**
 * 一行式视图：当前选中的灯效。
 *
 * 简单档只有一个可选项（整组一个灯效），所以列表只有一行；点它弹出滚轮。
 * 这个形状是刻意的——票面要的就是「一行一个设置」，不是一屏色块。
 */
export function buildEffectRows(selectedId: string | null): EffectRowView[] {
  const effect = selectedId === null ? null : simpleEffectOf(selectedId);
  return [
    {
      key: "effect",
      label: "灯效",
      value: effect?.name ?? "未设置",
    },
  ];
}

/** 滚轮里的一行（左名称 + 副说明 + 选中态）。 */
export interface WheelOptionView {
  id: string;
  name: string;
  hint: string;
  selected: boolean;
  /** 行尾的选中勾。 */
  check: boolean;
}

/** 滚轮选项列表（八个灯效，当前选中高亮）。 */
export function buildWheelOptions(selectedId: string | null): WheelOptionView[] {
  return SIMPLE_EFFECTS.map((effect) => ({
    id: effect.id,
    name: effect.name,
    hint: effect.hint,
    selected: effect.id === selectedId,
    check: effect.id === selectedId,
  }));
}

/** 灯效名里不该出现的颜色词（验收项：「名字里没有颜色词，彩虹除外」）。 */
export const FORBIDDEN_COLOR_WORDS: readonly string[] = [
  "暖",
  "冷",
  "红",
  "绿",
  "蓝",
  "紫",
  "白",
  "黄",
  "橙",
  "青",
  "粉",
  "黑",
];

/**
 * 检查一个灯效名是否违规（含颜色词且不是「彩虹」）。
 *
 * 单测用它锁住八个名字；界面文案改动时这里先红。
 */
export function hasColorWord(name: string): boolean {
  if (name.includes("彩虹")) {
    return false;
  }
  return FORBIDDEN_COLOR_WORDS.some((word) => name.includes(word));
}
