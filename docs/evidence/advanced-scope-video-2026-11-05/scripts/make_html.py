#!/usr/bin/env python
"""把 analysis.json 生成一份可直接打开的视频报告（自包含 HTML）。"""

import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

LEVEL = {
    "ok":    ("生效",   "ok"),
    "WRONG": ("不符预期", "bad"),
    "gap":   ("未下发",  "gap"),
    "same":  ("无变化",  "same"),
    "skip":  ("不涉及",  "skip"),
}

# 每一组的分组标题
GROUPS = [
    ("进入进阶档", ["01-mode-advanced", "02-step-add", "03-zone-add", "04-zone-select"]),
    ("背景层：八个灯效", ["05-effect-breathing", "06-effect-rainbow", "07-effect-comet",
                      "08-effect-strobe", "09-effect-heartbeat", "10-effect-flicker",
                      "11-effect-static"]),
    ("参数", ["12-param-level", "13-param-hue"]),
    ("特效层", ["14-overlay-comet", "15-overlay-blend"]),
    ("循环三档", ["16-loop-none", "17-loop-all", "18-loop-last"]),
    ("时长与收尾", ["19-duration", "20-effect-off"]),
]


def fmt_state(s):
    if not s:
        return "—"
    names = {0: "常亮", 1: "呼吸", 2: "彩虹", 3: "流星", 4: "爆闪",
             5: "心跳", 6: "熄灭", 7: "随机闪烁"}
    bg = "、".join(names.get(t, f"0x{t:02x}") for t in s["layerTypes"]) or "无分区"
    ov = [t for t in s.get("overlayTypes", []) if t != 0xff]
    extra = f" + 特效层{'、'.join(names.get(t, f'0x{t:02x}') for t in ov)}" if ov else ""
    flags = s.get("flags", 0)
    loop = "最后一步循环" if flags & 0x04 else ("全部循环" if flags & 0x01 else "不循环")
    counts = s.get("segCounts") or []
    segs = counts[0] if counts else 0
    return f"{bg}{extra} · 分区 {segs} · {loop} · {'播放中' if s.get('playback') else '停止'}"


