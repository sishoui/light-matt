#!/usr/bin/env node
/*
 * 校验 docs/protocol-testvectors-v5.json 与 docs/protocol-v5.md 的一致性。
 *
 * 为什么需要：向量是生成出来的，生成器本身可能有 bug（本项目已经发生过一次：
 * 彩虹 span 按 2 字节传值，导致段载荷整体错位 1 字节）。所以要有独立的校验，
 * 只读 JSON、不相信生成器。
 *
 * v5 的校验面比 v4 大一圈：
 *   - 信封（magic / version / 长度 / CRC 覆盖范围）；
 *   - 命令表载荷宽度（含新增的布局族与场景族）；
 *   - **退役命令必须回 0x02**（票 #155 的验收项，v4 命令一律不被执行）；
 *   - 层编码规则（类型 / flags 保留位 / 周期区间 / 空层 level）；
 *   - 布局与场景字段的语义约束（段区间、步数、循环三值、时长区间）；
 *   - State 32 字节布局、报告宽度、设备版本的 0x0500；
 *   - 分片重组与 ctrl 头。
 *
 * 用法：node scripts/check-protocol-testvectors-v5.mjs
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS = path.join(ROOT, 'docs', 'protocol-testvectors-v5.json');

const MAGIC = 'A6';
const VERSION = '05';
const HEADER = 8; // magic1 + ver1 + cmd1 + seq1 + len2 + crc2
const MAX_FRAME = 240;
const MAX_PAYLOAD = 232;

/* 契约 §1.1 的常量。 */
const STATE_BYTES = 32;
const LAYER_BYTES = 9;
const LAYOUT_PART_PAYLOAD = 28;
const LAYOUT_REPORT_BYTES = 44;
const SCENE_STEP_PAYLOAD = 24;
const SCENE_NAME_PAYLOAD = 26;
const NAME_BYTES = 24;
const MAX_PARTS = 8;
const MAX_PART_SEGS = 8;
const MAX_STEPS = 8;
const MAX_SCENES = 3;
const MAX_STRIPS = 8;
const MAX_LEDS = 100;
const STEP_MIN_MS = 100;
const STEP_MAX_MS = 60000;
const LAYER_LEVEL_MAX = 100;
const EMPTY_LAYER = 0xff;

/* 契约 §6 的命令表：每个命令的期望载荷长度。 */
const EXPECTED_PAYLOAD = new Map([
  [0x01, 1], [0x02, 1],
  [0x05, 0], [0x06, 3], [0x07, 0],
  [0x1b, 2], [0x1c, 0], [0x1d, 0],
  /* 布局族 */
  [0x20, 2], [0x21, LAYOUT_PART_PAYLOAD], [0x22, 5], [0x23, 0], [0x24, 1],
  /* 场景族 */
  [0x25, 6], [0x26, SCENE_STEP_PAYLOAD], [0x27, SCENE_NAME_PAYLOAD], [0x28, 1], [0x29, 1],
]);

/* v5 明确退役的命令（必须回 0x02）。 */
const RETIRED_COMMANDS = new Set([
  0x03, 0x04,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1e,
]);

/* 设备 → 小程序报告（§7.4）。0x83-0x86 在 v5 已删除。 */
const EXPECTED_REPORT = new Map([
  [0x80, 2], [0x81, 2], [0x82, STATE_BYTES],
  [0x87, 24], [0x88, 15],
  [0x89, LAYOUT_REPORT_BYTES], [0x8a, 2],
  [0x8b, 6], [0x8c, SCENE_STEP_PAYLOAD], [0x8d, SCENE_NAME_PAYLOAD],
]);

/* v5 已删除的报告：不得在合法帧里出现。 */
const REMOVED_REPORTS = new Set([0x83, 0x84, 0x85, 0x86]);

/* 灯效类型与参数规则（docs/effects-spec.md §2，v5 未改）。 */
const KNOWN_TYPES = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
const TYPE_STATIC = 0x00;
const TYPE_BREATHING = 0x01;
const TYPE_RAINBOW = 0x02;
const TYPE_COMET = 0x03;
const TYPE_STROBE = 0x04;
const TYPE_HEARTBEAT = 0x05;
const TYPE_OFF = 0x06;
const TYPE_FLICKER = 0x07;
const STROBE_MIN_PERIOD_MS = 100;
const HEARTBEAT_MIN_PERIOD_MS = 500;
const HEARTBEAT_MAX_PERIOD_MS = 1500;
const BREATHING_MIN_PERIOD_MS = 334;
const ANIMATION_MIN_PERIOD_MS = 200;
const FLICKER_MIN_PERIOD_MS = 334;
const COMET_FLAGS_RESERVED = 0xf0;
const COMET_DENSITY_SHIFT = 2;
const COMET_DENSITY_MASK = 0x0c;

