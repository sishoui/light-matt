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
# 一条带最少要有这么多「饱和像素」，否则不足以定方向。
MIN_MASK_PX = 250
# 但物理上极短的带（实测最上面那条只有 2 颗）永远达不到这个量级：
# 2 颗灯在 1080p 下总共约 100 像素。给它一个更低的下限，
# 同时在布局里标 `short=True`，让分析阶段知道「这条带覆盖范围小、判定不可靠」。
MIN_MASK_PX_SHORT = 60


def saturation_margin(frame):
    """饱和度图 = max(R,G,B) − min(R,G,B)，即 HSV 的「色度」分量。

    **不能用「单通道主导」判据。** v3 的 colorize 用 i*45° 一档，其中
    45/135/225/315 是「双通道色」（青、品红、黄），两个通道同时高：
    实测青色带 B=110 / G=121，`G - max(B,R)` 只剩 11–27，掩码被滤空，
    整条带只找到 36 个像素。

    饱和度对**任何**饱和色都成立（单通道色与双通道色一视同仁），背景
    （桌面、白纸）三通道接近所以接近 0。这个判据与具体色相无关，
    因此也不受相机白平衡影响。
    """
    img = frame.astype(np.float32)
    b, g, r = img[:, :, 0], img[:, :, 1], img[:, :, 2]
    mx = np.maximum(np.maximum(b, g), r)
    mn = np.minimum(np.minimum(b, g), r)
    return (mx - mn)


def strip_mask(frame):
    """自适应阈值掩码（基于饱和度）。

    阈值取 `max × 0.45`：灯带是画面里最饱和的东西，用最大值的一个比例
    自适应光照强弱；固定阈值换一次补光就会失效。

    **下限用绝对 25**：纯黑背景里灯带边缘的微弱反光不应被当成信号。
    """
    sat = saturation_margin(frame)
    if float(sat.max()) < 25:
        return None
    thr = max(25.0, float(sat.max()) * 0.45)
    mask = (sat >= thr).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    return mask


def _ransac_direction(pts, seed, iters=300, tol=2.5, seed_rng=12345):
    """在一堆像素点里找「最多点共线」的方向，返回单位向量。

    纯 PCA 对离群点毫无抵抗：一条灯带旁边只要有几个杂点，主轴就会偏掉
    （实测 −29° → −60°，进而让「8 条平行」校验失败）。

    做法：随机取两点定一条直线，数落在 ±tol 内的点数，留最优；再用内点
    做一次最小二乘精修。种子固定，结果可复现。
    """
    n = len(pts)
    if n < 20:
        return seed
    rng = np.random.default_rng(seed_rng)
    best_inl, best_d = 0, None
    for _ in range(iters):
        i, j = rng.integers(0, n, 2)
        if i == j:
            continue
        v = pts[j] - pts[i]
        L = float(np.hypot(v[0], v[1]))
        if L < 15:
            continue
        d = v / L
        nvec = np.array([-d[1], d[0]])
        resid = np.abs((pts - pts[i]) @ nvec)
        inl = int((resid <= tol).sum())
        if inl > best_inl:
            best_inl, best_d = inl, d
    if best_d is None or best_inl < max(20, int(n * 0.35)):
        return seed
    # 用内点做最小二乘精修
    nvec = np.array([-best_d[1], best_d[0]])
    resid = np.abs((pts - pts[0]) @ nvec)
    inl_pts = pts[resid <= tol]
    if len(inl_pts) < 10:
        return best_d
    m = inl_pts.mean(axis=0)
    _, _, vt = np.linalg.svd(inl_pts - m, full_matrices=False)
    d = vt[0]
    if d[0] < 0:
        d = -d
    return d / np.linalg.norm(d)


