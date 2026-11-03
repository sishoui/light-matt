#!/usr/bin/env node
/*
 * 校验 docs/protocol-testvectors-v4.json 与 docs/protocol-v4.md 的一致性。
 *
 * 为什么需要：向量是生成出来的，生成器本身可能有 bug（本项目已经发生过一次：
 * 彩虹 span 按 2 字节传值，导致段载荷整体错位 1 字节）。所以要有独立的校验，
 * 只读 JSON、不相信生成器。
 *
 * 用法：node scripts/check-protocol-testvectors-v4.mjs
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS = path.join(ROOT, 'docs', 'protocol-testvectors-v4.json');

const MAGIC = 'A6';
const VERSION = '04';
const HEADER = 8; // magic1 + ver1 + cmd1 + seq1 + len2 + crc2
const MAX_FRAME = 240;
const MAX_PAYLOAD = 232;
const STATE_BYTES = 37;
/* v4：5 字节段头 + 2 × 9 字节层。 */
const SEGMENT_PAYLOAD = 23;
const SCRIPT_SEGMENT_PAYLOAD = 25;
/* 段的语义约束（契约 §7.1）。 */
const LAYER_LEVEL_MAX = 100;
const EMPTY_LAYER = 0xff;

// 契约 §6 的命令表：每个命令的期望载荷长度（null = 变长，单独校验）
const EXPECTED_PAYLOAD = new Map([
  [0x01, 1], [0x02, 1], [0x03, null], [0x04, null],
  [0x05, 0], [0x06, 3], [0x07, 0],
  [0x10, SEGMENT_PAYLOAD], [0x11, 2], [0x12, 1], [0x13, 2],
  [0x14, 3], [0x15, 6], [0x16, SCRIPT_SEGMENT_PAYLOAD],
  [0x17, 1], [0x18, 1], [0x19, 2], [0x1A, 1],
  [0x1B, 2], [0x1C, 0], [0x1D, 0], [0x1E, 1],
]);

/*
 * #74：灯效类型的参数规则（契约 §7.1 第 8 步）。
 *
 * 这里只校验**向量自身的字节与预期结果一致**，不实现完整校验器：
 *   - 合法帧里出现的 type 必须是已知七种之一；
 *   - 已知类型的 flags 保留位 / 周期区间必须落在契约内；
 *   - 熄灭层的 hue / sat / p5 / period / flags 必须全 0。
 */
const KNOWN_TYPES = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
const TYPE_STATIC = 0x00;
const TYPE_BREATHING = 0x01;
const TYPE_RAINBOW = 0x02;
const TYPE_COMET = 0x03;
const TYPE_STROBE = 0x04;
const TYPE_HEARTBEAT = 0x05;
const TYPE_OFF = 0x06;
const STROBE_MIN_PERIOD_MS = 100;
const HEARTBEAT_MIN_PERIOD_MS = 500;
const HEARTBEAT_MAX_PERIOD_MS = 1500;
const BREATHING_MIN_PERIOD_MS = 334;
const ANIMATION_MIN_PERIOD_MS = 200;

// 设备 → 小程序报告（§7.4）
const EXPECTED_REPORT = new Map([
  [0x82, STATE_BYTES], [0x87, 24], [0x88, 15],
]);

let failures = 0;
function check(ok, msg) {
  if (!ok) {
    console.log(`FAIL: ${msg}`);
    failures++;
  }
}

const doc = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));

check(doc.protocol_version === 4, 'protocol_version is 4');
check(doc.state_bytes === STATE_BYTES, `state_bytes is ${STATE_BYTES}`);
check(doc.state_read_example_hex.length / 2 === STATE_BYTES,
  `state example is ${STATE_BYTES} bytes, got ${doc.state_read_example_hex.length / 2}`);

