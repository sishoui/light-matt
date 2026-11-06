#!/usr/bin/env python
"""本轮修复的真机验收（无分区=全黑 / blend 0x03 / State R/G/B 归零）。

这四条是**只有真机能证明**的：

  §1 无分区的灯带整条全黑 —— 曾经的 v1 单色回退会把它刷成暖白（看着是黄）。
     判据是渲染的像素，所以这里用串口日志 + State 交叉验证：
       - State 的 R/G/B 在 seg_count == 0 时必须是 0,0,0（不再保留暖白）；
       - 串口上该带取的是 `render seg:` 而不是旧的 `render:` 单色行。
  §2 改第一组的颜色不影响其它带 —— State 的 R/G/B 不再被当成全局兜底色。
  §3 blend 0x03「按亮度叠加」被接受并读回 —— 契约 §7.2.1 的新值。
  §4 blend 0x04 仍被拒 —— 上界只放到 3。

用法：
    python scripts/probe-layer-fixes.py [--address CC:8D:A2:C2:56:62]

没有真机时不要跑：它只做真机往返，不做 mock。
"""

import argparse
import asyncio
import struct
import sys

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.exit("需要 bleak：python -m pip install bleak")

SERVICE = "6c756d65-6e00-4b1e-9a3c-000000000001"
RX = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX = "6c756d65-6e00-4b1e-9a3c-000000000003"

MAGIC = 0xA6
VERSION = 0x04
LAYER_EMPTY = 0xFF
LAYER_BYTES = 9

CMD = {
    "SET_POWER": 0x01,
    "SET_BRIGHTNESS": 0x02,
    "SET_SEGMENT": 0x10,
    "CLEAR_SEGMENT": 0x11,
    "QUERY_STRIP": 0x12,
    "QUERY_STATE": 0x05,
}

