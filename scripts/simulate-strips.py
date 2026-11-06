#!/usr/bin/env python
"""八条灯带的模拟验收（不依赖摄像头与真机）。

## 为什么需要它

摄像头这条路被物理条件卡死了：实测只点亮 strip 0 时画面里只有一个小光点，
说明机位拍不到灯带本体（`.layout-shots/layout-0.png` 是证据）。用一台拍不到
灯的设备做验收，得到的只会是噪声。

所以改成**在宿主上跑固件真实的渲染代码**：`firmware/sim/sim_main.c` 链接的是
生产用的 `effects.c` / `segment_store.c` / `gamma.c` / `led_render.c`，只把
「刷 RMT」换成了「留在内存里」。像素与真机逐字节同源。

它不能替代真机的地方：WS2812B 的色域压缩、电源压降、RMT 时序。这三项仍需真机
肉眼或示波器；本脚本在报告里会明说。

## 五组场景

  1. zero-zones      八条带都没有分区      → 期望全部纯黑（曾经的黄灯）
  2. only-strip0     只有 strip 0 有彩虹   → 其余 7 条必须纯黑
  3. hue-sat-change  只改 strip 0 颜色     → 其余 7 条逐字节不变
  4. luma-blend      彩虹 + 流星 blend=3   → 亮处流星、暗处彩虹
  5. over-blend      同配置 blend=0        → 对照组：边界生硬、暗处被吃掉

用法：
    python scripts/simulate-strips.py            # 跑全部并出图
    python scripts/simulate-strips.py --csv      # 另外打印逐颗数值
    python scripts/simulate-strips.py --keep     # 保留中间 JSON

产物：`.sim-out/<scenario>.png`、`.sim-out/<scenario>-frames.png`、`.sim-out/report.md`
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, ".sim-out")
SIM_DIR = os.path.join(ROOT, "firmware", "sim")
SIM_BIN = os.path.join(tempfile.gettempdir(), "lumen-sim", "lumen_sim.exe")

MAIN = os.path.join(ROOT, "firmware", "main")
STRIPS = 8
LEDS = 30

# 灯效类型（docs/protocol-v4.md §7.1）
STATIC, BREATHING, RAINBOW, COMET, STROBE, HEARTBEAT, OFF, FLICKER = range(8)

BLEND_OVER, BLEND_MULTIPLY, BLEND_ADD, BLEND_LUMA = 0, 1, 2, 3


# ---------------------------------------------------------------- 构建

def build_simulator():
    """编译宿主模拟器。需要 gcc 与三个桩头文件（esp_log / sdkconfig / esp_err）。"""
    os.makedirs(os.path.dirname(SIM_BIN), exist_ok=True)
    stub_dir = os.path.join(tempfile.gettempdir(), "lumen-sim-stubs")
    os.makedirs(stub_dir, exist_ok=True)
    stubs = {
        "esp_log.h": (
            "#pragma once\n#include <stdio.h>\n"
            "#define ESP_LOGI(tag, ...) ((void)0)\n"
            "#define ESP_LOGW(tag, ...) ((void)0)\n"
            "#define ESP_LOGD(tag, ...) ((void)0)\n"
        ),
        "sdkconfig.h": "#pragma once\n",
        "esp_err.h": (
            "#pragma once\ntypedef int esp_err_t;\n"
            "#define ESP_OK 0\n#define ESP_ERR_INVALID_ARG 1\n"
        ),
        "led_strip.h": (
            "#pragma once\n#include <stdint.h>\ntypedef void *led_strip_handle_t;\n"
        ),
        "esp_timer.h": "#pragma once\n#include <stdint.h>\nint64_t esp_timer_get_time(void);\n",
    }
    for name, body in stubs.items():
        path = os.path.join(stub_dir, name)
        if not os.path.exists(path) or open(path, encoding="utf-8").read() != body:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)

    sources = [
        os.path.join(SIM_DIR, "sim_main.c"),
        os.path.join(MAIN, "effects.c"),
        os.path.join(MAIN, "segment_store.c"),
        os.path.join(MAIN, "gamma.c"),
        os.path.join(MAIN, "led_render.c"),
        os.path.join(MAIN, "state.c"),
        os.path.join(MAIN, "strip_power.c"),
        os.path.join(MAIN, "selftest.c"),
    ]
    cmd = [
        "gcc",
        "-std=c11",
        "-O1",
        "-I",
        stub_dir,
        "-I",
        MAIN,
        *sources,
        "-lm",
        "-o",
        SIM_BIN,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    # led_render.c 的 TAG 在桩头下没被引用，是唯一预期内的告警。
    fatal = [ln for ln in (proc.stderr or "").splitlines() if "error" in ln]
    if proc.returncode != 0 or fatal:
        raise SystemExit("模拟器编译失败：\n" + (proc.stderr or ""))
    return SIM_BIN


# ---------------------------------------------------------------- 场景

def layer(type_, hue=0, sat=255, period=0, p5=0, flags=0, level=100):
    return {
        "type": type_,
        "hue": hue,
        "sat": sat,
        "period": period,
        "p5": p5,
        "flags": flags,
        "level": level,
    }


def segment(strip, seg, start, end, l0, l1=None, blend=BLEND_OVER):
    return {
        "strip": strip,
        "seg": seg,
        "start": start,
        "end": end,
        "blend": blend,
        "layer0": l0,
        "layer1": l1 if l1 is not None else {"type": -1},
    }


def scenario(name, segments, samples=(0,), brightness=200):
    return {
        "name": name,
        "led_count": [LEDS] * STRIPS,
        "strip_count": STRIPS,
        "brightness": brightness,
        "power": 1,
        "samples_ms": list(samples),
        "segments": segments,
    }


def all_scenarios():
    rainbow_still = layer(RAINBOW, hue=0, sat=255, period=0, p5=255, level=100)
    white_comet = layer(COMET, hue=0, sat=0, period=2000, p5=140, level=100)
    solid_blue = layer(STATIC, hue=43690, sat=255, level=100)

    # 流星动画的采样时刻：一个周期（2000ms）内的 8 个点。
    anim_samples = [i * 250 for i in range(8)]

    return [
        # 1 零分区：所有带必须纯黑
        scenario("zero-zones", []),
        # 2 只有 strip0 有彩虹：其余 7 条必须纯黑
        scenario("only-strip0", [segment(0, 0, 0, LEDS - 1, rainbow_still)]),
        # 3 只改 strip0 的颜色（同一场景的另一个色相），用来越层比对其它带不变
        scenario(
            "only-strip0-hue",
            [segment(0, 0, 0, LEDS - 1, layer(RAINBOW, hue=20000, sat=255, period=0, p5=255))],
        ),
        # 4 轨道：彩虹 + 流星，按亮度叠加（本轮新增的 0x03）
        scenario(
            "luma-blend",
            [segment(0, 0, 0, LEDS - 1, rainbow_still, white_comet, blend=BLEND_LUMA)],
            samples=anim_samples,
        ),
        # 5 对照组：同配置但用「覆盖」（0x00，旧行为）
        scenario(
            "over-blend",
            [segment(0, 0, 0, LEDS - 1, rainbow_still, white_comet, blend=BLEND_OVER)],
            samples=anim_samples,
        ),
        # 6 额外：背景纯蓝 + 流星，便于肉眼分辨「亮处流星、暗处透出背景」
        scenario(
            "luma-on-solid",
            [segment(0, 0, 0, LEDS - 1, solid_blue, white_comet, blend=BLEND_LUMA)],
            samples=anim_samples,
        ),
    ]


def run_scenario(sc):
    """把场景交给模拟器，读回逐帧像素。"""
    with tempfile.TemporaryDirectory(prefix="lumen-sim-run-") as td:
        scen_path = os.path.join(td, "scenario.json")
        out_path = os.path.join(td, "out.json")
        payload = {k: v for k, v in sc.items() if k != "name"}
        with open(scen_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        proc = subprocess.run([SIM_BIN, scen_path, out_path], capture_output=True, text=True)
        if proc.returncode != 0:
            raise SystemExit(
                f"场景 {sc['name']} 运行失败（{proc.returncode}）：\n{proc.stderr}"
                f"{proc.stdout}"
            )
        out_text = open(out_path, encoding="utf-8").read()
    return json.loads(out_text)


# ---------------------------------------------------------------- 出图

def _write_png(path, img):
    """写 PNG。

    **不能用 `cv2.imwrite`**：OpenCV 在 Windows 上按 ANSI 路径打开文件，本仓库
    的路径含中文（`项目`），imwrite 会静默返回 False、一个字节都不写。用
    imencode 在内存里编码，再用 Python 的文件对象落盘，与路径编码无关。
    """
    import cv2

    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError(f"PNG 编码失败：{path}")
    with open(path, "wb") as fh:
        fh.write(buf.tobytes())


def render_strip_image(sc_name, result, frame_index=0, path=None, title=None):
    """把一帧画成「8 条灯带并排」的横向色块图。"""
    import numpy as np
    import cv2

    frame = result["frames"][frame_index]
    cell = 28
    gap = 12
    label_w = 120
    width = label_w + LEDS * cell + 24
    height = gap + STRIPS * (cell + gap)

    img = np.full((height, width, 3), 16, dtype=np.uint8)
    for strip in range(STRIPS):
        pixels = frame["strips"][strip]
        y = gap + strip * (cell + gap)
        for i, rgb in enumerate(pixels):
            x = label_w + i * cell
            # RGB → BGR（OpenCV）
            img[y : y + cell, x : x + cell] = (int(rgb[2]), int(rgb[1]), int(rgb[0]))
        cv2.putText(
            img,
            f"strip {strip}",
            (8, y + cell - 8),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.42,
            (190, 190, 190),
            1,
            cv2.LINE_AA,
        )
    if title:
        pass  # 标题交给 HTML 报告，图上不画中文（cv2 不支持 CJK）。

    path = path or os.path.join(OUT, f"{sc_name}.png")
    _write_png(path, img)
    return path


def render_frame_timeline(sc_name, result, path=None):
    """把多帧采样画成「时间 → 灯带 → 灯珠」的三维投影（每行一帧）。"""
    import numpy as np
    import cv2

    frames = result["frames"]
    rows = len(frames)
    row_h = 34
    gap = 8
    label_w = 76
    width = label_w + LEDS * 22 + 20
    height = gap + rows * (row_h * STRIPS // 8 + row_h) + gap
    # 每帧画 strip0 一条，纵向堆叠
    height = gap + rows * (row_h + gap)
    img = np.full((height, width, 3), 16, dtype=np.uint8)
    for k, frame in enumerate(frames):
        y = gap + k * (row_h + gap)
        pixels = frame["strips"][0]
        for i, rgb in enumerate(pixels):
            x = label_w + i * 22
            img[y : y + row_h, x : x + 22] = (int(rgb[2]), int(rgb[1]), int(rgb[0]))
        cv2.putText(
            img,
            f"{frame['t_ms']}ms",
            (6, y + row_h - 11),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.38,
            (190, 190, 190),
            1,
            cv2.LINE_AA,
        )
    path = path or os.path.join(OUT, f"{sc_name}-frames.png")
    _write_png(path, img)
    return path


# ---------------------------------------------------------------- 判定

def as_tuples(pixels):
    return [tuple(int(c) for c in p) for p in pixels]


def check(cond, label, detail=""):
    return {"ok": bool(cond), "label": label, "detail": detail}


def evaluate(name, result):
    """按场景给出断言。返回 (checks, notes)。"""
    frames = result["frames"]
    f0 = frames[0]["strips"]
    checks = []

    if name == "zero-zones":
        for strip in range(STRIPS):
            px = as_tuples(f0[strip])
            worst = max(max(p) for p in px) if px else 0
            checks.append(
                check(
                    all(p == (0, 0, 0) for p in px),
                    f"strip {strip} 全黑",
                    f"最亮通道 {worst}",
                )
            )

    elif name in ("only-strip0", "only-strip0-hue"):
        px0 = as_tuples(f0[0])
        lit0 = sum(1 for p in px0 if max(p) > 0)
        checks.append(check(lit0 > 0, "strip 0 有光", f"{lit0}/{len(px0)} 颗亮"))
        for strip in range(1, STRIPS):
            px = as_tuples(f0[strip])
            worst = max(max(p) for p in px) if px else 0
            checks.append(
                check(all(p == (0, 0, 0) for p in px), f"strip {strip} 全黑（未被污染）",
                      f"最亮通道 {worst}")
            )

    elif name == "luma-blend":
        px = as_tuples(f0[0])
        # 判据：同一帧里既有「接近白的亮处」又有「明显是彩色的暗处」。
        #
        # 阈值按**实测峰值**定，不是按 255：全局 brightness=200 且过 gamma 之后，
        # 满亮通道实测到 165（见 .sim-out/report.md 的说明）。用 200 当门槛会
        # 永远匹配不到，把「判据写错」误报成「固件坏」。
        peak = max((max(p) for p in px), default=0)
        bright = [p for p in px if min(p) > peak * 0.9]
        colored = [p for p in px if max(p) - min(p) > 60 and max(p) > 40]
        dark = [p for p in px if max(p) < peak * 0.08]
        checks.append(
            check(len(bright) > 0, "存在近白的流星亮处", f"{len(bright)} 颗（峰值 {peak}）")
        )
        checks.append(check(len(colored) >= 10, "暗处仍有彩色（彩虹透出）", f"{len(colored)} 颗"))
        checks.append(check(len(dark) <= 2, "几乎没有被吃掉的黑点", f"{len(dark)} 颗"))
        # 动画：至少两种不同的帧
        sigs = {tuple(as_tuples(f["strips"][0])) for f in frames}
        checks.append(check(len(sigs) >= 3, "画面随时间变化（流星在动）", f"{len(sigs)} 种画面"))

    elif name == "over-blend":
        px = as_tuples(f0[0])
        peak = max((max(p) for p in px), default=0)
        dark = [p for p in px if max(p) < max(20, peak * 0.08)]
        colored = [p for p in px if max(p) - min(p) > 60 and max(p) > 40]
        # 对照组的意义：证明 0x00 确实会把背景吃掉，0x03 不是巧合。
        checks.append(
            check(len(dark) > len(colored), "覆盖语义：黑点多于彩色点（背景被吃掉）",
                  f"黑 {len(dark)} / 彩 {len(colored)}")
        )

    elif name == "luma-on-solid":
        px = as_tuples(f0[0])
        bluish = [p for p in px if p[2] > p[0] and p[2] > p[1] and max(p) > 20]
        peak = max((max(p) for p in px), default=0)
        whitish = [p for p in px if min(p) > peak * 0.9]
        checks.append(check(len(whitish) > 0, "有近白的流星亮处", f"{len(whitish)} 颗"))
        checks.append(check(len(bluish) >= 10, "暗处仍是背景蓝", f"{len(bluish)} 颗"))

    return checks


def unchanged_between(a_result, b_result):
    """两组场景之间，strip 1..7 是否逐字节一致。"""
    a = a_result["frames"][0]["strips"]
    b = b_result["frames"][0]["strips"]
    diffs = []
    for strip in range(1, STRIPS):
        if as_tuples(a[strip]) != as_tuples(b[strip]):
            n = sum(1 for x, y in zip(as_tuples(a[strip]), as_tuples(b[strip])) if x != y)
            diffs.append(f"strip {strip}: {n} 颗不同")
    return diffs


def main():
    ap = argparse.ArgumentParser(description="八条灯带的宿主模拟验收")
    ap.add_argument("--csv", action="store_true", help="打印逐颗数值")
    ap.add_argument("--keep", action="store_true", help="保留中间 JSON")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    build_simulator()
    print(f"模拟器：{SIM_BIN}")

    results = {}
    report = []
    for sc in all_scenarios():
        name = sc["name"]
        res = run_scenario(sc)
        results[name] = res
        checks = evaluate(name, res)
        png = render_strip_image(name, res)
        if len(res["frames"]) > 1:
            timeline = render_frame_timeline(name, res)
        else:
            timeline = None

        print(f"\n=== {name} ===")
        for c in checks:
            mark = "PASS" if c["ok"] else "FAIL"
            print(f"  {mark}  {c['label']}" + (f"  — {c['detail']}" if c["detail"] else ""))
        report.append((name, checks, png, timeline))

        if args.csv:
            for strip in range(STRIPS):
                px = as_tuples(res["frames"][0]["strips"][strip])
                print(f"  strip{strip}: " + " ".join(f"{r:02x}{g:02x}{b:02x}" for r, g, b in px))

    # 跨场景：只改 strip0 的颜色 / 饱和度，其余带必须逐字节不变
    diffs = unchanged_between(results["only-strip0"], results["only-strip0-hue"])
    cross = check(not diffs, "改 strip 0 颜色后，其余 7 条逐字节不变", "；".join(diffs) or "无差异")
    print("\n=== 跨场景：改一组不污染其它组 ===")
    print(f"  {'PASS' if cross['ok'] else 'FAIL'}  {cross['label']}"
          + (f"  — {cross['detail']}" if cross["detail"] else ""))
    report.append(("cross-strip-isolation", [cross], None, None))

    # 汇总
    total = sum(len(c) for _, c, _, _ in report)
    failed = sum(1 for _, cs, _, _ in report for c in cs if not c["ok"])
    print(f"\n===== {total - failed} passed / {failed} failed =====")
    print(f"图片：{OUT}")
    write_markdown(report)

    {
        "__note": "模拟器只证明段语义与像素合成；色域压缩 / 压降 / RMT 时序仍需真机。",
        "sim_binary": SIM_BIN,
        "results": {n: r for n, r in results.items()} if args.keep else {},
    }
    return 1 if failed else 0


def write_markdown(report):
    lines = [
        "# 八条灯带模拟验收",
        "",
        "由 `scripts/simulate-strips.py` 生成。像素来自固件真实的渲染代码",
        "（`effects.c` / `segment_store.c` / `gamma.c` / `led_render.c`），",
        "只把「刷 RMT」换成了留在内存里。",
        "",
        "> **边界**：能证明段语义、blend 结果、层亮度、gamma 合成顺序、动画相位；",
        "> **不能**证明 WS2812B 色域压缩、电源压降、RMT 时序——这三项仍需真机。",
        "",
    ]
    for name, checks, png, timeline in report:
        lines.append(f"## {name}")
        lines.append("")
        for c in checks:
            lines.append(f"- {'✅' if c['ok'] else '❌'} {c['label']}"
                         + (f" — {c['detail']}" if c["detail"] else ""))
        lines.append("")
        if png and os.path.exists(png):
            lines.append(f"![{name}]({os.path.basename(png)})")
            lines.append("")
        if timeline and os.path.exists(timeline):
            lines.append(f"![{name} 时间线]({os.path.basename(timeline)})")
            lines.append("")
    with open(os.path.join(OUT, "report.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


if __name__ == "__main__":
    sys.exit(main())
