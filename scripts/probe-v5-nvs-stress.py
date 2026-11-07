#!/usr/bin/env python
"""lumen v5 · NVS 极限压测（#162 规格风险 #2）。

回答一个具体问题：**三个场景各写满「8 链 × 8 部位 × 8 步 × 两层」之后，
64 KB 的 NVS 分区还撑得住吗？反复擦写会不会撞页擦除 / 碎片？**

## 为什么不能靠现有的存储压测

`probe-v5-acceptance.py` 的 §2 每场景只写「1 链 × 8 部位 × 8 步」≈ 1.5 KB，
**离最坏形态 10.4 KB 差 7 倍**。规格 §Further Notes 的风险 #2 说的正是「三份
最坏场景 ≈ 31 KB 塞进 64 KB，实际可用常低于标称」。所以这一项必须单独压。

## 判据

1. 三个场景都写满最坏形态，且 `QueryScene` 能读回全部 512 条（×3）；
2. 反复擦写 N 轮后仍能读回 —— 任何一轮失败即判失败；
3. 全程零 `Event 0x81`（存储失败）与零 `nvs write failed`（串口）。

## 已知的退路（规格里写好的）

如果撞了：场景键上限降到 8 KB + 打开「相邻同效果步合并」压缩。这个脚本只负责
给出「撞没撞」的事实，不自动改契约。

用法：
  python scripts/probe-v5-nvs-stress.py                    # 1 轮（含最优/最坏对比）
  python scripts/probe-v5-nvs-stress.py --rounds 20        # 反复擦写 20 轮
  python scripts/probe-v5-nvs-stress.py --rounds 20 --port COM6   # 每轮后断电复位
"""

import argparse
import asyncio
import struct
import sys
import time

from bleak import BleakClient, BleakScanner

MAGIC = 0xA6
VERSION = 0x05
MAX_STRIPS = 8
MAX_PARTS = 8
MAX_STEPS = 8
MAX_SCENES = 3
SCENE_STEP_BYTES = 24
LAYOUT_PART_BYTES = 29

RX_UUID = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX_UUID = "6c756d65-6e00-4b1e-9a3c-000000000003"
STATE_UUID = "6c756d65-6e00-4b1e-9a3c-000000000004"

OK = 0x00
CMD = {
    "SET_POWER": 0x01,
    "QUERY_STATE": 0x05,
    "SET_LED_COUNT": 0x06,
    "SET_STRIP_POWER": 0x1B,
    "LAYOUT_WRITE": 0x20,
    "LAYOUT_PART": 0x21,
    "LAYOUT_SEG": 0x22,
    "LAYOUT_COMMIT": 0x23,
    "QUERY_LAYOUT": 0x24,
    "SCENE_PART": 0x25,
    "SCENE_STEP": 0x26,
    "SCENE_NAME": 0x27,
    "ACTIVATE_SCENE": 0x28,
    "QUERY_SCENE": 0x29,
}
RPT_EVENT = 0x81
RPT_SCENE_PART = 0x8B
RPT_SCENE_STEP = 0x8C
RPT_SCENE_LIST_END = 0x8D

# 规格 §10.4 的两个数字：最坏 10472，硬上限 12288。
SCENE_BLOB_MAX_BYTES = 12288
SCENE_STEP_MAX_BYTES = 20  # 2 时长 + 9 + 9


def hexs(value):
    return "无 ACK" if value is None else f"0x{value:02X}"