let failures = 0;
function check(ok, msg) {
  if (!ok) {
    console.log(`FAIL: ${msg}`);
    failures++;
  }
}

const doc = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
const cases = doc.cases;

check(doc.protocol_version === 5, 'protocol_version is 5');
check(doc.magic === '0xA6', 'magic is 0xA6');
check(doc.state_bytes === STATE_BYTES, `state_bytes is ${STATE_BYTES}`);
check(doc.state_read_example_hex.length / 2 === STATE_BYTES,
  `state example is ${STATE_BYTES} bytes, got ${doc.state_read_example_hex.length / 2}`);
check(cases.length > 0, 'has cases');

const byName = new Map(cases.map((c) => [c.name, c]));

function payloadBytes(c) {
  const out = [];
  for (let i = 0; i < c.payload_hex.length; i += 2) {
    out.push(parseInt(c.payload_hex.slice(i, i + 2), 16));
  }
  return out;
}

/** 一层（9 字节）的解析视图。 */
function layerAt(bytes, off) {
  return {
    type: bytes[off],
    hue: bytes[off + 1] | (bytes[off + 2] << 8),
    sat: bytes[off + 3],
    period: bytes[off + 4] | (bytes[off + 5] << 8),
    p5: bytes[off + 6],
    flags: bytes[off + 7],
    level: bytes[off + 8],
    params: bytes.slice(off + 1, off + 8),
  };
}

/* ---------------- 信封 ---------------- */

for (const c of cases) {
  const bytes = c.frame_len;
  const hexBytes = c.frame_hex.length / 2;
  check(hexBytes === bytes, `${c.name}: frame_hex is ${hexBytes}B but frame_len says ${bytes}`);

  if (c.frame_valid) {
    check(bytes === HEADER + c.payload_len,
      `${c.name}: frame_len ${bytes} != ${HEADER} + payload ${c.payload_len}`);
    check(bytes <= MAX_FRAME, `${c.name}: frame ${bytes}B exceeds ${MAX_FRAME}`);
    check(c.payload_len <= MAX_PAYLOAD, `${c.name}: payload ${c.payload_len}B exceeds ${MAX_PAYLOAD}`);

    check(c.frame_hex.slice(0, 2) === MAGIC, `${c.name}: magic is not 0x${MAGIC}`);
    check(c.frame_hex.slice(2, 4) === VERSION, `${c.name}: version is not 0x${VERSION}`);

    const lenLo = parseInt(c.frame_hex.slice(8, 10), 16);
    const lenHi = parseInt(c.frame_hex.slice(10, 12), 16);
    check((lenLo | (lenHi << 8)) === c.payload_len,
      `${c.name}: length field ${lenLo | (lenHi << 8)} != payload_len ${c.payload_len}`);
  }

  // 分片：剥掉 1 字节 ctrl 头后必须正好拼回逻辑帧
  const reassembled = c.chunks_hex.map((h) => h.slice(2)).join('');
  check(reassembled === c.frame_hex, `${c.name}: chunks do not reassemble to the logical frame`);

  c.chunks_hex.forEach((h, i) => {
    const ctrl = parseInt(h.slice(0, 2), 16);
    check(((ctrl & 0x80) !== 0) === (i === 0), `${c.name}: chunk ${i} FIRST flag wrong`);
    check(((ctrl & 0x40) !== 0) === (i === c.chunks_hex.length - 1),
      `${c.name}: chunk ${i} LAST flag wrong`);
    check(h.length / 2 - 1 <= 179, `${c.name}: chunk ${i} data exceeds 179B`);
  });
}

/* ---------------- 命令表：载荷宽度 / 退役 / 已删报告 ---------------- */

