#!/usr/bin/env python
"""v3 错色实验的 PC 侧驱动：当 BLE central，配置画面 + 制造压力。

**这是 v3 版本。** 旧版写的是 v2 帧（magic 0xA5 / version 0x02 / 无分片头），
v3 固件收到会直接丢弃且不回 ACK —— 表现为「脚本一路静默失败、最后在格式化
None 时崩」。改动点：

  - magic 0xA5 → 0xA6，version 0x02 → 0x03
  - 校验从 1 字节取反和 → CRC16-CCITT
  - 长度从 1 字节 → 2 字节小端
  - **每帧必须带 1 字节分片头**（ctrl，bit7 FIRST / bit6 LAST / bit5..0 序号）
  - 段载荷从「type + 变长参数」→ 固定 21 字节（两层各 8 字节定宽）

为什么驱动要单独一个进程：`opencv` 与 `bleak` 不能同进程（opencv 会把线程设成
Windows GUI，之后 bleak 报 "Thread is configured for Windows GUI"）。所以
「配置」在这里，「取帧/标定/判定」在其他脚本。

用法（仓库根目录；设备空闲，小程序退到后台）：

    # 逐带隔离：只开第 k 条、其余全关，该条上铺满静态红（测物理颗数用）
    python scripts/ble-stress.py isolate 3

    # 逐带专属色：8 条各一种色相（45° 一档），用于标定与串带检测
    python scripts/ble-stress.py colorize

    # 压力：以 hz 频率连续写 SetBrightness
    python scripts/ble-stress.py flood --seconds 400 --hz 20 --brightness 60

    # 恢复
    python scripts/ble-stress.py reset
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

MAGIC = 0xA6
VERSION = 0x03
SERVICE = "6c756d65-6e00-4b1e-9a3c-000000000001"
RX = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX = "6c756d65-6e00-4b1e-9a3c-000000000003"
STATE_CHAR = "6c756d65-6e00-4b1e-9a3c-000000000004"

CMD_SET_POWER = 0x01
CMD_SET_BRIGHTNESS = 0x02
CMD_SET_LED_COUNT = 0x06
CMD_SET_SEGMENT = 0x10
CMD_CLEAR_SEGMENT = 0x11
CMD_QUERY_STRIP = 0x12
CMD_SET_STRIP_POWER = 0x1B
CMD_QUERY_STRIP_CONFIG = 0x1C
CMD_QUERY_DEVICE_INFO = 0x1D

TYPE_STATIC = 0x00
LAYER_EMPTY = 0xFF
BLEND_OVERWRITE = 0x00

STRIP_COUNT = 8
SLOT_COUNT = 8
# 铺设到固件上报的灯珠数上限。物理上更短的带，多出来的像素被 WS2812B
# 静默丢弃，协议层看不出差别 —— 所以「物理颗数」必须靠录像测。
FULL_RANGE_END = 29


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
    """8 字节定宽层：type(1) + param(7)。静态 = hue(2 LE) + sat(1) + 保留 4 字节 0。"""
    return bytes([TYPE_STATIC]) + struct.pack("<H", hue & 0xFFFF) + bytes([sat & 0xFF]) + bytes(4)


def layer_empty() -> bytes:
    return bytes([LAYER_EMPTY]) + bytes(7)


def segment_payload(strip, seg, start, end, blend, layer0: bytes, layer1: bytes) -> bytes:
    assert len(layer0) == 8 and len(layer1) == 8
    return bytes([strip, seg, start, end, blend]) + layer0 + layer1


def hue_for_strip(strip: int) -> int:
    """第 i 条带 → 色相 i*45°。

    45° 一档是因为 8 条正好铺满一圈，任意两条至少相差 45°，而「串带」会让
    某条跳到别人的色相上，在色度空间里区分度极高。
    """
    return int(round(strip * 65536.0 / 8.0)) & 0xFFFF


class Rig:
    """v3 分片收发 + ACK 等待。"""

    def __init__(self, client):
        self.client = client
        mtu = getattr(client, "mtu_size", 23) or 23
        self.cap = min(max(mtu - 3, 20), 180)
        self.data_cap = self.cap - 1
        self.rx = bytearray()
        self.frames = []
        self.seq = 0

    async def start(self):
        await self.client.start_notify(TX, self._on_notify)

    def _on_notify(self, _char, data):
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

    async def write(self, cmd: int, payload: bytes = b"") -> int:
        self.seq = (self.seq % 0xFF) + 1
        frame = encode(cmd, self.seq, payload)
        chunks = [frame[i:i + self.data_cap] for i in range(0, len(frame), self.data_cap)]
        for i, ch in enumerate(chunks):
            ctrl = (0x80 if i == 0 else 0) | (0x40 if i == len(chunks) - 1 else 0) | (i & 0x3F)
            await self.client.write_gatt_char(RX, bytes([ctrl]) + ch, response=False)
        return self.seq

    async def ack(self, seq: int, timeout: float = 2.0, timeout_is_ok: bool = False):
        """等 seq 对应的 ACK；返回 (orig_cmd, result)，超时返回 None。

        timeout_is_ok=True 用于 flood：那条路径故意不逐个等 ACK。
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            while self.frames:
                f = self.frames.pop(0)
                if f[0] == 0x80 and f[1] == seq and len(f[2]) >= 2:
                    return f[2][0], f[2][1]
            await asyncio.sleep(0.005)
        return None

    async def send(self, cmd: int, payload: bytes = b"", wait: float = 2.0):
        seq = await self.write(cmd, payload)
        return await self.ack(seq, wait)

    async def state(self) -> bytes:
        return bytes(await self.client.read_gatt_char(STATE_CHAR))


