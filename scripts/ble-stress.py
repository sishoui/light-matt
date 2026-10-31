#!/usr/bin/env python
"""#20 错色实验的 PC 侧驱动：当 BLE central，配置灯带 + 并发高频写入。

为什么需要它：错色判定的前提是「画面恒定 + 持续刷帧 + BLE 并发写入」。
前两条由固件的 CONFIG_LUMEN_FORCE_REFRESH 保证，第三条必须由 PC 制造
（小程序不方便做 20Hz 持续写 30 分钟）。判定本身由
scripts/analyze-strip-video.py 逐帧比对录像完成。

用法（仓库根目录；设备空闲时；先把小程序退到后台，它会抢连接）：

    # 1) 配置：只点亮指定灯带上的 8 颗对角灯（画面恒定，便于判定）
    python scripts/ble-stress.py setup --strip 6

    # 2) 基线录像期间什么都不写（人为保持画面恒定）
    #    然后用 analyze-strip-video.py --grid 8x8 分析

    # 3) 高频写入段：以 20Hz 连续发 SetBrightness，持续 N 秒
    python scripts/ble-stress.py flood --seconds 180 --hz 20

    # 4) 收尾：恢复默认（全黑、亮度 128）
    python scripts/ble-stress.py reset

约定：
- **引脚 → strip_id 的映射**由固件 Kconfig 的 LUMEN_STRIP_PINS 决定。
  当前默认 "3,10,0,1,4,5,6,7"，所以 GPIO6 = strip_id 6。
- 灯板只接一条数据线时，只有它对应的 strip_id 会驱动它；其余条发到悬空引脚。
- 所有命令都走真实协议帧（checksum、seq 回显），与小程序同一条链路。
"""

import argparse
import asyncio
import sys
import time

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.exit("需要 bleak：python -m pip install bleak")

MAGIC = 0xA5
VERSION = 0x02

RX = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX = "6c756d65-6e00-4b1e-9a3c-000000000003"
STATE = "6c756d65-6e00-4b1e-9a3c-000000000004"

CMD_SET_POWER = 0x01
CMD_SET_BRIGHTNESS = 0x02
CMD_SET_SEGMENT = 0x10
CMD_CLEAR_SEGMENT = 0x11

TYPE_STATIC = 0x00


def frame(cmd, seq, payload=b""):
    body = bytes([MAGIC, VERSION, cmd, seq, len(payload)]) + payload
    return body + bytes([(~sum(body)) & 0xFF])


class Rig:
    """最小协议客户端：只实现实验需要的几条命令。"""

    def __init__(self, client):
        self.client = client
        self.seq = 0
        self.acks = []

    async def start(self):
        await self.client.start_notify(TX, self._on_notify)

    async def _on_notify(self, _handle, data):
        b = bytes(data)
        # ACK 帧：A5 02 80 seq len=02 orig_cmd result cksum
        if b[2] == 0x80 and len(b) >= 8 and b[4] == 2:
            self.acks.append((b[3], b[5], b[6]))

    async def send(self, cmd, payload=b"", wait=0.25):
        self.seq = (self.seq + 1) & 0xFF or 1
        await self.client.write_gatt_char(RX, frame(cmd, self.seq, payload), response=False)
        await asyncio.sleep(wait)
        return self.acks[-1][2] if self.acks else None

    async def state(self):
        return await self.client.read_gatt_char(STATE)


async def find_device(timeout=15):
    dev = await BleakScanner.find_device_by_filter(
        lambda d, a: (a.local_name or "").startswith("Lumen"), timeout=timeout
    )
    if not dev:
        raise SystemExit("未找到 Lumen 设备（确认已上电、没被小程序占着）")
    return dev


async def clear_all(rig, strips=8, slots=8):
    """清空所有条的所有段槽。"""
    for strip in range(strips):
        for seg in range(slots):
            await rig.send(CMD_CLEAR_SEGMENT, bytes([strip, seg]), wait=0.03)


