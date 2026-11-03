#!/usr/bin/env node
/*
 * 校验 docs/protocol-testvectors-v3.json 与 docs/protocol-v3.md 的一致性。
 *
 * 为什么需要：向量是生成出来的，生成器本身可能有 bug（本项目已经发生过一次：
 * 彩虹 span 按 2 字节传值，导致段载荷整体错位 1 字节）。所以要有独立的校验，
 * 只读 JSON、不相信生成器。
 *
 * 用法：node scripts/check-protocol-testvectors-v3.mjs
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS = path.join(ROOT, 'docs', 'protocol-testvectors-v3.json');

const MAGIC = 'A6';
const VERSION = '03';
const HEADER = 8; // magic1 + ver1 + cmd1 + seq1 + len2 + crc2
const MAX_FRAME = 240;
const MAX_PAYLOAD = 232;
const STATE_BYTES = 37;
const SEGMENT_PAYLOAD = 21;
const SCRIPT_SEGMENT_PAYLOAD = 23;

// 契约 §6 的命令表：每个命令的期望载荷长度（null = 变长，单独校验）
const EXPECTED_PAYLOAD = new Map([
  [0x01, 1], [0x02, 1], [0x03, null], [0x04, null],
  [0x05, 0], [0x06, 3], [0x07, 0],
  [0x10, SEGMENT_PAYLOAD], [0x11, 2], [0x12, 1], [0x13, 2],
  [0x14, 3], [0x15, 6], [0x16, SCRIPT_SEGMENT_PAYLOAD],
  [0x17, 1], [0x18, 1], [0x19, 2], [0x1A, 1],
  [0x1B, 2], [0x1C, 0], [0x1D, 0], [0x1E, 1],
]);

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

check(doc.protocol_version === 3, 'protocol_version is 3');
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
  /* #74：爆闪 / 心跳 / 熄灭是 v4 新增类型，v3 固件按未知类型拒绝（D7）。 */
  set_segment_bad_strobe_type_unsupported: 0x01,
  set_segment_bad_heartbeat_type_unsupported: 0x01,
  set_segment_bad_off_type_unsupported: 0x01,
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

// 段命令必须真的按 21/23 字节编码（防止层编码位宽漂移）
const setSegs = cases.filter((c) => c.command === 0x10 && c.frame_valid);
check(setSegs.length > 0, 'has SetSegment vectors');
check(setSegs.every((c) => c.payload_len === SEGMENT_PAYLOAD),
  `every SetSegment payload is ${SEGMENT_PAYLOAD}B`);

const scriptSegs = cases.filter((c) => c.command === 0x16);
check(scriptSegs.every((c) => c.payload_len === SCRIPT_SEGMENT_PAYLOAD),
  `every ScriptSegment payload is ${SCRIPT_SEGMENT_PAYLOAD}B`);

// 两层组合必须都有覆盖
const twoLayer = setSegs.filter((c) => {
  const p = c.payload_hex;
  const l1Type = parseInt(p.slice(26, 28), 16); // 层1 type 在载荷偏移 13
  return l1Type !== 0xff;
});
check(twoLayer.length >= 3, `has >=3 two-layer vectors, got ${twoLayer.length}`);

const blends = new Set(twoLayer.map((c) => parseInt(c.payload_hex.slice(8, 10), 16)));
for (const b of [0x00, 0x01, 0x02]) {
  check(blends.has(b), `blend 0x${b.toString(16)} has no two-layer vector`);
}

// 分片用例必须真的跨多片
const multiChunk = cases.filter((c) => (c.chunk_count ?? c.chunks_hex.length) > 1);
check(multiChunk.length >= 1, 'has at least one multi-chunk vector');

/*
 * #74：三条拒绝用例的字节里必须真的是 0x04 / 0x05 / 0x06（而不是生成器写错成
 * 已有类型）。v3 的 layer0 type 在载荷偏移 5。
 */
for (const [name, wantType] of Object.entries({
  set_segment_bad_strobe_type_unsupported: 0x04,
  set_segment_bad_heartbeat_type_unsupported: 0x05,
  set_segment_bad_off_type_unsupported: 0x06,
})) {
  const c = cases.find((x) => x.name === name);
  check(!!c, `missing v3 rejection case: ${name}`);
  if (c) {
    const type = parseInt(c.payload_hex.slice(10, 12), 16); /* 偏移 5 → hex 10..12 */
    check(type === wantType,
      `${name}: layer0 type 0x${type.toString(16)} != 0x${wantType.toString(16)}`);
    check(c.frame_valid === false, `${name}: must be marked invalid`);
  }
}

if (failures === 0) {
  console.log(`OK: ${cases.length} vectors consistent with docs/protocol-v3.md`);
  process.exit(0);
}
console.log(`\n${failures} failure(s)`);
process.exit(1);
