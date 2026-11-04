#!/usr/bin/env python
"""doctor：只读检查「这台 ESP32 值不值得驱动」。

回答四件事，全部只读（QueryDeviceInfo / QueryState / QueryStrip 都是查询命令，
不写 NVS，不发 SetPower / SetSegment）：

  1. 有没有设备：扫得到 `Lumen-*` 吗；
  2. 烧的是哪版固件：`DeviceInfoReport 0x88` 的 version / caps / 上限；
  3. 链路质量：连接后的 MTU（决定单次写容量）；
  4. 现场基线：State 的 power / brightness / 逐带灯珠数与段数。

用法：
    python .zcode/skills/verify-lumen-ble/scripts/doctor.py
    python .zcode/skills/verify-lumen-ble/scripts/doctor.py --address CC:8D:A2:C2:56:62

退出码：0 = 值得驱动；1 = 不能驱动（没扫到 / 连不上 / 帧不合法）。
没有设备时这不是「测试失败」，是**前置条件不满足**——它会明确说出来。
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
RX_CHAR = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX_CHAR = "6c756d65-6e00-4b1e-9a3c-000000000003"

MAGIC = 0xA6
VERSION = 0x04

CMD_QUERY_STATE = 0x05
CMD_QUERY_STRIP = 0x12
CMD_QUERY_DEVICE_INFO = 0x1D

RPT_STATE = 0x82
RPT_SEGMENT = 0x83
RPT_SEGMENT_LIST_END = 0x84
RPT_DEVICE_INFO = 0x88

FAILS = []


def check(name, ok, detail=""):
    print(f"{'OK  ' if ok else 'NO  '} {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)
    return ok


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def frame(command: int, seq: int, payload: bytes = b"") -> bytes:
    body = bytes([MAGIC, VERSION, command, seq]) + struct.pack("<H", len(payload)) + payload
    return body + struct.pack("<H", crc16(body))


class Collector:
    """把 notify 帧按命令字归档（只保留每个命令的最后一帧）。"""

    def __init__(self):
        self.frames = {}

    def on_notify(self, _sender, data: bytearray) -> None:
        raw = bytes(data)
        # 设备侧单分片：最高位是「有分片头」标记。查询响应都很小，不会真分片。
        if raw and raw[0] & 0x80:
            raw = raw[1:]
        if len(raw) < 8 or raw[0] != MAGIC:
            return
        command = raw[2]
        length = struct.unpack("<H", raw[4:6])[0]
        self.frames[command] = raw[6:6 + length]


async def probe(address: str, timeout: float) -> int:
    print("扫描 Lumen-* …")
    devices = await BleakScanner.discover(timeout=timeout)
    named = [d for d in devices if d.name and d.name.startswith("Lumen")]
    if not named:
        check("扫到 Lumen-* 设备", False,
              "没有设备。检查：① 是否上电；② 是否已被别处连着（固件连上就停止广播）；"
              "③ 蓝牙适配器是否可用")
        return 1
    target = next((d for d in named if address and d.address.upper() == address.upper()), named[0])
    check("扫到 Lumen-* 设备", True, f"{target.name} @ {target.address}")
    if address and target.address.upper() != address.upper():
        print(f"     （指定了 {address}，但没扫到它；用扫到的 {target.address}）")

    collector = Collector()
    try:
        async with BleakClient(target.address, timeout=25.0) as client:
            check("连上设备", True)
            mtu = getattr(client, "mtu_size", None)
            check("MTU 已协商（≥23 才能发一帧）", isinstance(mtu, int) and mtu >= 23, f"mtu={mtu}")

            await client.start_notify(TX_CHAR, collector.on_notify)
            await client.write_gatt_char(RX_CHAR, bytes([0xC0]) + frame(CMD_QUERY_DEVICE_INFO, 0x01),
                                         response=False)
            await asyncio.sleep(1.2)
            await client.write_gatt_char(RX_CHAR, bytes([0xC0]) + frame(CMD_QUERY_STATE, 0x02),
                                         response=False)
            await asyncio.sleep(1.2)
            await client.write_gatt_char(RX_CHAR, bytes([0xC0]) + frame(CMD_QUERY_STRIP, 0x03, bytes([0])),
                                         response=False)
            await asyncio.sleep(2.0)
            await client.stop_notify(TX_CHAR)
    except Exception as exc:  # noqa: BLE001
        check("连上设备", False, f"{type(exc).__name__}: {exc}")
        return 1

    info = collector.frames.get(RPT_DEVICE_INFO)
    if not check("收到 DeviceInfoReport 0x88", info is not None):
        return 1
    if not check("DeviceInfoReport 载荷 15 字节", len(info) == 15, f"len={len(info)}"):
        return 1

    firmware = struct.unpack("<H", info[0:2])[0]
    hw_id = ":".join("%02X" % b for b in info[2:8])
    max_leds, max_strips, max_segments, max_stages, max_scripts = info[8:13]
    caps = info[13]
    reserved = info[14]

    major, minor = firmware >> 8, firmware & 0xFF
    check("固件是 v4（v3 帧会被断崖拒绝为 0x07）", major == 4, f"0x{firmware:04X} = v{major}.{minor}")
    print(f"     固件      : v{major}.{minor} (0x{firmware:04X})")
    print(f"     硬件号    : {hw_id}")
    print(f"     上限      : leds={max_leds} strips={max_strips} segments={max_segments} "
          f"stages={max_stages} scripts={max_scripts}")
    print(f"     caps      : 0x{caps:02X}  (bit0 两层叠加={bool(caps & 0x01)}, "
          f"bit1 fade={bool(caps & 0x02)})")
    check("caps.reserved 为 0", reserved == 0, f"reserved={reserved}")

    state = collector.frames.get(RPT_STATE)
    if not check("收到 StateReport 0x82", state is not None):
        return 1
    if check("State 恰好 37 字节（v4 契约）", len(state) == 37, f"len={len(state)}"):
        power = state[0]
        brightness = state[1]
        max_brightness = state[5]
        strip_count = state[6]
        power_mask = state[11]
        counts = [struct.unpack("<H", state[13 + i * 2:15 + i * 2])[0] for i in range(8)]
        seg_counts = list(state[29:37])
        check("strip_count 在 1..8", 1 <= strip_count <= 8, f"{strip_count}")
        check("brightness ≤ max_brightness", brightness <= max_brightness,
              f"{brightness} ≤ {max_brightness}")
        print(f"     State     : power={power} brightness={brightness}/{max_brightness} "
              f"strips={strip_count} power_mask=0x{power_mask:02X}")
        print(f"     逐带灯珠  : {counts[:strip_count]}")
        print(f"     逐带段数  : {seg_counts[:strip_count]}")

    reports = collector.frames.get(RPT_SEGMENT)
    if reports is not None:
        check("QueryStrip 有回包（0x83）", True, f"segId={reports[0]} start={reports[1]} end={reports[2]}")
    # SegmentListEnd 是「查询结束」的标志，缺了说明回包被截断。
    check("收到 SegmentListEnd 0x84", collector.frames.get(RPT_SEGMENT_LIST_END) is not None)

    if FAILS:
        print(f"\n先修上面 {len(FAILS)} 项，再驱动；否则断言结果不可信。")
        return 1
    print("\n值得驱动：设备在、固件 v4、State 合法。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="lumen BLE 设备体检（只读）")
    parser.add_argument("--address", default="", help="指定 MAC；省略则用扫到的第一台 Lumen-*")
    parser.add_argument("--timeout", type=float, default=8.0, help="扫描秒数")
    args = parser.parse_args()
    return asyncio.run(probe(args.address, args.timeout))


if __name__ == "__main__":
    sys.exit(main())
