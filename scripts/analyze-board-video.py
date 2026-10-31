#!/usr/bin/env python
"""#20 错色判定：逐帧分析 8×8 灯板录像。

与 `analyze-strip-video.py` 的区别：那个按**一维**切段（或用轴对齐 --grid），
本脚本先把画面按标定单应矩阵矫正成方图，再切 8×8 —— 灯板在画面里是斜的
（约 -25°）且带透视，轴对齐切法会把邻灯的颜色算进同一格。

判定维度沿用同一套，都与「该格自己的滚动中位数基线」比，因此对相机曝光
缓慢漂移免疫：

  错色  chroma 的最大分量偏离 > 阈值（默认 0.18）
  熄灭  该格从「有灯」变成「暗」（必须本来亮过，避免边缘格误报）
  变暗  亮度 < 基线 × dark_ratio
  变亮  亮度 > 基线 × bright_ratio

用法：

    python scripts/analyze-board-video.py stress.mp4
    python scripts/analyze-board-video.py stress.mp4 --json out.json
    python scripts/analyze-board-video.py baseline.mp4 --max-seconds 30   # 试跑

判定线（票面）：30 分钟 20Hz 写入下，错色 ≤ 1 次/10 分钟且用户不可感知。
本脚本输出「次/10 分钟」以及每次事件的时刻与格号，可直接回帖。
"""

import argparse
import json
import math
import os
import sys

import numpy as np

try:
    import cv2
except ImportError:
    sys.exit("需要 opencv-python：python -m pip install opencv-python")

from importlib.util import module_from_spec, spec_from_file_location

_dir = os.path.dirname(os.path.abspath(__file__))
_spec = spec_from_file_location("led_probe", os.path.join(_dir, "led-probe.py"))
led_probe = module_from_spec(_spec)
_spec.loader.exec_module(led_probe)

ROWS = COLS = 8
N_CELLS = ROWS * COLS

TOP_FRACTION = 0.25     # 仅作历史参照；代表色现按「相对最亮值」筛（见 cell_metrics）
# 「这格有没有灯」的判据。**用代表色的亮度，不用单像素最大值**：
# 实测未点亮的格子偶尔有一个溢光像素到 30（灯板邻格的红色反光），
# 用 max_px 会把暗格判成亮格，随后它的色度（几乎处处是 0，比值纯噪声）
# 就会在基线里抖动，产生大量假错色。格内代表亮度 >12 才认为有灯。
LIT_THRESHOLD = 12.0
# 亮度低于这个值时不看色相：色度是归一化比值，分母趋零时噪声被放大，
# 暗格的色相没有任何物理意义。
MIN_HUE_LUM = 20.0


def cell_metrics(warped):
    """把矫正后的方图切成 8×8，返回 (chroma, lum, max_px) 三个 (64,) 数组。

    代表色取「亮度 ≥ 该格最亮值 60% 的那批像素」的中位数，而不是固定取
    最亮 25%。原因：灯珠光斑在格子里占多大面积不确定（取决于对焦与亮度），
    若光斑只占 20%，固定取最亮 25% 会把黑背景也纳入，中位数直接掉到 0，
    整格被误判成「没有灯」。按「相对最亮值」筛，光斑多大都只取光斑本身。
    """
    ch, cw = warped.shape[0] // ROWS, warped.shape[1] // COLS
    chroma = np.zeros((N_CELLS, 3), np.float32)
    lum = np.zeros(N_CELLS, np.float32)
    max_px = np.zeros(N_CELLS, np.float32)
    for rr in range(ROWS):
        for cc in range(COLS):
            patch = warped[rr * ch:(rr + 1) * ch, cc * cw:(cc + 1) * cw]
            flat = patch.reshape(-1, 3).astype(np.float32)
            b, g, r = flat[:, 0], flat[:, 1], flat[:, 2]
            lpx = 0.299 * r + 0.587 * g + 0.114 * b
            peak = float(lpx.max())
            i = rr * COLS + cc
            max_px[i] = peak
            if peak <= 0:
                continue
            core = flat[lpx >= peak * 0.6]
            if len(core) == 0:
                core = flat[np.argmax(lpx)][None, :]
            med = np.median(core, axis=0)
            total = float(med.sum()) or 1.0
            chroma[i] = (med[2] / total, med[1] / total, med[0] / total)  # RGB
            lum[i] = 0.299 * med[2] + 0.587 * med[1] + 0.114 * med[0]
    return chroma, lum, max_px


