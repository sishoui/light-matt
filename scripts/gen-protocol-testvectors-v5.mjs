#!/usr/bin/env node
/*
 * 生成 docs/protocol-testvectors-v5.json。
 *
 * 为什么要有生成器：docs/protocol-v5.md §13 规定「改任何字节布局 = 契约 +
 * 测试向量 + 两端实现同一个 commit」。手写向量在改布局时必然漂移，所以向量由
 * 本脚本从布局定义算出，CRC16 与分片也一并算出。
 *
 * v5 相对 v4 的差别（不是「扩一版」，是换模型）：
 *   - 协议版本 0x04 → 0x05，State 37 → 32 字节；
 *   - 删掉分区 / 剧本两族命令（0x10-0x1E 里的旧码一律回 0x02），
 *     删掉 SegmentReport 0x83 / SegmentListEnd 0x84 / ScriptSummary 0x85 /
 *     ScriptProgress 0x86 四条报告；
 *   - 新增布局族 0x20-0x24 与场景族 0x25-0x29，新增报告 0x89-0x8D。
 *
 * 退役命令的帧**保留在向量里**：这是「固件收到 v4 命令必须回未知命令」的
 * 可执行证据（票 #155 的验收项）。
 *
 * 用法：node scripts/gen-protocol-testvectors-v5.mjs
 * 输出：docs/protocol-testvectors-v5.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'protocol-testvectors-v5.json');

const MAGIC = 0xa6;
const VER = 5;
/* 契约常量（docs/protocol-v5.md §1.1）。 */
const LAYER_BYTES = 9;
const LAYOUT_PART_PAYLOAD = 28;
const SCENE_STEP_PAYLOAD = 24;
const SCENE_NAME_PAYLOAD = 26;
const STATE_BYTES = 32;
const EMPTY_LAYER = 0xff;
const LAYER_LEVEL_FULL = 100;
const NAME_BYTES = 24;
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

/*
 * 层是定宽 9 字节：type(1) + param(7，右对齐，未用字节补 0) + level(1)。
 * v5 未改层编码（§7.1 明说「与 v4 完全一致」）。
 */
const layerEmpty = () => [EMPTY_LAYER, 0, 0, 0, 0, 0, 0, 0, 0];

// 各字段位宽（effects-spec §2）。越界直接抛错，避免「多传一个字节导致整体错位」。
const WIDTH = { hue: 2, sat: 1, period: 2, p5: 1, flags: 1 };