for (const c of cases) {
  if (!c.frame_valid) {
    continue;
  }
  if (c.direction === 'app_to_device') {
    if (EXPECTED_PAYLOAD.has(c.command)) {
      const want = EXPECTED_PAYLOAD.get(c.command);
      check(c.payload_len === want,
        `${c.name}: command 0x${c.command.toString(16)} payload ${c.payload_len}B != contract ${want}B`);
    } else {
      check(false, `${c.name}: command 0x${c.command.toString(16)} is not in the v5 command table`);
    }
  } else if (c.direction === 'device_to_app') {
    check(!REMOVED_REPORTS.has(c.command),
      `${c.name}: report 0x${c.command.toString(16)} was removed in v5`);
    if (EXPECTED_REPORT.has(c.command)) {
      check(c.payload_len === EXPECTED_REPORT.get(c.command),
        `${c.name}: report 0x${c.command.toString(16)} payload ${c.payload_len}B != contract`);
    }
  } else {
    check(false, `${c.name}: unknown direction ${c.direction}`);
  }
}

/* 每个 v5 命令至少一条合法用例；每条退役命令至少一条 0x02 用例。 */
const appCmds = new Set(
  cases.filter((c) => c.direction === 'app_to_device' && c.frame_valid).map((c) => c.command),
);
for (const cmd of EXPECTED_PAYLOAD.keys()) {
  check(appCmds.has(cmd), `command 0x${cmd.toString(16)} has no valid vector`);
}
const devCmds = new Set(cases.filter((c) => c.direction === 'device_to_app').map((c) => c.command));
for (const cmd of EXPECTED_REPORT.keys()) {
  check(devCmds.has(cmd), `report 0x${cmd.toString(16)} has no vector`);
}

/*
 * 退役命令：票 #155 的验收项「固件收到 v4 的写分区 / 剧本命令回未知命令」。
 *
 * 注意本项目的 `frame_valid` 语义是「这条命令应当成功」，不是「信封合法」。
 * 所以退役命令是 frame_valid=false + result 0x02，但**信封必须完好**——
 * 这正是要证明的：拒收来自命令字退役，不是来自坏信封。
 */
const RETIRED_EXPECT = new Map([
  [0x03, 3], [0x04, 5],
  [0x10, 23], [0x11, 2], [0x12, 1], [0x13, 2],
  [0x14, 3], [0x15, 6], [0x16, 25], [0x17, 1],
  [0x18, 1], [0x19, 2], [0x1a, 1], [0x1e, 1],
]);
for (const [cmd, wantLen] of RETIRED_EXPECT) {
  const found = cases.filter((c) => c.command === cmd && c.name.startsWith('retired_'));
  check(found.length === 1, `retired command 0x${cmd.toString(16)} must have exactly 1 vector, got ${found.length}`);
  if (found.length === 1) {
    const c = found[0];
    check(c.frame_valid === false, `${c.name}: retired command must not be marked as succeeding`);
    check(c.result_code === 0x02, `${c.name}: result 0x${c.result_code.toString(16)} != 0x02 UnknownCommand`);
    check(c.payload_len === wantLen,
      `${c.name}: payload ${c.payload_len}B != v4 width ${wantLen}B (retirement must not depend on length)`);
    check(c.frame_len === HEADER + c.payload_len, `${c.name}: envelope length field is wrong`);
    check(c.frame_hex.slice(0, 2) === MAGIC, `${c.name}: magic is not 0x${MAGIC}`);
    check(c.frame_hex.slice(2, 4) === VERSION, `${c.name}: version is not 0x${VERSION}`);
  }
}
for (const cmd of RETIRED_COMMANDS) {
  check(
    cases.some((c) => c.command === cmd && c.result_code === 0x02),
    `retired command 0x${cmd.toString(16)} has no UnknownCommand vector`,
  );
}
/* 退役命令不得出现在合法帧里。 */
for (const c of cases) {
  if (RETIRED_COMMANDS.has(c.command)) {
    check(!c.frame_valid, `${c.name}: retired command must not be a valid frame`);
  }
}

/* ---------------- 列表族：结构校验 ---------------- */

function expectCase(name, fn) {
  const c = byName.get(name);
  check(!!c, `missing case: ${name}`);
  if (c) {
    fn(c);
  }
}

/* LayoutWrite：strip_id < 8，part_count ≤ 8。 */
for (const c of cases.filter((x) => x.command === 0x20 && x.frame_valid)) {
  const p = payloadBytes(c);
  check(p[0] < MAX_STRIPS, `${c.name}: strip_id ${p[0]} exceeds ${MAX_STRIPS - 1}`);
  check(p[1] <= MAX_PARTS, `${c.name}: part_count ${p[1]} exceeds ${MAX_PARTS}`);
}

