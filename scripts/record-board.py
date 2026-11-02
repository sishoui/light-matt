#!/usr/bin/env python
"""错色实验的录像器：锁定曝光的恒定画面录制，元数据写实测帧率与每帧时间戳。

为什么要单独一个录制器（而不是 OBS / 相机应用）：判定靠逐帧比对，
需要**精确可控的曝光**和**可信的时间轴**，否则分析工具会把曝光漂移误判成
错色、把时间戳对不上当成真事件。

关键事实（实测，见 docs/handoff-colour-error-test.md）：
- **必须用 DirectShow（CAP_DSHOW）**。MSMF 下 EXPOSURE/GAIN 的 set 返回 True
  但读回恒为 -5/0 —— 自动曝光一直开着，帧间亮度差能到 4 档。
- **不要设 MJPG**。DSHOW+MJPG 会完全忽略曝光设置（所有档位画面一模一样）。
  不设 FOURCC 时走 YUY2，曝光生效。
- **容器帧率必须用实测值**。旧版按请求值 3fps 写容器，而这台相机 1080p
  实测只有 2.51fps，结果所有时间戳快了 20%，与串口日志按 t= 对齐会系统性
  错位，折算出的「次/10 分钟」也偏大 20%。现在先测 1.5s 再开写，并把每帧
  的真实时刻写进 .json。
- opencv 和 bleak 不能同进程，所以 BLE 压力由 ble-stress.py 另起进程，
  本脚本只负责录。

分辨率与帧率的取舍（实测这台相机）：

    | 分辨率     | 实测 fps |
    |-----------|---------|
    | 1920×1080 | 2.5     |
    | 1280×720  | 10      |
    | 960×540   | 15      |
    | 640×480   | 30      |

固件跑 20fps，所以 1080p 只抽样到 12.5% 的帧。**帧率比分辨率值钱得多**：
640×480 下灯带仍能分开，建议优先用低分辨率高帧率，除非画面里灯珠太小。

用法（仓库根目录）：

    # 基线：什么都不写
    python scripts/record-board.py baseline.mp4 --seconds 400 --width 640 --height 480

    # 压力段：同时另开一个终端跑 flood
    python scripts/record-board.py stress.mp4 --seconds 400 --width 640 --height 480
    # 另一个终端：python scripts/ble-stress.py flood --seconds 400 --hz 20

    # 录完分析（需要先跑 strip-layout.py 标定）
    python scripts/analyze-strips-video.py stress.mp4
"""

import argparse
import json
import os
import sys
import time

import numpy as np

try:
    import cv2
except ImportError:
    sys.exit("需要 opencv-python：python -m pip install opencv-python")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib.util import module_from_spec, spec_from_file_location

_spec = spec_from_file_location("led_probe", os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "led-probe.py"))
led_probe = module_from_spec(_spec)
_spec.loader.exec_module(led_probe)

BACKEND = cv2.CAP_DSHOW
EXPOSURE = -8
GAIN = 0
WARMUP_S = 1.5
GRAB_FRAMES = 30

FRAME_W = 1920
FRAME_H = 1080

# 1080p YUY2 实测只有 2.5fps（USB 带宽）。这个帧率是刻意接受的取舍：
# MJPG 能到 30fps，但会强制自动曝光且改不动 —— 自动曝光以 ~0.3s 周期振荡，
# 逐帧比对会把它误判成错色。
# **但代价很大**：固件 20fps、相机 2.5fps 等于每 400ms 只取一瞬，
# 抽样率仅 12.5%。实测降到 640×480 能到 30fps，且灯带仍分得开，
# 所以默认改成 640×480，重分辨率请显式给 --width/--height。
RECORD_FPS = 3.0
DEFAULT_SECONDS = 180


def open_camera(exposure=EXPOSURE, gain=GAIN, width=FRAME_W, height=FRAME_H):
    cap = cv2.VideoCapture(0, BACKEND)
    if not cap.isOpened():
        raise SystemExit("打不开相机 0")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    # 刻意**不设** FOURCC：DSHOW+MJPG 会忽略曝光设置并强制自动曝光
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
    cap.set(cv2.CAP_PROP_EXPOSURE, exposure)
    cap.set(cv2.CAP_PROP_GAIN, gain)
    time.sleep(WARMUP_S)
    for _ in range(GRAB_FRAMES):
        cap.grab()
    return cap


