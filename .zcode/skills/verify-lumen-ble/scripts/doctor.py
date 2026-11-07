#!/usr/bin/env python
"""doctor：只读检查「这台 ESP32 值不值得驱动」（v5 契约）。

回答四件事，全部只读（QueryDeviceInfo / QueryState / QueryLayout / QueryScene
都是查询命令，不写 NVS，不发 SetPower / SceneStep）：

  1. 有没有设备：扫得到 `Lumen-*` 吗；
  2. 烧的是哪版固件：`DeviceInfoReport 0x88` 的 version / caps / 上限；
  3. 链路质量：连接后的 MTU（决定单次写容量）；
  4. 现场基线：State 的 power / brightness / 逐带灯珠数 / 逐链部位数，
     以及当前场景名与部位头。

用法：
    python .zcode/skills/verify-lumen-ble/scripts/doctor.py
    python .zcode/skills/verify-lumen-ble/scripts/doctor.py --address CC:8D:A2:C2:56:62

退出码：0 = 值得驱动；1 = 不能驱动（没扫到 / 连不上 / 帧不合法）。
没有设备时这不是「测试失败」，是**前置条件不满足**——它会明确说出来。

> **v5 迁移说明（2026-11-07）**：本脚本原本是 v4 的（`VERSION = 0x04`、
> 37 字节 State、用 `0x12 QueryStrip` 探段）。v5 把 `0x12` 整族退役、State 改
> 32 字节、段查询换成 `0x24 QueryLayout`，所以那份脚本在 v5 固件上**必然**报
> 「收到 DeviceInfoReport 0x88 = NO」——`test-run` 的 e2e 层因此长期 SKIP。
> 现在按 `docs/protocol-v5.md` 重写。
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
VERSION = 0x05

CMD_QUERY_STATE = 0x05
CMD_QUERY_DEVICE_INFO = 0x1D
CMD_QUERY_LAYOUT = 0x24
CMD_QUERY_SCENE = 0x29

RPT_STATE = 0x82
RPT_DEVICE_INFO = 0x88
RPT_LAYOUT = 0x89
RPT_LAYOUT_LIST_END = 0x8A
RPT_SCENE_PART = 0x8B
RPT_SCENE_LIST_END = 0x8D

STATE_BYTES = 32
DEVICE_INFO_BYTES = 15
LAYOUT_REPORT_BYTES = 45

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


def chunks(frame_bytes: bytes, capacity: int = 180):
    """§3.2 的发送分片：bit7 FIRST、bit6 LAST、bit5-0 序号。"""
    total = (len(frame_bytes) + capacity - 1) // capacity
    out = []
    for index in range(total):
        piece = frame_bytes[index * capacity:(index + 1) * capacity]
        head = (0x80 if index == 0 else 0) | (0x40 if index == total - 1 else 0) | index
        out.append(bytes([head]) + piece)
    return out


class Collector:
    """把 notify 帧按命令字归档（保留**全部**帧：多帧报告要数条数）。"""

    def __init__(self):
        self.frames = {}
        self._pending = b""

    def on_notify(self, _sender, data: bytearray) -> None:
        """§3.2：设备 → 主机的每个 notify 都带 1 字节分片头，必须重组。

        不分片时 ctrl = 0xC0（FIRST|LAST|序号 0），裸帧的 0xA6 会被它盖住。
        老脚本那句「查询响应都很小，不会真分片」是错的：45 字节的 LayoutReport
        在 MTU 23 下就是 3 片。
        """
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
        length = struct.unpack("<H", frame_bytes[4:6])[0]
        payload = frame_bytes[6:6 + length]
        self.frames.setdefault(command, []).append(payload)

    def last(self, command):
        items = self.frames.get(command)
        return items[-1] if items else None


async def send(client, command, seq, payload=b"", wait=1.2):
    for piece in chunks(frame(command, seq, payload)):
        await client.write_gatt_char(RX_CHAR, piece, response=False)
    await asyncio.sleep(wait)


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
            await send(client, CMD_QUERY_DEVICE_INFO, 0x01, wait=1.2)
            await send(client, CMD_QUERY_STATE, 0x02, wait=1.2)
            await send(client, CMD_QUERY_LAYOUT, 0x03, bytes([0]), wait=1.5)
            await send(client, CMD_QUERY_SCENE, 0x04, bytes([0]), wait=2.0)
            await client.stop_notify(TX_CHAR)
    except Exception as exc:  # noqa: BLE001
        check("连上设备", False, f"{type(exc).__name__}: {exc}")
        return 1

    info = collector.last(RPT_DEVICE_INFO)
    if not check("收到 DeviceInfoReport 0x88", info is not None):
        return 1
    if not check(f"DeviceInfoReport 载荷 {DEVICE_INFO_BYTES} 字节",
                 len(info) == DEVICE_INFO_BYTES, f"len={len(info)}"):
        return 1

    firmware = struct.unpack("<H", info[0:2])[0]
    hw_id = ":".join("%02X" % b for b in info[2:8])
    max_leds, max_strips, max_parts, max_segs, max_steps, max_scenes = info[8:14]
    caps = info[14]

    major, minor = firmware >> 8, firmware & 0xFF
    check("固件是 v5（v4 帧会被断崖拒绝为 0x07）", major == 5, f"0x{firmware:04X} = v{major}.{minor}")
    print(f"     固件      : v{major}.{minor} (0x{firmware:04X})")
    print(f"     硬件号    : {hw_id}")
    print(f"     上限      : leds={max_leds} strips={max_strips} parts={max_parts} "
          f"part_segs={max_segs} steps={max_steps} scenes={max_scenes}")
    print(f"     caps      : 0x{caps:02X}  (bit0 两层叠加={bool(caps & 0x01)}, "
          f"bit1 fade={bool(caps & 0x02)})")
    check("caps bit0 = 支持两层叠加", bool(caps & 0x01), f"0x{caps:02X}")
    check("六个上限与契约一致（100/8/8/8/8/3）",
          (max_leds, max_strips, max_parts, max_segs, max_steps, max_scenes)
          == (100, 8, 8, 8, 8, 3),
          f"{max_leds}/{max_strips}/{max_parts}/{max_segs}/{max_steps}/{max_scenes}")

    state = collector.last(RPT_STATE)
    if not check("收到 StateReport 0x82", state is not None):
        return 1
    if check(f"State 恰好 {STATE_BYTES} 字节（v5 契约）", len(state) == STATE_BYTES,
             f"len={len(state)}"):
        power = state[0]
        brightness = state[1]
        max_brightness = state[2]
        strip_count = state[3]
        power_mask = state[4]
        active_scene = state[5]
        layout_valid = state[6]
        counts = [struct.unpack("<H", state[8 + i * 2:10 + i * 2])[0] for i in range(8)]
        part_counts = list(state[24:32])
        check("strip_count 在 1..8", 1 <= strip_count <= 8, f"{strip_count}")
        check("brightness ≤ max_brightness", brightness <= max_brightness,
              f"{brightness} ≤ {max_brightness}")
        check("active_scene 在 0..2", 0 <= active_scene <= 2, f"{active_scene}")
        print(f"     State     : power={power} brightness={brightness}/{max_brightness} "
              f"strips={strip_count} power_mask=0x{power_mask:02X} "
              f"scene={active_scene} layout_valid={layout_valid}")
        print(f"     逐带灯珠  : {counts[:strip_count]}")
        print(f"     逐链部位  : {part_counts[:strip_count]}")

    # 布局：v5 的「段查询」是 QueryLayout 0x24 → 若干 0x89 + 一条 0x8A。
    layout_reports = collector.frames.get(RPT_LAYOUT) or []
    check("QueryLayout 有回包（0x89）", len(layout_reports) > 0, f"{len(layout_reports)} 条")
    check("收到 LayoutListEnd 0x8A", collector.last(RPT_LAYOUT_LIST_END) is not None)
    for payload in layout_reports:
        if len(payload) != LAYOUT_REPORT_BYTES:
            check(f"LayoutReport 载荷 {LAYOUT_REPORT_BYTES} 字节", False, f"len={len(payload)}")
            continue
        strip_id, part_id, name_len = payload[0], payload[1], payload[2]
        name = payload[3:3 + name_len].decode("utf-8", "replace")
        seg_count, phase = payload[27], payload[28]
        segs = [(payload[29 + i * 2], payload[30 + i * 2]) for i in range(seg_count)]
        print(f"     部位      : strip{strip_id} part{part_id} "
              f"name={name or '(空)'} segs={segs} phase={phase}")

    # 场景 0：部位头 + 收尾。
    scene_parts = collector.frames.get(RPT_SCENE_PART) or []
    check("QueryScene 有部位头（0x8B）", len(scene_parts) > 0, f"{len(scene_parts)} 条")
    check("收到 SceneListEnd 0x8D", collector.last(RPT_SCENE_LIST_END) is not None)
    scene_end = collector.last(RPT_SCENE_LIST_END)
    if scene_end and len(scene_end) >= 2:
        name_len = scene_end[1]
        name = scene_end[2:2 + name_len].decode("utf-8", "replace")
        print(f"     场景 0 名 : {name or '(空)'}")

    if FAILS:
        print(f"\n先修上面 {len(FAILS)} 项，再驱动；否则断言结果不可信。")
        return 1
    print("\n值得驱动：设备在、固件 v5、State 与布局合法。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="lumen BLE 设备体检（只读，v5）")
    parser.add_argument("--address", default="", help="指定 MAC；省略则用扫到的第一台 Lumen-*")
    parser.add_argument("--timeout", type=float, default=8.0, help="扫描秒数")
    args = parser.parse_args()
    return asyncio.run(probe(args.address, args.timeout))


if __name__ == "__main__":
    sys.exit(main())
