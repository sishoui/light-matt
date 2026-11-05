#!/usr/bin/env python
"""把一场录制的原始素材切成「每步一段」的并排视频，并给出客观量测。

输入：run/ 里的 camera.json / marks.jsonl / results.json / strips.mp4
输出：run/clips/*.mp4（H.264，浏览器可直接播）+ run/analysis.json

画面布局（左灯带 / 右状态面板）：灯带是唯一能证明「真的变了」的东西，
面板写清「点了什么、页面怎么认、设备读回什么」，两者并排才好判断。

所有时间窗口都用 camera.json 里的**逐帧真实时间戳**定位，不用容器帧率
——实测 720p 约 10fps，声明值是 30，按声明值切会整体错位。
"""

import json
import os
import subprocess
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = r"C:/Users/13092/AppData/Local/Programs/Python/Python312/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe"
FONT = r"C:/Windows/Fonts/msyh.ttc"

# 灯带在 1280x720 画面里的固定区域（机位不动，实测内容都落在 x 662..808 / y 246..481）
CROP = (600, 220, 870, 520)
OUT_H = 620
PANEL_W = 780

TYPE_NAME = {0x00: "常亮", 0x01: "呼吸", 0x02: "彩虹", 0x03: "流星",
             0x04: "爆闪", 0x05: "心跳", 0x06: "熄灭", 0x07: "随机闪烁", 0xff: "空层"}

# 每一步「应用后应该读到什么」。用期望值而不是只看「变没变」：
# 随机闪烁那一步确实变了（心跳 0x05 → 常亮 0x00），只看「变了」会把缺陷判成通过。
EXPECT = {
    "03-zone-add": {"bg": 0x00},
    "05-effect-breathing": {"bg": 0x01},
    "06-effect-rainbow": {"bg": 0x02},
    "07-effect-comet": {"bg": 0x03},
    "08-effect-strobe": {"bg": 0x04},
    "09-effect-heartbeat": {"bg": 0x05},
    "10-effect-flicker": {"bg": 0x07},
    "11-effect-static": {"bg": 0x00},
    "12-param-level": {"level": 40},
    "13-param-hue": {"hue_deg": 210.0},
    "14-overlay-comet": {"overlay": 0x03},
    "15-overlay-blend": {"blend": 0x02},
    "20-effect-off": {"bg": 0x06},
    "16-loop-none": {"flags": 0x02},
    "17-loop-all": {"flags": 0x03},
    "18-loop-last": {"flags": 0x07},
}


def load_font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default()


F_STEP = load_font(30)
F_SMALL = load_font(20)
F_TINY = load_font(18)


def describe_effect(types):
    if not types:
        return "无分区"
    return " / ".join(TYPE_NAME.get(t, f"0x{t:02x}") for t in types)


def measure(frame, crop):
    """在灯带区域量三个客观量：亮灯像素数、平均亮度、平均色相（有光时）。"""
    x0, y0, x1, y1 = crop
    roi = frame[y0:y1, x0:x1]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2].astype(np.float32)
    s = hsv[:, :, 1].astype(np.float32)
    lit = (v > 110) & (s > 30)
    n = int(lit.sum())
    hue = float(np.median(hsv[:, :, 0][lit])) * 2.0 if n > 12 else None
    return {"lit_px": n, "mean_v": round(float(v.mean()), 2),
            "hue": None if hue is None else round(hue, 1)}


def measure_span(cap, ft, a, b):
    """一段窗口内的相机量测。

    动态效果（呼吸 / 流星 / 爆闪）单帧和静止长得一样，所以除中位数外
    还要给出变化幅度：窗口内亮度极差。那是「这一段在动」的证据。
    """
    vs, lits, hues = [], [], []
    for i in range(a, min(b, len(ft))):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, f = cap.read()
        if not ok:
            continue
        m = measure(f, CROP)
        vs.append(m["mean_v"])
        lits.append(m["lit_px"])
        if m["hue"] is not None:
            hues.append(m["hue"])
    if not vs:
        return None
    return {
        "lit_px": int(np.median(lits)),
        "lit_max": int(max(lits)),
        "mean_v": round(float(np.median(vs)), 2),
        "v_range": round(float(max(vs) - min(vs)), 2),
        "hue": round(float(np.median(hues)), 1) if hues else None,
        "samples": len(vs),
    }