/* LayoutPart：名字 NUL 补齐，name_len 与实际内容一致，seg_count ≤ 8。 */
for (const c of cases.filter((x) => x.command === 0x21 && x.frame_valid)) {
  const p = payloadBytes(c);
  const nameLen = p[2];
  check(nameLen <= NAME_BYTES, `${c.name}: name_len ${nameLen} exceeds ${NAME_BYTES}`);
  check(p.length === LAYOUT_PART_PAYLOAD, `${c.name}: payload must be ${LAYOUT_PART_PAYLOAD}B`);
  /* name_len 之后的字节必须全 0（NUL 填充）。 */
  for (let i = nameLen; i < NAME_BYTES; i++) {
    check(p[3 + i] === 0, `${c.name}: name padding byte ${i} must be 0, got 0x${p[3 + i].toString(16)}`);
  }
  check(p[27] <= MAX_PART_SEGS, `${c.name}: seg_count ${p[27]} exceeds ${MAX_PART_SEGS}`);
}

/* LayoutSeg：start ≤ end，所有下标 < 8。 */
for (const c of cases.filter((x) => x.command === 0x22 && x.frame_valid)) {
  const p = payloadBytes(c);
  check(p[0] < MAX_STRIPS, `${c.name}: strip_id out of range`);
  check(p[1] < MAX_PARTS, `${c.name}: part_id ${p[1]} exceeds ${MAX_PARTS - 1}`);
  check(p[2] < MAX_PART_SEGS, `${c.name}: seg_id ${p[2]} exceeds ${MAX_PART_SEGS - 1}`);
  check(p[3] <= p[4], `${c.name}: start ${p[3]} > end ${p[4]}`);
  check(p[4] < MAX_LEDS, `${c.name}: end ${p[4]} exceeds MAX_LEDS`);
}

/* 三个部位必须在一条链上互不重叠（S3：一颗灯珠只属一个部位）。 */
{
  const segs = cases
    .filter((x) => x.command === 0x22 && x.frame_valid)
    .map((x) => payloadBytes(x))
    .filter((p) => p[0] === 0)
    .map((p) => [p[3], p[4]]);
  const sorted = [...segs].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i++) {
    check(sorted[i][0] > sorted[i - 1][1],
      `layout segments on strip0 overlap: ${sorted[i - 1]} and ${sorted[i]}`);
  }
}

/* ScenePart：loop ∈ {0,1,2}，on ∈ {0,1}，step_count ≤ 8。 */
for (const c of cases.filter((x) => x.command === 0x25 && x.frame_valid)) {
  const p = payloadBytes(c);
  check(p[0] < MAX_SCENES, `${c.name}: scene_id ${p[0]} exceeds ${MAX_SCENES - 1}`);
  check(p[1] < MAX_STRIPS, `${c.name}: strip_id out of range`);
  check(p[2] < MAX_PARTS, `${c.name}: part_id out of range`);
  check(p[3] <= MAX_STEPS, `${c.name}: step_count ${p[3]} exceeds ${MAX_STEPS}`);
  check(p[4] <= 2, `${c.name}: loop ${p[4]} must be 0/1/2`);
  check(p[5] <= 1, `${c.name}: on ${p[5]} must be 0/1`);
}

/* SceneStep：时长区间、层规则。 */
for (const c of cases.filter((x) => x.command === 0x26 && x.frame_valid)) {
  const p = payloadBytes(c);
  const duration = p[4] | (p[5] << 8);
  check(duration >= STEP_MIN_MS && duration <= STEP_MAX_MS,
    `${c.name}: duration ${duration} outside ${STEP_MIN_MS}-${STEP_MAX_MS}`);
  check(p[0] < MAX_SCENES, `${c.name}: scene_id ${p[0]} exceeds ${MAX_SCENES - 1}`);
  check(p[3] < MAX_STEPS, `${c.name}: step_index ${p[3]} exceeds ${MAX_STEPS - 1}`);
}

/* ---------------- 层编码规则 ---------------- */

/* 层在载荷里的基址：只有 SceneStep 带层，且层从偏移 6 起。 */
const LAYER_BASE = { 0x26: 6 };

