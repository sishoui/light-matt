#!/usr/bin/env python
"""进阶灯效录像：持续录制真实灯带，逐帧写时间戳，供事后按标记切段。

与 `scripts/record-board.py` 的区别：
- 本脚本**连续录一场**，不按场景重开相机（开一次要 1.5s，切十几段会丢掉每段开头）；
- 每帧写绝对时间戳（`time.time()`），Node 侧的标记也用同一时钟，
  事后按时间轴切窗口，不用容器声明的帧率（实测 720p=10fps，声明值是 30）。

**opencv 与 bleak 不能同进程**（WinRT MTA 报错），所以本脚本只拍，
BLE 由 Node 侧经 `scripts/ble-gateway.py` 驱动。

握手：写 `ready` 文件 → 等 `go` 文件 → 开录 → 等 `stop` 文件 → 收尾。
"""

import json
import os
import sys
import time

import cv2

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else HERE
    width = int(sys.argv[2]) if len(sys.argv) > 2 else 1280
    height = int(sys.argv[3]) if len(sys.argv) > 3 else 720
    exposure = float(sys.argv[4]) if len(sys.argv) > 4 else -7.0
    max_seconds = float(sys.argv[5]) if len(sys.argv) > 5 else 900.0
    os.makedirs(out_dir, exist_ok=True)

    ready = os.path.join(out_dir, "ready")
    go = os.path.join(out_dir, "go")
    stop = os.path.join(out_dir, "stop")
    video = os.path.join(out_dir, "strips.mp4")
    meta = os.path.join(out_dir, "camera.json")
    for f in (ready, go, stop):
        try:
            os.remove(f)
        except OSError:
            pass

    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    if not cap.isOpened():
        sys.exit("打不开相机")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    # 必须锁曝光：自动曝光会让「呼吸」与「亮度变化」被判成同一件事。
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
    cap.set(cv2.CAP_PROP_EXPOSURE, exposure)
    cap.set(cv2.CAP_PROP_GAIN, 0)
    time.sleep(1.5)
    for _ in range(15):
        cap.read()

    with open(ready, "w", encoding="utf-8") as fh:
        fh.write(str(time.time()))
    print(f"相机就绪 {width}x{height} exposure={exposure}，等 go …", flush=True)

    while not os.path.exists(go):
        time.sleep(0.05)
        if time.time() - os.path.getmtime(ready) > 60:
            sys.exit("等 go 超时")

    ok, frame = cap.read()
    if not ok:
        sys.exit("取帧失败")
    h, w = frame.shape[:2]

    t0 = time.time()
    n = 0
    while time.time() - t0 < 1.5:
        if cap.read()[0]:
            n += 1
    fps = n / (time.time() - t0)
    print(f"实测帧率 {fps:.2f} fps", flush=True)

    writer = cv2.VideoWriter(video, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    if not writer.isOpened():
        sys.exit(f"打不开输出 {video}")

    stamps = []
    t_start = time.time()
    print("录制中 …", flush=True)
    while not os.path.exists(stop) and time.time() - t_start < max_seconds:
        ok, frame = cap.read()
        if not ok:
            break
        writer.write(frame)
        stamps.append(round(time.time(), 5))

    writer.release()
    cap.release()
    t_end = time.time()

    with open(meta, "w", encoding="utf-8") as fh:
        json.dump({
            "video": os.path.basename(video),
            "width": w,
            "height": h,
            "frames": len(stamps),
            "measured_fps": round(fps, 3),
            "start_time": round(t_start, 5),
            "end_time": round(t_end, 5),
            "duration_s": round(t_end - t_start, 2),
            "exposure": exposure,
            # 逐帧绝对时间：切窗口按它，不按容器帧率
            "frame_times": stamps,
        }, fh)
    print(f"完成：{len(stamps)} 帧 / {t_end - t_start:.1f}s = "
          f"{len(stamps) / max(0.001, t_end - t_start):.2f} fps → {video}", flush=True)


if __name__ == "__main__":
    main()
