#!/usr/bin/env python
"""方案作用域真机验证（#122 / #123）。

验收判据要的是**逐帧**，不是终态：要抓的正是「闪一下就恢复」这种瞬态。
所以本脚本对每一条带连续采样 `State` 的第 12 字节（`strip_anim_mask`），
把整段时间轴的每一次变化都打出来——不是只在开始/结束各读一次。

四组：

  §1 只含 strip0 的方案激活后，strip1..7 的动画位仍在（逐帧）
  §2 方案 loop=0 走完停住，未参与的带仍在动（逐帧）
  §3 参与方案但某一步没段的带，该步输出黑（读回 + 出光）
  §4 未参与的带在方案全程它的实时分区字节不变

用法：
    python scripts/verify-scope.py [--address CC:8D:A2:C2:56:62]
    python scripts/verify-scope.py --fps 20 --seconds 6

前置：设备已刷本轮固件（`scripts\\build-firmware.cmd` + `flash-firmware.cmd`），
且**没有别的 central 连着**（小程序在后台或已杀掉）。

没有真机时不要跑：它只做真机往返。
"""

import argparse
import asyncio
import struct
import sys
import time

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.exit("需要 bleak：python -m pip install bleak")

SERVICE = "6c756d65-6e00-4b1e-9a3c-000000000001"
RX = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX = "6c756d65-6e00-4b1e-9a3c-000000000003"

MAGIC = 0xA6
VERSION = 0x04
LAYER_BYTES = 9
LAYER_EMPTY = 0xFF

CMD = {
    "QUERY_STATE": 0x05,
    "SET_POWER": 0x01,
    "SET_BRIGHTNESS": 0x02,
    "SET_SEGMENT": 0x10,
    "CLEAR_SEGMENT": 0x11,
    "QUERY_STRIP": 0x12,
    "SET_PLAYBACK": 0x13,
    "SCRIPT_BEGIN": 0x14,
    "SCRIPT_STAGE": 0x15,
    "SCRIPT_SEGMENT": 0x16,
    "SCRIPT_COMMIT": 0x17,
    "SCRIPT_ABORT": 0x18,
    "ACTIVATE_SCRIPT": 0x19,
    "QUERY_SCRIPT": 0x1A,
    "CLEAR_SCRIPT": 0x1E,
}

ACK = 0x80
STATE_REPORT = 0x82
SEGMENT_REPORT = 0x83

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    return ok


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
    """9 字节层：type + param(7) + level（显式拼，避免 struct 填充陷阱）。"""
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
    return bytes([LAYER_EMPTY]) + bytes(LAYER_BYTES - 1)


def segment(strip, seg, start, end, l0, l1=None, blend=0):
    return bytes([strip, seg, start, end, blend]) + l0 + (l1 or empty_layer())