for (const c of cases) {
  if (!c.frame_valid || !LAYER_BASE[c.command]) {
    continue;
  }
  const bytes = payloadBytes(c);
  const base = LAYER_BASE[c.command];
  for (const li of [0, 1]) {
    const off = base + li * LAYER_BYTES;
    const layer = layerAt(bytes, off);
    check(layer.level <= LAYER_LEVEL_MAX,
      `${c.name}: layer${li} level ${layer.level} exceeds ${LAYER_LEVEL_MAX}`);
    if (layer.type === EMPTY_LAYER) {
      check(layer.level === 0, `${c.name}: empty layer${li} must have level 0`);
      check(layer.params.every((b) => b === 0),
        `${c.name}: empty layer${li} params must all be 0`);
      continue;
    }
    check(KNOWN_TYPES.has(layer.type),
      `${c.name}: layer${li} type 0x${layer.type.toString(16)} is not known`);
    if (layer.type === TYPE_STATIC) {
      check(layer.params.slice(3).every((b) => b === 0),
        `${c.name}: static layer${li} reserved bytes must be 0`);
    } else if (layer.type === TYPE_BREATHING) {
      check((layer.flags & 0xf8) === 0, `${c.name}: layer${li} breathing flags reserved bits set`);
      check(layer.period === 0 || layer.period >= BREATHING_MIN_PERIOD_MS,
        `${c.name}: layer${li} breathing period ${layer.period} < ${BREATHING_MIN_PERIOD_MS}`);
      check(layer.p5 <= 100, `${c.name}: layer${li} breathing p5 ${layer.p5} > 100`);
    } else if (layer.type === TYPE_RAINBOW) {
      check((layer.flags & 0xfe) === 0, `${c.name}: layer${li} rainbow flags reserved bits set`);
      check(layer.period === 0 || layer.period >= ANIMATION_MIN_PERIOD_MS,
        `${c.name}: layer${li} period ${layer.period} < ${ANIMATION_MIN_PERIOD_MS}`);
    } else if (layer.type === TYPE_COMET) {
      check((layer.flags & COMET_FLAGS_RESERVED) === 0,
        `${c.name}: layer${li} comet flags bit4-7 must be 0`);
      check(layer.period === 0 || layer.period >= ANIMATION_MIN_PERIOD_MS,
        `${c.name}: layer${li} comet period ${layer.period} < ${ANIMATION_MIN_PERIOD_MS}`);
    } else if (layer.type === TYPE_FLICKER) {
      check(layer.flags === 0, `${c.name}: layer${li} flicker flags must be 0`);
      check(layer.period === 0 || layer.period >= FLICKER_MIN_PERIOD_MS,
        `${c.name}: layer${li} flicker period ${layer.period} < ${FLICKER_MIN_PERIOD_MS}`);
    } else if (layer.type === TYPE_STROBE) {
      check(layer.flags === 0, `${c.name}: layer${li} strobe flags must be 0`);
      check(layer.period === 0 || layer.period >= STROBE_MIN_PERIOD_MS,
        `${c.name}: layer${li} strobe period ${layer.period} < ${STROBE_MIN_PERIOD_MS}`);
    } else if (layer.type === TYPE_HEARTBEAT) {
      check((layer.flags & 0xfe) === 0, `${c.name}: layer${li} heartbeat flags reserved bits set`);
      check(
        layer.period === 0 ||
          (layer.period >= HEARTBEAT_MIN_PERIOD_MS && layer.period <= HEARTBEAT_MAX_PERIOD_MS),
        `${c.name}: layer${li} heartbeat period ${layer.period} outside range`,
      );
    } else if (layer.type === TYPE_OFF) {
      check(layer.params.every((b) => b === 0), `${c.name}: OFF layer${li} params must all be 0`);
    }
  }
  /* layer0 必须非空（§7.1）。 */
  check(layerAt(bytes, base).type !== EMPTY_LAYER || !c.frame_valid,
    `${c.name}: layer0 must not be empty on a valid frame`);
}

/* ---------------- 关键用例的逐字节断言 ---------------- */

/* 单层常亮：底层非空、叠加层为空、亮度满。 */
expectCase('scene_step_static_single', (c) => {
  const bytes = payloadBytes(c);
  const l0 = layerAt(bytes, 6);
  const l1 = layerAt(bytes, 15);
  check(l0.type === TYPE_STATIC, 'scene_step_static_single: layer0 must be static');
  check(l0.level === LAYER_LEVEL_MAX, 'scene_step_static_single: layer0 level must be 100');
  check(l1.type === EMPTY_LAYER, 'scene_step_static_single: layer1 must be empty');
  check(l1.level === 0, 'scene_step_static_single: empty layer1 level must be 0');
});