function assertWidth(field, value) {
  const max = 2 ** (8 * WIDTH[field]) - 1;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${field}=${value} out of range 0..${max} (${WIDTH[field]} bytes)`);
  }
}

/*
 * level 缺省 100（满亮）。合法域是 0-100；这里只校验「装得进一个字节」，
 * 因为生成器必须能构造**越界用例**（level = 101 → 期望 InvalidParam）。
 */
function assertLevel(level) {
  if (!Number.isInteger(level) || level < 0 || level > 255) {
    throw new Error(`level=${level} out of range 0..255 (1 byte)`);
  }
}

const layerStatic = (hue, sat, level = LAYER_LEVEL_FULL) => {
  assertWidth('hue', hue);
  assertWidth('sat', sat);
  assertLevel(level);
  const layer = [0x00, ...u16(hue), sat, 0, 0, 0, 0, level];
  if (layer.length !== LAYER_BYTES) throw new Error(`layer must be 9 bytes`);
  return layer;
};

const layerAnim = (type, hue, sat, period, p5, flags, level = LAYER_LEVEL_FULL) => {
  assertWidth('hue', hue);
  assertWidth('sat', sat);
  assertWidth('period', period);
  assertWidth('p5', p5);
  assertWidth('flags', flags);
  assertLevel(level);
  const layer = [type, ...u16(hue), sat, ...u16(period), p5, flags, level];
  if (layer.length !== LAYER_BYTES) throw new Error(`layer must be 9 bytes`);
  return layer;
};

/** 部位名：UTF-8，NUL 补到 24 字节。返回 [bytes24, name_len]。 */
function nameField(text) {
  const bytes = [...Buffer.from(text, 'utf8')];
  if (bytes.length > NAME_BYTES) {
    throw new Error(`name "${text}" is ${bytes.length} bytes, limit ${NAME_BYTES}`);
  }
  const padded = [...bytes];
  while (padded.length < NAME_BYTES) padded.push(0);
  return [padded, bytes.length];
}

/* 布局族载荷（§6 / §7.2）。 */
const layoutWrite = (strip, partCount) => [strip, partCount];

function layoutPart(strip, part, name, segCount) {
  const [nameBytes, nameLen] = nameField(name);
  const payload = [strip, part, nameLen, ...nameBytes, segCount];
  if (payload.length !== LAYOUT_PART_PAYLOAD) {
    throw new Error(`LayoutPart must be ${LAYOUT_PART_PAYLOAD} bytes, got ${payload.length}`);
  }
  return payload;
}

const layoutSeg = (strip, part, seg, start, end) => [strip, part, seg, start, end];

/* 场景族载荷（§6 / §7.4）。 */
const scenePart = (scene, strip, part, stepCount, loop, on) => [
  scene, strip, part, stepCount, loop, on,
];

function sceneStep(scene, strip, part, stepIndex, durationMs, l0, l1) {
  const payload = [scene, strip, part, stepIndex, ...u16(durationMs), ...l0, ...l1];
  if (payload.length !== SCENE_STEP_PAYLOAD) {
    throw new Error(`SceneStep must be ${SCENE_STEP_PAYLOAD} bytes, got ${payload.length}`);
  }
  return payload;
}

function sceneName(scene, name) {
  const [nameBytes, nameLen] = nameField(name);
  const payload = [scene, nameLen, ...nameBytes];
  if (payload.length !== SCENE_NAME_PAYLOAD) {
    throw new Error(`SceneName must be ${SCENE_NAME_PAYLOAD} bytes, got ${payload.length}`);
  }
  return payload;
}

/* ---------------- 用例收集 ---------------- */

const cases = [];

function addApp(c) {
  // 新命令族的载荷宽度是契约常量，生成时就断言，防止层编码漂移后静默错位。
  if (c.command === 0x21 && c.payload.length !== LAYOUT_PART_PAYLOAD) {
    throw new Error(`${c.name}: LayoutPart payload must be ${LAYOUT_PART_PAYLOAD}B`);
  }
  if (c.command === 0x26 && c.payload.length !== SCENE_STEP_PAYLOAD) {
    throw new Error(`${c.name}: SceneStep payload must be ${SCENE_STEP_PAYLOAD}B`);
  }
  if (c.command === 0x27 && c.payload.length !== SCENE_NAME_PAYLOAD) {
    throw new Error(`${c.name}: SceneName payload must be ${SCENE_NAME_PAYLOAD}B`);
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

/* ---------------- 保留命令（v5 原样保留） ---------------- */

addApp({ name: 'set_power_on', command: 0x01, commandName: 'SetPower', seq: 1, payload: [1] });
addApp({ name: 'set_power_off', command: 0x01, commandName: 'SetPower', seq: 2, payload: [0] });
addApp({ name: 'set_power_bad_value', command: 0x01, commandName: 'SetPower', seq: 3, payload: [2], result: 0x01, note: 'power 只允许 0/1' });
addApp({ name: 'set_brightness_128', command: 0x02, commandName: 'SetBrightness', seq: 4, payload: [128] });
addApp({ name: 'set_brightness_0', command: 0x02, commandName: 'SetBrightness', seq: 5, payload: [0] });
addApp({ name: 'set_brightness_255', command: 0x02, commandName: 'SetBrightness', seq: 6, payload: [255], note: '设备按 max_brightness 钳位' });
addApp({ name: 'query_state', command: 0x05, commandName: 'QueryState', seq: 7, payload: [] });
addApp({ name: 'set_led_count_strip0_64', command: 0x06, commandName: 'SetLedCount', seq: 8, payload: [0, 64, 0] });
addApp({ name: 'set_led_count_strip0_100', command: 0x06, commandName: 'SetLedCount', seq: 9, payload: [0, 100, 0], note: '上限 100' });
addApp({ name: 'set_led_count_strip7_1', command: 0x06, commandName: 'SetLedCount', seq: 10, payload: [7, 1, 0] });
addApp({ name: 'set_led_count_bad_zero', command: 0x06, commandName: 'SetLedCount', seq: 11, payload: [0, 0, 0], result: 0x01, note: '灯珠数 0 非法' });
addApp({ name: 'set_led_count_bad_101', command: 0x06, commandName: 'SetLedCount', seq: 12, payload: [0, 101, 0], result: 0x01, note: '灯珠数 101 超过 MAX_LEDS' });
addApp({ name: 'self_test', command: 0x07, commandName: 'SelfTest', seq: 13, payload: [] });

addApp({ name: 'set_strip_power_on_0', command: 0x1b, commandName: 'SetStripPower', seq: 14, payload: [0, 1] });
addApp({ name: 'set_strip_power_off_3', command: 0x1b, commandName: 'SetStripPower', seq: 15, payload: [3, 0] });
addApp({ name: 'set_strip_power_bad_strip8', command: 0x1b, commandName: 'SetStripPower', seq: 16, payload: [8, 1], result: 0x01, note: 'strip_id 越界，合法范围 0-7' });
addApp({ name: 'set_strip_power_bad_on', command: 0x1b, commandName: 'SetStripPower', seq: 17, payload: [0, 2], result: 0x01, note: 'on 只允许 0/1' });

addApp({ name: 'query_strip_config', command: 0x1c, commandName: 'QueryStripConfig', seq: 18, payload: [] });
addApp({ name: 'query_device_info', command: 0x1d, commandName: 'QueryDeviceInfo', seq: 19, payload: [] });

/* ---------------- 布局族 0x20-0x24 ---------------- */

addApp({ name: 'layout_write_strip0_3_parts', command: 0x20, commandName: 'LayoutWrite', seq: 20, payload: layoutWrite(0, 3), note: '声明 strip0 有 3 个部位并清空其内容' });
addApp({ name: 'layout_write_strip7_1_part', command: 0x20, commandName: 'LayoutWrite', seq: 21, payload: layoutWrite(7, 1) });
addApp({ name: 'layout_write_strip0_0_parts', command: 0x20, commandName: 'LayoutWrite', seq: 22, payload: layoutWrite(0, 0), note: '0 个部位 = 这条链没有部位，未覆盖灯珠恒黑' });
addApp({ name: 'layout_write_bad_strip8', command: 0x20, commandName: 'LayoutWrite', seq: 23, payload: layoutWrite(8, 1), result: 0x01, note: 'strip_id 越界' });
addApp({ name: 'layout_write_bad_part_count_9', command: 0x20, commandName: 'LayoutWrite', seq: 24, payload: layoutWrite(0, 9), result: 0x01, note: 'part_count 超过 MAX_PARTS' });

addApp({ name: 'layout_part_eye_1_seg', command: 0x21, commandName: 'LayoutPart', seq: 25, payload: layoutPart(0, 0, '眼灯', 1), note: '部位名 6 字节 UTF-8，NUL 补到 24，1 个灯珠段' });
addApp({ name: 'layout_part_zero_name', command: 0x21, commandName: 'LayoutPart', seq: 26, payload: layoutPart(0, 1, '', 2), note: '空名合法：name_len = 0，24 字节全 0' });
addApp({ name: 'layout_part_bad_name_len_25', command: 0x21, commandName: 'LayoutPart', seq: 27, payload: [0, 0, 25, ...new Array(24).fill(0x41), 1], result: 0x01, note: 'name_len 25 超过 NAME_BYTES 24' });
addApp({ name: 'layout_part_bad_strip8', command: 0x21, commandName: 'LayoutPart', seq: 28, payload: layoutPart(8, 0, 'x', 1), result: 0x01, note: 'strip_id 越界' });
addApp({ name: 'layout_part_bad_part8', command: 0x21, commandName: 'LayoutPart', seq: 29, payload: layoutPart(0, 8, 'x', 1), result: 0x01, note: 'part_id 越界' });
addApp({ name: 'layout_part_bad_seg_count_9', command: 0x21, commandName: 'LayoutPart', seq: 30, payload: layoutPart(0, 0, 'x', 9), result: 0x01, note: 'seg_count 超过 MAX_PART_SEGS' });

addApp({ name: 'layout_seg_head_0_9', command: 0x22, commandName: 'LayoutSeg', seq: 31, payload: layoutSeg(0, 0, 0, 0, 9), note: '闭区间 0-9' });
addApp({ name: 'layout_seg_monitor_single', command: 0x22, commandName: 'LayoutSeg', seq: 32, payload: layoutSeg(0, 1, 0, 10, 10), note: '单颗灯珠段' });
addApp({ name: 'layout_seg_radiator_11_29', command: 0x22, commandName: 'LayoutSeg', seq: 33, payload: layoutSeg(0, 2, 0, 11, 29) });
addApp({ name: 'layout_seg_bad_range', command: 0x22, commandName: 'LayoutSeg', seq: 34, payload: layoutSeg(0, 0, 0, 30, 10), result: 0x01, note: 'start 大于 end' });
addApp({ name: 'layout_seg_bad_strip8', command: 0x22, commandName: 'LayoutSeg', seq: 35, payload: layoutSeg(8, 0, 0, 0, 9), result: 0x01 });
addApp({ name: 'layout_seg_bad_part8', command: 0x22, commandName: 'LayoutSeg', seq: 36, payload: layoutSeg(0, 8, 0, 0, 9), result: 0x01 });
addApp({ name: 'layout_seg_bad_seg8', command: 0x22, commandName: 'LayoutSeg', seq: 37, payload: layoutSeg(0, 0, 8, 0, 9), result: 0x01 });

addApp({ name: 'layout_commit', command: 0x23, commandName: 'LayoutCommit', seq: 38, payload: [], note: '整份校验通过后立即落盘' });
addApp({ name: 'query_layout_strip0', command: 0x24, commandName: 'QueryLayout', seq: 39, payload: [0], note: 'ACK 后逐部位 LayoutReport 加一条 LayoutListEnd' });
addApp({ name: 'query_layout_strip7', command: 0x24, commandName: 'QueryLayout', seq: 40, payload: [7] });
addApp({ name: 'query_layout_bad_strip8', command: 0x24, commandName: 'QueryLayout', seq: 41, payload: [8], result: 0x01 });

/* ---------------- 场景族 0x25-0x29 ---------------- */

addApp({ name: 'scene_part_single_step_loop', command: 0x25, commandName: 'ScenePart', seq: 42, payload: scenePart(0, 0, 0, 1, 1, 1), note: '1 步、全部循环、部位开' });
addApp({ name: 'scene_part_zero_steps', command: 0x25, commandName: 'ScenePart', seq: 43, payload: scenePart(0, 0, 0, 0, 0, 0), note: '0 步 = 本场景不演，恒黑' });
addApp({ name: 'scene_part_loop_last', command: 0x25, commandName: 'ScenePart', seq: 44, payload: scenePart(2, 1, 3, 8, 2, 1), note: '最后一步循环、8 步上限' });
addApp({ name: 'scene_part_bad_scene3', command: 0x25, commandName: 'ScenePart', seq: 45, payload: scenePart(3, 0, 0, 1, 1, 1), result: 0x01, note: 'scene_id 越界，只有 3 个场景' });
addApp({ name: 'scene_part_bad_loop3', command: 0x25, commandName: 'ScenePart', seq: 46, payload: scenePart(0, 0, 0, 1, 3, 1), result: 0x01, note: 'loop 只有三值 0/1/2' });
addApp({ name: 'scene_part_bad_on2', command: 0x25, commandName: 'ScenePart', seq: 47, payload: scenePart(0, 0, 0, 1, 1, 2), result: 0x01, note: 'on 只允许 0/1' });
addApp({ name: 'scene_part_bad_steps9', command: 0x25, commandName: 'ScenePart', seq: 48, payload: scenePart(0, 0, 0, 9, 1, 1), result: 0x01, note: 'step_count 超过 MAX_STEPS' });

addApp({ name: 'scene_step_static_single', command: 0x26, commandName: 'SceneStep', seq: 49, payload: sceneStep(0, 0, 0, 0, 1000, layerStatic(0, 255), layerEmpty()), note: '1 步 1 层常亮暖红，底层非空、叠加层为空' });
addApp({ name: 'scene_step_min_duration', command: 0x26, commandName: 'SceneStep', seq: 50, payload: sceneStep(0, 0, 0, 0, 100, layerStatic(0, 255), layerEmpty()), note: '时长下限 100ms' });
addApp({ name: 'scene_step_max_duration', command: 0x26, commandName: 'SceneStep', seq: 51, payload: sceneStep(0, 0, 0, 1, 60000, layerStatic(0, 255), layerEmpty()), note: '时长上限 60000ms' });
addApp({ name: 'scene_step_breathing', command: 0x26, commandName: 'SceneStep', seq: 52, payload: sceneStep(0, 0, 0, 0, 2000, layerAnim(0x01, 21845, 200, 2000, 30, 0), layerEmpty()), note: '呼吸 period 2000ms' });
addApp({ name: 'scene_step_two_layers', command: 0x26, commandName: 'SceneStep', seq: 53, payload: sceneStep(1, 0, 0, 0, 1500, layerStatic(0, 255), layerAnim(0x03, 30000, 255, 1200, 8, 0x01)), note: '静态打底加流光叠加层，混合方式不在线上' });
addApp({ name: 'scene_step_level_50', command: 0x26, commandName: 'SceneStep', seq: 54, payload: sceneStep(0, 0, 0, 0, 1000, layerStatic(0, 255, 50), layerEmpty()), note: '层亮度 50' });
addApp({ name: 'scene_step_level_0', command: 0x26, commandName: 'SceneStep', seq: 55, payload: sceneStep(0, 0, 0, 0, 1000, layerStatic(0, 255, 0), layerEmpty()), note: '层亮度 0 合法，语义是不出光' });
addApp({ name: 'scene_step_bad_duration_low', command: 0x26, commandName: 'SceneStep', seq: 56, payload: sceneStep(0, 0, 0, 0, 99, layerStatic(0, 255), layerEmpty()), result: 0x01, note: '时长 99ms 低于下限 100ms' });
addApp({ name: 'scene_step_bad_duration_zero', command: 0x26, commandName: 'SceneStep', seq: 57, payload: sceneStep(0, 0, 0, 0, 0, layerStatic(0, 255), layerEmpty()), result: 0x01, note: '时长 0 非法' });
addApp({ name: 'scene_step_bad_layer0_empty', command: 0x26, commandName: 'SceneStep', seq: 58, payload: sceneStep(0, 0, 0, 0, 1000, layerEmpty(), layerStatic(0, 255)), result: 0x01, note: 'layer0 不能为空' });
addApp({ name: 'scene_step_bad_level_101', command: 0x26, commandName: 'SceneStep', seq: 59, payload: sceneStep(0, 0, 0, 0, 1000, layerStatic(0, 255, 101), layerEmpty()), result: 0x01, note: '层亮度 101 超过 100' });
addApp({ name: 'scene_step_bad_empty_level', command: 0x26, commandName: 'SceneStep', seq: 60, payload: sceneStep(0, 0, 0, 0, 1000, layerStatic(0, 255), [EMPTY_LAYER, 0, 0, 0, 0, 0, 0, 0, 50]), result: 0x01, note: '空层 level 必须为 0' });
addApp({ name: 'scene_step_bad_unknown_type', command: 0x26, commandName: 'SceneStep', seq: 61, payload: sceneStep(0, 0, 0, 0, 1000, [0x09, 0, 0, 0, 0, 0, 0, 0, 100], layerEmpty()), result: 0x01, note: '未知灯效类型 0x09' });
addApp({ name: 'scene_step_bad_breathing_period', command: 0x26, commandName: 'SceneStep', seq: 62, payload: sceneStep(0, 0, 0, 0, 1000, layerAnim(0x01, 0, 255, 300, 30, 0), layerEmpty()), result: 0x01, note: '呼吸周期 300ms 低于 334ms' });
addApp({ name: 'scene_step_bad_strobe_flags', command: 0x26, commandName: 'SceneStep', seq: 63, payload: sceneStep(0, 0, 0, 0, 1000, layerAnim(0x04, 0, 255, 100, 90, 0x01), layerEmpty()), result: 0x01, note: '爆闪 flags 必须为 0' });
addApp({ name: 'scene_step_bad_scene3', command: 0x26, commandName: 'SceneStep', seq: 64, payload: sceneStep(3, 0, 0, 0, 1000, layerStatic(0, 255), layerEmpty()), result: 0x01 });
addApp({ name: 'scene_step_bad_part8', command: 0x26, commandName: 'SceneStep', seq: 65, payload: sceneStep(0, 0, 8, 0, 1000, layerStatic(0, 255), layerEmpty()), result: 0x01 });
addApp({ name: 'scene_step_bad_step8', command: 0x26, commandName: 'SceneStep', seq: 66, payload: sceneStep(0, 0, 0, 8, 1000, layerStatic(0, 255), layerEmpty()), result: 0x01, note: 'step_index 超过 MAX_STEPS' });

addApp({ name: 'scene_name_standby', command: 0x27, commandName: 'SceneName', seq: 67, payload: sceneName(0, '待机'), note: '场景名 6 字节 UTF-8' });
addApp({ name: 'scene_name_empty', command: 0x27, commandName: 'SceneName', seq: 68, payload: sceneName(1, ''), note: '空名合法' });
addApp({ name: 'scene_name_bad_len_25', command: 0x27, commandName: 'SceneName', seq: 69, payload: [0, 25, ...new Array(24).fill(0x42)], result: 0x01, note: 'name_len 25 超过 24' });
addApp({ name: 'scene_name_bad_scene3', command: 0x27, commandName: 'SceneName', seq: 70, payload: sceneName(3, 'x'), result: 0x01 });

addApp({ name: 'activate_scene_0', command: 0x28, commandName: 'ActivateScene', seq: 71, payload: [0], note: '硬切，全部部位从第 1 步重跳' });
addApp({ name: 'activate_scene_2', command: 0x28, commandName: 'ActivateScene', seq: 72, payload: [2] });
addApp({ name: 'activate_scene_bad_3', command: 0x28, commandName: 'ActivateScene', seq: 73, payload: [3], result: 0x01 });
addApp({ name: 'query_scene_0', command: 0x29, commandName: 'QueryScene', seq: 74, payload: [0] });
addApp({ name: 'query_scene_bad_3', command: 0x29, commandName: 'QueryScene', seq: 75, payload: [3], result: 0x01 });

/* ---------------- 退役命令：v4 的写分区与剧本族 ---------------- */

/*
 * 这些帧的**信封完全合法**，但命令层必须回 0x02 UnknownCommand（§6 末段）。
 * 载荷内容保留 v4 形态，是为了证明「不是载荷长度挡住它们，而是命令字本身退役」。
 * 0x0A ScriptTooLarge 也随之退役（编号不复用）。
 */
const retired = [
  { name: 'retired_set_color', command: 0x03, commandName: 'SetColor', payload: [0xff, 0x00, 0x00], note: 'v2 退役' },
  { name: 'retired_set_all', command: 0x04, commandName: 'SetAll', payload: [0x01, 0x80, 0xff, 0xb4, 0x78], note: 'v2 退役' },
  { name: 'retired_set_segment', command: 0x10, commandName: 'SetSegment', payload: [0, 0, 0, 9, 0x00, ...layerStatic(0, 255), ...layerEmpty()], note: 'v4 的写分区，v5 删除' },
  { name: 'retired_clear_segment', command: 0x11, commandName: 'ClearSegment', payload: [0, 3], note: 'v4 的清分区，v5 删除' },
  { name: 'retired_query_strip', command: 0x12, commandName: 'QueryStrip', payload: [0], note: 'v4 的段读回，v5 删除' },
  { name: 'retired_set_playback', command: 0x13, commandName: 'SetPlayback', payload: [1, 1], note: 'v4 的播放控制，v5 删除' },
  { name: 'retired_script_begin', command: 0x14, commandName: 'ScriptBegin', payload: [0, 4, 2], note: 'v4 剧本族' },
  { name: 'retired_script_stage', command: 0x15, commandName: 'ScriptStage', payload: [0, 0, 0xe8, 0x03, 0, 0], note: 'v4 剧本族' },
  { name: 'retired_script_segment', command: 0x16, commandName: 'ScriptSegment', payload: [0, 0, 0, 3, 0, 9, 0x00, ...layerStatic(0, 255), ...layerEmpty()], note: 'v4 剧本族' },
  { name: 'retired_script_commit', command: 0x17, commandName: 'ScriptCommit', payload: [0], note: 'v4 剧本族' },
  { name: 'retired_script_abort', command: 0x18, commandName: 'ScriptAbort', payload: [0], note: 'v4 剧本族' },
  { name: 'retired_activate_script', command: 0x19, commandName: 'ActivateScript', payload: [0, 1], note: 'v4 剧本族' },
  { name: 'retired_query_script', command: 0x1a, commandName: 'QueryScript', payload: [0], note: 'v4 剧本族' },
  { name: 'retired_clear_script', command: 0x1e, commandName: 'ClearScript', payload: [0], note: 'v4 剧本族' },
];
let seq = 76;
for (const r of retired) {
  addApp({ ...r, seq: seq++, result: 0x02 });
}

/* ---------------- 设备 → 小程序 ---------------- */

addDevice({
  name: 'ack_ok', command: 0x80, commandName: 'ACK', seq: 90,
  payload: [0x01, 0x00],
  note: 'SetPower 的 ACK：原命令字 0x01 + 结果码 0x00，seq 回显请求',
});
addDevice({
  name: 'ack_unknown_command', command: 0x80, commandName: 'ACK', seq: 91,
  payload: [0x10, 0x02],
  note: '收到 v4 的 0x10 SetSegment：回显原命令字 + UnknownCommand',
});
addDevice({
  name: 'ack_bad_length', command: 0x80, commandName: 'ACK', seq: 92,
  payload: [0x06, 0x04],
  note: '载荷长度不符 → BadLength',
});
addDevice({
  name: 'event_storage_failed', command: 0x81, commandName: 'Event', seq: 0,
  payload: [0x01, 0x23],
  note: 'NVS 写失败：event_code 0x01，detail = 触发写入的命令字 0x23 LayoutCommit；设备主动帧 seq 恒 0',
});

/* State 32 字节（§7.3）。 */
function buildState() {
  const ledCounts = [30, 60, 0, 0, 0, 0, 0, 0];
  const partCounts = [1, 2, 0, 0, 0, 0, 0, 0];
  const s = [
    1, // power
    128, // brightness
    200, // max_brightness
    2, // strip_count
    0x03, // strip_power_mask：0、1 两条链打开
    0, // active_scene
    1, // layout_valid
    0, // reserved
    ...ledCounts.flatMap(u16),
    ...partCounts,
  ];
  if (s.length !== STATE_BYTES) throw new Error(`State must be ${STATE_BYTES} bytes, got ${s.length}`);
  return s;
}

addDevice({
  name: 'state_report_default', command: 0x82, commandName: 'StateReport', seq: 100,
  payload: buildState(),
  note: '开灯亮度 128；2 条链 30/60 灯；链开关掩码 0b11；当前场景 0；布局已提交；部位数 1/2',
});
{
  const s = buildState();
  s[0] = 0; // power off
  s[5] = 2; // active_scene 2
  s[6] = 0; // layout_valid 0
  s[11] = 0; // led_count[1] high
  s[12] = 0; // led_count[1] low
  addDevice({
    name: 'state_report_off_scene2_no_layout', command: 0x82, commandName: 'StateReport', seq: 101,
    payload: s,
    note: '上电默认值：关灯、场景 0、没有已提交布局',
  });
}

{
  const gpios = [3, 10, 0];
  const cfg = [];
  for (let i = 0; i < 8; i++) cfg.push(i, i < 3 ? gpios[i] : 0xff, i < 3 ? 1 : 0);
  if (cfg.length !== 24) throw new Error('StripConfigReport must be 24 bytes');
  addDevice({
    name: 'strip_config_report_3_strips', command: 0x87, commandName: 'StripConfigReport', seq: 102,
    payload: cfg,
    note: '3 条链已分配：GPIO 3/10/0；其余 gpio=0xFF、flags=0 未分配',
  });
}
{
  /* 固件版本是小端（低字节在前）。v5.0 = 0x0500，线上是 00 05。 */
  const info = [0x00, 0x05, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 100, 8, 8, 8, 8, 3, 0x01];
  if (info.length !== 15) throw new Error('DeviceInfoReport must be 15 bytes');
  addDevice({
    name: 'device_info_report', command: 0x88, commandName: 'DeviceInfoReport', seq: 103,
    payload: info,
    note: '固件 v5.0；MAC AA:BB:CC:DD:EE:FF；上限 100 灯 / 8 链 / 8 部位 / 8 段 / 8 步 / 3 场景；caps bit0 两层叠加',
  });
}

/* LayoutReport 44 字节（§7.2）。 */
function buildLayoutReport(strip, part, name, segs) {
  const [nameBytes, nameLen] = nameField(name);
  const payload = [strip, part, nameLen, ...nameBytes, segs.length];
  for (let i = 0; i < 8; i++) {
    const seg = segs[i];
    payload.push(seg ? seg[0] : 0, seg ? seg[1] : 0);
  }
  if (payload.length !== 44) throw new Error(`LayoutReport must be 44 bytes, got ${payload.length}`);
  return payload;
}

addDevice({
  name: 'layout_report_eye_1_seg', command: 0x89, commandName: 'LayoutReport', seq: 104,
  payload: buildLayoutReport(0, 0, '眼灯', [[0, 1]]),
  note: 'strip0 部位 0 眼灯，1 个段 0-1，未用的 7 个段补 0/0',
});
addDevice({
  name: 'layout_report_radiator_2_segs', command: 0x89, commandName: 'LayoutReport', seq: 104,
  payload: buildLayoutReport(0, 2, '散热', [[11, 29], [40, 49]]),
  note: '一个部位占两个不连续段（多段共享全部参数）',
});
addDevice({
  name: 'layout_list_end', command: 0x8a, commandName: 'LayoutListEnd', seq: 104,
  payload: [0, 0x05],
  note: 'strip0 的部位位图 0b101：部位 0 与部位 2 有段',
});

/* ScenePartReport / SceneStepReport / SceneListEnd（§7.4）。 */
addDevice({
  name: 'scene_part_report', command: 0x8b, commandName: 'ScenePartReport', seq: 105,
  payload: scenePart(0, 0, 0, 3, 1, 1),
  note: '与 ScenePart 同构（方向相反）',
});
addDevice({
  name: 'scene_step_report', command: 0x8c, commandName: 'SceneStepReport', seq: 105,
  payload: sceneStep(0, 0, 0, 0, 1000, layerStatic(0, 255), layerEmpty()),
  note: '与 SceneStep 同构（方向相反）',
});
addDevice({
  name: 'scene_list_end', command: 0x8d, commandName: 'SceneListEnd', seq: 105,
  payload: sceneName(0, '待机'),
  note: '收尾帧带场景名，26 字节',
});

/* ---------------- 分片用例 ---------------- */

/*
 * 分片用例必须是**契约合法的载荷**，否则它们会同时违反「命令载荷宽度」规则。
 * chunk_capacity 的下限是 20（MTU 23 时 23-3），数据上限再减 1 字节分片头。
 */
function pushChunkCase(c) {
  const frame = logicalFrame(c.command, c.seq, c.payload);
  const chunks = chunkFrame(frame, c.capacity);
  cases.push({
    name: c.name,
    direction: c.direction ?? 'app_to_device',
    command: c.command,
    command_name: c.commandName,
    seq: c.seq,
    payload_hex: hex(c.payload),
    payload_len: c.payload.length,
    frame_hex: hex(frame),
    frame_len: frame.length,
    chunks_hex: chunks.map(hex),
    chunk_count: chunks.length,
    chunk_capacity: c.capacity,
    frame_valid: true,
    result_code: 0,
    note: c.note,
  });
  return chunks.length;
}

{
  const payload = sceneStep(0, 0, 0, 0, 1000, layerStatic(0, 255), layerEmpty());
  const n = pushChunkCase({
    name: 'chunking_single_chunk', command: 0x26, commandName: 'SceneStep', seq: 110,
    payload, capacity: 180,
    note: '正常 MTU：32 字节帧一次写完，ctrl = FIRST|LAST = 0xC0',
  });
  if (n !== 1) throw new Error(`expected 1 chunk, got ${n}`);
}
{
  const payload = sceneStep(0, 0, 0, 0, 1000, layerStatic(0, 255), layerEmpty());
  const n = pushChunkCase({
    name: 'chunking_two_chunks', command: 0x26, commandName: 'SceneStep', seq: 111,
    payload, capacity: 20,
    note: 'MTU 23（cap 20）：32 字节帧分 2 片，首片 FIRST、次片 LAST',
  });
  if (n !== 2) throw new Error(`expected 2 chunks, got ${n}`);
}
{
  const payload = buildState();
  const n = pushChunkCase({
    name: 'chunking_three_chunks_state_report', command: 0x82, commandName: 'StateReport',
    seq: 112, payload, capacity: 20, direction: 'device_to_app',
    note: 'StateReport 40 字节帧在 MTU 23（cap 20）下分 3 片；notify 侧同样要重组',
  });
  if (n !== 3) throw new Error(`expected 3 chunks, got ${n}`);
}

/* ---------------- 信封层非法帧：直接给出字节，不走构造器 ---------------- */

function rawCase(c) {
  const bytes = Array.from({ length: c.frameHex.length / 2 }, (_, i) =>
    parseInt(c.frameHex.slice(i * 2, i * 2 + 2), 16),
  );
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
    chunks_hex: chunkFrame(bytes).map(hex),
    frame_valid: false,
    result_code: c.result,
    note: c.note,
  });
}

{
  const powerOn = logicalFrame(0x01, 200, [1]);
  rawCase({
    name: 'bad_magic',
    command: 0x01, commandName: 'SetPower', seq: 200, payloadHex: '01',
    frameHex: hex([0xa5, VER, 0x01, 200, 0x01, 0x00, 0x01, 0x00, 0x00]),
    result: 0x08,
    note: 'magic 0xA5 → BadMagic。magic 先于 CRC 校验，所以 CRC 填 0 也没关系',
  });
  rawCase({
    name: 'bad_version_v4',
    command: 0x01, commandName: 'SetPower', seq: 200, payloadHex: '01',
    frameHex: hex([MAGIC, 0x04, 0x01, 200, 0x01, 0x00, 0x01, 0x00, 0x00]),
    result: 0x07,
    note: 'version 0x04（v4）→ UnsupportedVersion。v4 帧不会被 v5 固件执行',
  });
  rawCase({
    name: 'bad_version_v3',
    command: 0x01, commandName: 'SetPower', seq: 200, payloadHex: '01',
    frameHex: hex([MAGIC, 0x03, 0x01, 200, 0x01, 0x00, 0x01, 0x00, 0x00]),
    result: 0x07,
    note: 'version 0x03 → UnsupportedVersion',
  });
  {
    const bad = [...powerOn];
    bad[bad.length - 1] ^= 0xff;
    rawCase({
      name: 'bad_crc',
      command: 0x01, commandName: 'SetPower', seq: 200, payloadHex: '01',
      frameHex: hex(bad),
      result: 0x03,
      note: 'CRC 高字节被篡改 → BadChecksum',
    });
  }
  {
    const bad = [...powerOn];
    bad[4] = 200; // length 越界
    rawCase({
      name: 'bad_length_overflow',
      command: 0x01, commandName: 'SetPower', seq: 200, payloadHex: '01',
      frameHex: hex(bad),
      result: 0x04,
      note: 'length 200 但实际只有 1 字节载荷 → BadLength',
    });
  }
}

/* ---------------- 自检：保证向量与契约不会漂移 ---------------- */

for (const c of cases) {
  if (c.frame_valid && c.frame_len !== 8 + c.payload_len) {
    throw new Error(`${c.name}: frame_len ${c.frame_len} != 8 + payload_len ${c.payload_len}`);
  }
  // 分片带 1 字节 ctrl 头，剥掉后拼起来必须正好是逻辑帧。
  const reconstructed = c.chunks_hex.map((h) => h.slice(2)).join('');
  if (reconstructed !== c.frame_hex) {
    throw new Error(`${c.name}: chunks do not reconstruct to the logical frame`);
  }
  if (c.payload_len > 232) {
    throw new Error(`${c.name}: payload ${c.payload_len}B exceeds MAX_PAYLOAD 232`);
  }
}

const doc = {
  protocol_version: 5,
  magic: '0xA6',
  crc16: 'CCITT-FALSE poly 0x1021 init 0xFFFF, no reflect, no xorout',
  frame_layout: 'magic(1) version(1) command(1) seq(1) length(2 LE) payload(length) crc16(2 LE)',
  chunk_layout: 'ctrl(1) data(<=179); ctrl bit7=FIRST bit6=LAST bits5..0=chunk index',
  state_bytes: STATE_BYTES,
  state_read_example_hex: hex(buildState()),
  state_read_fields: [
    'power', 'brightness', 'max_brightness', 'strip_count', 'strip_power_mask',
    'active_scene', 'layout_valid', 'reserved',
    'led_count[8] (u16 LE)', 'part_count[8] (u8)',
  ],
  cases,
};

fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`${cases.length} cases -> ${path.relative(ROOT, OUT)}`);
console.log(`state example: ${doc.state_read_example_hex}`);
