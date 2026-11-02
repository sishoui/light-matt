/**
 * 扫描过滤：全量扫描 + JS 层筛 lumen 设备。
 *
 * 背景（真机问题）：扫描原本带 `services: [SERVICE_UUID]`，指望系统级过滤。
 * 不少 Android 机型上这会**把真设备一起滤掉**——广播包里的 128-bit UUID
 * 被截断或拿不到时，系统判定「不匹配」，于是设备在广播却一条也不回。
 * 现象是「手机上搜不到设备」，而 PC 用 bleak 扫同一台完全正常。
 *
 * 现在改成全量扫描，过滤移到 `DeviceScanner.addDevices`。这里锁两件事：
 *  1. `startBluetoothDevicesDiscovery` **不再带 services 参数**；
 *  2. 过滤既认广播名也认 Service UUID（两个平台给的信息不同）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeviceScanner, isLumenDevice } from "../utils/ble/scan-controller";
import { SERVICE_UUID } from "../utils/protocol/constants";
import { BleTransport } from "../utils/ble/transport";
import { FrameLog } from "../utils/ble/log";

const DEVICE_ID = "DEV-1";

class ScanFakeWx {
  /** 每次 startBluetoothDevicesDiscovery 的入参（断言用）。 */
  readonly discoveryCalls: any[] = [];
  private readonly deviceFound: Array<(res: any) => void> = [];
  private readonly valueHandlers: Array<(res: any) => void> = [];
  private readonly connHandlers: Array<(res: any) => void> = [];
  private readonly adapterHandlers: Array<(res: any) => void> = [];

  onBluetoothDeviceFound(fn: (res: any) => void): void {
    this.deviceFound.push(fn);
  }
  onBLECharacteristicValueChange(fn: (res: any) => void): void {
    this.valueHandlers.push(fn);
  }
  onBLEConnectionStateChange(fn: (res: any) => void): void {
    this.connHandlers.push(fn);
  }
  onBluetoothAdapterStateChange(fn: (res: any) => void): void {
    this.adapterHandlers.push(fn);
  }
  offBluetoothDeviceFound(): void {}
  offBLECharacteristicValueChange(): void {}
  offBLEConnectionStateChange(): void {}
  offBluetoothAdapterStateChange(): void {}

  openBluetoothAdapter(opts: any): void {
    opts.success?.({});
  }
  /* 被裸引用传给 wxCall（不带 this），所以下面两个必须是箭头函数属性。 */
  startBluetoothDevicesDiscovery = (opts: any): void => {
    this.discoveryCalls.push(opts);
    opts.success?.({});
  };
  stopBluetoothDevicesDiscovery = (opts: any): void => {
    opts.success?.({});
  };
  closeBLEConnection(opts: any): void {
    opts.success?.({});
  }
  createBLEConnection(opts: any): void {
    opts.success?.({});
  }
  getBLEDeviceServices(opts: any): void {
    opts.success?.({ services: [] });
  }
  getBLEDeviceCharacteristics(opts: any): void {
    opts.success?.({ characteristics: [] });
  }
  notifyBLECharacteristicValueChange(opts: any): void {
    opts.success?.({});
  }
  setBLEMTU = (opts: any): void => {
    opts.fail?.({ errCode: 10008, errMsg: "mock" });
  };
  getBLEMTU = (opts: any): void => {
    opts.fail?.({ errCode: 10008, errMsg: "mock" });
  };
  readBLECharacteristicValue = (opts: any): void => {
    opts.fail?.({ errCode: 10008, errMsg: "mock" });
  };
  writeBLECharacteristicValue = (opts: any): void => {
    opts.success?.({});
  };

  /** 派发一批扫描结果给所有监听者。 */
  emitDevices(devices: any[]): void {
    for (const fn of this.deviceFound.slice()) {
      fn({ devices });
    }
  }
}

let fakeWx: ScanFakeWx;

beforeEach(() => {
  fakeWx = new ScanFakeWx();
  (globalThis as unknown as { wx: ScanFakeWx }).wx = fakeWx;
});

afterEach(() => {
  delete (globalThis as unknown as { wx?: ScanFakeWx }).wx;
});

/** 只收集扫描结果的假监听器表。 */
function makeScanner() {
  const emitted: any[][] = [];
  const hints: Array<string | null> = [];
  const scanner = new DeviceScanner(
    {
      emitDevices: (list: any[]) => emitted.push(list),
      emitScanHint: (hint: string | null) => hints.push(hint),
    } as any,
    10_000,
  );
  return { scanner, emitted, hints };
}