def crc16(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def build_frame(command, seq, payload=b""):
    body = bytes([MAGIC, VERSION, command, seq]) + struct.pack("<H", len(payload)) + payload
    return body + struct.pack("<H", crc16(body))


def chunked(frame_bytes, capacity=20):
    total = (len(frame_bytes) + capacity - 1) // capacity
    out = []
    for index in range(total):
        piece = frame_bytes[index * capacity:(index + 1) * capacity]
        head = (0x80 if index == 0 else 0) | (0x40 if index == total - 1 else 0) | index
        out.append(bytes([head]) + piece)
    return out


def empty_layer():
    return bytes([0xFF]) + bytes(8)


def static_layer(hue, sat, level=100):
    return bytes([0x00]) + struct.pack("<H", hue) + bytes([sat]) + struct.pack("<H", 0) + bytes([0, 0, level])


def anim_layer(effect_type, hue, sat, period_ms, p5, flags, level):
    """9 字节动画层：最坏编码形态（每步两层都是这个）。"""
    return (
        bytes([effect_type])
        + struct.pack("<H", hue)
        + bytes([sat])
        + struct.pack("<H", period_ms)
        + bytes([p5, flags, level])
    )


class Checks:
    def __init__(self):
        self.passed = 0
        self.failed = []

    def check(self, name, ok, detail=""):
        if ok:
            self.passed += 1
            print(f"PASS  {name}" + (f"  — {detail}" if detail else ""))
        else:
            self.failed.append(name)
            print(f"FAIL  {name}" + (f"  — {detail}" if detail else ""))
        return ok

    def report(self):
        total = self.passed + len(self.failed)
        print(f"\n=== {self.passed}/{total} 通过 ===")
        for item in self.failed:
            print(f"  - {item}")
        return 0 if not self.failed else 1


class Probe:
    def __init__(self, client):
        self.client = client
        self.seq = 0
        self.acks = {}
        self.reports = []
        self.events = []
        self._pending = b""

    def on_notify(self, _sender, data):
        raw = bytes(data)
        if not raw:
            return
        ctrl = raw[0]
        piece = raw[1:]
        if ctrl & 0x80:
            self._pending = piece
        else:
            self._pending += piece
        if not (ctrl & 0x40):
            return
        frame_bytes = self._pending
        self._pending = b""
        if len(frame_bytes) < 8 or frame_bytes[0] != MAGIC:
            return
        command = frame_bytes[2]
        seq = frame_bytes[3]
        length = struct.unpack("<H", frame_bytes[4:6])[0]
        body = frame_bytes[6:6 + length]
        if command == 0x80 and len(body) >= 2:
            self.acks[seq] = body[1]
        elif command == RPT_EVENT and len(body) >= 2:
            # Event 0x81：[event_code, detail]。0x01 = 存储失败。
            self.events.append((body[0], body[1]))
        else:
            self.reports.append((command, seq, body))

    async def send(self, name, payload=b"", wait=0.03):
        command = CMD[name]
        self.seq = (self.seq + 1) & 0xFF
        seq = self.seq
        self.acks.pop(seq, None)
        for piece in chunked(build_frame(command, seq, payload)):
            await self.client.write_gatt_char(RX_UUID, piece, response=False)
        deadline = time.monotonic() + 3.0
        while seq not in self.acks and time.monotonic() < deadline:
            await asyncio.sleep(0.003)
        result = self.acks.get(seq)
        if wait > 0:
            await asyncio.sleep(wait)
        return result

    async def read_state(self):
        payload = bytes(await self.client.read_gatt_char(STATE_UUID))
        return {
            "power": payload[0],
            "brightness": payload[1],
            "strip_count": payload[3],
            "strip_power_mask": payload[4],
            "active_scene": payload[5],
            "layout_valid": payload[6],
            "led_counts": [payload[8 + i * 2] | (payload[9 + i * 2] << 8) for i in range(8)],
            "part_counts": list(payload[24:32]),
        }

    async def query_scene(self, scene_id, wait=28.0):
        self.reports = []
        result = await self.send("QUERY_SCENE", bytes([scene_id]), wait=wait)
        parts = [p for c, _s, p in self.reports if c == RPT_SCENE_PART]
        steps = [p for c, _s, p in self.reports if c == RPT_SCENE_STEP]
        ends = [p for c, _s, p in self.reports if c == RPT_SCENE_LIST_END]
        return result, parts, steps, ends

    async def drain_events(self):
        await asyncio.sleep(2.5)  # 2s 防抖 + 余量
        got = self.events
        self.events = []
        return got


def worst_case_blob_bytes(strip_count, led_count):
    """按 §10.4 的变长编码算一个场景最坏形态的字节数（算术，不是实测）。

    头 32 + 每链 part_count 1 + 每部位 (3 + 每步 20)。每步两层都带动画 → 20。
    """
    total = 32 + MAX_STRIPS
    for _strip in range(strip_count):
        for _part in range(MAX_PARTS):
            total += 3 + MAX_STEPS * SCENE_STEP_MAX_BYTES
    return total


async def fill_layout(probe):
    """8 链 × 8 部位 × 1 段（每段 12–13 颗，8 条链共 100 颗时均分）。"""
    for strip in range(MAX_STRIPS):
        await probe.send("LAYOUT_WRITE", bytes([strip, MAX_PARTS]))
        for part in range(MAX_PARTS):
            name = f"s{strip}p{part}".encode("utf-8")[:24]
            payload = bytes([strip, part, len(name)]) + name + bytes(24 - len(name))
            payload += bytes([1, part % 2])  # seg_count=1，相位交替
            await probe.send("LAYOUT_PART", payload)
            # 100 颗均分 8 段：每段 ~12 颗
            start = part * 12
            end = min(99, start + 11)
            await probe.send("LAYOUT_SEG", bytes([strip, part, 0, start, end]))
    return await probe.send("LAYOUT_COMMIT")


async def fill_scene(probe, scene_id, strip_count):
    """把一个场景写成最坏形态：8 链 × 8 部位 × 8 步 × 两层全动画。"""
    written = 0
    for strip in range(strip_count):
        for part in range(MAX_PARTS):
            result = await probe.send(
                "SCENE_PART", bytes([scene_id, strip, part, MAX_STEPS, 1, 1])
            )
            if result != OK:
                return written, f"ScenePart s{strip}p{part} {hexs(result)}"
            for step in range(MAX_STEPS):
                payload = bytes([scene_id, strip, part, step]) + struct.pack("<H", 1000 + step * 100)
                # 两层都用动画类（9 字节），这是最坏变长编码。
                payload += anim_layer(0x02, 0, 255, 334 + step * 10, 255, 0, 100)
                payload += anim_layer(0x03, 100, 200, 500 + step * 10, 120, 0, 60)
                result = await probe.send("SCENE_STEP", payload)
                if result != OK:
                    return written, f"SceneStep s{strip}p{part}st{step} {hexs(result)}"
                written += 1
    return written, None


async def verify_scene(probe, scene_id, strip_count, label):
    result, parts, steps, ends = await probe.query_scene(scene_id)
    want_parts = strip_count * MAX_PARTS
    want_steps = want_parts * MAX_STEPS
    ok = (
        result == OK
        and len(parts) == want_parts
        and len(steps) == want_steps
        and len(ends) == 1
    )
    print(
        f"  {label}场景 {scene_id}：ack={hexs(result)} "
        f"{len(parts)}/{want_parts} 部位 · {len(steps)}/{want_steps} 步 · "
        f"收尾 {len(ends)}"
    )
    return ok and len(parts) == want_parts and len(steps) == want_steps


async def power_cycle(port):
    """DTR/RTS 真复位（与 capture-serial.py --reset 同一串序列）。"""
    try:
        import serial
    except ImportError:
        return False, "缺 pyserial"
    try:
        ser = serial.Serial(port, 115200, timeout=0.3)
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)
    ser.setDTR(False)
    ser.setRTS(True)
    time.sleep(0.2)
    ser.setRTS(False)
    ser.close()
    await asyncio.sleep(8)
    return True, ""


