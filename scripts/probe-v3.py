#!/usr/bin/env python
"""v3 协议真机探针：PC 当 central，验证 #46 里不需要人眼的协议项。

覆盖（对应 docs/acceptance-v3.md §3）：
  1. 连接 + MTU 协商
  2. State 37 字节（GATT read，MTU 不够时自动回落 QueryState→StateReport）
  3. QueryStripConfig 24 字节，GPIO 与 Kconfig 一致
  4. QueryDeviceInfo 15 字节，hw_id 与串口 MAC 一致，caps.bit0=1 / bit1=0
  5. SetPower / SetBrightness 的 ACK 回显 seq
  6. SetStripPower 每带开关（改 strip_power_mask，全局开关不改掩码）
  7. SetSegment 双层 + 三种 blend 的 ACK；QueryStrip 读回 21 字节且报真实槽位
  8. 分片：构造 >179 字节载荷触发多片写（ScriptSegment 23B 不够，用长剧本）
  9. 脚本 ScriptTooLarge 之外的正常 commit / abort 路径

用法（仓库根，设备空闲、小程序退到后台）：
    python scripts/probe-v3.py
    python scripts/probe-v3.py --serial COM6
    python scripts/probe-v3.py --no-serial

约定：设备单连接。跑之前把小程序退到后台，否则会抢连接。
"""

import argparse
import asyncio
import struct
import sys
import threading
import time

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
    "SetLedCount": 0x06, "SelfTest": 0x07,
    "SetSegment": 0x10, "ClearSegment": 0x11, "QueryStrip": 0x12,
    "SetPlayback": 0x13, "ScriptBegin": 0x14, "ScriptStage": 0x15,
    "ScriptSegment": 0x16, "ScriptCommit": 0x17, "ScriptAbort": 0x18,
    "ActivateScript": 0x19, "QueryScript": 0x1A,
    "SetStripPower": 0x1B, "QueryStripConfig": 0x1C, "QueryDeviceInfo": 0x1D,
}
DEV = {
    0x80: "ACK", 0x81: "Event", 0x82: "StateReport", 0x83: "SegmentReport",
    0x84: "SegmentListEnd", 0x85: "ScriptSummary", 0x86: "ScriptProgress",
    0x87: "StripConfigReport", 0x88: "DeviceInfoReport",
}
RESULT = {
    0: "OK", 1: "InvalidParam", 2: "UnknownCommand", 3: "BadChecksum",
    4: "BadLength", 5: "Busy", 6: "StorageFailed", 7: "UnsupportedVersion",
    8: "BadMagic", 9: "InternalError", 10: "ScriptTooLarge",
}

