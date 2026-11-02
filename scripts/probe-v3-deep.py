#!/usr/bin/env python
"""v3 深层真机探针：#46 里「设备侧可判定、只差人眼」的那一半。

`probe-v3.py` 覆盖协议字节与 ACK；本脚本覆盖**行为语义**，逐项对应
`docs/acceptance-v3.md` 的条目：

  §1.4.4  强行下发单层带 blend=1 → InvalidParam，且旧段配置逐字节不变
  §1.5.1  4 阶段剧本按时长推进，stage_index 与时长一致，非循环播完停在末阶段
  §1.5.2  播放中断开 BLE，2.2s 后重连：剧本仍在播且已推进（不依赖手机）
  §1.5.3  4 套剧本摘要彼此独立（QueryScript × 4，stage_count 各不相同）
  §1.5.4  4 套剧本各自下发、激活互不覆盖
  §1.5.7  ScriptStage duration=0 被拒
  §1.6.2  绕过预检强行 commit 第二套 8×8×8 两层动画 → 0x0A，不提交
  §1.6.3  失败后上一套仍可激活并播放
  §1.2.1  关一条带：pmask 位清零、其它带动画继续（amask 不变）
  §1.2.2  关带时串口出现「已推黑帧」（WS2812B 锁存的清除机制）
  §1.2.3  重开后 pmask 位恢复，动画继续
  §1.2.5  自检序列红→绿→蓝→白（串口四步），且自检安排在关带之后仍执行

**不算闭环的部分**（本脚本会在结论里写明）：颜色好不好看、有无残影、
chip 显示、提交前提示、多设备、400s 录像 —— 那些仍需要人眼 / 手机 / 相机。

用法（仓库根，设备空闲、小程序退到后台）：

    python scripts/probe-v3-deep.py --serial COM6 --json .runs/v3/deep.json
    python scripts/probe-v3-deep.py --no-serial --skip-heavy   # 跳过 ~900 帧的过大剧本

注意：本脚本会改写设备上的段、pmask 与剧本槽位（最后会尽量恢复）。
"""

import argparse
import asyncio
import json
import struct
import sys
import threading
import time
from datetime import datetime, timezone

try:
    import serial
except ImportError:
    serial = None

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.exit("需要 bleak：python -m pip install bleak")

MAGIC = 0xA6
VERSION = 0x03
SERVICE = "6c756d65-6e00-4b1e-9a3c-000000000001"
RX = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX = "6c756d65-6e00-4b1e-9a3c-000000000003"
STATE_CHAR = "6c756d65-6e00-4b1e-9a3c-000000000004"

CMD = {
    "SetPower": 0x01, "SetBrightness": 0x02, "QueryState": 0x05,
    "SelfTest": 0x07, "SetSegment": 0x10, "ClearSegment": 0x11, "QueryStrip": 0x12,
    "SetPlayback": 0x13, "ScriptBegin": 0x14, "ScriptStage": 0x15,
    "ScriptSegment": 0x16, "ScriptCommit": 0x17, "ScriptAbort": 0x18,
    "ActivateScript": 0x19, "QueryScript": 0x1A, "SetStripPower": 0x1B,
    "QueryStripConfig": 0x1C, "QueryDeviceInfo": 0x1D,
}
ACK, EVENT, STATE_REPORT, SEGMENT_REPORT = 0x80, 0x81, 0x82, 0x83
SEGMENT_LIST_END, SCRIPT_SUMMARY = 0x84, 0x85
SCRIPT_TOO_LARGE = 0x0A
RESULT = {
    0: "OK", 1: "InvalidParam", 2: "UnknownCommand", 3: "BadChecksum",
    4: "BadLength", 5: "Busy", 6: "StorageFailed", 7: "UnsupportedVersion",
    8: "BadMagic", 9: "InternalError", 10: "ScriptTooLarge",
}
STATIC, BREATHING, RAINBOW, COMET, EMPTY = 0x00, 0x01, 0x02, 0x03, 0xFF
BLEND_OVER, BLEND_MULTIPLY, BLEND_ADD = 0, 1, 2

reports = []
serial_lines = []


def check(item, name, ok, detail="", evidence=""):
    entry = {
        "item": item,
        "name": name,
        "ok": bool(ok),
        "detail": detail,
        "evidence": evidence,
    }
    reports.append(entry)
    print(("  PASS  " if ok else "  FAIL  ") + f"[{item}] " + name + (("  — " + detail) if detail else ""))
    return ok


def note(text):
    print(f"        · {text}")


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return crc


def encode(cmd: int, seq: int, payload: bytes = b"") -> bytes:
    body = bytes([MAGIC, VERSION, cmd, seq]) + struct.pack("<H", len(payload)) + payload
    return body + struct.pack("<H", crc16(body))


