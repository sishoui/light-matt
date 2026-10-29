const SERVICE_UUID = "6C756D65-6E00-4B1E-9A3C-000000000001";
const RX_UUID = "6C756D65-6E00-4B1E-9A3C-000000000002";
const TX_UUID = "6C756D65-6E00-4B1E-9A3C-000000000003";
const STATE_UUID = "6C756D65-6E00-4B1E-9A3C-000000000004";

interface DeviceItem {
  deviceId: string;
  name: string;
  RSSI: number;
}

function wxCall<T>(api: (options: any) => void, options: any = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    api({
      ...options,
      success: (res: T) => resolve(res),
      fail: (err: any) => reject(err),
    });
  });
}

function errText(err: any): string {
  if (err == null) return "unknown";
  const code = err.errCode ?? err.errno;
  const msg = err.errMsg ?? err.message ?? String(err);
  return code === undefined ? msg : `errCode=${code} ${msg}`;
}

function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value))
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function makeTestFrame(seq: number): ArrayBuffer {
  const buf = new Uint8Array(20);
  buf[0] = 0xa5;
  buf[1] = 0x01;
  buf[2] = 0x01;
  buf[3] = seq & 0xff;
  buf[4] = 0x00;
  for (let i = 5; i < buf.length; i += 1) {
    buf[i] = (seq + i) & 0xff;
  }
  return buf.buffer;
}

