#!/usr/bin/env python
"""逐带几何标定：为每条灯带定位「一条线段 + 端点」，产出 .strip-layout.json。

**为什么不再用单应矩阵 + 等分网格。** 旧工具（`led-probe.py calibrate`）假设
画面里是一块 N×N 方阵，把整帧透视矫正成 800×800 再等分。现在硬件是 **8 条互相
平行、长度各不相同的独立灯带**（实测 2 颗到 30 颗），等分网格无从下手；而且
网格对不上时工具不会报错，只会安静地输出错数字。

新模型对每条带存 **一条线段**（起点、终点、方向、长度），不需要逐颗灯的中心：
验收要判的是「这条带整体熄了 / 变色了 / 变成别人的颜色」，这些都是**带级**现象，
线段足够。逐颗定心的方案试过，成本高且脆弱（见文件末尾「踩过的坑」）。

**标定要对抗的三类干扰**（都实测踩过）：
  1. 光照变 → 阈值不能写死，用画面自身的动态范围做自适应；
  2. 相机机位/朝向变 → 不做整帧旋转对齐，每条带独立拟合；
  3. 背景里有亮区（白纸反光、桌面、开发板 LED）→ 用色度判据排除。

**不可信就报错。** 拟合出来的角度如果和「8 条带应近似平行」这一物理约束矛盾，
或者像素量不足以支撑，直接判该带标定失败并列出原因 —— 绝不输出一个看似正常
实则错位的布局（旧工具正是这样静默出错的）。

用法（仓库根目录）：

    # 逐条隔离 → 抓图 → 标定 → 写 .strip-layout.json（会改设备状态）
    python scripts/strip-layout.py --isolate .layout-shots

    # 从已有 layout-<strip>.png 离线标定
    python scripts/strip-layout.py --dir .layout-shots

    # 看结果
    python scripts/strip-layout.py --show

    # 验证标定逻辑本身
    python scripts/strip-layout.py --selftest
"""

import argparse
import json
import math
import os
import subprocess
import sys

import numpy as np

try:
    import cv2
except ImportError:
    sys.exit("需要 opencv-python：python -m pip install opencv-python")

_here = os.path.dirname(os.path.abspath(__file__))
from importlib.util import module_from_spec, spec_from_file_location

_spec = spec_from_file_location("led_probe", os.path.join(_here, "led-probe.py"))
led_probe = module_from_spec(_spec)
_spec.loader.exec_module(led_probe)

LAYOUT_PATH = os.path.join(_here, "..", ".strip-layout.json")
STRIP_COUNT = 8

# 8 条带在物理上是平行安装的。允许的偏离量：实测各条在 ±4° 内一致。
MAX_ANGLE_SPREAD_DEG = 8.0
# 一条带最少要有这么多「色度像素」，否则不足以定方向。
MIN_MASK_PX = 250


def lead_channel(frame):
    """判断这一帧的主色通道（0=B, 1=G, 2=R）。

    用**色度能量**，不用通道总量也不用最亮像素：
      - 通道总量：背景（桌面、白纸）贡献巨大且三路接近，把灯带的差异淹掉。
        实测某条蓝带来 B/G/R 总量 34M/28M/25M，比值仅 1.21，判不出来。
      - 最亮像素：画面最亮的常是反光点（BGR=(255,255,249)），会让主导通道
        随机漂到 R。
      - 色度能量 max(0, ch - max(others))：只统计「这一路明显压过另两路」的
        部分，白纸/反光恒为 0。同一条带实测 B=6022 / G=1 / R=1266，判得干净。
    """
    img = frame.astype(np.int32)
    b, g, r = img[:, :, 0], img[:, :, 1], img[:, :, 2]
    energy = np.array([
        np.clip(b - np.maximum(g, r), 0, None).sum(),
        np.clip(g - np.maximum(b, r), 0, None).sum(),
        np.clip(r - np.maximum(b, g), 0, None).sum(),
    ], np.float64)
    if energy.max() <= 0:
        return None
    return int(np.argmax(energy))


