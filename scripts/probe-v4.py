#!/usr/bin/env python
"""协议 v4 真机验收（#71 / #72–#83 的协议层）。

覆盖「只有真机能证明」的几件事：

  §1 信封：v3 帧回 0x07（断崖），v4 帧正常；被拒后设备继续服务
  §2 灯珠上限 100：SetLedCount(100) 成功并读回 100
  §3 爆闪 0x04 / 心跳 0x05 / 熄灭 0x06：接受、读回类型与参数
  §4 新灯效的边界：爆闪 <100ms 被拒、心跳 <500ms 被拒
  §5 逐光区亮度：同一带两个 level（100 / 25）分别读回
  §6 ClearScript 0x1E：提交一套方案后清空，摘要回 0 步
  §7 #98：流光密度（1/4 个头）、实色拖尾、随机闪烁 0x07 的接受与越界
  §8 收尾：把灯珠数与光区恢复成默认（不把测试现场留给用户）

用法：
    python scripts/probe-v4.py [--address CC:8D:A2:C2:56:62]

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
SEGMENT_BYTES = 23

CMD = {
    "SET_POWER": 0x01,
    "SET_BRIGHTNESS": 0x02,
    "SET_LED_COUNT": 0x06,
    "SET_SEGMENT": 0x10,
    "CLEAR_SEGMENT": 0x11,
    "QUERY_STRIP": 0x12,
    "QUERY_STATE": 0x05,
    "SCRIPT_BEGIN": 0x14,
    "SCRIPT_STAGE": 0x15,
    "SCRIPT_SEGMENT": 0x16,
    "SCRIPT_COMMIT": 0x17,
    "SCRIPT_ABORT": 0x18,
    "ACTIVATE_SCRIPT": 0x19,
    "QUERY_SCRIPT": 0x1A,
    "CLEAR_SCRIPT": 0x1E,
    "SET_PLAYBACK": 0x13,
}

RESULT = {
    0x00: "OK",
    0x01: "InvalidParam",
    0x02: "UnknownCommand",
    0x03: "BadChecksum",
    0x04: "BadLength",
    0x05: "Busy",
    0x06: "StorageFailed",
    0x07: "UnsupportedVersion",
    0x08: "BadMagic",
    0x09: "InternalError",
    0x0A: "ScriptTooLarge",
}

ACK = 0x80
STATE_REPORT = 0x82
SEGMENT_REPORT = 0x83
SCRIPT_SUMMARY = 0x85

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


def build_frame(cmd, seq, payload=b"", version=VERSION):
    body = bytes([MAGIC, version, cmd, seq]) + struct.pack("<H", len(payload)) + payload
    return body + struct.pack("<H", crc16(body))


def chunk(frame):
    """单分片：ctrl = FIRST|LAST。"""
    return b"\xC0" + frame


def layer(type_, hue=7281, sat=255, period=0, p5=0, flags=0, level=100):
    """9 字节层：type + param(7) + level。"""
    return bytes([type_]) + struct.pack("<HBBBHB", hue, sat, period, p5, flags, 0)[:7] + bytes([level])


def layer_bytes(type_, hue=7281, sat=255, period=0, p5=0, flags=0, level=100):
    """显式拼 9 字节，避免 struct 填充陷阱。"""
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
    """空层：type = 0xFF，其余 8 字节全 0（不是全零——全零是「静态黑」）。"""
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

    async def send(self, cmd, payload=b"", version=VERSION, timeout=2.0):
        """发一帧，等到同 seq 的 ACK；返回 (result_code, acks)。"""
        self.seq = (self.seq + 1) & 0xFF
        seq = self.seq
        self.tx.clear()
        await self.client.write_gatt_char(RX, chunk(build_frame(cmd, seq, payload, version)))
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            frames = self._drain()
            for f in frames:
                if f["cmd"] == ACK and f["seq"] == seq:
                    return f["payload"][1] if len(f["payload"]) >= 2 else None, frames
            await asyncio.sleep(0.05)
        return None, self._drain()

    async def send_and_collect(self, cmd, payload=b"", timeout=2.5):
        """发一帧，返回 (result_code, 所有收到的逻辑帧)。"""
        self.seq = (self.seq + 1) & 0xFF
        seq = self.seq
        self.tx.clear()
        await self.client.write_gatt_char(RX, chunk(build_frame(cmd, seq, payload)))
        await asyncio.sleep(0.05)
        deadline = asyncio.get_event_loop().time() + timeout
        result = None
        frames = []
        while asyncio.get_event_loop().time() < deadline:
            frames.extend(self._drain())
            for f in frames:
                if f["cmd"] == ACK and f["seq"] == seq:
                    result = f["payload"][1] if len(f["payload"]) >= 2 else None
            await asyncio.sleep(0.05)
        return result, frames

    def _drain(self):
        """把 TX 缓冲里的分片拼回逻辑帧。

        本设备 MTU 拉满后单帧（最大 StateReport 45 字节）永远装得进一个分片，
        所以每个分片都是 `ctrl(1) + 逻辑帧`，按 header 里的 length 就能逐帧切开。
        残余（半帧）留在缓冲里等下一次通知。多帧响应（QueryStrip 的多个
        SegmentReport）也因此不会只解析出第一条。
        """
        frames = []
        buf = bytes(self.tx)
        i = 0
        while i + 7 <= len(buf):  # ctrl + header(6) + 至少 1 字节 crc 起始
            ctrl = buf[i]
            start = i + 1
            if start + 6 > len(buf):
                break
            length = buf[start + 4] | (buf[start + 5] << 8)
            total = 6 + length + 2
            if len(buf) < start + total:
                break
            raw = buf[start : start + total]
            # 分片标志：FIRST|LAST 才算完整帧；本探针只处理单分片。
            if (ctrl & 0xC0) == 0xC0:
                frames.append(
                    {
                        "cmd": raw[2],
                        "seq": raw[3],
                        "payload": bytes(raw[6 : 6 + length]),
                    }
                )
            i = start + total
        self.tx = bytearray(buf[i:])
        return frames


def parse_state(payload):
    return {
        "power": payload[0],
        "brightness": payload[1],
        "max_brightness": payload[5],
        "strip_count": payload[6],
        "script_id": payload[7],
        "stage_index": payload[8],
        "playback": payload[9],
        "flags": payload[10],
        "strip_power_mask": payload[11],
        "strip_counts": [payload[13 + i * 2] | (payload[14 + i * 2] << 8) for i in range(8)],
        "strip_seg_counts": list(payload[29:37]),
    }


def parse_segment_report(payload):
    """SegmentReport 与 SetSegment 同构（23 字节）。"""
    return {
        "strip": payload[0],
        "seg": payload[1],
        "start": payload[2],
        "end": payload[3],
        "blend": payload[4],
        "layer0": {
            "type": payload[5],
            "level": payload[5 + 8],
            "period": payload[5 + 4] | (payload[5 + 5] << 8),
            "p5": payload[5 + 6],
            "flags": payload[5 + 7],
        },
        "layer1": {
            "type": payload[14],
            "level": payload[14 + 8],
            "flags": payload[14 + 7],
        },
    }


async def find_device(address):
    if address:
        return address
    device = await BleakScanner.find_device_by_filter(
        lambda d, _ad: (d.name or "").lower().startswith("lumen-"), timeout=20
    )
    if device is None:
        return None
    print(f"device: {device.address} {device.name}")
    return device.address if hasattr(device, "address") else device


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--address", default="")
    parser.add_argument("--skip-restore", action="store_true")
    args = parser.parse_args()

    address = await find_device(args.address)
    if address is None:
        print("RESULT: no-device (设备没在广播：确认没有别的客户端连着它)")
        return 2

    async with BleakClient(address, timeout=25) as client:
        dev = Device(client)
        await client.start_notify(TX, dev.on_notify)
        await asyncio.sleep(0.8)

        # ---------- §1 信封 ----------
        code, _ = await dev.send(CMD["QUERY_STATE"], version=0x03)
        check("v3 帧被拒（0x07 UnsupportedVersion）", code == 0x07, f"result=0x{code:02X}" if code is not None else "无 ACK")

        code, frames = await dev.send_and_collect(CMD["QUERY_STATE"])
        state_frames = [f for f in frames if f["cmd"] == STATE_REPORT]
        check("被拒后设备继续服务 v4 帧", code == 0x00 and len(state_frames) == 1, f"result=0x{code:02X}" if code is not None else "无 ACK")
        state = parse_state(state_frames[0]["payload"]) if state_frames else None
        if state:
            print(f"      State: brightness={state['brightness']} max={state['max_brightness']} counts={state['strip_counts']}")

        # ---------- §2 灯珠上限 100 ----------
        code, _ = await dev.send(CMD["SET_LED_COUNT"], bytes([0, 100, 0]))
        check("SetLedCount(100) 被接受（上限已从 64 抬到 100）", code == 0x00, f"result=0x{code:02X}")
        code, frames = await dev.send_and_collect(CMD["QUERY_STATE"])
        state_frames = [f for f in frames if f["cmd"] == STATE_REPORT]
        if state_frames:
            state = parse_state(state_frames[0]["payload"])
            check("读回 100 颗灯珠", state["strip_counts"][0] == 100, f"count={state['strip_counts'][0]}")
        code, _ = await dev.send(CMD["SET_LED_COUNT"], bytes([0, 101, 0]))
        check("SetLedCount(101) 被拒（超出新上限）", code in (0x01, 0x04), f"result=0x{code:02X}")

        # 回到 30 颗方便后面的光区测试
        await dev.send(CMD["SET_LED_COUNT"], bytes([0, 30, 0]))

        # ---------- §3 三种新灯效 ----------
        for name, type_, l0 in (
            ("爆闪 0x04", 0x04, layer_bytes(0x04, period=250, p5=128)),
            ("心跳 0x05", 0x05, layer_bytes(0x05, period=1000)),
            # 熄灭要求 hue/sat/p5/period/flags 全为 0（§7.1 第 8 步），
            # level 不参与这条校验。
            ("熄灭 0x06", 0x06, layer_bytes(0x06, hue=0, sat=0)),
        ):
            payload = segment(0, 0, 0, 14, l0)
            code, _ = await dev.send(CMD["SET_SEGMENT"], payload)
            check(f"{name} 被接受", code == 0x00, f"result=0x{code:02X}")

            code, frames = await dev.send_and_collect(CMD["QUERY_STRIP"], bytes([0]))
            reports = [parse_segment_report(f["payload"]) for f in frames if f["cmd"] == SEGMENT_REPORT]
            found = [r for r in reports if r["seg"] == 0]
            check(
                f"{name} 读回类型 0x{type_:02X}",
                bool(found) and found[0]["layer0"]["type"] == type_,
                f"读回={[hex(r['layer0']['type']) for r in found]}",
            )

        # ---------- §4 新灯效边界 ----------
        code, _ = await dev.send(CMD["SET_SEGMENT"], segment(0, 0, 0, 14, layer_bytes(0x04, period=50)))
        check("爆闪 50ms 被拒（下限 100ms）", code == 0x01, f"result=0x{code:02X}")
        code, _ = await dev.send(CMD["SET_SEGMENT"], segment(0, 0, 0, 14, layer_bytes(0x05, period=300)))
        check("心跳 300ms 被拒（下限 500ms）", code == 0x01, f"result=0x{code:02X}")

        # ---------- §5 逐光区亮度 ----------
        await dev.send(CMD["CLEAR_SEGMENT"], bytes([0, 0]))
        await dev.send(CMD["CLEAR_SEGMENT"], bytes([0, 1]))
        await dev.send(CMD["SET_SEGMENT"], segment(0, 0, 0, 14, layer_bytes(0x00, level=100)))
        await dev.send(CMD["SET_SEGMENT"], segment(0, 1, 15, 29, layer_bytes(0x00, level=25)))
        code, frames = await dev.send_and_collect(CMD["QUERY_STRIP"], bytes([0]))
        reports = [parse_segment_report(f["payload"]) for f in frames if f["cmd"] == SEGMENT_REPORT]
        levels = {r["seg"]: (r["start"], r["end"], r["layer0"]["level"]) for r in reports}
        check(
            "同一带两个光区各自的 level 独立（100 / 25）",
            len(reports) == 2 and levels.get(0, (None, None, None))[2] == 100 and levels.get(1, (None, None, None))[2] == 25,
            f"levels={levels}",
        )
        code, _ = await dev.send(CMD["SET_SEGMENT"], segment(0, 2, 0, 4, layer_bytes(0x00, level=101)))
        check("level=101 被拒", code == 0x01, f"result=0x{code:02X}")

        # ---------- §6 ClearScript ----------
        script_id = 3
        await dev.send(CMD["CLEAR_SCRIPT"], bytes([script_id]))
        begin_payload = bytes([script_id, 1, 1])
        code, _ = await dev.send(CMD["SCRIPT_BEGIN"], begin_payload)
        check("ScriptBegin 被接受", code == 0x00, f"result=0x{code:02X}")
        await dev.send(CMD["SCRIPT_STAGE"], bytes([script_id, 0, 0xE8, 0x03, 0x00, 0x00]))
        seg_payload = segment(0, 0, 0, 29, layer_bytes(0x00))
        code, _ = await dev.send(CMD["SCRIPT_SEGMENT"], bytes([script_id, 0]) + seg_payload)
        check("ScriptSegment 被接受", code == 0x00, f"result=0x{code:02X}")
        code, _ = await dev.send(CMD["SCRIPT_COMMIT"], bytes([script_id]))
        check("ScriptCommit 被接受", code == 0x00, f"result=0x{code:02X}")

        code, frames = await dev.send_and_collect(CMD["QUERY_SCRIPT"], bytes([script_id]))
        summaries = [f for f in frames if f["cmd"] == SCRIPT_SUMMARY]
        steps_before = summaries[0]["payload"][1] if summaries else None
        check("提交后摘要读到 1 个步骤", steps_before == 1, f"steps={steps_before}")

        code, _ = await dev.send(CMD["CLEAR_SCRIPT"], bytes([script_id]))
        check("ClearScript 0x1E 被接受", code == 0x00, f"result=0x{code:02X}")
        code, frames = await dev.send_and_collect(CMD["QUERY_SCRIPT"], bytes([script_id]))
        summaries = [f for f in frames if f["cmd"] == SCRIPT_SUMMARY]
        steps_after = summaries[0]["payload"][1] if summaries else None
        check("清空后摘要回到 0 个步骤", steps_after == 0, f"steps={steps_after}")

        code, _ = await dev.send(CMD["CLEAR_SCRIPT"], bytes([script_id]))
        check("ClearScript 幂等（再清一次仍 OK）", code == 0x00, f"result=0x{code:02X}")

        # ---------- §7 #98：流光密度 / 实色拖尾 / 随机闪烁 ----------
        #
        # 三个都只碰已存在的字节：密度与拖尾挤在流光的 flags 字节里
        # （bit1 实色、bit2-3 头数-1），随机闪烁是新的类型值 0x07。
        # 设备侧的像素数学由 host 测试证明，这里证明「真机接受并读回同样的
        # 字节」——这正是旧固件与新固件的分界线。
        await dev.send(CMD["CLEAR_SEGMENT"], bytes([0, 0]))
        await dev.send(CMD["CLEAR_SEGMENT"], bytes([0, 1]))

        comet_flags = [
            ("1 个头", 0x00),
            ("4 个头", 0x0C),
            ("实色拖尾", 0x02),
            ("4 头 + 实色 + 反向", 0x0F),
        ]
        for label, flags in comet_flags:
            payload = segment(0, 0, 0, 14, layer_bytes(0x03, period=800, p5=64, flags=flags))
            code, _ = await dev.send(CMD["SET_SEGMENT"], payload)
            check(f"流光 {label} 被接受（flags=0x{flags:02X}）", code == 0x00, f"result=0x{code:02X}")

            code, frames = await dev.send_and_collect(CMD["QUERY_STRIP"], bytes([0]))
            reports = [parse_segment_report(f["payload"]) for f in frames if f["cmd"] == SEGMENT_REPORT]
            found = [r for r in reports if r["seg"] == 0]
            got = found[0]["layer0"].get("flags") if found else None
            check(
                f"流光 {label} 读回 flags=0x{flags:02X}",
                bool(found) and got == flags,
                f"读回={got if got is None else hex(got)}",
            )

        code, _ = await dev.send(
            CMD["SET_SEGMENT"], segment(0, 0, 0, 14, layer_bytes(0x03, period=800, flags=0x10))
        )
        check("流光 flags bit4 保留位被拒（0x10）", code == 0x01, f"result=0x{code:02X}")

        # 随机闪烁 0x07：p5 = 同时亮着的比例。
        await dev.send(CMD["CLEAR_SEGMENT"], bytes([0, 0]))
        for label, duty in (("稀疏", 32), ("密集", 224)):
            payload = segment(0, 0, 0, 14, layer_bytes(0x07, period=1000, p5=duty))
            code, _ = await dev.send(CMD["SET_SEGMENT"], payload)
            check(f"随机闪烁（{label} duty={duty}）被接受", code == 0x00, f"result=0x{code:02X}")

            code, frames = await dev.send_and_collect(CMD["QUERY_STRIP"], bytes([0]))
            reports = [parse_segment_report(f["payload"]) for f in frames if f["cmd"] == SEGMENT_REPORT]
            found = [r for r in reports if r["seg"] == 0]
            check(
                f"随机闪烁（{label}）读回类型 0x07 与 duty={duty}",
                bool(found)
                and found[0]["layer0"]["type"] == 0x07
                and found[0]["layer0"]["p5"] == duty,
                f"读回={found[0]['layer0'] if found else None}",
            )

        code, _ = await dev.send(
            CMD["SET_SEGMENT"], segment(0, 0, 0, 14, layer_bytes(0x07, period=333))
        )
        check("随机闪烁 333ms 被拒（下限 334ms）", code == 0x01, f"result=0x{code:02X}")
        code, _ = await dev.send(
            CMD["SET_SEGMENT"], segment(0, 0, 0, 14, layer_bytes(0x07, period=1000, flags=0x01))
        )
        check("随机闪烁 flags 非 0 被拒", code == 0x01, f"result=0x{code:02X}")

        # ---------- §8 收尾 ----------
        if not args.skip_restore:
            await dev.send(CMD["CLEAR_SEGMENT"], bytes([0, 0]))
            await dev.send(CMD["CLEAR_SEGMENT"], bytes([0, 1]))
            await dev.send(CMD["SET_LED_COUNT"], bytes([0, 30, 0]))
            await dev.send(CMD["SET_BRIGHTNESS"], bytes([128]))
            print("      （已恢复：灯珠 30、亮度 128、光区清空）")

    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print(f"\n===== {passed} passed / {failed} failed =====")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
