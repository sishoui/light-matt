#!/usr/bin/env python
"""#20 辅助工具：标定 8×8 灯板，并测量每格色度。

为什么单独一个脚本：opencv 和 bleak 不能同进程（opencv 把线程设成 Windows GUI，
之后 bleak 报 "Thread is configured for Windows GUI"）。配置画面用 ble-stress.py，
取帧 / 标定 / 测量用本脚本。

**标定为什么两步**：灯板在画面里是斜的（约 -25°）且带透视，轴对齐的
`--grid` 切不出正确格子。但直接做透视矫正也定不准 —— 用基板外缘会被红色
溢光带偏，用 8 颗对角灯只能定出一条对角线（缺另一条边的方向）。
真正稳的参照是 **64 个白色丝印灯座**：每格一个、位置固定、不随灯亮灭变化。

所以流程是：
  1) 点亮四个角（LED 0/7/56/63）→ 这四个点是真实的格心，给出粗矫正；
  2) 粗矫正图上丝印灯座变成整齐的 8×8 → 用 64 个质心做最小二乘拟合，
     得到精确的单应矩阵。
相机不动时，第 2 步的矩阵一直有效；挪过相机必须重跑。

用法（仓库根目录）：

    # 先点亮四角（另一个进程，因为 bleak 不能和 opencv 同进程）
    python scripts/ble-stress.py setup --strip 6 --brightness 12 --leds-list 0,7,56,63
    python scripts/led-probe.py calibrate corner.png

    # 之后任意画面都能测
    python scripts/led-probe.py capture shot.png
    python scripts/led-probe.py measure shot.png
"""

import argparse
import json
import math
import os
import sys
import time

import numpy as np

try:
    import cv2
except ImportError:
    sys.exit("需要 opencv-python：python -m pip install opencv-python")

# 相机参数。**必须 DirectShow + YUY2（不设 FOURCC）**：
#   - MSMF：EXPOSURE/GAIN 的 set 返回 True 但读回恒为 -5/0，自动曝光一直开着；
#   - DSHOW + MJPG：完全忽略曝光设置且强制自动曝光（读回 AE 恒 -1，改不动），
#     实测自动曝光在灯板画面下以 ~0.3s 周期振荡（R 在 181↔239 跳），
#     逐帧比对会被它毁掉；
#   - DSHOW + YUY2：能真正锁住手动曝光（读回与设定一致，G 通道 p2p 0.01）。
# 代价是 USB 带宽：1080p 只有 ~3fps。这个帧率是刻意接受的 —— 20Hz 刷新的
# 错色通常持续多个刷新周期，3fps 仍能采样到持续性错色（瞬时单帧错色会漏，
# 这点已写进 docs/animation-baseline.md §7.8）。
BACKEND = cv2.CAP_DSHOW
FRAME_W = 1920
FRAME_H = 1080
EXPOSURE = -8      # 亮度 12 时 R≈220、不饱和，G 还有充足余量
GAIN = 0
WARMUP_S = 1.5
GRAB_FRAMES = 30

BOARD_PX = 800          # 矫正后方图边长 → 每格 100px
CALIB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "..", ".board-homography.json")

# 四角灯在 **1920×1080** 画面里的参考坐标（本轮实测）。
# 现在优先用 `detect_corner_leds` 自动找；这组值只是自动检测失败时的退路。
CORNER_HINT = {
    0: (752, 538),
    7: (900, 472),
    56: (812, 700),
    63: (982, 621),
}


def open_camera(exposure=EXPOSURE, gain=GAIN, width=FRAME_W, height=FRAME_H):
    cap = cv2.VideoCapture(0, BACKEND)
    if not cap.isOpened():
        raise SystemExit("打不开相机 0")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    # 刻意不设 FOURCC：设成 MJPG 会让曝光设置失效并强制自动曝光
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
    cap.set(cv2.CAP_PROP_EXPOSURE, exposure)
    cap.set(cv2.CAP_PROP_GAIN, gain)
    time.sleep(WARMUP_S)
    for _ in range(GRAB_FRAMES):
        cap.grab()
    return cap


def grab_frame(exposure=EXPOSURE, gain=GAIN, width=None, height=None):
    cap = open_camera(exposure, gain,
                      width or FRAME_W, height or FRAME_H)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise SystemExit("取帧失败")
    return frame


