#!/usr/bin/env python
"""#7 RMT × BLE 共存实验的「错色判定」：把 30 分钟录像拆成可数的证据。

为什么需要它：docs/rmt-ble-stability.md §2 自己写明——串口只能证明「固件没崩、
刷新没报错」，证明不了波形正确；§3.3 又写明人眼对「单颗灯错色」很容易漏。
两头都不可靠，而判定线（错色 ≤ 1 次/10 分钟）恰恰押在这上面。

本脚本补的是中间那一环：STEADY 模式下画面是**恒定**的，所以任何偏离基线的帧
都是异常。它逐帧解码，把灯带切成 N 段（建议与灯珠数一致），每段单独建立
滚动中位数基线，因此**单颗灯错色也能被抓到**，不会被整条平均淹没。

判定维度（都与「该段自己」的基线比，抗环境光差异与相机自动曝光漂移）：

  色相偏离  chroma = RGB / (R+G+B)，与基线的最大分量差 > 阈值 → 错色
  变暗     亮度 < 基线 × dark_ratio                        → 熄灭/变暗
  变亮     亮度 > 基线 × bright_ratio                      → 变亮/闪烁

用法：

    # 先自检，确认判定逻辑本身是对的（会生成合成视频并验证）
    python scripts/analyze-strip-video.py --selftest

    # 分析一段录像
    python scripts/analyze-strip-video.py video.mp4 --segments 64

    # 显式指定灯带区域（自动检测不灵时）
    python scripts/analyze-strip-video.py video.mp4 --roi 120,860,840,120

输出：终端摘要 + `--json` 指定的事件明细（时间戳可直接与串口 t= 对齐）。

依赖：opencv-python (cv2) + numpy。仓库环境已有，无需 ffmpeg。
"""

import argparse
import json
import math
import sys
from collections import deque

import numpy as np

try:
    import cv2
except ImportError:
    sys.exit("需要 opencv-python：python -m pip install opencv-python")

# 每段在内部重采样到这个像素宽度再取均值；够小以求速度，够大以免量化噪声。
SEG_PIXELS = 4

# 每段取「最亮的这一比例像素」做代表色。0.25 意味着即使抖动把该段 3/4 的
# 面积换成黑色背景，代表色仍然是灯珠本身，不会被稀释。
TOP_FRACTION = 0.25


# ---------------------------------------------------------------- 取色


def frame_segments(frame_bgr, roi, segments):
    """把 ROI 沿长边切成 segments 段，返回 (每段均值 RGB, 每段亮像素比例)。

    返回的 rgb 形状 (segments, 3)，顺序是 R,G,B（不是 OpenCV 的 BGR）。
    某段如果几乎没有亮像素（灯灭/黑），mean 该行置 0、lit_ratio 置 0，
    由调用方按「熄灭」处理——不能把黑当成一种颜色去比色相。
    """
    x, y, w, h = roi
    patch = frame_bgr[y : y + h, x : x + w]
    if patch.size == 0:
        return np.zeros((segments, 3)), np.zeros(segments)

    horizontal = w >= h
    if horizontal:
        # 长边=宽：压成 (segments*SEG_PIXELS, 4) 后按列分段
        small = cv2.resize(patch, (segments * SEG_PIXELS, 4), interpolation=cv2.INTER_AREA)
    else:
        small = cv2.resize(patch, (4, segments * SEG_PIXELS), interpolation=cv2.INTER_AREA)

    # BGR → 逐像素置为 (seg, pixel, BGR)
    if horizontal:
        chunks = small.reshape(4, segments, SEG_PIXELS, 3)
        chunks = chunks.transpose(1, 0, 2, 3).reshape(segments, -1, 3)
    else:
        chunks = small.reshape(segments, SEG_PIXELS, 4, 3)
        chunks = chunks.transpose(0, 2, 1, 3).reshape(segments, -1, 3)

    b = chunks[:, :, 0].astype(np.float32)
    g = chunks[:, :, 1].astype(np.float32)
    r = chunks[:, :, 2].astype(np.float32)
    return b, g, r


