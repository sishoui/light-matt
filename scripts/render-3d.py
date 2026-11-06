#!/usr/bin/env python
"""把模拟器的逐颗色值画成 3D 效果图（自发光，无光照模型）。

## 两个来源，分得很清楚

**色值**：来自 `lumen_sim`，也就是固件真实的渲染链
（`effects.c` → `segment_store.c` → `gamma.c` → `led_render.c`）。逐颗精确，
不是插值也不是猜测。

**几何**：**名义排布**，不是实测。8 条带假设为彼此平行、等间距、沿 Z 轴
排开的一排直线（`--layout rows`），或围成一个圆环（`--layout ring`）。
真实几何（`.strip-layout.json`）只有 2D 像素坐标、没有深度，而且那台相机
根本拍不到灯带本体，所以这里不拿它冒充 3D 位置。

> 换句话说：**灯珠的亮度与色值是真的，它们在空间里怎么摆是假设的。**
> 图上会把这个假设写在角标里，不允许看的人误以为是实拍。

## 为什么不做光照模型

灯珠是**自发光**的。给它加漫反射 / 高光会把「固件输出这个色值」变成
「这个色值在这种光照下大概长这样」——那是新的不确定性。所以这里只做：

  1. 透视投影（让平行的带看起来有纵深）；
  2. 加法混合的辉光（模拟灯珠在空气中的溢光，物理上也只是近似；
     但它是**加法**的，不会把暗处的颜色洗掉）。

用法：
    python scripts/render-3d.py                            # 用当前设备配置
    python scripts/render-3d.py --layout ring              # 换成环形排布
    python scripts/render-3d.py --rainbow-level 5 --comet-level 10
    python scripts/render-3d.py --frames 8 --animate        # 出多帧
"""

import argparse
import math
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, ".sim-out")

sys.path.insert(0, HERE)
import importlib.util

_spec = importlib.util.spec_from_file_location("simlib", os.path.join(HERE, "simulate-strips.py"))
simlib = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(simlib)

STATIC, BREATHING, RAINBOW, COMET = 0, 1, 2, 3
BLEND_OVER, BLEND_LUMA = 0, 3


# ---------------------------------------------------------------- 几何

def layout_rows(strip_count, led_count):
    """名义排布：8 条平行直线，沿 X 展开、沿 Z 拉开纵深。

    返回 [(x, y, z) × led_count] × strip_count，单位是「灯珠间距 = 1」。
    """
    out = []
    for s in range(strip_count):
        line = []
        for i in range(led_count):
            x = (i - (led_count - 1) / 2.0) * 1.0
            y = 0.0
            z = s * 1.35
            line.append((x, y, z))
        out.append(line)
    return out


def layout_ring(strip_count, led_count):
    """名义排布：8 条带组成一个圆环，每条沿切线方向。

    只是给「环形模型」这种用法一个直观视图；同样是假设，不是实测。
    """
    out = []
    radius = max(6.0, led_count * 0.55)
    for s in range(strip_count):
        ang = (s / strip_count) * 2 * math.pi
        cx, cy = radius * math.cos(ang), radius * math.sin(ang)
        # 切向
        tx, ty = -math.sin(ang), math.cos(ang)
        line = []
        for i in range(led_count):
            t = (i - (led_count - 1) / 2.0) * 0.9
            line.append((cx + tx * t, 0.0, cy + ty * t))
        out.append(line)
    return out


LAYOUTS = {"rows": layout_rows, "ring": layout_ring}


# ---------------------------------------------------------------- 渲染

def project(points, cam, width, height, fov_scale):
    """透视投影。points: Nx3 → 屏幕坐标 + 深度。"""
    eye = np.array(cam["eye"], dtype=np.float64)
    target = np.array(cam["target"], dtype=np.float64)
    up = np.array([0.0, 1.0, 0.0])

    forward = target - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, up)
    right /= np.linalg.norm(right)
    upv = np.cross(right, forward)

    rel = points - eye
    # 相机空间
    cx = rel @ right
    cy = rel @ upv
    cz = rel @ forward

    z = np.maximum(cz, 1e-3)
    f = fov_scale * height
    sx = width / 2.0 + (cx / z) * f
    sy = height / 2.0 - (cy / z) * f
    return sx, sy, cz


def scene_peak(strip_pixels):
    """这一帧里最亮的那个通道（0-255）。

    曝光要按**画面里最亮的灯**定，而不是按 255 定——真机在暗房里看灯，
    眼睛与相机会为暗场景放大进光量，所以 5% 亮度的灯依然清晰可辨。
    按 255 归一化会让低亮度场景整片糊黑（第一版就是这个错）。
    """
    peak = 0.0
    for line in strip_pixels:
        for r, g, b in line:
            m = max(r, g, b)
            if m > peak:
                peak = float(m)
    return peak