async def find_device(timeout=20):
    dev = await BleakScanner.find_device_by_filter(
        lambda d, a: (a.local_name or "").startswith("Lumen"), timeout=timeout)
    if not dev:
        raise SystemExit("未找到 Lumen 设备（确认已上电、没被小程序占着；"
                         "协议是单连接，断开才重新广播）")
    return dev


async def open_rig():
    dev = await find_device()
    client = BleakClient(dev)
    await client.connect()
    rig = Rig(client)
    await rig.start()
    return client, rig


def parse_state(st: bytes) -> dict:
    if len(st) != 37:
        raise SystemExit(f"State 长度应为 37，实际 {len(st)}（协议不匹配？）")
    return {
        "power": st[0], "brightness": st[1], "rgb": tuple(st[2:5]),
        "max_brightness": st[5], "strip_count": st[6], "script_id": st[7],
        "stage_index": st[8], "playback_state": st[9], "flags": st[10],
        "strip_power_mask": st[11], "strip_anim_mask": st[12],
        "strip_counts": [int.from_bytes(st[13 + 2 * i:15 + 2 * i], "little") for i in range(8)],
        "strip_seg_counts": list(st[29:37]),
    }


def describe(st: bytes) -> str:
    d = parse_state(st)
    return (f"power={d['power']} bright={d['brightness']} rgb={d['rgb']} "
            f"pmask={d['strip_power_mask']:#04x} amask={d['strip_anim_mask']:#04x} "
            f"counts={d['strip_counts']} segs={d['strip_seg_counts']}")


async def clear_segments(rig, strips=range(STRIP_COUNT), slots=range(SLOT_COUNT)):
    for s in strips:
        for seg in slots:
            await rig.send(CMD_CLEAR_SEGMENT, bytes([s, seg]), wait=0.5)


async def set_strip_power(rig, mask: int):
    for s in range(STRIP_COUNT):
        await rig.send(CMD_SET_STRIP_POWER, bytes([s, 1 if (mask >> s) & 1 else 0]), wait=0.5)


async def cmd_isolate(rig, strip: int, brightness: int, end: int, hue: int):
    """只开第 strip 条、其余全关；该条上铺一个 0..end 的静态段。

    **必须关掉其余带**：没有活动段的带会走 v1 单色回退，被全局色刷亮 ——
    那会让「只点亮一条」的观察彻底失效（踩过：pmask 只留最后一条，
    导致前面几次测量全部误读）。
    """
    await clear_segments(rig)
    await rig.send(CMD_SET_BRIGHTNESS, bytes([brightness]), wait=0.5)
    await rig.send(CMD_SET_POWER, bytes([1]), wait=0.5)
    await set_strip_power(rig, 1 << strip)
    r = await rig.send(CMD_SET_SEGMENT,
                       segment_payload(strip, 0, 0, end, BLEND_OVERWRITE,
                                       layer_static(hue), layer_empty()), wait=1.0)
    code = "OK" if r and r[1] == 0 else (f"result=0x{r[1]:02X}" if r else "NO ACK")
    print(f"  isolate strip={strip} hue={hue} LED[0..{end}] -> {code}")
    print("  " + describe(await rig.state()))


async def cmd_colorize(rig, brightness: int, end: int):
    """8 条各铺一个专属色相的静态段，全开。

    这是标定信号源：色相唯一，所以从一帧里能同时
    (a) 认出每条带在画面里的位置，(b) 数出它的物理颗数，
    (c) 之后用它检测「串带」（某条显示成了别人的色相）。
    """
    await clear_segments(rig)
    await rig.send(CMD_SET_BRIGHTNESS, bytes([brightness]), wait=0.5)
    await rig.send(CMD_SET_POWER, bytes([1]), wait=0.5)
    for s in range(STRIP_COUNT):
        r = await rig.send(CMD_SET_SEGMENT,
                           segment_payload(s, 0, 0, end, BLEND_OVERWRITE,
                                           layer_static(hue_for_strip(s)), layer_empty()),
                           wait=0.8)
        code = "OK" if r and r[1] == 0 else (f"result=0x{r[1]:02X}" if r else "NO ACK")
        print(f"  strip {s}: hue={hue_for_strip(s):5d} ({s * 45:3d}°) LED[0..{end}] -> {code}")
    await set_strip_power(rig, 0xFF)
    print("  " + describe(await rig.state()))