def decode(buf: bytes):
    if len(buf) < 8 or buf[0] != MAGIC or buf[1] != VERSION:
        return None
    cmd, seq = buf[2], buf[3]
    (length,) = struct.unpack("<H", buf[4:6])
    if len(buf) != 8 + length:
        return None
    if struct.unpack("<H", buf[6 + length:8 + length])[0] != crc16(buf[:6 + length]):
        return None
    return cmd, seq, buf[6:6 + length]


def layer_static(hue: int, sat: int = 255) -> bytes:
    return bytes([STATIC]) + struct.pack("<H", hue & 0xFFFF) + bytes([sat & 0xFF]) + bytes(4)


def layer_anim(typ: int, hue: int, sat: int, period: int, p5: int, flags: int = 0) -> bytes:
    return (bytes([typ]) + struct.pack("<H", hue & 0xFFFF) + bytes([sat & 0xFF])
            + struct.pack("<H", period & 0xFFFF) + bytes([p5 & 0xFF, flags & 0xFF]))


def layer_empty() -> bytes:
    return bytes([EMPTY]) + bytes(7)


def segment(strip, seg, start, end, blend, l0: bytes, l1: bytes) -> bytes:
    assert len(l0) == 8 and len(l1) == 8
    return bytes([strip, seg, start, end, blend]) + l0 + l1


class Link:
    def __init__(self, client):
        self.client = client
        mtu = getattr(client, "mtu_size", 23) or 23
        self.cap = min(max(mtu - 3, 20), 180)
        self.data_cap = self.cap - 1
        self.rx = bytearray()
        self.frames = []
        self.seq = 0

    def on_notify(self, _char, data: bytearray):
        raw = bytes(data)
        if not raw:
            return
        ctrl = raw[0]
        if ctrl & 0x80:
            self.rx = bytearray()
        self.rx += raw[1:]
        if ctrl & 0x40:
            f = decode(bytes(self.rx))
            if f:
                self.frames.append(f)
            self.rx = bytearray()

    async def write_frame(self, cmd, payload=b""):
        self.seq = (self.seq % 0xFF) + 1
        frame = encode(cmd, self.seq, payload)
        chunks = [frame[i:i + self.data_cap] for i in range(0, len(frame), self.data_cap)]
        for i, ch in enumerate(chunks):
            ctrl = (0x80 if i == 0 else 0) | (0x40 if i == len(chunks) - 1 else 0) | (i & 0x3F)
            await self.client.write_gatt_char(RX, bytes([ctrl]) + ch, response=False)
        return self.seq

    async def wait(self, want, timeout=3.0, seq=None):
        got, deadline = [], time.monotonic() + timeout
        while time.monotonic() < deadline:
            while self.frames:
                f = self.frames.pop(0)
                if f[0] in want and (seq is None or f[1] == seq):
                    got.append(f)
                    return got[0]
            await asyncio.sleep(0.01)
        return None

    async def cmd(self, name, payload=b"", timeout=3.0):
        seq = await self.write_frame(CMD[name], payload)
        ack = await self.wait({ACK}, timeout, seq)
        if ack is None:
            return None
        return {"seq": seq, "orig": ack[2][0], "result": ack[2][1],
                "result_name": RESULT.get(ack[2][1], "?")}

    async def state(self):
        return bytes(await self.client.read_gatt_char(STATE_CHAR))

    async def query_script(self, script_id):
        seq = await self.write_frame(CMD["QueryScript"], bytes([script_id]))
        ack = await self.wait({ACK}, 2.0, seq)
        summary = await self.wait({SCRIPT_SUMMARY}, 2.0)
        return ack, summary

    async def query_strip(self, strip_id):
        seq = await self.write_frame(CMD["QueryStrip"], bytes([strip_id]))
        await self.wait({ACK}, 2.0, seq)
        records, deadline = [], time.monotonic() + 2.0
        while time.monotonic() < deadline:
            f = await self.wait({SEGMENT_REPORT, SEGMENT_LIST_END}, 0.3)
            if f is None:
                continue
            if f[0] == SEGMENT_LIST_END:
                break
            records.append(bytes(f[2]))
        return records


def parse_state(st: bytes) -> dict:
    if len(st) != 37:
        raise SystemExit(f"State 长度应为 37，实际 {len(st)}")
    return {
        "power": st[0], "brightness": st[1], "max_brightness": st[5],
        "strip_count": st[6], "script_id": st[7], "stage_index": st[8],
        "playback_state": st[9], "flags": st[10],
        "strip_power_mask": st[11], "strip_anim_mask": st[12],
        "strip_counts": [int.from_bytes(st[13 + 2 * i:15 + 2 * i], "little") for i in range(8)],
        "strip_seg_counts": list(st[29:37]),
    }


async def clear_all_segments(link):
    for s in range(8):
        for seg in range(8):
            await link.cmd("ClearSegment", bytes([s, seg]), timeout=1.0)