async def connect(name):
    devices = await BleakScanner.discover(timeout=8)
    target = next((d for d in devices if d.name == name), None)
    if target is None:
        found = ", ".join(f"{d.address}({d.name})" for d in devices) or "无"
        sys.exit(f"没扫到 {name}。扫到的是：{found}\n"
                 "若设备被手机上的小程序占着，先退出小程序（协议是单连接）。")
    client = BleakClient(target.address, timeout=30)
    await client.connect()
    probe = Probe(client)
    await client.start_notify(TX_UUID, probe.on_notify)
    return client, probe


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", default="Lumen-5662", help="广播名")
    parser.add_argument("--rounds", type=int, default=1, help="反复擦写轮数")
    parser.add_argument("--port", default="", help="串口；给了就在每轮后真复位")
    args = parser.parse_args()

    client, probe = await connect(args.name)
    chk = Checks()
    try:
        state = await probe.read_state()
        strip_count = state["strip_count"]
        led_count = state["led_counts"][0] or 30
        print(f"设备：{strip_count} 条链，strip0 = {led_count} 颗\n")

        # 布局要能容纳 8 部位 × 8 段（每段 12 颗 → 100 颗链）。
        for strip in range(MAX_STRIPS):
            await probe.send("SET_LED_COUNT", bytes([strip, 100, 0]))
        state = await probe.read_state()
        chk.check(
            "8 条链的灯珠数都设成 100（最坏布局需要 8 部位 × 12 颗）",
            all(state["led_counts"][i] == 100 for i in range(MAX_STRIPS)),
            str(state["led_counts"]),
        )

        commit = await fill_layout(probe)
        chk.check("最坏布局（8 链 × 8 部位 × 1 段）提交", commit == OK, hexs(commit))

        expected_blob = worst_case_blob_bytes(MAX_STRIPS, 100)
        print(
            f"每场景最坏编码 = {expected_blob} 字节（规格上限 {SCENE_BLOB_MAX_BYTES}）；"
            f"三场景合计 {expected_blob * MAX_SCENES} 字节\n"
        )
        chk.check(
            f"算术上单场景装得下（{expected_blob} ≤ {SCENE_BLOB_MAX_BYTES}）",
            expected_blob <= SCENE_BLOB_MAX_BYTES,
            f"{expected_blob} / {SCENE_BLOB_MAX_BYTES}",
        )

        rounds = max(1, args.rounds)
        all_ok = True
        started = time.monotonic()
        for round_index in range(rounds):
            print(f"--- 第 {round_index + 1}/{rounds} 轮：三场景全写最坏形态 ---")
            for scene in range(MAX_SCENES):
                written, error = await fill_scene(probe, scene, MAX_STRIPS)
                if error is not None:
                    chk.check(f"第 {round_index + 1} 轮场景 {scene} 写入", False, error)
                    all_ok = False
                    break
            if not all_ok:
                break

            # 2 秒防抖 + 余量，然后等 Event 0x81（存储失败是异步上报的）。
            events = await probe.drain_events()
            storage_events = [e for e in events if e[0] == 0x01]
            chk.check(
                f"第 {round_index + 1} 轮无存储失败事件（Event 0x81）",
                len(storage_events) == 0,
                f"{len(storage_events)} 次" + (f" detail={storage_events[:3]}" if storage_events else ""),
            )

            # （可选）每轮后真复位，验证断电恢复也扛得住。
            if args.port:
                ok, why = await power_cycle(args.port)
                if not ok:
                    chk.check("断电复位", False, why)
                    all_ok = False
                    break
                try:
                    await client.disconnect()
                except Exception:
                    pass
                client, probe = await connect(args.name)

            verified = True
            for scene in range(MAX_SCENES):
                scene_ok = await verify_scene(probe, scene, MAX_STRIPS, f"第 {round_index + 1} 轮 ")
                verified = verified and scene_ok
            chk.check(
                f"第 {round_index + 1} 轮三场景读回完整（各 {MAX_STRIPS * MAX_PARTS} 部位 / "
                f"{MAX_STRIPS * MAX_PARTS * MAX_STEPS} 步）",
                verified,
            )
            all_ok = all_ok and verified

        elapsed = time.monotonic() - started
        print(f"\n{rounds} 轮耗时 {elapsed:.0f}s（平均 {elapsed / rounds:.0f}s/轮）")

        # 收尾：恢复成「8 链 30 颗 / 每链 1 部位 / 常亮」。
        await restore(probe, chk, led_count)
    finally:
        try:
            await client.stop_notify(TX_UUID)
        except Exception:
            pass
        await client.disconnect()

    return chk.report()


