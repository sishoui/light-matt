import json

p = 'docs/protocol-testvectors.json'
d = json.load(open(p, encoding='utf-8'))


def csum(b):
    return (~sum(b)) & 0xff


def frame(cmd, seq, payload):
    body = bytes([0xA5, 0x02, cmd, seq, len(payload)]) + bytes(payload)
    return (body + bytes([csum(body)])).hex().upper()


cases = {c['name']: c for c in d['cases']}

# 本脚本追加的用例都带 generated 标记；重复运行先删掉上次生成的，保证幂等。
GENERATED = "#32 gen-script-vectors.py"

d['cases'] = [c for c in d['cases'] if c.get('generated') != GENERATED]

# ---- 1. flip pinned layout cases 0x13-0x1A to 0 ----
flip = ['script_segment_static', 'script_segment_animation', 'set_playback', 'script_begin',
        'script_stage', 'script_commit', 'script_abort', 'activate_script', 'query_script']
for n in flip:
    cases[n]['result_code'] = 0
    cases[n]['note'] = '#32 已实现 0x13-0x1A；布局固定（frame_hex 是权威）'


def segpl(stage, start, end, typ=0, hue=0, sat=0xff):
    return bytes([0, stage, 0, 0, start, end, typ, hue & 0xff, (hue >> 8) & 0xff, sat]).hex().upper()


# 布局钉死用例原本只钉字节，没有设备侧上下文。补上各自需要的前置状态，
# 让「命令层放行之后引擎也接受」也被同一份向量钉住。
cases['script_segment_static']['prior_script'] = "20:000101;21:0000E803;22:" + segpl(0, 0, 9) + ";"
cases['script_segment_static']['device_ack'] = 0
cases['script_segment_animation']['prior_script'] = "20:000201;21:0000E803;21:0001F401;22:" + segpl(0, 0, 9) + ";"
cases['script_segment_animation']['device_ack'] = 0
cases['script_stage']['prior_script'] = "20:000401;22:" + segpl(0, 0, 9) + ";"
cases['script_stage']['device_ack'] = 0
cases['script_commit']['prior_script'] = "20:000101;21:0000E803;22:" + segpl(0, 0, 9) + ";"
cases['script_commit']['device_ack'] = 0
cases['activate_script']['prior_script'] = "20:000101;21:0000E803;22:" + segpl(0, 0, 9) + ";23:00"
cases['activate_script']['device_ack'] = 0
cases['script_abort']['device_ack'] = 0
cases['query_script']['device_ack'] = 0
cases['set_playback']['device_ack'] = 0

NAMES = {19: "SetPlayback", 20: "ScriptBegin", 21: "ScriptStage", 22: "ScriptSegment",
         23: "ScriptCommit", 24: "ScriptAbort", 25: "ActivateScript", 26: "QueryScript"}

seq = 40
new = []


def add(name, cmd, payload, note, result=0, **kw):
    global seq
    c = {"name": name, "direction": "app_to_device", "command": cmd, "seq": seq,
         "payload_hex": payload.hex().upper(), "frame_hex": frame(cmd, seq, payload),
         "command_name": NAMES[cmd], "frame_valid": True, "result_code": result,
         "note": note, "generated": GENERATED}
    c.update(kw)
    new.append(c)
    seq += 1


durations = [1000, 1500, 2000, 2500]

# ---- 2. happy-path download sequence: 4 stages, per-stage duration + per-segment effects ----
# 每一步都把「之前所有下发帧」写进 prior_script，所以向量不仅钉住单帧字节，
# 也钉住完整下载帧序列在设备侧真的能走通（apply_prior_script 用同一套纯模块重放）。
prior_ops = []


def add_step(name, cmd, payload, note):
    add(name, cmd, payload, note, result=0, device_ack=0,
        prior_script=";".join(prior_ops))
    prior_ops.append(f"{cmd}:{payload.hex().upper()}")


add_step('script_download_begin_4_stages', 20, bytes([0x00, 0x04, 0x01]),
         '#32 4 阶段剧本下发第 1 帧：Begin(script_id 0, 4 stages, 1 strip)')

for st, dur in enumerate(durations):
    add_step(f'script_download_stage_{st}', 21,
             bytes([0x00, st, dur & 0xff, (dur >> 8) & 0xff]),
             f'#32 阶段 {st} 时长 {dur}ms')