async def set_all_strip_power(link, mask):
    for s in range(8):
        await link.cmd("SetStripPower", bytes([s, 1 if (mask >> s) & 1 else 0]))


def animation_segment(strip, seg, start, end) -> bytes:
    l0 = layer_anim(RAINBOW, 0x1000 * (strip + 1), 255, 1000, 200)
    l1 = layer_anim(BREATHING, 0x0800 + strip * 1000, 200, 1000, 30)
    return bytes([strip, seg, start, end, BLEND_MULTIPLY]) + l0 + l1


async def send_full_script(link, script_id, stages=8, strips=8, segs=8, progress=True):
    """8 带 × 8 阶段 × 8 段两层动画（记录 19B，单套 9835B）。"""
    began = await link.cmd("ScriptBegin", bytes([script_id, stages, strips]))
    if not began or began["result"] != 0:
        return False, f"ScriptBegin {began and began['result_name']}"
    for st in range(stages):
        r = await link.cmd("ScriptStage", bytes([script_id, st]) + struct.pack("<HH", 1000, 0))
        if not r or r["result"] != 0:
            return False, f"ScriptStage st={st} {r and r['result_name']}"
        for strip in range(strips):
            for seg in range(segs):
                payload = bytes([script_id, st]) + animation_segment(strip, seg, seg, seg)
                r = await link.cmd("ScriptSegment", payload)
                if not r or r["result"] != 0:
                    return False, f"ScriptSegment st={st} strip={strip} seg={seg} " \
                                  f"{r and r['result_name']}"
        if progress:
            print(f"        · 阶段 {st + 1}/{stages} 已下发（{strips} 带 × {segs} 段）", end="\r")
    if progress:
        print()
    return True, "ok"


async def shrink_script(link, script_id):
    """把槽位覆写成最小合法剧本（1 阶段 1 带 1 段），用于腾出持久化预算。"""
    await link.cmd("ScriptBegin", bytes([script_id, 1, 1]))
    await link.cmd("ScriptStage", bytes([script_id, 0]) + struct.pack("<HH", 1000, 0))
    payload = bytes([script_id, 0]) + segment(0, 0, 0, 0, BLEND_OVER,
                                              layer_static(script_id * 8000), layer_empty())
    await link.cmd("ScriptSegment", payload)
    return await link.cmd("ScriptCommit", bytes([script_id]))


async def group_144_rollback(link):
    print("\n== §1.4.4 非法 blend 被拒且旧配置不变 ==")
    await clear_all_segments(link)
    green = layer_static(0x5555, 255)  # 约 120°
    r = await link.cmd("SetSegment", segment(0, 0, 0, 9, BLEND_OVER, green, layer_empty()))
    check("1.4.4", "基线段下发成功", bool(r and r["result"] == 0), r and r["result_name"])
    baseline = await link.query_strip(0)
    check("1.4.4", "基线 QueryStrip 读回 1 条段", len(baseline) == 1, f"{len(baseline)} 条")

    bad = segment(0, 1, 10, 15, BLEND_MULTIPLY, layer_static(0xFFFF), layer_empty())
    r = await link.cmd("SetSegment", bad)
    check("1.4.4", "单层带 blend=1 被拒 InvalidParam", bool(r and r["result"] == 1),
          r and r["result_name"])

    after = await link.query_strip(0)
    same = after == baseline
    check("1.4.4", "被拒后段配置逐字节不变", same,
          f"{len(after)} 条 / 基线 {len(baseline)} 条",
          evidence=(after[0].hex() if after else "空"))
    await clear_all_segments(link)


async def group_1554_four_scripts(link):
    print("\n== §1.5.3 / §1.5.4 四套剧本各自独立 ==")
    for script_id in range(4):
        stages = script_id + 1
        await link.cmd("ScriptBegin", bytes([script_id, stages, 1]))
        for st in range(stages):
            await link.cmd("ScriptStage",
                           bytes([script_id, st]) + struct.pack("<HH", 700 + st * 100, 0))
            payload = bytes([script_id, st]) + segment(0, 0, 0, 4, BLEND_OVER,
                                                       layer_static(script_id * 8000), layer_empty())
            await link.cmd("ScriptSegment", payload)
        r = await link.cmd("ScriptCommit", bytes([script_id]))
        check("1.5.4", f"剧本 {script_id}（{stages} 阶段）提交", bool(r and r["result"] == 0),
              r and r["result_name"])

    summaries = {}
    for script_id in range(4):
        _, summary = await link.query_script(script_id)
        if summary is None:
            check("1.5.3", f"剧本 {script_id} 有摘要", False, "无 ScriptSummary")
            continue
        p = summary[2]
        summaries[script_id] = {"stage_count": p[1], "flags": p[2], "active": p[3]}
        check("1.5.3", f"剧本 {script_id} 摘要 stage_count == {script_id + 1}",
              p[1] == script_id + 1, f"stages={p[1]} flags=0x{p[2]:02X} active={p[3]}")

    r = await link.cmd("ActivateScript", bytes([2, 0]))
    check("1.5.4", "激活剧本 2", bool(r and r["result"] == 0), r and r["result_name"])
    await asyncio.sleep(0.3)
    for script_id in range(4):
        _, summary = await link.query_script(script_id)
        active = summary[2][3] if summary else None
        want = 1 if script_id == 2 else 0
        check("1.5.4", f"激活后只有剧本 2 的 active=1（剧本 {script_id}={active}）",
              active == want, f"active={active}")
    st = parse_state(await link.state())
    check("1.5.3", "State.script_id 与激活剧本一致", st["script_id"] == 2,
          f"script_id={st['script_id']}")
    await link.cmd("SetPlayback", bytes([0, 0]))


