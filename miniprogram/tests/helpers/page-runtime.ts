/**
 * 页面运行时：把 `Page({...})` 的对象变成可在 Node 里驱动的实例。
 *
 * 为什么需要它：用户要的是「点每一步，设备有没有反应」。这要求**跑页面自己的
 * 事件处理器**（不是测试里另写一遍调用顺序），而且 `wx` 要转发到真实 BLE。
 *
 * 做法：
 *  - `Page(obj)` 被捕获后，把 obj 的**方法**挂到实例上，`data` 独立一份；
 *  - `setData` 支持小程序的两条语义：对象浅合并 + 支持 `a.b[0]` 这样的路径键；
 *  - `this.session` 由测试注入（走真实 ControlSession + BleTransport + 网关）。
 *
 * 不模拟渲染：WXML 模板不求值，断言一律读页面 `data` 与**设备 State**。
 */

export function installGlobals({ wx }: { wx: any }) {
  const captured: any[] = [];
  /* 页面在 measureTimeline / 长按拖动里调 wx.createSelectorQuery().select().boundingClientRect()。
   * 渲染层不存在，这里给一个固定容器宽，让「按比例分配块宽」能算出确定值。 */
  (wx as any).createSelectorQuery = () => {
    const q: any = {
      select: () => q,
      selectAll: () => q,
      selectViewport: () => q,
      in: () => q,
      boundingClientRect: (cb: any) => {
        if (typeof cb === "function") {
          setTimeout(() => cb({ width: 640, height: 48, left: 0, top: 0 }), 0);
        }
        return q;
      },
      scrollOffset: (cb: any) => {
        if (typeof cb === "function") setTimeout(() => cb({ scrollLeft: 0, scrollTop: 0 }), 0);
        return q;
      },
      fields: (opts: any, cb: any) => {
        const fn = typeof opts === "function" ? opts : cb;
        if (typeof fn === "function") setTimeout(() => fn({}), 0);
        return q;
      },
      exec: (cb?: any) => {
        if (typeof cb === "function") setTimeout(() => cb([]), 0);
        return q;
      },
    };
    return q;
  };
  (wx as any).nextTick = (fn: () => void) => setTimeout(fn, 0);
  (wx as any).createAnimation = () => ({
    step: () => undefined, export: () => ({}), height: () => undefined,
  });
  (globalThis as any).wx = wx;
  (globalThis as any).Page = (obj: any) => { captured.push(obj); };
  (globalThis as any).Component = (obj: any) => { captured.push(obj); };
  (globalThis as any).getApp = () => ({ globalData: {} });
  (globalThis as any).getCurrentPages = () => [];
  return captured;
}

function setByPath(target: any, path: string, value: any) {
  if (!/[[.]/.test(path)) {
    target[path] = value;
    return;
  }
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (cur[key] === undefined || cur[key] === null) {
      cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

/** 把一个 Page({...}) 的对象变成实例。 */
export function instantiate(pageDef: any) {
  const instance: any = {
    data: JSON.parse(JSON.stringify(pageDef.data ?? {})),
    setData(patch: Record<string, any>, cb?: () => void) {
      for (const [key, value] of Object.entries(patch)) {
        setByPath(instance.data, key, value);
      }
      cb?.();
    },
  };
  for (const [key, value] of Object.entries(pageDef)) {
    if (key === "data" || key === "setData") continue;
    instance[key] = typeof value === "function" ? value.bind(instance) : value;
  }
  return instance;
}

/** 等某个条件成立（页面里的异步链路要等 ACK / State）。 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 15000, intervalMs = 100, label = "条件" } = {},
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等超时：${label}（${timeoutMs}ms）`);
}
