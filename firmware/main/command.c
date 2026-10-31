#include "command.h"

#include <stddef.h>
#include <string.h>

#include "effects.h"

bool lumen_command_is_known(uint8_t command)
{
    /*
     * 只包含「已实现」的命令（docs/protocol-v3.md §6）。0x03 / 0x04 在 v2 退役，
     * 落到 default → 0x02 未知命令，小程序能明确看到「该命令需要升级固件」。
     * v3 加入 0x1B SetStripPower / 0x1C QueryStripConfig / 0x1D QueryDeviceInfo。
     *
     * 0x1B 在 #36 只做取值校验与意图登记（真正的掩码写入与 TDM 跳带是 #38）；
     * 已实现的是「认识这条命令并按 §5 的顺序校验」，不是完整行为。
     */
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
    case LUMEN_CMD_QUERY_STATE:
    case LUMEN_CMD_SET_LED_COUNT:
    case LUMEN_CMD_SELF_TEST:
    case LUMEN_CMD_SET_SEGMENT:
    case LUMEN_CMD_CLEAR_SEGMENT:
    case LUMEN_CMD_QUERY_STRIP:
    case LUMEN_CMD_SET_PLAYBACK:
    case LUMEN_CMD_SCRIPT_BEGIN:
    case LUMEN_CMD_SCRIPT_STAGE:
    case LUMEN_CMD_SCRIPT_SEGMENT:
    case LUMEN_CMD_SCRIPT_COMMIT:
    case LUMEN_CMD_SCRIPT_ABORT:
    case LUMEN_CMD_ACTIVATE_SCRIPT:
    case LUMEN_CMD_QUERY_SCRIPT:
    case LUMEN_CMD_SET_STRIP_POWER:
    case LUMEN_CMD_QUERY_STRIP_CONFIG:
    case LUMEN_CMD_QUERY_DEVICE_INFO:
        return true;
    default:
        return false;
    }
}

uint8_t lumen_command_payload_len(uint8_t command)
{
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
        return 1;
    case LUMEN_CMD_QUERY_STATE:
    case LUMEN_CMD_SELF_TEST:
    case LUMEN_CMD_QUERY_STRIP_CONFIG:
    case LUMEN_CMD_QUERY_DEVICE_INFO:
        return 0;
    case LUMEN_CMD_SET_LED_COUNT:
        /* strip_id + count 小端（docs/protocol-v3.md §6）。 */
        return 3;
    case LUMEN_CMD_SET_STRIP_POWER:
        /* strip_id, on。 */
        return 2;
    case LUMEN_CMD_CLEAR_SEGMENT:
        return 2;
    case LUMEN_CMD_QUERY_STRIP:
        return 1;
    case LUMEN_CMD_SET_PLAYBACK:
        /* action, loop。 */
        return 2;
    case LUMEN_CMD_SCRIPT_BEGIN:
        /* script_id, stage_count, strip_count。 */
        return 3;
    case LUMEN_CMD_SCRIPT_STAGE:
        /* script_id, stage_index, duration_ms(2), fade_ms(2)。 */
        return 6;
    case LUMEN_CMD_SCRIPT_SEGMENT:
        /* 固定 23：script_id + stage_index + §7.1 的 21 字节段。 */
        return 23;
    case LUMEN_CMD_SCRIPT_COMMIT:
    case LUMEN_CMD_SCRIPT_ABORT:
    case LUMEN_CMD_QUERY_SCRIPT:
        /* script_id。 */
        return 1;
    case LUMEN_CMD_ACTIVATE_SCRIPT:
        /* script_id, loop。 */
        return 2;
    case LUMEN_CMD_SET_SEGMENT:
        /* 固定 21（docs/protocol-v3.md §7.1）：定宽层编码，不再按 type 变长。 */
        return 21;
    default:
        return 0;
    }
}

bool lumen_command_payload_len_ok(const lumen_frame_t *frame)
{
    if (frame == NULL) {
        return false;
    }
    /*
     * v3 的段命令都是**固定长度**（21 / 23），不再有「先读 type 再定长」的
     * 二次校验路径——这正是 §7.1 选择定宽层编码的目的。长度不符一律
     * BadLength，交给 type 校验之前就拒。
     */
    return frame->payload_len == lumen_command_payload_len(frame->command);
}