async def sample_stages(link, seconds, interval=0.08):
    samples = []
    t0 = time.monotonic()
    while time.monotonic() - t0 < seconds:
        st = parse_state(await link.state())
        samples.append((time.monotonic() - t0, st["stage_index"], st["playback_state"]))
        await asyncio.sleep(interval)
    return samples


async def group_151_progression(link):
    print("\n== §1.5.1 4 阶段按时长推进 ==")
    durations = [800, 1200, 800, 1200]
    sid = 3
    await link.cmd("ScriptBegin", bytes([sid, 4, 1]))
    # §1.5.7：duration=0 必须被拒
    r0 = await link.cmd("ScriptStage", bytes([sid, 0]) + struct.pack("<HH", 0, 0))
    check("1.5.7", "ScriptStage duration=0 被拒 InvalidParam", bool(r0 and r0["result"] == 1),
          r0 and r0["result_name"])
    for st, dur in enumerate(durations):
        await link.cmd("ScriptStage", bytes([sid, st]) + struct.pack("<HH", dur, 0))
        payload = bytes([sid, st]) + segment(0, 0, 0, 9, BLEND_OVER,
                                             layer_static(0x1000 * (st + 1)), layer_empty())
        await link.cmd("ScriptSegment", payload)
    r = await link.cmd("ScriptCommit", bytes([sid]))
    check("1.5.1", "4 阶段剧本提交", bool(r and r["result"] == 0), r and r["result_name"])

    r = await link.cmd("ActivateScript", bytes([sid, 0]))
    check("1.5.1", "激活剧本 3", bool(r and r["result"] == 0), r and r["result_name"])
    r = await link.cmd("SetPlayback", bytes([1, 0]))
    check("1.5.1", "开始播放", bool(r and r["result"] == 0), r and r["result_name"])

    samples = await sample_stages(link, sum(durations) / 1000.0 + 1.6)
    transitions = []
    last = None
    for t, stage, playback in samples:
        if last is not None and stage != last:
            transitions.append((t, stage))
        last = stage
    expected = []
    acc = 0
    for i, dur in enumerate(durations[:-1]):
        acc += dur
        expected.append((acc / 1000.0, i + 1))
    note(f"实测阶段切换：{[(round(t, 2), s) for t, s in transitions]}")
    note(f"期望（累计时长）：{[(round(t, 2), s) for t, s in expected]}")
    check("1.5.1", "阶段按顺序推进到第 4 阶段",
          [s for _, s in transitions] == [1, 2, 3],
          str([s for _, s in transitions]))
    ok_timing = len(transitions) == len(expected) and all(
        abs(t - et) <= 0.30 for (t, _), (et, _) in zip(transitions, expected))
    check("1.5.1", "切换时刻与累计时长一致（±300ms）", ok_timing,
          ", ".join(f"{t:.2f}s vs {et:.2f}s" for (t, _), (et, _) in zip(transitions, expected)))

    final = parse_state(await link.state())
    check("1.5.1", "非循环播完停在末阶段且 state=STOPPED",
          final["stage_index"] == 3 and final["playback_state"] == 0,
          f"stage={final['stage_index']} playback={final['playback_state']}")
    return final