def segment_features(b, g, r, lit_threshold):
    """由每段的 B/G/R 平面算出代表性 RGB、亮度、色相、亮像素比例。

    取「该段最亮的 TOP_FRACTION 像素」的中位数，而不是「超过绝对阈值」的均值。
    原因（踩过的坑）：暗红在亮度 64 时 lum≈16.8，只要相机曝光稍降 12% 就跌破
    任何固定阈值（比如 18），整条会被判成「熄灭」，零值再污染基线，随后爆出
    巨大的假偏离。真机录像的曝光本来就会漂移，所以不能依赖绝对阈值。

    取最亮的一批像素在物理上更合理：灯带是画面里的高亮区域，取它的峰值就代表
    灯珠颜色；背景全黑或曝光变化都不会改变「哪批像素最亮」这个事实。
    """
    lum_px = 0.299 * r + 0.587 * g + 0.114 * b
    n_seg, n_px = lum_px.shape
    take = max(1, int(round(n_px * TOP_FRACTION)))

    # 每段按亮度取前 take 个像素（argpartition 是 O(n)，比全排序快）
    order = np.argpartition(lum_px, -take, axis=1)[:, -take:]
    rows = np.arange(n_seg)[:, None]
    r_top = r[rows, order]
    g_top = g[rows, order]
    b_top = b[rows, order]

    r_rep = np.median(r_top, axis=1)
    g_rep = np.median(g_top, axis=1)
    b_rep = np.median(b_top, axis=1)

    total_rgb = r_rep + g_rep + b_rep
    safe = np.maximum(total_rgb, 1.0)
    chroma_r = r_rep / safe
    chroma_g = g_rep / safe
    chroma_b = b_rep / safe

    lum = 0.299 * r_rep + 0.587 * g_rep + 0.114 * b_rep
    # 「有没有灯」用最亮像素是否高于一个极低的绝对底噪判断（只排除纯黑帧，
    # 不用它做颜色或亮度的判据）。这里守 6.0，远低于任何有效亮度。
    lit_ratio = (np.max(lum_px, axis=1) > lit_threshold).astype(np.float32)
    return {
        "rgb": np.stack([r_rep, g_rep, b_rep], axis=1),
        "chroma": np.stack([chroma_r, chroma_g, chroma_b], axis=1),
        "lum": lum,
        "lit_ratio": lit_ratio,
    }


# ---------------------------------------------------------------- 基线判定


class SegmentBaseline:
    """每段各自的滚动中位数基线。

    比较时**不含当前帧**：单帧错误不会污染基线；持续的状态变化在窗口填满后
    才会被当成新常态（那是永久变化，不是我们要抓的偶发错色）。

    同时记录每段的 lit_ratio 基线：真机录像里灯带可能因轻微抖动周期性地在
    ROI 边缘「露出一小块黑」，这不是灯灭了。只有整段持续变黑才算 dark。
    """

    def __init__(self, segments, window):
        self.segments = segments
        self.chroma = deque(maxlen=window)
        self.lum = deque(maxlen=window)
        self.lit = deque(maxlen=window)
        self.warm = 0
        self.window = window

    def ready(self):
        return self.warm >= self.window

    def push(self, feat):
        self.chroma.append(feat["chroma"].copy())
        self.lum.append(feat["lum"].copy())
        self.lit.append(feat["lit_ratio"].copy())
        self.warm += 1

    def compare(self, feat):
        """返回 (每段的色相偏离, 每段的亮度比, 每段是否熄灭)。基线未就绪时返回 None。"""
        if not self.chroma:
            return None
        base_chroma = np.median(np.stack(self.chroma), axis=0)
        base_lum = np.median(np.stack(self.lum), axis=0)
        base_lit = np.median(np.stack(self.lit), axis=0)

        dev = np.abs(feat["chroma"] - base_chroma).max(axis=1)
        safe = np.maximum(base_lum, 1e-6)
        lum_ratio = feat["lum"] / safe

        # 熄灭必须同时满足两条：该段现在最亮的像素都很暗（lit_ratio 掉了），
        # **而且**它平时是亮的（base_lit 高）。否则 ROI 边缘本来就有黑边的段
        # 会被无休止地误报。
        was_lit = base_lit > 0.5
        is_lit = feat["lit_ratio"] > 0.5
        dark = was_lit & ~is_lit
        return dev, lum_ratio, dark