/* 两层：证明层编码没有变宽（仍 24 字节载荷）。 */
expectCase('scene_step_two_layers', (c) => {
  const bytes = payloadBytes(c);
  check(c.payload_len === SCENE_STEP_PAYLOAD,
    `scene_step_two_layers: payload ${c.payload_len}B != ${SCENE_STEP_PAYLOAD}B`);
  check(layerAt(bytes, 6).type === TYPE_STATIC, 'scene_step_two_layers: layer0 must be static');
  check(layerAt(bytes, 15).type === TYPE_COMET, 'scene_step_two_layers: layer1 must be comet');
});

/* 时长两端必须是真的边界值。 */
expectCase('scene_step_min_duration', (c) => {
  const p = payloadBytes(c);
  check((p[4] | (p[5] << 8)) === STEP_MIN_MS, `min duration must be ${STEP_MIN_MS}`);
});
expectCase('scene_step_max_duration', (c) => {
  const p = payloadBytes(c);
  check((p[4] | (p[5] << 8)) === STEP_MAX_MS, `max duration must be ${STEP_MAX_MS}`);
});
expectCase('scene_step_bad_duration_low', (c) => {
  const p = payloadBytes(c);
  check((p[4] | (p[5] << 8)) === 99, 'bad_duration_low must carry 99ms');
  check(c.result_code === 0x01, 'bad_duration_low must be InvalidParam');
});

/* 逐层亮度三档（0 / 50 / 100）——与 v4 同一规则，证明 level 语义没漂。 */
expectCase('scene_step_level_0', (c) => {
  check(layerAt(payloadBytes(c), 6).level === 0, 'level_0 must be 0');
});
expectCase('scene_step_level_50', (c) => {
  check(layerAt(payloadBytes(c), 6).level === 50, 'level_50 must be 50');
});
expectCase('scene_step_bad_level_101', (c) => {
  check(layerAt(payloadBytes(c), 6).level === 101, 'bad_level_101 must carry 101');
  check(c.result_code === 0x01, 'bad_level_101 must be InvalidParam');
});
expectCase('scene_step_bad_empty_level', (c) => {
  const l1 = layerAt(payloadBytes(c), 15);
  check(l1.type === EMPTY_LAYER && l1.level !== 0, 'bad_empty_level: layer1 empty with nonzero level');
});

/* 循环三值：0 / 1 / 2 都有合法用例。 */
{
  const loops = new Set(
    cases.filter((c) => c.command === 0x25 && c.frame_valid).map((c) => payloadBytes(c)[4]),
  );
  for (const v of [0, 1, 2]) {
    check(loops.has(v), `loop value ${v} has no valid ScenePart vector`);
  }
}

/* 每部位的 loop 与 step_count 落在布局的独立段落上（ScenePart 载荷偏移 3/4）。 */
expectCase('scene_part_zero_steps', (c) => {
  const p = payloadBytes(c);
  check(p[3] === 0, 'scene_part_zero_steps: step_count must be 0');
  check(c.frame_valid, 'scene_part_zero_steps: 0 steps is legal (part not performed this scene)');
});

/* 报告宽度与内容。 */
expectCase('layout_report_eye_1_seg', (c) => {
  const p = payloadBytes(c);
  check(p.length === LAYOUT_REPORT_BYTES, 'LayoutReport must be 44B');
  check(p[0] === 0 && p[1] === 0, 'layout_report_eye: strip0 part0');
  check(p[2] === 6, `layout_report_eye: name_len must be 6 (眼灯), got ${p[2]}`);
  check(p[27] === 1, 'layout_report_eye: seg_count must be 1');
  check(p[28] === 0 && p[29] === 1, 'layout_report_eye: first seg must be 0-1');
  /* 未用的 7 个段必须是 0/0。 */
  for (let i = 1; i < 8; i++) {
    check(p[28 + i * 2] === 0 && p[29 + i * 2] === 0,
      `layout_report_eye: unused seg ${i} must be 0/0`);
  }
});
expectCase('layout_report_radiator_2_segs', (c) => {
  const p = payloadBytes(c);
  check(p[27] === 2, 'radiator report: seg_count must be 2');
  check(p[28] === 11 && p[29] === 29, 'radiator report: first seg must be 11-29');
  check(p[30] === 40 && p[31] === 49, 'radiator report: second seg must be 40-49');
});
expectCase('layout_list_end', (c) => {
  const p = payloadBytes(c);
  check(p.length === 2, 'LayoutListEnd must be 2B');
  check(p[1] === 0x05, `part_mask must be 0b101, got 0x${p[1].toString(16)}`);
});