async def group_152_disconnect(dev_address):
    print("\n== §1.5.2 播放中断连，剧本继续 ==")
    # 用**专用长阶段剧本**（3 × 6s，loop=1）：断连 + 重连的扫描/连接开销
    # 本身就有 1~2s，4s 的剧本会在重连完成前播完，测不出「继续推进」。
    client = BleakClient(dev_address, timeout=20.0)
    await client.connect()
    link = Link(client)
    await client.start_notify(TX, link.on_notify)
    try:
        # 8 × 3s = 24s 总长，远大于 4~6s 的离线窗口：这样「推进」不会因为
        # loop 回绕而落回原阶段，判定是确定性的。
        sid, durations = 1, [3000] * 8
        await link.cmd("ScriptBegin", bytes([sid, len(durations), 1]))
        for st, dur in enumerate(durations):
            await link.cmd("ScriptStage", bytes([sid, st]) + struct.pack("<HH", dur, 0))
            payload = bytes([sid, st]) + segment(0, 0, 0, 9, BLEND_OVER,
                                                 layer_static(0x1000 * (st + 1)), layer_empty())
            await link.cmd("ScriptSegment", payload)
        r = await link.cmd("ScriptCommit", bytes([sid]))
        check("1.5.2", "8 阶段剧本（8×3s）提交", bool(r and r["result"] == 0),
              r and r["result_name"])
        r = await link.cmd("ActivateScript", bytes([sid, 1]))  # loop=1
        check("1.5.2", "以 loop=1 激活", bool(r and r["result"] == 0), r and r["result_name"])
        # 注意：SetPlayback 的 loop 参数在每次调用时都会写进 playback.loop，
        # 所以这里必须**也传 1**，否则会把激活时的 loop=1 覆盖成 0。
        r = await link.cmd("SetPlayback", bytes([1, 1]))
        check("1.5.2", "开始播放（loop=1 保持）", bool(r and r["result"] == 0),
              r and r["result_name"])
        await asyncio.sleep(0.5)
        before = parse_state(await link.state())
        note(f"断开前 stage={before['stage_index']} playback={before['playback_state']} "
             f"flags=0x{before['flags']:02X}")
    finally:
        await client.stop_notify(TX)
        await client.disconnect()

    disconnected_at = time.monotonic()
    await asyncio.sleep(2.2)

    client = BleakClient(dev_address, timeout=20.0)
    await client.connect()
    link = Link(client)
    await client.start_notify(TX, link.on_notify)
    try:
        after = parse_state(await link.state())
    finally:
        await client.stop_notify(TX)
        await client.disconnect()

    offline = time.monotonic() - disconnected_at
    note(f"离线 {offline:.1f}s 后 stage={after['stage_index']} "
         f"playback={after['playback_state']} script={after['script_id']}")
    check("1.5.2", "重连后剧本仍是激活状态", after["script_id"] == 1, f"script={after['script_id']}")
    check("1.5.2", "断连期间剧本未停（playback_state=1）", after["playback_state"] == 1,
          f"playback={after['playback_state']}")
    check("1.5.2", "断连期间播放头继续推进（不依赖手机）",
          after["stage_index"] != before["stage_index"],
          f"stage {before['stage_index']} -> {after['stage_index']}")


async def group_12_strip_power(link, serial_mark):
    print("\n== §1.2.1 / §1.2.2 / §1.2.3 每带开关行为 ==")
    # 必须先停播放：非循环剧本播完会 hold_last，`active_segments_locked()`
    # 仍然返回**剧本最后一阶段**的段配置，State 的 amask / seg_counts 都读它。
    # 不停的话，下面写入的静态段在 State 里看不到（踩过：amask 恒 0）。
    await link.cmd("SetPlayback", bytes([0, 0]))
    await asyncio.sleep(0.2)
    await clear_all_segments(link)
    await link.cmd("SetPower", b"\x01")
    await link.cmd("SetBrightness", bytes([60]))
    await set_all_strip_power(link, 0xFF)
    for s in range(8):
        payload = segment(s, 0, 0, 29, BLEND_OVER,
                          layer_anim(BREATHING, 0x1000 * (s + 1), 255, 1000, 0), layer_empty())
        await link.cmd("SetSegment", payload)
    await asyncio.sleep(0.4)
    st = parse_state(await link.state())
    check("1.2.1", "8 条带都有动画段（amask=0xFF）", st["strip_anim_mask"] == 0xFF,
          f"amask=0x{st['strip_anim_mask']:02X}")

    mark = len(serial_lines)
    r = await link.cmd("SetStripPower", bytes([3, 0]))
    await asyncio.sleep(0.6)
    st_off = parse_state(await link.state())
    check("1.2.1", "关第 3 条后 pmask bit3 清零", not (st_off["strip_power_mask"] & 0x08),
          f"pmask=0x{st_off['strip_power_mask']:02X}")
    check("1.2.1", "其余 7 条仍在跑动画（amask 不变）", st_off["strip_anim_mask"] == 0xFF,
          f"amask=0x{st_off['strip_anim_mask']:02X}")
    black_log = [l for l in serial_lines[mark:] if "strip 3 关闭：已推黑帧" in l]
    check("1.2.2", "串口出现「strip 3 关闭：已推黑帧」", bool(black_log),
          black_log[0].strip() if black_log else "串口未捕获（见 --serial）")

    r = await link.cmd("SetStripPower", bytes([3, 1]))
    await asyncio.sleep(0.6)
    st_on = parse_state(await link.state())
    check("1.2.3", "重开第 3 条后 pmask bit3 恢复", bool(st_on["strip_power_mask"] & 0x08),
          f"pmask=0x{st_on['strip_power_mask']:02X}")
    check("1.2.3", "重开后动画段仍在（无需重设段）", st_on["strip_seg_counts"][3] >= 1,
          f"seg_count[3]={st_on['strip_seg_counts'][3]}")
    return st_on


