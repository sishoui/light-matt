#!/usr/bin/env python
"""#20 实验：录制「画面恒定 + 可选 BLE 压力」的灯板录像。

为什么要单独一个录制器（而不是用 OBS / 相机应用）：判定靠逐帧比对，
需要**精确可控的曝光**和**统一的帧率**，否则分析工具会把曝光漂移误判成
错色。这里把相机参数、帧率、时长都钉死，并把实际参数写进旁边的 .json，
分析时可以直接确认。

关键事实（本轮实测，见 docs/handoff-colour-error-test.md）：
- **必须用 DirectShow（CAP_DSHOW）**。MSMF 下 EXPOSURE/GAIN 的 set 返回 True
  但读回恒为 -5/0 —— 自动曝光一直开着，帧间亮度差能到 4 档。
- **不要设 MJPG**。DSHOW+MJPG 会完全忽略曝光设置（所有档位画面一模一样）。
  不设 FOURCC 时走 YUY2，曝光生效。
- opencv 和 bleak 不能同进程，所以 BLE 压力由 ble-stress.py 另起进程，
  本脚本只负责录。

用法（仓库根目录）：

    # 基线：什么都不写
    python scripts/record-board.py baseline.mp4 --seconds 180

    # 压力段：同时另开一个终端跑 flood
    python scripts/record-board.py stress.mp4 --seconds 180
    # 另一个终端：python scripts/ble-stress.py flood --seconds 180 --hz 20

    # 录完分析
    python scripts/analyze-board-video.py baseline.mp4
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

# 1080p YUY2 实测只有 ~3fps（USB 带宽）。这是刻意接受的取舍：MJPG 能到
# 30fps，但会强制自动曝光且改不动 —— 自动曝光以 ~0.3s 周期振荡，
# 逐帧比对会把它误判成错色。宁可帧率低，也要曝光稳。
RECORD_FPS = 3.0
DEFAULT_SECONDS = 180


def open_camera(exposure=EXPOSURE, gain=GAIN):
    cap = cv2.VideoCapture(0, BACKEND)
    if not cap.isOpened():
        raise SystemExit("打不开相机 0")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
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


def record(path, seconds, exposure, gain):
    cap = open_camera(exposure, gain)
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
    writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"),
                             RECORD_FPS, (w, h))
    if not writer.isOpened():
        raise SystemExit(f"打不开输出文件 {path}")

    need = int(round(seconds * RECORD_FPS))
    written = 0
    t0 = time.monotonic()
    last_report = t0
    print(f"录制 {seconds:.0f}s @ 目标 {RECORD_FPS:.0f}fps → {path}")
    print("  期间不要碰灯板 / 相机 / 环境光（判定靠画面恒定）")
    while written < need:
        ok, frame = cap.read()
        if not ok:
            break
        writer.write(frame)
        written += 1
        now = time.monotonic()
        if now - last_report >= 10.0:
            elapsed = now - t0
            print(f"  {elapsed:5.1f}s  {written} 帧  ({written/elapsed:.1f} fps)")
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
        "fps_tag": RECORD_FPS,
        "size": [w, h],
        "camera": {"backend": "DSHOW", "exposure": info["exposure"],
                   "gain": info["gain"], "auto_exposure": info["auto_exposure"]},
    }
    with open(os.path.splitext(path)[0] + ".json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    print(f"完成：{written} 帧 / {elapsed:.1f}s = {written/elapsed:.1f} fps")
    print(f"元数据写入 {os.path.splitext(path)[0]}.json")


def main():
    ap = argparse.ArgumentParser(description="#20 灯板录像（曝光锁定）")
    ap.add_argument("path", help="输出 mp4 路径")
    ap.add_argument("--seconds", type=float, default=DEFAULT_SECONDS)
    ap.add_argument("--exposure", type=float, default=EXPOSURE)
    ap.add_argument("--gain", type=float, default=GAIN)
    args = ap.parse_args()
    record(args.path, args.seconds, args.exposure, args.gain)


if __name__ == "__main__":
    main()
