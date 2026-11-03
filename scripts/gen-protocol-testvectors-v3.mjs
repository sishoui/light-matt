#!/usr/bin/env node
/*
 * 生成 docs/protocol-testvectors-v3.json。
 *
 * 为什么要有生成器：docs/protocol-v3.md §13 规定「改字节布局 = 契约 + 测试向量 +
 * 两端实现同一个 commit」。手写向量在改布局时必然漂移，所以向量由本脚本从
 * 布局定义算出，CRC16 和分片也一并算出。
 *
 * 用法：node scripts/gen-protocol-testvectors-v3.mjs
 * 输出：docs/protocol-testvectors-v3.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'protocol-testvectors-v3.json');

const MAGIC = 0xa6;
const VER = 3;
const EMPTY_LAYER = 0xff;
const DEFAULT_CHUNK_CAPACITY = 180; // min(mtu - 3, 180)

/** CRC16 CCITT-FALSE：poly 0x1021，init 0xFFFF，不反转，无 xorout。 */
function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= (b << 8) & 0xffff;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

const hex = (arr) => arr.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];

function logicalFrame(command, seq, payload) {
  const body = [MAGIC, VER, command, seq, ...u16(payload.length), ...payload];
  return [...body, ...u16(crc16(body))];
}

function chunkFrame(frame, capacity = DEFAULT_CHUNK_CAPACITY) {
  const dataCap = capacity - 1;
  const count = Math.max(1, Math.ceil(frame.length / dataCap));
  const out = [];
  for (let i = 0; i < count; i++) {
    const slice = frame.slice(i * dataCap, (i + 1) * dataCap);
    let ctrl = i & 0x3f;
    if (i === 0) ctrl |= 0x80;
    if (i === count - 1) ctrl |= 0x40;
    out.push([ctrl, ...slice]);
  }
  return out;
}

/* ---------------- 载荷构造器（与契约 §7.1 一一对应） ---------------- */

// 层是定宽 8 字节：type(1) + param(7，右对齐，未用字节补 0)。
const layerEmpty = () => [EMPTY_LAYER, 0, 0, 0, 0, 0, 0, 0];

// 各字段位宽（effects-spec §2）。越界直接抛错，避免"多传一个字节导致整段错位"。
const WIDTH = { hue: 2, sat: 1, period: 2, p5: 1, flags: 1 };