async def group_125_selftest(link, serial_mark):
    print("\n== §1.2.5 自检序列（关带后仍执行） ==")
    await set_all_strip_power(link, 0x80)  # 只留第 7 条开，其余关
    await asyncio.sleep(0.3)
    mark = len(serial_lines)
    r = await link.cmd("SelfTest")
    check("1.2.5", "SelfTest ACK OK", bool(r and r["result"] == 0), r and r["result_name"])
    await asyncio.sleep(3.0)
    steps = [l for l in serial_lines[mark:] if "自检 " in l]
    names = []
    for line in steps:
        for n in ("red", "green", "blue", "white"):
            if f" {n} " in line:
                names.append(n)
    note(f"串口自检步进：{names}")
    check("1.2.5", "自检走完红→绿→蓝→白（4 步）", names[:4] == ["red", "green", "blue", "white"],
          str(names[:4]))
    st = parse_state(await link.state())
    check("1.2.5", "自检不改变每带开关（pmask=0x80 保持）", st["strip_power_mask"] == 0x80,
          f"pmask=0x{st['strip_power_mask']:02X}")
    await set_all_strip_power(link, 0xFF)


async def group_16_too_large(link):
    print("\n== §1.6.1 / §1.6.2 / §1.6.3 剧本过大与回滚 ==")
    for sid in range(4):
        r = await shrink_script(link, sid)
        check("1.6.2", f"预处理：槽位 {sid} 缩到最小剧本",
              bool(r and r["result"] == 0), r and r["result_name"])

    # 失败回滚的正确判据是「**保持原样**」，不是「变成空」：槽位 1 本来就
    # 有一套 1 阶段的最小剧本，commit 失败后它必须还是那套，而不是被覆盖成
    # 新下发的 8 阶段。
    _, before1 = await link.query_script(1)
    before1_stages = before1[2][1] if before1 else None
    note(f"下发前槽位 1 摘要：stages={before1_stages}")

    ok, detail = await send_full_script(link, 0)
    check("1.6.1", "第一套 8带×8阶段×8段两层动画下发", ok, detail)
    r = await link.cmd("ScriptCommit", bytes([0]))
    check("1.6.1", "第一套提交成功（单套约 9835B）", bool(r and r["result"] == 0),
          r and r["result_name"])

    ok, detail = await send_full_script(link, 1)
    check("1.6.1", "第二套同尺寸剧本下发", ok, detail)
    r = await link.cmd("ScriptCommit", bytes([1]))
    check("1.6.2", "第二套 commit 回 0x0A ScriptTooLarge",
          bool(r and r["result"] == SCRIPT_TOO_LARGE), r and r["result_name"])

    _, s0 = await link.query_script(0)
    _, s1 = await link.query_script(1)
    check("1.6.2", "失败后剧本 0 未被改动（stages=8）",
          bool(s0 and s0[2][1] == 8), f"stages={s0[2][1] if s0 else '?'}")
    check("1.6.2", "失败后剧本 1 保持原样（未被 8 阶段覆盖）",
          bool(s1 and s1[2][1] == before1_stages and s1[2][1] != 8),
          f"stages={s1[2][1] if s1 else '?'}（下发前 {before1_stages}）")

    r = await link.cmd("ActivateScript", bytes([0, 1]))
    check("1.6.3", "上一套仍可激活", bool(r and r["result"] == 0), r and r["result_name"])
    r = await link.cmd("SetPlayback", bytes([1, 0]))
    await asyncio.sleep(2.4)
    st = parse_state(await link.state())
    check("1.6.3", "上一套仍可播放（stage_index 已推进）",
          st["playback_state"] == 1 and st["stage_index"] >= 1,
          f"stage={st['stage_index']} playback={st['playback_state']}")
    await link.cmd("SetPlayback", bytes([0, 0]))


