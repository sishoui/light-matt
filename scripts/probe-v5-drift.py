#!/usr/bin/env python
"""#162 相位漂移真机测量：布置场景 → 跑 N 分钟 → 抓串口 → 交给分析脚本。

## 为什么单独一个脚本

`probe-v5-acceptance.py --drift-minutes` 验的是「长时间挂着不崩、不掉线」，**不是**
相位偏差（协议没有读播放头的命令）。真数字要靠固件的 `CONFIG_LUMEN_PLAYHEAD_LOG`
（默认关闭的调试构建）打 `ph:` 行，再由
`scripts/analyze-playhead-log.py` 算闭式解残差。

这个脚本负责中间那段：把设备布置成「两个不同节奏的部位」、在**采集期间不碰
BLE**（避免链路问题污染）、跑完把日志交给分析器。

## 布置的场景

同一条链的两个部位，周期**互质**：

| 部位 | 步数 | 每步 | 总周期 |
|---|---|---|---|
| part 0 | 7 | 100ms | 700ms |
| part 1 | 3 | 300ms | 900ms |

互质很重要：采样周期 10 秒，若周期能整除采样间隔（如 1000ms），每次采样都会
落在循环的同一相位，`elapsed` 永远是同一个值——那样既看不出漂移，也验不到
「各走各的」。700 与 900 的最小公倍数是 6300ms，10 秒采样下相位会走遍整个循环。

## 判据

`analyze-playhead-log.py` 的闭式解残差：把日志里的 `(step, elapsed)` 反算成
绝对经过时间，与 `(t - origin) mod total` 比。残差 > 2ms 即判漂移。
**「步号一直在变」不算通过**——那只能证明在动。

用法：

    # 1) 先烧调试固件（CONFIG_LUMEN_PLAYHEAD_LOG=y）
    # 2) 布置 + 采集
    python scripts/probe-v5-drift.py --minutes 30 --port COM6
    # 3) 分析（脚本会自动调；也可单独跑）
    python scripts/analyze-playhead-log.py docs/evidence/playhead-30min.log --minutes 30

退出码：0 = 通过；1 = 有漂移或数据不足；2 = 连不上 / 串口打不开。
"""

