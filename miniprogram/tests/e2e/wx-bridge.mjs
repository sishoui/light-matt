/**
 * 真机 e2e 的 `wx` 桥接：把小程序用到的 wx.* 转发给 Python BLE 网关。
 *
 * **为什么要这么绕**：微信开发者工具的蓝牙是桩实现（`createBLEConnection`
 * 直接回「暂时不支持此 API 调试」），而 `noble` 在 Node 24 上编译不过。
 * 所以让 Python `bleak` 驱动 PC 的真实蓝牙，Node 这边**只替换 `wx` 对象**，
 * 于是 `BleTransport` / `ControlSession` / 帧编解码都是原封不动的产品代码。
 *
 * 这比「写一个假 transport」有价值得多：假 transport 只能验证调用顺序，
 * 这里验证的是真实的 MTU、分片、CRC、ACK 时序。
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY = resolve(HERE, "../../../scripts/ble-gateway.py");

export const UUID = {
  service: "6c756d65-6e00-4b1e-9a3c-000000000001",
  rx: "6c756d65-6e00-4b1e-9a3c-000000000002",
  tx: "6c756d65-6e00-4b1e-9a3c-000000000003",
  state: "6c756d65-6e00-4b1e-9a3c-000000000004",
};

/** Python 解释器：优先环境变量，其次 PATH 上的 python。 */
function pythonBin() {
  return process.env.LUMEN_PYTHON || "python";
}

/**
 * 启动网关子进程并返回一个「按 id 等响应」的客户端。
 * 事件（device_found / notify / disconnect）通过 handlers 派发。
 */
export function startGateway({ onEvent, timeoutMs = 20000 } = {}) {
  if (!existsSync(GATEWAY)) {
    throw new Error(`找不到网关脚本：${GATEWAY}`);
  }
  const child = spawn(pythonBin(), [GATEWAY], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 0;
  let readyResolve;
  const ready = new Promise((res) => { readyResolve = res; });
  const stderrLines = [];

  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === "ready") { readyResolve(msg.value); return; }
    if (msg.event) { onEvent?.(msg); return; }
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(new Error(msg.error || "gateway error"));
    }
  });

  createInterface({ input: child.stderr }).on("line", (l) => {
    stderrLines.push(l);
    if (stderrLines.length > 200) stderrLines.shift();
  });

  function call(op, args = {}) {
    nextId += 1;
    const id = nextId;
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectP(new Error(`网关超时：${op}（stderr: ${stderrLines.slice(-3).join(" | ")}）`));
      }, timeoutMs);
      pending.set(id, { resolve: resolveP, reject: rejectP, timer });
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  function stop() {
    for (const [, w] of pending) { clearTimeout(w.timer); w.reject(new Error("网关已关闭")); }
    pending.clear();
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
  }

  return { call, ready, stop, child, stderrLines, emit: (msg) => onEvent?.(msg) };
}

/**
 * 构造一个只实现 BLE 相关 API 的 `wx` 桩。
 *
 * 非 BLE 的调用（storage / request / navigate）一律走最小的降级实现：
 * 存储用内存 Map，网络直接失败（usage logger 会因此关闭，不影响控制路径）。
 */
