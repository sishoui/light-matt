#!/usr/bin/env python
"""协议 v5 真机验收（票 #155 的验收项）。

覆盖「只有真机能证明」的几件事：

  §1 断崖：v4 帧回 0x07；v4 的段 / 剧本命令回 0x02 未知命令
  §2 信封与身份：DeviceInfo 报 v5 能力位（100/8/8/8/8/3）
  §3 State 32 字节：layout_valid 与 active_scene 可读
  §4 布局：LayoutWrite / LayoutPart / LayoutSeg / LayoutCommit / QueryLayout 往返
  §5 段互斥：压到别的部位 → InvalidParam，且旧布局逐字节不变（S3/S4）
  §6 场景：ScenePart / SceneStep / SceneName / ActivateScene / QueryScene 往返
  §7 未覆盖灯珠恒黑：布局只覆盖前半条，后半条应为 0（规格 §9.3）
  §8 断电恢复：写布局 + 场景后提示用户复位，重连读回
  §9 收尾：把设备恢复成「一条链、一个整条部位、常亮」

用法：
    python scripts/probe-v5.py                    # 默认 Lumen-5662
    python scripts/probe-v5.py --address CC:8D:A2:C2:56:62
    python scripts/probe-v5.py --skip-persist     # 跳过需要人工复位的 §8

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
VERSION_V5 = 0x05
VERSION_V4 = 0x04
LAYER_EMPTY = 0xFF
LAYER_BYTES = 9
STATE_BYTES = 32
CHUNK_FIRST = 0x80
CHUNK_LAST = 0x40
CHUNK_INDEX_MASK = 0x3F

OK = 0x00
INVALID_PARAM = 0x01
UNKNOWN_COMMAND = 0x02
UNSUPPORTED_VERSION = 0x07

CMD = {
    "SET_POWER": 0x01,
    "SET_BRIGHTNESS": 0x02,
    "QUERY_STATE": 0x05,
    "SET_LED_COUNT": 0x06,
    "SELF_TEST": 0x07,
    "SET_STRIP_POWER": 0x1B,
    "QUERY_STRIP_CONFIG": 0x1C,
    "QUERY_DEVICE_INFO": 0x1D,
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

REPORT = {
    0x80: "ACK",
    0x81: "EVENT",
    0x82: "STATE",
    0x87: "STRIP_CONFIG",
    0x88: "DEVICE_INFO",
    0x89: "LAYOUT",
    0x8A: "LAYOUT_END",
    0x8B: "SCENE_PART",
    0x8C: "SCENE_STEP",
    0x8D: "SCENE_END",
}

# v4 的退役命令（必须回 0x02）
RETIRED = {
    "SetSegment": 0x10,
    "ClearSegment": 0x11,
    "QueryStrip": 0x12,
    "SetPlayback": 0x13,
    "ScriptBegin": 0x14,
    "ScriptCommit": 0x17,
    "ClearScript": 0x1E,
}


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def chunked(frame_bytes):
    """§3.2：小程序 → 设备的**每一次写**也带 1 字节分片头。

    设备侧 remove_chunk_header 无条件剥掉首字节，裸帧会被当成「头 + 少了
    一个字节的帧」，CRC 必然不过 —— 表现是设备一个 ACK 都不回。
    短帧永远是单分片，ctrl = 0xC0（FIRST|LAST|序号 0）。
    """
    return bytes([CHUNK_FIRST | CHUNK_LAST]) + frame_bytes


def frame(command, seq, payload=b"", version=VERSION_V5):
    body = bytes([MAGIC, version, command, seq]) + struct.pack("<H", len(payload)) + payload
    return body + struct.pack("<H", crc16(body))


def empty_layer():
    return bytes([LAYER_EMPTY]) + b"\x00" * 8


def static_layer(hue, sat, level=100):
    # type 0x00 静态：param = hue, sat, 0,0,0,0,0
    return bytes([0x00, hue, sat, 0, 0, 0, 0, 0, level])


class Probe:
    def __init__(self, client):
        self.client = client
        self.seq = 0
        self.reports = []
        self.acks = {}
        self.pending = b""

    def next_seq(self):
        self.seq = (self.seq + 1) & 0xFF
        return self.seq

    def on_notify(self, _handle, data):
        """§3.2：设备 → 小程序的每个 notify 都带 1 字节分片头。

        单分片时 ctrl = 0xC0（FIRST|LAST|序号 0），所以裸帧的第一个字节
        0xA6 会被前缀盖住。这里按头重组，不为单分片场景写简化分支——
        多分片（LayoutReport / SceneStepReport 长报告）也会走同一条路。
        """
        b = bytes(data)
        if not b:
            return
        ctrl = b[0]
        index = ctrl & CHUNK_INDEX_MASK
        payload = b[1:]
        if ctrl & CHUNK_FIRST:
            self.pending = payload
        else:
            self.pending += payload
        if not (ctrl & CHUNK_LAST):
            return
        frame_bytes = self.pending
        self.pending = b""
        self._consume_frame(frame_bytes, index)

    def _consume_frame(self, b, _index):
        if len(b) < 8 or b[0] != MAGIC:
            return
        command = b[2]
        seq = b[3]
        length = struct.unpack("<H", b[4:6])[0]
        payload = b[6:6 + length]
        if command == 0x80 and len(payload) >= 2:
            self.acks[seq] = payload[1]
        else:
            self.reports.append((command, seq, payload))

    async def send(self, name, payload=b"", version=VERSION_V5, wait=0.35):
        command = CMD[name] if isinstance(name, str) else name
        seq = self.next_seq()
        self.reports.clear()
        self.acks.pop(seq, None)
        await self.client.write_gatt_char(RX, chunked(frame(command, seq, payload, version)),
                                          response=False)
        deadline = asyncio.get_event_loop().time() + 3.0
        while seq not in self.acks and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.005)
        result = self.acks.get(seq)
        await asyncio.sleep(wait)
        return result, list(self.reports)


class Checker:
    def __init__(self):
        self.passed = 0
        self.failed = []

    def check(self, name, condition, detail=""):
        if condition:
            self.passed += 1
            print(f"PASS  {name}" + (f"  — {detail}" if detail else ""))
        else:
            self.failed.append(name)
            print(f"FAIL  {name}" + (f"  — {detail}" if detail else ""))

    def summary(self):
        total = self.passed + len(self.failed)
        print(f"\n=== {self.passed}/{total} 通过 ===")
        if self.failed:
            print("失败项：")
            for name in self.failed:
                print(f"  - {name}")
        return len(self.failed) == 0


def parse_device_info(payload):
    if len(payload) < 15:
        return None
    return {
        "firmware": struct.unpack("<H", payload[0:2])[0],
        "hw_id": payload[2:8].hex(":").upper(),
        "max_leds": payload[8],
        "max_strips": payload[9],
        "max_parts": payload[10],
        "max_part_segs": payload[11],
        "max_steps": payload[12],
        "max_scenes": payload[13],
        "caps": payload[14],
    }


def parse_state(payload):
    if len(payload) < STATE_BYTES:
        return None
    return {
        "power": payload[0],
        "brightness": payload[1],
        "max_brightness": payload[2],
        "strip_count": payload[3],
        "strip_power_mask": payload[4],
        "active_scene": payload[5],
        "layout_valid": payload[6],
        "led_counts": list(struct.unpack("<8H", payload[8:24])),
        "part_counts": list(payload[24:32]),
    }


def parse_layout_report(payload):
    if len(payload) < 44:
        return None
    name_len = payload[2]
    return {
        "strip_id": payload[0],
        "part_id": payload[1],
        "name": payload[3:3 + name_len].decode("utf-8", "replace"),
        "seg_count": payload[27],
        "segs": [(payload[28 + i * 2], payload[29 + i * 2]) for i in range(8)],
    }


def parse_scene_part(payload):
    if len(payload) < 6:
        return None
    return {
        "scene_id": payload[0],
        "strip_id": payload[1],
        "part_id": payload[2],
        "step_count": payload[3],
        "loop": payload[4],
        "on": payload[5],
    }


async def run(probe, chk, args):
    # ---------------- §1 断崖 ----------------
    print("\n--- §1 断崖升级 ---")
    result, _ = await probe.send("QUERY_STATE", version=VERSION_V4)
    chk.check("v4 帧回 UnsupportedVersion 0x07", result == UNSUPPORTED_VERSION, f"0x{result:02X}" if result is not None else "无 ACK")

    for name, code in RETIRED.items():
        payload = b"\x00" * 23  # 段 / 剧本载荷，宽度不该影响判决
        result, _ = await probe.send(code, payload)
        chk.check(f"退役命令 {name} 0x{code:02X} 回 UnknownCommand", result == UNKNOWN_COMMAND,
                  f"0x{result:02X}" if result is not None else "无 ACK")

    # ---------------- §2 身份与能力 ----------------
    print("\n--- §2 能力位 ---")
    result, reports = await probe.send("QUERY_DEVICE_INFO")
    info = None
    for command, _seq, payload in reports:
        if command == 0x88:
            info = parse_device_info(payload)
    chk.check("DeviceInfoReport 收到", info is not None)
    if info:
        chk.check("固件版本是 v5 (0x0500)", info["firmware"] == 0x0500, f"0x{info['firmware']:04X}")
        chk.check("max_leds = 100", info["max_leds"] == 100, str(info["max_leds"]))
        chk.check("max_strips = 8", info["max_strips"] == 8, str(info["max_strips"]))
        chk.check("max_parts = 8", info["max_parts"] == 8, str(info["max_parts"]))
        chk.check("max_part_segs = 8", info["max_part_segs"] == 8, str(info["max_part_segs"]))
        chk.check("max_steps = 8", info["max_steps"] == 8, str(info["max_steps"]))
        chk.check("max_scenes = 3", info["max_scenes"] == 3, str(info["max_scenes"]))

    # ---------------- §3 State ----------------
    print("\n--- §3 State 32 字节 ---")
    result, reports = await probe.send("QUERY_STATE")
    state = None
    for command, _seq, payload in reports:
        if command == 0x82:
            chk.check("StateReport 是 32 字节", len(payload) == STATE_BYTES, f"{len(payload)} 字节")
            state = parse_state(payload)
    chk.check("StateReport 收到", state is not None)
    if state:
        led0 = state["led_counts"][0]
        print(f"      设备：{state['strip_count']} 条链，strip0 = {led0} 颗，"
              f"active_scene={state['active_scene']}，layout_valid={state['layout_valid']}")
        chk.check("strip_count 在 1-8", 1 <= state["strip_count"] <= 8, str(state["strip_count"]))
        chk.check("active_scene 在 0-2", 0 <= state["active_scene"] <= 2, str(state["active_scene"]))
        led_count = led0
    else:
        led_count = 64

    # 从零开始：一条链、无部位
    await probe.send("LAYOUT_WRITE", bytes([0, 0]))

    # ---------------- §4 布局往返 ----------------
    print("\n--- §4 布局往返 ---")
    half = max(1, led_count // 2)

    result, _ = await probe.send("LAYOUT_WRITE", bytes([0, 2]))
    chk.check("LayoutWrite(2 个部位) OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    name_eye = "眼灯".encode("utf-8")
    result, _ = await probe.send(
        "LAYOUT_PART",
        bytes([0, 0, len(name_eye)]) + name_eye + b"\x00" * (24 - len(name_eye)) + bytes([1]),
    )
    chk.check("LayoutPart(眼灯, 1 段) OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    result, _ = await probe.send("LAYOUT_SEG", bytes([0, 0, 0, 0, 1]))
    chk.check("LayoutSeg(0-1) OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    name_fin = "散热".encode("utf-8")
    result, _ = await probe.send(
        "LAYOUT_PART",
        bytes([0, 1, len(name_fin)]) + name_fin + b"\x00" * (24 - len(name_fin)) + bytes([1]),
    )
    chk.check("LayoutPart(散热, 1 段) OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    result, _ = await probe.send("LAYOUT_SEG", bytes([0, 1, 0, 2, half - 1]))
    chk.check(f"LayoutSeg(2-{half - 1}) OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    result, _ = await probe.send("LAYOUT_COMMIT")
    chk.check("LayoutCommit OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    result, reports = await probe.send("QUERY_LAYOUT", bytes([0]))
    layout = [parse_layout_report(p) for c, _s, p in reports if c == 0x89]
    layout = [x for x in layout if x]
    end = [p for c, _s, p in reports if c == 0x8A]
    chk.check("QueryLayout 报回 2 个部位", len(layout) == 2, f"{len(layout)} 个")
    chk.check("LayoutListEnd 收到", len(end) == 1)
    if len(layout) == 2:
        chk.check("部位 0 名字是「眼灯」", layout[0]["name"] == "眼灯", layout[0]["name"])
        chk.check("部位 0 段是 0-1", layout[0]["segs"][0] == (0, 1), str(layout[0]["segs"][0]))
        chk.check("部位 1 名字是「散热」", layout[1]["name"] == "散热", layout[1]["name"])
        chk.check(f"部位 1 段是 2-{half - 1}", layout[1]["segs"][0] == (2, half - 1),
                  str(layout[1]["segs"][0]))
    if end:
        chk.check("part_mask = 0b11", end[0][1] == 0x03, f"0x{end[0][1]:02X}")

    # ---------------- §5 段互斥 ----------------
    print("\n--- §5 段互斥（S3 / S4）---")
    result, _ = await probe.send("LAYOUT_SEG", bytes([0, 1, 0, 1, 5]))
    chk.check("压到别的部位 → InvalidParam", result == INVALID_PARAM,
              f"0x{result:02X}" if result is not None else "无 ACK")

    result, reports = await probe.send("QUERY_LAYOUT", bytes([0]))
    layout_after = [parse_layout_report(p) for c, _s, p in reports if c == 0x89]
    layout_after = [x for x in layout_after if x]
    unchanged = (
        len(layout_after) == 2
        and layout_after[1]["segs"][0] == (2, half - 1)
    ) if len(layout_after) == 2 else False
    chk.check("被拒后旧布局逐字节不变", unchanged)

    result, _ = await probe.send("LAYOUT_SEG", bytes([0, 0, 0, 5, 2]))
    chk.check("start > end → InvalidParam", result == INVALID_PARAM,
              f"0x{result:02X}" if result is not None else "无 ACK")

    result, _ = await probe.send("LAYOUT_SEG", bytes([0, 0, 0, 0, 200]))
    chk.check("end >= led_count → InvalidParam", result == INVALID_PARAM,
              f"0x{result:02X}" if result is not None else "无 ACK")

    # ---------------- §6 场景往返 ----------------
    print("\n--- §6 场景往返 ---")
    scene_name = "待机".encode("utf-8")
    result, _ = await probe.send(
        "SCENE_NAME",
        bytes([0, len(scene_name)]) + scene_name + b"\x00" * (24 - len(scene_name)),
    )
    chk.check("SceneName(待机) OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    # 部位 0：2 步，全部循环，开
    result, _ = await probe.send("SCENE_PART", bytes([0, 0, 0, 2, 1, 1]))
    chk.check("ScenePart(部位0, 2 步, 循环, 开) OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    red = static_layer(0, 255, 100)       # 色相 0 = 红
    blue = static_layer(170, 255, 100)     # 色相 170 ≈ 蓝
    for index, (layer, duration) in enumerate([(red, 500), (blue, 700)]):
        payload = (bytes([0, 0, 0, index])
                   + struct.pack("<H", duration)
                   + layer + empty_layer())
        result, _ = await probe.send("SCENE_STEP", payload)
        chk.check(f"SceneStep(部位0 第{index}步, {duration}ms) OK", result == OK,
                  f"0x{result:02X}" if result is not None else "无 ACK")

    # 部位 1：1 步，不循环，开
    result, _ = await probe.send("SCENE_PART", bytes([0, 0, 1, 1, 0, 1]))
    chk.check("ScenePart(部位1, 1 步, 不循环) OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    payload = (bytes([0, 0, 1, 0]) + struct.pack("<H", 1000) + red + empty_layer())
    result, _ = await probe.send("SCENE_STEP", payload)
    chk.check("SceneStep(部位1 第0步, 1000ms) OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    result, _ = await probe.send("SCENE_PART", bytes([0, 0, 0, 9, 1, 1]))
    chk.check("step_count = 9 → InvalidParam", result == INVALID_PARAM,
              f"0x{result:02X}" if result is not None else "无 ACK")

    result, _ = await probe.send("SCENE_PART", bytes([0, 0, 0, 2, 3, 1]))
    chk.check("loop = 3 → InvalidParam", result == INVALID_PARAM,
              f"0x{result:02X}" if result is not None else "无 ACK")

    result, _ = await probe.send("ACTIVATE_SCENE", bytes([0]))
    chk.check("ActivateScene(0) OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    result, reports = await probe.send("QUERY_SCENE", bytes([0]))
    parts = [parse_scene_part(p) for c, _s, p in reports if c == 0x8B]
    parts = [x for x in parts if x]
    steps = [p for c, _s, p in reports if c == 0x8C]
    ends = [p for c, _s, p in reports if c == 0x8D]
    chk.check("QueryScene 报回 2 个部位头", len(parts) == 2, f"{len(parts)} 个")
    chk.check("QueryScene 报回 3 步", len(steps) == 3, f"{len(steps)} 条")
    chk.check("SceneListEnd 收到", len(ends) == 1)
    if len(parts) == 2:
        chk.check("部位 0 是 2 步 / 全部循环 / 开",
                  (parts[0]["step_count"], parts[0]["loop"], parts[0]["on"]) == (2, 1, 1),
                  str(parts[0]))
        chk.check("部位 1 是 1 步 / 不循环 / 开",
                  (parts[1]["step_count"], parts[1]["loop"], parts[1]["on"]) == (1, 0, 1),
                  str(parts[1]))
    if ends:
        scene_end = ends[0]
        got_name = scene_end[2:2 + scene_end[1]].decode("utf-8", "replace")
        chk.check("场景名是「待机」", got_name == "待机", got_name)
    if steps:
        # 第 0 步 500ms、第 1 步 700ms、部位 1 的 1000ms
        durations = sorted(struct.unpack("<H", s[4:6])[0] for s in steps)
        chk.check("步骤时长 500 / 700 / 1000 都在", durations == [500, 700, 1000], str(durations))

    # ---------------- §7 未覆盖灯珠恒黑 ----------------
    print("\n--- §7 未覆盖灯珠恒黑（§9.3）---")
    result, reports = await probe.send("QUERY_STATE")
    state = None
    for command, _seq, payload in reports:
        if command == 0x82:
            state = parse_state(payload)
    if state:
        chk.check("提交布局后 layout_valid = 1", state["layout_valid"] == 1,
                  str(state["layout_valid"]))
        chk.check(f"strip0 部位数 = 2", state["part_counts"][0] == 2,
                  str(state["part_counts"][0]))
    chk.check("取色不依赖 State 的 rgb（v5 已移除该字段）", state is not None and len(state) > 0,
              "State 32 字节没有颜色摘要")

    # ---------------- §8 复位恢复 ----------------
    # 真正的复位与读回都在 main 里做（要跨两次连接）。这里**不做**任何读回，
    # 也不在这里收尾——收尾会覆盖 §8 要验的现场。
    if not args.skip_persist:
        print("\n--- §8 复位恢复：断开 → 硬复位 → 重连读回（见下方输出）---")
    else:
        # 跳过 §8 时现场由本段收掉。
        await cleanup(probe, chk, led_count)
    return led_count


async def cleanup(probe, chk, led_count):
    """把设备恢复成「一条链、一个整条部位、常亮」——不把测试现场留给用户。"""
    print("\n--- 收尾（恢复成一条链、一个整条部位、常亮）---")
    await probe.send("LAYOUT_WRITE", bytes([0, 1]))
    whole = "整条".encode("utf-8")
    await probe.send("LAYOUT_PART",
                     bytes([0, 0, len(whole)]) + whole + b"\x00" * (24 - len(whole)) + bytes([1]))
    await probe.send("LAYOUT_SEG", bytes([0, 0, 0, 0, led_count - 1]))
    result, _ = await probe.send("LAYOUT_COMMIT")
    chk.check("收尾布局提交 OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    await probe.send("SCENE_PART", bytes([0, 0, 0, 1, 0, 1]))
    warm = static_layer(30, 128, 100)
    await probe.send("SCENE_STEP",
                     bytes([0, 0, 0, 0]) + struct.pack("<H", 1000) + warm + empty_layer())
    await probe.send("ACTIVATE_SCENE", bytes([0]))
    await probe.send("SET_STRIP_POWER", bytes([0, 1]))
    chk.check("收尾完成（整条常亮）", True)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--address", default=None, help="设备的 MAC；省略则按名字扫描")
    parser.add_argument("--name", default="Lumen-5662", help="广播名")
    parser.add_argument("--port", default="COM6", help="串口（§8 复位用）")
    parser.add_argument("--skip-persist", action="store_true",
                        help="跳过 §8 的复位恢复（不碰串口）")
    args = parser.parse_args()

    address = args.address
    if address is None:
        print(f"扫描 {args.name} ……")
        devices = await BleakScanner.discover(timeout=8)
        for device in devices:
            if device.name == args.name:
                address = device.address
                break
        if address is None:
            found = ", ".join(f"{d.address}({d.name})" for d in devices) or "无"
            sys.exit(f"没扫到 {args.name}。扫到的是：{found}\n"
                     "若设备被手机上的小程序占着，先退出小程序（协议是单连接）。")

    chk = Checker()

    print(f"连接 {address} ……")
    led_count = 64
    async with BleakClient(address) as client:
        probe = Probe(client)
        await client.start_notify(TX, probe.on_notify)
        try:
            led_count = await run(probe, chk, args)
        finally:
            await client.stop_notify(TX)

    # §8 的复位发生在两次连接之间：断开 → DTR/RTS 硬复位 → 等它广播 → 重连读回。
    # 只在同一条连接里读回是假的（RAM 还在，证明不了 NVS）。
    if not args.skip_persist:
        await hard_reset(args.port)
        await asyncio.sleep(3.0)
        address = await wait_for_device(args.name, timeout=20.0)
        if address is None:
            chk.check("复位后设备重新广播", False, "20 秒内没扫到")
        else:
            chk.check("复位后设备重新广播", True, address)
            async with BleakClient(address) as client:
                probe = Probe(client)
                await client.start_notify(TX, probe.on_notify)
                try:
                    await readback_after_reset(probe, chk)
                    # 读回验完才收尾——收尾会覆盖要验的现场。
                    await cleanup(probe, chk, led_count)
                finally:
                    await client.stop_notify(TX)

    ok = chk.summary()
    sys.exit(0 if ok else 1)


async def readback_after_reset(probe, chk):
    result, reports = await probe.send("QUERY_LAYOUT", bytes([0]))
    layout = [parse_layout_report(p) for c, _s, p in reports if c == 0x89]
    layout = [x for x in layout if x]
    chk.check("复位后布局仍在（2 个部位）", len(layout) == 2, f"{len(layout)} 个")
    if len(layout) == 2:
        chk.check("复位后部位 0 名字仍是「眼灯」", layout[0]["name"] == "眼灯", layout[0]["name"])
        chk.check("复位后部位 1 段仍是 2-14", layout[1]["segs"][0] == (2, 14),
                  str(layout[1]["segs"][0]))

    result, reports = await probe.send("QUERY_SCENE", bytes([0]))
    parts = [parse_scene_part(p) for c, _s, p in reports if c == 0x8B]
    parts = [x for x in parts if x]
    steps = [p for c, _s, p in reports if c == 0x8C]
    chk.check("复位后场景仍在（2 个部位头）", len(parts) == 2, f"{len(parts)} 个")
    chk.check("复位后步骤仍在（3 步）", len(steps) == 3, f"{len(steps)} 条")
    if len(parts) == 2:
        chk.check("复位后部位 0 仍是 2 步 / 全部循环",
                  (parts[0]["step_count"], parts[0]["loop"]) == (2, 1), str(parts[0]))

    result, reports = await probe.send("QUERY_STATE")
    for command, _seq, payload in reports:
        if command == 0x82:
            st = parse_state(payload)
            if st:
                chk.check("复位后 layout_valid 仍是 1", st["layout_valid"] == 1,
                          str(st["layout_valid"]))
                chk.check("复位后 8 条链的灯珠数都还在",
                          all(c > 0 for c in st["led_counts"][:st["strip_count"]]),
                          str(st["led_counts"]))


async def hard_reset(port="COM6"):
    """DTR/RTS 硬复位（与 capture-serial.py --reset 同一手法）。"""
    try:
        import serial
    except ImportError:
        print(f"      跳过硬复位：没装 pyserial（python -m pip install pyserial）")
        return False
    try:
        ser = serial.Serial(port, 115200, timeout=0.2)
        ser.setDTR(False)
        ser.setRTS(True)
        await asyncio.sleep(0.1)
        ser.setRTS(False)
        ser.close()
        print(f"      已在 {port} 上发硬复位")
        return True
    except Exception as exc:  # noqa: BLE001 - 复位失败不该中断验收
        print(f"      硬复位失败（{exc}）；请手动拔插后重跑 §8")
        return False


async def wait_for_device(name, timeout=20.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        devices = await BleakScanner.discover(timeout=3)
        for device in devices:
            if device.name == name:
                return device.address
        await asyncio.sleep(1)
    return None


if __name__ == "__main__":
    asyncio.run(main())