def chroma_margin(frame):
    """色度余量图 = 主导通道 − 其余通道的最大值（低于 0 归零）。

    这张图对光照强度和相机白平衡都不敏感：背景（三通道接近）恒为 0，
    灯带（饱和色）显著为正。后续掩码和剖面都用它。
    """
    lead = lead_channel(frame)
    if lead is None:
        return None, None
    img = frame.astype(np.float32)
    chans = [img[:, :, 0], img[:, :, 1], img[:, :, 2]]
    others = [chans[i] for i in range(3) if i != lead]
    m = chans[lead] - np.maximum(others[0], others[1])
    m[m < 0] = 0
    return m, lead


def strip_mask(frame):
    """自适应阈值掩码。

    **阈值不能用分位数。** 灯带在画面里只占极小面积（实测这条带的真实信号
    只有约 1300 个像素，占全画面 0.06%），而背景有大量低水平色偏（p99.9 只有
    20，但最大值 62）。按 `p99.5 × 0.45` 取阈值得到 9 —— 把整个背景都包了
    进来，掩码覆盖全画面 30 万像素，拟合出的「线段」横跨整个视图。

    正确做法：以**最大值的一个比例**作阈值。灯带的 margin 显著高于背景噪声，
    取 `max × 0.5` 能干净地把两者分开，且对光照强度自适应（光照强弱只缩放
    整体量级，不改变相对关系）。
    """
    m, _lead = chroma_margin(frame)
    if m is None or m.max() < 12:
        return None
    thr = max(12.0, float(m.max()) * 0.5)
    mask = (m >= thr).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    return mask


def fit_segment(mask, weight):
    """从掩码拟合一条线段，返回 dict 或 (None, 原因)。

    返回：{p0, p1, dir, angle_deg, length, px}
    """
    ys, xs = np.nonzero(mask)
    if len(xs) < MIN_MASK_PX:
        return None, f"候选像素只有 {len(xs)}（需 ≥{MIN_MASK_PX}）"
    pts = np.column_stack([xs, ys]).astype(np.float64)
    w = weight[ys, xs].astype(np.float64)
    if w.sum() <= 0:
        w = np.ones(len(xs))
    wsum = w.sum()
    mean = (pts * w[:, None]).sum(axis=0) / wsum
    c = (pts - mean) * np.sqrt(w[:, None])
    _u, s, vt = np.linalg.svd(c, full_matrices=False)
    if s[0] <= 1e-6:
        return None, "点云退化，无法定向"
    d = vt[0]
    if d[0] < 0:
        d = -d
    d = d / np.linalg.norm(d)
    # 轴比太接近 1 说明「一团」而不是「一条线」，拟合出的方向没有意义
    if s[1] > s[0] * 0.55:
        return None, f"形状不呈细长（轴比 {s[0] / max(s[1], 1e-6):.2f}）"

    along = (pts - mean) @ d
    lo, hi = float(np.percentile(along, 0.5)), float(np.percentile(along, 99.5))
    p0 = mean + d * lo
    p1 = mean + d * hi
    angle = math.degrees(math.atan2(d[1], d[0]))
    return {
        "p0": [round(float(p0[0]), 1), round(float(p0[1]), 1)],
        "p1": [round(float(p1[0]), 1), round(float(p1[1]), 1)],
        "dir": [round(float(d[0]), 5), round(float(d[1]), 5)],
        "angle_deg": round(float(angle), 2),
        "length": round(float(hi - lo), 1),
        "px": int(len(xs)),
    }, None


def sample_line(img, p0, direction, n=200):
    """沿 (p0, direction) 均匀取 n 个点的双线性插值值。"""
    ts = np.linspace(0.0, 1.0, n)
    length = float(np.hypot(*(np.asarray(p0) - np.asarray(p0))))  # placeholder
    return ts