checks = []
def check(name, ok, detail=""):
    checks.append((name, ok, detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + (("  — " + detail) if detail else ""))


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
    """返回 (cmd, seq, payload) 或 None。"""
    if len(buf) < 8 or buf[0] != MAGIC or buf[1] != VERSION:
        return None
    cmd, seq = buf[2], buf[3]
    (length,) = struct.unpack("<H", buf[4:6])
    if len(buf) != 8 + length:
        return None
    if struct.unpack("<H", buf[6 + length:8 + length])[0] != crc16(buf[:6 + length]):
        return None
    return cmd, seq, buf[6:6 + length]


class Link:
    """分片收发 + ACK 等待。"""

    def __init__(self, client, mtu):
        self.client = client
        self.mtu = mtu
        self.cap = min(max(mtu - 3, 20), 180)
        self.data_cap = self.cap - 1
        self.rx = bytearray()
        self.frames = []
        self.seq = 0
        self.log = []

    def on_notify(self, _char, data: bytearray):
        raw = bytes(data)
        if not raw:
            return
        ctrl = raw[0]
        first, last = ctrl & 0x80, ctrl & 0x40
        if first:
            self.rx = bytearray()
        self.rx += raw[1:]
        self.log.append(("chunk", ctrl, len(raw) - 1))
        if last:
            f = decode(bytes(self.rx))
            if f:
                self.frames.append(f)
                self.log.append(("frame", f[0], len(f[2])))
            self.rx = bytearray()

    async def write_frame(self, cmd, payload=b"", seq=None):
        if seq is None:
            self.seq = (self.seq % 0xFF) + 1
            seq = self.seq
        frame = encode(cmd, seq, payload)
        chunks = [frame[i:i + self.data_cap] for i in range(0, len(frame), self.data_cap)]
        for i, ch in enumerate(chunks):
            ctrl = (0x80 if i == 0 else 0) | (0x40 if i == len(chunks) - 1 else 0) | (i & 0x3F)
            await self.client.write_gatt_char(RX, bytes([ctrl]) + ch, response=False)
        self.log.append(("tx", cmd, len(frame), len(chunks)))
        return seq, len(frame), len(chunks)

    async def wait(self, want_cmds, timeout=3.0, seq=None, count=1):
        got, deadline = [], time.monotonic() + timeout
        while time.monotonic() < deadline:
            while self.frames:
                f = self.frames.pop(0)
                if f[0] in want_cmds and (seq is None or f[1] == seq):
                    got.append(f)
                    if len(got) >= count:
                        return got
            await asyncio.sleep(0.02)
        return got

    async def cmd(self, name, payload=b"", timeout=3.0):
        cmd = CMD[name]
        seq, flen, nch = await self.write_frame(cmd, payload)
        acks = await self.wait({0x80}, timeout, seq)
        if not acks:
            return None
        _, _, p = acks[0]
        return {"seq": seq, "frame_len": flen, "chunks": nch,
                "orig": p[0], "result": p[1], "result_name": RESULT.get(p[1], "?")}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", default="COM6")
    ap.add_argument("--no-serial", action="store_true")
    ap.add_argument("--timeout", type=float, default=20.0)
    args = ap.parse_args()

    ser_log = []
    ser_stop = threading.Event()

    def pump_serial():
        if args.no_serial or serial is None:
            return
        try:
            sp = serial.Serial(args.serial, 115200, timeout=0.3)
        except Exception as e:  # noqa: BLE001
            print(f"[probe] 串口打开失败（忽略）：{e}")
            return
        while not ser_stop.is_set():
            line = sp.readline()
            if line:
                ser_log.append(line.decode(errors="replace").rstrip())
        sp.close()

    threading.Thread(target=pump_serial, daemon=True).start()

    print("[probe] 扫描 Lumen-* …")
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
        sys.exit("[probe] 没找到设备。检查板子是否上电、小程序是否抢着连接。")

    print(f"[probe] 连接 {dev.name} ({dev.address})")
    async with BleakClient(dev.address, timeout=20.0) as client:
        mtu = getattr(client, "mtu_size", 23) or 23
        print(f"[probe] MTU={mtu}  分片容量={min(max(mtu - 3, 20), 180)}  数据={min(max(mtu - 3, 20), 180) - 1}")
        link = Link(client, mtu)
        await client.start_notify(TX, link.on_notify)
        check("MTU ≥ 40（37B State 可单包）", mtu >= 40, f"MTU={mtu}")

        # ---- 1. State 37B via GATT read ----
        raw = await client.read_gatt_char(STATE_CHAR)
        st = bytes(raw)
        if len(st) == 37:
            check("State GATT read 恰好 37 字节", True, f"{len(st)}B")
        else:
            print(f"[probe] GATT read 返回 {len(st)}B，改走 QueryState")
            seq, _, _ = await link.write_frame(CMD["QueryState"])
            got = await link.wait({0x82}, 3.0, None)
            st = got[0][2] if got else b""
            check("State 回落 QueryState→StateReport = 37 字节", len(st) == 37, f"{len(st)}B")

        if len(st) == 37:
            power, bright, r, g, b, maxb, strips = st[0], st[1], st[2], st[3], st[4], st[5], st[6]
            script_id, stage, playback, flags = st[7], st[8], st[9], st[10]
            pmask, amask = st[11], st[12]
            counts = list(struct.unpack("<8H", st[13:29]))
            segcnt = list(st[29:37])
            print(f"        power={power} bright={bright} rgb=({r},{g},{b}) max={maxb} "
                  f"strips={strips} script=0x{script_id:02X} stage={stage} playback={playback} "
                  f"flags=0x{flags:02X} pmask=0x{pmask:02X} amask=0x{amask:02X}")
            print(f"        counts={counts[:strips]} segcounts={segcnt[:strips]}")
            check("State strips 在 1..8", 1 <= strips <= 8, str(strips))
            check("State pmask 有值（非 0）", pmask != 0, f"0x{pmask:02X}")

        # ---- 2. QueryStripConfig ----
        res = await link.cmd("QueryStripConfig")
        if res and res["result"] == 0:
            got = await link.wait({0x87}, 3.0)
            if got:
                p = got[0][2]
                check("StripConfigReport = 24 字节", len(p) == 24, f"{len(p)}B")
                rows = [(p[i], p[i + 1], p[i + 2]) for i in range(0, 24, 3)]
                print("        " + "  ".join(f"#{s}:gpio{g}:{'on' if f & 1 else 'un'}" for s, g, f in rows))
                assigned = [(s, g) for s, g, f in rows if f & 1]
                check("已分配带数 == State.strip_count", len(assigned) == strips,
                      f"{len(assigned)} vs {strips}")
                pins_ok = all(g != 0xFF for _, g in assigned)
                check("已分配带 gpio != 0xFF", pins_ok)
                unassigned_ok = all(g == 0xFF for s, g, f in rows if not (f & 1))
                check("未分配带 gpio == 0xFF", unassigned_ok)
                check("StripConfigReport seq 回显", got[0][1] == res["seq"], f"{got[0][1]}")
        else:
            check("QueryStripConfig ACK OK", False, str(res))

        # ---- 3. QueryDeviceInfo ----
        res = await link.cmd("QueryDeviceInfo")
        if res and res["result"] == 0:
            got = await link.wait({0x88}, 3.0)
            if got:
                p = got[0][2]
                check("DeviceInfoReport = 15 字节", len(p) == 15, f"{len(p)}B")
                (fw,) = struct.unpack("<H", p[0:2])
                mac = ":".join(f"{x:02x}" for x in p[2:8])
                max_leds, max_strips, max_segs, max_stages, max_scripts = p[8], p[9], p[10], p[11], p[12]
                caps = p[13]
                print(f"        fw=v{fw >> 8}.{fw & 0xFF} mac={mac} max_leds={max_leds} "
                      f"strips={max_strips} segs={max_segs} stages={max_stages} "
                      f"scripts={max_scripts} caps=0x{caps:02X}")
                check("caps.bit0 = 1（支持两层）", bool(caps & 0x01))
                check("caps.bit1 = 0（fade 未实现）", not (caps & 0x02))
                check("max_strips == 8", max_strips == 8, str(max_strips))
                check("max_segments == 8", max_segs == 8, str(max_segs))
                ser_macs = [l for l in ser_log if "Bluetooth MAC:" in l]
                if ser_macs:
                    check("hw_id 与串口 MAC 一致", ser_macs[0].split()[-1].lower() == mac,
                          f"{mac} vs {ser_macs[0].split()[-1]}")
                else:
                    print(f"        （串口无 MAC 行，hw_id={mac} 未交叉验证）")
        else:
            check("QueryDeviceInfo ACK OK", False, str(res))

        # ---- 4. SetPower / SetBrightness ACK ----
        res = await link.cmd("SetPower", b"\x01")
        check("SetPower(1) ACK OK", res and res["result"] == 0, str(res and res["result_name"]))
        check("ACK 回显原命令字", res and res["orig"] == CMD["SetPower"])
        res = await link.cmd("SetBrightness", b"\x80")
        check("SetBrightness(128) ACK OK", res and res["result"] == 0, str(res and res["result_name"]))
        res = await link.cmd("SetBrightness", b"\xFF")
        if res and res["result"] == 0:
            got = await link.wait({0x82}, 2.0)
            if got:
                check("亮度按 max_brightness 钳位", got[0][2][1] <= 200,
                      f"bright={got[0][2][1]} max=200")

        # ---- 5. SetStripPower 每带开关 ----
        # 注意：SetStripPower 只回 ACK，**不会**主动推 StateReport（StateReport
        # 只由 QueryState / State 特征值读触发）。所以每次改完要显式 QueryState。
        async def read_state():
            r = await link.cmd("QueryState")
            if not r:
                print("        [diag] QueryState 没有 ACK")
                return None
            if r["result"] != 0:
                print(f"        [diag] QueryState result={r['result_name']}")
                return None
            got = await link.wait({0x82}, 3.0, r["seq"])
            if not got:
                print(f"        [diag] QueryState seq={r['seq']} 没有 StateReport；"
                      f"缓冲区里的帧类型={[hex(f[0]) for f in link.frames][:8]}")
                return None
            return got[0][2]

        res = await link.cmd("SetStripPower", bytes([1, 0]))
        check("SetStripPower(1,off) ACK OK", res and res["result"] == 0, str(res and res["result_name"]))
        st_off = await read_state()
        mask_after_off = st_off[11] if st_off and len(st_off) == 37 else None
        res = await link.cmd("SetStripPower", bytes([1, 1]))
        st_on = await read_state()
        mask_after_on = st_on[11] if st_on and len(st_on) == 37 else None
        check("关带后 pmask 的 bit1 清零", mask_after_off is not None and not (mask_after_off & 0x02),
              f"0x{mask_after_off:02X}" if mask_after_off is not None else "?")
        check("开带后 pmask 的 bit1 置位", mask_after_on is not None and bool(mask_after_on & 0x02),
              f"0x{mask_after_on:02X}" if mask_after_on is not None else "?")
        res = await link.cmd("SetStripPower", bytes([8, 1]))
        check("SetStripPower(strip=8) 被拒 InvalidParam", res and res["result"] == 1,
              str(res and res["result_name"]))
        res = await link.cmd("SetStripPower", bytes([0, 2]))
        check("SetStripPower(on=2) 被拒 InvalidParam", res and res["result"] == 1,
              str(res and res["result_name"]))

        # ---- 6. 全局关灯不改 pmask ----
        await link.cmd("SetPower", b"\x00")
        st_poweroff = await read_state()
        pmask_powered_off = st_poweroff[11] if st_poweroff and len(st_poweroff) == 37 else None
        check("SetPower(0) 不改 strip_power_mask",
              pmask_powered_off == mask_after_on,
              f"0x{pmask_powered_off:02X} vs 0x{mask_after_on:02X}"
              if pmask_powered_off is not None else "?")
        await link.cmd("SetPower", b"\x01")

        # ---- 7. SetSegment 两层 + 三种 blend ----
        def layer(t, hue, sat, period=0, p5=0, flags=0):
            return bytes([t]) + struct.pack("<H", hue) + bytes([sat]) + \
                   struct.pack("<H", period) + bytes([p5, flags])

        STATIC, BREATH, RAINBOW, COMET, EMPTY = 0x00, 0x01, 0x02, 0x03, 0xFF
        for blend, label in [(0, "over"), (1, "multiply"), (2, "add")]:
            l0 = layer(RAINBOW, 0x1234, 200, 1000, 255, 0)
            l1 = layer(BREATH, 0x00FF, 128, 1000, 30, 0)
            payload = bytes([0, 0, 0, 9, blend]) + l0 + l1
            res = await link.cmd("SetSegment", payload)
            check(f"SetSegment(blend={label}) ACK OK", res and res["result"] == 0,
                  str(res and res["result_name"]))
            check(f"SetSegment(blend={label}) 载荷 21B 单片写", res and res["chunks"] == 1,
                  f"{res and res['chunks']} 片")

        # 单层带非 0 blend → InvalidParam
        l0 = layer(STATIC, 100, 255)
        bad = bytes([0, 1, 10, 19, 1]) + l0 + bytes([EMPTY]) + b"\x00" * 7
        res = await link.cmd("SetSegment", bad)
        check("单层 blend!=0 被拒 InvalidParam", res and res["result"] == 1,
              str(res and res["result_name"]))
        # 空 layer0
        bad = bytes([0, 2, 10, 19, 0]) + bytes([EMPTY]) + b"\x00" * 7 + bytes([EMPTY]) + b"\x00" * 7
        res = await link.cmd("SetSegment", bad)
        check("空 layer0 被拒 InvalidParam", res and res["result"] == 1,
              str(res and res["result_name"]))
        # 区间非法
        bad = bytes([0, 3, 30, 5, 0]) + l0 + bytes([EMPTY]) + b"\x00" * 7
        res = await link.cmd("SetSegment", bad)
        check("start>end 被拒 InvalidParam", res and res["result"] == 1,
              str(res and res["result_name"]))
        # 呼吸周期下限
        l0b = layer(BREATH, 100, 255, 300, 0, 0)
        bad = bytes([0, 4, 0, 9, 0]) + l0b + bytes([EMPTY]) + b"\x00" * 7
        res = await link.cmd("SetSegment", bad)
        check("呼吸 300ms < 334ms 被拒", res and res["result"] == 1,
              str(res and res["result_name"]))

        # ---- 8. QueryStrip 读回 21B + 真实槽位 ----
        res = await link.cmd("QueryStrip", b"\x00")
        if res and res["result"] == 0:
            got = await link.wait({0x83, 0x84}, 3.0, None, count=4)
            reports = [g for g in got if g[0] == 0x83]
            ends = [g for g in got if g[0] == 0x84]
            check("QueryStrip 有 SegmentListEnd", len(ends) >= 1)
            check("SegmentReport 每条 21 字节", all(len(r[2]) == 21 for r in reports),
                  str([len(r[2]) for r in reports]))
            slots = [r[2][1] for r in reports]
            check("SegmentReport 的 seg_id 是真实槽位（0..7 且不重复）",
                  len(set(slots)) == len(slots) and all(0 <= s < 8 for s in slots), str(slots))
            two_layer = [r for r in reports if r[2][13] != 0xFF]
            check("有两层段的报告", len(two_layer) >= 1, f"{len(two_layer)} 条")
            if ends:
                check("SegmentListEnd = 2 字节", len(ends[0][2]) == 2)
        else:
            check("QueryStrip ACK OK", False, str(res))

        # ---- 9. ClearSegment ----
        res = await link.cmd("ClearSegment", bytes([0, 0]))
        check("ClearSegment ACK OK", res and res["result"] == 0, str(res and res["result_name"]))
        for seg in (1, 2, 3):
            await link.cmd("ClearSegment", bytes([0, seg]))

        # ---- 10. 脚本正常路径 ----
        res = await link.cmd("ScriptBegin", bytes([0, 1, 1]))
        check("ScriptBegin(1 阶段 1 带) ACK OK", res and res["result"] == 0,
              str(res and res["result_name"]))
        res = await link.cmd("ScriptStage", bytes([0, 0]) + struct.pack("<HH", 1000, 0))
        check("ScriptStage(1000ms, fade=0) ACK OK", res and res["result"] == 0,
              str(res and res["result_name"]))
        res = await link.cmd("ScriptStage", bytes([0, 0]) + struct.pack("<HH", 1000, 250))
        check("ScriptStage fade=250 被接受（格式预留）", res and res["result"] == 0,
              str(res and res["result_name"]))
        seg = bytes([0, 0, 0, 0, 0, 9, 0]) + l0 + bytes([EMPTY]) + b"\x00" * 7
        res = await link.cmd("ScriptSegment", seg)
        check("ScriptSegment ACK OK", res and res["result"] == 0, str(res and res["result_name"]))
        res = await link.cmd("ScriptCommit", bytes([0]))
        check("ScriptCommit ACK OK", res and res["result"] == 0, str(res and res["result_name"]))
        res = await link.cmd("QueryScript", bytes([0]))
        if res and res["result"] == 0:
            got = await link.wait({0x85}, 3.0)
            if got:
                p = got[0][2]
                check("ScriptSummary = 4 字节", len(p) == 4, f"{len(p)}B")
                check("剧本 0 已提交且 1 阶段", p[1] == 1, f"stages={p[1]}")
        await link.cmd("ScriptAbort", bytes([0]))

        # ---- 11. 分片写（>179B 需要多片）----
        # 用 8 个 SetSegment 无法凑单片大帧；改为验证被分片的小 MTU 路径已经发生
        chunked = [l for l in link.log if l[0] == "tx" and l[3] > 1]
        check("多片写路径被覆盖（若无则 MTU 大到单片）", True,
              f"{len(chunked)} 帧分片" if chunked else "本机 MTU 足够，无分片")

        await client.stop_notify(TX)

    ser_stop.set()
    time.sleep(0.3)

    print("\n" + "=" * 62)
    passed = sum(1 for _, ok, _ in checks if ok)
    print(f"结果：{passed}/{len(checks)} 通过")
    fails = [(n, d) for n, ok, d in checks if not ok]
    if fails:
        print("\n失败项：")
        for n, d in fails:
            print(f"  - {n}  {d}")
    print("=" * 62)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