function assertWidth(field, value) {
  const max = 2 ** (8 * WIDTH[field]) - 1;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${field}=${value} out of range 0..${max} (${WIDTH[field]} bytes)`);
  }
}

const layerStatic = (hue, sat) => {
  assertWidth('hue', hue);
  assertWidth('sat', sat);
  return [0x00, ...u16(hue), sat, 0, 0, 0, 0];
};

const layerAnim = (type, hue, sat, period, p5, flags) => {
  assertWidth('hue', hue);
  assertWidth('sat', sat);
  assertWidth('period', period);
  assertWidth('p5', p5);
  assertWidth('flags', flags);
  const layer = [type, ...u16(hue), sat, ...u16(period), p5, flags];
  if (layer.length !== 8) throw new Error(`layer must be 8 bytes, got ${layer.length}`);
  return layer;
};

const segment = (strip, seg, start, end, blend, l0, l1) => [
  strip, seg, start, end, blend, ...l0, ...l1,
];

// 断言：段载荷固定 21 字节，ScriptSegment 固定 23 字节。
function checkSegmentLen(payload, name) {
  if (payload.length !== 21) throw new Error(`${name}: segment payload must be 21, got ${payload.length}`);
}

/* ---------------- 用例 ---------------- */

const cases = [];

function addApp(c) {
  // 段类命令的载荷宽度是契约常量，生成时就断言，防止改动层编码后静默漂移。
  if (c.command === 0x10 && c.payload.length !== 21) {
    throw new Error(`${c.name}: SetSegment payload must be 21 B, got ${c.payload.length}`);
  }
  if (c.command === 0x16 && c.payload.length !== 23) {
    throw new Error(`${c.name}: ScriptSegment payload must be 23 B, got ${c.payload.length}`);
  }
  const frame = logicalFrame(c.command, c.seq, c.payload);
  cases.push({
    name: c.name,
    direction: 'app_to_device',
    command: c.command,
    command_name: c.commandName,
    seq: c.seq,
    payload_hex: hex(c.payload),
    payload_len: c.payload.length,
    frame_hex: hex(frame),
    frame_len: frame.length,
    chunks_hex: chunkFrame(frame).map(hex),
    frame_valid: c.result === undefined,
    result_code: c.result ?? 0,
    ...(c.note ? { note: c.note } : {}),
  });
}

function addDevice(c) {
  const frame = logicalFrame(c.command, c.seq, c.payload);
  cases.push({
    name: c.name,
    direction: 'device_to_app',
    command: c.command,
    command_name: c.commandName,
    seq: c.seq,
    payload_hex: hex(c.payload),
    payload_len: c.payload.length,
    frame_hex: hex(frame),
    frame_len: frame.length,
    chunks_hex: chunkFrame(frame).map(hex),
    frame_valid: true,
    result_code: 0,
    ...(c.note ? { note: c.note } : {}),
  });
}

// 基础命令
addApp({ name: 'set_power_on', command: 0x01, commandName: 'SetPower', seq: 1, payload: [1] });
addApp({ name: 'set_power_off', command: 0x01, commandName: 'SetPower', seq: 2, payload: [0] });
addApp({ name: 'set_brightness_128', command: 0x02, commandName: 'SetBrightness', seq: 3, payload: [128] });
addApp({ name: 'set_brightness_0', command: 0x02, commandName: 'SetBrightness', seq: 4, payload: [0] });
addApp({
  name: 'set_brightness_255', command: 0x02, commandName: 'SetBrightness', seq: 5, payload: [255],
  note: '设备按 max_brightness 钳位',
});
addApp({ name: 'query_state', command: 0x05, commandName: 'QueryState', seq: 6, payload: [] });
addApp({ name: 'set_led_count_strip0_64', command: 0x06, commandName: 'SetLedCount', seq: 7, payload: [0, 64, 0] });
addApp({
  name: 'set_led_count_strip0_100', command: 0x06, commandName: 'SetLedCount', seq: 61,
  payload: [0, 100, 0],
  note: '#72：上限抬到 100，线上仍是 3 字节载荷（strip_id + u16 LE）',
});
addApp({ name: 'set_led_count_strip7_1', command: 0x06, commandName: 'SetLedCount', seq: 8, payload: [7, 1, 0] });
addApp({ name: 'self_test', command: 0x07, commandName: 'SelfTest', seq: 9, payload: [] });
addApp({
  name: 'retired_set_color', command: 0x03, commandName: 'SetColor', seq: 10,
  payload: [0xff, 0x00, 0x00], result: 0x02, note: 'v3 退役，回 UnknownCommand',
});
addApp({
  name: 'retired_set_all', command: 0x04, commandName: 'SetAll', seq: 11,
  payload: [0x01, 0x80, 0xff, 0xb4, 0x78], result: 0x02, note: 'v3 退役，回 UnknownCommand',
});

// 每带开关
addApp({ name: 'set_strip_power_on_0', command: 0x1b, commandName: 'SetStripPower', seq: 12, payload: [0, 1] });
addApp({ name: 'set_strip_power_off_3', command: 0x1b, commandName: 'SetStripPower', seq: 13, payload: [3, 0] });
addApp({
  name: 'set_strip_power_bad_strip8', command: 0x1b, commandName: 'SetStripPower', seq: 14,
  payload: [8, 1], result: 0x01, note: 'strip_id 越界（strip_count=8 时合法范围 0-7）',
});
addApp({
  name: 'set_strip_power_bad_on', command: 0x1b, commandName: 'SetStripPower', seq: 15,
  payload: [0, 2], result: 0x01, note: 'on 只允许 0/1',
});

// 配置查询
addApp({ name: 'query_strip_config', command: 0x1c, commandName: 'QueryStripConfig', seq: 16, payload: [] });
addApp({ name: 'query_device_info', command: 0x1d, commandName: 'QueryDeviceInfo', seq: 17, payload: [] });

// 单层段
addApp({
  name: 'set_segment_single_static', command: 0x10, commandName: 'SetSegment', seq: 18,
  payload: segment(0, 0, 0, 9, 0x00, layerStatic(0, 255), layerEmpty()),
  note: '单层静态暖白红：layer1 为空',
});
addApp({
  name: 'set_segment_single_breathing', command: 0x10, commandName: 'SetSegment', seq: 19,
  payload: segment(1, 2, 10, 29, 0x00, layerAnim(0x01, 21845, 200, 2000, 30, 0), layerEmpty()),
  note: '单层呼吸，period=2000ms，min_level=30，正弦',
});
addApp({
  name: 'set_segment_single_rainbow', command: 0x10, commandName: 'SetSegment', seq: 20,
  payload: segment(2, 0, 0, 63, 0x00, layerAnim(0x02, 0, 255, 4000, 255, 0), layerEmpty()),
  note: '单层彩虹，span=255（沿整条铺满一圈）',
});
addApp({
  name: 'set_segment_single_comet', command: 0x10, commandName: 'SetSegment', seq: 21,
  payload: segment(3, 1, 5, 60, 0x00, layerAnim(0x03, 30000, 255, 1200, 8, 0x01), layerEmpty()),
  note: '单层流光，tail=8，reverse=1',
});

// 双层段
addApp({
  name: 'set_segment_two_static_multiply', command: 0x10, commandName: 'SetSegment', seq: 22,
  payload: segment(0, 1, 10, 39, 0x01, layerStatic(0, 255), layerStatic(0, 128)),
  note: '静态 + 静态，相乘：上层 50% 灰压暗下层',
});
addApp({
  name: 'set_segment_two_static_add', command: 0x10, commandName: 'SetSegment', seq: 23,
  payload: segment(2, 0, 0, 63, 0x02, layerStatic(43690, 255), layerStatic(0, 255)),
  note: '静态蓝 + 静态红，相加以验证饱和钳位',
});
addApp({
  name: 'set_segment_rainbow_plus_breathing_multiply', command: 0x10, commandName: 'SetSegment', seq: 24,
  payload: segment(
    0, 3, 0, 63, 0x01,
    layerAnim(0x02, 0, 255, 4000, 255, 0),
    layerAnim(0x01, 0, 0, 1500, 20, 0),
  ),
  note: '核心用例：彩虹打底 + 呼吸相乘压暗',
});
addApp({
  name: 'set_segment_comet_plus_static_over', command: 0x10, commandName: 'SetSegment', seq: 25,
  payload: segment(1, 0, 0, 31, 0x00, layerAnim(0x03, 30000, 255, 1200, 8, 0), layerStatic(0, 255)),
  note: 'blend=覆盖：上层静态完全盖住下层流光（用于验证 blend 0 语义）',
});

// 非法段
addApp({
  name: 'set_segment_bad_blend_single', command: 0x10, commandName: 'SetSegment', seq: 26,
  payload: segment(3, 0, 0, 5, 0x01, layerStatic(1000, 255), layerEmpty()),
  result: 0x01, note: '单层但 blend != 0 → InvalidParam',
});
addApp({
  name: 'set_segment_bad_blend_value', command: 0x10, commandName: 'SetSegment', seq: 27,
  payload: segment(3, 0, 0, 5, 0x03, layerStatic(1000, 255), layerStatic(2000, 255)),
  result: 0x01, note: 'blend 只允许 0/1/2（不做取最大）',
});
addApp({
  name: 'set_segment_bad_layer0_empty', command: 0x10, commandName: 'SetSegment', seq: 28,
  payload: segment(3, 0, 0, 5, 0x00, layerEmpty(), layerStatic(1000, 255)),
  result: 0x01, note: 'layer0 不能为空',
});
addApp({
  name: 'set_segment_bad_unknown_type', command: 0x10, commandName: 'SetSegment', seq: 29,
  payload: segment(3, 0, 0, 5, 0x00, [0x09, 0, 0, 0, 0, 0, 0, 0], layerEmpty()),
  result: 0x01, note: '未知 type 0x09 → InvalidParam（D7 不降级）',
});
addApp({
  name: 'set_segment_bad_range', command: 0x10, commandName: 'SetSegment', seq: 30,
  payload: segment(0, 0, 30, 10, 0x00, layerStatic(0, 255), layerEmpty()),
  result: 0x01, note: 'start > end',
});
addApp({
  name: 'set_segment_bad_breathing_period', command: 0x10, commandName: 'SetSegment', seq: 31,
  payload: segment(0, 0, 0, 9, 0x00, layerAnim(0x01, 0, 255, 300, 0, 0), layerEmpty()),
  result: 0x01, note: '呼吸周期 300ms < 334ms 下限',
});
addApp({
  name: 'set_segment_bad_rainbow_period', command: 0x10, commandName: 'SetSegment', seq: 32,
  payload: segment(0, 0, 0, 9, 0x00, layerAnim(0x02, 0, 255, 199, 0, 0), layerEmpty()),
  result: 0x01, note: '彩虹周期 199ms < 200ms 下限',
});

// 段查询 / 清段
addApp({ name: 'clear_segment', command: 0x11, commandName: 'ClearSegment', seq: 33, payload: [0, 3] });
addApp({ name: 'query_strip_0', command: 0x12, commandName: 'QueryStrip', seq: 34, payload: [0] });
addApp({ name: 'query_strip_7', command: 0x12, commandName: 'QueryStrip', seq: 35, payload: [7] });

// 剧本
addApp({ name: 'script_begin', command: 0x14, commandName: 'ScriptBegin', seq: 36, payload: [0, 4, 2] });
addApp({
  name: 'script_stage_fade0', command: 0x15, commandName: 'ScriptStage', seq: 37,
  payload: [0, 0, ...u16(1000), ...u16(0)],
});
addApp({
  name: 'script_stage_fade_reserved', command: 0x15, commandName: 'ScriptStage', seq: 38,
  payload: [0, 1, ...u16(2000), ...u16(500)],
  note: 'fade_ms 非 0：接受并存储，但播放行为仍是硬切',
});
addApp({
  name: 'script_segment_two_layer', command: 0x16, commandName: 'ScriptSegment', seq: 39,
  payload: [0, 0, ...segment(
    0, 0, 0, 31, 0x01,
    layerAnim(0x02, 0, 255, 4000, 255, 0),
    layerAnim(0x01, 0, 0, 1500, 20, 0),
  )],
  note: '剧本里下发双层段',
});
addApp({
  name: 'script_segment_clear_slot', command: 0x16, commandName: 'ScriptSegment', seq: 40,
  payload: [0, 0, 0, 3, 0, 9, 0x00, ...layerEmpty(), ...layerEmpty()],
  note: '两层都空 = 清空该槽位',
});
addApp({ name: 'script_commit', command: 0x17, commandName: 'ScriptCommit', seq: 41, payload: [0] });
addApp({
  name: 'script_commit_too_large', command: 0x17, commandName: 'ScriptCommit', seq: 42,
  payload: [1], result: 0x0a,
  note: '编码后超过 16384 字节 → ScriptTooLarge，不提交',
});
addApp({ name: 'script_abort', command: 0x18, commandName: 'ScriptAbort', seq: 43, payload: [0] });
addApp({ name: 'activate_script', command: 0x19, commandName: 'ActivateScript', seq: 44, payload: [0, 1] });
addApp({ name: 'query_script', command: 0x1a, commandName: 'QueryScript', seq: 45, payload: [0] });
addApp({ name: 'set_playback_play', command: 0x13, commandName: 'SetPlayback', seq: 46, payload: [1, 1] });
addApp({ name: 'set_playback_pause', command: 0x13, commandName: 'SetPlayback', seq: 47, payload: [2, 1] });
addApp({ name: 'set_playback_stop', command: 0x13, commandName: 'SetPlayback', seq: 48, payload: [0, 0] });

// 信封层非法帧：直接给出字节，不走构造器
function rawCase(c) {
  cases.push({
    name: c.name,
    direction: 'app_to_device',
    command: c.command,
    command_name: c.commandName,
    seq: c.seq,
    payload_hex: c.payloadHex,
    payload_len: c.payloadHex.length / 2,
    frame_hex: c.frameHex,
    frame_len: c.frameHex.length / 2,
    chunks_hex: chunkFrame(
      Array.from({ length: c.frameHex.length / 2 }, (_, i) =>
        parseInt(c.frameHex.slice(i * 2, i * 2 + 2), 16),
      ),
    ).map(hex),
    frame_valid: false,
    result_code: c.result,
    note: c.note,
  });
}

const powerOn = logicalFrame(0x01, 49, [1]);
rawCase({
  name: 'bad_magic',
  command: 0x01, commandName: 'SetPower', seq: 49, payloadHex: '01',
  frameHex: hex([0xa5, VER, 0x01, 0x31, 0x01, 0x00, 0x01, 0x00, 0x00]),
  result: 0x08,
  note: 'magic=0xA5（v2 的 magic）→ BadMagic。CRC 无关，magic 先校验',
});
rawCase({
  name: 'bad_version',
  command: 0x01, commandName: 'SetPower', seq: 49, payloadHex: '01',
  frameHex: hex([MAGIC, 0x02, 0x01, 0x31, 0x01, 0x00, 0x01, 0x00, 0x00]),
  result: 0x07,
  note: 'version=0x02 → UnsupportedVersion',
});
{
  const bad = [...powerOn];
  bad[bad.length - 1] ^= 0xff;
  rawCase({
    name: 'bad_crc',
    command: 0x01, commandName: 'SetPower', seq: 49, payloadHex: '01',
    frameHex: hex(bad), frame_valid: false, result: 0x03,
    note: 'CRC 高字节被篡改 → BadChecksum',
  });
}
{
  const bad = [...powerOn];
  bad[4] = 200; // length 越界
  rawCase({
    name: 'bad_length_overflow',
    command: 0x01, commandName: 'SetPower', seq: 49, payloadHex: '01',
    frameHex: hex(bad), result: 0x04,
    note: 'length=200 但实际只有 1 字节 payload → BadLength',
  });
}

/* ---------------- 分片用例 ----------------
 *
 * 三个用例都必须是**契约合法的载荷**，否则它们会同时违反「命令载荷宽度」规则。
 * chunk_capacity 的下限是 20（MTU 23 时 23-3），所以：
 *   - 31 字节的 ScriptSegment 帧 → 1 片（cap 180）或 2 片（cap 20）
 *   - 45 字节的 StateReport 帧   → 3 片（cap 20）
 */

// 一个合法的两层 ScriptSegment（23 字节载荷 → 31 字节帧）
const twoLayerScriptPayload = [0, 0, ...segment(
  0, 0, 0, 63, 0x01,
  layerAnim(0x02, 0, 255, 4000, 255, 0),
  layerAnim(0x01, 0, 0, 1500, 20, 0),
)];
if (twoLayerScriptPayload.length !== 23) {
  throw new Error(`ScriptSegment payload must be 23B, got ${twoLayerScriptPayload.length}`);
}

function pushChunkCase(name, seq, payload, capacity, note) {
  const frame = logicalFrame(0x16, seq, payload);
  const chunks = chunkFrame(frame, capacity);
  cases.push({
    name,
    direction: 'app_to_device',
    command: 0x16,
    command_name: 'ScriptSegment',
    seq,
    payload_hex: hex(payload),
    payload_len: payload.length,
    frame_hex: hex(frame),
    frame_len: frame.length,
    chunks_hex: chunks.map(hex),
    chunk_count: chunks.length,
    chunk_capacity: capacity,
    frame_valid: true,
    result_code: 0,
    note,
  });
  return chunks.length;
}

{
  const n = pushChunkCase(
    'chunking_single_chunk', 50, twoLayerScriptPayload, 180,
    '正常 MTU：31 字节帧一次写完，ctrl = FIRST|LAST = 0xC0',
  );
  if (n !== 1) throw new Error(`expected 1 chunk, got ${n}`);
}
{
  const n = pushChunkCase(
    'chunking_two_chunks', 51, twoLayerScriptPayload, 20,
    'MTU 23（cap 20）：31 字节帧分 2 片，首片 FIRST、次片 LAST',
  );
  if (n !== 2) throw new Error(`expected 2 chunks, got ${n}`);
}
{
  // 设备 → 小程序：37 字节 StateReport，低 MTU 下 3 片
  const payload = buildState();
  const frame = logicalFrame(0x82, 52, payload);
  const chunks = chunkFrame(frame, 20);
  if (chunks.length !== 3) throw new Error(`expected 3 chunks, got ${chunks.length}`);
  cases.push({
    name: 'chunking_three_chunks_state_report',
    direction: 'device_to_app',
    command: 0x82,
    command_name: 'StateReport',
    seq: 52,
    payload_hex: hex(payload),
    payload_len: payload.length,
    frame_hex: hex(frame),
    frame_len: frame.length,
    chunks_hex: chunks.map(hex),
    chunk_count: chunks.length,
    chunk_capacity: 20,
    frame_valid: true,
    result_code: 0,
    note: `StateReport ${frame.length} 字节帧在 MTU 23（cap 20）下分 ${chunks.length} 片；notify 侧同样要重组`,
  });
}

/* ---------------- 设备 → 小程序 ---------------- */

function buildState() {
  const stripCounts = [30, 60, 0, 0, 0, 0, 0, 0];
  const segCounts = [2, 4, 0, 0, 0, 0, 0, 0];
  const s = [
    1, // power
    128, // brightness
    255, 180, 120, // strip0/seg0 layer0 基准色（暖白）
    200, // max_brightness
    2, // strip_count
    0xff, // script_id = 无激活剧本
    0, // stage_index
    0, // playback_state = 停止
    0, // flags
    0x03, // strip_power_mask：0、1 两条带打开
    0x01, // strip_anim_mask：strip0 有动画
    ...stripCounts.flatMap(u16),
    ...segCounts,
  ];
  if (s.length !== 37) throw new Error(`State must be 37 bytes, got ${s.length}`);
  return s;
}

addDevice({
  name: 'state_report_default', command: 0x82, commandName: 'StateReport', seq: 52,
  payload: buildState(),
  note: '开灯/亮度128/暖白；2 条灯带（30、60 灯）；带开关掩码 0b11；strip0 有 2 段且含动画',
});

{
  const gpios = [3, 10, 0, 1, 4, 5, 6, 7];
  const cfg = [];
  for (let i = 0; i < 8; i++) cfg.push(i, i < 3 ? gpios[i] : 0xff, i < 3 ? 1 : 0);
  if (cfg.length !== 24) throw new Error('StripConfigReport must be 24 bytes');
  addDevice({
    name: 'strip_config_report_3_strips', command: 0x87, commandName: 'StripConfigReport', seq: 53,
    payload: cfg,
    note: '3 条灯带已分配：GPIO 3/10/0；其余 gpio=0xFF、flags=0 未分配',
  });
}
{
  const info = [0x03, 0x00, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 100, 8, 8, 8, 4, 0x01, 0x00];
  if (info.length !== 15) throw new Error('DeviceInfoReport must be 15 bytes');
  addDevice({
    name: 'device_info_report', command: 0x88, commandName: 'DeviceInfoReport', seq: 54,
    payload: info,
    note: '固件 v3.0；MAC AA:BB:CC:DD:EE:FF；caps=0x01（支持两层叠加，fade 未实现）',
  });
}

/* ---------------- 自检（保证向量和契约不会漂移） ---------------- */

for (const c of cases) {
  if (c.frame_valid && c.frame_len !== 8 + c.payload_len) {
    throw new Error(`${c.name}: frame_len ${c.frame_len} != 8 + payload_len ${c.payload_len}`);
  }
  // 分片带 1 字节 ctrl 头，剥掉后拼起来必须正好是逻辑帧。
  const reconstructed = c.chunks_hex.map((h) => h.slice(2)).join('');
  if (reconstructed !== c.frame_hex) {
    throw new Error(`${c.name}: chunks do not reconstruct to the logical frame`);
  }
}

const doc = {
  protocol_version: 3,
  magic: '0xA6',
  crc16: 'CCITT-FALSE poly 0x1021 init 0xFFFF, no reflect, no xorout',
  frame_layout: 'magic(1) version(1) command(1) seq(1) length(2 LE) payload(length) crc16(2 LE)',
  chunk_layout: 'ctrl(1) data(<=179); ctrl bit7=FIRST bit6=LAST bits5..0=chunk index',
  state_bytes: 37,
  state_read_example_hex: hex(buildState()),
  state_read_fields: [
    'power', 'brightness', 'r', 'g', 'b', 'max_brightness', 'strip_count',
    'script_id', 'stage_index', 'playback_state', 'flags',
    'strip_power_mask', 'strip_anim_mask',
    'strip_counts[8] (u16 LE)', 'strip_seg_counts[8] (u8)',
  ],
  cases,
};

fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`${cases.length} cases -> ${path.relative(ROOT, OUT)}`);
console.log(`state example: ${doc.state_read_example_hex}`);
