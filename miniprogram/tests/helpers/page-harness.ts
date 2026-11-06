/**
 * 页面级共用底座：把「真实 ControlSession + 演示传输层 + 真实页面处理器」
 * 接起来，让用例能断言**设备可观察状态**而不是页面 data。
 *
 * 为什么需要它：`session-v3` / `brightness` / `selftest` 这些测的是会话与纯函数；
 * 而「点页面上的电源键，设备开关真的翻了吗」「灯组开关只动一位吗」这类问题只有
 * 跑**页面自己的处理器**才能回答。`page-runtime` 提供了 `Page({...})` 的实例化，
 * `page-registry` 负责把页面定义捕获一次，这里补上「页面要的那个会话」。
 *
 * ## 只替换允许替换的东西
 *
 * 传输层是产品代码本身（`MockTransport`），存储是内存实现；其余全是真代码。
 */

import { ControlSession } from "../../utils/control/session";
import { setSessionForTest } from "../../utils/control/session-singleton";
import { MockTransport } from "../../utils/ble/mock-transport";
import type { BleTransport } from "../../utils/ble/transport";
import { MOCK_DEVICES } from "../../utils/control/mock-devices";
import { instantiate } from "./page-runtime";
import { installPageCapture, pageDefinition, type PageKey } from "./page-registry";
import { createSessionStorage, type MemoryStorage } from "./storage";

/** 演示设备 0（书桌）的 deviceId。 */
export const MOCK_FIRST = MOCK_DEVICES[0].deviceId;

/** 一个可驱动的页面 + 它背后的会话。 */
export interface PageHarness {
  page: any;
  session: ControlSession;
  transport: MockTransport;
  storage: MemoryStorage;
  /** `wx` 桩（toast / modal 的记录在 `createWxStub` 的返回值里）。 */
  wx: any;
  /** 解绑并丢弃会话（每个用例收尾调用，避免泄漏监听）。 */
  dispose(): Promise<void>;
}

/** 一个够用的 `wx` 桩：存储走内存 Map，UI 反馈只记录不弹。 */
export function createWxStub(): {
  wx: any;
  toasts: string[];
  modals: Array<{ title: string; content: string; confirmText?: string }>;
} {
  const store = new Map<string, any>();
  const toasts: string[] = [];
  const modals: Array<{ title: string; content: string; confirmText?: string }> = [];
  const wx: any = {
    getStorageSync: (key: string) => store.get(key),
    setStorageSync: (key: string, value: any) => void store.set(key, value),
    removeStorageSync: (key: string) => void store.delete(key),
    getStorageInfoSync: () => ({ keys: [...store.keys()] }),
    showToast: (opts: { title?: string }) => void toasts.push(String(opts.title ?? "")),
    showModal: (opts: any) => {
      modals.push({ title: opts.title, content: opts.content, confirmText: opts.confirmText });
      opts.success?.({ confirm: true, cancel: false });
    },
    vibrateShort: () => undefined,
    navigateBack: () => undefined,
    navigateTo: () => undefined,
    getWindowInfo: () => ({ statusBarHeight: 24 }),
    getSystemInfoSync: () => ({ statusBarHeight: 24 }),
    getDeviceInfo: () => ({ platform: "devtools" }),
  };
  return { wx, toasts, modals };
}

/**
 * 加载一个页面并给它注入一个**已连上演示设备 0** 的会话。
 *
 * `options` 是页面 `onLoad` 的查询参数（`{ key, strip, part }` 等）。
 */
export async function openPage(
  key: PageKey,
  options: Record<string, string> = {},
): Promise<PageHarness> {
  const stub = createWxStub();
  installPageCapture(stub.wx);
  const pageDef = await pageDefinition(key);

  const storage = createSessionStorage();
  const transport = new MockTransport();
  const session = new ControlSession({
    platform: "other",
    devMode: false,
    storage,
    transportOverride: transport as unknown as BleTransport,
    reconnectDelaysMs: [],
  });
  await session.connect(MOCK_FIRST, "书桌");
  setSessionForTest(session);

  const page = instantiate(pageDef);
  page.onLoad(options);
  page.onShow?.();
  await settle(page);
  return {
    page,
    session,
    transport,
    storage,
    wx: stub.wx,
    dispose: async () => {
      try {
        page.onUnload?.();
      } catch {
        /* 页面卸载不该让用例失败。 */
      }
      setSessionForTest(null);
      await session.disconnect().catch(() => undefined);
    },
  };
}

/** 等页面把异步链路跑完（`ready` 变真且没有在忙）。 */
export async function settle(page: any, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (page.data.ready === true && page.data.busy !== true && page.data.powerBusy !== true) {
      /* 再多等一拍：`reload()` 之后的第二段派生也在同一个事件循环里。 */
      await new Promise((r) => setTimeout(r, 20));
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 一个能塞进 `data-*` 的 tap 事件。 */
export function tap(dataset: Record<string, any> = {}): any {
  return { currentTarget: { dataset }, detail: {} };
}

/** 一个滑块事件。 */
export function slide(value: number, dataset: Record<string, any> = {}): any {
  return { currentTarget: { dataset }, detail: { value } };
}

/** 一个开关事件。 */
export function toggle(value: boolean, dataset: Record<string, any> = {}): any {
  return { currentTarget: { dataset }, detail: { value } };
}

/** 一个 picker 事件。 */
export function pick(value: number | string): any {
  return { currentTarget: { dataset: {} }, detail: { value } };
}

/** 一个输入框事件。 */
export function input(value: string): any {
  return { detail: { value } };
}
