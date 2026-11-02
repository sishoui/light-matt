/**
 * 传输层的订阅者注册表与事件派发。
 *
 * 只有这一份 listener 数组；派发时对快照迭代并吞掉监听者异常（监听者异常
 * 不能影响状态机）。会话层与页面都通过 transport 的 on* 方法间接使用这里。
 */

import type { DeviceState, DiscoveredDevice, LinkState } from "../protocol/types";

export interface LinkDetail {
  message?: string;
  deviceName?: string;
  /**
   * true = 非用户主动的断线（设备断电 / 超出范围 / 10006）。
   * 会话层据此启动 1s/2s/4s 自动回连；主动 disconnect 不带这个标记。
   */
  reconnectable?: boolean;
}

export class TransportListeners {
  private readonly linkListeners: Array<(state: LinkState, detail?: LinkDetail) => void> = [];
  private readonly deviceListeners: Array<(list: DiscoveredDevice[]) => void> = [];
  private readonly stateListeners: Array<(state: DeviceState) => void> = [];
  private readonly eventListeners: Array<(code: number, detail: number) => void> = [];
  private readonly scanHintListeners: Array<(hint: string | null) => void> = [];
  /** #32：设备侧的 ScriptProgress(0x86) 旁证（每接受 8 帧一条）。 */
  private readonly scriptProgressListeners: Array<(scriptId: number, frames: number) => void> = [];

  onLink(fn: (state: LinkState, detail?: LinkDetail) => void): () => void {
    return subscribe(this.linkListeners, fn);
  }

  onDevices(fn: (list: DiscoveredDevice[]) => void): () => void {
    return subscribe(this.deviceListeners, fn);
  }

  onState(fn: (state: DeviceState) => void): () => void {
    return subscribe(this.stateListeners, fn);
  }

  onDeviceEvent(fn: (code: number, detail: number) => void): () => void {
    return subscribe(this.eventListeners, fn);
  }

  onScanHint(fn: (hint: string | null) => void): () => void {
    return subscribe(this.scanHintListeners, fn);
  }

  /** #32：ScriptProgress 0x86 的旁证（scriptId + 设备侧累计帧数）。 */
  onScriptProgress(fn: (scriptId: number, frames: number) => void): () => void {
    return subscribe(this.scriptProgressListeners, fn);
  }

  emitLink(state: LinkState, detail?: LinkDetail): void {
    for (const fn of this.linkListeners.slice()) {
      try {
        fn(state, detail);
      } catch {
        /* 监听者异常不能影响状态机 */
      }
    }
  }

  emitDevices(list: DiscoveredDevice[]): void {
    for (const fn of this.deviceListeners.slice()) {
      try {
        fn(list);
      } catch {
        /* ignore */
      }
    }
  }

  emitState(state: DeviceState): void {
    for (const fn of this.stateListeners.slice()) {
      try {
        fn(state);
      } catch {
        /* ignore */
      }
    }
  }

  emitEvent(code: number, detail: number): void {
    for (const fn of this.eventListeners.slice()) {
      try {
        fn(code, detail);
      } catch {
        /* ignore */
      }
    }
  }

  emitScanHint(hint: string | null): void {
    for (const fn of this.scanHintListeners.slice()) {
      try {
        fn(hint);
      } catch {
        /* ignore */
      }
    }
  }

  emitScriptProgress(scriptId: number, frames: number): void {
    for (const fn of this.scriptProgressListeners.slice()) {
      try {
        fn(scriptId, frames);
      } catch {
        /* ignore */
      }
    }
  }

  clear(): void {
    this.linkListeners.length = 0;
    this.deviceListeners.length = 0;
    this.stateListeners.length = 0;
    this.eventListeners.length = 0;
    this.scanHintListeners.length = 0;
    this.scriptProgressListeners.length = 0;
  }
}

/** 注册并返回反注册函数；数组用截断/拼接保持原引用（clear 依赖同引用）。 */
function subscribe<T>(list: T[], fn: T): () => void {
  list.push(fn);
  return () => {
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
}