async def restore(probe, chk, led_count):
    print("\n--- 收尾（恢复成 8 链 30 颗 / 每链 1 部位 / 常亮）---")
    for strip in range(MAX_STRIPS):
        await probe.send("SET_LED_COUNT", bytes([strip, led_count & 0xFF, led_count >> 8]))
    for strip in range(MAX_STRIPS):
        await probe.send("LAYOUT_WRITE", bytes([strip, 1]))
        await probe.send("LAYOUT_PART", bytes([0, strip, 0]) + bytes(24) + bytes([1, 0]))
        await probe.send("LAYOUT_SEG", bytes([0, strip, 0, 0, led_count - 1]))
    commit = await probe.send("LAYOUT_COMMIT")
    chk.check("收尾布局提交", commit == OK, hexs(commit))

    for scene in range(MAX_SCENES):
        for strip in range(MAX_STRIPS):
            await probe.send("SCENE_PART", bytes([scene, strip, 0, 1, 0, 1]))
            payload = bytes([scene, strip, 0, 0]) + struct.pack("<H", 1000)
            payload += static_layer(30, 128, 100) + empty_layer()
            await probe.send("SCENE_STEP", payload)
    await probe.send("ACTIVATE_SCENE", bytes([0]))
    for strip in range(MAX_STRIPS):
        await probe.send("SET_STRIP_POWER", bytes([strip, 1]))
    await probe.send("SET_POWER", bytes([1]))
    chk.check("收尾完成", True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