def detect_corner_leds(frame, region=None):
    """找「只点亮四角」时的四个亮点，返回 {0:.., 7:.., 56:.., 63:..} 像素坐标。

    灯珠核心接近白（R/G/B 都高），而丝印和白纸都偏冷/低红，用
    「亮 + 偏红」作判据。相机没动时直接用 CORNER_HINT 更快；挪过机位时
    用这个重新定位，省掉手量坐标。

    默认只搜画面中央区域：灯板在画面里占中间一块，全画面搜会把插座上的
    白色丝印、纸面反光也算进来（实测画面里会混进 3 个干扰点）。
    """
    if region is None:
        h, w = frame.shape[:2]
        region = (int(w * 0.25), int(h * 0.30), int(w * 0.45), int(h * 0.50))
    x, y, w, h = region
    r = frame[:, :, 2].astype(np.int16)
    g = frame[:, :, 1].astype(np.int16)
    b = frame[:, :, 0].astype(np.int16)
    gray = frame.max(axis=2).astype(np.int16)
    mask = ((gray[y:y + h, x:x + w] > 180)
            & (r[y:y + h, x:x + w] > b[y:y + h, x:x + w] + 12)).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, _lab, stats, cents = cv2.connectedComponentsWithStats(mask, 8)
    cand = [(stats[i][4], float(cents[i][0]) + x, float(cents[i][1]) + y)
            for i in range(1, n) if stats[i][4] >= 40]
    if len(cand) < 4:
        raise SystemExit(
            f"只找到 {len(cand)} 个角灯亮点（需要 4 个）。"
            "确认只点亮 LED 0/7/56/63，且灯板完整在画面内。")
    # 角灯是四个最大的亮点；更小的多半是丝印或反光碎片。
    # 注意用**质心**而不是最亮点：灯珠核心已经饱和，最亮处是平台，
    # 取 argmax 会随机落到平台边缘；质心对饱和平台是稳定的。
    cand.sort(reverse=True)
    pts = [(cx, cy) for _a, cx, cy in cand[:4]]
    # 分类：0=左上、7=右上、56=左下、63=右下（板子在画面里略旋转）
    pts.sort(key=lambda p: p[0])           # 按 x 分左右两组
    left, right = pts[:2], pts[2:]
    left.sort(key=lambda p: p[1])
    right.sort(key=lambda p: p[1])
    return {0: left[0], 7: right[0], 56: left[1], 63: right[1]}


def coarse_homography(corners):
    """由四个角灯位置求粗矫正：把角灯中心映射到**角格的格心**。

    注意是两个不同的概念（踩过坑）：角灯 LED 0/7/56/63 的亮心位于四个角格
    的格心，映射后就该落在 (100,100)…(700,700)（800px 方图、8 格、每格
    100px 的第 1 个格子中心），而**不是** (50,50)…(750,750) —— 后者是
    800px 方图的四角，对应灯板最外缘。映射到外缘会让整张网格缩进半格，
    灯座就全压在格线上了。
    """
    half = BOARD_PX / 16.0          # 半格 = 50
    inner = BOARD_PX / 8 - half     # 角格格心 = 100
    src = np.array([corners[0], corners[7], corners[56], corners[63]], np.float32)
    dst = np.array([[inner, inner],
                    [BOARD_PX - inner, inner],
                    [inner, BOARD_PX - inner],
                    [BOARD_PX - inner, BOARD_PX - inner]], np.float32)
    return cv2.getPerspectiveTransform(src, dst)


def warp_with(M, frame, size=BOARD_PX):
    return cv2.warpPerspective(frame, M, (size, size))


def save_grid_overlay(warped, out_path):
    img = warped.copy()
    for k in range(9):
        p = k * BOARD_PX // 8
        cv2.line(img, (p, 0), (p, BOARD_PX), (0, 255, 0), 1)
        cv2.line(img, (0, p), (BOARD_PX, p), (0, 255, 0), 1)
    cv2.imwrite(out_path, img)


def cell_features(warped, rows=8, cols=8, top_fraction=0.25):
    """切 8×8，每格取「最亮 top_fraction 像素」的中位数作代表色。

    与 analyze-strip-video.py 的 segment_features 同口径，便于两边数字对齐。
    clipped 表示该格代表像素里有 >5% 通道达到 250 —— 此时色相已不可信，
    错色检测会失效，必须先降亮度或降曝光。
    """
    ch, cw = warped.shape[0] // rows, warped.shape[1] // cols
    out = []
    for rr in range(rows):
        for cc in range(cols):
            patch = warped[rr * ch:(rr + 1) * ch, cc * cw:(cc + 1) * cw]
            flat = patch.reshape(-1, 3).astype(np.float32)
            b, g, r = flat[:, 0], flat[:, 1], flat[:, 2]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            take = max(1, int(round(len(lum) * top_fraction)))
            top = flat[np.argpartition(lum, -take)[-take:]]
            med = np.median(top, axis=0)  # BGR
            total = float(med.sum()) or 1.0
            out.append({
                "index": rr * cols + cc,
                "row": rr,
                "col": cc,
                "bgr": [round(float(v), 1) for v in med],
                "lum": round(float(0.299 * med[2] + 0.587 * med[1] + 0.114 * med[0]), 1),
                "chroma_r": round(float(med[2] / total), 3),
                "chroma_g": round(float(med[1] / total), 3),
                "chroma_b": round(float(med[0] / total), 3),
                "clipped": float((top >= 250).any(axis=1).mean()) > 0.05,
            })
    return out


