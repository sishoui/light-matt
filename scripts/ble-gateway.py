#!/usr/bin/env python
"""BLE 网关：把 PC 的真实蓝牙暴露成一行行 JSON，供 Node 侧的小程序代码调用。

**为什么需要这个**：微信开发者工具的蓝牙是桩实现（`createBLEConnection` 直接
回「开发者工具暂时不支持此 API 调试」），而 `noble` 在 Node 24 上编译不过。
所以用 Python `bleak`（已验证能连上 ESP32-C3）当网关，Node 侧把 `wx.*` 换成
「调这个进程」，于是**跑的是真实的小程序传输层与会话层代码**，不是重写的替身。

协议：stdin 一行一条 JSON 请求，stdout 一行一条 JSON 响应或事件。

  请求  {"id": 1, "op": "scan_start", "args": {...}}
  响应  {"id": 1, "ok": true, "value": ...}  /  {"id": 1, "ok": false, "error": "..."}
  事件  {"event": "device_found", "value": {...}}
        {"event": "notify", "value": {"char": "...", "data": [..字节..]}}
        {"event": "disconnect", "value": {...}}

字节一律用整数数组（JSON 没有 bytes）。

用法（一般由 Node 测试拉起，不手动跑）：
    python scripts/ble-gateway.py
"""

import asyncio
import json
import sys

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.exit("需要 bleak：python -m pip install bleak")

SERVICE = "6c756d65-6e00-4b1e-9a3c-000000000001"
RX = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX = "6c756d65-6e00-4b1e-9a3c-000000000003"
STATE = "6c756d65-6e00-4b1e-9a3c-000000000004"


