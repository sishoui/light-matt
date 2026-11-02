/**
 * 路由表（#41）：所有页面路径只在这里写一次。
 *
 * 为什么集中：`wx.navigateTo` / `wx.switchTab` 的目标是字符串，写错只会在
 * 真机上「点了没反应」。集中成常量后，页面之间只有一个真相，改路径时
 * 跟着 app.json 一起改，且能一眼看出「谁是 tab、谁是二级页」。
 *
 * 函数体内部才碰 wx（模块 import 无副作用），node 单测不会触发。
 */

/**
 * tabBar 两页（必须与 app.json 的 tabBar.list 完全一致）。
 *
 * #58：删除「剧本」tab —— 灯效方案已并入设备详情页的自定义档，
 * 独立的时间轴编辑器不再有入口，留着只会让用户以为还有第二个地方能编。
 */
export const TAB_ROUTES = {
  home: "/pages/home/home",
  devices: "/pages/devices/devices",
} as const;

/** 二级页（push 进入，不在 tabBar 里）。 */
export const PAGE_ROUTES = {
  device: "/pages/device/device",
  deviceInfo: "/pages/device-info/device-info",
} as const;

/** 切换到 tab 页（不会压栈）。 */
export function switchTabTo(url: (typeof TAB_ROUTES)[keyof typeof TAB_ROUTES]): void {
  wx.switchTab({
    url,
    fail: (err) => console.warn(`[lumen] switchTab 失败：${err.errMsg}`),
  });
}

/** 压栈进入二级页；`query` 里的值会被 URL 编码。 */
export function pushTo(
  url: (typeof PAGE_ROUTES)[keyof typeof PAGE_ROUTES],
  query: Record<string, string | number> = {},
): void {
  const pairs = Object.entries(query).map(
    ([key, value]) => `${key}=${encodeURIComponent(String(value))}`,
  );
  const target = pairs.length > 0 ? `${url}?${pairs.join("&")}` : url;
  wx.navigateTo({
    url: target,
    fail: (err) => console.warn(`[lumen] navigateTo 失败：${err.errMsg}`),
  });
}

/** 从页面 options 里取一个整数查询参数；缺失 / 非法时返回 fallback。 */
export function queryInt(options: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = options[key];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) ? value : fallback;
}

/** 从页面 options 里取一个字符串查询参数；缺失时返回 fallback。 */
export function queryText(
  options: Record<string, string | undefined>,
  key: string,
  fallback = "",
): string {
  const raw = options[key];
  if (raw === undefined) {
    return fallback;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