/* DeviceInfoReport：0x0500 小端、能力位与上限。 */
expectCase('device_info_report', (c) => {
  const p = payloadBytes(c);
  check(p.length === 15, 'DeviceInfoReport must be 15B');
  check((p[0] | (p[1] << 8)) === 0x0500,
    `firmware_version must be 0x0500 little-endian (00 05), got ${p[0].toString(16)} ${p[1].toString(16)}`);
  check(p[8] === MAX_LEDS, 'max_leds must be 100');
  check(p[9] === MAX_STRIPS, 'max_strips must be 8');
  check(p[10] === MAX_PARTS, 'max_parts must be 8');
  check(p[11] === MAX_PART_SEGS, 'max_part_segs must be 8');
  check(p[12] === MAX_STEPS, 'max_steps must be 8');
  check(p[13] === MAX_SCENES, 'max_scenes must be 3');
  check((p[14] & 0x01) !== 0, 'caps bit0 (two layers) must be set');
  check((p[14] & 0x02) === 0, 'caps bit1 (fade) must still be 0 in v5');
});

/* State 布局：逐字段核对（§7.3）。 */
function checkState(c, expect, label) {
  const p = payloadBytes(c);
  check(p.length === STATE_BYTES, `${label}: State must be ${STATE_BYTES}B`);
  for (const [off, want, field] of expect) {
    check(p[off] === want, `${label}: ${field} at offset ${off} is ${p[off]}, want ${want}`);
  }
  check(p[7] === 0, `${label}: reserved byte 7 must be 0`);
  for (let i = 0; i < MAX_STRIPS; i++) {
    const led = p[8 + i * 2] | (p[9 + i * 2] << 8);
    if (led !== 0) {
      check(led >= 1 && led <= MAX_LEDS, `${label}: led_count[${i}] ${led} out of range 1-100`);
    }
    check(led === 0 || i < p[3],
      `${label}: led_count[${i}] must be 0 for strips beyond strip_count ${p[3]}`);
    check(p[24 + i] <= MAX_PARTS,
      `${label}: part_count[${i}] ${p[24 + i]} exceeds ${MAX_PARTS}`);
    check(p[24 + i] === 0 || i < p[3],
      `${label}: part_count[${i}] must be 0 for strips beyond strip_count ${p[3]}`);
  }
  check(p[1] <= p[2], `${label}: brightness ${p[1]} must be clamped to max_brightness ${p[2]}`);
  check(p[0] <= 1, `${label}: power must be 0/1`);
  check(p[3] >= 1 && p[3] <= MAX_STRIPS, `${label}: strip_count must be 1-8`);
  check(p[5] < MAX_SCENES, `${label}: active_scene ${p[5]} must be < ${MAX_SCENES}`);
  check(p[6] <= 1, `${label}: layout_valid must be 0/1`);
}

expectCase('state_report_default', (c) => {
  checkState(c, [
    [0, 1, 'power'], [1, 128, 'brightness'], [2, 200, 'max_brightness'],
    [3, 2, 'strip_count'], [4, 0x03, 'strip_power_mask'],
    [5, 0, 'active_scene'], [6, 1, 'layout_valid'],
  ], 'state_report_default');
});
expectCase('state_report_off_scene2_no_layout', (c) => {
  checkState(c, [
    [0, 0, 'power'], [3, 2, 'strip_count'], [5, 2, 'active_scene'], [6, 0, 'layout_valid'],
  ], 'state_report_off_scene2_no_layout');
});

/* ---------------- 非法帧结果码 ---------------- */

