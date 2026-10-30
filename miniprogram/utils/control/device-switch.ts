/**
 * 设备切换状态机（#33）。
 *
 * 单连接 + 切换，不并发。已定的取舍：
 *  - 切换 = 先断开当前再连新的（设备只允许 1 个连接）；
 *  - **切换失败停在 failed + 重试入口，不自动回滚**。回滚到 A 在 A 也不可用时
 *    会来回震荡，用户完全无法判断该点哪个按钮；
 *  - 切换是**主动意图**，绝不走 1s/2s/4s 的自动回连退避——那套机制是给
 *    「非自愿断线」用的，用错对象会对错误的设备反复拨号。
 *
 * 本模块是纯状态机：只表达阶段与事件，不碰 BLE、计时器、storage，
 * 因此可以逐条断言。真正的连接动作由调用方（session）执行。
 */

/** 切换阶段。failed 保留目标设备，供 UI 给「重试」入口。 */
export type SwitchPhase = "idle" | "disconnecting" | "connecting" | "ready" | "failed";

export interface SwitchState {
  phase: SwitchPhase;
  /** 正在切/切换失败时保留的目标设备；idle / ready 时为 null。 */
  target: { deviceId: string; name?: string } | null;
  /** failed 时的原因文案（给用户看，不参与逻辑）。 */
  error: string | null;
}

export function initialSwitchState(): SwitchState {
  return { phase: "idle", target: null, error: null };
}

/** 正在切换中（UI 显示加载态、禁用重复点击）。 */
export function isSwitching(state: SwitchState): boolean {
  return state.phase === "disconnecting" || state.phase === "connecting";
}

/** 切换前是否必须先断开：只有当前链路是 ready 时才需要。 */
export function needsDisconnect(linkState: string): boolean {
  return linkState === "ready";
}

/**
 * 开始一次切换。
 *
 * 如果当前已连接，先进入 disconnecting；否则直接 connecting。
 * 重复点击同一目标时保持原状态（不重启流程），避免抖动。
 */
export function beginSwitch(
  state: SwitchState,
  deviceId: string,
  name: string | undefined,
  currentLink: string,
): SwitchState {
  if (isSwitching(state) && state.target?.deviceId === deviceId) {
    return state;
  }
  const target = { deviceId, ...(name !== undefined && name.length > 0 ? { name } : {}) };
  return {
    phase: needsDisconnect(currentLink) ? "disconnecting" : "connecting",
    target,
    error: null,
  };
}

/** 断开完成 → 可以连新设备了。 */
export function switchedDisconnected(state: SwitchState): SwitchState {
  if (state.phase !== "disconnecting") {
    return state;
  }
  return { ...state, phase: "connecting" };
}

/** 连接成功。目标不再需要保留。 */
export function switchedReady(state: SwitchState): SwitchState {
  if (state.phase !== "connecting" && state.phase !== "disconnecting") {
    return state;
  }
  return { phase: "ready", target: null, error: null };
}

/**
 * 切换失败：**停在 failed，保留目标**，不做任何自动回滚。
 *
 * 调用方必须确保此时链路已经断开（我们主动断的），所以用户看到的是
 * 「未连接」而不是「还连着旧设备但 UI 说失败」。
 */
export function switchFailed(state: SwitchState, error: string): SwitchState {
  if (!isSwitching(state)) {
    return state;
  }
  return { ...state, phase: "failed", error };
}

/** 放弃切换（用户点取消 / 页面卸载）：回到 idle，不再保留目标。 */
export function abandonSwitch(): SwitchState {
  return initialSwitchState();
}

/**
 * 重试：从 failed 重新走一遍，目标沿用上一次的。
 * 没有失败目标时返回原状态（无副作用）。
 */
export function retrySwitch(state: SwitchState, currentLink: string): SwitchState {
  if (state.phase !== "failed" || state.target === null) {
    return state;
  }
  return {
    phase: needsDisconnect(currentLink) ? "disconnecting" : "connecting",
    target: state.target,
    error: null,
  };
}
