#!/usr/bin/env python
"""相位漂移分析（#162 票面第 3 项）：从串口 `ph:` 行反推相位偏差。

## 为什么需要这个脚本

#162 要求「两个部位不同步数不同时长，连续跑 30 分钟，记录最大的相位偏差」。
协议**没有**读「演到第几步」的命令（`QueryScene` 只回编好的步表），所以这个
数字拿不到。固件侧加了 `CONFIG_LUMEN_PLAYHEAD_LOG`（默认关闭、不进契约），
每 10 秒打一行 `ph:`，本脚本把日志变成「相位偏差」这个数。

## 「相位偏差」在这里的定义

一个部位的播放头由 `(t - origin)` 决定：

    elapsed_total = (t - origin) mod total          # total = 该部位各步时长之和
    步号与步内时间 = 在步表里按 elapsed_total 顺序定位

**闭式解残差**：把日志里的 `step` / `elapsed` 反算成「按步表定位出来的绝对
经过时间」`reconstructed`，与 `(t - origin) mod total` 比较：

    residual = reconstructed - (t - origin) mod total

- 残差恒为 0（±1ms 的整数截断）→ 播放头完全由绝对时间决定，**不存在累积漂移**；
- 残差随时间单调增大 → 是累加式实现，每秒都在丢一点时间，这才是真漂移。

**为什么不是「步号对不对」**：步号是离散的，10 秒采样下它一直在变，比对步号
只能证明「在动」，证明不了「没漂」。残差是连续的，才看得出累积。

## 两个部位之间的相对相位

同时打出的两个部位各有一个 `origin`。它们的**相对相位**

    phase_delta = ((t - origin_a) - (t - origin_b)) mod lcm(total_a, total_b)

在两者起点相同时应当恒为 0。本脚本报这个量的最大值与标准差。

用法：

    python scripts/analyze-playhead-log.py docs/evidence/playhead-30min.log
    python scripts/analyze-playhead-log.py --selftest

退出码：0 = 通过；1 = 有漂移 / 数据不足；2 = 日志格式不对。
"""

import argparse
import math
import re
import sys
from collections import defaultdict

# `ph: t=1234 strip=0 part=0 step=3 elapsed=42 dur=100 total=800 loop=1 origin=1000`
LINE = re.compile(
    r"ph:\s+t=(\d+)\s+strip=(\d+)\s+part=(\d+)\s+"
    r"(?:idle\s+steps=(\d+)\s+on=(\d+)|"
    r"step=(\d+)\s+elapsed=(\d+)\s+dur=(\d+)\s+total=(\d+)\s+loop=(\d+)\s+origin=(\d+))"
)

# `ph: table strip=0 part=0 steps=100,100,100 total=800 loop=1`
TABLE = re.compile(
    r"ph:\s+table\s+strip=(\d+)\s+part=(\d+)\s+steps=([\d,]+)\s+total=(\d+)\s+loop=(\d+)"
)

# 整数截断允许的误差（毫秒）。`now_ms` 与步内时间都是 uint32 毫秒，
# 一次减法的量化误差最多 1ms；给 2ms 余量。
RESIDUAL_TOLERANCE_MS = 2


class Sample:
    __slots__ = ("t", "strip", "part", "step", "elapsed", "dur", "total", "loop", "origin")

    def __init__(self, t, strip, part, step, elapsed, dur, total, loop, origin):
        self.t = t
        self.strip = strip
        self.part = part
        self.step = step
        self.elapsed = elapsed
        self.dur = dur
        self.total = total
        self.loop = loop
        self.origin = origin


def parse(text):
    """把日志拆成 (按部位分组的样本, 固件报的步表, 无法解析的 ph: 行数)。

    步表优先用固件自己打的 `ph: table` 行——它比从采样反推可靠得多（10 秒
    采样配 800ms 循环会永远落在同一相位，反推必然失败）。
    """
    by_part = defaultdict(list)
    tables = {}
    bad = 0
    for line in text.splitlines():
        if "ph:" not in line:
            continue
        mt = TABLE.search(line)
        if mt is not None:
            key = (int(mt.group(1)), int(mt.group(2)))
            tables[key] = [int(x) for x in mt.group(3).split(",")]
            continue
        m = LINE.search(line)
        if m is None:
            bad += 1
            continue
        g = m.groups()
        if g[3] is not None:  # idle 形态
            continue
        by_part[(int(g[1]), int(g[2]))].append(
            Sample(int(g[0]), int(g[1]), int(g[2]), int(g[5]), int(g[6]), int(g[7]),
                   int(g[8]), int(g[9]), int(g[10]))
        )
    for samples in by_part.values():
        samples.sort(key=lambda s: s.t)
    return by_part, tables, bad