/*
 * SetPower 0x01：载荷 1 字节，只接受 0 / 1。
 * 与当前 power 相同时不 commit（避免无意义的刷新与 NVS 写入），ACK 仍为 0x00。
 */
static void dispatch_set_power(const lumen_frame_t *frame, const lumen_state_t *current,
                               lumen_command_outcome_t *outcome)
{
    if (frame->payload_len != 1) {
        outcome->result_code = LUMEN_RESULT_BAD_LENGTH;
        return;
    }
    uint8_t power = frame->payload[0];
    if (power > 1) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    if (current->power != power) {
        outcome->next.power = power;
        outcome->state_changed = true;
    }
}

/*
 * SetBrightness 0x02：载荷 1 字节 0-255，按 §11.4 钳位到构建期上限。
 *
 * 关键语义：
 *  - 越界不拒绝：钳位后照常回 0x00（协议 §6 的 SetBrightness 没有错误码）。
 *  - 只写 brightness，绝不动 power：亮度 0 是合法状态，视觉等于关灯，
 *    但设备状态里 power 仍为 1；关灯也保留亮度（§7）。
 *  - 钳位后的值与当前值相同则不 commit（避免无意义的渲染与 NVS 写入）。
 */
static void dispatch_set_brightness(const lumen_frame_t *frame,
                                    const lumen_state_t *current, uint8_t max_brightness,
                                    lumen_command_outcome_t *outcome)
{
    uint8_t requested = frame->payload[0];
    uint8_t effective = lumen_state_clamp_brightness(requested, max_brightness);

    outcome->result_code = LUMEN_RESULT_OK;
    if (current->brightness != effective) {
        outcome->next.brightness = effective;
        outcome->state_changed = true;
    }
}

bool lumen_command_changes_state(uint8_t command)
{
    /* 协议 §11.2 第 5 条列出的改变状态命令；QueryState / SelfTest / QueryStrip 不在其中。
     * v2 的 0x03 / 0x04 已退役，不再属于这一类别。 */
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
    case LUMEN_CMD_SET_LED_COUNT:
    case LUMEN_CMD_SET_SEGMENT:
    case LUMEN_CMD_CLEAR_SEGMENT:
    case LUMEN_CMD_SET_PLAYBACK:
    case LUMEN_CMD_SCRIPT_BEGIN:
    case LUMEN_CMD_SCRIPT_STAGE:
    case LUMEN_CMD_SCRIPT_SEGMENT:
    case LUMEN_CMD_SCRIPT_COMMIT:
    case LUMEN_CMD_SCRIPT_ABORT:
    case LUMEN_CMD_ACTIVATE_SCRIPT:
    case LUMEN_CMD_SET_STRIP_POWER:
        return true;
    default:
        return false;
    }
}

/*
 * SetLedCount 0x06：v2 载荷 3 字节 strip_id, count_lo, count_hi，合法数量 1-64（§6）。
 *
 * 关键语义（§11.3）：
 *  - 这里只校验并标记「需要重建」。数量必须在渲染任务重建 led_strip 成功后
 *    才写入共享状态，ACK 也要等重建结果——所以本 reducer 不改 next、
 *    state_changed 保持 false，由 led_engine 在重建完成时提交 / 回滚。
 *  - strip_id 必须先落在 0 ≤ strip_id < strip_count 内（#29 之后多条灯带各自
 *    独立设置灯珠数）。先校验 strip_id 再校验数量，保证「这条命令到底改
 *    哪条灯带」先被确认。
 *  - 越界（0、>64、小端读出的 65535 等）→ 0x01，不请求重建、不改状态。
 */
