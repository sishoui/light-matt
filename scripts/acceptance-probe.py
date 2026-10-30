#!/usr/bin/env python
"""PC 侧真机验收探针：当 central 跑协议，边跑边抓串口，两侧按 seq 对齐。

为什么需要它：#14 的七条里，一部分需要人眼（灯带颜色）和手机（小程序 UI），
但协议层的证据可以用 PC 当 central 稳定复现——ACK 是否回显 seq、MTU 协商、
亮度 latest-wins 不排队、State read/StateReport 一致、断电后 NVS 恢复。
这些用手机点很难一次点准，也很难留下逐帧日志。

它**不替代**真机人眼验收：灯带颜色、断线回连 UI、隐藏面板可读性仍要人看。

用法（仓库根目录，设备空闲时）：
    python scripts/acceptance-probe.py                 # 全套（含灯珠数量，会改设备状态）
    python scripts/acceptance-probe.py --group basic   # 只跑 ①②③④，不动灯珠数量
    python scripts/acceptance-probe.py --group count   # 只跑 ⑥ 的灯珠数量边界
    python scripts/acceptance-probe.py --no-serial     # 串口被占用时跳过抓取

约定：
- 设备是单连接的。手机上的小程序若正在回连，会抢走连接（断线后 1s/2s/4s 退避）。
  跑之前先把小程序退到后台或杀掉，否则会看到 `disconnected` 而失败。
- 跑完会把设备恢复到脚本开始时的状态（除非中途出错）。
"""

import argparse
import queue
import sys
import threading
import time

try:
    import serial
except ImportError:
    sys.exit("需要 pyserial：python -m pip install pyserial")

try:
    import asyncio

    from bleak import BleakClient, BleakScanner
    from bleak.exc import BleakError
except ImportError:
    sys.exit("需要 bleak：python -m pip install bleak")


ADDRESS = "CC:8D:A2:C2:56:62"
NAME = "Lumen-5662"
SVC = "6c756d65-6e00-4b1e-9a3c-000000000001"
UUID_RX = "6c756d65-6e00-4b1e-9a3c-000000000002"
UUID_TX = "6c756d65-6e00-4b1e-9a3c-000000000003"
UUID_STATE = "6c756d65-6e00-4b1e-9a3c-000000000004"

MAGIC = 0xA5
VERSION = 0x01

CMD_SET_POWER = 0x01
CMD_SET_BRIGHTNESS = 0x02
CMD_SET_COLOR = 0x03
CMD_SET_ALL = 0x04
CMD_QUERY_STATE = 0x05
CMD_SET_LED_COUNT = 0x06

CMD_ACK = 0x80
CMD_EVENT = 0x81
CMD_STATE_REPORT = 0x82

RESULT = {
    0x00: "OK",
    0x01: "InvalidParam",
    0x02: "UnknownCommand",
    0x03: "BadChecksum",
    0x04: "BadLength",
    0x05: "Busy",
    0x06: "StorageFailed",
    0x07: "UnsupportedVersion",
    0x08: "BadMagic",
    0x09: "InternalError",
}


# ---------------------------------------------------------------- 帧编解码


def checksum(body):
    return (~sum(body)) & 0xFF


def encode(cmd, seq, payload=b""):
    body = bytes([MAGIC, VERSION, cmd, seq, len(payload)]) + bytes(payload)
    return body + bytes([checksum(body)])


def decode(buf):
    if len(buf) < 6:
        return None
    if buf[0] != MAGIC or buf[1] != VERSION:
        return None
    length = buf[4]
    total = 6 + length
    if len(buf) != total:
        return None
    body = buf[: 5 + length]
    if checksum(body) != buf[5 + length]:
        return None
    return {"cmd": buf[2], "seq": buf[3], "payload": bytes(buf[5 : 5 + length])}


# ---------------------------------------------------------------- 串口抓取


