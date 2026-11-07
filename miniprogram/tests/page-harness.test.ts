/**
 * 页面 harness 自身的契约（底座坏了，上面的页面回归会以错误的方式绿）。
 *
 * 这里只断言底座的可观察行为：能拿到页面定义、能注入会话、`settle` 真的等到
 * `ready`、收尾真的解绑、事件构造器放在处理器读取的位置。不掺业务断言。
 */

import { describe, expect, it } from "vitest";
import {
  createWxStub,
  input,
  MOCK_FIRST,
  openPage,
  pick,
  settle,
  slide,
  tap,
  toggle,
} from "./helpers/page-harness";
import { installPageCapture, pageDefinition } from "./helpers/page-registry";

describe("页面 harness", () => {
  it("wx 桩把存储写进内存、把 toast / modal 记下来", () => {
    const stub = createWxStub();
    stub.wx.setStorageSync("a", "1");
    expect(stub.wx.getStorageSync("a")).toBe("1");
    stub.wx.showToast({ title: "hi" });
    expect(stub.toasts).toEqual(["hi"]);
    stub.wx.showModal({ title: "t", content: "c", success: () => undefined });
    expect(stub.modals).toEqual([{ title: "t", content: "c", confirmText: undefined }]);
    stub.wx.removeStorageSync("a");
    expect(stub.wx.getStorageSync("a")).toBeUndefined();
  });

  it("事件构造器把值放在页面处理器读的位置", () => {
    expect(tap({ index: "2" }).currentTarget.dataset.index).toBe("2");
    expect(slide(30).detail.value).toBe(30);
    expect(toggle(false).detail.value).toBe(false);
    expect(pick(1).detail.value).toBe(1);
    expect(input("x").detail.value).toBe("x");
  });

  it("每个页面都能被捕获（没有遗漏注册的页面）", async () => {
    const stub = createWxStub();
    installPageCapture(stub.wx);
    for (const key of ["home", "me", "discover", "device", "device-info", "part"] as const) {
      const def = await pageDefinition(key);
      expect(def, `${key} 没有注册 Page({...})`).toBeDefined();
      expect(typeof def.onLoad).toBe("function");
    }
  });

  it("能打开页面并注入一个已连上的演示会话", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    try {
      expect(harness.page.data.ready).toBe(true);
      expect(harness.session.linkState).toBe("ready");
      expect(harness.session.transport.currentDeviceId).toBe(MOCK_FIRST);
    } finally {
      await harness.dispose();
    }
  });

  it("settle 在页面已经 ready 时立即返回（不会卡满超时）", async () => {
    const page = { data: { ready: true } };
    const t0 = Date.now();
    await settle(page);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("收尾会解绑会话（后续用例不再收到旧页面的回调）", async () => {
    const harness = await openPage("device", { key: MOCK_FIRST });
    await harness.dispose();
    expect(harness.session.linkState).not.toBe("ready");
  });
});