def classify(dev, lum_ratio, dark, chroma_threshold, dark_ratio, bright_ratio):
    """把每段的偏离归成事件类型；返回 [(segment, kind, 幅度)]。

    顺序是先色相、后亮度，因为一次 RMT 波形损坏常常同时改变颜色和亮度
    （暗红 → 亮绿），若先判亮度就被归成 bright，会掩盖「这是错色」这个更
    重要的结论。熄灭（dark）必须最先判：黑色没有色相，拿它比色相会误报。
    """
    hits = []
    for i in range(len(dev)):
        if dark[i]:
            hits.append((i, "dark", 0.0))
            continue
        if dev[i] > chroma_threshold:
            hits.append((i, "wrong_color", float(dev[i])))
            continue
        if lum_ratio[i] < dark_ratio:
            hits.append((i, "dim", float(lum_ratio[i])))
            continue
        if lum_ratio[i] > bright_ratio:
            hits.append((i, "bright", float(lum_ratio[i])))
            continue
    return hits


def group_events(flagged_frames, fps, merge_gap_frames):
    """把「同一次错误出现在连续帧里」合并成一个事件。

    flagged_frames: [(frame_idx, [hits])]
    相邻两个命中帧的间隔 <= merge_gap_frames 视为同一事件（60fps 下一次 20Hz
    刷新约占 3 帧，压缩抖动可能让中间夹一帧干净，所以允许小间隙）。
    """
    events = []
    for idx, hits in flagged_frames:
        if events and idx - events[-1]["end_frame"] <= merge_gap_frames:
            ev = events[-1]
            ev["end_frame"] = idx
            ev["frames"] += 1
            ev["segments"].update(h[0] for h in hits)
            kinds = ev["kinds"]
            for _, kind, mag in hits:
                kinds[kind] = max(kinds.get(kind, 0.0), mag)
        else:
            events.append(
                {
                    "start_frame": idx,
                    "end_frame": idx,
                    "frames": 1,
                    "segments": {h[0] for h in hits},
                    "kinds": {kind: mag for _, kind, mag in hits},
                }
            )
    for ev in events:
        ev["t_start"] = ev["start_frame"] / fps
        ev["t_end"] = ev["end_frame"] / fps
        ev["kind"] = max(ev["kinds"], key=lambda k: ev["kinds"][k])
        ev["segments"] = sorted(ev["segments"])
    return events


# ---------------------------------------------------------------- ROI 自动检测