const cases = doc.cases;
check(cases.length > 0, 'has cases');

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

  // 命令载荷宽度（只对合法帧）
  if (c.frame_valid && c.direction === 'app_to_device' && EXPECTED_PAYLOAD.has(c.command)) {
    const want = EXPECTED_PAYLOAD.get(c.command);
    if (want !== null) {
      check(c.payload_len === want,
        `${c.name}: command 0x${c.command.toString(16)} payload ${c.payload_len}B != contract ${want}B`);
    }
  }
  if (c.frame_valid && c.direction === 'device_to_app' && EXPECTED_REPORT.has(c.command)) {
    check(c.payload_len === EXPECTED_REPORT.get(c.command),
      `${c.name}: report 0x${c.command.toString(16)} payload ${c.payload_len}B != contract`);
  }

  // 分片：剥掉 1 字节 ctrl 头后必须正好拼回逻辑帧
  const reassembled = c.chunks_hex.map((h) => h.slice(2)).join('');
  check(reassembled === c.frame_hex, `${c.name}: chunks do not reassemble to the logical frame`);

  // ctrl 头结构：首片 FIRST，末片 LAST
  c.chunks_hex.forEach((h, i) => {
    const ctrl = parseInt(h.slice(0, 2), 16);
    const isFirst = (ctrl & 0x80) !== 0;
    const isLast = (ctrl & 0x40) !== 0;
    check(isFirst === (i === 0), `${c.name}: chunk ${i} FIRST flag wrong`);
    check(isLast === (i === c.chunks_hex.length - 1), `${c.name}: chunk ${i} LAST flag wrong`);
  });
}

// 非法帧必须有契约规定的结果码
const INVALID_EXPECT = {
  bad_magic: 0x08,
  bad_version: 0x07,
  bad_crc: 0x03,
  bad_length_overflow: 0x04,
  script_commit_too_large: 0x0a,
  // v4 层亮度规则
  set_segment_bad_level_101: 0x01,
  set_segment_bad_empty_level: 0x01,
  script_segment_clear_level_nonzero: 0x01,
  // #73 ClearScript：越界 script_id
  clear_script_bad_id: 0x01,
  // #74 三种新灯效的边界拒绝
  set_segment_bad_strobe_period: 0x01,
  set_segment_bad_strobe_flags: 0x01,
  set_segment_bad_heartbeat_period_low: 0x01,
  set_segment_bad_heartbeat_period_high: 0x01,
  set_segment_bad_heartbeat_flags: 0x01,
  set_segment_bad_off_params: 0x01,
};
for (const [name, code] of Object.entries(INVALID_EXPECT)) {
  const c = cases.find((x) => x.name === name);
  check(!!c, `missing invalid case: ${name}`);
  if (c) {
    check(c.result_code === code,
      `${name}: result 0x${c.result_code.toString(16)} != expected 0x${code.toString(16)}`);
  }
}

// 命令覆盖：契约 §6 里每条命令至少一个用例
const appCmds = new Set(cases.filter((c) => c.direction === 'app_to_device').map((c) => c.command));
for (const cmd of EXPECTED_PAYLOAD.keys()) {
  check(appCmds.has(cmd), `command 0x${cmd.toString(16)} has no vector`);
}
const devCmds = new Set(cases.filter((c) => c.direction === 'device_to_app').map((c) => c.command));
for (const cmd of EXPECTED_REPORT.keys()) {
  check(devCmds.has(cmd), `report 0x${cmd.toString(16)} has no vector`);
}

// 段命令必须真的按 23/25 字节编码（防止层编码位宽漂移）
const setSegs = cases.filter((c) => c.command === 0x10 && c.frame_valid);
check(setSegs.length > 0, 'has SetSegment vectors');
check(setSegs.every((c) => c.payload_len === SEGMENT_PAYLOAD),
  `every SetSegment payload is ${SEGMENT_PAYLOAD}B`);

const scriptSegs = cases.filter((c) => c.command === 0x16);
check(scriptSegs.every((c) => c.payload_len === SCRIPT_SEGMENT_PAYLOAD),
  `every ScriptSegment payload is ${SCRIPT_SEGMENT_PAYLOAD}B`);

