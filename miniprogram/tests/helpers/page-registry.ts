/**
 * 页面定义的注册表：把每个页面模块的一次性 `Page({...})` 注册捕获下来。
 *
 * ## 为什么需要一张表而不是动态 `import(path)`
 *
 * 两个原因：
 *
 *  1. `import()` 的**相对路径按调用它的模块解析**，把页面路径当字符串参数传
 *     进去只会解析到 `tests/helpers/` 下（实测 "Failed to load url"）；
 *  2. 微信的 `Page({...})` 在模块**首次求值**时注册一次，之后走模块缓存。
 *     所以每个页面只能被捕获一次——表里给每个页面一个 thunk，并由
 *     `pageDefinition()` 记住第一次捕获的结果。
 *
 * 新增页面时往 `PAGES` 里加一行即可；表里缺页面会让对应的用例直接报「没有
 * 注册」而不是静默拿到 `undefined`。
 */

import { installGlobals } from "./page-runtime";

/** 页面键 → 加载器（顺序只影响人类阅读）。 */
const PAGES = {
  home: () => import("../../pages/home/home"),
  me: () => import("../../pages/me/me"),
  discover: () => import("../../pages/discover/discover"),
  device: () => import("../../pages/device/device"),
  "device-info": () => import("../../pages/device-info/device-info"),
  part: () => import("../../pages/part/part"),
} as const;

/** 可用的页面键。 */
export type PageKey = keyof typeof PAGES;

/** 全局 `Page` 桩捕获到的定义（模块级，跨用例共享）。 */
let captured: any[] | null = null;

/** 已捕获的页面定义（页面键 → 定义），只在首次加载时增长。 */
const definitions = new Map<PageKey, any>();

/** 首次使用时安装全局桩并返回捕获数组。 */
export function installPageCapture(wx: any): any[] {
  if (captured === null) {
    captured = installGlobals({ wx });
  } else {
    (globalThis as any).wx = wx;
  }
  return captured;
}

/**
 * 取某个页面的定义（首次调用时加载模块）。
 *
 * 加载后断言确实捕获到了一个**新的** `Page({...})`：否则说明页面模块没有在
 * 顶层注册，后面的用例会拿到一个空壳，断言全部形同虚设。
 */
export async function pageDefinition(key: PageKey): Promise<any> {
  const cached = definitions.get(key);
  if (cached !== undefined) {
    return cached;
  }
  if (captured === null) {
    throw new Error("pageDefinition 之前必须先 installPageCapture(wx)");
  }
  const before = captured.length;
  await PAGES[key]();
  if (captured.length <= before) {
    /* 已经在这个进程里被别的模块 import 过了：用最后一次捕获兜底。 */
    const fallback = captured[captured.length - 1];
    if (fallback === undefined) {
      throw new Error(`页面 ${key} 没有注册 Page({...})`);
    }
    definitions.set(key, fallback);
    return fallback;
  }
  const def = captured[before];
  definitions.set(key, def);
  return def;
}

/** 测试用：忘掉已捕获的定义（不卸载模块，所以只影响表本身）。 */
export function forgetPageDefinitions(): void {
  definitions.clear();
}