class Device:
    def __init__(self, client):
        self.client = client
        self.tx = bytearray()
        self.seq = 0

    def on_notify(self, _handle, data):
        self.tx.extend(data)

    async def send(self, cmd, payload=b"", timeout=2.0):
        self.seq = (self.seq + 1) & 0xFF
        seq = self.seq
        self.tx.clear()
        await self.client.write_gatt_char(RX, chunk(build_frame(cmd, seq, payload)))
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            frames = self._drain()
            for f in frames:
                if f["cmd"] == ACK and f["seq"] == seq:
                    return f["payload"][1] if len(f["payload"]) >= 2 else None
            await asyncio.sleep(0.005)
        return None

    async def send_and_collect(self, cmd, payload=b"", timeout=1.5):
        self.seq = (self.seq + 1) & 0xFF
        seq = self.seq
        self.tx.clear()
        await self.client.write_gatt_char(RX, chunk(build_frame(cmd, seq, payload)))
        deadline = asyncio.get_event_loop().time() + timeout
        frames = []
        while asyncio.get_event_loop().time() < deadline:
            frames.extend(self._drain())
            await asyncio.sleep(0.005)
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

    async def state_burst(self, count):
        """连续发 `count` 条 QUERY_STATE，再一次性收齐 StateReport。

        单发一条要等一个完整的 BLE 往返（实测 ~62ms = 16Hz），而固件按 20fps
        渲染——只持续一帧的瞬态（「闪一下就恢复」）正好落在采样间隙里。批量
        连发把往返开销摊到 n 帧上：写 n 条几乎不额外花时间，回包是一串连续
        通知，所以 n=8 时能到 100Hz 上下，足以覆盖 20fps 的每一帧。

        返回解析后的 State 列表（按到达顺序）。
        """
        self.tx.clear()
        for _ in range(count):
            self.seq = (self.seq + 1) & 0xFF
            await self.client.write_gatt_char(
                RX, chunk(build_frame(CMD["QUERY_STATE"], self.seq))
            )
        out = []
        deadline = asyncio.get_event_loop().time() + max(1.0, count * 0.15)
        while len(out) < count and asyncio.get_event_loop().time() < deadline:
            for f in self._drain():
                if f["cmd"] == STATE_REPORT:
                    out.append(parse_state(f["payload"]))
            if len(out) < count:
                await asyncio.sleep(0.002)
        return out

    async def state(self):
        """读一次 State 并**立刻**返回解析结果。

        不能用 `send_and_collect`：它总是等满超时才返回，于是采样率被钉在
        1.5s/帧——而「闪一下就恢复」正是要抓的那个瞬态，1.5s 的采样窗口
        必然漏掉它。这里收到 StateReport 就返回，实测能到 20Hz 以上。
        """
        self.seq = (self.seq + 1) & 0xFF
        seq = self.seq
        self.tx.clear()
        await self.client.write_gatt_char(RX, chunk(build_frame(CMD["QUERY_STATE"], seq)))
        deadline = asyncio.get_event_loop().time() + 1.0
        while asyncio.get_event_loop().time() < deadline:
            for f in self._drain():
                if f["cmd"] == STATE_REPORT:
                    return parse_state(f["payload"])
            await asyncio.sleep(0.002)
        return None

    async def query_strip(self, strip_id):
        frames = await self.send_and_collect(CMD["QUERY_STRIP"], bytes([strip_id]))
        return [parse_segment_report(f["payload"]) for f in frames if f["cmd"] == SEGMENT_REPORT]


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
        # State 字节 12：被别的东西占掉了？见下。
        "strip_anim_mask": payload[12],
        "strip_counts": [payload[13 + i * 2] | (payload[14 + i * 2] << 8) for i in range(8)],
        "strip_seg_counts": list(payload[29:37]),
    }


def parse_segment_report(payload):
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


async def sample_states(dev, seconds, fps, label):
    """逐帧采样 State 的 strip_anim_mask（不是只看终态）。

    批量连发把实际采样率抬到 100Hz 上下，覆盖固件 20fps 的每一帧——
    单发 16Hz 会漏掉只存在一帧的瞬态，那正是「闪一下就恢复」。

    返回 [(t, mask, stage, playback, flags)]，t 是相对开始秒数。
    """
    batch = max(16, int(round(fps / 20.0)) * 8)
    t0 = time.time()
    samples = []
    while time.time() - t0 < seconds:
        for st in await dev.state_burst(batch):
            samples.append(
                (
                    round(time.time() - t0, 3),
                    st["strip_anim_mask"],
                    st["stage_index"],
                    st["playback"],
                    st["flags"],
                )
            )
    elapsed = time.time() - t0
    rate = len(samples) / elapsed if elapsed > 0 else 0
    print(
        f"  [{label}] 采样 {len(samples)} 帧 / {elapsed:.2f}s = {rate:.1f}Hz，"
        f"anim_mask 取值 {[hex(v) for v in sorted({s[1] for s in samples})]}"
    )
    return samples


def mask_trace(samples):
    """把逐帧采样压成「哪段时间是什么值」，人读比一堆数字快。"""
    if not samples:
        return "（无采样）"
    out = []
    prev = None
    for t, mask, stage, playback, _flags in samples:
        if mask != prev:
            out.append(f"t={t:.2f}s mask=0x{mask:02X} stage={stage} pb={playback}")
            prev = mask
    return " | ".join(out)