# payload: script_id, stage, strip, seg, start, end, type, hue_lo, hue_hi, sat[, period, p5, flags]
segments = [
    # stage 0: two static segments
    [(0, 0, 9, 0x00, 0x0000, 0xff, 0, 0, 0),
     (1, 10, 29, 0x00, 0x8000, 0xff, 0, 0, 0)],
    # stage 1: breathing + static
    [(0, 0, 9, 0x01, 0x0e10, 0xff, 1000, 0x60, 0x00),
     (1, 10, 29, 0x00, 0x4000, 0xff, 0, 0, 0)],
    # stage 2: rainbow + comet
    [(0, 0, 9, 0x02, 0x0000, 0xff, 2000, 0xff, 0x01),
     (1, 10, 29, 0x03, 0x2000, 0xff, 800, 0xc0, 0x00)],
    # stage 3: static + breathing (triangle)
    [(0, 0, 14, 0x00, 0x2222, 0x80, 0, 0, 0),
     (1, 15, 29, 0x01, 0x6000, 0x90, 1500, 0x20, 0x04)],
]
for st, row in enumerate(segments):
    for (segid, start, end, typ, hue, sat, period, p5, flags) in row:
        pl = bytes([0x00, st, 0x00, segid, start, end, typ,
                    hue & 0xff, (hue >> 8) & 0xff, sat])
        if typ != 0x00:
            pl += bytes([period & 0xff, (period >> 8) & 0xff, p5, flags])
        add_step(f'script_download_segment_s{st}g{segid}', 22, pl,
                 f'#32 阶段 {st} 段 {segid}：type 0x{typ:02X}，区间 [{start}-{end}]')

add_step('script_download_commit', 23, bytes([0x00]), '#32 整份校验通过 → 原子替换')

# commit 之后的下发序列完整了：后续控制命令的前置状态是「已提交的 4 阶段剧本」。
FULL_DOWNLOAD = ";".join(prior_ops)
add('script_download_activate_loop', 25, bytes([0x00, 0x01]),
    '#32 激活 script 0，loop=1', result=0, device_ack=0, prior_script=FULL_DOWNLOAD)
add('script_download_play', 19, bytes([0x01, 0x01]),
    '#32 play：从当前播放头（stage 0）开始，loop=1', result=0, prior_script=FULL_DOWNLOAD)
add('script_download_pause', 19, bytes([0x02, 0x01]),
    '#32 pause：冻结播放头与画面，playback_state=2', result=0, prior_script=FULL_DOWNLOAD)
add('script_download_resume', 19, bytes([0x01, 0x01]),
    '#32 play（暂停后）：从暂停点继续，不从头（靠 pause_offset_ms）', result=0,
    prior_script=FULL_DOWNLOAD)
add('script_download_stop', 19, bytes([0x00, 0x00]),
    '#32 stop：播放头回 stage 0，playback_state=0，画面回静态配置', result=0,
    prior_script=FULL_DOWNLOAD)
add('script_download_query', 26, bytes([0x00]), '#32 QueryScript(0) → 期望 ScriptSummary 0x85',
    result=0, prior_script=FULL_DOWNLOAD)


def segpl(stage, start, end, typ=0, hue=0, sat=0xff):
    return bytes([0, stage, 0, 0, start, end, typ, hue & 0xff, (hue >> 8) & 0xff, sat]).hex().upper()


# A previously committed 4-stage script (each stage one static segment [0-9]).
PRIOR_OK = ("20:000401;" +
            "".join(f"21:00{st:02d}{dur & 0xff:02X}{dur >> 8:02X};" for st, dur in enumerate(durations)) +
            "".join(f"22:{segpl(st, 0, 9)};" for st in range(4)) +
            "23:00")

# ---- 3. failure paths ----
add('script_commit_fail_zero_duration', 21, bytes([0x00, 0x00, 0x00, 0x00]),
    '#32 阶段时长为 0 → 命令层 InvalidParam（§11.3，脚本类命令额外校验）', result=1)

# Staging with a missing second duration, on top of a good committed script.
PRIOR_STAGING = "20:000201;21:0000E803;22:" + segpl(0, 0, 9) + ";"
add('script_commit_fail_missing_stage', 23, bytes([0x00]),
    '#32 缺第二阶段时长 → 整份校验失败；旧剧本完好（keep_script 断言）',
    result=0, device_ack=1, prior_script=PRIOR_OK + ";" + PRIOR_STAGING, keep_script="0:4")

# end = 30 with 30 leds (valid max is 29).
PRIOR_OOR = "20:000101;21:0000E803;22:" + segpl(0, 0, 30) + ";"
add('script_commit_fail_out_of_range', 23, bytes([0x00]),
    '#32 段 end=30 越界（30 灯，合法上界 29）→ commit 失败，旧剧本保留',
    result=0, device_ack=1, prior_script=PRIOR_OK + ";" + PRIOR_OOR, keep_script="0:4")

# seg0 [0-15] and seg1 [10-20] overlap.
PRIOR_OVERLAP = ("20:000101;21:0000E803;"
                 "22:" + segpl(0, 0, 15) + ";"
                 "22:" + bytes([0, 0, 0, 1, 10, 20, 0, 0, 0, 0xff]).hex().upper() + ";")
