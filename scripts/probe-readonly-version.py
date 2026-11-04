"""只读探针：连上设备读 DeviceInfoReport，打印固件版本与能力位。

不发任何写命令（不 SetPower / 不 SetSegment / 不写 NVS），只做：
  1. BLE 扫描找 Lumen-*；
  2. 连接 + 订阅 notify；
  3. 发 QueryDeviceInfo (0x1D) 与 QueryState (0x05)，读回包。

用途：确认设备上烧的是哪一版固件。
"""
import asyncio
import struct
import sys

from bleak import BleakClient, BleakScanner

SERVICE = "6c756d65-6e00-4b1e-9a3c-000000000001"
RX_CHAR = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX_CHAR = "6c756d65-6e00-4b1e-9a3c-000000000003"

MAGIC = 0xA6
VERSION = 0x04


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


async def send(client, command: int, seq: int, payload: bytes = b"") -> None:
    raw = frame(command, seq, payload)
    # 单分片：容量 180，数据 179，这里远小于。
    chunk = bytes([0x80 | 0x40]) + raw
    await client.write_gatt_char(RX_CHAR, chunk, response=False)


async def main() -> int:
    print("扫描 Lumen-* …")
    devices = await BleakScanner.discover(timeout=8.0)
    target = None
    for device in devices:
        if device.name and device.name.startswith("Lumen"):
            target = device
            break
    if target is None:
        print("没扫到 Lumen-* 设备。请确认它没被别处连着（固件连上就停止广播）。")
        return 1
    print(f"找到 {target.name} @ {target.address}")

    seen = {}

    def on_notify(_sender, data: bytearray) -> None:
        raw = bytes(data)
        # 去分片头（这里应当只有单分片）
        if raw and raw[0] & 0x80:
            raw = raw[1:]
        if len(raw) < 8 or raw[0] != MAGIC:
            return
        command = raw[2]
        length = struct.unpack("<H", raw[4:6])[0]
        payload = raw[6:6 + length]
        seen[command] = payload

    async with BleakClient(target.address, timeout=20.0) as client:
        await client.start_notify(TX_CHAR, on_notify)
        await send(client, 0x1D, 0x01)  # QueryDeviceInfo
        await asyncio.sleep(1.2)
        await send(client, 0x05, 0x02)  # QueryState
        await asyncio.sleep(1.2)
        await client.stop_notify(TX_CHAR)

    info = seen.get(0x88)
    state = seen.get(0x82)
    if info is None:
        print("没收到 DeviceInfoReport（0x88）。")
        return 1
    fw = struct.unpack("<H", info[0:2])[0]
    hw = info[2:8]
    caps = info[8]
    print(f"固件版本: 0x{fw:04X}  (v{fw >> 8}.{fw & 0xFF})")
    print(f"硬件号  : {':'.join('%02X' % b for b in hw)}")
    print(f"能力位  : 0x{caps:02X}")
    if state is not None:
        print(f"State   : 37 字节收到（power={state[0]} brightness={state[1]} strips={state[6]}）")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