async def build_scope_script(dev, script_id, stage_count, strip_count, only_strip):
    """两步方案：只有 only_strip 在第 0 步有内容（呼吸），第 1 步故意留空。"""
    await dev.send(CMD["CLEAR_SCRIPT"], bytes([script_id]))
    await dev.send(CMD["SCRIPT_BEGIN"], bytes([script_id, stage_count, strip_count]))
    for stage in range(stage_count):
        # 时长 1500ms：够 loop=0 跑完并停住，也够逐帧采样抓瞬态。
        await dev.send(CMD["SCRIPT_STAGE"], bytes([script_id, stage, 0xDC, 0x05, 0x00, 0x00]))
        if stage == 0:
            l0 = layer_bytes(0x01, period=1000, p5=40)  # 呼吸
            await dev.send(
                CMD["SCRIPT_SEGMENT"], bytes([script_id, stage]) + segment(only_strip, 0, 0, 9, l0)
            )
    return await dev.send(CMD["SCRIPT_COMMIT"], bytes([script_id]))


async def setup_live_animated(dev, strip_count):
    """给 strip1..7 各写一段自己的呼吸（实时分区），作为「不归方案管」的对照。"""
    for s in range(1, strip_count):
        await dev.send(CMD["CLEAR_SEGMENT"], bytes([s, 0]))
        await dev.send(
            CMD["SET_SEGMENT"], segment(s, 0, 0, 9, layer_bytes(0x01, period=1000, p5=40))
        )
    # strip0 的实时分区留空：它的内容来自方案，不来自静态配置。
    await dev.send(CMD["CLEAR_SEGMENT"], bytes([0, 0]))
    await asyncio.sleep(0.3)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--address", default="")
    parser.add_argument("--fps", type=float, default=12.0, help="State 逐帧采样率")
    parser.add_argument("--seconds", type=float, default=5.0, help="每组采样时长")
    args = parser.parse_args()

    address = await find_device(args.address)
    if address is None:
        print("RESULT: no-device (设备没在广播：确认没有别的客户端连着它)")
        return 2

    async with BleakClient(address, timeout=25) as client:
        dev = Device(client)
        await client.start_notify(TX, dev.on_notify)
        await asyncio.sleep(0.8)

        state = await dev.state()
        if state is None:
            print("RESULT: no-state (连上了但读不到 State)")
            return 2
        strip_count = state["strip_count"]
        print(
            f"设备：strips={strip_count} leds={state['strip_counts'][:strip_count]} "
            f"max_brightness={state['max_brightness']}"
        )

        # ---------- 现场归一 ----------
        await dev.send(CMD["SET_PLAYBACK"], bytes([0, 0]))
        await dev.send(CMD["SET_POWER"], bytes([1]))
        for s in range(8):
            for seg in range(8):
                await dev.send(CMD["CLEAR_SEGMENT"], bytes([s, seg]))
        await dev.send(CMD["SET_BRIGHTNESS"], bytes([150]))
        await setup_live_animated(dev, strip_count)

        live_before = {}
        for s in range(1, strip_count):
            live_before[s] = await dev.query_strip(s)

        # ---------- §1 只含 strip0 的方案激活后 ----------
        print("\n=== §1 只含 strip0 的方案：strip1..7 的动画位必须还在 ===")
        code = await build_scope_script(dev, 3, 2, strip_count, 0)
        check("两步方案（只含 strip0）提交成功", code == 0x00, f"result={code}")
        await dev.send(CMD["ACTIVATE_SCRIPT"], bytes([3, 1]))  # loop = 全部循环
        await dev.send(CMD["SET_PLAYBACK"], bytes([1, 1]))
        await asyncio.sleep(0.5)

        samples = await sample_states(dev, args.seconds, args.fps, "§1 播放中")
        print(f"  轨迹：{mask_trace(samples)}")
        expected_others = 0xFE & ((1 << strip_count) - 1)
        others_ok = all((s[1] & expected_others) == expected_others for s in samples)
        check(
            "播放全程 strip1..7 的动画位始终为 1（逐帧）",
            others_ok,
            f"期望每帧都含 0x{expected_others:02X}，"
            f"实际最小 0x{min((s[1] for s in samples), default=0):02X}",
        )

        # ---------- §4 未参与带的实时分区字节不变 ----------
        print("\n=== §4 未参与方案的带：实时分区逐字节不变 ===")
        live_after = {}
        for s in range(1, strip_count):
            live_after[s] = await dev.query_strip(s)
        drift = []
        for s in range(1, strip_count):
            if live_before[s] != live_after[s]:
                drift.append(s)
        check(
            "方案全程后 strip1..7 的 QueryStrip 读回与开工前逐字节一致",
            not drift,
            f"变化的带：{drift}" if drift else "8 条全部一致",
        )

        # ---------- §2 loop=0 走完停住 ----------
        print("\n=== §2 loop=0 走完停住：未参与的带继续动 ===")
        await dev.send(CMD["ACTIVATE_SCRIPT"], bytes([3, 0]))
        await dev.send(CMD["SET_PLAYBACK"], bytes([1, 0]))
        # 两步 × 1.5s = 3s：等它真的走完再采样。
        await asyncio.sleep(3.4)
        st = await dev.state()
        check(
            "方案已走完并停住（playback=STOPPED / hold_last）",
            st is not None and st["playback"] == 0,
            f"playback={st['playback'] if st else '?'} stage={st['stage_index'] if st else '?'}",
        )
        samples = await sample_states(dev, args.seconds, args.fps, "§2 停住后")
        print(f"  轨迹：{mask_trace(samples)}")
        others_ok = all((s[1] & expected_others) == expected_others for s in samples)
        check(
            "停住后 strip1..7 的动画位仍在（逐帧）",
            others_ok,
            f"每帧最低 0x{min((s[1] for s in samples), default=0):02X}",
        )
        # 参与带（strip0）走完后是有内容的静态最后一帧；这里确认它不再是动画。
        check(
            "停住后 strip0 的动画位为 0（它冻结在最后一帧）",
            all((s[1] & 0x01) == 0 for s in samples),
            f"strip0 位的实际取值 {sorted({s[1] & 0x01 for s in samples})}",
        )

        # ---------- §3 某一步没内容 = 该步全黑 ----------
        print("\n=== §3 参与方案但某一步没段的带：该步输出黑 ===")
        #
        # 第 0 步只有 strip0 有呼吸段；第 1 步整份为空。用 stage_index 轮询
        # 抓住「停在第 1 步」的那段窗口，此时 strip0 应当没有任何活动段
        # （seg_counts[0] == 0），且它仍在方案归属里（动画位为 0 = 不闪）。
        await dev.send(CMD["ACTIVATE_SCRIPT"], bytes([3, 2]))  # 最后一步循环
        await dev.send(CMD["SET_PLAYBACK"], bytes([1, 2]))
        await asyncio.sleep(2.2)  # 走过第 0 步（1.5s），进入第 1 步
        st = await dev.state()
        check(
            "播放头已进入第 1 步（空步骤）",
            st is not None and st["stage_index"] == 1,
            f"stage={st['stage_index'] if st else '?'}",
        )
        if st is not None and st["stage_index"] == 1:
            check(
                "该步 strip0 的活动段数为 0（没有段 = 输出黑，不是纯色）",
                st["strip_seg_counts"][0] == 0,
                f"seg_counts[0]={st['strip_seg_counts'][0]} (全部 {st['strip_seg_counts'][:strip_count]})",
            )
            check(
                "该步 strip0 的动画位为 0（黑帧不产生动画）",
                (st["strip_anim_mask"] & 0x01) == 0,
                f"anim_mask=0x{st['strip_anim_mask']:02X}",
            )

        # ---------- 收尾 ----------
        await dev.send(CMD["SET_PLAYBACK"], bytes([0, 0]))
        await dev.send(CMD["CLEAR_SCRIPT"], bytes([3]))

    passed = sum(1 for _n, ok, _d in results if ok)
    total = len(results)
    print(f"\n=== {passed}/{total} 通过 ===")
    if passed != total:
        for name, ok, detail in results:
            if not ok:
                print(f"  FAILED: {name} — {detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