async def group_11_strip_independence(link):
    print("\n== §1.1.1 / §1.1.2 / §1.1.4 逐带独立（设备侧数据） ==")
    await link.cmd("SetPlayback", bytes([0, 0]))
    await clear_all_segments(link)
    await link.cmd("SetPower", b"\x01")
    await set_all_strip_power(link, 0xFF)

    # 1.1.1：只给 strip 0 设 0-9 红色
    red = layer_static(0x0000, 255)
    r = await link.cmd("SetSegment", segment(0, 0, 0, 9, BLEND_OVER, red, layer_empty()))
    check("1.1.1", "strip 0 设 0-9 红色 ACK OK", bool(r and r["result"] == 0),
          r and r["result_name"])
    after0 = await link.query_strip(0)
    others = [await link.query_strip(s) for s in (1, 2, 3)]
    check("1.1.1", "strip 0 有 1 条段", len(after0) == 1, f"{len(after0)} 条")
    check("1.1.1", "strip 1/2/3 无段（未被波及）",
          all(len(o) == 0 for o in others), str([len(o) for o in others]))
    st = parse_state(await link.state())
    check("1.1.1", "State 段数只在 strip 0 变化",
          st["strip_seg_counts"][0] == 1 and st["strip_seg_counts"][1:4] == [0, 0, 0],
          str(st["strip_seg_counts"]))

    # 1.1.2：切到 strip 1 设 0-9 绿色
    green = layer_static(0x5555, 255)
    r = await link.cmd("SetSegment", segment(1, 0, 0, 9, BLEND_OVER, green, layer_empty()))
    check("1.1.2", "strip 1 设 0-9 绿色 ACK OK", bool(r and r["result"] == 0),
          r and r["result_name"])
    strip0_after = await link.query_strip(0)
    strip1_after = await link.query_strip(1)
    check("1.1.2", "strip 0 的红色段逐字节不变", strip0_after == after0,
          evidence=strip0_after[0].hex() if strip0_after else "空")
    check("1.1.2", "strip 1 出现自己的段且与 strip 0 不同",
          len(strip1_after) == 1 and strip1_after[0] != after0[0],
          evidence=strip1_after[0].hex() if strip1_after else "空")

    # 1.1.4：chip 的数据源必须逐带真实，不能把 strip 0 复制给所有带
    rows = []
    for s in range(8):
        recs = await link.query_strip(s)
        rows.append(len(recs))
    st = parse_state(await link.state())
    check("1.1.4", "State.strip_seg_counts 逐带真实（0/1 各 1，其余 0）",
          st["strip_seg_counts"] == [1, 1, 0, 0, 0, 0, 0, 0], str(st["strip_seg_counts"]))
    check("1.1.4", "QueryStrip 逐带真实（不是复制 strip 0）",
          rows == [1, 1, 0, 0, 0, 0, 0, 0], str(rows))
    check("1.1.4", "strip_counts 逐带为 u16 且非 0", all(c > 0 for c in st["strip_counts"]),
          str(st["strip_counts"]))
    await clear_all_segments(link)


async def group_14_ranges(link):
    print("\n== §1.4.1 / §1.4.2 / §1.4.5 区间、重叠与隔离（设备侧） ==")
    await clear_all_segments(link)
    await link.cmd("SetPower", b"\x01")
    await set_all_strip_power(link, 0xFF)
    led_count = parse_state(await link.state())["strip_counts"][0]

    # 1.4.1：同带重叠必须被设备拒绝
    r = await link.cmd("SetSegment", segment(0, 0, 0, 15, BLEND_OVER,
                                             layer_static(0x0000), layer_empty()))
    check("1.4.1", "先设 0-15", bool(r and r["result"] == 0), r and r["result_name"])
    r = await link.cmd("SetSegment", segment(0, 1, 10, 20, BLEND_OVER,
                                             layer_static(0x5555), layer_empty()))
    check("1.4.1", "再设 10-20（重叠）被拒 InvalidParam", bool(r and r["result"] == 1),
          r and r["result_name"])
    recs = await link.query_strip(0)
    check("1.4.1", "被拒后只剩原来的 0-15", len(recs) == 1, f"{len(recs)} 条")

    # 1.4.2：超出该带灯珠数必须被设备拒绝
    r = await link.cmd("SetSegment", segment(0, 2, 0, 40, BLEND_OVER,
                                             layer_static(0xAAAA), layer_empty()))
    check("1.4.2", f"0-40 超出灯珠数 {led_count} 被拒 InvalidParam",
          bool(r and r["result"] == 1), r and r["result_name"])

    # 1.4.5：改第 3 条带不影响第 1、2 条
    await clear_all_segments(link)
    for s, hue in ((0, 0x0000), (1, 0x5555)):
        await link.cmd("SetSegment", segment(s, 0, 0, 9, BLEND_OVER,
                                            layer_static(hue), layer_empty()))
    snap0 = await link.query_strip(0)
    snap1 = await link.query_strip(1)
    r = await link.cmd("SetSegment", segment(2, 0, 0, 9, BLEND_OVER,
                                             layer_static(0xAAAA), layer_empty()))
    check("1.4.5", "改 strip 2 ACK OK", bool(r and r["result"] == 0), r and r["result_name"])
    check("1.4.5", "strip 0 逐字节不变", await link.query_strip(0) == snap0,
          evidence=snap0[0].hex() if snap0 else "空")
    check("1.4.5", "strip 1 逐字节不变", await link.query_strip(1) == snap1,
          evidence=snap1[0].hex() if snap1 else "空")
    await clear_all_segments(link)