def emit(obj):
    """写一行 JSON 到 stdout 并立即 flush（Node 侧按行读）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    # 诊断信息走 stderr，绝不污染 stdout 的 JSON 流。
    sys.stderr.write(f"[gw] {msg}\n")
    sys.stderr.flush()


class Gateway:
    def __init__(self):
        self.client = None
        self.scanner = None
        self.scanning = False
        self.found = {}
        self.notify_started = set()
        self.mtu = 23

    # ---------------- 扫描 ----------------

    async def scan_start(self, args):
        if self.scanning:
            return {"already": True}

        def on_detect(dev, adv):
            # bleak 的 callback 可能是普通函数：不 await，直接派发。
            name = dev.name or (adv.local_name if adv else None) or ""
            log(f"detect {dev.address} name={name!r}")
            if not name and not adv:
                return
            key = dev.address
            prev = self.found.get(key)
            # 同一个 address 后续才拿到名字（广播包/扫描响应包分开到达），
            # 所以「没有名字」不能当成「已上报过」——否则永远等不到带名的那条。
            if prev is not None and prev == name:
                return
            self.found[key] = name
            emit({
                "event": "device_found",
                "value": {
                    "deviceId": dev.address,
                    "name": name,
                    "localName": (adv.local_name if adv else None) or name,
                    "RSSI": getattr(adv, "rssi", None) if adv else None,
                },
            })

        self.scanner = BleakScanner(detection_callback=on_detect)
        await self.scanner.start()
        self.scanning = True
        return {"started": True}

    async def scan_stop(self, _args):
        if self.scanner is not None and self.scanning:
            await self.scanner.stop()
            self.scanning = False
        return {"stopped": True}

    async def scan_get(self, _args):
        return [
            {"deviceId": addr, "name": name, "localName": name}
            for addr, name in self.found.items()
        ]

    # ---------------- 连接 ----------------

    async def connect(self, args):
        device_id = args["deviceId"]
        if self.client is not None and self.client.is_connected:
            try:
                await self.client.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self.client = BleakClient(
            device_id,
            disconnected_callback=lambda _c: emit({"event": "disconnect", "value": {"deviceId": device_id}}),
        )
        await self.client.connect()
        self.mtu = getattr(self.client, "mtu_size", 23) or 23
        return {"connected": True, "mtu": self.mtu}

    async def disconnect(self, _args):
        if self.client is not None:
            try:
                await self.client.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self.client = None
        self.notify_started.clear()
        return {"disconnected": True}

    async def device_services(self, _args):
        services = []
        for svc in self.client.services:
            services.append({"uuid": svc.uuid.lower(), "isPrimary": True})
        return services

    async def device_characteristics(self, args):
        service_id = args["serviceId"].lower()
        out = []
        for svc in self.client.services:
            if svc.uuid.lower() != service_id:
                continue
            for ch in svc.characteristics:
                # 小程序的 getBLEDeviceCharacteristics 返回的是**对象**不是数组：
                #   properties: { read, write, notify, indicate, writeNoResponse }
                # 顺序无关，只看字段是否为 true。transport 直接判
                # `rx.properties?.writeNoResponse !== true`，所以这里必须是对象。
                p = ch.properties
                properties = {
                    "read": "read" in p,
                    "write": "write" in p,
                    "notify": "notify" in p,
                    "indicate": "indicate" in p,
                    "writeNoResponse": "write-without-response" in p,
                }
                out.append({"uuid": ch.uuid.lower(), "properties": properties})
        return out

    # ---------------- 收发 ----------------

    async def write(self, args):
        data = bytes(args["data"])
        uuid = args["characteristicId"].lower()
        # wx 的写接口没有 "without response" 开关：这里按特性支持与否自动选。
        resp = args.get("response")
        if resp is None:
            resp = False
        await self.client.write_gatt_char(uuid, data, response=bool(resp))
        return {"written": len(data)}

    async def read(self, args):
        uuid = args["characteristicId"].lower()
        data = await self.client.read_gatt_char(uuid)
        return {"data": list(bytes(data))}

    async def notify_start(self, args):
        uuid = args["characteristicId"].lower()

        def cb(_ch, data):
            emit({"event": "notify", "value": {"char": uuid, "data": list(bytes(data))}})

        await self.client.start_notify(uuid, cb)
        self.notify_started.add(uuid)
        return {"started": True}

    async def notify_stop(self, args):
        uuid = args["characteristicId"].lower()
        if uuid in self.notify_started:
            await self.client.stop_notify(uuid)
            self.notify_started.discard(uuid)
        return {"stopped": True}

    async def get_mtu(self, _args):
        return {"mtu": self.mtu}

    async def set_mtu(self, args):
        # bleak 不能主动协商 MTU（由系统决定），如实报告当前值。
        self.mtu = getattr(self.client, "mtu_size", self.mtu) or self.mtu
        return {"mtu": self.mtu, "note": "bleak 不主动协商，返回系统协商值"}

    # ---------------- 派发 ----------------

    async def handle(self, req):
        op = req.get("op")
        args = req.get("args") or {}
        handler = getattr(self, op, None)
        if handler is None or not callable(handler):
            raise ValueError(f"未知 op: {op}")
        value = await handler(args)
        emit({"id": req["id"], "ok": True, "value": value})

    async def run(self):
        """
        读 stdin 必须放在**线程**里：Windows 的 ProactorEventLoop 不支持
        `connect_read_pipe` 对 stdin 的用法，而且 `sys.stdin.readline()` 是阻塞的，
        放进事件循环会把扫描/通知回调一起卡死（真机测过：scan_start 永远不回）。
        线程读到一行就丢进 asyncio 队列，由事件循环消费。
        """
        import threading

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def pump():
            for line in sys.stdin:
                loop.call_soon_threadsafe(queue.put_nowait, line)

        threading.Thread(target=pump, daemon=True).start()

        while True:
            line = await queue.get()
            text = line.strip()
            if not text:
                continue
            try:
                req = json.loads(text)
            except json.JSONDecodeError as e:
                log(f"坏请求: {e}")
                continue
            # 每条请求单独起任务：扫描/通知回调不能被慢命令阻塞。
            asyncio.create_task(self._safe_handle(req))

    async def _safe_handle(self, req):
        try:
            await self.handle(req)
        except Exception as e:  # noqa: BLE001
            emit({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"})


async def main():
    gw = Gateway()
    emit({"event": "ready", "value": {"service": SERVICE, "rx": RX, "tx": TX, "state": STATE}})
    await gw.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