describe("isLumenDevice 判定", () => {
  it("认广播名前缀 Lumen-", () => {
    expect(isLumenDevice({ localName: "Lumen-5662" })).toBe(true);
    expect(isLumenDevice({ name: "Lumen-ABCD" })).toBe(true);
    expect(isLumenDevice({ localName: "lumen-5662" })).toBe(true);
  });

  it("认 Service UUID（大小写不敏感）", () => {
    expect(isLumenDevice({ advertisServiceUUIDs: [SERVICE_UUID] })).toBe(true);
    expect(
      isLumenDevice({ advertisServiceUUIDs: [SERVICE_UUID.toLowerCase()] }),
    ).toBe(true);
  });

  it("别的设备一律拒绝（这是全量扫描的必要代价）", () => {
    expect(isLumenDevice({ name: "eg_ac_hanging" })).toBe(false);
    expect(isLumenDevice({ name: "书桌" })).toBe(false);
    expect(
      isLumenDevice({ advertisServiceUUIDs: ["0000fdaa-0000-1000-8000-00805f9b34fb"] }),
    ).toBe(false);
    expect(isLumenDevice({ name: "" })).toBe(false);
    expect(isLumenDevice({})).toBe(false);
    expect(isLumenDevice(null)).toBe(false);
  });
});

describe("DeviceScanner 过滤", () => {
  it("混在一堆设备里的 lumen 会被留下，其余丢掉", () => {
    const { scanner, emitted } = makeScanner();
    scanner.addDevices([
      { deviceId: "A", localName: "Lumen-5662", RSSI: -58 },
      { deviceId: "B", name: "eg_ac_hanging", RSSI: -84 },
      { deviceId: "C", name: "书桌", RSSI: -70 },
      { deviceId: "D", advertisServiceUUIDs: [SERVICE_UUID], RSSI: -60 },
    ]);
    scanner.flushNow();

    const list = emitted.at(-1) ?? [];
    expect(list.map((d) => d.deviceId).sort()).toEqual(["A", "D"]);
    expect(scanner.size).toBe(2);
  });

  it("一条 lumen 都没有时列表为空（不把周边设备泄给界面）", () => {
    const { scanner, emitted } = makeScanner();
    const changed = scanner.addDevices([
      { deviceId: "X", name: "Mi Band", RSSI: -50 },
      { deviceId: "Y", name: "TV", RSSI: -40 },
    ]);
    scanner.flushNow();
    expect(changed).toBe(false);
    expect(scanner.size).toBe(0);
    expect(emitted.at(-1)).toEqual([]);
  });
});

describe("startScan 不再带系统级 services 过滤", () => {
  it("startBluetoothDevicesDiscovery 的入参没有 services 字段", async () => {
    const transport = new BleTransport({
      log: new FrameLog(),
      platform: "android",
      initSettleMs: 0,
      ackTimeoutMs: 200,
      stateReadTimeoutMs: 200,
    });

    await transport.startScan();

    expect(fakeWx.discoveryCalls).toHaveLength(1);
    const opts = fakeWx.discoveryCalls[0];
    /* 关键断言：带上 services 会在部分 Android 上把真设备滤掉。 */
    expect(opts.services).toBeUndefined();
    expect(opts.allowDuplicatesKey).toBe(true);
    expect(transport.linkState).toBe("scanning");
  });

  it("全量扫描 + 过滤：只有 lumen 出现在派发列表里", async () => {
    const transport = new BleTransport({
      log: new FrameLog(),
      platform: "android",
      initSettleMs: 0,
      ackTimeoutMs: 200,
      stateReadTimeoutMs: 200,
    });
    const seen: any[][] = [];
    transport.onDevices((list) => seen.push(list));

    await transport.startScan();
    fakeWx.emitDevices([
      { deviceId: "other", name: "别人的设备", RSSI: -30 },
      { deviceId: DEVICE_ID, localName: "Lumen-5662", RSSI: -58, advertisServiceUUIDs: [SERVICE_UUID] },
    ]);

    /* 300ms 合并窗口。 */
    await new Promise((r) => setTimeout(r, 400));
    const list = seen.at(-1) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].deviceId).toBe(DEVICE_ID);
    expect(list[0].name).toBe("Lumen-5662");
  });
});