async def cleanup(link):
    print("\n== 收尾：停止播放、清段、恢复默认 ==")
    await link.cmd("SetPlayback", bytes([0, 0]))
    await clear_all_segments(link)
    await set_all_strip_power(link, 0xFF)
    await link.cmd("SetBrightness", bytes([128]))
    await link.cmd("SetPower", bytes([0]))
    st = parse_state(await link.state())
    note(f"收尾后 {st}")
    return st


async def main():
    ap = argparse.ArgumentParser(description="#46 设备侧行为语义探针")
    ap.add_argument("--serial", default="COM6")
    ap.add_argument("--no-serial", action="store_true")
    ap.add_argument("--json", default="")
    ap.add_argument("--skip-heavy", action="store_true", help="跳过 ~900 帧的过大剧本测试")
    ap.add_argument("--timeout", type=float, default=20.0)
    args = ap.parse_args()

    ser_stop = threading.Event()

    def pump_serial():
        if args.no_serial or serial is None:
            return
        try:
            sp = serial.Serial(args.serial, 115200, timeout=0.3)
        except Exception as e:  # noqa: BLE001
            print(f"[deep] 串口打开失败（忽略）：{e}")
            return
        while not ser_stop.is_set():
            line = sp.readline()
            if line:
                serial_lines.append(line.decode(errors="replace").rstrip())
        sp.close()

    threading.Thread(target=pump_serial, daemon=True).start()

    print("[deep] 扫描 Lumen-* …")
    dev = None
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline and dev is None:
        found = await BleakScanner.discover(timeout=4.0, service_uuids=[SERVICE])
        for d in found:
            if d.name and d.name.startswith("Lumen-"):
                dev = d
                break
    if dev is None:
        ser_stop.set()
        sys.exit("[deep] 没找到设备。确认已上电、小程序退到后台（协议是单连接）。")

    print(f"[deep] 连接 {dev.name} ({dev.address})")
    meta = {"device": dev.name, "address": dev.address,
            "started_at": datetime.now(timezone.utc).isoformat()}

    client = BleakClient(dev.address, timeout=20.0)
    await client.connect()
    link = Link(client)
    await client.start_notify(TX, link.on_notify)

    try:
        mtu = getattr(client, "mtu_size", 23) or 23
        meta["mtu"] = mtu
        st0 = parse_state(await link.state())
        meta["state_before"] = st0
        note(f"初始 State: power={st0['power']} bright={st0['brightness']} "
             f"pmask=0x{st0['strip_power_mask']:02X} script={st0['script_id']}")

        await group_144_rollback(link)
        await group_11_strip_independence(link)
        await group_14_ranges(link)
        await group_1554_four_scripts(link)
        await group_151_progression(link)
        await group_12_strip_power(link, 0)
        await group_125_selftest(link, 0)
        if args.skip_heavy:
            note("--skip-heavy：跳过 §1.6 的 ~900 帧过大剧本测试")
        else:
            await group_16_too_large(link)
    finally:
        try:
            meta["state_after"] = await cleanup(link)
        except Exception as e:  # noqa: BLE001
            print(f"[deep] 收尾失败：{e}")
        await client.stop_notify(TX)
        await client.disconnect()

    # 断开后仍要跑 §1.5.2（它自己管连接）
    await group_152_disconnect(dev.address)

    # 重连做最后一次收尾（§1.5.2 留下了 loop 播放）
    client = BleakClient(dev.address, timeout=20.0)
    await client.connect()
    link = Link(client)
    await client.start_notify(TX, link.on_notify)
    try:
        meta["state_final"] = await cleanup(link)
    finally:
        await client.stop_notify(TX)
        await client.disconnect()

    ser_stop.set()
    time.sleep(0.3)

    passed = sum(1 for r in reports if r["ok"])
    print("\n" + "=" * 70)
    print(f"结果：{passed}/{len(reports)} 通过")
    fails = [r for r in reports if not r["ok"]]
    if fails:
        print("\n失败项：")
        for r in fails:
            print(f"  - [{r['item']}] {r['name']}  {r['detail']}")
    print("=" * 70)

    if args.json:
        # 只留末尾 200 行会把有用证据冲掉：#1.6 的 900 帧下发会产生上千行 RX。
        # 所以另外抽一份「关键行」摘要，验收归档以它为准。
        keywords = ("ScriptTooLarge", "拒签", "自检", "推黑帧", "激活", "ActivateScript",
                    "ScriptCommit", "ScriptBegin", "SetPlayback", "stage", "恢复", "降级")
        interesting = [l.strip() for l in serial_lines
                       if any(k in l for k in keywords)]
        payload = {
            **meta,
            "passed": passed,
            "total": len(reports),
            "checks": reports,
            "serial_line_count": len(serial_lines),
            "serial_interesting": interesting[-200:],
            "serial_tail": serial_lines[-40:],
        }
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        print(f"[deep] 报告已写入 {args.json}"
              f"（串口 {len(serial_lines)} 行，关键行 {len(interesting)} 条）")

    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
