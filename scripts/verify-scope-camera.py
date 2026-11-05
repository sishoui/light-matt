#!/usr/bin/env python
"""方案作用域的**出光**验证（#122 验收第 4 条：逐帧比对）。

## 为什么需要配对对照

这台相机的采样框在空间上互相重叠：strip0 呼吸时，它溢出的光会让相邻带的
框均值跟着动 3~8（实测），而「逐条带的像素有没有变」只值 0.2。所以绝不能用
「与基线比」的单侧判据——那会把光溢出判成串扰（实测刷出 143 个假事件）。

本脚本改用**配对**：

  阶段 A（对照）：strip0 播呼吸，但内容是**实时分区**（协议里没有方案）
  阶段 B（被测）：strip0 播呼吸，内容是**只含 strip0 的方案**

两阶段的 strip0 亮度曲线尽量一致，因此对其它七条带的光学扰动也一致。
判据是 B 与 A 的**差**：非参与带在两阶段的均值应当无从区分。若固件把别的带
绑上了方案的时间轴，B 阶段它们会跟着方案停播 / 切步，差值就会撕开。

## 分工

  verify-scope.py         读 State 第 12 字节 + 固件串口日志（协议层，帧级）
  本脚本                  看真实灯带（物理层，逐帧，配对消除光溢出）

用法：
    python scripts/verify-scope-camera.py [--seconds 14]

前置：已跑 `scripts/calibrate-scope-boxes.py` 生成 `.scope-boxes.json`。
产物：`.scope-shots/scope.json`。
"""

import argparse
import asyncio
import importlib.util
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, ".scope-shots")

CAM_SCRIPT = r'''
import os, sys, time
import numpy as np
import cv2

d, w, h, expo = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
if not cap.isOpened():
    sys.exit("打不开相机")
cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
cap.set(cv2.CAP_PROP_EXPOSURE, expo)
cap.set(cv2.CAP_PROP_GAIN, 0)
time.sleep(1.5)
for _ in range(15):
    cap.read()
open(os.path.join(d, "ready"), "w").close()
req = os.path.join(d, "req")
stop = os.path.join(d, "stop")
while not os.path.exists(stop):
    if os.path.exists(req):
        for _ in range(3):
            cap.read()
        ok, f = cap.read()
        if ok:
            np.save(os.path.join(d, "frame.npy"), f)
        os.remove(req)
    time.sleep(0.005)
cap.release()
'''


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), os.path.join(HERE, name))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Cam:
    def __init__(self, exposure, w, h):
        self.dir = tempfile.mkdtemp(prefix="scope-cam-")
        script = os.path.join(self.dir, "cam.py")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(CAM_SCRIPT)
        self.proc = subprocess.Popen(
            [sys.executable, script, self.dir, str(w), str(h), str(exposure)], cwd=self.dir
        )
        ready = os.path.join(self.dir, "ready")
        deadline = time.time() + 40
        while not os.path.exists(ready):
            if time.time() > deadline:
                raise SystemExit("相机子进程没起来")
            time.sleep(0.05)

    def grab(self):
        import numpy as np

        with open(os.path.join(self.dir, "req"), "w", encoding="utf-8") as fh:
            fh.write("1")
        path = os.path.join(self.dir, "frame.npy")
        deadline = time.time() + 8
        while not os.path.exists(path):
            if time.time() > deadline:
                return None
            time.sleep(0.01)
        time.sleep(0.01)
        frame = np.load(path)
        os.remove(path)
        return frame

    def close(self):
        try:
            open(os.path.join(self.dir, "stop"), "w").close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def measure(frame, boxes):
    import cv2

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return [float(gray[y0:y1, x0:x1].mean()) for x0, y0, x1, y1 in boxes]


def measure_masked(frame, masks):
    """按**互斥**掩码取均值。

    必须用掩码而不是矩形框：这台相机的框互相重叠（s2 与 s0 重叠 56%），
    在重叠框上取均值会把 strip0 自己的呼吸算进 s2 的读数里。
    """
    import cv2

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(float)
    return [float(gray[m].mean()) if m.any() else 0.0 for m in masks]


def decode_masks(entries, w, h):
    import base64

    import numpy as np

    out = []
    for e in entries:
        packed = np.frombuffer(base64.b64decode(e), dtype=np.uint8)
        bits = np.unpackbits(packed)[: w * h]
        out.append(bits.reshape(h, w).astype(bool))
    return out


async def sample(cam, masks, seconds):
    t0 = time.time()
    series = []
    while time.time() - t0 < seconds:
        f = cam.grab()
        if f is not None:
            series.append(measure_masked(f, masks))
    return series