def check_expect(step_id, after):
    """按期望值核对，返回 (ok, 说明)，没有期望值返回 None。"""
    exp = EXPECT.get(step_id)
    if exp is None or after is None:
        return None
    l0 = ((after.get("layers") or [{}])[0] or {}).get("l0") or {}
    problems = []
    if "bg" in exp:
        got = (after.get("layerTypes") or [None])[0]
        if got != exp["bg"]:
            problems.append(
                f"背景层应为 {TYPE_NAME.get(exp['bg'])} 0x{exp['bg']:02x}，"
                f"实际 {TYPE_NAME.get(got, '无分区')} 0x{got:02x}"
                if isinstance(got, int)
                else f"背景层应为 {TYPE_NAME.get(exp['bg'])}，实际无分区")
    if "overlay" in exp and (after.get("overlayTypes") or [None])[0] != exp["overlay"]:
        problems.append(f"特效层应为 0x{exp['overlay']:02x}")
    if "blend" in exp and (((after.get("layers") or [{}])[0] or {}).get("blend")) != exp["blend"]:
        problems.append(f"混合方式应为 0x{exp['blend']:02x}")
    if "level" in exp and l0.get("level") != exp["level"]:
        problems.append(f"亮度应为 {exp['level']}，实际 {l0.get('level')}")
    if "hue_deg" in exp:
        got = l0.get("hue")
        deg = round(got * 360.0 / 65536.0, 1) if isinstance(got, int) else None
        if deg is None or abs(deg - exp["hue_deg"]) > 3:
            problems.append(f"色相应为 {exp['hue_deg']}°，实际 {deg}°")
    if "flags" in exp and (after.get("flags", 0) & 0x07) != exp["flags"]:
        problems.append(f"flags 应为 0x{exp['flags']:02x}，实际 0x{after.get('flags', 0):02x}")
    return (not problems, "；".join(problems))


def verdict_for(win, res):
    """判定这一步「设备端有没有真的发生对应的变化」。

    第九轮起每步只有一个窗口（点完即下发）。`expectChange` 为真却读回没变
    就是真问题；为假（元数据步骤）只要求「不报错、不破坏画面」。
    """
    after = win["after"]
    if after is None:
        return {"level": "skip", "text": "这一步只改本地草稿，不下发设备。"}

    checked = check_expect(win["step"], after)
    if checked is not None:
        ok, detail = checked
        return {
            "level": "ok" if ok else "WRONG",
            "text": "读回值与预期一致。" if ok else f"与预期不符：{detail}",
        }

    err = (res or {}).get("applyError") or ""
    if err:
        return {"level": "WRONG", "text": f"页面报了失败：{err}"}

    changed = (res or {}).get("changed")
    expect = (res or {}).get("expectChange") is True
    if changed:
        return {"level": "ok", "text": "点完即下发，设备读回已改变。"}
    if not expect:
        return {
            "level": "same",
            "text": "这一步没有改变设备读回值：可能点的就是当前已有的值，或改的是"
                    "协议读不回来的方案元数据（循环档 / 步骤时长）。要求只是"
                    "「点完不报错、画面不被破坏」，已满足。",
        }
    return {"level": "WRONG", "text": "期望设备读回变化，但前后逐字段相同。"}


def panel_image(step, phase, before, after, verdict, measured):
    """右侧状态面板。高度由内容决定不了（视频要求定高），所以先排一遍量行数，
    再按需要收紧字号/间距——面板溢出会在画面底部被截掉一整段文字。"""
    img = Image.new("RGB", (PANEL_W, OUT_H), (18, 20, 24))
    d = ImageDraw.Draw(img)
    y = 16

    def wrap(text, font, width):
        lines, line = [], ""
        for ch in text:
            if d.textlength(line + ch, font=font) > width:
                lines.append(line)
                line = ""
            line += ch
        if line:
            lines.append(line)
        return lines

    for ln in wrap(step["title"], F_STEP, PANEL_W - 52):
        d.text((26, y), ln, font=F_STEP, fill=(240, 242, 246))
        y += 36
    y += 2

    tag = "点完即下发（#125）" if phase == "click" else "点击后应用"
    d.text((26, y), tag, font=F_SMALL, fill=(120, 200, 255))
    y += 34

    def section(label):
        nonlocal y
        d.text((26, y), label, font=F_TINY, fill=(130, 136, 148))
        y += 24

    def row(k, v, color=(214, 219, 228)):
        nonlocal y
        d.text((40, y), k, font=F_TINY, fill=(140, 146, 158))
        d.text((196, y), str(v), font=F_SMALL, fill=color)
        y += 27

    section("页面 / 设备读回")
    def segs_of(s):
        counts = s.get("segCounts") or []
        return counts[0] if counts else 0

    if before:
        row("操作前", f"分区 {segs_of(before)} · {describe_effect(before['layerTypes'])}")
    if after:
        row("操作后", f"分区 {segs_of(after)} · {describe_effect(after['layerTypes'])}")
        row("区段", ", ".join(after["ranges"]) or "无")
        overlays = [t for t in after["overlayTypes"] if t != 0xff]
        row("特效层", describe_effect(overlays) if overlays else "空")
        row("播放", "播放中" if after["playback"] else "停止")
    y += 6

    section("相机实测（灯带区域）")
    if measured:
        row("亮灯像素", f"{measured['lit_px']}（峰值 {measured['lit_max']}）")
        row("平均亮度", f"{measured['mean_v']}（波动 {measured['v_range']}）")
        row("平均色相", "—" if measured["hue"] is None else f"{measured['hue']}°")
    y += 8

    section("判定")
    color = {"ok": (120, 220, 150), "WRONG": (255, 110, 110),
             "gap": (255, 180, 90), "same": (200, 200, 120),
             "skip": (150, 156, 168)}.get(verdict["level"], (220, 220, 220))
    for ln in wrap(verdict["text"], F_SMALL, PANEL_W - 52):
        d.text((26, y), ln, font=F_SMALL, fill=color)
        y += 27
    if y > OUT_H - 10:
        print(f"  ⚠ 面板可能溢出：{step.get('id', '')} 用到 {y}px / {OUT_H}px")
    return img