def detect_roi(cap, frame_count, max_samples=40):
    """找灯带区域：在若干采样帧里找「红通道显著高于 G/B」的像素，取并集包围盒。

    STEADY 模式是恒定暗红，这个判据很稳。找不到就返回 None，让调用方要求手动指定。
    """
    if frame_count <= 0:
        return None
    step = max(1, frame_count // max_samples)
    boxes = []
    idx = 0
    sampled = 0
    while sampled < max_samples:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            break
        b = frame[:, :, 0].astype(np.int16)
        g = frame[:, :, 1].astype(np.int16)
        r = frame[:, :, 2].astype(np.int16)
        mask = (r > 40) & (r > g + 20) & (r > b + 20)
        if mask.any():
            ys, xs = np.where(mask)
            boxes.append((xs.min(), ys.min(), xs.max(), ys.max()))
        idx += step
        sampled += 1
    if not boxes:
        return None
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    # 留一点边，避免把灯带边缘切掉
    pad = 4
    h, w = frame.shape[:2]
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(w - 1, x1 + pad)
    y1 = min(h - 1, y1 + pad)
    return (x0, y0, x1 - x0 + 1, y1 - y0 + 1)


# ---------------------------------------------------------------- 主分析


def analyze_video(
    path,
    segments=64,
    roi=None,
    chroma_threshold=0.18,
    dark_ratio=0.55,
    bright_ratio=1.8,
    window=61,
    merge_gap_frames=3,
    lit_threshold=6.0,
    max_seconds=None,
    stride=1,
    progress=True,
):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit(f"打不开视频：{path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 60.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if roi is None:
        roi = detect_roi(cap, frame_count)
        if roi is None:
            raise SystemExit(
                "自动检测灯带区域失败（画面里没找到明显的红色区域）。"
                "请用 --roi x,y,w,h 手动指定。"
            )
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    limit_frames = int(max_seconds * fps) if max_seconds else frame_count
    if frame_count:
        limit_frames = min(limit_frames, frame_count)

    baseline = SegmentBaseline(segments, window)
    flagged = []
    idx = 0
    analyzed = 0
    warmup_frames = window

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx >= limit_frames:
            break
        if idx % stride == 0:
            b, g, r = frame_segments(frame, roi, segments)
            feat = segment_features(b, g, r, lit_threshold)
            cmp = baseline.compare(feat)
            if cmp is not None:
                dev, lum_ratio, dark = cmp
                hits = classify(
                    dev, lum_ratio, dark, chroma_threshold, dark_ratio, bright_ratio
                )
                if hits:
                    flagged.append((idx, hits))
            baseline.push(feat)
            analyzed += 1
            if progress and analyzed % 3600 == 0:
                print(f"  …已分析 {analyzed} 帧（{idx / fps:.0f}s）", flush=True)
        idx += 1

    cap.release()

    events = group_events(flagged, fps, merge_gap_frames)
    duration_s = analyzed / fps if fps else 0
    rate_per_10min = (len(events) / duration_s * 600) if duration_s > 0 else 0.0

    return {
        "video": path,
        "fps": fps,
        "frames_total": frame_count,
        "frames_analyzed": analyzed,
        "duration_s": round(duration_s, 2),
        "roi": list(roi),
        "segments": segments,
        "warmup_frames": warmup_frames,
        "params": {
            "chroma_threshold": chroma_threshold,
            "dark_ratio": dark_ratio,
            "bright_ratio": bright_ratio,
            "window": window,
            "merge_gap_frames": merge_gap_frames,
            "lit_threshold": lit_threshold,
            "stride": stride,
        },
        "event_count": len(events),
        "rate_per_10min": round(rate_per_10min, 3),
        "events": [
            {
                "t_start_s": round(ev["t_start"], 2),
                "t_end_s": round(ev["t_end"], 2),
                "kind": ev["kind"],
                "kinds": {k: round(v, 3) for k, v in ev["kinds"].items()},
                "frames": ev["frames"],
                "segments": ev["segments"][:20],
                "segment_count": len(ev["segments"]),
            }
            for ev in events
        ],
    }


def print_report(result):
    print("\n" + "=" * 62)
    print(f"视频        {result['video']}")
    print(f"帧率        {result['fps']:.2f} fps")
    print(f"分析帧数    {result['frames_analyzed']} / {result['frames_total']}")
    print(f"有效时长    {result['duration_s']:.1f}s（前 {result['warmup_frames']} 帧作基线）")
    print(f"灯带区域    x={result['roi'][0]} y={result['roi'][1]} "
          f"w={result['roi'][2]} h={result['roi'][3]}")
    print(f"分段数      {result['segments']}")
    print(f"错色/闪烁   {result['event_count']} 次")
    print(f"换算错色率  {result['rate_per_10min']} 次/10 分钟")
    print("=" * 62)
    if result["events"]:
        print("\n事件明细（t 为视频时间，可与串口 t= 对齐）：")
        for i, ev in enumerate(result["events"], 1):
            kinds = ", ".join(f"{k}({v})" for k, v in ev["kinds"].items())
            segs = ev["segments"][:6]
            more = f" …共 {ev['segment_count']} 段" if ev["segment_count"] > len(segs) else ""
            print(
                f"  {i:3d}. t={ev['t_start_s']:8.2f}s  持续 {ev['frames']} 帧  "
                f"{ev['kind']:12s} 段={segs}{more}  [{kinds}]"
            )
    else:
        print("\n未检出任何异常帧。")


# ---------------------------------------------------------------- 自检


def _make_synthetic(path, fps=60, seconds=10, segments=16, injected=None, jitter=False):
    """生成一段「恒定暗红 + 已知异常」的合成录像，用来验证判定逻辑本身。

    jitter=True 时模拟真实录像的两个常见干扰：整体亮度缓慢漂移（相机自动曝光）
    与亚像素抖动（手持/支架轻微移动）。判定逻辑必须对这两种免疫，否则真机录像
    会被这些噪声刷满假阳性。
    """
    injected = injected or {}
    w, h = 640, 480
    # 灯带区域：横向居中，高 60px
    sx, sy, sw, sh = 40, 210, 560, 60
    writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    total = fps * seconds
    base0 = np.array([0, 0, 64], dtype=np.float32)  # 暗红（BGR）
    for f in range(total):
        frame = np.zeros((h, w, 3), dtype=np.uint8)
        seg_w = sw // segments
        # 每帧都从 base0 重算，不能就地累乘（否则亮度指数漂移）
        base = base0.copy()
        if jitter:
            # 曝光漂移：±12% 正弦，周期约 3s
            base *= 1.0 + 0.12 * math.sin(2 * math.pi * f / (fps * 3))
            # 轻微的「背景」噪声，模拟传感器噪声
            noise = np.random.normal(0, 1.2, (sh, seg_w, 3))
            shift_y = int(1.5 * math.sin(2 * math.pi * f / (fps * 7)))
        else:
            noise = 0.0
            shift_y = 0
        for s in range(segments):
            color = tuple(int(v) for v in np.clip(base, 0, 255))
            if f in injected:
                kind, target = injected[f]
                if kind == "all":
                    if target == "green":
                        color = (0, 200, 0)
                    elif target == "white":
                        color = (200, 200, 200)
                    elif target == "blue":
                        color = (200, 0, 0)
                elif kind == "seg" and s == target[0]:
                    color = target[1]
            x0 = sx + s * seg_w
            y0 = sy + shift_y
            block = np.full((sh, seg_w, 3), color, dtype=np.float32) + noise
            frame[y0 : y0 + sh, x0 : x0 + seg_w] = np.clip(block, 0, 255).astype(np.uint8)
        writer.write(frame)
    writer.release()


def selftest():
    import tempfile
    import os

    print("自检：生成合成录像并验证判定逻辑")
    fps = 60
    segments = 16

    # ---- 用例 1：注入 4 次已知事件，必须全部检出且时间准确 ----
    injected = {}
    for f in (100, 101, 102):
        injected[f] = ("all", "green")
    for f in (300, 301, 302):
        injected[f] = ("all", "white")
    for f in (500, 501, 502):
        injected[f] = ("all", "blue")
    # 单颗灯错色：第 4 段变白
    for f in (700, 701, 702):
        injected[f] = ("seg", (4, (200, 200, 200)))

    tmp = os.path.join(tempfile.gettempdir(), "lumen-selftest-strip.mp4")
    _make_synthetic(tmp, fps=fps, seconds=15, segments=segments, injected=injected)

    result = analyze_video(
        tmp,
        segments=segments,
        roi=(40, 210, 560, 60),
        progress=False,
    )

    expected_times = [100 / fps, 300 / fps, 500 / fps, 700 / fps]
    got_times = [ev["t_start_s"] for ev in result["events"]]
    ok = True
    print(f"\n[用例 1] 注入 {len(expected_times)} 次事件 @ "
          + ", ".join(f"{t:.2f}s" for t in expected_times))
    print(f"          检出 {len(got_times)} 次事件 @ "
          + ", ".join(f"{t:.2f}s" for t in got_times))

    if len(got_times) != len(expected_times):
        print(f"✗ 事件数不符：期望 {len(expected_times)}，实得 {len(got_times)}")
        ok = False
    else:
        for exp, got, ev in zip(expected_times, got_times, result["events"]):
            if abs(exp - got) > 0.1:
                print(f"✗ 时间不符：期望 {exp:.2f}s，实得 {got:.2f}s")
                ok = False
            if ev["kind"] != "wrong_color":
                print(f"✗ {got:.2f}s 应为 wrong_color，实得 {ev['kind']}")
                ok = False
            print(f"  ✓ {got:.2f}s  {ev['kind']}  涉及 {ev['segment_count']} 段")

    single = [ev for ev in result["events"] if ev["segment_count"] <= 2]
    if not single:
        print("✗ 没检出单颗灯错色（整条平均会淹没它，这正是本脚本要解决的问题）")
        ok = False
    else:
        print(f"  ✓ 单颗灯错色已检出，仅涉及 {single[0]['segment_count']} 段")

    # ---- 用例 2：完全正常的录像，绝不能报假阳性 ----
    clean = os.path.join(tempfile.gettempdir(), "lumen-selftest-clean.mp4")
    _make_synthetic(clean, fps=fps, seconds=15, segments=segments, injected={})
    clean_result = analyze_video(
        clean, segments=segments, roi=(40, 210, 560, 60), progress=False
    )
    print(f"\n[用例 2] 无异常的录像：检出 {clean_result['event_count']} 次事件（应为 0）")
    if clean_result["event_count"] != 0:
        for ev in clean_result["events"][:5]:
            print(f"✗ 假阳性 t={ev['t_start_s']:.2f}s {ev['kind']} 段={ev['segments'][:5]}")
        ok = False
    else:
        print("  ✓ 无假阳性")

    # ---- 用例 3：带曝光漂移 + 抖动 + 噪声的正常录像，仍不能报假阳性 ----
    jittery = os.path.join(tempfile.gettempdir(), "lumen-selftest-jitter.mp4")
    _make_synthetic(
        jittery, fps=fps, seconds=15, segments=segments, injected={}, jitter=True
    )
    jitter_result = analyze_video(
        jittery, segments=segments, roi=(40, 210, 560, 64), progress=False
    )
    print(f"\n[用例 3] 曝光漂移+抖动+噪声：检出 {jitter_result['event_count']} 次（应为 0）")
    if jitter_result["event_count"] != 0:
        for ev in jitter_result["events"][:5]:
            print(f"✗ 假阳性 t={ev['t_start_s']:.2f}s {ev['kind']} 段={ev['segments'][:5]}")
        ok = False
    else:
        print("  ✓ 对曝光漂移与抖动免疫")

    # ---- 用例 4：真实感干扰下仍能抓到错色 ----
    jitter_injected = {}
    for f in (200, 201, 202):
        jitter_injected[f] = ("all", "green")
    mixed = os.path.join(tempfile.gettempdir(), "lumen-selftest-mixed.mp4")
    _make_synthetic(
        mixed, fps=fps, seconds=15, segments=segments, injected=jitter_injected, jitter=True
    )
    mixed_result = analyze_video(
        mixed, segments=segments, roi=(40, 210, 560, 64), progress=False
    )
    print(f"\n[用例 4] 干扰 + 1 次真实错色：检出 {mixed_result['event_count']} 次（应为 1）")
    if mixed_result["event_count"] != 1:
        for ev in mixed_result["events"][:5]:
            print(f"✗ t={ev['t_start_s']:.2f}s {ev['kind']}")
        ok = False
    else:
        ev = mixed_result["events"][0]
        print(f"  ✓ t={ev['t_start_s']:.2f}s {ev['kind']}（期望 3.33s）")
        if abs(ev["t_start_s"] - 200 / fps) > 0.1:
            print("✗ 时间偏移过大")
            ok = False

    print("\n自检" + ("通过" if ok else "失败"))
    return 0 if ok else 1


# ---------------------------------------------------------------- CLI


def main():
    ap = argparse.ArgumentParser(description="#7 错色判定：逐帧分析灯带录像")
    ap.add_argument("video", nargs="?", help="录像文件；--selftest 时可省略")
    ap.add_argument("--selftest", action="store_true", help="用合成视频验证判定逻辑")
    ap.add_argument("--segments", type=int, default=64,
                    help="把灯带切成几段，建议与灯珠数一致（默认 64）")
    ap.add_argument("--roi", help="灯带区域 x,y,w,h；不给则自动检测")
    ap.add_argument("--chroma-threshold", type=float, default=0.18,
                    help="色相偏离阈值（0-1，越小越敏感，默认 0.18）")
    ap.add_argument("--dark-ratio", type=float, default=0.55,
                    help="亮度低于基线此比例记为变暗（默认 0.55）")
    ap.add_argument("--bright-ratio", type=float, default=1.8,
                    help="亮度高于基线此比例记为变亮（默认 1.8）")
    ap.add_argument("--window", type=int, default=61,
                    help="滚动基线窗口帧数（默认 61 ≈ 1s@60fps）")
    ap.add_argument("--merge-gap", type=int, default=3,
                    help="间隔不超过此帧数视为同一事件（默认 3）")
    ap.add_argument("--lit-threshold", type=float, default=6.0,
                    help="判为「这段有灯」的极低亮度底噪（默认 6，只用来排除纯黑帧）")
    ap.add_argument("--max-seconds", type=float, help="只分析前 N 秒（调试用）")
    ap.add_argument("--stride", type=int, default=1,
                    help="每隔 N 帧取一帧（默认 1，不要为了省时间随意加大）")
    ap.add_argument("--json", help="把结果写成 JSON")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(selftest())
    if not args.video:
        ap.error("需要视频路径，或加 --selftest")

    roi = None
    if args.roi:
        parts = [int(v) for v in args.roi.replace(" ", "").split(",")]
        if len(parts) != 4:
            ap.error("--roi 格式为 x,y,w,h")
        roi = tuple(parts)

    print(f"分析 {args.video} …")
    result = analyze_video(
        args.video,
        segments=args.segments,
        roi=roi,
        chroma_threshold=args.chroma_threshold,
        dark_ratio=args.dark_ratio,
        bright_ratio=args.bright_ratio,
        window=args.window,
        merge_gap_frames=args.merge_gap,
        lit_threshold=args.lit_threshold,
        max_seconds=args.max_seconds,
        stride=args.stride,
    )
    print_report(result)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
        print(f"\n已写入 {args.json}")


if __name__ == "__main__":
    main()