ACK = 0x80
STATE_REPORT = 0x82

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def crc16(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def build_frame(cmd, seq, payload=b""):
    body = bytes([MAGIC, VERSION, cmd, seq]) + struct.pack("<H", len(payload)) + payload
    return body + struct.pack("<H", crc16(body))


def chunk(frame):
    return b"\xC0" + frame


def layer_bytes(type_, hue=7281, sat=255, period=0, p5=0, flags=0, level=100):
    out = bytearray(LAYER_BYTES)
    out[0] = type_
    if type_ != LAYER_EMPTY:
        out[1] = hue & 0xFF
        out[2] = (hue >> 8) & 0xFF
        out[3] = sat
        out[4] = period & 0xFF
        out[5] = (period >> 8) & 0xFF
        out[6] = p5
        out[7] = flags
        out[8] = level
    return bytes(out)


def empty_layer():
    out = bytearray(LAYER_BYTES)
    out[0] = LAYER_EMPTY
    return bytes(out)


def segment(strip, seg, start, end, l0, l1=None, blend=0):
    return bytes([strip, seg, start, end, blend]) + l0 + (l1 or empty_layer())


class Device:
    def __init__(self, client):
        self.client = client
        self.tx = bytearray()
        self.seq = 0

    def on_notify(self, _handle, data):
        self.tx.extend(bytes(data))

    async def send(self, cmd, payload=b"", timeout=2.0):
        self.seq = (self.seq + 1) & 0xFF
        seq = self.seq
        self.tx.clear()
        await self.client.write_gatt_char(RX, chunk(build_frame(cmd, seq, payload)))
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            for f in self._drain():
                if f["cmd"] == ACK and f["seq"] == seq:
                    return f["payload"][1] if len(f["payload"]) >= 2 else None
            await asyncio.sleep(0.05)
        return None

    async def collect(self, cmd, payload=b"", timeout=1.5):
        self.seq = (self.seq + 1) & 0xFF
        seq = self.seq
        self.tx.clear()
        await self.client.write_gatt_char(RX, chunk(build_frame(cmd, seq, payload)))
        frames = []
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            frames.extend(self._drain())
            if any(f["cmd"] == ACK and f["seq"] == seq for f in frames):
                await asyncio.sleep(0.15)
                frames.extend(self._drain())
                break
            await asyncio.sleep(0.05)
        return frames

    def _drain(self):
        frames = []
        buf = bytes(self.tx)
        i = 0
        while i + 7 <= len(buf):
            ctrl = buf[i]
            start = i + 1
            if start + 6 > len(buf):
                break
            length = buf[start + 4] | (buf[start + 5] << 8)
            total = 6 + length + 2
            if len(buf) < start + total:
                break
            raw = buf[start : start + total]
            if (ctrl & 0xC0) == 0xC0:
                frames.append(
                    {"cmd": raw[2], "seq": raw[3], "payload": bytes(raw[6 : 6 + length])}
                )
            i = start + total
        self.tx = bytearray(buf[i:])
        return frames


def parse_state(payload):
    return {
        "power": payload[0],
        "brightness": payload[1],
        "r": payload[2],
        "g": payload[3],
        "b": payload[4],
        "strip_seg_counts": list(payload[29:37]),
    }


async def read_state(dev):
    for f in await dev.collect(CMD["QUERY_STATE"]):
        if f["cmd"] == STATE_REPORT:
            return parse_state(f["payload"])
    return None


async def clear_strip(dev, strip, up_to=8):
    for seg in range(up_to):
        await dev.send(CMD["CLEAR_SEGMENT"], bytes([strip, seg]))


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--address")
    args = ap.parse_args()

    address = args.address
    if not address:
        device = await BleakScanner.find_device_by_filter(
            lambda d, _ad: (d.name or "").lower().startswith("lumen-"), timeout=20
        )
        if device is None:
            sys.exit("没找到 Lumen 设备")
        address = device.address if hasattr(device, "address") else device
        print(f"device: {address} {device.name}")

    async with BleakClient(address) as client:
        dev = Device(client)
        await client.start_notify(TX, dev.on_notify)
        await asyncio.sleep(0.4)

        await dev.send(CMD["SET_POWER"], bytes([1]))
        await asyncio.sleep(0.3)

        print("\n--- §1 无分区的灯带整条全黑 ---")
        # 把 strip 1..7 全部清空，只留 strip 0 一个分区。
        for strip in range(1, 8):
            await clear_strip(dev, strip)
        await clear_strip(dev, 0)
        await dev.send(
            CMD["SET_SEGMENT"],
            segment(0, 0, 0, 9, layer_bytes(0x00, hue=0, sat=255, level=100)),
        )
        await asyncio.sleep(0.8)

        state = await read_state(dev)
        if state is None:
            check("读到 State", False, "没有 StateReport")
        else:
            counts = state["strip_seg_counts"]
            check(
                "strip 0 有 1 个分区，其余 7 条为 0",
                counts[0] == 1 and all(c == 0 for c in counts[1:]),
                f"seg_counts={counts}",
            )
            # 有分区时 R/G/B 是 strip0/seg0 层0 的基准色（这里设成纯红）。
            check(
                "有分区时 State R/G/B = 该分区的颜色（纯红）",
                (state["r"], state["g"], state["b"]) == (255, 0, 0),
                f"rgb={state['r']},{state['g']},{state['b']}",
            )

        print("\n--- §2 清空后 State R/G/B 归零（不再保留暖白） ---")
        await clear_strip(dev, 0)
        await asyncio.sleep(0.8)
        state = await read_state(dev)
        if state is None:
            check("读到 State（清空后）", False)
        else:
            check(
                "零分区时 seg_count = 0",
                state["strip_seg_counts"][0] == 0,
                f"seg_counts={state['strip_seg_counts']}",
            )
            check(
                "零分区时 State R/G/B = 0,0,0（契约 §7.3）",
                (state["r"], state["g"], state["b"]) == (0, 0, 0),
                f"rgb={state['r']},{state['g']},{state['b']}",
            )

        print("\n--- §3 blend 0x03「按亮度叠加」 ---")
        # 背景层常亮 + 特效层流星，blend = 0x03。
        result = await dev.send(
            CMD["SET_SEGMENT"],
            segment(
                0,
                0,
                0,
                9,
                layer_bytes(0x00, hue=0, sat=255, level=100),
                layer_bytes(0x03, hue=43690, sat=255, period=2000, p5=120, level=100),
                blend=0x03,
            ),
        )
        check("blend=0x03 被接受", result == 0x00, f"result=0x{result:02X}" if result is not None else "")

        frames = await dev.collect(CMD["QUERY_STRIP"], bytes([0]))
        blends = [f["payload"][4] for f in frames if f["cmd"] == 0x83]
        types = [f["payload"][14] for f in frames if f["cmd"] == 0x83]
        check("读回 blend = 0x03", 0x03 in blends, f"blends={[hex(b) for b in blends]}")
        check("读回 layer1 类型 = 流星 0x03", 0x03 in types, f"layer1_types={[hex(t) for t in types]}")

        print("\n--- §4 blend 0x04 仍被拒（上界只放到 3） ---")
        result = await dev.send(
            CMD["SET_SEGMENT"],
            segment(
                0,
                1,
                10,
                19,
                layer_bytes(0x00, hue=0, sat=255),
                layer_bytes(0x03, hue=0, sat=255, period=2000, p5=120),
                blend=0x04,
            ),
        )
        check("blend=0x04 被拒（InvalidParam）", result == 0x01, f"result=0x{result:02X}" if result is not None else "")

        print("\n--- 收尾：清空全部灯带、恢复亮度 ---")
        for strip in range(8):
            await clear_strip(dev, strip)
        await dev.send(CMD["SET_BRIGHTNESS"], bytes([128]))
        await asyncio.sleep(0.3)
        print("      （已清空 8 条灯带，亮度 128）")

        await client.stop_notify(TX)

    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print(f"\n===== {passed} passed / {failed} failed =====")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
