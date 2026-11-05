#!/usr/bin/env python
"""为 verify-scope-camera.py 标定逐带采样框。

逐条点亮（其余全灭），从画面上找那一条的亮区，产出 `.scope-boxes.json`。

**相机跑在子进程里**：opencv 与 bleak 在同一个进程里会撞 WinRT MTA
（`Thread is configured for Windows GUI but callbacks are not working`），
所以本脚本（bleak 侧）spawn `cam_worker.py`（cv2 侧），两者通过命名管道
文件握手，见 `_cam_capture`。

用法：
    python scripts/calibrate-scope-boxes.py [--address CC:8D:A2:C2:56:62]

会改动设备状态（逐条点亮），跑完恢复成全灭。
"""

import argparse
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, ".scope-boxes.json")
W, H = 1920, 1080


def load_probe():
    spec = importlib.util.spec_from_file_location("vs", os.path.join(HERE, "verify-scope.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class CamWorker:
    """cv2 子进程的句柄：让它取一张图，返回 numpy 数组。"""

    def __init__(self, exposure):
        self.dir = tempfile.mkdtemp(prefix="scope-cam-")
        self.script = os.path.join(self.dir, "cam.py")
        with open(self.script, "w", encoding="utf-8") as fh:
            fh.write(CAM_SCRIPT)
        self.proc = subprocess.Popen(
            [sys.executable, self.script, self.dir, str(W), str(H), str(exposure)],
            cwd=self.dir,
        )
        ready = os.path.join(self.dir, "ready")
        deadline = time.time() + 40
        while not os.path.exists(ready):
            if time.time() > deadline:
                raise SystemExit("相机子进程没起来")
            time.sleep(0.05)
        print("相机子进程就绪")

    def grab(self):
        req = os.path.join(self.dir, "req")
        with open(req, "w", encoding="utf-8") as fh:
            fh.write(str(time.time()))
        path = os.path.join(self.dir, "frame.npy")
        deadline = time.time() + 10
        while not os.path.exists(path):
            if time.time() > deadline:
                return None
            time.sleep(0.02)
        time.sleep(0.02)
        import numpy as np

        frame = np.load(path)
        os.remove(path)
        return frame

    def close(self):
        try:
            open(os.path.join(self.dir, "stop"), "w").close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


# 子进程：只依赖 cv2 + numpy，不含 bleak。
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
        for _ in range(5):
            cap.read()
        ok, f = cap.read()
        if ok:
            np.save(os.path.join(d, "frame.npy"), f)
        os.remove(req)
    time.sleep(0.01)
cap.release()
'''


def analyse(frame, dark):
    """从「只亮这一条」的帧里取出该条的亮区框。"""
    import cv2

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    diff = cv2.absdiff(gray, dark) if dark is not None else gray
    _, mask = cv2.threshold(diff, 40, 255, cv2.THRESH_BINARY)
    ys, xs = mask.nonzero()
    if len(xs) < 15:
        return None, len(xs)
    x0, x1 = int(xs.min()) + 2, int(xs.max()) - 2
    y0, y1 = int(ys.min()) + 2, int(ys.max()) - 2
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None, len(xs)
    return [x0, y0, x1, y1], len(xs)


def separate_masks(raw_boxes, shape):
    """把互相重叠的框拆成**互斥**的掩码（每个像素归最近的那条带）。

    为什么必须互斥：这台相机的框重叠很严重（实测 s2 与 s0 重叠 56%、s4 与 s0
    重叠 62%）。在重叠框上取均值，strip0 自己的呼吸会把 s2/s4 的读数一起带跑，
    于是「别的带有没有被改动」永远判不出来——配对对照也救不了，因为污染来自
    被测对象本身。
    """
    import numpy as np

    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    best = np.full((h, w), -1, dtype=np.int16)
    best_d = np.full((h, w), np.inf, dtype=np.float64)
    for i, (x0, y0, x1, y1) in enumerate(raw_boxes):
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        inside = (xx >= x0) & (xx <= x1) & (yy >= y0) & (yy <= y1)
        d = (xx - cx) ** 2 + (yy - cy) ** 2
        take = inside & (d < best_d)
        best[take] = i
        best_d[take] = d[take]
    return [(best == i) for i in range(len(raw_boxes))]


def encode_masks(raw_boxes):
    """互斥掩码 → base64。每条带一个 uint8 掩码，行优先压位。"""
    import base64

    import numpy as np

    masks = separate_masks(raw_boxes, (H, W))
    out = []
    for m in masks:
        packed = np.packbits(m.astype(np.uint8))
        out.append(base64.b64encode(packed.tobytes()).decode("ascii"))
    return out


def decode_masks(entries, w, h):
    """base64 → 布尔掩码列表（供相机验证脚本用）。"""
    import base64

    import numpy as np

    nbytes = (w * h + 7) // 8
    out = []
    for e in entries:
        packed = np.frombuffer(base64.b64decode(e), dtype=np.uint8)
        bits = np.unpackbits(packed)[: w * h]
        out.append(bits.reshape(h, w).astype(bool))
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--address", default="")
    parser.add_argument("--exposure", type=float, default=-7.0)
    args = parser.parse_args()

    vs = load_probe()
    cam = CamWorker(args.exposure)

    async def run():
        addr = await vs.find_device(args.address)
        if addr is None:
            sys.exit("没找到设备")
        boxes = {}
        async with vs.BleakClient(addr, timeout=25) as client:
            dev = vs.Device(client)
            await client.start_notify(vs.TX, dev.on_notify)
            await asyncio.sleep(0.8)
            st = await dev.state()
            strip_count = st["strip_count"]
            led_counts = st["strip_counts"][:strip_count]
            print(f"strips={strip_count} leds={led_counts}")

            await dev.send(vs.CMD["SET_POWER"], bytes([0]))
            await asyncio.sleep(1.2)
            dark_frame = cam.grab()
            import cv2

            dark = cv2.cvtColor(dark_frame, cv2.COLOR_BGR2GRAY) if dark_frame is not None else None
            print(f"背景帧（总闸关）mean={float(dark_frame.mean()):.2f}" if dark_frame is not None else "背景帧失败")

            # 上电后每条带各自全亮一段，逐条找框。
            #
            # **其余带必须先显式写一段「熄灭」**：没有活动段的带会走 v1 兼容
            # 路径整条铺满全局 RGB——那正是 #122 要修的「亮起再熄灭」，
            # 标定时会把 8 条带拍成同一片光晕（实测 8 个框完全相同）。
            await dev.send(vs.CMD["SET_POWER"], bytes([1]))
            await dev.send(vs.CMD["SET_BRIGHTNESS"], bytes([200]))
            for s in range(strip_count):
                await dev.send(
                    vs.CMD["SET_SEGMENT"],
                    vs.segment(s, 0, 0, max(0, led_counts[s] - 1), vs.layer_bytes(0x06, hue=0, sat=0)),
                )
            await asyncio.sleep(0.8)

            for s in range(strip_count):
                await dev.send(
                    vs.CMD["SET_SEGMENT"],
                    vs.segment(
                        s, 0, 0, max(0, led_counts[s] - 1), vs.layer_bytes(0x00, hue=0, sat=0)
                    ),
                )
                await asyncio.sleep(0.8)
                frame = cam.grab()
                if frame is None:
                    print(f"  strip{s}: 取帧失败")
                else:
                    box, npx = analyse(frame, dark)
                    if box is None:
                        print(f"  strip{s}: 亮点不够（{npx}），跳过")
                    else:
                        boxes[s] = box
                        print(
                            f"  strip{s}: 框 {box} "
                            f"({box[2]-box[0]}x{box[3]-box[1]}px, {npx} 亮点)"
                        )
                # 拍完换回熄灭：下一条才只亮自己。
                await dev.send(
                    vs.CMD["SET_SEGMENT"],
                    vs.segment(s, 0, 0, max(0, led_counts[s] - 1), vs.layer_bytes(0x06, hue=0, sat=0)),
                )
                await asyncio.sleep(0.3)

            # 留一条亮着（strip0），方便紧接着的相机验证确认相机没掉线。
            await dev.send(
                vs.CMD["SET_SEGMENT"],
                vs.segment(0, 0, 0, max(0, led_counts[0] - 1), vs.layer_bytes(0x00, hue=0, sat=0)),
            )
        return boxes

    try:
        boxes = asyncio.run(run())
    finally:
        cam.close()

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "width": W,
                "height": H,
                "boxes": [boxes[k] for k in sorted(boxes)],
                # 互斥掩码按 np.packbits 压成一维再 base64：JSON 里直接放 1080×1920
                # 的布尔矩阵会撑到几十 MB。
                "masks_rle": encode_masks([boxes[k] for k in sorted(boxes)]),
            },
            fh,
            ensure_ascii=False,
            indent=2,
        )
    print(f"\n写出 {OUT}：{len(boxes)} 条带")
    if len(boxes) < 2:
        print("警告：少于 2 条带标定成功，逐帧比对没有意义")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