add('script_commit_fail_overlap', 23, bytes([0x00]),
    '#32 同灯带两段重叠 → commit 失败，旧剧本保留',
    result=0, device_ack=1, prior_script=PRIOR_OK + ";" + PRIOR_OVERLAP, keep_script="0:4")

add('script_begin_bad_stage_count', 20, bytes([0x00, 0x00, 0x01]),
    '#32 stage_count=0 → InvalidParam（协议 1..8）', result=1)
add('script_begin_bad_strip_count', 20, bytes([0x00, 0x04, 0x08]),
    '#32 strip_count 8 > 设备配置的 1 条灯带 → InvalidParam', result=1)
add('script_begin_bad_id', 20, bytes([0x04, 0x04, 0x01]),
    '#32 script_id=4 >= MAX_SCRIPTS(4) → InvalidParam', result=1)
add('script_stage_bad_index', 21, bytes([0x00, 0x09, 0xE8, 0x03]),
    '#32 stage_index 9 >= MAX_STAGES(8) → InvalidParam', result=1)
add('script_segment_unknown_type', 22, bytes([0, 0, 0, 0, 0, 9, 0x07, 0, 0, 0xff]),
    '#32 type 0x07 未知 → InvalidParam（§11.3 第 4 步）', result=1)
add('script_segment_bad_length', 22, bytes([0, 0, 0, 0, 0, 9, 0x00, 0, 0xff]),
    '#32 静态类型 9 字节载荷（应为 10）→ BadLength', result=4)
add('script_segment_bad_strip', 22, bytes([0, 0, 0x08, 0, 0, 9, 0, 0, 0, 0xff]),
    '#32 strip_id 8 >= MAX_STRIPS(8) → InvalidParam', result=1)
add('script_segment_without_begin', 22, bytes([0, 0, 0, 0, 0, 9, 0, 0, 0, 0xff]),
    '#32 形状合法但引擎侧没有对应 Begin → 设备回 InvalidParam（device_ack 钉住）',
    result=0, device_ack=1)
add('script_stage_without_begin', 21, bytes([0x00, 0x00, 0xE8, 0x03]),
    '#32 形状合法但引擎侧没有对应 Begin → InvalidParam', result=0, device_ack=1)
add('script_activate_uncommitted', 25, bytes([0x01, 0x01]),
    '#32 激活未提交剧本 → InvalidParam', result=0, device_ack=1)
add('script_abort_then_commit_fails', 23, bytes([0x00]),
    '#32 Abort 之后 commit → InvalidParam，旧剧本仍完好',
    result=0, device_ack=1, prior_script=PRIOR_OK, keep_script="0:4")
add('set_playback_bad_action', 19, bytes([0x03, 0x00]),
    '#32 action 3 未定义 → InvalidParam', result=1)
add('set_playback_bad_loop', 19, bytes([0x01, 0x02]),
    '#32 loop 2 非 0/1 → InvalidParam', result=1)


def frame_any(cmd, seqv, pl):
    body = bytes([0xA5, 0x02, cmd, seqv, len(pl)]) + bytes(pl)
    return (body + bytes([csum(body)])).hex().upper()


# ---- 4. device -> app script responses ----
new.append({"name": "script_summary_uncommitted", "direction": "device_to_app", "command": 0x85,
            "seq": seq, "payload_hex": "04000000",
            "frame_hex": frame_any(0x85, seq, bytes([0x04, 0, 0, 0])),
            "command_name": "ScriptSummary", "frame_valid": True,
            "note": "#32 查询未提交剧本：stage_count 0 / flags 0 / active 0", "generated": GENERATED})
new.append({"name": "script_progress_eight_frames", "direction": "device_to_app", "command": 0x86,
            "seq": seq, "payload_hex": "000800",
            "frame_hex": frame_any(0x86, seq, bytes([0, 8, 0])),
            "command_name": "ScriptProgress", "frame_valid": True,
            "note": "#32 已接受 8 帧（每 8 帧补一条 0x86）", "generated": GENERATED})
new.append({"name": "event_script_commit_failed", "direction": "device_to_app", "command": 0x81,
            "seq": 0, "payload_hex": "0202",
            "frame_hex": frame_any(0x81, 0, bytes([0x02, 0x02])),
            "command_name": "Event", "frame_valid": True,
            "note": "#32 Event 0x02 ScriptCommitFailed，detail = script_id 2", "generated": GENERATED})

d['cases'].extend(new)
open(p, 'w', encoding='utf-8', newline='\n').write(
    json.dumps(d, ensure_ascii=False, indent=2) + "\n")
print("total cases", len(d['cases']), "new", len(new))