class Baseline:
    """每格各自的滚动中位数基线；比较时不含当前帧。"""

    def __init__(self, window):
        self.chroma = []
        self.lum = []
        self.window = window

    def ready(self):
        return len(self.chroma) >= self.window

    def push(self, chroma, lum):
        self.chroma.append(chroma)
        self.lum.append(lum)
        if len(self.chroma) > self.window:
            self.chroma.pop(0)
            self.lum.pop(0)

    def compare(self, chroma, lum):
        if not self.chroma:
            return None
        base_c = np.median(np.stack(self.chroma), axis=0)
        base_l = np.median(np.stack(self.lum), axis=0)
        dev = np.abs(chroma - base_c).max(axis=1)
        ratio = lum / np.maximum(base_l, 1e-6)
        return dev, ratio


def classify(dev, ratio, was_lit, is_lit, lum, chroma_thr, dark_ratio,
             bright_ratio, min_hue_lum=MIN_HUE_LUM):
    """归成事件。顺序：熄灭 → 错色 → 变暗 → 变亮。

    熄灭最先判：黑色没有色相，拿它比色相必然误报。
    错色先于亮度：波形损坏常同时改颜色和亮度，先判亮度会掩盖「错色」。
    色相只在「当前够亮」时判：暗格的色度是噪声（分母趋零），没有物理意义。
    """
    hits = []
    for i in range(N_CELLS):
        if was_lit[i] and not is_lit[i]:
            hits.append((i, "dark", 0.0))
            continue
        if not is_lit[i]:
            continue          # 本来就是黑的格，不参与判定
        bright_enough = lum[i] >= min_hue_lum
        if bright_enough and dev[i] > chroma_thr:
            hits.append((i, "wrong_color", float(dev[i])))
        elif ratio[i] < dark_ratio:
            hits.append((i, "dim", float(ratio[i])))
        elif ratio[i] > bright_ratio:
            hits.append((i, "bright", float(ratio[i])))
    return hits


def group_events(flagged, fps, merge_gap):
    """把同一次错误跨连续帧合并成一个事件。"""
    events = []
    for idx, hits in flagged:
        if events and idx - events[-1]["end_frame"] <= merge_gap:
            ev = events[-1]
            ev["end_frame"] = idx
            ev["frames"] += 1
            ev["cells"].update(h[0] for h in hits)
            for _, kind, mag in hits:
                ev["kinds"][kind] = max(ev["kinds"].get(kind, 0.0), mag)
        else:
            events.append({"start_frame": idx, "end_frame": idx, "frames": 1,
                           "cells": {h[0] for h in hits},
                           "kinds": {k: m for _, k, m in hits}})
    for ev in events:
        ev["t_start"] = ev["start_frame"] / fps
        ev["t_end"] = ev["end_frame"] / fps
        ev["kind"] = max(ev["kinds"], key=lambda k: ev["kinds"][k])
        ev["cells"] = sorted(ev["cells"])
    return events