async def cmd_flood(rig, seconds, hz, brightness):
    """以 hz 频率连续发 SetBrightness —— 制造 BLE 抢占 RMT 中断的压力。

    **不等 ACK**：等 ACK 会把节奏锁死在往返时延上，达不到目标频率（旧版用
    `await asyncio.sleep(wait)` 固定等待，实测远低于目标 hz）。发送期间不解析
    接收缓冲，结束时统一统计 ACK 数量与非 0 结果。
    """
    period = 1.0 / hz
    levels = [brightness, max(1, brightness - 1)]
    sent = 0
    t0 = time.monotonic()
    print(f"开始 {hz}Hz 写入，持续 {seconds}s（画面亮度在 {levels} 间微调）")
    while True:
        now = time.monotonic()
        if now - t0 >= seconds:
            break
        await rig.write(CMD_SET_BRIGHTNESS, bytes([levels[sent % len(levels)]]))
        sent += 1
        delay = (t0 + sent * period) - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
    elapsed = time.monotonic() - t0
    acks = bad = 0
    while rig.frames:
        f = rig.frames.pop(0)
        if f[0] == 0x80 and len(f[2]) >= 2:
            acks += 1
            if f[2][1] != 0:
                bad += 1
    print(f"完成：{sent} 帧 / {elapsed:.1f}s = {sent / elapsed:.1f} Hz")
    print(f"回收 ACK {acks} / 非 0 {bad}（发送期间未逐个等待，这是预期值）")


async def cmd_reset(rig):
    await clear_segments(rig)
    await set_strip_power(rig, 0xFF)
    await rig.send(CMD_SET_BRIGHTNESS, bytes([128]), wait=0.5)
    await rig.send(CMD_SET_POWER, bytes([0]), wait=0.5)
    print("已恢复：无段、8 带全开、亮度 128、关灯")
    print("  " + describe(await rig.state()))


async def cmd_show(rig):
    print("  " + describe(await rig.state()))
    seq = await rig.write(CMD_QUERY_STRIP_CONFIG)
    await asyncio.sleep(0.6)
    for f in rig.frames:
        if f[0] == 0x87 and len(f[2]) >= 24:
            pl = f[2]
            recs = [(pl[3 * i], pl[3 * i + 1], pl[3 * i + 2]) for i in range(8)]
            print("  StripConfig (strip_id, gpio, flags):")
            for sid, gpio, flags in recs:
                print(f"    strip {sid}: gpio={0xFF if gpio == 0xFF else gpio:>3} "
                      f"assigned={(flags >> 0) & 1}")
    rig.frames.clear()
    ack = await rig.ack(seq, 1.0)
    print(f"  QueryStripConfig ACK = {ack}")


async def main():
    ap = argparse.ArgumentParser(description="v3 错色实验的 PC 侧 BLE 驱动")
    ap.add_argument("--brightness", type=int, default=60,
                    help="配置画面用的全局亮度（flood 请用 --flood-brightness）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_iso = sub.add_parser("isolate", help="只开一条带并铺满静态色（测物理颗数用）")
    p_iso.add_argument("strip", type=int)
    p_iso.add_argument("--hue", type=int, default=0)
    p_iso.add_argument("--end", type=int, default=FULL_RANGE_END)

    p_col = sub.add_parser("colorize", help="8 条各一种专属色相（标定 + 串带检测）")
    p_col.add_argument("--end", type=int, default=FULL_RANGE_END)

    p_fl = sub.add_parser("flood", help="高频写入制造 BLE 压力")
    p_fl.add_argument("--seconds", type=float, default=400)
    p_fl.add_argument("--hz", type=float, default=20)
    p_fl.add_argument("--brightness", type=int, default=60)

    sub.add_parser("show", help="打印 State 与 StripConfig")
    sub.add_parser("reset", help="恢复默认状态")

    args = ap.parse_args()
    client, rig = await open_rig()
    try:
        if args.cmd == "isolate":
            await cmd_isolate(rig, args.strip, args.brightness, args.end, args.hue)
        elif args.cmd == "colorize":
            await cmd_colorize(rig, args.brightness, args.end)
        elif args.cmd == "flood":
            await cmd_flood(rig, args.seconds, args.hz, args.brightness)
        elif args.cmd == "show":
            await cmd_show(rig)
        elif args.cmd == "reset":
            await cmd_reset(rig)
    finally:
        await client.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