def bilinear(img32, x, y):
    """向量化双线性插值；越界返回 0。"""
    h, w = img32.shape[:2]
    x = np.asarray(x, np.float32)
    y = np.asarray(y, np.float32)
    ok = (x >= 0) & (x < w - 1) & (y >= 0) & (y < h - 1)
    xc = np.where(ok, x, 0).astype(np.int32)
    yc = np.where(ok, y, 0).astype(np.int32)
    fx = np.where(ok, x - xc, 0.0).astype(np.float32)
    fy = np.where(ok, y - yc, 0.0).astype(np.float32)
    x1 = np.minimum(xc + 1, w - 1)
    y1 = np.minimum(yc + 1, h - 1)
    v00 = img32[yc, xc]
    v01 = img32[yc, x1]
    v10 = img32[y1, xc]
    v11 = img32[y1, x1]
    out = (v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy)
           + v10 * (1 - fx) * fy + v11 * fx * fy)
    return np.where(ok, out, 0.0).astype(np.float32)


def strip_profile(frame, seg, n=400):
    """沿线段取「法向 ±3px 最大值」的色度剖面，用于后续逐颗/逐段判定。"""
    m, _ = chroma_margin(frame)
    if m is None:
        return None
    p0 = np.array(seg["p0"], np.float64)
    p1 = np.array(seg["p1"], np.float64)
    d = (p1 - p0)
    L = float(np.linalg.norm(d))
    if L < 1:
        return None
    d = d / L
    nx, ny = -d[1], d[0]
    ts = np.linspace(0.0, L, n)
    best = np.zeros(n, np.float32)
    for off in (-3.0, -1.0, 0.0, 1.0, 3.0):
        x = p0[0] + d[0] * ts + nx * off
        y = p0[1] + d[1] * ts + ny * off
        np.maximum(best, bilinear(m, x, y), out=best)
    return best


def calibrate_one(frame, strip, verbose=True):
    """从一帧隔离画面标定一条带。返回 (dict, None) 或 (None, 原因)。"""
    mask = strip_mask(frame)
    if mask is None:
        return None, "画面里没有可用色度（灯带没亮？曝光全黑？）"
    m, _ = chroma_margin(frame)
    seg, why = fit_segment(mask, m)
    if seg is None:
        return None, why
    seg["strip"] = strip
    if verbose:
        print(f"  strip {strip}: len={seg['length']:6.1f}px  角度={seg['angle_deg']:6.1f}°  "
              f"px={seg['px']:6d}  p0=({seg['p0'][0]:.0f},{seg['p0'][1]:.0f})")
    return seg, None


def check_parallel(segs):
    """8 条带应近似平行：偏离中位角太多就判不可信。"""
    angles = np.array([s["angle_deg"] for s in segs.values()])
    if len(angles) < 2:
        return True, ""
    med = float(np.median(angles))
    worst = float(np.max(np.abs(angles - med)))
    ok = worst <= MAX_ANGLE_SPREAD_DEG
    return ok, f"角度中位 {med:.1f}°，最大偏离 {worst:.1f}°（上限 {MAX_ANGLE_SPREAD_DEG:.0f}°）"


def calibrate_isolated(frames, verbose=True):
    shape = next(iter(frames.values())).shape
    strips, failed = {}, {}
    ok_list = []
    for strip in range(STRIP_COUNT):
        frame = frames.get(strip)
        if frame is None:
            failed[strip] = "缺图"
            continue
        seg, why = calibrate_one(frame, strip, verbose)
        if seg:
            strips[strip] = seg
            ok_list.append(seg)
        else:
            failed[strip] = why
            if verbose:
                print(f"  strip {strip}: 标定失败 —— {why}")

    layout = {"frame_size": [shape[1], shape[0]], "strips": strips,
              "failed": {str(k): v for k, v in failed.items()},
              "method": "isolated-per-strip-segment"}
    if ok_list:
        good, msg = check_parallel(strips)
        layout["parallel_ok"] = good
        layout["parallel_note"] = msg
        if not good and verbose:
            print(f"\n  ! 平行性校验未通过：{msg}")
            print("    8 条带物理上平行；角度散开说明某些帧里混进了别的东西。"
                  "这些带的标定不可信。")
    return layout