async def main():
    """同一份画面内容，唯一变量是「它是不是由方案驱动的」。

    ## 为什么是这个设计

    这台相机拍到的八条灯带在空间上靠得太近：实测把 strip0 从亮度 60 调到 0，
    其余七条的读数也各自掉了 7~39（纯光学串扰）。所以「给别的带设个亮度阈值」
    这条路物理上走不通——串扰比真实变化大一个数量级，配对对照也消不掉。

    改成**同内容对照**：让 strip0 在两个阶段渲染**完全相同的像素**（同 hue /
    同 sat / 同 level）——

      阶段 A：内容来自实时分区（协议里没有方案）
      阶段 B：内容来自只含 strip0 的方案（整份方案归 strip0 管）

    两阶段 strip0 的出光逐像素相同，因此它对其它带的串扰也相同。于是判据变得
    干净：**八条带的读数都必须无从区分**。如果固件把别的带绑上了方案，B 阶段
    它们会被方案接管（哪怕内容看着一样，渲染源换了、相位也换了），差值就会
    撕开；而在修好的固件上，非参与带的渲染源根本没变。

    这比「与基线比」强：基线会随气温 / 供电 / 曝光漂移，而同内容对照的两个
    阶段是紧邻着测的。
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--exposure", type=float, default=-7.0)
    parser.add_argument("--threshold", type=float, default=2.0,
                        help="两阶段均值差的允许上限（实测静止噪声 stdev 0.04~0.28）")
    args = parser.parse_args()

    with open(os.path.join(ROOT, ".scope-boxes.json"), encoding="utf-8") as fh:
        calib = json.load(fh)
    masks = decode_masks(calib["masks_rle"], calib["width"], calib["height"])
    n = len(masks)
    os.makedirs(OUT, exist_ok=True)

    vs = load("verify-scope.py")
    cam = Cam(args.exposure, calib["width"], calib["height"])
    hues = [0, 10922, 21845, 32768, 43690, 54613, 10000, 50000]
    # strip0 的内容在两阶段完全一致：同一 hue / sat / level。
    strip0_layer = vs.layer_bytes(0x00, hue=0, sat=255, level=60)

    async def stage(dev, use_script):
        """摆好静态底；strip0 的内容两阶段相同，只有来源不同。"""
        await dev.send(vs.CMD["SET_PLAYBACK"], bytes([0, 0]))
        await dev.send(vs.CMD["CLEAR_SCRIPT"], bytes([3]))
        await dev.send(vs.CMD["SET_POWER"], bytes([1]))
        await dev.send(vs.CMD["SET_BRIGHTNESS"], bytes([200]))
        for s in range(n):
            for seg in range(8):
                await dev.send(vs.CMD["CLEAR_SEGMENT"], bytes([s, seg]))
            await dev.send(
                vs.CMD["SET_SEGMENT"],
                vs.segment(
                    s, 0, 0, 29,
                    vs.layer_bytes(0x00, hue=hues[s % len(hues)], sat=255, level=60),
                ),
            )
        await asyncio.sleep(1.2)
        if use_script:
            await dev.send(vs.CMD["SCRIPT_BEGIN"], bytes([3, 1, n]))
            await dev.send(vs.CMD["SCRIPT_STAGE"], bytes([3, 0, 0xDC, 0x05, 0x00, 0x00]))
            await dev.send(
                vs.CMD["SCRIPT_SEGMENT"], bytes([3, 0]) + vs.segment(0, 0, 0, 29, strip0_layer)
            )
            code = await dev.send(vs.CMD["SCRIPT_COMMIT"], bytes([3]))
            if code != 0:
                raise SystemExit(f"方案提交失败 result={code}")
            await dev.send(vs.CMD["ACTIVATE_SCRIPT"], bytes([3, 1]))
            await dev.send(vs.CMD["SET_PLAYBACK"], bytes([1, 1]))
            # strip0 的实时分区与方案内容相同，所以两阶段看起来一模一样；
            # 差别只在「这一帧由谁渲染」。
        await asyncio.sleep(1.2)

    try:
        addr = await vs.find_device("")
        if addr is None:
            print("RESULT: no-device")
            return 2

        async with vs.BleakClient(addr, timeout=25) as client:
            dev = vs.Device(client)
            await client.start_notify(vs.TX, dev.on_notify)
            await asyncio.sleep(0.8)

            print("阶段 A：strip0 的内容来自实时分区（无方案）")
            await stage(dev, use_script=False)
            a = await sample(cam, masks, args.seconds)

            print("阶段 B：strip0 的内容来自只含 strip0 的方案")
            await stage(dev, use_script=True)
            b = await sample(cam, masks, args.seconds)

            await dev.send(vs.CMD["SET_PLAYBACK"], bytes([0, 0]))
            await dev.send(vs.CMD["CLEAR_SCRIPT"], bytes([3]))
            await dev.send(vs.CMD["SET_POWER"], bytes([0]))

        a_means = [statistics.mean(fr[i] for fr in a) for i in range(n)]
        b_means = [statistics.mean(fr[i] for fr in b) for i in range(n)]
        rows = [
            {
                "strip": i,
                "static": round(a_means[i], 2),
                "script": round(b_means[i], 2),
                "delta": round(abs(b_means[i] - a_means[i]), 2),
            }
            for i in range(n)
        ]
        violations = [r for r in rows if r["delta"] > args.threshold]

        summary = {
            "frames_a": len(a),
            "frames_b": len(b),
            "fps": round((len(a) + len(b)) / (2 * args.seconds), 2),
            "threshold": args.threshold,
            "design": "same content, only the render source differs",
            "strips": rows,
            "violations": violations,
        }
        with open(os.path.join(OUT, "scope.json"), "w", encoding="utf-8") as fh:
            json.dump(summary, fh, ensure_ascii=False, indent=2)

        print()
        print(
            f"同内容对照：A {len(a)} 帧 / B {len(b)} 帧 @ {summary['fps']}fps，"
            f"阈值 {args.threshold}"
        )
        print("  strip  实时分区  方案驱动   差")
        for r in rows:
            flag = "  <== 超阈值" if r["delta"] > args.threshold else ""
            print(f"  s{r['strip']}    {r['static']:7.2f}  {r['script']:7.2f}  {r['delta']:5.2f}{flag}")

        ok = not violations
        print()
        print(
            f"{'PASS' if ok else 'FAIL'}  "
            + (
                "八条带在「内容相同、来源不同」下无从区分：方案没有碰非参与带"
                if ok
                else f"{len(violations)} 条带读数被方案改变了"
            )
        )
        return 0 if ok else 1
    finally:
        cam.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