import argparse
import asyncio
import importlib.util
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def load_probe_module():
    """把 probe-v5-acceptance.py 当模块加载（文件名带连字符，不能直接 import）。"""
    path = os.path.join(HERE, "probe-v5-acceptance.py")
    spec = importlib.util.spec_from_file_location("probe_v5_acceptance", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load_probe_module()

# 两个部位的步表（互质：700ms vs 900ms）。
PART0_STEPS = [100] * 7
PART1_STEPS = [300] * 3


async def setup_scene(probe):
    """布置：一条链两个部位，各有自己的时间轴；激活场景让两个播放头同时起跳。"""
    print("布置场景：strip0 两个部位（7×100ms / 3×300ms）……")

    # 布局：一条链两个部位，各占一半灯珠。
    result, _ = await probe.send("LAYOUT_WRITE", bytes([0, 2]))
    if result != P.OK:
        return f"LAYOUT_WRITE 失败：{P._hex(result)}"
    # part 0：灯珠 0-14；part 1：灯珠 15-29（strip0 = 30 颗）。
    result, _ = await probe.send("LAYOUT_PART", bytes([0, 0, 0]) + b"\x00" * 24 + bytes([1, 0]))
    if result != P.OK:
        return f"LayoutPart(0) 失败：{P._hex(result)}"
    result, _ = await probe.send("LAYOUT_SEG", bytes([0, 0, 0, 0, 14]))
    if result != P.OK:
        return f"LayoutSeg(part0) 失败：{P._hex(result)}"
    result, _ = await probe.send("LAYOUT_PART", bytes([0, 1, 0]) + b"\x00" * 24 + bytes([1, 0]))
    if result != P.OK:
        return f"LayoutPart(1) 失败：{P._hex(result)}"
    result, _ = await probe.send("LAYOUT_SEG", bytes([0, 1, 0, 15, 29]))
    if result != P.OK:
        return f"LayoutSeg(part1) 失败：{P._hex(result)}"
    result, _ = await probe.send("LAYOUT_COMMIT")
    if result != P.OK:
        return f"LayoutCommit 失败：{P._hex(result)}"

    # 部位 0：7 步 × 100ms，全部循环。
    result, _ = await probe.send("SCENE_PART", bytes([0, 0, 0, len(PART0_STEPS), 1, 1]))
    if result != P.OK:
        return f"ScenePart(0) 失败：{P._hex(result)}"
    for index, duration in enumerate(PART0_STEPS):
        payload = bytes([0, 0, 0, index]) + struct.pack("<H", duration)
        # 每步不同色相：肉眼能看出在换步，也让「画面没动」与「时钟没动」分得开。
        payload += P.static_layer(index * 9000, 255, 100) + P.empty_layer()
        result, _ = await probe.send("SCENE_STEP", payload)
        if result != P.OK:
            return f"SceneStep(part0 step{index}) 失败：{P._hex(result)}"

    # 部位 1：3 步 × 300ms，全部循环。
    result, _ = await probe.send("SCENE_PART", bytes([0, 0, 1, len(PART1_STEPS), 1, 1]))
    if result != P.OK:
        return f"ScenePart(1) 失败：{P._hex(result)}"
    for index, duration in enumerate(PART1_STEPS):
        payload = bytes([0, 0, 1, index]) + struct.pack("<H", duration)
        payload += P.static_layer(30000 + index * 9000, 255, 100) + P.empty_layer()
        result, _ = await probe.send("SCENE_STEP", payload)
        if result != P.OK:
            return f"SceneStep(part1 step{index}) 失败：{P._hex(result)}"

    # 激活：两个部位从同一时刻起跳（T3/C4）。
    result, _ = await probe.send("ACTIVATE_SCENE", bytes([0]))
    if result != P.OK:
        return f"ActivateScene 失败：{P._hex(result)}"
    print(f"  布局 2 部位 / 场景 7+3 步 / 已激活（周期 {sum(PART0_STEPS)}ms vs {sum(PART1_STEPS)}ms）")

    # 等落盘。
    #
    # `SceneStep` 是**2 秒防抖落盘**（§10.4），布置完立刻断开连接会让防抖
    # 窗口没走完就复位——场景内容留在 RAM，NVS 里还是旧的。第一版就是
    # 这么丢掉场景的：重启后场景 0 恢复成出厂那 1 步，而布局（LayoutCommit
    # 是立即落盘）还在，所以 `parts=2` 但时间轴是错的。
    #
    # 3 秒 = 2 秒防抖 + 1 秒余量。等完再读一次确认步数。
    print("  等 3 秒让场景落盘（SceneStep 是 2 秒防抖）……")
    await asyncio.sleep(3.0)

    # 复核：读回当前场景，确认 7+3 步真的在设备上。
    result, parts, steps, ends = await probe.query_scene(0, wait=5.0)
    if result != P.OK:
        return f"QueryScene 复核失败：{P._hex(result)}"
    part0_steps = sum(1 for s in steps if s[1] == 0 and s[2] == 0)
    part1_steps = sum(1 for s in steps if s[1] == 0 and s[2] == 1)
    if part0_steps != len(PART0_STEPS) or part1_steps != len(PART1_STEPS):
        return (
            f"场景复核不符：读回 part0={part0_steps} 步 / part1={part1_steps} 步，"
            f"期望 {len(PART0_STEPS)} / {len(PART1_STEPS)}"
        )
    print(f"  复核通过：读回 part0={part0_steps} 步 / part1={part1_steps} 步")
    return None


def open_serial(port, retries=10, delay=2.0):
    """打开串口，带重试。

    为什么要重试：刚断开 BLE 后立刻开串口，Windows 上常报
    `OSError(22) ... 已中止 I/O 操作`——那是上一个句柄还没完全释放。
    等两秒再来一次就好，不值得让 30 分钟的采集因此失败。
    """
    import serial  # 延迟导入：不采集时不需要 pyserial

    last = None
    for attempt in range(1, retries + 1):
        try:
            return serial.Serial(port, 115200, timeout=0.5)
        except Exception as exc:  # noqa: BLE001 - 端口错误类型因平台而异
            last = exc
            print(f"  串口打开失败 ({attempt}/{retries})：{str(exc).splitlines()[0]}")
            if attempt < retries:
                time.sleep(delay)
    raise last


async def capture(port, seconds, out_path):
    """抓串口到文件。**采集期间不碰 BLE**——链路问题会污染判据。

    两个坑（第一版都踩了）：

    1. **缓冲写盘**：只在每分钟的心跳里 `flush()`，中途进程卡住时日志看起来
       停在某个点，实际数据还在内存里。现在每写完一行就落盘（30 分钟约 400 行，
       开销可忽略）。
    2. **「进程活着但没数据」不等于设备停了**：第一版看到日志 60 行不动就以为
       设备挂了，其实是我自己的进程卡在串口读上。现在加心跳检测——连续
       `STALL_LIMIT_S` 秒一行都没读到就报错退出，并说清是「串口没数据」而不是
       「设备崩了」。
    """
    STALL_LIMIT_S = 120
    print(f"采集串口 {port}，{seconds:.0f} 秒 → {out_path}")
    deadline = time.time() + seconds
    total_bytes = 0
    lines = 0
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        ser = open_serial(port)
        try:
            buf = b""
            next_report = time.time() + 60
            last_data = time.time()
            while time.time() < deadline:
                chunk = ser.read(4096)
                now = time.time()
                if not chunk:
                    if now - last_data > STALL_LIMIT_S:
                        print(
                            f"FAIL  连续 {STALL_LIMIT_S}s 没读到任何串口数据"
                            f"（设备没在跑？CONFIG_LUMEN_PLAYHEAD_LOG 没打开？）"
                        )
                        break
                    continue
                last_data = now
                total_bytes += len(chunk)
                buf += chunk
                # 按行切，保留残行
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    text = raw.decode("utf-8", errors="replace").rstrip()
                    if text:
                        fh.write(text + "\n")
                        fh.flush()  # 每行落盘：进程被杀也不丢已有数据
                        lines += 1
                if now >= next_report:
                    next_report += 60
                    remaining = deadline - now
                    print(f"  … {total_bytes} 字节 / {lines} 行 / 剩余 {remaining:.0f}s")
            if buf:
                fh.write(buf.decode("utf-8", errors="replace") + "\n")
                fh.flush()
        finally:
            ser.close()
    print(f"  采集完成：{total_bytes} 字节 / {lines} 行")
    return lines


async def main():
    ap = argparse.ArgumentParser(description="#162 相位漂移真机测量")
    ap.add_argument("--minutes", type=float, default=30.0, help="观察窗口（分钟）")
    ap.add_argument("--port", default="COM6", help="串口")
    ap.add_argument("--name", default="Lumen-5662", help="广播名")
    ap.add_argument("--out", default=None, help="日志落点（默认 docs/evidence/playhead-<n>min.log）")
    ap.add_argument("--skip-setup", action="store_true", help="不重布置（设备已是目标场景）")
    ap.add_argument("--analyze-only", default=None, help="只分析已有日志，不连设备")
    args = ap.parse_args()

    if args.analyze_only:
        return analyze(args.analyze_only, args.minutes)

    out_path = args.out or os.path.join(
        os.path.dirname(HERE), "docs", "evidence", f"playhead-{int(args.minutes)}min.log"
    )

    if not args.skip_setup:
        print(f"连接 {args.name} ……")
        try:
            client, probe = await P.connect(args.name)
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL  连不上设备：{exc}")
            return 2
        try:
            error = await setup_scene(probe)
            if error is not None:
                print(f"FAIL  {error}")
                return 1
        finally:
            # 断开：采集期间不持有 BLE 连接（避免 PC 侧链路问题干扰）
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(1.0)
    else:
        print("跳过布置（--skip-setup）")

    seconds = args.minutes * 60
    try:
        lines = await capture(args.port, seconds, out_path)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL  串口采集失败：{exc}")
        return 2

    if lines < 10:
        print("FAIL  日志太少（设备没在跑？检查 CONFIG_LUMEN_PLAYHEAD_LOG 是否打开）")
        return 1

    return analyze(out_path, args.minutes)


def analyze(path, minutes):
    print(f"\n分析 {path} ……")
    spec = importlib.util.spec_from_file_location(
        "analyze_playhead_log", os.path.join(HERE, "analyze-playhead-log.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    report = module.analyse(text)
    return module.print_report(report, minutes)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