def cut_windows(marks, results_by_id):
    """每步一个窗口（第九轮起每步只录一次：点完即下发，没有「点后应用」）。

    上一版每步录两段（click / apply），因为那时只有循环三档会写设备。现在
    #125 之后点完就下发，「只点」就是完整行为，所以窗口直接用那一条标记。
    """
    wins = []
    for m in marks:
        step_id = m["step"]
        if step_id.endswith("-baseline") or step_id.endswith("-end"):
            continue
        res = results_by_id.get(step_id) or {}
        wins.append(
            {
                "id": step_id,
                "step": step_id,
                "phase": "click",
                "title": m["note"],
                "t0": m["t"] - 1.2,
                "t1": m["t"] + 3.2,
                "before": res.get("before"),
                "after": res.get("after"),
                "changed": res.get("changed"),
                "expectChange": res.get("expectChange"),
            }
        )
    return wins


def main():
    run = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "run")
    clips_dir = os.path.join(run, "clips")
    os.makedirs(clips_dir, exist_ok=True)

    cam = json.load(open(os.path.join(run, "camera.json"), encoding="utf-8"))
    marks = [json.loads(l) for l in open(os.path.join(run, "marks.jsonl"), encoding="utf-8")]
    results = json.load(open(os.path.join(run, "results.json"), encoding="utf-8"))
    results_by_id = {r["id"]: r for r in results}

    ft = cam["frame_times"]
    video = os.path.join(run, cam["video"])
    cap = cv2.VideoCapture(video)

    x0, y0, x1, y1 = CROP
    cw, ch = x1 - x0, y1 - y0
    cw2 = int(cw * (OUT_H / ch))

    wins = cut_windows(marks, results_by_id)
    analysis = []
    span_frames = int(round(1.2 * (len(ft) / max(0.1, cam["duration_s"]))))

    for w in wins:
        idx0 = int(np.searchsorted(ft, w["t0"]))
        idx1 = int(np.searchsorted(ft, w["t1"]))
        idx0 = max(0, min(idx0, len(ft) - 2))
        idx1 = max(idx0 + 2, min(idx1, len(ft) - 1))

        m_before = measure_span(cap, ft, idx0, idx0 + span_frames)
        m_after = measure_span(cap, ft, max(idx0, idx1 - span_frames), idx1)

        verdict = verdict_for(w, results_by_id.get(w["step"]))
        panel_np = cv2.cvtColor(
            np.array(panel_image(w, w["phase"], w["before"], w["after"], verdict, m_after)),
            cv2.COLOR_RGB2BGR)

        out = os.path.join(clips_dir, f"{w['id']}.mp4")
        # 写 H.264：mp4v 在 Chrome 里放不了
        proc = subprocess.Popen(
            [FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
             "-s", f"{cw2 + PANEL_W}x{OUT_H}", "-r", "10", "-i", "-",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
            stdin=subprocess.PIPE)

        frames = 0
        prev = None
        for i in range(idx0, idx1):
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, f = cap.read()
            if not ok:
                continue
            rix = cv2.resize(f[y0:y1, x0:x1], (cw2, OUT_H), interpolation=cv2.INTER_CUBIC)
            # 刻意**不做**亮度增强：加 gamma/beta 会把彩虹冲成一片白，
            # 而那正是这段视频要让人看见的东西。
            canvas = np.hstack([rix, panel_np])
            proc.stdin.write(canvas.tobytes())
            prev = canvas
            frames += 1
        if frames and prev is not None:
            for _ in range(8):  # 片尾多停 0.8s，方便看最后一帧
                proc.stdin.write(prev.tobytes())
        proc.stdin.close()
        proc.wait()

        analysis.append({
            "id": w["id"], "step": w["step"], "title": w["title"],
            "phase": w["phase"], "clip": f"clips/{w['id']}.mp4",
            "duration_s": round((idx1 - idx0) / (len(ft) / cam["duration_s"]), 2),
            "frames": frames,
            "before": w["before"], "after": w["after"],
            "camera_before": m_before, "camera_after": m_after,
            "verdict": verdict,
        })
        print(f"{w['id']:34s} {frames:4d} 帧  {verdict['level']:6s} {verdict['text'][:40]}")

    cap.release()
    with open(os.path.join(run, "analysis.json"), "w", encoding="utf-8") as fh:
        json.dump({"camera": {k: cam[k] for k in ("frames", "duration_s", "measured_fps")},
                   "clips": analysis}, fh, ensure_ascii=False, indent=2)
    print(f"\n{len(analysis)} 段 → {clips_dir}")


if __name__ == "__main__":
    main()