def load_homography(frame_size=None):
    """读标定。给了 frame_size 时校验分辨率一致 —— 单应矩阵与分辨率绑定，
    换分辨率还用旧矩阵会把网格整体切歪，且不会报错。"""
    if not os.path.exists(CALIB_PATH):
        raise SystemExit(f"没有标定文件 {CALIB_PATH}，先跑 calibrate")
    with open(CALIB_PATH, encoding="utf-8") as fh:
        data = json.load(fh)
    calib_size = data.get("frame_size")
    if frame_size is not None and calib_size is not None:
        if list(frame_size) != list(calib_size):
            raise SystemExit(
                f"标定是 {calib_size} 下做的，当前录像是 {list(frame_size)}。"
                "分辨率变了必须重新标定（单应矩阵与分辨率绑定）。"
            )
    return np.array(data["homography"], dtype=np.float64)


def cmd_calibrate(args):
    """标定：只用四个角灯确定 8×8 网格。

    这是本轮最终采用的做法，也是唯一在本机可复现的：锁定曝光后画面里
    只剩 LED 自己（房间光被压掉），丝印灯座看不见，所以不能靠灯座标定。
    四角灯（LED 0/7/56/63）的亮心就是四个角格的格心 —— 四个点直接定出
    单应，实测误差远小于一格（见 .board-calib-check.png 的复核图）。
    """
    frame = cv2.imread(args.path)
    if frame is None:
        raise SystemExit(f"读不到 {args.path}")
    try:
        corners = detect_corner_leds(frame)
        print("自动检测四角灯 "
              f"{[tuple(round(v) for v in corners[k]) for k in (0, 7, 56, 63)]}")
    except SystemExit as exc:
        print(f"自动检测失败（{exc}），改用内置四角坐标")
        corners = CORNER_HINT
    M = coarse_homography(corners)
    h, w = frame.shape[:2]
    with open(CALIB_PATH, "w", encoding="utf-8") as fh:
        json.dump({"homography": M.tolist(),
                   "frame_size": [w, h],
                   "corners": {str(k): list(v) for k, v in corners.items()},
                   "method": "四角灯 LED 0/7/56/63 = 角格格心",
                   "note": "换机位或分辨率必须重跑；本标定只依赖角灯，不依赖丝印"},
                  fh, indent=2)
    print(f"标定分辨率 {w}×{h}，已写入 {CALIB_PATH}")
    save_grid_overlay(warp_with(M, frame), ".board-calib-check.png")
    print("复核图已存 .board-calib-check.png —— 确认四个角灯各在自己的角格中心")


def cmd_capture(args):
    frame = grab_frame(args.exposure, args.gain)
    cv2.imwrite(args.path, frame)
    print(f"已存 {args.path}  饱和像素 {(frame >= 250).mean() * 100:.2f}%")


def cmd_overlay(args):
    frame = cv2.imread(args.path)
    if frame is None:
        raise SystemExit(f"读不到 {args.path}")
    h, w = frame.shape[:2]
    save_grid_overlay(warp_with(load_homography((w, h)), frame), args.out)
    print(f"已存 {args.out}")


def cmd_measure(args):
    frame = cv2.imread(args.path)
    if frame is None:
        raise SystemExit(f"读不到 {args.path}")
    h, w = frame.shape[:2]
    warped = warp_with(load_homography((w, h)), frame)
    cells = cell_features(warped)
    clipped = [c["index"] for c in cells if c["clipped"]]
    print("index row col   BGR                lum   R%    G%    B%")
    for c in cells:
        b, g, r = c["bgr"]
        print(f"{c['index']:5d} {c['row']:3d} {c['col']:3d}  "
              f"({b:6.1f},{g:6.1f},{r:6.1f})  {c['lum']:5.1f}  "
              f"{c['chroma_r']:.3f} {c['chroma_g']:.3f} {c['chroma_b']:.3f}"
              f"{'  CLIP' if c['clipped'] else ''}")
    lit = [c["index"] for c in cells if c["lum"] > 40]
    print(f"\n饱和格 {len(clipped)}/64：{clipped}")
    print(f"亮格(lum>40) {len(lit)}：{lit}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(cells, fh, indent=2)
        print(f"明细已写入 {args.json}")


def main():
    ap = argparse.ArgumentParser(description="#20 灯板标定与色度测量")
    ap.add_argument("--exposure", type=float, default=EXPOSURE)
    ap.add_argument("--gain", type=float, default=GAIN)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_cal = sub.add_parser("calibrate", help="用「四角点亮」的一帧标定 8×8 网格")
    p_cal.add_argument("path")

    p_cap = sub.add_parser("capture", help="存一张原始帧")
    p_cap.add_argument("path")

    p_ov = sub.add_parser("overlay", help="把 8×8 网格画到一帧上（目视复核）")
    p_ov.add_argument("path")
    p_ov.add_argument("out")

    p_meas = sub.add_parser("measure", help="按 8×8 输出色度表")
    p_meas.add_argument("path")
    p_meas.add_argument("--json")

    args = ap.parse_args()
    {"calibrate": cmd_calibrate, "capture": cmd_capture,
     "overlay": cmd_overlay, "measure": cmd_measure}[args.cmd](args)


if __name__ == "__main__":
    main()