const INVALID_EXPECT = {
  bad_magic: 0x08,
  bad_version_v4: 0x07,
  bad_version_v3: 0x07,
  bad_crc: 0x03,
  bad_length_overflow: 0x04,
  set_power_bad_value: 0x01,
  set_led_count_bad_zero: 0x01,
  set_led_count_bad_101: 0x01,
  set_strip_power_bad_strip8: 0x01,
  set_strip_power_bad_on: 0x01,
  layout_write_bad_strip8: 0x01,
  layout_write_bad_part_count_9: 0x01,
  layout_part_bad_name_len_25: 0x01,
  layout_part_bad_strip8: 0x01,
  layout_part_bad_part8: 0x01,
  layout_part_bad_seg_count_9: 0x01,
  layout_seg_bad_range: 0x01,
  layout_seg_bad_strip8: 0x01,
  layout_seg_bad_part8: 0x01,
  layout_seg_bad_seg8: 0x01,
  query_layout_bad_strip8: 0x01,
  scene_part_bad_scene3: 0x01,
  scene_part_bad_loop3: 0x01,
  scene_part_bad_on2: 0x01,
  scene_part_bad_steps9: 0x01,
  scene_step_bad_duration_low: 0x01,
  scene_step_bad_duration_zero: 0x01,
  scene_step_bad_layer0_empty: 0x01,
  scene_step_bad_level_101: 0x01,
  scene_step_bad_empty_level: 0x01,
  scene_step_bad_unknown_type: 0x01,
  scene_step_bad_breathing_period: 0x01,
  scene_step_bad_strobe_flags: 0x01,
  scene_step_bad_scene3: 0x01,
  scene_step_bad_part8: 0x01,
  scene_step_bad_step8: 0x01,
  scene_name_bad_len_25: 0x01,
  scene_name_bad_scene3: 0x01,
  activate_scene_bad_3: 0x01,
  query_scene_bad_3: 0x01,
};
for (const [name, code] of Object.entries(INVALID_EXPECT)) {
  expectCase(name, (c) => {
    check(c.result_code === code,
      `${name}: result 0x${c.result_code.toString(16)} != expected 0x${code.toString(16)}`);
  });
}

/* 非法帧的字节必须真的越界（防止生成器把它们写成合法值）。 */
expectCase('layout_part_bad_name_len_25', (c) => {
  check(payloadBytes(c)[2] === 25, 'bad_name_len_25: name_len byte must be 25');
});
expectCase('scene_name_bad_len_25', (c) => {
  check(payloadBytes(c)[1] === 25, 'scene_name_bad_len_25: name_len byte must be 25');
});
expectCase('layout_seg_bad_range', (c) => {
  const p = payloadBytes(c);
  check(p[3] > p[4], 'layout_seg_bad_range: start must be > end');
});
expectCase('scene_part_bad_loop3', (c) => {
  check(payloadBytes(c)[4] === 3, 'bad_loop3: loop byte must be 3');
});
expectCase('scene_step_bad_unknown_type', (c) => {
  check(layerAt(payloadBytes(c), 6).type === 0x09, 'bad_unknown_type: layer0 type must be 0x09');
});
expectCase('scene_step_bad_layer0_empty', (c) => {
  check(layerAt(payloadBytes(c), 6).type === EMPTY_LAYER, 'bad_layer0_empty: layer0 must be empty');
});

/* ---------------- 分片 ---------------- */

const multiChunk = cases.filter((c) => (c.chunk_count ?? c.chunks_hex.length) > 1);
check(multiChunk.length >= 2, `has >=2 multi-chunk vectors, got ${multiChunk.length}`);

/* 单分片帧的 ctrl 必须是 0xC0（不许裸帧，§3.2）。 */
for (const c of cases) {
  if (c.chunks_hex.length === 1) {
    check(c.chunks_hex[0].slice(0, 2) === 'C0',
      `${c.name}: single-chunk ctrl must be 0xC0, got ${c.chunks_hex[0].slice(0, 2)}`);
  }
}

/* ---------------- 报告逐字节 ---------------- */

/* SceneListEnd 与 SceneName 同构：name_len 之后必须全 0。 */
expectCase('scene_list_end', (c) => {
  const p = payloadBytes(c);
  check(p.length === SCENE_NAME_PAYLOAD, 'SceneListEnd must be 26B');
  check(p[0] === 0, 'scene_list_end: scene_id must be 0');
  check(p[1] === 6, `scene_list_end: name_len must be 6 (待机), got ${p[1]}`);
  for (let i = p[1]; i < NAME_BYTES; i++) {
    check(p[2 + i] === 0, `scene_list_end: name padding byte ${i} must be 0`);
  }
});

if (failures === 0) {
  console.log(`OK: ${cases.length} vectors consistent with docs/protocol-v5.md`);
  process.exit(0);
}
console.log(`\n${failures} failure(s)`);
process.exit(1);
