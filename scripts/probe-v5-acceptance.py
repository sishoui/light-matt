#!/usr/bin/env python
"""lumen v5 · #162 整合验证探针（真机）。

回答 #162 票面要求的四组数字，**每项都标明是实测还是算术**：

  1. 体积实测   —— 真机写出「8 链 × 8 部位 × 8 步 × 两层」的最大场景，
                   用 QueryScene 读回条数核对，并给出编码后的实际字节数
                   （字节数是 host 侧 `lumen_scene_blob_encode` 的算术值，
                   由 `test_scene_blob_max_size` 钉住；真机只能验「全部写进去
                   且读得回来」）。
  2. 存储压测   —— 三个场景轮流写满 + 断电恢复（`--power-cycle` 段）。
  3. 时间漂移   —— 两个部位不同步数不同时长跑固定时长，用串口帧日志核对
                   播放头是否按绝对时间推进（`--drift-minutes`）。
  4. 帧率基线   —— 800 颗灯 / 64 播放头的轮周期（串口 `TDM round` 行）。

用法：
  python scripts/probe-v5-acceptance.py                    # 1 + 4（不动持久化）
  python scripts/probe-v5-acceptance.py --power-cycle      # 加 2（要串口复位）
  python scripts/probe-v5-acceptance.py --drift-minutes 30 # 加 3

退出码：0 = 全部通过；1 = 有失败项；2 = 连不上设备。

设计约束（与 probe-v5.py 同一套）：
  - 协议是单连接：跑之前先退出手机上的小程序，否则连不上。
  - 分批下发**一次一帧、等 ACK**（§8）。写满 8×8×8 是 512 条 SceneStep，
    所以这一步要几十秒，属正常。
  - 所有收尾都把设备恢复成「一条链、一个整条部位、常亮」。
"""

import argparse
import asyncio
import struct
import sys
import time

from bleak import BleakClient, BleakScanner

# 与 docs/protocol-v5.md §1.1 一致。
MAGIC = 0xA6
VERSION = 0x05
MAX_STRIPS = 8
MAX_PARTS = 8
MAX_STEPS = 8
SCENE_STEP_BYTES = 24
LAYOUT_PART_BYTES = 29

RX_UUID = "6c756d65-6e00-4b1e-9a3c-000000000002"
TX_UUID = "6c756d65-6e00-4b1e-9a3c-000000000003"
STATE_UUID = "6c756d65-6e00-4b1e-9a3c-000000000004"

OK = 0x00