static void dispatch_set_led_count(const lumen_frame_t *frame, const lumen_state_t *current,
                                   lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    if (strip_id >= current->strip_count || strip_id >= LUMEN_MAX_STRIPS) {
        /* 不存在的灯带：拒绝而不是静默忽略，否则用户以为设成功但没反应。 */
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    uint16_t count = (uint16_t)(frame->payload[1] | ((uint16_t)frame->payload[2] << 8));
    if (count < 1 || count > LUMEN_MAX_LEDS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->led_count_rebuild = true;
    outcome->led_count = count;
    outcome->led_count_strip = strip_id;
}

/*
 * 从 v3 段载荷解析层与段。
 *
 * 载荷布局（docs/protocol-v3.md §7.1）：固定 21 字节
 *   0 strip_id | 1 seg_id | 2 start | 3 end | 4 blend | 5..12 layer0 | 13..20 layer1
 *
 * 层是 8 字节定宽：type + param[7]。参数块语义沿用 docs/effects-spec.md §2：
 *   param[0..1] hue | param[2] sat | param[3..4] period_ms | param[5] p5 | param[6] flags
 *
 * 为什么定宽：未知 type 也能安全判定为非法而不是越界读（§7.1 的取舍记录）。
 * 这也是 v3 段命令长度固定的原因，命令层不再需要「先读 type 再定长」。
 */
typedef struct {
    uint8_t type;
    uint8_t param[7];
} lumen_wire_layer_t;

#define LUMEN_WIRE_SEGMENT_BYTES 21
#define LUMEN_WIRE_LAYER_BYTES 8

static void wire_layer_read(const uint8_t *src, lumen_wire_layer_t *out)
{
    out->type = src[0];
    memcpy(out->param, &src[1], sizeof(out->param));
}

/*
 * 单层的 §7.1 规则（第 2/3/6/7 步）。
 * layer0 不允许为空层；空层的参数必须全 0（防止将来语义漂移时旧固件静默接受）。
 */
static uint8_t validate_layer(const lumen_wire_layer_t *layer, bool is_layer0)
{
    if (layer->type == LUMEN_NO_EFFECT) {
        for (size_t i = 0; i < sizeof(layer->param); ++i) {
            if (layer->param[i] != 0) {
                return LUMEN_RESULT_INVALID_PARAM;
            }
        }
        return is_layer0 ? LUMEN_RESULT_INVALID_PARAM : LUMEN_RESULT_OK;
    }
    if (!lumen_effect_type_known(layer->type)) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (layer->type == LUMEN_EFFECT_STATIC) {
        /* 第 6 步：静态层的 param[3..6] 是保留位，必须全 0。 */
        for (size_t i = 3; i < sizeof(layer->param); ++i) {
            if (layer->param[i] != 0) {
                return LUMEN_RESULT_INVALID_PARAM;
            }
        }
    }
    uint16_t period = (uint16_t)(layer->param[3] | ((uint16_t)layer->param[4] << 8));
    return lumen_segment_store_validate_params(layer->type, layer->param[6], period);
}

/* 把 8 字节层映射到现有的平铺段结构（#36 不引入两层结构，#37 才改）。 */
static void wire_layer_to_segment(const lumen_wire_layer_t *layer, lumen_segment_t *seg)
{
    seg->type = layer->type;
    seg->hue = (uint16_t)(layer->param[0] | ((uint16_t)layer->param[1] << 8));
    seg->sat = layer->param[2];
    seg->period_ms = 0;
    seg->p5 = 0;
    seg->flags = 0;
    if (lumen_effect_param_len(layer->type) > 3u) {
        seg->period_ms = (uint16_t)(layer->param[3] | ((uint16_t)layer->param[4] << 8));
        seg->p5 = layer->param[5];
        seg->flags = layer->param[6];
    }
}

/*
 * #32 剧本命令的形状校验（docs/protocol.md §6 / §11.3）。
 *
 * 这里只做「命令层能判定」的部分：id / 下标 / 类型 / 长度 / 时长非 0。
 * 区间越界与重叠是**整份**校验，必须等 ScriptCommit（协议 §10.4 明确：
 * 失败回滚发生在 commit，逐帧下发的中间态允许不完整）。
 *
 * 真正的暂存 / 提交 / 激活在 led_engine 里执行——它持剧本表与锁。
 */

/* SetPlayback 0x13：action ∈ {0,1,2}，loop ∈ {0,1}。 */
static void dispatch_set_playback(const lumen_frame_t *frame, const lumen_state_t *current,
                                  lumen_command_outcome_t *outcome)
{
    uint8_t action = frame->payload[0];
    uint8_t loop = frame->payload[1];
    if (action > 2) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (loop > 1) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    /* 没有激活剧本时 stop / pause 仍合法（幂等），play 也无副作用。 */
    (void)current;
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->script_op = LUMEN_SCRIPT_OP_PLAYBACK;
    outcome->script_action = action;
    outcome->script_loop = loop != 0;
}

/* ScriptBegin 0x14：script_id < MAX_SCRIPTS，stage_count 1-8，strip_count 1-8。 */
static void dispatch_script_begin(const lumen_frame_t *frame, const lumen_state_t *current,
                                  lumen_command_outcome_t *outcome)
{
    uint8_t script_id = frame->payload[0];
    uint8_t stage_count = frame->payload[1];
    uint8_t strip_count = frame->payload[2];

    if (script_id >= LUMEN_MAX_SCRIPTS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (stage_count < 1 || stage_count > LUMEN_MAX_STAGES) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    /*
     * strip_count 不能超过设备实际配置的灯带数：声明 8 条但设备只有 1 条时，
     * 后续 ScriptSegment 会永远被拒，用户看到的是一套下发不完的剧本。
     * 提前在 Begin 就明确拒绝。
     */
    if (strip_count < 1 || strip_count > LUMEN_MAX_STRIPS ||
        strip_count > current->strip_count) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->script_op = LUMEN_SCRIPT_OP_BEGIN;
    outcome->script_id = script_id;
    outcome->script_stage_count = stage_count;
    outcome->script_strip_count = strip_count;
}

/* ScriptStage 0x15：duration 非 0（stage_index 的上界由引擎按本次 Begin 校验）。 */
static void dispatch_script_stage(const lumen_frame_t *frame, lumen_command_outcome_t *outcome)
{
    uint8_t script_id = frame->payload[0];
    uint8_t stage_index = frame->payload[1];
    uint16_t duration =
        (uint16_t)(frame->payload[2] | ((uint16_t)frame->payload[3] << 8));
    uint16_t fade = (uint16_t)(frame->payload[4] | ((uint16_t)frame->payload[5] << 8));

    if (script_id >= LUMEN_MAX_SCRIPTS || stage_index >= LUMEN_MAX_STAGES) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (duration == 0) {
        /* 协议 §9.6：脚本类命令额外校验 duration_ms != 0。 */
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    /*
     * fade_ms 在 v3 是**格式预留**（docs/protocol-v3.md §9.6）：非 0 值照常接受，
     * 但播放行为仍是硬切。#39 才把它存进阶段结构并接进剧本 blob v2；#36 只保证
     * 「不因这个字段拒收」，所以这里刻意只校验长度、不校验取值。
     */
    (void)fade;
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->script_op = LUMEN_SCRIPT_OP_STAGE;
    outcome->script_id = script_id;
    outcome->script_stage_index = stage_index;
    outcome->script_duration_ms = duration;
}

/*
 * ScriptSegment 0x16：载荷
 *   script_id, stage_index, 然后 §7.1 的 21 字节段（共 23 字节）。
 *
 * 注意字段顺序：两个前缀字节在**最前面**（与 v2 的 script_id/stage_index 前缀
 * 一致，测试向量也是这么排的）。docs/protocol-v3.md §7.1 的「末尾再追加」
 * 只是描述长度来源；字节级契约以向量为准。
 *
 * 与 SetSegment 的差别只有一条：**两层都空表示「清空该槽位」**（§9.6），
 * 所以这里 layer0 允许为空层，但「layer0 空、layer1 非空」仍是非法。
 *
 * 第 5 步 strip 范围用**本次下发的 strip_count** 判断不了（命令层没有暂存区），
 * 所以下界只到 LUMEN_MAX_STRIPS；引擎在写入时按暂存的 strip_count 再拒一次。
 * 区间与重叠留给 ScriptCommit（§9.6）。
 */
static void dispatch_script_segment(const lumen_frame_t *frame,
                                    lumen_command_outcome_t *outcome)
{
    uint8_t script_id = frame->payload[0];
    uint8_t stage_index = frame->payload[1];
    uint8_t strip_id = frame->payload[2];
    uint8_t seg_id = frame->payload[3];
    uint8_t start = frame->payload[4];
    uint8_t end = frame->payload[5];
    uint8_t blend = frame->payload[6];

    if (script_id >= LUMEN_MAX_SCRIPTS || stage_index >= LUMEN_MAX_STAGES ||
        strip_id >= LUMEN_MAX_STRIPS || seg_id >= LUMEN_MAX_SEGMENTS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }

    if (start > end) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }

    lumen_wire_layer_t layer0;
    lumen_wire_layer_t layer1;
    wire_layer_read(&frame->payload[7], &layer0);
    wire_layer_read(&frame->payload[15], &layer1);

    if (layer0.type == LUMEN_NO_EFFECT && layer1.type == LUMEN_NO_EFFECT) {
        /*
         * 清空槽位（§9.6）：效果等同于不下发该段。交出非活动段，由调用方
         * 释放槽位；#39 的剧本两层结构落地后这里会带上 layer/blend 字段。
         */
        outcome->result_code = LUMEN_RESULT_OK;
        outcome->script_op = LUMEN_SCRIPT_OP_SEGMENT;
        outcome->script_id = script_id;
        outcome->script_stage_index = stage_index;
        outcome->script_strip = strip_id;
        outcome->script_seg = seg_id;
        outcome->script_segment = (lumen_segment_t){0};
        return;
    }

    if (validate_layer(&layer0, true) != LUMEN_RESULT_OK ||
        validate_layer(&layer1, false) != LUMEN_RESULT_OK) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (layer1.type == LUMEN_NO_EFFECT && blend != 0) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (blend > 0x02) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (!lumen_effect_type_implemented(layer0.type) ||
        (layer1.type != LUMEN_NO_EFFECT && !lumen_effect_type_implemented(layer1.type))) {
        outcome->result_code = LUMEN_RESULT_UNKNOWN_COMMAND;
        return;
    }

    lumen_segment_t candidate;
    memset(&candidate, 0, sizeof(candidate));
    candidate.active = true;
    candidate.start = start;
    candidate.end = end;
    wire_layer_to_segment(&layer0, &candidate);
    candidate.t0_ms = 0;

    outcome->result_code = LUMEN_RESULT_OK;
    outcome->script_op = LUMEN_SCRIPT_OP_SEGMENT;
    outcome->script_id = script_id;
    outcome->script_stage_index = stage_index;
    outcome->script_strip = strip_id;
    outcome->script_seg = seg_id;
    outcome->script_segment = candidate;
}

/*
 * SetStripPower 0x1B（docs/protocol-v3.md §9.5）：strip_id 必须已分配、on ∈ {0,1}。
 *
 * #36 只做校验与意图登记（outcome->strip_power_op）；掩码写入、推黑帧与 TDM
 * 跳带在 #38。命令仍然**算已知命令**：小程序要能收到 ACK 0x00，而不是被旧
 * 固件的 0x02 误导成「这个固件不支持」。
 */
static void dispatch_set_strip_power(const lumen_frame_t *frame, const lumen_state_t *current,
                                     lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    uint8_t on = frame->payload[1];
    if (strip_id >= current->strip_count || strip_id >= LUMEN_MAX_STRIPS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (on > 1) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->strip_power_op = true;
    outcome->strip_power_strip = strip_id;
    outcome->strip_power_on = on != 0;
}

/* ScriptCommit / ScriptAbort / QueryScript 共用 1 字节 script_id。 */
static void dispatch_script_single_id(const lumen_frame_t *frame, uint8_t op,
                                      lumen_command_outcome_t *outcome)
{
    uint8_t script_id = frame->payload[0];
    /* QueryScript 允许查 0xFF（表示「问当前激活的是谁以外」没有意义，仍拒）。 */
    if (script_id >= LUMEN_MAX_SCRIPTS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->script_op = op;
    outcome->script_id = script_id;
}

/* ActivateScript 0x19：script_id, loop。 */
static void dispatch_activate_script(const lumen_frame_t *frame,
                                     lumen_command_outcome_t *outcome)
{
    uint8_t script_id = frame->payload[0];
    uint8_t loop = frame->payload[1];
    if (script_id >= LUMEN_MAX_SCRIPTS || loop > 1) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->script_op = LUMEN_SCRIPT_OP_ACTIVATE;
    outcome->script_id = script_id;
    outcome->script_loop = loop != 0;
}

/*
 * 取某条灯带的灯珠数：优先用 #29 的 per-strip 表，没有表（单灯带 / host 单测）
 * 时退回 State 的 strip 0 值。越界/未初始化时按协议上限处理。
 */
uint16_t lumen_command_strip_count(const lumen_state_t *current, const uint16_t *strip_counts,
                                   uint8_t strip_id)
{
    if (current == NULL) {
        return 0;
    }
    uint16_t count = 0;
    if (strip_counts != NULL && strip_id < LUMEN_MAX_STRIPS) {
        count = strip_counts[strip_id];
    }
    if (count == 0) {
        count = current->led_count; /* 单灯带 / 未提供表：退回 strip 0 值 */
    }
    if (count == 0 || count > LUMEN_MAX_LEDS) {
        count = LUMEN_MAX_LEDS; /* 防御：状态未初始化时按协议上限 */
    }
    return count;
}

/*
 * SetSegment 0x10（#25 / #30 / #31 / #36）。
 *
 * 校验顺序严格按 docs/protocol-v3.md §7.1（再叠 §5 的信封级顺序）：
 *   1 载荷长度精确等于 21（在上层 payload_len_ok 完成）
 *   2 layer0 已知且不为 0xFF
 *   3 layer1 已知或 0xFF
 *   4 layer1 为空 ⇒ blend 必须为 0
 *   5 blend ≤ 2
 *   6 静态层 param[3..6] 全 0
 *   7 各层按 type 校验参数（周期下限、flags 保留位）
 *   然后 strip 范围 / 区间 / 重叠（lumen_segment_store_validate）
 *
 * #36 仍写进 v2 的平铺 lumen_segment_t：layer1 参与校验但**不落库**（#37 的两层
 * 结构才持有它）。这样 v3 的下发能被严格校验，而段表 / blob / 渲染保持可用。
 */
static void dispatch_set_segment(const lumen_frame_t *frame, const lumen_state_t *current,
                                 const lumen_segment_store_t *segments,
                                 const uint16_t *strip_counts,
                                 lumen_command_outcome_t *outcome)
{
    if (frame->payload_len != LUMEN_WIRE_SEGMENT_BYTES) {
        outcome->result_code = LUMEN_RESULT_BAD_LENGTH;
        return;
    }

    lumen_wire_layer_t layer0;
    lumen_wire_layer_t layer1;
    wire_layer_read(&frame->payload[5], &layer0);
    wire_layer_read(&frame->payload[13], &layer1);

    /* 第 2/3 步：layer0 不得为空，layer1 可为空层。 */
    if (validate_layer(&layer0, true) != LUMEN_RESULT_OK ||
        validate_layer(&layer1, false) != LUMEN_RESULT_OK) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }

    uint8_t blend = frame->payload[4];
    /* 第 4 步：单层（layer1 为空）时 blend 必须为 0。 */
    if (layer1.type == LUMEN_NO_EFFECT && blend != 0) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    /* 第 5 步：blend 只允许 覆盖/相乘/相加。 */
    if (blend > 0x02) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }

    if (!lumen_effect_type_implemented(layer0.type) ||
        (layer1.type != LUMEN_NO_EFFECT && !lumen_effect_type_implemented(layer1.type))) {
        /* 协议已知但本固件未实现：明确回 UnknownCommand，不假装成功。 */
        outcome->result_code = LUMEN_RESULT_UNKNOWN_COMMAND;
        return;
    }

    lumen_segment_t candidate;
    memset(&candidate, 0, sizeof(candidate));
    candidate.active = true;
    candidate.start = frame->payload[2];
    candidate.end = frame->payload[3];
    wire_layer_to_segment(&layer0, &candidate);
    candidate.t0_ms = 0; /* 生效时刻由 led_engine 在真正写入时填 */

    /* strip 范围 / 区间 / 重叠（段配置快照为 NULL 时视为「没有任何活动段」）。 */
    static const lumen_segment_store_t k_empty_store;
    const lumen_segment_store_t *store = segments != NULL ? segments : &k_empty_store;

    uint8_t strip_id = frame->payload[0];
    uint8_t seg_id = frame->payload[1];
    if (seg_id >= LUMEN_MAX_SEGMENTS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    /*
     * 灯珠数必须按「这条灯带自己」的数字校验（#29）。current->led_count 只是
     * strip 0 的；拿它校验 strip 3 会放行真实越界（设成功但后半段不亮），
     * 或误拒合法段。
     */
    uint16_t led_count = lumen_command_strip_count(current, strip_counts, strip_id);

    uint8_t result = lumen_segment_store_validate(store, strip_id, current->strip_count, seg_id,
                                                  (uint8_t)led_count, &candidate);
    outcome->result_code = result;
    if (result != LUMEN_RESULT_OK) {
        return;
    }

    /* 校验通过：把写入意图交给调用方（段配置不在 lumen_state_t 里）。 */
    outcome->segment_op = true;
    outcome->segment_clear = false;
    outcome->segment_strip = strip_id;
    outcome->segment_id = seg_id;
    outcome->segment = candidate;
}

/*
 * ClearSegment 0x11（#25）：释放槽位，其灯珠归入未覆盖区（写 0）。
 * 幂等：清一个本来就不活动的槽位也回 0x00（命令是绝对值语义）。
 */
static void dispatch_clear_segment(const lumen_frame_t *frame, const lumen_state_t *current,
                                   lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    uint8_t seg_id = frame->payload[1];
    if (strip_id >= current->strip_count || strip_id >= LUMEN_MAX_STRIPS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (seg_id >= LUMEN_MAX_SEGMENTS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->segment_op = true;
    outcome->segment_clear = true;
    outcome->segment_strip = strip_id;
    outcome->segment_id = seg_id;
}

/*
 * QueryStrip 0x12（#25）：只做 strip 范围校验，真正的多帧回包由 ble_link
 * 在 ACK 之后发出（seg_count 条 SegmentReport + 1 条 SegmentListEnd，同 seq）。
 */
static void dispatch_query_strip(const lumen_frame_t *frame, const lumen_state_t *current,
                                 lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    if (strip_id >= current->strip_count || strip_id >= LUMEN_MAX_STRIPS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->strip_query = true;
    outcome->query_strip_id = strip_id;
}

void lumen_command_dispatch(const lumen_frame_t *frame, const lumen_state_t *current,
                            const lumen_segment_store_t *segments,
                            const uint16_t *strip_counts, uint8_t max_brightness,
                            lumen_command_outcome_t *outcome)
{
    if (frame == NULL || current == NULL || outcome == NULL) {
        return;
    }

    /* 默认：状态不变、结果码未知、不碰自检，等具体分支覆盖。 */
    outcome->result_code = LUMEN_RESULT_UNKNOWN_COMMAND;
    outcome->state_changed = false;
    outcome->start_selftest = false;
    outcome->cancels_selftest = false;
    outcome->state_report = false;
    outcome->led_count_rebuild = false;
    outcome->led_count = current->led_count;
    outcome->led_count_strip = 0;
    outcome->segment_op = false;
    outcome->segment_clear = false;
    outcome->segment_strip = 0;
    outcome->segment_id = 0;
    outcome->segment = (lumen_segment_t){0};
    outcome->strip_query = false;
    outcome->query_strip_id = 0;
    outcome->strip_power_op = false;
    outcome->strip_power_strip = 0;
    outcome->strip_power_on = false;
    outcome->strip_config_query = false;
    outcome->device_info_query = false;
    outcome->script_op = LUMEN_SCRIPT_OP_NONE;
    outcome->script_id = LUMEN_NO_SCRIPT;
    outcome->script_action = 0;
    outcome->script_stage_count = 0;
    outcome->script_strip_count = 0;
    outcome->script_stage_index = 0;
    outcome->script_duration_ms = 0;
    outcome->script_strip = 0;
    outcome->script_seg = 0;
    outcome->script_segment.active = false;
    outcome->script_loop = false;
    outcome->next = *current;

    /*
     * §11.3 顺序：command (0x02) → payload 长度 (0x04) → payload 取值 (0x01)。
     * 先判命令字是否协议已知，再判该命令的载荷长度，最后才看取值。
     */
    if (!lumen_command_is_known(frame->command)) {
        return; /* 0x08-0xFF（含保留命令、app 写入 0x80）→ 0x02 */
    }

    if (!lumen_command_payload_len_ok(frame)) {
        outcome->result_code = LUMEN_RESULT_BAD_LENGTH;
        return;
    }

    switch (frame->command) {
    case LUMEN_CMD_SET_POWER:
        dispatch_set_power(frame, current, outcome);
        break;

    case LUMEN_CMD_SET_BRIGHTNESS:
        dispatch_set_brightness(frame, current, max_brightness, outcome);
        break;

    case LUMEN_CMD_SET_LED_COUNT:
        /*
         * #12 实现重建语义；这里**不能 return**——必须走到下面的统一收尾，
         * 否则 SetLedCount 不会置 cancels_selftest（§11.2 第 5 条要求灯珠
         * 数量变更同样立即取消自检）。
         */
        dispatch_set_led_count(frame, current, outcome);
        break;

    case LUMEN_CMD_SET_SEGMENT:
        dispatch_set_segment(frame, current, segments, strip_counts, outcome);
        break;

    case LUMEN_CMD_CLEAR_SEGMENT:
        dispatch_clear_segment(frame, current, outcome);
        break;

    case LUMEN_CMD_QUERY_STRIP:
        dispatch_query_strip(frame, current, outcome);
        break;

    case LUMEN_CMD_SET_PLAYBACK:
        dispatch_set_playback(frame, current, outcome);
        break;

    case LUMEN_CMD_SCRIPT_BEGIN:
        dispatch_script_begin(frame, current, outcome);
        break;

    case LUMEN_CMD_SCRIPT_STAGE:
        dispatch_script_stage(frame, outcome);
        break;

    case LUMEN_CMD_SCRIPT_SEGMENT:
        dispatch_script_segment(frame, outcome);
        break;

    case LUMEN_CMD_SCRIPT_COMMIT:
        dispatch_script_single_id(frame, LUMEN_SCRIPT_OP_COMMIT, outcome);
        break;

    case LUMEN_CMD_SCRIPT_ABORT:
        dispatch_script_single_id(frame, LUMEN_SCRIPT_OP_ABORT, outcome);
        break;

    case LUMEN_CMD_ACTIVATE_SCRIPT:
        dispatch_activate_script(frame, outcome);
        break;

    case LUMEN_CMD_QUERY_SCRIPT:
        dispatch_script_single_id(frame, LUMEN_SCRIPT_OP_QUERY, outcome);
        break;

    case LUMEN_CMD_QUERY_STATE:
        /* §9.1：回 ACK 0x00，随后由调用方补一条 StateReport。
         * 查询不取消自检，也不改共享状态。 */
        outcome->result_code = LUMEN_RESULT_OK;
        outcome->state_report = true;
        break;

    case LUMEN_CMD_SET_STRIP_POWER:
        dispatch_set_strip_power(frame, current, outcome);
        break;

    case LUMEN_CMD_QUERY_STRIP_CONFIG:
        /* 无载荷查询：ACK 之后一条 StripConfigReport 0x87（§7.4 / §8）。 */
        outcome->result_code = LUMEN_RESULT_OK;
        outcome->strip_config_query = true;
        break;

    case LUMEN_CMD_QUERY_DEVICE_INFO:
        /* 无载荷查询：ACK 之后一条 DeviceInfoReport 0x88（§7.4 / §8）。 */
        outcome->result_code = LUMEN_RESULT_OK;
        outcome->device_info_query = true;
        break;

    case LUMEN_CMD_SELF_TEST:
        /* §11.2 第 1 条：立即回 ACK 0x00；序列由调用方启动。
         * 自检不改共享状态（不写 NVS），因此 state_changed 保持 false。 */
        outcome->result_code = LUMEN_RESULT_OK;
        outcome->start_selftest = true;
        break;

    default:
        /* lumen_command_is_known 已过滤，走不到这里；防御性回 0x02。 */
        outcome->result_code = LUMEN_RESULT_UNKNOWN_COMMAND;
        break;
    }

    /*
     * 统一收尾（协议 §11.2 第 5 条）：只要命令属于「改变状态」的类别且已
     * 被接受，就要求调用方结束自检——即使 state_changed 为 false（值没变）。
     * 非法命令（0x01 / 0x02 / 0x04）不取消自检，因为新命令并未生效。
     */
    outcome->cancels_selftest =
        outcome->result_code == LUMEN_RESULT_OK && lumen_command_changes_state(frame->command);
}