def main():
    run = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "run")
    out_html = sys.argv[2] if len(sys.argv) > 2 else os.path.join(run, "report.html")
    data = json.load(open(os.path.join(run, "analysis.json"), encoding="utf-8"))
    clips = data["clips"]
    by_id = {}
    for c in clips:
        by_id.setdefault(c["step"], {})[c["phase"]] = c

    # 把视频搬进与 html 同级的 media/，保证双击打开就能播
    media = os.path.join(os.path.dirname(out_html), "media")
    os.makedirs(media, exist_ok=True)
    for c in clips:
        shutil.copy2(os.path.join(run, c["clip"]), os.path.join(media, os.path.basename(c["clip"])))

    n_ok = sum(1 for c in clips if c["verdict"]["level"] == "ok")
    n_wrong = sum(1 for c in clips if c["verdict"]["level"] == "WRONG")
    n_gap = sum(1 for c in clips if c["verdict"]["level"] == "gap")
    n_same = sum(1 for c in clips if c["verdict"]["level"] == "same")

    parts = [f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>进阶灯效逐步实测报告</title>
<style>
:root{{--bg:#0f1115;--card:#171a21;--line:#262b36;--text:#e6e9ef;--dim:#8b93a3;
--ok:#6fd08c;--bad:#ff6f6f;--gap:#ffb35c;--same:#d8d264;--skip:#8891a3;--accent:#6b8cae}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--text);
font:15px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}}
.wrap{{max-width:1180px;margin:0 auto;padding:40px 22px 80px}}
h1{{font-size:30px;margin:0 0 6px}}
.sub{{color:var(--dim);font-size:14px;margin-bottom:26px}}
h2{{font-size:20px;margin:44px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line)}}
.banner{{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--gap);
border-radius:10px;padding:18px 20px;margin:22px 0}}
.banner h3{{margin:0 0 8px;font-size:16px}}
.banner p{{margin:6px 0;color:#c8cedb}}
.stats{{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0 8px}}
.stat{{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:12px 18px;min-width:110px}}
.stat b{{display:block;font-size:24px;line-height:1.2}}
.stat span{{color:var(--dim);font-size:12px}}
table{{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}}
th,td{{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}}
th{{color:var(--dim);font-weight:600;font-size:12px;letter-spacing:.04em}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:12px;
padding:16px;margin:16px 0;display:grid;grid-template-columns:minmax(0,1fr) 460px;gap:16px}}
@media(max-width:900px){{.card{{grid-template-columns:1fr}}}}
.card video{{width:100%;border-radius:8px;background:#000;display:block}}
.card h4{{margin:0 0 4px;font-size:16px}}
.card .why{{color:var(--dim);font-size:13px;margin-bottom:10px}}
.kv{{font-size:13px;color:#b9c0cd}}
.kv div{{padding:2px 0}}
.kv b{{color:var(--dim);font-weight:500;display:inline-block;min-width:70px}}
.tag{{display:inline-block;font-size:12px;padding:2px 9px;border-radius:20px;
border:1px solid currentColor;margin-left:8px;vertical-align:middle}}
.ok{{color:var(--ok)}} .bad{{color:var(--bad)}} .gap{{color:var(--gap)}}
.same{{color:var(--same)}} .skip{{color:var(--skip)}}
.verdict{{margin-top:8px;font-size:13px;padding:8px 10px;border-radius:8px;background:#12151b}}
code{{background:#12151b;padding:1px 6px;border-radius:4px;font-size:13px}}
footer{{margin-top:50px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:16px}}
</style></head><body><div class="wrap">
<h1>进阶灯效：每一步点击的实测视频</h1>
<div class="sub">真机 <b>Lumen-5662</b>（固件 v4.0，8 条灯带 × 30 颗）· 相机 1280×720 逐帧录制 ·
共 {len(clips)} 段，{data['camera']['duration_s']:.0f} 秒素材</div>

<div class="banner">
<h3>先说最重要的一件事</h3>
<p><b>当前版本里，进阶档只有「循环三档」会在点下去时真正写给设备。</b>
其余改动（选灯效、划分区、调参数、改时长）点完只写进手机本地草稿，设备毫无反应 ——
这一点在下面每个步骤的「① 只点击」视频里可以直接看到。</p>
<p>所以每个步骤都录了两段：<b>① 只点击</b>（今天用户点完看到的真实画面）与
<b>② 点击后应用</b>（调用页面自己的下发逻辑，验证这套编排本身对不对）。</p>
</div>

<div class="stats">
<div class="stat"><b class="ok">{n_ok}</b><span>读回与预期一致</span></div>
<div class="stat"><b class="bad">{n_wrong}</b><span>与预期不符</span></div>
<div class="stat"><b class="gap">{n_gap}</b><span>只点击时未下发</span></div>
<div class="stat"><b class="same">{n_same}</b><span>下发后无变化</span></div>
</div>
"""]

    # 结论表
    findings = [c for c in clips if c["verdict"]["level"] in ("WRONG",)]
    parts.append("<h2>发现的问题</h2>")
    if findings:
        parts.append("<table><tr><th>步骤</th><th>现象</th><th>视频</th></tr>")
        for c in findings:
            parts.append(
                f"<tr><td>{c['title']}</td><td>{c['verdict']['text']}</td>"
                f"<td><a class='bad' href='media/{os.path.basename(c['clip'])}'>查看</a></td></tr>")
        parts.append("</table>")
        parts.append("""
<p class="kv"><b>根因：</b><code>utils/control/effect-panel.ts</code> 的
<code>panelLayer()</code> 是一次 <code>switch (type)</code>，但分支里<b>没有
<code>case "flicker"</code></b>，于是「随机闪烁」落到 <code>default</code>（里面是静态层
<code>{type: STATIC, periodMs: 0, p5: 0, flags: 0}</code>）。同文件的
<code>TYPE_VALUE</code> 与 <code>panelTypeOf()</code> 都认识 <code>flicker → 0x07</code>，
<code>SLIDER_KEYS.flicker</code> 也定义了四个滑块 —— 唯独真正生成层的那一处漏了。
<code>defaultParams("flicker")</code> 同样走 <code>default</code>，所以它的周期默认是 0。</p>
<p class="kv"><b>为什么测试没拦住：</b><code>effect-panel.test.ts</code> 断言的是类型<b>清单</b>里有
<code>flicker</code>、滑块表里有它，没有断言 <code>panelLayer("flicker")</code> 产出的
<code>type</code> 是 <code>0x07</code>。这是「测了清单没测映射」的典型缺口。</p>
""")
    else:
        parts.append("<p>本次没有发现与预期不符的步骤。</p>")

    # 逐步骤
    for gname, ids in GROUPS:
        parts.append(f"<h2>{gname}</h2>")
        for step_id in ids:
            phases = by_id.get(step_id, {})
            for phase in ("click", "apply"):
                c = phases.get(phase)
                if not c:
                    continue
                label, cls = LEVEL[c["verdict"]["level"]]
                cam = c.get("camera_after") or {}
                parts.append(f"""
<div class="card">
  <div>
    <video controls preload="metadata" src="media/{os.path.basename(c['clip'])}"></video>
  </div>
  <div>
    <h4>{c['title']}{f' · ① 只点击' if phase == 'click' else ' · ② 应用后'}</h4>
    <div class="why">{c['duration_s']:.1f}s · {c['frames']} 帧</div>
    <div class="kv">
      <div><b>操作前</b>{fmt_state(c['before'])}</div>
      <div><b>操作后</b>{fmt_state(c['after'])}</div>
      <div><b>相机读回</b>亮灯 {cam.get('lit_px', '—')} px · 平均亮度 {cam.get('mean_v', '—')} · 色相 {('—' if cam.get('hue') is None else str(cam.get('hue')) + '°')}</div>
    </div>
    <div class="verdict"><span class="{cls}">{label}</span>
      <span class="tag {cls}">{'设备' if phase == 'apply' or c['verdict']['level'] == 'ok' else '草稿'}</span>
      <div style="margin-top:6px;color:#b9c0cd">{c['verdict']['text']}</div></div>
  </div>
</div>""")

    parts.append(f"""
<footer>
素材：<code>{data['camera']['frames']}</code> 帧 / <code>{data['camera']['duration_s']:.1f}</code> 秒 @
实测 <code>{data['camera']['measured_fps']:.2f}</code> fps。视频按逐帧真实时间戳切窗口，
未使用容器声明帧率。<br>
点击走的是页面自己的事件处理器（<code>onPanelTypeTap</code> / <code>onLoopTap</code> /
<code>onPickerConfirm</code> …），不是重写一遍调用顺序；断言读设备 State 与 QueryStrip 读回值。
</footer>
</div></body></html>""")

    with open(out_html, "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))
    print(f"写出 {out_html}（{len(clips)} 段视频 → {media}）")


if __name__ == "__main__":
    main()