def analyze(path, homography, chroma_thr=0.18, dark_ratio=0.55,
            bright_ratio=1.8, window=90, merge_gap=6, max_seconds=None,
            stride=1, progress=True):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit(f"打不开视频：{path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    limit = int(max_seconds * fps) if max_seconds else total
    if total:
        limit = min(limit, total)

    baseline = Baseline(window)
    flagged = []
    idx = analyzed = 0
    while idx < limit:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % stride == 0:
            warped = led_probe.warp_with(homography, frame)
            chroma, lum, max_px = cell_metrics(warped)
            is_lit = lum > LIT_THRESHOLD
            cmp = baseline.compare(chroma, lum)
            if cmp is not None:
                dev, ratio = cmp
                base_lit = np.median(np.stack(baseline.lum), axis=0) > LIT_THRESHOLD
                hits = classify(dev, ratio, base_lit, is_lit, lum, chroma_thr,
                                dark_ratio, bright_ratio)
                if hits:
                    flagged.append((idx, hits))
            baseline.push(chroma, lum)
            analyzed += 1
            if progress and analyzed % 1800 == 0:
                print(f"  …{analyzed} 帧（{idx / fps:.0f}s）", flush=True)
        idx += 1
    cap.release()

    events = group_events(flagged, fps, merge_gap)
    duration = analyzed / fps if fps else 0.0
    rate = (len(events) / duration * 600) if duration > 0 else 0.0
    return {"video": os.path.basename(path), "fps": fps, "frames": analyzed,
            "duration_s": round(duration, 1), "events": events,
            "event_count": len(events), "per_10min": round(rate, 2)}


def print_report(res, threshold_per_10min=1.0):
    print(f"\n视频        {res['video']}")
    print(f"时长        {res['duration_s']:.0f}s（{res['frames']} 帧 @ {res['fps']:.0f}fps）")
    print(f"事件数      {res['event_count']}")
    print(f"折算        {res['per_10min']:.2f} 次/10 分钟")
    if res["events"]:
        print("\n事件明细：")
        for ev in res["events"]:
            kinds = ", ".join(f"{k}={v:.2f}" for k, v in ev["kinds"].items())
            print(f"  t={ev['t_start']:7.2f}s  持续 {ev['frames']} 帧  "
                  f"格={ev['cells']}  {ev['kind']} ({kinds})")
    verdict = "通过" if res["per_10min"] <= threshold_per_10min else "未通过"
    print(f"\n判据（≤ {threshold_per_10min:.0f} 次/10 分钟）：{verdict}")


def _make_synthetic(path, rows=8, cols=8, fps=10, frames=200, on_cells=(),
                    drop_at=None, drop_cell=None, color_bgr=(10, 10, 230)):
    """生成 800×800 的合成录像：on_cells 画红点，drop_at 帧让 drop_cell 熄灭。"""
    size = 800
    writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"),
                             fps, (size, size))
    ch = cw = size // rows
    for i in range(frames):
        img = np.zeros((size, size, 3), np.uint8)
        for cell in on_cells:
            r, c = divmod(cell, cols)
            if drop_at is not None and i == drop_at and cell == drop_cell:
                continue
            cv2.circle(img, (c * cw + cw // 2, r * ch + ch // 2), 18,
                       color_bgr, -1)
        writer.write(img)
    writer.release()


def selftest():
    """验证判定逻辑：干净录像 0 事件；注入单格单帧熄灭能被抓到。"""
    import tempfile
    diag = [0, 9, 18, 27, 36, 45, 54, 63]
    eye = np.eye(3)
    tmp = tempfile.gettempdir()

    clean = os.path.join(tmp, "board-clean.mp4")
    _make_synthetic(clean, on_cells=diag)
    r1 = analyze(clean, eye, window=30, merge_gap=2, progress=False)
    ok1 = r1["event_count"] == 0
    print(f"[用例 1] 干净录像（8 颗常亮）：检出 {r1['event_count']} 次（应为 0）")
    print("  ✓ 无假阳性" if ok1 else "  ✗ 有假阳性")

    dirty = os.path.join(tmp, "board-drop.mp4")
    _make_synthetic(dirty, on_cells=diag, drop_at=120, drop_cell=63)
    r2 = analyze(dirty, eye, window=30, merge_gap=2, progress=False)
    hit = (r2["event_count"] == 1 and r2["events"]
           and 63 in r2["events"][0]["cells"])
    print(f"[用例 2] 第 120 帧格 63 熄灭：检出 {r2['event_count']} 次（应为 1）")
    if r2["events"]:
        ev = r2["events"][0]
        print(f"  t={ev['t_start']:.1f}s 持续 {ev['frames']} 帧 "
              f"格={ev['cells']} kind={ev['kind']}")
    print("  ✓ 精确抓到单帧单灯熄灭" if hit else "  ✗ 漏检/误检")

    for p in (clean, dirty):
        try:
            os.remove(p)
        except OSError:
            pass
    if not (ok1 and hit):
        sys.exit("自检失败")
    print("\n自检通过")


def main():
    ap = argparse.ArgumentParser(description="#20 灯板录像的错色判定")
    ap.add_argument("video", nargs="?", help="录像文件；--selftest 时可省略")
    ap.add_argument("--selftest", action="store_true",
                    help="用合成录像验证判定逻辑")
    ap.add_argument("--chroma-threshold", type=float, default=0.18)
    ap.add_argument("--dark-ratio", type=float, default=0.55)
    ap.add_argument("--bright-ratio", type=float, default=1.8)
    ap.add_argument("--window", type=int, default=90,
                    help="滚动基线窗口帧数（默认 90 ≈ 3s@30fps）")
    ap.add_argument("--merge-gap", type=int, default=6,
                    help="间隔不超过此帧数视为同一事件")
    ap.add_argument("--max-seconds", type=float, help="只分析前 N 秒")
    ap.add_argument("--stride", type=int, default=1)
    ap.add_argument("--json")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return
    if not args.video:
        ap.error("需要录像路径（或用 --selftest）")

    res = analyze(args.video, led_probe.load_homography(),
                  chroma_thr=args.chroma_threshold,
                  dark_ratio=args.dark_ratio,
                  bright_ratio=args.bright_ratio,
                  window=args.window, merge_gap=args.merge_gap,
                  max_seconds=args.max_seconds, stride=args.stride)
    print_report(res)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(res, fh, indent=2)
        print(f"明细已写入 {args.json}")


if __name__ == "__main__":
    main()