async def cmd_setup(rig, strip, brightness, leds):
    await clear_all(rig)
    await rig.send(CMD_SET_BRIGHTNESS, bytes([brightness]), wait=0.2)
    await rig.send(CMD_SET_POWER, bytes([1]), wait=0.3)
    # 每个段覆盖 1 颗灯，沿对角线分散 —— 孤立的点便于逐颗判定，互不粘连。
    indices = [round(i * 63 / (leds - 1)) for i in range(leds)] if leds > 1 else [0]
    for seg, idx in enumerate(indices):
        payload = bytes([strip, seg, idx, idx, TYPE_STATIC, 0x00, 0x00, 255])
        result = await rig.send(CMD_SET_SEGMENT, payload, wait=0.18)
        print(f"  段{seg} strip={strip} LED[{idx}] -> 0x{result:02X}")
    st = await rig.state()
    print(f"\nState: power={st[0]} brightness={st[1]} strip_count={st[8]} seg_count={st[9]}")
    print(f"预期：{leds} 颗红灯（strip {strip} 上），其余全黑")


async def cmd_flood(rig, seconds, hz, brightness):
    """以 hz 频率连续发 SetBrightness —— 制造 BLE 抢占 RMT 中断的压力。"""
    period = 1.0 / hz
    levels = [brightness, max(1, brightness - 1)]
    sent = 0
    t0 = time.monotonic()
    print(f"开始 {hz}Hz 写入，持续 {seconds}s（画面应当不变，亮度在 {levels} 间微调）")
    print("提示：这会让画面亮度轻微变化，判定基线要能容忍这一档")
    while time.monotonic() - t0 < seconds:
        level = levels[sent % len(levels)]
        await rig.send(CMD_SET_BRIGHTNESS, bytes([level]), wait=0)
        sent += 1
        # 用绝对时间对齐，避免累积漂移
        target = t0 + sent * period
        delay = target - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
    elapsed = time.monotonic() - t0
    print(f"完成：{sent} 帧 / {elapsed:.1f}s = {sent/elapsed:.1f} Hz")
    print("若固件有 ACK 丢失或断连，串口会出现提示；录像用 analyze-strip-video.py 判定")


async def cmd_reset(rig):
    await clear_all(rig)
    await rig.send(CMD_SET_BRIGHTNESS, bytes([128]), wait=0.2)
    await rig.send(CMD_SET_POWER, bytes([0]), wait=0.3)
    print("已恢复：无段、亮度 128、关灯")


async def main():
    ap = argparse.ArgumentParser(description="#20 错色实验的 PC 侧 BLE 驱动")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_setup = sub.add_parser("setup", help="配置静态画面（恒定，便于逐帧判定）")
    p_setup.add_argument("--strip", type=int, default=6,
                         help="目标 strip_id（默认 6 = GPIO6，见 LUMEN_STRIP_PINS）")
    p_setup.add_argument("--brightness", type=int, default=60)
    p_setup.add_argument("--leds", type=int, default=8,
                         help="点亮几颗灯（沿对焦线分散，默认 8）")

    p_flood = sub.add_parser("flood", help="高频写入制造 BLE 压力")
    p_flood.add_argument("--seconds", type=float, default=180)
    p_flood.add_argument("--hz", type=float, default=20)
    p_flood.add_argument("--brightness", type=int, default=60)

    sub.add_parser("reset", help="恢复默认状态")

    args = ap.parse_args()
    dev = await find_device()
    print(f"连接 {dev.name} ({dev.address})")
    async with BleakClient(dev) as client:
        rig = Rig(client)
        await rig.start()
        if args.cmd == "setup":
            await cmd_setup(rig, args.strip, args.brightness, args.leds)
        elif args.cmd == "flood":
            await cmd_flood(rig, args.seconds, args.hz, args.brightness)
        else:
            await cmd_reset(rig)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已中断")