def render_frame(strip_pixels, geom, cam, width, height, glow=0.55, dot_scale=0.34):
    """单帧渲染：每个灯珠画一个加法混合的圆形光斑。

    ## 曝光适应（exposure adaptation）

    真机的观感取决于**画面里最亮的灯**：暗场景下眼睛/相机会提高增益，
    所以 5% 亮度的彩虹依然清晰。这里按 `scene_peak` 把最亮通道映射到接近
    满值，模拟这件事。

    `cam["exposure_target"]` 是最亮灯珠要落到哪个亮度（0-1）。不设上限地
    提高增益会让极暗场景（例如只有单颗 10% 的流星、背景全黑）噪点遍地，
    所以增益限幅在 `cam["max_gain"]`。
    """
    img = np.zeros((height, width, 3), dtype=np.float32)
    yy, xx = np.mgrid[0:height, 0:width]

    peak = scene_peak(strip_pixels)
    target = cam.get("exposure_target", 0.92)
    max_gain = cam.get("max_gain", 14.0)
    if peak <= 0.5:
        gain = 1.0
    else:
        gain = min(max_gain, target / (peak / 255.0))
    # 线性空间里的增益：sRGB 的 1/gamma 次级效应已经包含在下面的反 gamma 里
    gain_lin = gain ** 2.2

    for strip_idx, line in enumerate(geom):
        pixels = strip_pixels[strip_idx]
        pts = np.array(line[: len(pixels)], dtype=np.float64)
        sx, sy, cz = project(pts, cam, width, height, cam["fov"])

        # 透视缩放：越远越小
        base_r = cam["dot_px"] * dot_scale
        radii = base_r * np.clip(cam["eye"][2] / np.maximum(cz, 0.5), 0.35, 2.4)

        # 远 → 近绘制，近的覆盖在上（加法混合下顺序只影响饱和）
        order = np.argsort(-cz)
        for idx in order:
            r, g, b = pixels[idx]
            if r == 0 and g == 0 and b == 0:
                continue
            # 固件输出是用户空间的 sRGB 近似；转回线性再加法混合，
            # 否则多个光斑叠加会过早饱和成白色。曝光增益在这里施加。
            lr, lg, lb = [(v / 255.0) ** 2.2 * gain_lin for v in (r, g, b)]
            rad = float(radii[idx])
            x0 = int(max(0, sx[idx] - rad * 3))
            x1 = int(min(width, sx[idx] + rad * 3 + 1))
            y0 = int(max(0, sy[idx] - rad * 3))
            y1 = int(min(height, sy[idx] + rad * 3 + 1))
            if x0 >= x1 or y0 >= y1:
                continue
            sub_x = xx[y0:y1, x0:x1].astype(np.float32) - sx[idx]
            sub_y = yy[y0:y1, x0:x1].astype(np.float32) - sy[idx]
            d2 = sub_x * sub_x + sub_y * sub_y
            # 核心：实心圆 + 柔边；辉光：指数衰减
            core = np.clip(1.0 - (np.sqrt(d2) / max(rad, 0.5)), 0.0, 1.0) ** 0.42
            halo = np.exp(-d2 / (2 * (rad * 1.45) ** 2)) * glow
            w = (core + halo).astype(np.float32)
            tile = img[y0:y1, x0:x1]
            tile[..., 0] += lr * w
            tile[..., 1] += lg * w
            tile[..., 2] += lb * w

    # 线性 → sRGB，再截断
    out = np.clip(img, 0.0, 1.0) ** (1 / 2.2)
    out = (out * 255.0).clip(0, 255).astype(np.uint8)
    return out[:, :, ::-1]  # RGB → BGR（cv2 存盘用）