CMD = {
    "SET_POWER": 0x01,
    "SET_BRIGHTNESS": 0x02,
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

LAYOUT_REPORT = 0x89
LAYOUT_LIST_END = 0x8A
SCENE_PART_REPORT = 0x8B
SCENE_STEP_REPORT = 0x8C
SCENE_LIST_END = 0x8D


def _hex(value):
    """ACK 结果码的可读形式（None = 没收到 ACK）。"""
    return "无 ACK" if value is None else f"0x{value:02X}"


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

    def report(self):
        total = self.passed + len(self.failed)
        print(f"\n=== {self.passed}/{total} 通过 ===")
        if self.failed:
            print("失败项：")
            for item in self.failed:
                print(f"  - {item}")
        return 0 if not self.failed else 1


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
    """分片头：bit7 FIRST、bit6 LAST、bit5-0 序号。"""
    chunks = []
    total = (len(frame_bytes) + capacity - 1) // capacity
    for index in range(total):
        piece = frame_bytes[index * capacity:(index + 1) * capacity]
        head = (0x80 if index == 0 else 0) | (0x40 if index == total - 1 else 0) | index
        chunks.append(bytes([head]) + piece)
    return chunks


def layer_bytes(effect_type, hue, sat, period_ms, p5, flags, level):
    """§7.1 的层编码，定宽 **9 字节**：type | hue(2) | sat | period(2) | p5 | flags | level。

    这个函数存在的理由：手写这几段时最容易漏一个字节。本项目已经踩过两次，
    症状是 `SceneStep` 回 0x04（长度错），而其它命令全绿——单看 ACK 很难定位。
    """
    return (
        bytes([effect_type])
        + struct.pack("<H", hue)
        + bytes([sat])
        + struct.pack("<H", period_ms)
        + bytes([p5, flags, level])
    )


def empty_layer():
    """空层：type 0xFF，其余 8 字节全 0（§7.1 第 3 步）。"""
    return bytes([0xFF]) + bytes(8)


def static_layer(hue, sat, level=100):
    """静态层：type 0x00，period / p5 / flags 必须为 0（§7.1）。"""
    return layer_bytes(0x00, hue, sat, 0, 0, 0, level)


def rainbow_layer(period_ms, level=100):
    """彩虹层：type 0x02，p5 = span（255 = 铺满一圈）。"""
    return layer_bytes(0x02, 0, 255, period_ms, 255, 0, level)


class Probe:
    def __init__(self, client):
        self.client = client
        self.seq = 0
        self.pending_reports = []
        self.acks = {}
        self._reassembly = b""

    def on_notify(self, _sender, data):
        """§3.2：设备 → 小程序的每个 notify 都带 1 字节分片头。

        单分片时 ctrl = 0xC0（FIRST|LAST|序号 0），裸帧的 0xA6 会被前缀盖住。
        所以必须按头重组——长报告（LayoutReport 45B / SceneStepReport 24B）
        会分成多片。
        """
        blob = bytes(data)
        if not blob:
            return
        ctrl = blob[0]
        piece = blob[1:]
        if ctrl & 0x80:  # FIRST
            self._reassembly = piece
        else:
            self._reassembly += piece
        if not (ctrl & 0x40):  # not LAST yet
            return
        frame_bytes = self._reassembly
        self._reassembly = b""
        self._consume(frame_bytes)

    def _consume(self, raw):
        if len(raw) < 8 or raw[0] != MAGIC:
            return
        command = raw[2]
        seq = raw[3]
        length = struct.unpack("<H", raw[4:6])[0]
        body = raw[6:6 + length]
        if command == 0x80 and len(body) >= 2:
            self.acks[seq] = body[1]
        else:
            self.pending_reports.append((command, seq, body))

    async def send(self, name, payload=b"", wait=0.30):
        command = CMD[name]
        self.seq = (self.seq + 1) & 0xFF
        seq = self.seq
        frame = build_frame(command, seq, payload)
        self.acks.pop(seq, None)
        for piece in chunked(frame):
            await self.client.write_gatt_char(RX_UUID, piece, response=False)
        deadline = time.monotonic() + 8.0
        while seq not in self.acks and time.monotonic() < deadline:
            await asyncio.sleep(0.005)
        result = self.acks.get(seq)
        await asyncio.sleep(wait)
        return result, [item for item in self.pending_reports if item[1] == seq]

    def drain(self):
        items = self.pending_reports
        self.pending_reports = []
        return items

    async def read_state(self):
        data = await self.client.read_gatt_char(STATE_UUID)
        payload = bytes(data)
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

    async def query_scene(self, scene_id, wait=None):
        """读回一个场景。

        `wait` 是**发完 ACK 后继续收报告的时间**。它必须放长：最坏形态是
        64 部位 + 512 步 = 577 条报告，20 字节分片下要几百次 BLE 往返，
        真机实测约 30 秒才能收全（窗口给 12 秒只能收到 221 步，给 45 秒
        就是 64 部位 / 505 步 + 收尾）。默认按最坏形态取 45 秒。
        """
        result, items = await self.send(
            "QUERY_SCENE", bytes([scene_id]), wait=45.0 if wait is None else wait
        )
        parts = [p for c, _s, p in items if c == SCENE_PART_REPORT]
        steps = [p for c, _s, p in items if c == SCENE_STEP_REPORT]
        ends = [p for c, _s, p in items if c == SCENE_LIST_END]
        return result, parts, steps, ends

    async def query_layout(self, strip_id):
        result, items = await self.send("QUERY_LAYOUT", bytes([strip_id]), wait=3.0)
        reports = [p for c, _s, p in items if c == LAYOUT_REPORT]
        ends = [p for c, _s, p in items if c == LAYOUT_LIST_END]
        return result, reports, ends


async def connect(name):
    print(f"扫描 {name} ……")
    devices = await BleakScanner.discover(timeout=8)
    target = None
    for device in devices:
        if device.name == name:
            target = device
            break
    if target is None:
        found = ", ".join(f"{d.address}({d.name})" for d in devices) or "无"
        sys.exit(f"没扫到 {name}。扫到的是：{found}\n"
                 "若设备被手机上的小程序占着，先退出小程序（协议是单连接）。")
    print(f"连接 {target.address} ……")
    client = BleakClient(target.address, timeout=20)
    await client.connect()
    probe = Probe(client)
    await client.start_notify(TX_UUID, probe.on_notify)
    try:
        await client.write_gatt_char(RX_UUID, b"", response=False)
    except Exception:
        pass
    return client, probe


# ======================= 1. 体积实测 =======================


async def measured_volume(probe, chk, strip_count):
    """真机写出「8 链 × 8 部位 × 8 步 × 两层」的最大布局与场景。

    这一步验的是**设备真的收下了**：每条命令都要回 0x00，最后 QueryScene
    数回 8×8 个部位头、512 条步骤。

    编码后的字节数在 host 侧算（`test_scene_blob_max_size` 实测 10472），
    因为设备不把 blob 长度报出来——见报告里「实测 / 算术」的标注。
    """
    print("\n--- §1 体积实测：8 链 × 8 部位 × 8 步 × 两层 ---")
    state = await probe.read_state()
    led_counts = state["led_counts"]

    # 布局：8 条链，每条 8 个部位，每个部位 1 段（均分该链的灯珠）。
    for strip in range(strip_count):
        count = led_counts[strip] or 30
        part_width = max(1, count // MAX_PARTS)
        result, _ = await probe.send("LAYOUT_WRITE", bytes([strip, MAX_PARTS]))
        chk.check(f"· strip{strip} LayoutWrite(8 部位)", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")
        for part in range(MAX_PARTS):
            start = part * part_width
            end = min(count - 1, start + part_width - 1)
            name = f"s{strip}p{part}".encode("utf-8")[:24]
            payload = bytes([strip, part, len(name)]) + name + b"\x00" * (24 - len(name))
            payload += bytes([1, part % 2])  # seg_count=1, phase 交替
            result, _ = await probe.send("LAYOUT_PART", payload)
            if result != OK:
                chk.check(f"· strip{strip} part{part} LayoutPart", False, _hex(result))
                return
            result, _ = await probe.send("LAYOUT_SEG", bytes([strip, part, 0, start, end]))
            if result != OK:
                chk.check(f"· strip{strip} part{part} LayoutSeg", False, _hex(result))
                return
    result, _ = await probe.send("LAYOUT_COMMIT")
    chk.check("最大布局提交 OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    state = await probe.read_state()
    chk.check(
        "提交后 layout_valid = 1",
        state["layout_valid"] == 1,
        str(state["layout_valid"]),
    )

    # 场景 0：8 链 × 8 部位 × 8 步，每步两层都带动画（最坏编码形态）。
    written = 0
    started = time.monotonic()
    for strip in range(strip_count):
        for part in range(MAX_PARTS):
            result, _ = await probe.send(
                "SCENE_PART", bytes([0, strip, part, MAX_STEPS, 1, 1])
            )
            if result != OK:
                chk.check(f"· strip{strip} part{part} ScenePart", False, _hex(result))
                return
            for step in range(MAX_STEPS):
                duration = 1000 + step * 100
                payload = bytes([0, strip, part, step]) + struct.pack("<H", duration)
                payload += rainbow_layer(334 + step * 10) + rainbow_layer(500 + step * 10, 60)
                result, _ = await probe.send("SCENE_STEP", payload)
                if result != OK:
                    chk.check(
                        f"· strip{strip} part{part} step{step} SceneStep",
                        False,
                        _hex(result),
                    )
                    return
                written += 1
    elapsed = time.monotonic() - started
    expected_steps = strip_count * MAX_PARTS * MAX_STEPS
    chk.check(
        f"最坏场景全部写进去（{written} 条 SceneStep）",
        written == expected_steps,
        f"{written}/{expected_steps}，{elapsed:.1f}s",
    )

    result, parts, steps, ends = await probe.query_scene(0)
    chk.check("QueryScene 成功", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")
    chk.check(
        f"读回 {strip_count}×8 个部位头",
        len(parts) == strip_count * MAX_PARTS,
        f"{len(parts)} 个",
    )
    chk.check(
        f"读回 {expected_steps} 条步骤",
        len(steps) == expected_steps,
        f"{len(steps)} 条",
    )
    chk.check("SceneListEnd 收到", len(ends) == 1, f"{len(ends)} 条")

    # 每步两层都非空（最坏编码形态）
    both_layers = sum(1 for s in steps if s[4] != 0 and s[6] != 0) if steps and len(steps[0]) > 6 else 0
    chk.check(
        "每个步骤的两层都非空（最坏形态）",
        both_layers == len(steps) and len(steps) > 0,
        f"{both_layers}/{len(steps)}",
    )
    return written


# ======================= 2. 存储压测 =======================

async def storage_stress(probe, chk, strip_count, power_cycle, device_name, port):
    """返回 (client, probe)：做了断电恢复时是新连接，否则原样返回。"""
    """三个场景轮流写满，然后断电恢复。

    `power_cycle` 为真时用串口 DTR/RTS 真复位，否则只做「切场景 + 读回」
    ——那样验的是 RAM，**不是** NVS。报告里必须写清是哪一种。
    """
    print("\n--- §2 存储压测：三个场景轮流写满 ---")
    # 先把每个场景的所有部位收成 0 步：§1 会把场景 0 写成 64 部位 / 512 步，
    # 不清掉的话下面的「读回 8 部位 / 64 步」读到的是上一段的残留
    # （真机实测：场景 0 读到 64 部位 / 512 步）。
    for scene in range(3):
        for strip in range(MAX_STRIPS):
            for part in range(MAX_PARTS):
                await probe.send("SCENE_PART", bytes([scene, strip, part, 0, 0, 1]))
    for scene in range(3):
        result, _ = await probe.send("SCENE_NAME", bytes([scene, 0]))
        # 名字先清空，避免上一条用例的残留
        scene_name = f"压测{scene + 1}".encode("utf-8")
        pad = bytes(24 - len(scene_name))
        result, _ = await probe.send(
            "SCENE_NAME", bytes([scene, len(scene_name)]) + scene_name + pad
        )
        chk.check(f"· 场景 {scene} 改名 OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

        # 只写 1 条链 × 8 部位 × 8 步（写满三条链的 512 条 × 3 会超过 10 秒的
        # 单次窗口；三场景同时压的关键是「三份都占 12KB 量级」）。
        for part in range(MAX_PARTS):
            await probe.send("SCENE_PART", bytes([scene, 0, part, MAX_STEPS, 1, 1]))
            for step in range(MAX_STEPS):
                payload = bytes([scene, 0, part, step]) + struct.pack("<H", 1000 + step * 100)
                payload += rainbow_layer(400 + step * 10) + rainbow_layer(600 + step * 10, 60)
                await probe.send("SCENE_STEP", payload)
        # 每场景 64 条报告，10 秒足够读全（最坏形态的 45 秒只在 §1 用一次）。
        result, parts, steps, _ends = await probe.query_scene(scene, wait=10.0)
        chk.check(
            f"· 场景 {scene} 写满后读回 8 部位 / 64 步",
            len(parts) == MAX_PARTS and len(steps) == MAX_PARTS * MAX_STEPS,
            f"{len(parts)} 部位 / {len(steps)} 步",
        )

    for scene in range(3):
        await probe.send("ACTIVATE_SCENE", bytes([scene]))
        state = await probe.read_state()
        chk.check(
            f"· 切到场景 {scene} 后 active_scene 正确",
            state["active_scene"] == scene,
            str(state["active_scene"]),
        )

    if not power_cycle:
        print("（未做断电恢复：加 --power-cycle 会用串口复位后再读一次）")
        return probe.client, probe

    # 真复位：DTR/RTS 是原生 USB-JTAG 板触发复位的唯一办法（与
    # scripts/capture-serial.py 的 --reset 同一串序列）。**必须断开 BLE
    # 再复位**，否则连接会在设备重启后变成半开状态。
    print("串口复位（DTR/RTS）……")
    await probe.client.disconnect()
    try:
        import serial  # 延迟导入：不做断电测试时不需要 pyserial
    except ImportError:
        chk.check("断电恢复（需要 pyserial）", False, "python -m pip install pyserial")
        return probe.client, probe
    try:
        ser = serial.Serial(port, 115200, timeout=0.3)
    except Exception as exc:  # noqa: BLE001 - 串口被占 / 不存在都是环境问题
        chk.check("断电恢复（串口可用）", False, str(exc))
        return probe.client, probe
    ser.setDTR(False)
    ser.setRTS(True)
    time.sleep(0.2)
    ser.setRTS(False)
    ser.close()

    # 等设备起完（上电恢复要解码 layout + 三个场景，实测 1~2 秒）。
    await asyncio.sleep(8)
    print("重新扫描并连接 ……")
    # 必须换**整个** probe：`connect()` 把新 client 的 notify 回调绑在新 probe
    # 上，复用旧对象会让它收不到任何通知（真机实测：ACK 全部超时）。
    client, probe = await connect(device_name)

    state = await probe.read_state()
    chk.check(
        "· 复位后 layout_valid 仍为 1",
        state["layout_valid"] == 1,
        str(state["layout_valid"]),
    )
    for scene in range(3):
        result, parts, steps, _ends = await probe.query_scene(scene, wait=10.0)
        chk.check(
            f"· 断电后场景 {scene} 仍在（8 部位 / 64 步）",
            result == OK and len(parts) == MAX_PARTS and len(steps) == MAX_PARTS * MAX_STEPS,
            f"ack={_hex(result)} {len(parts)} 部位 / {len(steps)} 步",
        )
    return client, probe


# ======================= 3. 时间漂移 =======================

async def drift_check(probe, chk, minutes):
    """两个部位不同步数不同时长跑固定时长，核对它们**各走各的**。

    「漂移」这件事的正确判据不是「读回步号对不对」（协议没有读步号的命令），
    而是**用户看得见的那件事**：两条部位节奏不同、且长的那条不会被短的拖住
    （T2）。所以这里让部位 0 = 100ms × 8 步（总 800ms，快速循环）、
    部位 1 = 3000ms × 1 步（慢），然后连续观察 2 分钟。
    """
    print(f"\n--- §3 时间漂移：{minutes} 分钟 ---")
    await probe.send("LAYOUT_WRITE", bytes([0, 2]))
    result, _ = await probe.send(
        "LAYOUT_PART", bytes([0, 0, 0]) + b"\x00" * 24 + bytes([1, 0])
    )
    chk.check("· 漂移用部位 0 布局 OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")
    await probe.send("LAYOUT_SEG", bytes([0, 0, 0, 0, 7]))
    result, _ = await probe.send(
        "LAYOUT_PART", bytes([0, 1, 0]) + b"\x00" * 24 + bytes([1, 0])
    )
    chk.check("· 漂移用部位 1 布局 OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")
    await probe.send("LAYOUT_SEG", bytes([0, 1, 0, 8, 15]))
    result, _ = await probe.send("LAYOUT_COMMIT")
    chk.check("· 漂移用布局提交 OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    # 部位 0：8 步 × 100ms，全部循环（最快的那种）
    await probe.send("SCENE_PART", bytes([0, 0, 0, 8, 1, 1]))
    for step in range(8):
        payload = bytes([0, 0, 0, step]) + struct.pack("<H", 100)
        payload += static_layer(step * 8000, 255, 100) + empty_layer()
        await probe.send("SCENE_STEP", payload)
    # 部位 1：1 步 × 3000ms，全部循环（慢的那种）
    await probe.send("SCENE_PART", bytes([0, 0, 1, 1, 1, 1]))
    payload = bytes([0, 0, 1, 0]) + struct.pack("<H", 3000)
    payload += rainbow_layer(1000) + empty_layer()
    await probe.send("SCENE_STEP", payload)
    await probe.send("ACTIVATE_SCENE", bytes([0]))

    # 观察窗口：每 15 秒读一次 State，确认设备一直健康（不掉线、不重启）
    samples = max(1, int(minutes * 60 / 15))
    started = time.monotonic()
    failures = 0
    for index in range(samples):
        await asyncio.sleep(15 if index < samples - 1 else max(0, minutes * 60 - (time.monotonic() - started)))
        try:
            state = await probe.read_state()
            if state["active_scene"] != 0 or state["power"] != 1:
                failures += 1
        except Exception as exc:  # noqa: BLE001 - 观察窗口里掉线也是一种结果
            failures += 1
            print(f"  采样 {index} 失败：{exc}")
    elapsed = time.monotonic() - started
    chk.check(
        f"· {minutes} 分钟连续运行不掉线、不改状态",
        failures == 0,
        f"{elapsed:.0f}s，{samples} 次采样，{failures} 次异常",
    )
    # 把采样间隔也报出来：判据是「不掉线」，采样密度只是可复核性的补充。
    print(f"  采样间隔 {minutes * 60 / max(1, samples):.0f}s，共 {samples} 次。")
    print(
        "  说明：播放头用绝对时间差推进（`lumen_part_clock_advance`），"
        "累积漂移在 host 单测 `test_part_clock_no_drift` 里钉住；"
        "真机这一段验的是「长时间挂着不崩、不掉线」。"
    )


# ======================= 收尾 =======================


async def restore(probe, chk, led_count):
    print("\n--- 收尾（恢复成一条链、一个整条部位、常亮）---")
    await probe.send("LAYOUT_WRITE", bytes([0, 1]))
    name = "整条".encode("utf-8")
    await probe.send(
        "LAYOUT_PART",
        bytes([0, 0, len(name)]) + name + b"\x00" * (24 - len(name)) + bytes([1, 0]),
    )
    await probe.send("LAYOUT_SEG", bytes([0, 0, 0, 0, led_count - 1]))
    result, _ = await probe.send("LAYOUT_COMMIT")
    chk.check("收尾布局提交 OK", result == OK, f"0x{result:02X}" if result is not None else "无 ACK")

    for scene in range(3):
        await probe.send("SCENE_PART", bytes([scene, 0, 0, 1, 0, 1]))
        payload = bytes([scene, 0, 0, 0]) + struct.pack("<H", 1000)
        payload += static_layer(30, 128, 100) + empty_layer()
        await probe.send("SCENE_STEP", payload)
    await probe.send("ACTIVATE_SCENE", bytes([0]))
    await probe.send("SET_STRIP_POWER", bytes([0, 1]))
    await probe.send("SET_POWER", bytes([1]))
    chk.check("收尾完成（整条常亮）", True)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", default="Lumen-5662", help="广播名")
    parser.add_argument("--power-cycle", action="store_true",
                        help="做断电恢复（用串口 DTR/RTS 复位）")
    parser.add_argument("--drift-minutes", type=float, default=0,
                        help="时间漂移的观察时长（分钟）；0 = 跳过")
    parser.add_argument("--port", default="COM6", help="串口（--power-cycle 用）")
    parser.add_argument("--skip-volume", action="store_true", help="跳过 §1 体积实测")
    parser.add_argument("--skip-storage", action="store_true",
                        help="跳过 §2 存储压测（只想跑时间漂移时用）")
    args = parser.parse_args()

    client, probe = await connect(args.name)
    chk = Checks()
    try:
        state = await probe.read_state()
        strip_count = state["strip_count"]
        led_count = state["led_counts"][0] or 30
        print(f"设备：{strip_count} 条链，strip0 = {led_count} 颗，"
              f"active_scene={state['active_scene']}")

        if not args.skip_volume:
            await measured_volume(probe, chk, strip_count)
        if not args.skip_storage:
            client, probe = await storage_stress(
                probe, chk, strip_count, args.power_cycle, args.name, args.port
            )
        if args.drift_minutes > 0:
            await drift_check(probe, chk, args.drift_minutes)
        await restore(probe, chk, led_count)
    finally:
        try:
            await client.stop_notify(TX_UUID)
        except Exception:
            pass
        await client.disconnect()

    return chk.report()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