def step_table_from_samples(samples):
    """（保留给没有 `ph: table` 行的旧日志）从样本反推步表。

    10 秒采样配 800ms 循环会永远落在同一相位，这个方法对那种日志必然失败
    ——所以固件现在直接打 `ph: table`。这里只作为旧日志的退路。
    """
    durations = {}
    for s in samples:
        if s.step in durations and durations[s.step] != s.dur:
            return None  # 同一步出现两个时长 = 日志自相矛盾
        durations[s.step] = s.dur
    if not durations:
        return None
    if sorted(durations) != list(range(len(durations))):
        return None
    return [durations[i] for i in sorted(durations)]


def residual_ms(sample, table):
    """闭式解残差：按步表定位出的绝对时间 - (t - origin) mod total。

    返回 None 表示这个样本与步表不一致（越界 / 时长不符），本身是个错误。
    """
    if sample.step >= len(table):
        return None
    if sample.dur != table[sample.step]:
        return None
    if sample.total != sum(table):
        return None
    if sample.elapsed >= sample.dur:
        # 步内时间必须严格小于该步时长；等于就是「该跨步没跨」。
        return None
    elapsed_total = (sample.t - sample.origin) % sample.total
    reconstructed = sum(table[: sample.step]) + sample.elapsed
    # 用循环内的最短距离表示残差（跨循环边界时不要报成 ±total）。
    diff = reconstructed - elapsed_total
    if diff > sample.total // 2:
        diff -= sample.total
    elif diff < -(sample.total // 2):
        diff += sample.total
    return diff


def analyse(text):
    """返回一份可打印的报告 dict。"""
    by_part, tables, bad = parse(text)
    if not by_part:
        return {"ok": False, "reason": "日志里没有任何可解析的 ph: 行", "bad": bad}

    report = {"ok": True, "bad": bad, "parts": {}, "problems": []}
    for key, samples in sorted(by_part.items()):
        table = tables.get(key)
        source = "固件 ph: table 行"
        if table is None:
            # 退路：日志从中间开始抓（设备早已在跑）时，`ph: table` 那行不在
            # 窗口里。这时从样本反推——但**只在采样足够密时可信**：10 秒采样
            # 配 700ms 循环只会落到 7 个固定相位，反推可能只覆盖部分步。
            # 所以反推出来的表必须与样本里的 `total` 完全一致，否则拒绝。
            table = step_table_from_samples(samples)
            source = "从样本反推"
            if table is None:
                report["problems"].append(
                    f"部位 {key}：日志里没有 `ph: table` 行，且样本反推不出步表"
                )
                continue
        if len(table) == 0 or len(table) > 8:
            report["problems"].append(f"部位 {key}：步表长度 {len(table)} 不合法")
            continue
        # 反推的表必须与样本自报的 total 一致（固件报的 total 是权威）。
        reported_totals = {s.total for s in samples}
        if len(reported_totals) != 1 or sum(table) != next(iter(reported_totals)):
            report["problems"].append(
                f"部位 {key}：步表之和 {sum(table)} 与日志里的 total "
                f"{sorted(reported_totals)} 不一致（{source}）"
            )
            continue
        residuals = []
        broken = 0
        for s in samples:
            r = residual_ms(s, table)
            if r is None:
                broken += 1
            else:
                residuals.append(r)
        if not residuals:
            report["problems"].append(f"部位 {key}：没有一条样本能算出残差")
            continue
        span_s = (samples[-1].t - samples[0].t) / 1000.0
        report["parts"][key] = {
            "samples": len(samples),
            "steps": table,
            "table_source": source,
            "total_ms": sum(table),
            "loop": samples[0].loop,
            "span_s": span_s,
            "residual_max_abs_ms": max(abs(r) for r in residuals),
            "residual_min_ms": min(residuals),
            "residual_max_ms": max(residuals),
            "broken": broken,
            "residuals": residuals,
        }

    # 两个部位的相对相位
    if len(report["parts"]) >= 2:
        keys = sorted(report["parts"])[:2]
        a_samples = by_part[keys[0]]
        b_samples = by_part[keys[1]]
        b_by_t = {s.t: s for s in b_samples}
        deltas = []
        for sa in a_samples:
            sb = b_by_t.get(sa.t)
            if sb is None:
                continue
            # 相对相位 = 两者「绝对经过时间」之差，按两者周期的公倍数折回。
            ea = (sa.t - sa.origin) % report["parts"][keys[0]]["total_ms"]
            eb = (sb.t - sb.origin) % report["parts"][keys[1]]["total_ms"]
            period = math.lcm(report["parts"][keys[0]]["total_ms"],
                              report["parts"][keys[1]]["total_ms"])
            d = (ea - eb) % period
            deltas.append(d)
        if deltas:
            # 相位差在 [0, period) 上绕圈，用「圆统计」判漂移：如果它稳定，
            # 所有点会挤在一个簇里；如果持续漂移，点会铺满整个圆。
            mean = sum(deltas) / len(deltas)
            spread = max(abs(d - mean) for d in deltas)
            report["relative"] = {
                "parts": keys,
                "samples": len(deltas),
                "mean_ms": mean,
                "spread_ms": spread,
                "min_ms": min(deltas),
                "max_ms": max(deltas),
                "period_ms": period,
            }

    return report


def print_report(report, minutes):
    if not report.get("ok"):
        print(f"FAIL  {report.get('reason')}")
        return 1

    print(f"# 相位漂移分析（{minutes:.1f} 分钟窗口）")
    if report["bad"]:
        print(f"  无法解析的 ph: 行：{report['bad']} 条（已跳过）")

    failed = False
    for key, part in sorted(report["parts"].items()):
        strip, pid = key
        steps = "+".join(str(d) for d in part["steps"])
        print(
            f"\n部位 strip={strip} part={pid}：{part['samples']} 样本 / "
            f"{part['span_s']:.0f}s / {len(part['steps'])} 步（{steps} = {part['total_ms']}ms）"
            f" / loop={part['loop']}"
        )
        print(
            f"  闭式解残差：min={part['residual_min_ms']}ms "
            f"max={part['residual_max_ms']}ms |max|={part['residual_max_abs_ms']}ms"
        )
        if part["broken"]:
            print(f"  ** {part['broken']} 条样本与步表不自洽（越界 / 时长不符 / elapsed >= dur）**")
            failed = True
        if part["residual_max_abs_ms"] > RESIDUAL_TOLERANCE_MS:
            print(f"  ** 残差超过 {RESIDUAL_TOLERANCE_MS}ms 容差 → 存在累积漂移 **")
            failed = True
        if part["span_s"] < minutes * 60 * 0.95:
            print(f"  ** 覆盖时长不足（{part['span_s']:.0f}s < {minutes * 60:.0f}s）**")
            failed = True

    rel = report.get("relative")
    if rel is not None:
        print(
            f"\n相对相位（{rel['parts'][0]} vs {rel['parts'][1]}，周期 {rel['period_ms']}ms）："
            f"{rel['samples']} 对样本"
        )
        print(
            f"  均值 {rel['mean_ms']:.1f}ms / 极差 {rel['spread_ms']:.1f}ms "
            f"/ 区间 [{rel['min_ms']}, {rel['max_ms']}]"
        )
        # 两个部位周期互质（如 800ms 与 3000ms，lcm = 6000ms）时，相位差本来
        # 就会铺满整个圆——那不是漂移。真正该看的是**每个部位自己的残差**。
        if rel["period_ms"] > 0 and rel["spread_ms"] > rel["period_ms"] * 0.9:
            print("  说明：两者周期互质，相位差在圆上均匀分布是**预期**的，不是漂移。")
            print("        漂移判据看上面的闭式解残差。")
    else:
        print("\n（只有一个部位有数据，跳过相对相位）")

    for problem in report.get("problems", []):
        print(f"  ** {problem} **")
        failed = True

    print()
    if failed:
        print("FAIL  有项未通过（见上面的 ** 标记）")
        return 1
    print("PASS  播放头完全由绝对时间决定，无累积漂移")
    return 0


def selftest():
    """自检：合成三种日志，确认判定逻辑真的能分开「无漂移」与「有漂移」。"""
    failures = []

    def check(name, ok, detail=""):
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
        if not ok:
            failures.append(name)

    def make_log(parts, seconds=600, period_ms=10000, drift_per_s=0.0):
        """合成日志。`drift_per_s` = 每秒被吞掉的毫秒数（累加式实现的典型形态）。

        每个部位先打一行 `ph: table`（与固件一致），再打采样行。
        时间基准与固件一致：`origin` 是某个过去的时刻，`t` 从 `origin` 起单调增。
        """
        lines = []
        for strip, pid, table, loop, origin in parts:
            total = sum(table)
            steps = ",".join(str(d) for d in table)
            lines.append(
                f"ph: table strip={strip} part={pid} steps={steps} total={total} loop={loop}"
            )
        for elapsed_s in range(0, seconds + 1, period_ms // 1000):
            for strip, pid, table, loop, origin in parts:
                total = sum(table)
                t = origin + elapsed_s * 1000
                # 累加式实现会「吞掉」时间：真实经过时间比名义少
                real = (t - origin) - int(drift_per_s * elapsed_s)
                elapsed_total = real % total
                acc = 0
                step = 0
                for i, d in enumerate(table):
                    if elapsed_total < acc + d:
                        step = i
                        break
                    acc += d
                elapsed = elapsed_total - acc
                lines.append(
                    f"I (1234) lumen_engine: ph: t={t} strip={strip} part={pid} "
                    f"step={step} elapsed={elapsed} dur={table[step]} total={total} "
                    f"loop={loop} origin={origin}"
                )
        return "\n".join(lines)

    parts = [(0, 0, [100] * 8, 1, 1000), (0, 1, [3000], 1, 1000)]

    # 1) 无漂移
    r = analyse(make_log(parts))
    ok = r.get("ok") and len(r.get("parts", {})) == 2 and all(
        p["residual_max_abs_ms"] <= RESIDUAL_TOLERANCE_MS for p in r["parts"].values()
    )
    check("无漂移日志被判为通过", ok, f"parts={len(r.get('parts', {}))} problems={r.get('problems')}")

    # 2) 每秒吞 0.05ms（30 分钟 = 90ms，必须被抓出来）
    r = analyse(make_log(parts, seconds=1800, drift_per_s=0.05))
    worst = max((p["residual_max_abs_ms"] for p in r.get("parts", {}).values()), default=0)
    check("每秒 0.05ms 的累积漂移被抓出", worst > RESIDUAL_TOLERANCE_MS, f"|max|={worst}ms")

    # 3) 没有 ph: table 行、且反推出来的表与 total 不符 → 拒绝判定（不假绿）
    no_table = "\n".join(
        f"ph: t={t} strip=0 part=0 step=0 elapsed=0 dur=100 total=800 loop=1 origin=0"
        for t in (10000, 20000)
    )
    r = analyse(no_table)
    ok = r.get("ok") and any("不一致" in p or "反推" in p for p in r.get("problems", []))
    check("缺 ph: table 且反推不自洽时拒绝判定（不假绿）", ok, str(r.get("problems")))

    # 3b) 没有 ph: table 行、但采样够密能反推出完整步表 → 允许（标来源）
    dense = []
    table8 = [100] * 8
    for t in range(0, 120000, 100):
        et = t % 800
        step = min(et // 100, 7)
        dense.append(
            f"ph: t={t} strip=0 part=0 step={step} elapsed={et - step * 100} "
            f"dur=100 total=800 loop=1 origin=0"
        )
    r = analyse("\n".join(dense))
    part = r.get("parts", {}).get((0, 0))
    ok = part is not None and part["table_source"] == "从样本反推" and len(part["steps"]) == 8
    check("采样够密时允许从样本反推（并标出来源）", ok,
          f"source={part['table_source'] if part else 'n/a'} steps={len(part['steps']) if part else 'n/a'}")

    # 4) 日志自相矛盾（elapsed >= dur）→ 计入 broken，不是静默通过
    broken_log = make_log(parts, seconds=60)
    broken_log += "\nph: t=99999 strip=0 part=1 step=0 elapsed=99999 dur=3000 total=3000 loop=1 origin=1000"
    r = analyse(broken_log)
    part = r.get("parts", {}).get((0, 1))
    check("elapsed >= dur 的样本被记为 broken", part is not None and part["broken"] >= 1,
          f"broken={part['broken'] if part else 'n/a'}")

    print()
    if failures:
        print(f"FAIL  自检 {len(failures)} 项未过：{failures}")
        return 1
    print("PASS  自检全部通过")
    return 0


def main():
    ap = argparse.ArgumentParser(description="相位漂移分析（#162）")
    ap.add_argument("log", nargs="?", help="capture-serial.py 抓下来的日志文件")
    ap.add_argument("--minutes", type=float, default=30.0, help="期望的观察窗口（分钟）")
    ap.add_argument("--selftest", action="store_true", help="先验证判定逻辑本身")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if not args.log:
        ap.error("需要日志文件，或 --selftest")

    try:
        with open(args.log, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError as exc:
        print(f"FAIL  读不到 {args.log}：{exc}")
        return 2

    report = analyse(text)
    return print_report(report, args.minutes)


if __name__ == "__main__":
    sys.exit(main())