export function createWxStub(initialGw = null) {
  /*
   * 网关是延迟注入的：必须先有 stub 才能把它接到 startGateway 的 onEvent 上，
   * 但 stub 内部的 callBle 又需要网关。所以这里允许先建、后 setGateway。
   */
  let gw = initialGw;
  const setGateway = (g) => { gw = g; };
  const listeners = {
    deviceFound: [],
    connectionState: [],
    characteristicValue: [],
    adapterState: [],
  };
  let connectedId = null;
  const mem = new Map();
  let cachedMtu = 247;

  /* 网关事件 → wx 监听器 */
  /** 网关事件入口：startGateway 的 onEvent 会调它。 */
  const pump = (msg) => {
    const v = msg.value || {};
    if (msg.event === "device_found") {
      const payload = { devices: [v] };
      for (const fn of listeners.deviceFound) fn(payload);
    } else if (msg.event === "notify") {
      const payload = {
        deviceId: connectedId,
        serviceId: UUID.service,
        characteristicId: v.char,
        value: Uint8Array.from(v.data).buffer,
      };
      for (const fn of listeners.characteristicValue) fn(payload);
    } else if (msg.event === "disconnect") {
      connectedId = null;
      for (const fn of listeners.connectionState) fn({ deviceId: v.deviceId, connected: false });
    }
  };

  /** 把 wx 的 {success,fail,complete} 套到网关调用上。 */
  const callBle = (op, args, opts, mapValue) =>
    gw
      .call(op, args)
      .then((value) => {
        opts?.success?.((mapValue ? mapValue(value) : value) ?? {});
      })
      .catch((e) => {
        opts?.fail?.({ errMsg: `${opWithPrefix(op)}:fail ${e.message}`, errCode: 10000 });
      })
      .finally(() => {
        opts?.complete?.({});
      });

  const opWithPrefix = (op) => {
    const map = {
      scan_start: "startBluetoothDevicesDiscovery",
      scan_stop: "stopBluetoothDevicesDiscovery",
      connect: "createBLEConnection",
      device_services: "getBLEDeviceServices",
      device_characteristics: "getBLEDeviceCharacteristics",
      write: "writeBLECharacteristicValue",
      read: "readBLECharacteristicValue",
      notify_start: "notifyBLECharacteristicValueChange",
      notify_stop: "notifyBLECharacteristicValueChange",
      get_mtu: "getBLEMTU",
      set_mtu: "setBLEMTU",
    };
    return map[op] || op;
  };

  const on = (key) => (fn) => { if (typeof fn === "function") listeners[key].push(fn); };
  const off = (key) => (fn) => {
    const i = listeners[key].indexOf(fn);
    if (i >= 0) listeners[key].splice(i, 1);
  };

  const wx = {
    /* ---- BLE ---- */
    openBluetoothAdapter: (opts) =>
      gw.ready.then(() => opts?.success?.({})).catch((e) => opts?.fail?.({ errMsg: e.message })),
    closeBluetoothAdapter: (opts) => opts?.success?.({}),
    getBluetoothAdapterState: (opts) =>
      opts?.success?.({ available: true, discovering: false }),
    startBluetoothDevicesDiscovery: (opts) =>
      callBle("scan_start", { allow_duplicates: opts?.allowDuplicatesKey ?? false }, opts, () => ({})),
    stopBluetoothDevicesDiscovery: (opts) => callBle("scan_stop", {}, opts, () => ({})),
    getBluetoothDevices: (opts) => callBle("scan_get", {}, opts, (v) => ({ devices: v })),
    onBluetoothDeviceFound: on("deviceFound"),
    offBluetoothDeviceFound: off("deviceFound"),
    onBluetoothAdapterStateChange: on("adapterState"),
    offBluetoothAdapterStateChange: off("adapterState"),

    createBLEConnection: (opts) =>
      callBle("connect", { deviceId: opts.deviceId }, opts, (v) => {
        connectedId = opts.deviceId;
        cachedMtu = v.mtu || cachedMtu;
        for (const fn of listeners.connectionState) fn({ deviceId: opts.deviceId, connected: true });
        return {};
      }),
    closeBLEConnection: (opts) =>
      callBle("disconnect", {}, opts, () => {
        connectedId = null;
        return {};
      }),
    onBLEConnectionStateChange: on("connectionState"),
    offBLEConnectionStateChange: off("connectionState"),

    getBLEDeviceServices: (opts) =>
      callBle("device_services", {}, opts, (v) => ({ services: v })),
    getBLEDeviceCharacteristics: (opts) =>
      callBle("device_characteristics", { serviceId: opts.serviceId }, opts, (v) => ({ characteristics: v })),

    writeBLECharacteristicValue: (opts) =>
      callBle(
        "write",
        {
          characteristicId: opts.characteristicId,
          data: Array.from(new Uint8Array(opts.value)),
        },
        opts,
        () => ({}),
      ),
    readBLECharacteristicValue: (opts) =>
      callBle("read", { characteristicId: opts.characteristicId }, opts, (v) => {
        /* wx 的 read 是异步回调 + onBLECharacteristicValueChange 通知；
         * 这里同时走两条路，保证 transport 的两种实现都能收到。 */
        const buf = Uint8Array.from(v.data).buffer;
        const payload = {
          deviceId: connectedId,
          serviceId: opts.serviceId,
          characteristicId: opts.characteristicId,
          value: buf,
        };
        for (const fn of listeners.characteristicValue) fn(payload);
        return {};
      }),

    notifyBLECharacteristicValueChange: (opts) =>
      callBle(
        opts.state === false ? "notify_stop" : "notify_start",
        { characteristicId: opts.characteristicId },
        opts,
        () => ({}),
      ),
    onBLECharacteristicValueChange: on("characteristicValue"),
    offBLECharacteristicValueChange: off("characteristicValue"),

    getBLEMTU: (opts) => callBle("get_mtu", {}, opts, (v) => ({ mtu: v.mtu })),
    setBLEMTU: (opts) => callBle("set_mtu", {}, opts, (v) => ({ mtu: v.mtu })),

    /* ---- 平台信息 ---- */
    getDeviceInfo: () => ({ platform: "android", system: "e2e", brand: "node", model: "gateway" }),
    getSystemInfoSync: () => ({
      platform: "android",
      system: "e2e",
      brand: "node",
      model: "gateway",
      SDKVersion: "3.17.6",
      bluetoothEnabled: true,
      locationEnabled: true,
    }),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),

    /* ---- 存储（内存）---- */
    getStorageSync: (k) => (mem.has(k) ? mem.get(k) : ""),
    setStorageSync: (k, v) => { mem.set(k, v); },
    removeStorageSync: (k) => { mem.delete(k); },

    /* ---- 网络：直接失败，让 usage logger 自行关闭 ---- */
    request: (opts) => opts?.fail?.({ errMsg: "request:fail e2e 不做网络" }),
    login: (opts) => opts?.fail?.({ errMsg: "login:fail e2e 不做登录" }),

    /* ---- 导航 / UI：空实现 ---- */
    navigateTo: (opts) => opts?.success?.({}),
    switchTab: (opts) => opts?.success?.({}),
    showToast: () => {},
    setClipboardData: (opts) => opts?.success?.({}),
    on: () => {},
  };

  return { wx, pump, setGateway };
}