def probe_exposure(cap):
    """确认曝光真的锁住了：读回值必须接近请求值，否则自动曝光还开着。"""
    ae = cap.get(cv2.CAP_PROP_AUTO_EXPOSURE)
    exp = cap.get(cv2.CAP_PROP_EXPOSURE)
    gain = cap.get(cv2.CAP_PROP_GAIN)
    return {"auto_exposure": ae, "exposure": exp, "gain": gain}


def record(path, seconds, exposure, gain, width=FRAME_W, height=FRAME_H,
           fps_hint=RECORD_FPS):
    cap = open_camera(exposure, gain, width, height)
    info = probe_exposure(cap)
    if info["auto_exposure"] != -1.0 or info["exposure"] != exposure:
        print(f"  ⚠ 曝光没锁住：请求 {exposure}/{gain}，读回 "
              f"{info['exposure']}/{info['gain']} (AE={info['auto_exposure']})")
        print("    自动曝光若仍开着，帧间亮度漂移会被误判成错色。")
    else:
        print(f"  曝光已锁定：{info['exposure']:.0f}/{info['gain']:.0f}")

    ok, frame = cap.read()
    if not ok:
        raise SystemExit("取帧失败")
    h, w = frame.shape[:2]
    # 容器 fps 用**实测值**，不用请求值。旧版把 2.51fps 的素材写成 3fps 容器，
    # 结果所有时间戳快 20%，跟串口日志按 t= 对齐会系统性错位，
    # 折算出的「次/10 分钟」也偏大 20%。
    measured = measure_fps(cap, seconds=1.5)
    container_fps = measured if measured > 0.5 else fps_hint
    writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"),
                             container_fps, (w, h))
    if not writer.isOpened():
        raise SystemExit(f"打不开输出文件 {path}")

    need = int(round(seconds * container_fps))
    written = 0
    stamps = []
    t0 = time.monotonic()
    last_report = t0
    print(f"录制 {seconds:.0f}s @ 实测 {container_fps:.2f}fps → {path}"
          f"（{w}×{h}）")
    print("  期间不要碰灯带 / 相机 / 环境光（判定靠画面恒定）")
    while written < need:
        ok, frame = cap.read()
        if not ok:
            break
        writer.write(frame)
        stamps.append(round(time.monotonic() - t0, 4))
        written += 1
        now = time.monotonic()
        if now - last_report >= 10.0:
            elapsed = now - t0
            print(f"  {elapsed:5.1f}s  {written} 帧  ({written / elapsed:.1f} fps)")
            last_report = now
    writer.release()
    cap.release()
    elapsed = time.monotonic() - t0
    meta = {
        "video": os.path.basename(path),
        "requested_seconds": seconds,
        "frames": written,
        "elapsed_s": round(elapsed, 2),
        "actual_fps": round(written / elapsed, 2) if elapsed > 0 else 0,
        "container_fps": round(container_fps, 3),
        "size": [w, h],
        "camera": {"backend": "DSHOW", "exposure": info["exposure"],
                   "gain": info["gain"], "auto_exposure": info["auto_exposure"]},
        "frame_times_s": stamps,
    }
    base = os.path.splitext(path)[0]
    with open(base + ".json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    print(f"完成：{written} 帧 / {elapsed:.1f}s = {written / elapsed:.1f} fps")
    print(f"元数据（含每帧真实时间戳）写入 {base}.json")


def measure_fps(cap, seconds=1.5):
    """实测相机帧率。相机声明的 fps 经常和实际不符（1080p 声称 30、实测 2.5）。"""
    n = 0
    t0 = time.monotonic()
    while time.monotonic() - t0 < seconds:
        ok, _ = cap.read()
        if not ok:
            break
        n += 1
    dt = time.monotonic() - t0
    return n / dt if dt > 0 else 0.0


def main():
    ap = argparse.ArgumentParser(description="错色实验录像（曝光锁定 + 实测帧率容器）")
    ap.add_argument("path", help="输出 mp4 路径")
    ap.add_argument("--seconds", type=float, default=DEFAULT_SECONDS)
    ap.add_argument("--exposure", type=float, default=EXPOSURE)
    ap.add_argument("--gain", type=float, default=GAIN)
    ap.add_argument("--width", type=int, default=FRAME_W)
    ap.add_argument("--height", type=int, default=FRAME_H)
    ap.add_argument("--fps", type=float, default=RECORD_FPS,
                    help="相机不动时的容器帧率兜底值（正常会用实测值）")
    args = ap.parse_args()
    record(args.path, args.seconds, args.exposure, args.gain,
           args.width, args.height, args.fps)


if __name__ == "__main__":
    main()