def add_caption(img, text, sub=None):
    """左上角角标：把「几何是假设」写清楚。"""
    out = img.copy()
    bar_h = 54 if sub else 32
    overlay = out[0:bar_h, 0 : min(out.shape[1], 760)].copy()
    overlay[:] = (overlay * 0.25).astype(np.uint8)
    out[0:bar_h, 0 : overlay.shape[1]] = overlay
    cv2.putText(out, text, (14, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.52,
                (235, 235, 235), 1, cv2.LINE_AA)
    if sub:
        cv2.putText(out, sub, (14, 44), cv2.FONT_HERSHEY_SIMPLEX, 0.40,
                    (150, 195, 235), 1, cv2.LINE_AA)
    return out


# ---------------------------------------------------------------- 场景

def build_scenario(rainbow_level, comet_level, rainbow_period, comet_period, tail,
                   brightness, led_count, strip_count, samples, blend):
    rainbow = simlib.layer(RAINBOW, hue=0, sat=255, period=rainbow_period, p5=255,
                           level=rainbow_level)
    comet = simlib.layer(COMET, hue=0, sat=0, period=comet_period, p5=tail, level=comet_level)
    segs = [
        simlib.segment(s, 0, 0, led_count - 1, rainbow, comet, blend=blend)
        for s in range(strip_count)
    ]
    sc = simlib.scenario("3d", segs, samples=samples)
    sc["led_count"] = [led_count] * strip_count
    sc["strip_count"] = strip_count
    sc["brightness"] = brightness
    return sc


def main():
    ap = argparse.ArgumentParser(description="逐颗色值的 3D 自发光效果图")
    ap.add_argument("--layout", choices=sorted(LAYOUTS), default="rows")
    ap.add_argument("--rainbow-level", type=int, default=5, help="背景彩虹层亮度 0-100（默认对准当前设备）")
    ap.add_argument("--comet-level", type=int, default=10, help="流星层亮度 0-100（默认对准当前设备）")
    ap.add_argument("--rainbow-period", type=int, default=3000)
    ap.add_argument("--comet-period", type=int, default=2000)
    ap.add_argument("--tail", type=int, default=140)
    ap.add_argument("--brightness", type=int, default=200)
    ap.add_argument("--led-count", type=int, default=30)
    ap.add_argument("--strips", type=int, default=8)
    ap.add_argument("--blend", type=int, default=BLEND_LUMA, help="0=覆盖 3=按亮度叠加")
    ap.add_argument("--frames", type=int, default=8, help="采样帧数（流星走一趟）")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=760)
    ap.add_argument("--elev", type=float, default=26.0, help="相机仰角（度）")
    ap.add_argument("--azim", type=float, default=-18.0, help="相机方位角（度）")
    ap.add_argument("--dist", type=float, default=38.0)
    ap.add_argument("--exposure-target", type=float, default=0.92,
                    help="最亮灯珠映射到的亮度 0-1（模拟暗场景曝光适应）")
    ap.add_argument("--max-gain", type=float, default=14.0,
                    help="曝光增益上限；太小则暗场景仍暗，太大则噪点遍地")
    ap.add_argument("--name", default=None)
    args = ap.parse_args()

    simlib.build_simulator()

    samples = [int(i * args.comet_period / args.frames) for i in range(args.frames)]
    sc = build_scenario(args.rainbow_level, args.comet_level, args.rainbow_period,
                        args.comet_period, args.tail, args.brightness,
                        args.led_count, args.strips, samples, args.blend)
    res = simlib.run_scenario(sc)

    geom = LAYOUTS[args.layout](args.strips, args.led_count)

    # 相机围绕名义几何的中心
    all_pts = np.array([p for line in geom for p in line])
    center = all_pts.mean(axis=0)
    elev, azim = math.radians(args.elev), math.radians(args.azim)
    eye = center + np.array([
        args.dist * math.cos(elev) * math.sin(azim),
        args.dist * math.sin(elev),
        args.dist * math.cos(elev) * math.cos(azim),
    ])
    cam = {"eye": tuple(eye), "target": tuple(center), "fov": 1.35,
           "dot_px": args.width / 46.0,
           "exposure_target": args.exposure_target,
           "max_gain": args.max_gain}

    os.makedirs(OUT, exist_ok=True)
    stem = args.name or f"3d-{args.layout}-r{args.rainbow_level}-c{args.comet_level}"
    written = []

    for k, frame in enumerate(res["frames"]):
        img = render_frame(frame["strips"], geom, cam, args.width, args.height)
        peak = scene_peak(frame["strips"])
        gain = 1.0 if peak <= 0.5 else min(args.max_gain, args.exposure_target / (peak / 255.0))
        cap = add_caption(
            img,
            f"{frame['t_ms']} ms   彩虹 {args.rainbow_level}% + 流星 {args.comet_level}%   "
            f"（最亮 {peak:.0f}/255 · 曝光 ×{gain:.1f}）",
            "色值来自固件真实渲染 • 灯带排布是名义假设（非实测几何）",
        )
        path = os.path.join(OUT, f"{stem}-f{k:02d}.png")
        simlib._write_png(path, cap)
        written.append(path)

    # 拼一张时间线（每帧缩略，纵向堆叠）
    if len(written) >= 2:
        thumbs = []
        step = max(1, len(written) // 6)
        for k in range(0, len(written), step):
            im = cv2.imdecode(np.fromfile(written[k], dtype=np.uint8), cv2.IMREAD_COLOR)
            if im is None:
                continue
            h = args.height // 3
            w = int(im.shape[1] * h / im.shape[0])
            thumbs.append(cv2.resize(im, (w, h), interpolation=cv2.INTER_AREA))
        if thumbs:
            gap = 8
            sheet = np.zeros((sum(t.shape[0] for t in thumbs) + gap * (len(thumbs) - 1),
                              max(t.shape[1] for t in thumbs), 3), dtype=np.uint8)
            y = 0
            for t in thumbs:
                sheet[y : y + t.shape[0], : t.shape[1]] = t
                y += t.shape[0] + gap
            tl_path = os.path.join(OUT, f"{stem}-timeline.png")
            simlib._write_png(tl_path, sheet)
            written.append(tl_path)

    for p in written:
        print(p)

    # 把第一帧的逐颗色值也打出来，方便对账
    f0 = res["frames"][0]["strips"][0]
    print("\nstrip 0 前 10 颗（固件真实输出）：")
    for i, (r, g, b) in enumerate(f0[:10]):
        print(f"  [{i:2d}] ({r:3d},{g:3d},{b:3d})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