class SerialTap:
    """后台线程读 COM 口，按到达时间打时间戳。设备空闲时不输出，这里只等。"""

    def __init__(self, port, enabled=True):
        self.port = port
        self.enabled = enabled
        self.lines = []
        self._stop = threading.Event()
        self._thread = None
        self._ser = None

    def start(self):
        if not self.enabled:
            return
        try:
            self._ser = serial.Serial(self.port, 115200, timeout=0.2)
        except Exception as exc:  # noqa: BLE001
            print(f"[serial] 打开 {self.port} 失败：{str(exc).splitlines()[0]}")
            print("[serial] 继续跑 BLE 部分，但缺少固件侧证据")
            self.enabled = False
            return
        print(f"[serial] {self.port} 已打开（后台抓取）")
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        buf = b""
        while not self._stop.is_set():
            try:
                chunk = self._ser.read(4096)
            except Exception:  # noqa: BLE001
                break
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                text = raw.decode("utf-8", errors="replace").rstrip("\r")
                if text.strip():
                    self.lines.append((time.time(), text))

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:  # noqa: BLE001
                pass

    def rx_lines(self):
        return [(t, ln) for t, ln in self.lines if "RX cmd=" in ln]


# ---------------------------------------------------------------- 探针


class AckWaiter:
    """按 seq 收集 notify，解出 ACK / StateReport / Event。

    必须用 await 轮询而不是阻塞的 queue.get()：notify 回调跑在同一个事件循环里，
    阻塞会把回调一起卡住，ACK 就会「慢一拍」才到。
    """

    def __init__(self):
        self.acks = []
        self.reports = []
        self.events = []
        self.raw = []

    def on_notify(self, _sender, data: bytearray):
        frame = decode(bytes(data))
        entry = {"t": time.time(), "hex": bytes(data).hex().upper(), "frame": frame}
        self.raw.append(entry)
        if frame is None:
            return
        if frame["cmd"] == CMD_ACK and len(frame["payload"]) == 2:
            entry["ack"] = (frame["payload"][0], frame["payload"][1])
            self.acks.append(entry)
        elif frame["cmd"] == CMD_STATE_REPORT and len(frame["payload"]) == 8:
            entry["state"] = tuple(frame["payload"])
            self.reports.append(entry)
        elif frame["cmd"] == CMD_EVENT and len(frame["payload"]) == 2:
            entry["event"] = (frame["payload"][0], frame["payload"][1])
            self.events.append(entry)

    @staticmethod
    async def _poll(pred, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            found = pred()
            if found is not None:
                return found
            await asyncio.sleep(0.005)
        return None

    async def wait(self, seq, timeout=3.0):
        """等 seq 匹配的 ACK（每条只被取走一次）。"""

        def pred():
            for e in self.acks:
                if e["frame"]["seq"] == seq and not e.get("_used"):
                    e["_used"] = True
                    return e
            return None

        return await self._poll(pred, timeout)

    async def wait_report(self, seq, timeout=3.0):
        def pred():
            for e in self.reports:
                if e["frame"]["seq"] == seq and not e.get("_used"):
                    e["_used"] = True
                    return e
            return None

        return await self._poll(pred, timeout)

    async def drain(self, seconds=0.6):
        started = len(self.raw)
        await asyncio.sleep(seconds)
        return self.raw[started:]


class Probe:
    def __init__(self, client, tap):
        self.client = client
        self.tap = tap
        self.waiter = AckWaiter()
        self.seq = 0
        self.failures = []
        self.notes = []

    def next_seq(self):
        self.seq = (self.seq + 1) & 0xFF
        if self.seq == 0:
            self.seq = 1
        return self.seq

    async def send(self, cmd, payload=b"", seq=None):
        s = self.next_seq() if seq is None else seq
        frame = encode(cmd, s, payload)
        await self.client.write_gatt_char(UUID_RX, frame, response=False)
        return s, frame

    async def command(self, cmd, payload=b"", timeout=3.0, label=""):
        seq, frame = await self.send(cmd, payload)
        entry = await self.waiter.wait(seq, timeout=timeout)
        name = label or f"cmd=0x{cmd:02X}"
        if entry is None:
            self.fail(
                f"{name}: 等 ACK seq={seq} 超时（{timeout}s）；"
                f"已有 ACK: {[(e['frame']['seq'], e['ack']) for e in self.waiter.acks[-5:]]}"
            )
            return None
        ack_cmd, result = entry["ack"]
        ok = ack_cmd == cmd and result == 0x00
        if ack_cmd != cmd:
            self.fail(f"{name}: ACK 回显命令字 0x{ack_cmd:02X} != 0x{cmd:02X}")
        return {"seq": seq, "cmd": cmd, "ack_cmd": ack_cmd, "result": result, "ok": ok, "frame": frame}

    def expect(self, cond, msg):
        if not cond:
            self.fail(msg)
        return cond

    def fail(self, msg):
        self.failures.append(msg)
        print(f"  ✗ {msg}")

    def ok(self, msg):
        print(f"  ✓ {msg}")

    async def read_state(self):
        data = await self.client.read_gatt_char(UUID_STATE)
        return tuple(data)

    async def query_state(self, timeout=3.0, label="QueryState"):
        seq, _ = await self.send(CMD_QUERY_STATE)
        ack = await self.waiter.wait(seq, timeout=timeout)
        report = await self.waiter.wait_report(seq, timeout=timeout)
        if ack is None or report is None:
            self.fail(
                f"{label}: QueryState seq={seq} 缺 ACK 或 StateReport"
                f"（ack={'有' if ack else '无'}, report={'有' if report else '无'}）"
            )
            return None
        return {"seq": seq, "ack": ack, "state": report["state"]}


def fmt_state(state):
    power, bright, r, g, b, lo, hi, maxb = state
    return (
        f"power={power} brightness={bright} rgb=({r},{g},{b}) "
        f"leds={lo | (hi << 8)} max_brightness={maxb}"
    )


# ---------------------------------------------------------------- 各组验收


async def group_basic(probe: Probe):
    print("\n=== ① 连接 + MTU ===")
    mtu = probe.client.mtu_size
    print(f"  MTU = {mtu}")
    probe.expect(mtu >= 23, f"MTU {mtu} < 23（连协议最小帧都放不下）")
    services = probe.client.services
    uuids = [str(s.uuid) for s in services]
    probe.expect(
        SVC in uuids,
        f"未发现 lumen service {SVC}；实际 {uuids}",
    )
    if SVC in uuids:
        chars = [str(c.uuid) for s in services if str(s.uuid) == SVC for c in s.characteristics]
        probe.expect(UUID_RX in chars, f"缺 RX 特征 {UUID_RX}")
        probe.expect(UUID_TX in chars, f"缺 TX 特征 {UUID_TX}")
        probe.expect(UUID_STATE in chars, f"缺 State 特征 {UUID_STATE}")
        probe.ok(f"service + RX/TX/State 特征齐全：{chars}")

    print("\n=== State read（主同步路径，必须 8 字节）===")
    state = await probe.read_state()
    probe.expect(len(state) == 8, f"State read 长度 {len(state)} != 8")
    print(f"  {fmt_state(state)}")
    baseline = state

    print("\n=== ② 开关 + ACK seq ===")
    on = await probe.command(CMD_SET_POWER, b"\x01", label="SetPower(1)")
    if on:
        probe.expect(on["result"] == 0x00, f"SetPower(1) 结果 0x{on['result']:02X}")
        probe.expect(on["seq"] == probe.seq, f"ACK seq {on['seq']} 与请求 {probe.seq} 不一致")
        probe.ok(f"SetPower(1) seq=0x{on['seq']:02X} ACK cmd=0x{on['ack_cmd']:02X} result=OK")

    off = await probe.command(CMD_SET_POWER, b"\x00", label="SetPower(0)")
    if off:
        probe.expect(off["result"] == 0x00, f"SetPower(0) 结果 0x{off['result']:02X}")
        probe.ok(f"SetPower(0) seq=0x{off['seq']:02X} ACK result=OK")

    # 非法 power 必须 0x01（InvalidParam），且不改状态
    bad = await probe.command(CMD_SET_POWER, b"\x02", label="SetPower(2) 非法")
    if bad:
        probe.expect(bad["result"] == 0x01, f"SetPower(2) 应回 InvalidParam，实际 0x{bad['result']:02X}")
        probe.ok(f"SetPower(2) → 0x{bad['result']:02X} {RESULT.get(bad['result'])}（非法值被拒）")

    print("\n=== QueryState 与 State read 一致性 ===")
    q = await probe.query_state()
    if q:
        st_direct = await probe.read_state()
        probe.expect(
            q["state"] == st_direct,
            f"StateReport {q['state']} != State read {st_direct}",
        )
        probe.ok(f"StateReport 与 State read 逐字节一致：{fmt_state(q['state'])}")

    print("\n=== ③ 亮度 latest-wins（快速拖动不排队）===")
    # 模拟快速拖动：一次连续打 20 帧亮度，间隔 30ms，不做任何等待 ACK 的串行化。
    # 固件侧 latest-wins 邮箱只保留最新值；串口应看到 20 行 RX 但渲染次数远少于 20
    # （重复值被跳过）。这里只验证：不报错、最终值正确、无 Busy/超时。
    values = [40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 255, 240, 200, 160, 120, 90, 70, 50, 30]
    seqs = []
    for v in values:
        s, _ = await probe.send(CMD_SET_BRIGHTNESS, bytes([v]))
        seqs.append((s, v))
        await asyncio.sleep(0.03)
    await probe.waiter.drain(0.8)
    acked = {}
    for entry in probe.waiter.acks:
        acked[entry["frame"]["seq"]] = entry["ack"]
    missing = [s for s, _ in seqs if s not in acked]
    probe.expect(not missing, f"快速拖动有 {len(missing)} 帧没收到 ACK：{missing}")
    bad_results = [
        (s, acked[s]) for s, _ in seqs if s in acked and acked[s][1] != 0x00
    ]
    probe.expect(not bad_results, f"快速拖动出现非 OK ACK：{bad_results}")
    errs = [ln for _, ln in probe.tap.rx_lines() if "notify 失败" in ln or "失败" in ln]
    probe.expect(not errs, f"串口出现发送失败：{errs[:3]}")
    print(f"  发送 {len(values)} 帧亮度，最终值 {values[-1]}；收到 ACK {len(acked)} 条")

    q = await probe.query_state(label="QueryState(拖动后)")
    if q:
        probe.expect(
            q["state"][1] == values[-1],
            f"拖动结束后 brightness={q['state'][1]}，期望 {values[-1]}（latest 未生效）",
        )
        probe.ok(f"拖动结束后 brightness={q['state'][1]}，落在最后一个值")

    print("\n=== ④ 颜色 + 低亮度色相（固件侧可见量）===")
    # 固件不回报「灯带真实颜色」，只能证明协议状态里的 RGB 原样落地、
    # 且渲染日志按 GRB 顺序输出正确的三元组。灯带实际颜色要人眼看。
    await probe.command(CMD_SET_POWER, b"\x01", label="SetPower(1) 前置")
    for name, rgb in (("红", (255, 0, 0)), ("绿", (0, 255, 0)), ("蓝", (0, 0, 255))):
        res = await probe.command(CMD_SET_COLOR, bytes(rgb), label=f"SetColor({name})")
        if res:
            q = await probe.query_state(label=f"QueryState({name})")
            if q:
                got = q["state"][2:5]
                probe.expect(got == rgb, f"{name}: 存储 RGB {got} != 下发 {rgb}")
                probe.ok(f"{name}: 存储 RGB {got} 与下发一致")

    # 低亮度深红 / 深蓝：亮度只走 brightness 字段，不折进 RGB（协议 §7 / #10）
    await probe.command(CMD_SET_BRIGHTNESS, b"\x10", label="SetBrightness(16)")
    for name, rgb in (("深红", (128, 0, 0)), ("深蓝", (0, 0, 128))):
        await probe.command(CMD_SET_COLOR, bytes(rgb), label=f"SetColor({name})")
        q = await probe.query_state(label=f"QueryState({name})")
        if q:
            got = q["state"][2:5]
            bright = q["state"][1]
            probe.expect(
                got == rgb,
                f"{name}: 低亮度下 RGB {got} != {rgb}（颜色被亮度污染）",
            )
            probe.expect(bright == 16, f"{name}: brightness {bright} != 16")
            probe.ok(f"{name}: RGB {got} 未被亮度污染，brightness={bright}")

    return baseline


async def group_count(probe: Probe, baseline):
    print("\n=== ⑥ 灯珠数量边界 ===")
    # 当前数量
    state = await probe.read_state()
    current = state[5] | (state[6] << 8)
    print(f"  当前 led_count = {current}")

    print(f"  改到 10（数量减少，验证多余灯珠熄灭路径）")
    res = await probe.command(CMD_SET_LED_COUNT, bytes([10, 0]), timeout=6.0, label="SetLedCount(10)")
    if res:
        probe.expect(res["result"] == 0x00, f"SetLedCount(10) 结果 0x{res['result']:02X}")
        probe.ok(f"SetLedCount(10) ACK result={RESULT.get(res['result'])}")
    state = await probe.read_state()
    got = state[5] | (state[6] << 8)
    probe.expect(got == 10, f"设 10 后 State 读回 {got}")
    probe.ok(f"State 读回 led_count={got}")

    print("  改到 0（越界，应回 InvalidParam 且保留 10）")
    res = await probe.command(CMD_SET_LED_COUNT, bytes([0, 0]), label="SetLedCount(0)")
    if res:
        probe.expect(res["result"] == 0x01, f"SetLedCount(0) 应 InvalidParam，实际 0x{res['result']:02X}")
        probe.ok(f"SetLedCount(0) → {RESULT.get(res['result'])}")
    state = await probe.read_state()
    got = state[5] | (state[6] << 8)
    probe.expect(got == 10, f"非法值后数量被改成了 {got}，应保留 10")
    probe.ok(f"非法值后数量仍为 {got}")

    print("  改到 65（越界，应回 InvalidParam 且保留 10）")
    res = await probe.command(CMD_SET_LED_COUNT, bytes([65, 0]), label="SetLedCount(65)")
    if res:
        probe.expect(res["result"] == 0x01, f"SetLedCount(65) 应 InvalidParam，实际 0x{res['result']:02X}")
        probe.ok(f"SetLedCount(65) → {RESULT.get(res['result'])}")
    state = await probe.read_state()
    got = state[5] | (state[6] << 8)
    probe.expect(got == 10, f"非法值后数量被改成了 {got}，应保留 10")
    probe.ok(f"非法值后数量仍为 {got}")

    print("  改到 64（恢复实物数量）")
    res = await probe.command(CMD_SET_LED_COUNT, bytes([64, 0]), timeout=6.0, label="SetLedCount(64)")
    if res:
        probe.expect(res["result"] == 0x00, f"SetLedCount(64) 结果 0x{res['result']:02X}")
        probe.ok(f"SetLedCount(64) ACK result={RESULT.get(res['result'])}")
    state = await probe.read_state()
    got = state[5] | (state[6] << 8)
    probe.expect(got == 64, f"恢复 64 后 State 读回 {got}")
    probe.ok(f"State 读回 led_count={got}")


async def group_persist_set(probe: Probe):
    """写入一组可辨识状态，等 debounce 落盘，然后由外部复位验证。"""
    print("\n=== ⑥ 断电恢复（第一步：写入可辨识状态）===")
    target = (1, 80, 128, 0, 128)  # power=1 brightness=80 rgb=紫色
    res = await probe.command(
        CMD_SET_ALL, bytes([target[0], target[1], target[2], target[3], target[4]]),
        label="SetAll(power=1,bright=80,紫)",
    )
    if res:
        probe.expect(res["result"] == 0x00, f"SetAll 结果 0x{res['result']:02X}")
    q = await probe.query_state(label="QueryState(写入后)")
    if q:
        got = q["state"][:5]
        probe.expect(got == target, f"写入后 State {got} != {target}")
        probe.ok(f"写入后 State = {got}（power,brightness,R,G,B）")
    print("  等待 1.2s 让 500ms debounce 写进 NVS…")
    await asyncio.sleep(1.2)
    probe.notes.append("persist_target=" + ",".join(str(v) for v in target))


async def group_selftest(probe: Probe):
    print("\n=== ④/自检 顺序（固件侧：渲染日志按红→绿→蓝→白）===")
    started = len(probe.tap.lines)
    res = await probe.command(0x07, label="SelfTest")
    if res:
        probe.expect(res["result"] == 0x00, f"SelfTest 结果 0x{res['result']:02X}")
        probe.ok("SelfTest ACK OK")
    print("  等 2.4s 让四段序列跑完…")
    await asyncio.sleep(2.4)

    # 固件侧唯一能证明通道顺序的证据：渲染日志里的 rgb 三元组。
    lines = [ln for _, ln in probe.tap.lines[started:] if "自检" in ln or "render:" in ln]
    for ln in lines:
        print(f"    {ln}")
    steps = [ln for ln in lines if "自检" in ln and "rgb=" in ln]
    probe.expect(len(steps) >= 4, f"自检渲染日志只有 {len(steps)} 段，期望 4 段")
    expect_rgb = ["rgb=255,0,0", "rgb=0,255,0", "rgb=0,0,255"]
    for idx, want in enumerate(expect_rgb):
        if idx < len(steps):
            probe.expect(want in steps[idx], f"自检第 {idx + 1} 段不是 {want}：{steps[idx]}")
    if len(steps) >= 3:
        probe.ok(f"自检前三段依次为 R/G/B 纯色（共 {len(steps)} 段）")


# ---------------------------------------------------------------- 主流程


async def find_device(timeout=8.0):
    found = {}

    def cb(dev, adv):
        found[dev.address.upper()] = (dev, adv)

    async with BleakScanner(detection_callback=cb) as _sc:
        await asyncio.sleep(timeout)
    if ADDRESS.upper() in found:
        dev, adv = found[ADDRESS.upper()]
        return dev, adv.local_name
    for addr, (dev, adv) in found.items():
        if (adv.local_name or "").startswith("Lumen-"):
            return dev, adv.local_name
    return None, None


async def run(args):
    tap = SerialTap(args.serial_port, enabled=not args.no_serial)
    tap.start()
    probe = None
    baseline = None
    try:
        print(f"扫描 {NAME} …")
        dev, name = await find_device()
        if dev is None:
            print("[失败] 没扫到 Lumen 设备。设备没在广播通常是「已被别的中心连着」——")
            print("      先关掉手机上的小程序/微信，等它断开，再重试。")
            return 2
        print(f"发现 {name} @ {dev.address}")

        async with BleakClient(dev, timeout=15) as client:
            print(f"已连接，MTU={client.mtu_size}")
            probe = Probe(client, tap)
            await client.start_notify(UUID_TX, probe.waiter.on_notify)
            print("TX notify 已订阅")
            await asyncio.sleep(0.4)

            if args.group in ("basic", "all"):
                baseline = await group_basic(probe)

            if args.group in ("selftest", "all"):
                await group_selftest(probe)

            if args.group in ("persist", "all"):
                await group_persist_set(probe)

            if args.group in ("count", "all"):
                await group_count(probe, baseline)

            if args.group == "all" and not args.keep_state and baseline is not None:
                print("\n=== 恢复脚本开始时的状态 ===")
                power, bright, r, g, b, lo, hi, _ = baseline
                await probe.command(
                    CMD_SET_ALL,
                    bytes([power, bright, r, g, b]),
                    label="SetAll(恢复基线)",
                )
                await probe.command(CMD_SET_LED_COUNT, bytes([lo, hi & 0xFF]), timeout=6.0,
                                    label="SetLedCount(恢复基线)")
                probe.ok(f"已恢复到 {fmt_state(baseline)}")

            await client.stop_notify(UUID_TX)
            await asyncio.sleep(0.3)
    finally:
        tap.stop()

    print("\n" + "=" * 60)
    ack_count = len(probe.waiter.acks) if probe else 0
    print(f"BLE 侧：ACK {ack_count} 条，StateReport {len(probe.waiter.reports) if probe else 0} 条，"
          f"Event {len(probe.waiter.events) if probe else 0} 条")
    print(f"串口侧：RX 行 {len(tap.rx_lines())} 条，总行 {len(tap.lines)} 条")
    if probe and probe.waiter.events:
        for e in probe.waiter.events:
            print(f"  Event code=0x{e['event'][0]:02X} detail=0x{e['event'][1]:02X}")
    if probe and probe.notes:
        for n in probe.notes:
            print(f"  note: {n}")
    if probe and probe.failures:
        print(f"\n未通过 {len(probe.failures)} 项：")
        for f in probe.failures:
            print(f"  - {f}")
        return 1
    print("\n本次探针覆盖的检查全部通过。")
    print("注意：灯带真实颜色、断线回连 UI、隐藏面板仍需人眼/手机确认。")
    return 0


def main():
    ap = argparse.ArgumentParser(description="#14 真机验收探针（PC 当 central）")
    ap.add_argument("--group", default="all",
                    choices=["all", "basic", "selftest", "persist", "count"],
                    help="跑哪一组，默认全套")
    ap.add_argument("--serial-port", default="COM6")
    ap.add_argument("--no-serial", action="store_true", help="不抓串口")
    ap.add_argument("--keep-state", action="store_true", help="跑完不恢复初始状态")
    args = ap.parse_args()
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