// 两层组合必须都有覆盖（层1 type 在载荷偏移 14 → hex 28..30）
const twoLayer = setSegs.filter((c) => {
  const p = c.payload_hex;
  const l1Type = parseInt(p.slice(28, 30), 16);
  return l1Type !== 0xff;
});
check(twoLayer.length >= 3, `has >=3 two-layer vectors, got ${twoLayer.length}`);

const blends = new Set(twoLayer.map((c) => parseInt(c.payload_hex.slice(8, 10), 16)));
for (const b of [0x00, 0x01, 0x02]) {
  check(blends.has(b), `blend 0x${b.toString(16)} has no two-layer vector`);
}

/*
 * v4 层亮度规则（契约 §7.1）：
 *   - 合法帧里每层的 level 必须 ≤ 100；
 *   - 空层（type = 0xFF）的 level 必须为 0；
 *   - 0 / 50 / 100 三档必须都有向量（固件要证明三档都能正确出光）。
 *
 * 层布局：段块偏移 5 + 9×层号 + 8 = level 字节。段块在 payload 里从 0 开始
 * （SetSegment）或从 2 开始（ScriptSegment）。
 */
function layerLevel(payloadHex, base, layerIndex) {
  const off = base + 5 + layerIndex * 9 + 8;
  return parseInt(payloadHex.slice(off * 2, off * 2 + 2), 16);
}
function layerType(payloadHex, base, layerIndex) {
  const off = base + 5 + layerIndex * 9;
  return parseInt(payloadHex.slice(off * 2, off * 2 + 2), 16);
}

/** 一层的 7 字节参数（param[0..6]），按小端给出多字节字段的便捷视图。 */
function layerParams(payloadHex, base, layerIndex) {
  const off = base + 5 + layerIndex * 9 + 1; // 跳过 type
  const bytes = [];
  for (let i = 0; i < 7; i += 1) {
    bytes.push(parseInt(payloadHex.slice((off + i) * 2, (off + i) * 2 + 2), 16));
  }
  return {
    bytes,
    hue: bytes[0] | (bytes[1] << 8),
    sat: bytes[2],
    period: bytes[3] | (bytes[4] << 8),
    p5: bytes[5],
    flags: bytes[6],
  };
}

for (const c of cases) {
  if (!c.frame_valid) {
    continue;
  }
  if (c.command === 0x10) {
    for (const li of [0, 1]) {
      const type = layerType(c.payload_hex, 0, li);
      const level = layerLevel(c.payload_hex, 0, li);
      check(level <= LAYER_LEVEL_MAX,
        `${c.name}: layer${li} level ${level} exceeds ${LAYER_LEVEL_MAX} on a valid frame`);
      if (type === EMPTY_LAYER) {
        check(level === 0, `${c.name}: empty layer${li} must have level 0, got ${level}`);
      }
    }
  } else if (c.command === 0x16) {
    for (const li of [0, 1]) {
      const type = layerType(c.payload_hex, 2, li);
      const level = layerLevel(c.payload_hex, 2, li);
      check(level <= LAYER_LEVEL_MAX,
        `${c.name}: layer${li} level ${level} exceeds ${LAYER_LEVEL_MAX} on a valid frame`);
      if (type === EMPTY_LAYER) {
        check(level === 0, `${c.name}: empty layer${li} must have level 0, got ${level}`);
      }
    }
  }

  // #74：合法帧里的类型必须已知，且各类型的参数规则必须在契约内。
  if (c.command === 0x10 || c.command === 0x16) {
    const base = c.command === 0x10 ? 0 : 2;
    for (const li of [0, 1]) {
      const type = layerType(c.payload_hex, base, li);
      if (type === EMPTY_LAYER) {
        continue; /* 空层另由上面的 level 规则覆盖 */
      }
      check(KNOWN_TYPES.has(type),
        `${c.name}: layer${li} type 0x${type.toString(16)} is not a known effect type`);
      if (type === TYPE_STATIC) {
        continue; /* 静态层的保留位由生成器保证，checker 不重复实现 */
      }
      const p = layerParams(c.payload_hex, base, li);
      if (type === TYPE_BREATHING) {
        check((p.flags & 0xf8) === 0, `${c.name}: layer${li} breathing flags reserved bits set`);
        check(p.period === 0 || p.period >= BREATHING_MIN_PERIOD_MS,
          `${c.name}: layer${li} breathing period ${p.period} < ${BREATHING_MIN_PERIOD_MS}`);
      } else if (type === TYPE_RAINBOW || type === TYPE_COMET) {
        check((p.flags & 0xfe) === 0, `${c.name}: layer${li} animation flags reserved bits set`);
        check(p.period === 0 || p.period >= ANIMATION_MIN_PERIOD_MS,
          `${c.name}: layer${li} period ${p.period} < ${ANIMATION_MIN_PERIOD_MS}`);
      } else if (type === TYPE_STROBE) {
        check(p.flags === 0, `${c.name}: layer${li} strobe flags must be 0, got ${p.flags}`);
        check(p.period === 0 || p.period >= STROBE_MIN_PERIOD_MS,
          `${c.name}: layer${li} strobe period ${p.period} < ${STROBE_MIN_PERIOD_MS}`);
      } else if (type === TYPE_HEARTBEAT) {
        check((p.flags & 0xfe) === 0, `${c.name}: layer${li} heartbeat flags reserved bits set`);
        check(
          p.period === 0 ||
            (p.period >= HEARTBEAT_MIN_PERIOD_MS && p.period <= HEARTBEAT_MAX_PERIOD_MS),
          `${c.name}: layer${li} heartbeat period ${p.period} outside ` +
            `${HEARTBEAT_MIN_PERIOD_MS}-${HEARTBEAT_MAX_PERIOD_MS}`,
        );
      } else if (type === TYPE_OFF) {
        const allZero = p.bytes.every((b) => b === 0);
        check(allZero, `${c.name}: layer${li} OFF params must all be 0`);
      }
    }
  }
}