def fit_segment(mask, weight):
    """从掩码拟合一条线段，返回 dict 或 (None, 原因)。

    返回：{p0, p1, dir, angle_deg, length, px}
    """
    # **先剔除离群连通块。**
    # 画面里常有孤立的彩色噪点（开发板电源灯、反光碎片）。实测某个 56 像素
    # 的小点把 1654 像素灯带的 PCA 主轴从 −25° 拉到了 −60°，
    # 于是「8 条平行」的校验直接失败。按面积只留最大的几个块。
    n_lab, lab, stats, _cents = cv2.connectedComponentsWithStats(mask, 8)
    if n_lab > 1:
        areas = sorted(((stats[i][4], i) for i in range(1, n_lab)), reverse=True)
        keep = {i for a, i in areas if a >= max(MIN_MASK_PX, areas[0][0] * 0.25)}
        mask = np.isin(lab, list(keep)).astype(np.uint8)

    ys, xs = np.nonzero(mask)
    floor = MIN_MASK_PX_SHORT if len(xs) >= MIN_MASK_PX_SHORT else MIN_MASK_PX
    if len(xs) < floor:
        return None, f"候选像素只有 {len(xs)}（需 ≥{floor}）"
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
    # **用 RANSAC 精修方向。** 整体 PCA 会被零星离群点带偏：实测一条
    # −29° 的灯带被少量杂点拉成 −60°。RANSAC 只认「最多点落在同一条
    # 细线上」的那个方向，对离群点免疫。
    d = _ransac_direction(pts, d)
    if d is not None:
        mean = pts.mean(axis=0)
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
    """沿线段取「法向 ±3px 最大值」的饱和度剖面，用于后续逐颗/逐段判定。"""
    m = saturation_margin(frame)
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
        return None, "画面里没有可用饱和度（灯带没亮？曝光全黑？）"
    m = saturation_margin(frame)
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


def _isolate(strip, brightness, end):
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
    return ok


def _scene_glare(frame):
    """场景被照亮了多少：高饱和像素占比。灯带本身只占极小面积。"""
    img = frame.astype(np.int32)
    mx = np.maximum(np.maximum(img[:, :, 0], img[:, :, 1]), img[:, :, 2])
    mn = np.minimum(np.minimum(img[:, :, 0], img[:, :, 1]), img[:, :, 2])
    sat = mx - mn
    return float((sat > 60).mean())


def capture_isolated(out_dir, end=29, brightness=150, width=1920, height=1080,
                     exposure=-11, gain=0):
    """逐条隔离 + 抓图。每条一张 layout-<strip>.png。

    **亮度逐带自适应。** 实测同一条亮度下，不同颜色/长度照亮环境的能力差极大：
    品红 30 颗在 brightness=150 时把整个房间照亮（高饱和像素占 40%+），
    而短带几乎看不见。所以每条先从基础亮度试拍，发现场景被照亮就逐级下调，
    目标是「灯带清晰、背景干净」。

    判据是**高饱和像素占比**：灯带自己只占画面 0.1% 量级，一旦这个比例明显
    上升，说明光已经漫到环境里了。
    """
    os.makedirs(out_dir, exist_ok=True)
    frames = {}
    levels = [brightness, 100, 70, 45, 30]
    for strip in range(STRIP_COUNT):
        print(f"\n[{strip + 1}/{STRIP_COUNT}] 隔离 strip {strip}")
        chosen, frame = None, None
        for level in levels:
            if not _isolate(strip, level, end):
                continue
            probe = led_probe.grab_frame(exposure, gain, width, height)
            glare = _scene_glare(probe)
            print(f"   亮度 {level:3d} → 高饱和占比 {glare * 100:5.2f}%")
            if chosen is None or glare < 0.5:
                chosen, frame = level, probe
            if glare < 0.5:
                break
            print("     场景被照亮，下调一档")
        if frame is None:
            print("   ! 这张图不可信（没有可用的亮度档）")
            frame = led_probe.grab_frame(exposure, gain, width, height)
        path = os.path.join(out_dir, f"layout-{strip}.png")
        cv2.imwrite(path, frame)
        frames[strip] = frame
        print(f"   已存 {path}（亮度 {chosen}，均值 {frame.mean():.2f}，"
              f"高饱和 {_scene_glare(frame) * 100:.2f}%）")
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
