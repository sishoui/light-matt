/**
 * 页面测试底座的自查（#115）。
 *
 * 底座是「让页面能在没有真机的环境里被驱动」的那一层。它自己要是坏的，
 * 上面所有页面回归都会以错误的方式绿：
 *  - `setData` 不认路径键 → 页面读到的是一份永远不更新的副本，断言形同虚设；
 *  - `data` 与 `pageDef.data` 共用引用 → 用例之间互相污染，跑单条绿、跑全量红；
 *  - 渲染期 API 缺失 → 页面在 `onLoad` 链上抛错，事件绑定整个断掉。
 *
 * 所以这里断言的是底座**自己的可观察行为**，不是某个页面的业务。
 * 底座不掺业务判定，也不含任何页面的断言。
 */

import { describe, expect, it } from "vitest";
import { installGlobals, instantiate, waitFor } from "./helpers/page-runtime";

describe("#115 页面底座", () => {
  const minimalPage = () => ({
    data: { count: 0, nested: { items: [] as string[] } },
    onLoad() {
      /* onLoad 里能读到自己 data。 */
      this.setData({ loaded: true });
    },
    increment() {
      this.setData({ count: this.data.count + 1 });
    },
  });

  it("我把 Page 定义变成可调用实例：方法可直接调、data 可读", () => {
    const page = instantiate(minimalPage());
    expect(page.data.count).toBe(0);
    page.onLoad();
    expect(page.data.loaded).toBe(true);
    page.increment();
    page.increment();
    expect(page.data.count).toBe(2);
  });

  it("setData 支持 `a.b[0]` 这类路径键（含数组下标）", () => {
    const page = instantiate(minimalPage());
    page.setData({ "nested.items[0]": "first", "nested.items[1]": "second" });
    expect(page.data.nested.items).toEqual(["first", "second"]);

    /* 深层对象未存在时自动建出来。 */
    page.setData({ "fresh.deep.value": 42 });
    expect(page.data.fresh.deep.value).toBe(42);
  });

  it("setData 是对象浅合并，不是整份替换", () => {
    const page = instantiate({ data: { a: 1, b: 2 } });
    page.setData({ b: 3 });
    expect(page.data).toEqual({ a: 1, b: 3 });
  });

  it("data 与 Page 定义里的 data 各持一份（用例之间不互相污染）", () => {
    const def = minimalPage();
    const first = instantiate(def);
    const second = instantiate(def);

    first.setData({ count: 99 });
    first.setData({ "nested.items[0]": "only-first" });

    expect(def.data.count, "定义本身不该被改").toBe(0);
    expect(second.data.count, "第二个实例要从初值开始").toBe(0);
    expect(second.data.nested.items, "嵌套对象也要独立").toEqual([]);
  });

  it("setData 的回调会被调用（页面里靠它做「重画后」的收尾）", async () => {
    const page = instantiate({ data: {} });
    let called = false;
    page.setData({ x: 1 }, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("渲染期 API 被补上：选择器查询 / nextTick / createAnimation 都不抛", () => {
    const wx: any = {};
    installGlobals({ wx });

    /* 页面在 measureTimeline 里这样用；缺任何一个都会让 onLoad 链断掉。 */
    expect(() => wx.createSelectorQuery().select(".x").boundingClientRect()).not.toThrow();
    expect(() => wx.nextTick(() => undefined)).not.toThrow();
    const animation = wx.createAnimation();
    expect(() => animation.step()).not.toThrow();
    expect(animation.export()).toEqual({});
  });

  it("选择器查询回确定性的容器宽（派生算得出固定值）", async () => {
    const wx: any = {};
    installGlobals({ wx });

    const rect = await new Promise((resolve) => {
      wx.createSelectorQuery().select(".timeline-row").boundingClientRect(resolve).exec();
    });
    expect(rect).toMatchObject({ width: 640, height: 48 });
  });

  it("waitFor 在条件成立时立即返回，超时抛错（用例不会静默继续）", async () => {
    await expect(waitFor(() => true, { timeoutMs: 500 })).resolves.toBeUndefined();
    await expect(
      waitFor(() => false, { timeoutMs: 200, intervalMs: 50, label: "永假条件" }),
    ).rejects.toThrow(/等超时/);
  });

  it("Page 定义里的非函数字段原样挂上实例（但私有字段仍需页面自己初始化）", () => {
    const page = instantiate({ data: {}, someFlag: 7 });
    expect(page.someFlag).toBe(7);
  });
});