// 0 / 50 / 100 三档必须都有合法向量（逐字节验证第 9 字节就是 level）。
const levelCases = { 0: 'set_segment_level_0', 50: 'set_segment_level_50', 100: 'set_segment_level_100' };
for (const [level, name] of Object.entries(levelCases)) {
  const c = cases.find((x) => x.name === name);
  check(!!c, `missing level case: ${name}`);
  if (c) {
    check(c.frame_valid, `${name}: must be a valid frame`);
    check(layerLevel(c.payload_hex, 0, 0) === Number(level),
      `${name}: layer0 level ${layerLevel(c.payload_hex, 0, 0)} != ${level}`);
    check(layerLevel(c.payload_hex, 0, 1) === 0, `${name}: empty layer1 level must be 0`);
  }
}

// 非法 level 用例的字节必须真的越界（防止生成器把它们写成合法值）。
{
  const c = cases.find((x) => x.name === 'set_segment_bad_level_101');
  check(!!c && layerLevel(c.payload_hex, 0, 0) === 101,
    'set_segment_bad_level_101: layer0 level byte must be 101');
}
{
  const c = cases.find((x) => x.name === 'set_segment_bad_empty_level');
  check(!!c && layerType(c.payload_hex, 0, 1) === EMPTY_LAYER &&
    layerLevel(c.payload_hex, 0, 1) !== 0,
    'set_segment_bad_empty_level: layer1 must be empty with nonzero level');
}
{
  const c = cases.find((x) => x.name === 'script_segment_clear_level_nonzero');
  check(!!c &&
    layerType(c.payload_hex, 2, 0) === EMPTY_LAYER && layerType(c.payload_hex, 2, 1) === EMPTY_LAYER &&
    layerLevel(c.payload_hex, 2, 0) !== 0,
    'script_segment_clear_level_nonzero: both layers empty, layer0 level nonzero');
}

// 分片用例必须真的跨多片
const multiChunk = cases.filter((c) => (c.chunk_count ?? c.chunks_hex.length) > 1);
check(multiChunk.length >= 1, 'has at least one multi-chunk vector');

