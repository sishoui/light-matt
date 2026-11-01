#!/usr/bin/env python
"""错色/断带判定：拿录像对着「布局 + 期望颜色」逐帧核，输出事件表与比率。

**与旧 analyze-board-video.py 的根本区别：不再用「滚动基线偏离」。**

旧方法每格和「它自己过去 90 帧的中位数」比，于是有三个解不掉的毛病：
  1. 需要基线窗口，前 3 秒无法判定；
  2. 无法区分「错色 / 整条断了 / 显示成了别人的颜色」——三者都只表现为
     「和刚才不一样」；
  3. **持续性错色约 1 秒后会被基线吸收成新常态**，之后再也不报。

新方法问的是「这一帧**应该**是什么样」：布局给了每条带的位置，场景给了
每条带该显示的颜色，所以直接比绝对值。没有基线、没有吸收、类型可分。

判定维度（每条带各自独立，取带内色度剖面的中位数）：
  dark     —— 该带应有亮度，实测接近 0（整条熄灭 / WS2812B 锁存残影）
  wrong_hue—— 色相与该带应有值偏离超过阈值（错色）
  crosstalk—— 实测色相更接近**另一条**带的期望值（TDM 串带）
  dim/bright—— 亮度相对期望值偏移过大（掉压 / 白化）

用法（仓库根目录）：

    # 1) 标定布局（相机机位变了必须重跑）
    python scripts/strip-layout.py --isolate .layout-shots

    # 2) 配置画面并录像
    python scripts/ble-stress.py --brightness 60 colorize
    python scripts/record-board.py base.mp4 --seconds 60 --width 640 --height 480

    # 3) 判定
    python scripts/analyze-strips-video.py base.mp4
    python scripts/analyze-strips-video.py stress.mp4 --expect colorize --json out.json
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

_here = os.path.dirname(os.path.abspath(__file__))
LAYOUT_PATH = os.path.join(_here, "..", ".strip-layout.json")
STRIP_COUNT = 8

# 每条带应显示的色相（度）。与 ble-stress.py 的 colorize 一致：第 i 条 = i*45°。
EXPECT_HUE_DEG = {i: (i * 45.0) % 360.0 for i in range(STRIP_COUNT)}

# 「有灯」门限（色度余量图的 p90，0-255 刻度）。低于此视为该带没亮。
LIT_MIN = 18.0
# 色相偏离超过这个角度算错色。45° 一档、相邻差 45°，取 28° 既不会把
# 相邻带误判成串色，又能抓住真正的色相跳变。
HUE_TOL_DEG = 28.0
# 串带判定要求「离另一条带比离自己近这么多」，避免边界误判
CROSSTALK_MARGIN_DEG = 12.0
# 亮度相对期望的容许范围
DIM_RATIO = 0.45
BRIGHT_RATIO = 2.2


def hue_dist(a, b):
    d = abs(float(a) - float(b)) % 360.0
    return min(d, 360.0 - d)


def calibrate_expect(reference_video, layout, frames=60):
    """从一段**已知干净**的录像里实测每条带的参考色相与强度。

    **不能把期望色相写死成「第 i 条 = i*45°」。** 实测两个原因：
      1. mp4 的 4:2:0 色度下采样会让纯红（0°）偏到 22° 左右；
      2. 相机白平衡让整体色相有偏移，且不同位置偏移量不同。
    写死的话干净录像会被判成「整段错色」（实测 400s 旧录像被整段报 wrong_hue）。

    所以参考值必须从一段自己拍的基线里来：这段录像期间画面不变、没有压力，
    它测到的就是「正常是什么样」。判定的问题于是变成「偏离基线多少」，
    但**基线是绝对常量**，不是滚动窗口 —— 所以旧方法「持续错色被基线吸收」
    的问题依然不存在。
    """
    cap = cv2.VideoCapture(reference_video)
    if not cap.isOpened():
        raise SystemExit(f"打不开参考视频：{reference_video}")
    lw, lh = layout["frame_size"]
    fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if fw and fh and (fw, fh) != (lw, lh):
        cap.release()
        raise SystemExit(f"参考视频 {fw}×{fh} 与标定 {lw}×{lh} 不一致")

    hues, strengths = {int(k): [] for k in layout["strips"]}, {int(k): [] for k in layout["strips"]}
    n = 0
    while n < frames:
        ok, frame = cap.read()
        if not ok:
            break
        st = strip_stats(frame, layout)
        for k, v in st.items():
            if not math.isnan(v["hue_deg"]):
                hues[k].append(v["hue_deg"])
            strengths[k].append(v["strength"])
        n += 1
    cap.release()
    if n == 0:
        raise SystemExit("参考视频没有可读帧")

    ref = {}
    for k in hues:
        if not hues[k]:
            continue
        arr = np.asarray(hues[k], np.float64)
        med = circular_median(hues[k])
        # 噪声幅度：各帧色相偏离中位数的 95 分位。容差用它自适应 ——
        # 写死 28° 在某些场景下太松（漏检）、在某些场景下太紧（假事件）。
        dev = np.array([hue_dist(v, med) for v in arr])
        noise = float(np.percentile(dev, 95))
        ref[k] = {
            "hue_deg": med,
            "strength": float(np.median(strengths[k])),
            "noise_deg": noise,
            "samples": len(hues[k]),
        }
    print(f"参考基线取自 {os.path.basename(reference_video)} 的前 {n} 帧：")
    for k in sorted(ref):
        print(f"  strip {k}: hue={ref[k]['hue_deg']:6.1f}°  "
              f"strength={ref[k]['strength']:6.1f}  "
              f"噪声(p95)={ref[k]['noise_deg']:5.1f}°  ({ref[k]['samples']} 帧)")

    # 所有带的参考色相互相接近时，串带判定没有意义（分不清是哪条串到哪条）。
    # 旧场景 8 颗灯全是红色，色相都挤在 341–9°，正是这种情况。
    hues_all = [v["hue_deg"] for v in ref.values()]
    if len(hues_all) >= 2:
        min_sep = min(hue_dist(a, b) for i, a in enumerate(hues_all)
                      for b in hues_all[i + 1:])
        ref_meta = {"min_hue_separation_deg": round(min_sep, 1),
                    "crosstalk_enabled": bool(min_sep >= HUE_TOL_DEG)}
    else:
        ref_meta = {"min_hue_separation_deg": 0.0, "crosstalk_enabled": False}
    if not ref_meta["crosstalk_enabled"]:
        print(f"  注意：各带参考色相最近只差 {ref_meta['min_hue_separation_deg']:.1f}°，"
              f"串带判定已禁用（需 ≥ {HUE_TOL_DEG:.0f}°，否则分不清谁串到谁）")
    return ref, ref_meta


def circular_median(deg_list):
    """色相的圆周中位数（用单位向量平均后取角，避免 0/360 边界问题）。"""
    a = np.radians(np.asarray(deg_list, np.float64))
    s = float(np.sin(a).mean())
    c = float(np.cos(a).mean())
    if abs(s) < 1e-9 and abs(c) < 1e-9:
        return float(np.median(deg_list))
    return float(math.degrees(math.atan2(s, c)) % 360.0)


def load_layout(path=LAYOUT_PATH):
    if not os.path.exists(path):
        raise SystemExit(
            f"没有布局文件 {path}。"
            "先跑：python scripts/strip-layout.py --isolate .layout-shots")
    with open(path, encoding="utf-8") as fh:
        layout = json.load(fh)

    if not layout.get("parallel_ok", True):
        note = layout.get("parallel_note", "?")
        raise SystemExit(
            f"布局不可信（平行性未通过：{note}），拒绝用它判定。\n"
            "8 条带物理上平行；角度散开说明标定抓到了错误的东西。\n"
            "重跑：python scripts/strip-layout.py --isolate .layout-shots")

    # 标定失败的带**逐条降级**，不整份拒绝。
    # 实测最上面那条只有 2 颗灯——两个孤立光点在几何上定不出方向，
    # 任何算法都救不了。把它排除出判定即可，其余各条照常工作。
    failed = layout.get("failed", {})
    strips = layout.get("strips", {})
    if failed:
        print(f"⚠ 有 {len(failed)} 条带无法标定，将从判定中排除：")
        for k, why in sorted(failed.items(), key=lambda kv: int(kv[0])):
            print(f"    strip {k}: {why}")
    if len(strips) < 2:
        raise SystemExit(f"只标定出 {len(strips)} 条带，不足以判定")
    layout = dict(layout)
    layout["judged_strips"] = sorted(int(k) for k in strips)
    return layout


def sample_segment(img32, seg, n=120, normal_offsets=(-2.0, 0.0, 2.0)):
    """沿一条带区间均匀采样，返回每个采样点的色度余量最大响应。"""
    p0 = np.array(seg["p0"], np.float64)
    p1 = np.array(seg["p1"], np.float64)
    v = p1 - p0
    L = float(np.linalg.norm(v))
    if L < 2:
        return None, None
    d = v / L
    nx, ny = -d[1], d[0]
    ts = np.linspace(0.0, L, n)
    best = np.zeros(n, np.float32)
    h, w = img32.shape[:2]
    for off in normal_offsets:
        x = p0[0] + d[0] * ts + nx * off
        y = p0[1] + d[1] * ts + ny * off
        ok = (x >= 0) & (x < w - 1) & (y >= 0) & (y < h - 1)
        xc = np.where(ok, x, 0).astype(np.int32)
        yc = np.where(ok, y, 0).astype(np.int32)
        fx = np.where(ok, x - xc, 0.0).astype(np.float32)
        fy = np.where(ok, y - yc, 0.0).astype(np.float32)
        x1 = np.minimum(xc + 1, w - 1)
        y1 = np.minimum(yc + 1, h - 1)
        val = (img32[yc, xc] * (1 - fx) * (1 - fy) + img32[yc, x1] * fx * (1 - fy)
               + img32[y1, xc] * (1 - fx) * fy + img32[y1, x1] * fx * fy)
        val = np.where(ok, val, 0.0).astype(np.float32)
        np.maximum(best, val, out=best)
    return ts, best


def strip_stats(frame_bgr, layout):
    """一帧 → 每条带的 (strength, hue_deg)。

    **色相只能取灯珠核心。** 早期实现沿整条线段取色相中位数，把光晕边缘也算
    进去了：实测某个灯位的色相在 44.6°↔67.3° 之间来回跳，而灯珠中心稳定在
    178–179。光晕是低饱和过渡色，色相没有物理意义，混进来会让参考基线自己
    就不稳定，最终整段录像被判成异常（实测 47 个假事件）。

    做法：沿线段采 V（亮度），只取最亮的一小撮点（≥p90 且 ≥0.85×max），
    对它们的色相取**圆周**中位数。strength 仍用色度 p90，用于判「有没有灯」。
    """
    img = frame_bgr.astype(np.float32)
    b, g, r = img[:, :, 0], img[:, :, 1], img[:, :, 2]
    chroma = np.maximum.reduce([b, g, r]) - np.minimum.reduce([b, g, r])

    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    H = hsv[:, :, 0].astype(np.float32) * 2.0     # 0-358 度
    V = hsv[:, :, 2].astype(np.float32)

    out = {}
    for k, seg in layout["strips"].items():
        _ts, cprof = sample_segment(chroma, seg)
        if cprof is None:
            continue
        _t, vprof = sample_segment(V, seg, n=200)
        _t2, hprof = sample_segment(H, seg, n=200)
        strength = float(np.percentile(cprof, 90))
        if vprof is None or vprof.size == 0 or float(vprof.max()) < 20:
            hue = float("nan")
        else:
            vmax = float(vprof.max())
            core = vprof >= max(float(np.percentile(vprof, 90)), 0.85 * vmax)
            if core.sum() < 3:
                core = vprof >= 0.85 * vmax
            hue = circular_median(hprof[core]) if core.any() else float("nan")
        out[int(k)] = {"strength": strength, "hue_deg": hue}
    return out


def classify(stats, ref, meta):
    """把一帧的每带统计归成事件。

    ref 是**实测参考**（每带应有的色相、强度、噪声），不是写死的 i*45°。
    容差按每个带自己的实测噪声放大：基线里色相抖动大的带，说明它在画面里
    本来就不好取色，判据应该相应放宽，否则会把噪声报成错色。
    """
    hits = []
    expect_hue = {k: v["hue_deg"] for k, v in ref.items()}
    allow_crosstalk = meta.get("crosstalk_enabled", True)
    for k, r in ref.items():
        st = stats.get(k)
        if st is None:
            continue
        if st["strength"] < max(LIT_MIN, r["strength"] * 0.25):
            hits.append((k, "dark", 0.0))
            continue
        if math.isnan(st["hue_deg"]):
            continue
        d_own = hue_dist(st["hue_deg"], expect_hue[k])
        tol = max(HUE_TOL_DEG, r.get("noise_deg", 0.0) * 2.0 + 8.0)
        if d_own <= tol:
            ratio = st["strength"] / max(r["strength"], 1e-6)
            if ratio < DIM_RATIO:
                hits.append((k, "dim", float(ratio)))
            elif ratio > BRIGHT_RATIO:
                hits.append((k, "bright", float(ratio)))
            continue
        if allow_crosstalk:
            others = [(kk, hue_dist(st["hue_deg"], e))
                      for kk, e in expect_hue.items() if kk != k]
            nearest_other, d_other = min(others, key=lambda kv: kv[1]) if others else (None, 999.0)
            if d_other + CROSSTALK_MARGIN_DEG < d_own:
                hits.append((k, "crosstalk", float(d_other)))
                continue
        hits.append((k, "wrong_hue", float(d_own)))
    return hits


def group_events(flagged, fps, merge_gap_frames):
    events = []
    for idx, hits in flagged:
        if events and idx - events[-1]["end_frame"] <= merge_gap_frames:
            ev = events[-1]
            ev["end_frame"] = idx
            ev["frames"] += 1
            ev["strips"].update(h[0] for h in hits)
            for _k, kind, mag in hits:
                ev["kinds"][kind] = max(ev["kinds"].get(kind, 0.0), mag)
        else:
            events.append({"start_frame": idx, "end_frame": idx, "frames": 1,
                           "strips": {h[0] for h in hits},
                           "kinds": {kind: mag for _k, kind, mag in hits}})
    for ev in events:
        ev["t_start"] = ev["start_frame"] / fps if fps else 0.0
        ev["t_end"] = ev["end_frame"] / fps if fps else 0.0
        ev["strips"] = sorted(ev["strips"])
        ev["kind"] = max(ev["kinds"], key=lambda kk: ev["kinds"][kk]) if ev["kinds"] else "?"
    return events


def analyze(path, layout, ref, meta, max_seconds=None, merge_gap=3, progress=True):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit(f"打不开视频：{path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    limit = int(max_seconds * fps) if (max_seconds and fps) else total

    # 分辨率必须和标定一致：坐标是像素，换了分辨率整套线段都错位，
    # 而且不会报错 —— 这是旧工具最危险的失效方式。
    lw, lh = layout["frame_size"]
    fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if fw and fh and (fw, fh) != (lw, lh):
        cap.release()
        raise SystemExit(
            f"录像分辨率 {fw}×{fh} 与标定 {lw}×{lh} 不一致 —— 坐标会整体错位。\n"
            f"用相同分辨率重新标定：strip-layout.py --isolate ... "
            f"--width {fw} --height {fh}")

    flagged = []
    idx = analyzed = 0
    while idx < limit:
        ok, frame = cap.read()
        if not ok:
            break
        stats = strip_stats(frame, layout)
        hits = classify(stats, ref, meta)
        if hits:
            flagged.append((idx, hits))
        analyzed += 1
        idx += 1
        if progress and analyzed % 900 == 0:
            print(f"  …{analyzed} 帧（{idx / fps:.0f}s）", flush=True)
    cap.release()

    events = group_events(flagged, fps, merge_gap)
    duration = analyzed / fps if fps else 0.0
    per_10min = len(events) / duration * 600 if duration > 0 else 0.0
    kinds = {}
    for ev in events:
        kinds[ev["kind"]] = kinds.get(ev["kind"], 0) + 1
    return {"video": os.path.basename(path), "fps": round(fps, 3),
            "reference": {str(k): {"hue_deg": round(v["hue_deg"], 1),
                                   "strength": round(v["strength"], 1),
                                   "noise_deg": round(v.get("noise_deg", 0.0), 1)}
                          for k, v in ref.items()},
            "reference_meta": meta,
            "frames": analyzed, "duration_s": round(duration, 1),
            "events": events, "event_count": len(events),
            "per_10min": round(per_10min, 2), "kinds": kinds}


def print_report(res, threshold=1.0):
    print(f"\n视频      {res['video']}")
    print(f"时长      {res['duration_s']:.0f}s（{res['frames']} 帧 @ {res['fps']:.2f}fps）")
    print(f"事件数    {res['event_count']}")
    if res["kinds"]:
        print("事件类型  " + ", ".join(f"{k}={v}" for k, v in sorted(res["kinds"].items())))
    print(f"折算      {res['per_10min']:.2f} 次/10 分钟")
    if res["events"]:
        print("\n事件明细：")
        for ev in res["events"]:
            detail = ", ".join(f"{k}={v:.1f}" for k, v in ev["kinds"].items())
            print(f"  t={ev['t_start']:7.2f}s  持续 {ev['frames']:3d} 帧  "
                  f"带={ev['strips']}  {ev['kind']} ({detail})")
    verdict = "通过" if res["per_10min"] <= threshold else "未通过"
    print(f"\n判据（≤ {threshold:.0f} 次/10 分钟）：{verdict}")
    print("注意：相机帧率高时同一固件异常会被记成多帧；看 events 而不是帧数。")


def _make_synthetic(path, layout, frames=120, fps=10, inject=None):
    """按布局合成一段录像。

    inject = {帧号: [(值, 带号)]}，值是色相（度）或字符串 "off"。
    容器用 FFV1（无损）：mp4v 的 4:2:0 会把纯红色相从 0° 压到 70°，
    自检会把编码伪影当成判定失败。
    """
    lw, lh = layout["frame_size"]
    fourcc = cv2.VideoWriter_fourcc(*"FFV1")
    writer = cv2.VideoWriter(path, fourcc, fps, (lw, lh))
    if not writer.isOpened():
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"MJPG"), fps, (lw, lh))
    if not writer.isOpened():
        raise SystemExit(f"打不开输出 {path}（需要 FFV1 或 MJPG 编码器）")

    def color_for(hue_deg):
        bgr = cv2.cvtColor(np.uint8([[[hue_deg / 2.0, 160, 200]]]), cv2.COLOR_HSV2BGR)[0, 0]
        return tuple(int(v) for v in bgr)

    for i in range(frames):
        img = np.zeros((lh, lw, 3), np.uint8)
        overrides = {}
        if inject and i in inject:
            for val, sid in inject[i]:
                overrides[int(sid)] = val
        for k, seg in layout["strips"].items():
            sid = int(k)
            val = overrides.get(sid)
            if val == "off":
                continue
            hue = EXPECT_HUE_DEG[sid] if val is None else val
            cv2.line(img, tuple(int(v) for v in seg["p0"]),
                     tuple(int(v) for v in seg["p1"]), color_for(hue), 7)
        writer.write(img)
    writer.release()


def synthetic_layout(w=1280, h=720):
    """自检用的合成布局：8 条平行带，长度各异（模拟真实硬件）。

    自检不应该依赖真机标定产物 —— 那样在没有标定的机器上就跑不了，
    而标定恰恰是最容易卡住的一步。
    """
    angle = math.radians(-17.0)
    d = (math.cos(angle), math.sin(angle))
    spans = [42, 126, 210, 294, 378, 462, 546, 630]   # 2,6,10,…,30 颗 × 21px
    strips = {}
    for k in range(STRIP_COUNT):
        x0, y0 = 120.0, 70.0 + k * 78.0
        L = float(spans[k])
        strips[str(k)] = {
            "p0": [round(x0, 1), round(y0, 1)],
            "p1": [round(x0 + d[0] * L, 1), round(y0 + d[1] * L, 1)],
            "dir": [round(d[0], 5), round(d[1], 5)],
            "angle_deg": round(math.degrees(angle), 2),
            "length": L, "px": 5000, "strip": k,
        }
    return {"frame_size": [w, h], "strips": strips, "failed": {},
            "parallel_ok": True, "method": "synthetic"}


def selftest(layout):
    """验证判定逻辑：干净录像 0 事件；单条断带与单条错色各抓 1 次。

    **合成录像必须用无损编码。** 一开始用 mp4v（4:2:0 色度下采样），
    纯红（色相 0°）在压缩后色相会跳到 70°/18°，干净画面被误判成 crosstalk。
    那是编码伪影，不是判定逻辑的问题 —— 但它会让自检本身失去意义。
    这里改用 FFV1（无损），把「判定逻辑」和「压缩伪影」彻底分开。
    """
    import tempfile
    tmp = tempfile.gettempdir()

    def make(name, **kw):
        path = os.path.join(tmp, name)
        _make_synthetic(path, layout, **kw)
        return path

    clean = make("strip-clean.avi")
    # 和真实使用一致：先从干净录像取参考基线，再用它判有异常的录像
    ref, meta = calibrate_expect(clean, layout, frames=30)
    r1 = analyze(clean, layout, ref, meta, progress=False)
    ok1 = r1["event_count"] == 0
    print(f"[用例 1] 干净录像（自身作参考）：检出 {r1['event_count']} 次（应为 0）"
          f"{'  ✓' if ok1 else '  ✗ ' + str(r1['kinds'])}")

    target = sorted(int(k) for k in layout["strips"])[3]
    broken = make("strip-dark.avi", inject={60: [("off", target)]})
    r2 = analyze(broken, layout, ref, meta, progress=False)
    hit2 = r2["event_count"] == 1 and target in r2["events"][0]["strips"]         and r2["events"][0]["kind"] == "dark"
    print(f"[用例 2] 第 60 帧 strip {target} 熄灭：检出 {r2['event_count']} 次"
          f"{'  ✓ ' + str(r2['events'][0]['strips']) if hit2 else '  ✗ 漏检/误检 ' + str(r2['events'])}")

    target2 = sorted(int(k) for k in layout["strips"])[1]
    wrong_hue = (ref[target2]["hue_deg"] + 180.0) % 360.0
    wrong = make("strip-hue.avi", inject={60: [(wrong_hue, target2)]})
    r3 = analyze(wrong, layout, ref, meta, progress=False)
    hit3 = r3["event_count"] == 1 and target2 in r3["events"][0]["strips"] \
        and r3["events"][0]["kind"] in ("wrong_hue", "crosstalk")
    print(f"[用例 3] 第 60 帧 strip {target2} 色相翻转 180°：检出 {r3['event_count']} 次"
          f"{'  ✓ ' + r3['events'][0]['kind'] if hit3 else '  ✗ 漏检/误检 ' + str(r3['events'])}")

    for p in (clean, broken, wrong):
        try:
            os.remove(p)
        except OSError:
            pass
    if not (ok1 and hit2 and hit3):
        sys.exit("自检失败")
    print("\n自检通过")


def main():
    ap = argparse.ArgumentParser(description="错色/断带判定（绝对参考，不用基线）")
    ap.add_argument("video", nargs="?")
    ap.add_argument("--layout", default=LAYOUT_PATH)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--reference", metavar="VIDEO",
                    help="干净基线录像（必须与待测录像同机位、同曝光、同画面）。"
                         "不给则用待测录像自己的前 N 帧，那只在「前面确实干净」时可用。")
    ap.add_argument("--reference-frames", type=int, default=120)
    ap.add_argument("--max-seconds", type=float)
    ap.add_argument("--merge-gap", type=int, default=3,
                    help="间隔不超过此帧数视为同一事件")
    ap.add_argument("--json")
    ap.add_argument("--threshold", type=float, default=1.0,
                    help="判据：次/10 分钟上限")
    args = ap.parse_args()

    if args.selftest:
        # 自检用内置合成布局：不依赖真机标定产物，任何机器上都能跑
        selftest(synthetic_layout())
        return
    if not args.video:
        ap.error("需要录像路径（或用 --selftest）")

    layout = load_layout(args.layout)
    if args.reference:
        ref_src = args.reference
        print(f"参考基线：{ref_src}")
    else:
        ref_src = args.video
        print("⚠ 没给 --reference，用待测录像自己的前若干帧当基线。")
        print("  只有在你确定这段开头是干净的时候才可靠（例如压力段前一直没写 BLE）。")
    ref, meta = calibrate_expect(ref_src, layout, frames=args.reference_frames)

    res = analyze(args.video, layout, ref, meta, max_seconds=args.max_seconds,
                  merge_gap=args.merge_gap)
    print_report(res, args.threshold)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(res, fh, indent=2, ensure_ascii=False)
        print(f"明细已写入 {args.json}")


if __name__ == "__main__":
    main()