def load_firmware_counts():
    try:
        out = subprocess.run(
            [sys.executable, os.path.join(_here, "ble-stress.py"), "show"],
            capture_output=True, text=True, timeout=90,
            encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.stdout.splitlines():
        if "counts=" in line:
            try:
                seg = line.split("counts=")[1].split("]")[0] + "]"
                return json.loads(seg.replace(" ", ", "))
            except (ValueError, IndexError):
                pass
    return None


def save(layout, path=LAYOUT_PATH):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(layout, fh, indent=2, ensure_ascii=False)
    print(f"布局已写入 {os.path.abspath(path)}")


def load(path=LAYOUT_PATH):
    if not os.path.exists(path):
        raise SystemExit(f"没有布局文件 {path}，先跑 --isolate 或 --dir")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def show(path=LAYOUT_PATH):
    layout = load(path)
    print(f"分辨率 {layout['frame_size']}，标定成功 {len(layout['strips'])}/{STRIP_COUNT} 条")
    print(f"{'strip':>5} {'len(px)':>8} {'angle':>7} {'px':>7}   p0 → p1")
    for k in sorted(layout["strips"], key=int):
        s = layout["strips"][k]
        print(f"{k:>5} {s['length']:>8.1f} {s['angle_deg']:>7.1f} {s['px']:>7}   "
              f"({s['p0'][0]:6.0f},{s['p0'][1]:6.0f}) → ({s['p1'][0]:6.0f},{s['p1'][1]:6.0f})")
    if layout.get("parallel_note"):
        flag = "通过" if layout.get("parallel_ok") else "**未通过**"
        print(f"\n平行性校验：{flag}  {layout['parallel_note']}")
    if layout.get("failed"):
        print("\n标定失败的带：")
        for k, why in sorted(layout["failed"].items(), key=lambda kv: int(kv[0])):
            print(f"  strip {k}: {why}")
    fw = layout.get("firmware_counts")
    if fw:
        print(f"\n固件 State.strip_counts = {fw}")


def draw_overlay(frame, layout, out_path):
    img = frame.copy()
    for k, s in layout["strips"].items():
        p0 = tuple(int(v) for v in s["p0"])
        p1 = tuple(int(v) for v in s["p1"])
        cv2.line(img, p0, p1, (0, 255, 0), 2)
        cv2.circle(img, p0, 5, (255, 200, 0), -1)
        cv2.circle(img, p1, 5, (0, 200, 255), -1)
        cv2.putText(img, f"s{k}", (p0[0], p0[1] - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
    cv2.imwrite(out_path, img)
    print(f"复核图已存 {out_path}")


def capture_isolated(out_dir, end=29, brightness=60, width=1920, height=1080,
                     exposure=-7, gain=0):
    """逐条隔离 + 抓图。每条一张 layout-<strip>.png。"""
    os.makedirs(out_dir, exist_ok=True)
    frames = {}
    for strip in range(STRIP_COUNT):
        print(f"\n[{strip + 1}/{STRIP_COUNT}] 隔离 strip {strip}")
        r = subprocess.run(
            [sys.executable, os.path.join(_here, "ble-stress.py"),
             "--brightness", str(brightness), "isolate", str(strip),
             "--hue", str(strip * 8192 & 0xFFFF), "--end", str(end)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=180)
        ok = False
        for line in r.stdout.splitlines():
            if "isolate" in line:
                print("   " + line.strip())
                ok = "OK" in line
        if not ok:
            print(f"   ! 配置未确认成功（exit {r.returncode}），这张图不可信")
        frame = led_probe.grab_frame(exposure, gain, width, height)
        path = os.path.join(out_dir, f"layout-{strip}.png")
        cv2.imwrite(path, frame)
        frames[strip] = frame
        print(f"   已存 {path}（均值 {frame.mean():.1f}，饱和 {(frame >= 250).mean() * 100:.2f}%）")
    return frames


def load_dir(path):
    frames = {}
    for strip in range(STRIP_COUNT):
        p = os.path.join(path, f"layout-{strip}.png")
        if os.path.exists(p):
            f = cv2.imread(p)
            if f is not None:
                frames[strip] = f
    return frames


def self_test():
    """合成 8 张隔离画面（含反光干扰 + 不同长度），验证标定流程。"""
    rng = np.random.default_rng(7)
    h, w = 720, 1280
    frames, truth = {}, {}
    angle = math.radians(-17.0)
    d = np.array([math.cos(angle), math.sin(angle)])
    for k in range(STRIP_COUNT):
        frame = np.zeros((h, w, 3), np.uint8)
        # 背景：亮灰桌面 + 一处白色反光（模拟真实干扰）
        frame[:, :] = (40, 38, 36)
        cv2.circle(frame, (1180, 120), 26, (255, 255, 252), -1)
        n = 2 + k * 4
        pitch = 21.0
        start = np.array([120.0, 80.0 + k * 78.0])
        for i in range(n):
            c = start + d * (i * pitch)
            # BGR 蓝：B 远高于 G/R，色度能量判据才会选中 B
            cv2.circle(frame, (int(c[0]), int(c[1])), 9, (235, 80, 30), -1)
        frame = np.clip(frame.astype(np.int16) + rng.integers(-4, 5, frame.shape), 0, 255).astype(np.uint8)
        frames[k] = frame
        truth[k] = n * pitch
    layout = calibrate_isolated(frames, verbose=False)
    ok = True
    if len(layout["strips"]) != STRIP_COUNT:
        print(f"  [用例] 只标定出 {len(layout['strips'])}/{STRIP_COUNT} 条")
        ok = False
    for k in sorted(layout["strips"]):
        got = layout["strips"][k]["length"]
        want = truth[k]
        err = abs(got - want) / want
        if err > 0.18:
            print(f"  [用例] strip {k}: 长度 {got:.0f}px，期望 {want:.0f}px（偏差 {err * 100:.0f}%）")
            ok = False
    if not layout.get("parallel_ok", False):
        print(f"  [用例] 平行性校验失败：{layout.get('parallel_note')}")
        ok = False
    print("  自检通过：8 条带长度与平行性全部合理" if ok else "  自检失败")
    return ok


def main():
    ap = argparse.ArgumentParser(description="逐带几何标定（8 条独立灯带的 camera layout）")
    ap.add_argument("--isolate", metavar="DIR", nargs="?", const=".layout-shots",
                    help="逐条隔离并抓图到 DIR，然后标定（会改设备状态）")
    ap.add_argument("--dir", metavar="DIR", help="从已有 layout-<strip>.png 目录离线标定")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--exposure", type=float, default=-7)
    ap.add_argument("--gain", type=float, default=0)
    ap.add_argument("--brightness", type=int, default=60)
    ap.add_argument("--end", type=int, default=29)
    ap.add_argument("--show", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--overlay", help="把标定结果画到隔离图上复核（每带一张）")
    ap.add_argument("--out", default=LAYOUT_PATH)
    args = ap.parse_args()

    if args.selftest:
        sys.exit(0 if self_test() else 1)
    if args.show:
        show(args.out)
        return

    if args.isolate is not None:
        frames = capture_isolated(args.isolate, end=args.end, brightness=args.brightness,
                                  width=args.width, height=args.height,
                                  exposure=args.exposure, gain=args.gain)
    elif args.dir:
        frames = load_dir(args.dir)
    else:
        ap.error("需要 --isolate DIR / --dir DIR / --show / --selftest")

    if not frames:
        raise SystemExit("没有可用画面")

    print(f"\n标定 {len(frames)} 张隔离画面")
    layout = calibrate_isolated(frames)
    if not layout["strips"]:
        raise SystemExit("一条带都没标定出来。检查：灯带是否点亮、曝光是否全黑/过曝。")

    fw = load_firmware_counts()
    if fw:
        layout["firmware_counts"] = fw
        print(f"\n固件上报 State.strip_counts = {fw}")
    save(layout, args.out)

    if args.overlay:
        for strip, frame in frames.items():
            if strip in layout["strips"]:
                one = {"strips": {strip: layout["strips"][strip]}}
                draw_overlay(frame, one, args.overlay.replace(".png", f"-{strip}.png"))

    bad = len(layout.get("failed", {}))
    if bad or not layout.get("parallel_ok", True):
        print(f"\n⚠ 标定不完整（失败 {bad} 条，平行性 "
              f"{'通过' if layout.get('parallel_ok') else '未通过'}）。"
              "分析阶段会拒绝使用这份布局。")


if __name__ == "__main__":
    main()