Page({
  data: {
    status: "未初始化",
    platform: "",
    devices: [] as DeviceItem[],
    logs: [] as string[],
    connected: false,
    cached: false,
  },

  deviceId: "",
  serviceId: SERVICE_UUID,
  rxId: RX_UUID,
  txId: TX_UUID,
  stateId: STATE_UUID,
  scanning: false,
  writing: false,
  nextSeq: 0,

  onLoad() {
    const info = wx.getSystemInfoSync();
    this.setData({ platform: info.platform });
    this.log(`平台 ${info.platform} / ${info.system} / 基础库 ${info.SDKVersion}`);

    wx.onBluetoothDeviceFound((res) => {
      const found = res.devices ?? [];
      if (!found.length) return;
      const map = new Map(this.data.devices.map((d) => [d.deviceId, d]));
      for (const dev of found) {
        if (!dev.deviceId) continue;
        map.set(dev.deviceId, {
          deviceId: dev.deviceId,
          name: dev.name || dev.localName || "(无名)",
          RSSI: dev.RSSI ?? 0,
        });
      }
      const devices = Array.from(map.values())
        .sort((a, b) => b.RSSI - a.RSSI)
        .slice(0, 20);
      this.setData({ devices });
    });

    wx.onBLECharacteristicValueChange((res) => {
      const id = res.characteristicId.toUpperCase();
      const hex = toHex(res.value);
      if (id === this.txId.toUpperCase()) {
        this.log(`TX <- ${hex}`);
      } else if (id === this.stateId.toUpperCase()) {
        this.log(`State <- ${hex}`);
      } else {
        this.log(`${id} <- ${hex}`);
      }
    });

    wx.onBLEConnectionStateChange((res) => {
      if (res.deviceId !== this.deviceId) return;
      this.setData({ connected: res.connected });
      this.log(res.connected ? "连接建立" : "连接断开");
      if (!res.connected) this.setStatus("未连接");
    });

    wx.onBluetoothAdapterStateChange((res) => {
      this.log(`适配器 available=${res.available} discovering=${res.discovering}`);
      if (!res.available) {
        this.setData({ connected: false });
        this.setStatus("蓝牙已关闭");
      } else if (!this.scanning && !this.data.connected) {
        this.setStatus("适配器就绪");
      }
    });
  },

  onUnload() {
    if (this.scanning) {
      wx.stopBluetoothDevicesDiscovery();
    }
    if (this.deviceId) {
      wx.closeBLEConnection({ deviceId: this.deviceId });
    }
  },

  log(line: string) {
    const now = new Date();
    const stamp = `${now.getHours().toString().padStart(2, "0")}:${now
      .getMinutes()
      .toString()
      .padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}.${now
      .getMilliseconds()
      .toString()
      .padStart(3, "0")}`;
    const logs = [`${stamp} ${line}`, ...this.data.logs].slice(0, 200);
    this.setData({ logs });
    console.log(`[probe] ${line}`);
  },

  setStatus(status: string) {
    this.setData({ status });
  },

  async openAdapter() {
    try {
      await wxCall(wx.openBluetoothAdapter);
      this.log("适配器已打开");
      this.setStatus("适配器就绪");
    } catch (err) {
      const code = (err as any).errCode;
      if (code === 10001) {
        this.log("蓝牙未开（10001）；打开系统蓝牙后会自动继续");
        this.setStatus("请打开蓝牙");
      } else {
        this.log(`打开适配器失败：${errText(err)}`);
        this.setStatus("适配器失败");
      }
    }
  },

  async startScan() {
    if (this.scanning) {
      this.log("已在扫描");
      return;
    }
    try {
      await this.openAdapter();
      this.setData({ devices: [] });
      this.scanning = true;
      await wxCall(wx.startBluetoothDevicesDiscovery, {
        services: [SERVICE_UUID],
        allowDuplicatesKey: true,
        interval: 0,
      });
      this.log(`开始扫描 service=${SERVICE_UUID}`);
      this.setStatus("扫描中…");
      setTimeout(() => {
        if (this.scanning && this.data.devices.length === 0) {
          this.log("10 秒无结果：Android 6.0+ 检查定位权限与定位开关；iOS 检查蓝牙授权");
        }
      }, 10000);
    } catch (err) {
      this.scanning = false;
      this.log(`扫描失败：${errText(err)}`);
      this.setStatus("扫描失败");
    }
  },

  async stopScan() {
    this.scanning = false;
    try {
      await wxCall(wx.stopBluetoothDevicesDiscovery);
    } catch (err) {
      this.log(`停止扫描：${errText(err)}`);
    }
    this.setStatus(this.data.connected ? "已连接" : "已停止扫描");
  },

  async connect(e: WechatMiniprogram.TouchEvent) {
    const deviceId = String(e.currentTarget.dataset.deviceId ?? "");
    if (!deviceId) return;
    await this.stopScan();
    this.deviceId = deviceId;
    this.setData({ cached: true });
    this.setStatus("连接中…");
    this.log(`连接 ${deviceId}`);
    try {
      await wxCall(wx.createBLEConnection, { deviceId, timeout: 10000 });
      this.setData({ connected: true });
      await this.initLink();
    } catch (err) {
      this.log(`连接失败：${errText(err)}`);
      this.setStatus("连接失败");
    }
  },

  async initLink() {
    const deviceId = this.deviceId;
    const platform = this.data.platform;

    try {
      if (platform === "android") {
        try {
          const res: any = await wxCall(wx.setBLEMTU, { deviceId, mtu: 185 });
          this.log(`MTU 协商结果 ${res.mtu}`);
        } catch (err) {
          this.log(`setBLEMTU 失败：${errText(err)}`);
        }
      } else {
        this.log("iOS/其他平台：跳过 setBLEMTU");
      }

      const services: any = await wxCall(wx.getBLEDeviceServices, { deviceId });
      this.log(`services: ${services.services.map((s: any) => s.uuid).join(", ")}`);
      const service = services.services.find(
        (s: any) => s.uuid.toUpperCase() === SERVICE_UUID,
      );
      if (!service) throw new Error(`找不到 service ${SERVICE_UUID}`);
      const serviceId = service.uuid;
      this.serviceId = serviceId;

      const chars: any = await wxCall(wx.getBLEDeviceCharacteristics, {
        deviceId,
        serviceId,
      });
      for (const c of chars.characteristics) {
        this.log(
          `char ${c.uuid} write=${c.properties.write} writeNoResponse=${c.properties.writeNoResponse} notify=${c.properties.notify} read=${c.properties.read}`,
        );
      }
      const rx = chars.characteristics.find(
        (c: any) => c.uuid.toUpperCase() === RX_UUID,
      );
      const tx = chars.characteristics.find(
        (c: any) => c.uuid.toUpperCase() === TX_UUID,
      );
      const state = chars.characteristics.find(
        (c: any) => c.uuid.toUpperCase() === STATE_UUID,
      );
      if (!rx) throw new Error("找不到 RX");
      if (!tx) throw new Error("找不到 TX");
      if (!state) throw new Error("找不到 State");
      this.rxId = rx.uuid;
      this.txId = tx.uuid;
      this.stateId = state.uuid;
      if (!rx.properties.writeNoResponse) {
        this.log("警告：RX 不支持 writeNoResponse");
      }

      await wxCall(wx.notifyBLECharacteristicValueChange, {
        state: true,
        deviceId,
        serviceId,
        characteristicId: tx.uuid,
        type: "notification",
      });
      this.log("notify 已订阅");

      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 500);
      });
      await wxCall(wx.readBLECharacteristicValue, {
        deviceId,
        serviceId,
        characteristicId: state.uuid,
      });
      this.log("已读 State");
      this.setStatus("已连接 / 就绪");
    } catch (err) {
      this.log(`初始化失败：${errText(err)}`);
      this.setStatus("初始化失败");
    }
  },

  async send() {
    if (!this.data.connected) return;
    if (this.writing) {
      this.log("上一次写入未完成，跳过");
      return;
    }
    this.writing = true;
    this.nextSeq = (this.nextSeq + 1) & 0xff;
    try {
      const frame = makeTestFrame(this.nextSeq);
      await wxCall(wx.writeBLECharacteristicValue, {
        deviceId: this.deviceId,
        serviceId: this.serviceId,
        characteristicId: this.rxId,
        value: frame,
        writeType: "writeNoResponse",
      });
      this.log(`RX -> ${toHex(frame)}`);
    } catch (err) {
      this.log(`写入失败：${errText(err)}`);
    } finally {
      this.writing = false;
    }
  },

  async burst(interval: number) {
    if (!this.data.connected) return;
    const count = 20;
    this.log(`连发 ${count} 帧 @ ${interval}ms`);
    for (let i = 0; i < count; i += 1) {
      await this.send();
      if (i < count - 1) {
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), interval);
        });
      }
    }
    this.log("连发结束");
  },

  burst20() {
    return this.burst(20);
  },

  burst50() {
    return this.burst(50);
  },

  burst100() {
    return this.burst(100);
  },

  async disconnect() {
    if (!this.deviceId) return;
    try {
      await wxCall(wx.closeBLEConnection, { deviceId: this.deviceId });
    } catch (err) {
      this.log(`断开失败：${errText(err)}`);
    }
    this.setData({ connected: false });
    this.setStatus("已断开");
  },

  async reconnect() {
    if (!this.deviceId) return;
    this.setStatus("重连中…");
    try {
      await wxCall(wx.createBLEConnection, {
        deviceId: this.deviceId,
        timeout: 10000,
      });
      this.setData({ connected: true });
      await this.initLink();
    } catch (err) {
      this.log(`重连失败：${errText(err)}`);
      this.setStatus("重连失败");
    }
  },

  async readState() {
    if (!this.data.connected) return;
    try {
      await wxCall(wx.readBLECharacteristicValue, {
        deviceId: this.deviceId,
        serviceId: this.serviceId,
        characteristicId: this.stateId,
      });
    } catch (err) {
      this.log(`读 State 失败：${errText(err)}`);
    }
  },

  clearLogs() {
    this.setData({ logs: [] });
  },

  copyLogs() {
    wx.setClipboardData({
      data: this.data.logs.join("\n"),
      success: () => this.log("日志已复制"),
    });
  },
});