/*
 * #74：三种新类型必须各有合法编码用例，且字节里真的是那个类型。
 * 合法用例同时证明「新类型没有扩宽层编码」——载荷仍是 23 字节。
 */
const newTypeCases = {
  set_segment_single_strobe: { type: TYPE_STROBE, period: 100 },
  set_segment_single_heartbeat: { type: TYPE_HEARTBEAT, period: 1000 },
  set_segment_single_off: { type: TYPE_OFF, period: 0 },
};
for (const [name, want] of Object.entries(newTypeCases)) {
  const c = cases.find((x) => x.name === name);
  check(!!c, `missing new-type case: ${name}`);
  if (!c) {
    continue;
  }
  check(c.frame_valid, `${name}: must be a valid frame`);
  check(c.payload_len === SEGMENT_PAYLOAD,
    `${name}: payload ${c.payload_len}B != ${SEGMENT_PAYLOAD}B (new types must not widen the layer)`);
  check(layerType(c.payload_hex, 0, 0) === want.type,
    `${name}: layer0 type 0x${layerType(c.payload_hex, 0, 0).toString(16)} != 0x${want.type.toString(16)}`);
  check(layerLevel(c.payload_hex, 0, 0) === LAYER_LEVEL_MAX,
    `${name}: layer0 level should default to ${LAYER_LEVEL_MAX}`);
  const p = layerParams(c.payload_hex, 0, 0);
  check(p.period === want.period, `${name}: period ${p.period} != ${want.period}`);
  if (want.type === TYPE_OFF) {
    check(p.bytes.every((b) => b === 0), `${name}: OFF params must all be 0`);
  }
}

/* 叠加用例：两种新类型同段（爆闪打底 + 心跳相乘），证明它们都能作 layer1。 */
{
  const c = cases.find((x) => x.name === 'set_segment_strobe_plus_heartbeat');
  check(!!c, 'missing set_segment_strobe_plus_heartbeat');
  if (c) {
    check(c.frame_valid, 'set_segment_strobe_plus_heartbeat: must be a valid frame');
    check(layerType(c.payload_hex, 0, 0) === TYPE_STROBE,
      'set_segment_strobe_plus_heartbeat: layer0 must be strobe');
    check(layerType(c.payload_hex, 0, 1) === TYPE_HEARTBEAT,
      'set_segment_strobe_plus_heartbeat: layer1 must be heartbeat');
    check(parseInt(c.payload_hex.slice(8, 10), 16) === 0x01,
      'set_segment_strobe_plus_heartbeat: blend must be multiply');
  }
}

/* 非法用例的字节必须真的越界（防止生成器把它们写成合法值）。 */
{
  const c = cases.find((x) => x.name === 'set_segment_bad_strobe_period');
  check(!!c && layerParams(c.payload_hex, 0, 0).period === 99,
    'set_segment_bad_strobe_period: period must be 99');
}
{
  const c = cases.find((x) => x.name === 'set_segment_bad_strobe_flags');
  check(!!c && layerParams(c.payload_hex, 0, 0).flags !== 0,
    'set_segment_bad_strobe_flags: flags must be nonzero');
}
{
  const c = cases.find((x) => x.name === 'set_segment_bad_heartbeat_period_low');
  check(!!c && layerParams(c.payload_hex, 0, 0).period === 499,
    'set_segment_bad_heartbeat_period_low: period must be 499');
}
{
  const c = cases.find((x) => x.name === 'set_segment_bad_heartbeat_period_high');
  check(!!c && layerParams(c.payload_hex, 0, 0).period === 1501,
    'set_segment_bad_heartbeat_period_high: period must be 1501');
}
{
  const c = cases.find((x) => x.name === 'set_segment_bad_off_params');
  check(!!c && layerParams(c.payload_hex, 0, 0).hue !== 0,
    'set_segment_bad_off_params: OFF hue must be nonzero');
}

if (failures === 0) {
  console.log(`OK: ${cases.length} vectors consistent with docs/protocol-v4.md`);
  process.exit(0);
}
console.log(`\n${failures} failure(s)`);
process.exit(1);
