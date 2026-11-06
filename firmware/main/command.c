#include "command.h"

#include <stddef.h>
#include <string.h>

#include "effects.h"

/*
 * 命令层（纯 reducer）。docs/protocol-v5.md §5 / §6 / §7.1。
 *
 * 校验顺序固定：命令字是否已知（0x02）→ 载荷长度（0x04）→ 载荷取值（0x01）。
 * 命令层只做「一条命令自己能判定」的部分；跨命令的不变量（布局里一颗灯珠
 * 只属一个部位、整份布局是否完整、场景的步号是否 < step_count）交给引擎在
 * 持有权威表时判——那正是 v4 把段校验放在 segment_store 的做法。
 */

bool lumen_command_is_known(uint8_t command)
{
    /*
     * 只包含**已实现**的命令（docs/protocol-v5.md §6）。
     *
     * v5 删掉了整个段 / 剧本族 0x10-0x1E：它们落到 default → 0x02 未知命令，
     * 小程序能明确看到「这个固件不支持该命令」。这些码**不复用**。
     */
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
    case LUMEN_CMD_QUERY_STATE:
    case LUMEN_CMD_SET_LED_COUNT:
    case LUMEN_CMD_SELF_TEST:
    case LUMEN_CMD_SET_STRIP_POWER:
    case LUMEN_CMD_QUERY_STRIP_CONFIG:
    case LUMEN_CMD_QUERY_DEVICE_INFO:
    case LUMEN_CMD_LAYOUT_WRITE:
    case LUMEN_CMD_LAYOUT_PART:
    case LUMEN_CMD_LAYOUT_SEG:
    case LUMEN_CMD_LAYOUT_COMMIT:
    case LUMEN_CMD_QUERY_LAYOUT:
    case LUMEN_CMD_SCENE_PART:
    case LUMEN_CMD_SCENE_STEP:
    case LUMEN_CMD_SCENE_NAME:
    case LUMEN_CMD_ACTIVATE_SCENE:
    case LUMEN_CMD_QUERY_SCENE:
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
    case LUMEN_CMD_ACTIVATE_SCENE:
    case LUMEN_CMD_QUERY_SCENE:
    case LUMEN_CMD_QUERY_LAYOUT:
        return 1;
    case LUMEN_CMD_QUERY_STATE:
    case LUMEN_CMD_SELF_TEST:
    case LUMEN_CMD_QUERY_STRIP_CONFIG:
    case LUMEN_CMD_QUERY_DEVICE_INFO:
    case LUMEN_CMD_LAYOUT_COMMIT:
        return 0;
    case LUMEN_CMD_SET_LED_COUNT:
        /* strip_id + count 小端（§6）。 */
        return 3;
    case LUMEN_CMD_SET_STRIP_POWER:
        /* strip_id, on。 */
        return 2;
    case LUMEN_CMD_LAYOUT_WRITE:
        /* strip_id, part_count。 */
        return 2;
    case LUMEN_CMD_LAYOUT_PART:
        /* strip_id, part_id, name_len, name[24], seg_count（§1.1 LAYOUT_PART_BYTES）。 */
        return LUMEN_LAYOUT_PART_BYTES;
    case LUMEN_CMD_LAYOUT_SEG:
        /* strip_id, part_id, seg_id, start, end。 */
        return 5;
    case LUMEN_CMD_SCENE_PART:
        /* scene_id, strip_id, part_id, step_count, loop, on。 */
        return 6;
    case LUMEN_CMD_SCENE_STEP:
        /* scene, strip, part, step, duration(2), 两层各 9 字节（§1.1）。 */
        return LUMEN_SCENE_STEP_BYTES;
    case LUMEN_CMD_SCENE_NAME:
        /* scene_id, name_len, name[24]。 */
        return LUMEN_SCENE_NAME_BYTES;
    default:
        return 0;
    }
}

bool lumen_command_payload_len_ok(const lumen_frame_t *frame)
{
    if (frame == NULL) {
        return false;
    }
    /* v5 全部命令都是固定长度，没有「先读 type 再定长」的二次校验路径。 */
    return frame->payload_len == lumen_command_payload_len(frame->command);
}

uint16_t lumen_command_strip_count(const lumen_state_t *current, uint8_t strip_id)
{
    if (current == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return LUMEN_MAX_LEDS;
    }
    uint16_t count = current->led_count[strip_id];
    if (count == 0 || count > LUMEN_MAX_LEDS) {
        /* 未配置 / 未初始化：按协议上限兜底（与 v4 同一口径，避免误拒合法段）。 */
        return LUMEN_MAX_LEDS;
    }
    return count;
}

/* ---------------- 整机 ---------------- */

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
 * SetBrightness 0x02：载荷 1 字节 0-255，按构建期上限钳位（§6）。
 *
 * 关键语义：
 *  - 越界不拒绝：钳位后照常回 0x00（协议 §6 的 SetBrightness 没有错误码）。
 *  - 只写 brightness，绝不动 power：亮度 0 是合法状态，视觉等于关灯，
 *    但设备状态里 power 仍为 1；关灯也保留亮度。
 *  - 钳位后的值与当前值相同则不 commit。
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

/*
 * SetLedCount 0x06：载荷 3 字节 strip_id, count_lo, count_hi，合法数量 1-100（§6）。
 *
 * 这里只校验并标记「需要重建」。数量必须在渲染任务重建 led_strip 成功后
 * 才写入共享状态，ACK 也要等重建结果——所以本 reducer 不改 next、
 * state_changed 保持 false，由 led_engine 在重建完成时提交 / 回滚。
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
 * SetStripPower 0x1B（§9.5）：strip_id 必须已分配、on ∈ {0,1}。
 * 掩码写入与渲染门控由调用方执行；命令层只登记意图。
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

/* ---------------- 布局族 0x20-0x24 ---------------- */

/*
 * 该链的部位数（布局快照的权威值）。越界返回 0。
 * 命令层用它判「part_id 是否在该链已声明的部位范围内」——与引擎同一口径，
 * 所以引擎不会因为一条已经通过命令层校验的请求再拒一次。
 */
static uint8_t layout_part_count(const lumen_layout_store_t *layout, uint8_t strip_id)
{
    if (layout == NULL || strip_id >= LUMEN_MAX_STRIPS) {
        return 0;
    }
    return layout->part_count[strip_id];
}

/* LayoutWrite 0x20：strip_id, part_count。声明部位数并清空该链的部位（§6.1 第 1 条）。 */
static void dispatch_layout_write(const lumen_frame_t *frame, const lumen_state_t *current,
                                  lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    uint8_t part_count = frame->payload[1];
    if (strip_id >= current->strip_count) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (part_count > LUMEN_MAX_PARTS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->layout_op = true;
    outcome->layout_opcode = LUMEN_CMD_LAYOUT_WRITE;
    outcome->layout_strip = strip_id;
    outcome->layout_part_count = part_count;
}

/*
 * LayoutPart 0x21：strip_id, part_id, name_len, name[24], seg_count（§6.1 第 2 条）。
 *
 * name_len ≤ 24；name 不足 24 字节的部分由调用方保证补 0（解码端只信任 name_len）。
 * seg_count ≤ 8。part_id 必须已被 LayoutWrite 声明过。
 */
static void dispatch_layout_part(const lumen_frame_t *frame, const lumen_state_t *current,
                                 const lumen_layout_store_t *layout,
                                 lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    uint8_t part_id = frame->payload[1];
    uint8_t name_len = frame->payload[2];
    uint8_t seg_count = frame->payload[27];

    if (strip_id >= current->strip_count) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (part_id >= LUMEN_MAX_PARTS || part_id >= layout_part_count(layout, strip_id)) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (name_len > LUMEN_NAME_BYTES || seg_count > LUMEN_MAX_PART_SEGS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->layout_op = true;
    outcome->layout_opcode = LUMEN_CMD_LAYOUT_PART;
    outcome->layout_strip = strip_id;
    outcome->layout_part = part_id;
    outcome->layout_name_len = name_len;
    outcome->layout_seg_count = seg_count;
    memset(outcome->layout_name, 0, sizeof(outcome->layout_name));
    if (name_len > 0) {
        memcpy(outcome->layout_name, &frame->payload[3], name_len);
    }
}

/*
 * LayoutSeg 0x22：strip_id, part_id, seg_id, start, end（§6.1 第 3 条）。
 *
 * 命令层判：下标范围、start ≤ end、end < 该链灯珠数、seg_id < 该部位声明的
 * seg_count、以及与**同链其它部位的所有段**互斥（S3：一颗灯珠只属一个部位）。
 *
 * 最后一条在这里判（而不是等 LayoutCommit）是刻意与 v4 的 SetSegment 对齐：
 * 向一条已经通过校验的帧回 InvalidParam 时，旧布局保持不变（S4：不自动裁剪、
 * 不覆盖），用户能立刻知道是哪一段压到了谁。
 */
static void dispatch_layout_seg(const lumen_frame_t *frame, const lumen_state_t *current,
                                const lumen_layout_store_t *layout,
                                lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    uint8_t part_id = frame->payload[1];
    uint8_t seg_id = frame->payload[2];
    uint8_t start = frame->payload[3];
    uint8_t end = frame->payload[4];

    if (strip_id >= current->strip_count) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (part_id >= LUMEN_MAX_PARTS || part_id >= layout_part_count(layout, strip_id)) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (seg_id >= LUMEN_MAX_PART_SEGS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    const lumen_part_layout_t *part = lumen_layout_store_part(layout, strip_id, part_id);
    if (part == NULL || seg_id >= part->segs.seg_count) {
        /* 声明了 seg_count 才能写那些槽位——先 LayoutPart 再 LayoutSeg。 */
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (start > end) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    uint16_t led_count = lumen_command_strip_count(current, strip_id);
    if (end >= led_count) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    /* 与同链其它部位的所有段互斥（S3）。未写的段（0xFF）不参与。 */
    for (uint8_t p = 0; p < layout_part_count(layout, strip_id) && p < LUMEN_MAX_PARTS; ++p) {
        const lumen_part_layout_t *other = &layout->part[strip_id][p];
        for (uint8_t s = 0; s < other->segs.seg_count && s < LUMEN_MAX_PART_SEGS; ++s) {
            if (p == part_id && s == seg_id) {
                continue; /* 段号等于自身时视为替换 */
            }
            uint8_t ostart = other->segs.seg[s][0];
            uint8_t oend = other->segs.seg[s][1];
            if (ostart == LUMEN_SEG_UNWRITTEN || oend == LUMEN_SEG_UNWRITTEN) {
                continue;
            }
            if (!(end < ostart || oend < start)) {
                outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
                return;
            }
        }
    }

    outcome->result_code = LUMEN_RESULT_OK;
    outcome->layout_op = true;
    outcome->layout_opcode = LUMEN_CMD_LAYOUT_SEG;
    outcome->layout_strip = strip_id;
    outcome->layout_part = part_id;
    outcome->layout_seg = seg_id;
    outcome->layout_start = start;
    outcome->layout_end = end;
}

/*
 * LayoutCommit 0x23：整份校验 + 立即落盘（§6.1 第 4 条）。
 *
 * 命令层无载荷可判，只登记意图；整份校验（每链部位数、每部位段数、段互斥、
 * 段已写齐）与落盘由引擎在持有布局表时做——它才看得到 RAM 里的完整布局。
 */
static void dispatch_layout_commit(lumen_command_outcome_t *outcome)
{
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->layout_op = true;
    outcome->layout_opcode = LUMEN_CMD_LAYOUT_COMMIT;
}

/* QueryLayout 0x24：ACK 之后逐部位 LayoutReport 0x89 + 一条 LayoutListEnd 0x8A。 */
static void dispatch_query_layout(const lumen_frame_t *frame, const lumen_state_t *current,
                                  lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    if (strip_id >= current->strip_count) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->layout_op = true;
    outcome->layout_opcode = LUMEN_CMD_QUERY_LAYOUT;
    outcome->layout_strip = strip_id;
}

/* ---------------- 场景族 0x25-0x29 ---------------- */

/*
 * ScenePart 0x25：scene_id, strip_id, part_id, step_count, loop, on（§6.2）。
 *
 * **不校验 part_id < 布局的部位数**：场景与布局是两张表（§6.2 末段）。用户可以
 * 先编排时间轴再划灯珠，也可以给一条还没划分的链预置内容。步数为 0 合法
 * （本场景不演，S10）；loop 只有三值；on ∈ {0,1}。
 */
static void dispatch_scene_part(const lumen_frame_t *frame, const lumen_state_t *current,
                                lumen_command_outcome_t *outcome)
{
    uint8_t scene_id = frame->payload[0];
    uint8_t strip_id = frame->payload[1];
    uint8_t part_id = frame->payload[2];
    uint8_t step_count = frame->payload[3];
    uint8_t loop = frame->payload[4];
    uint8_t on = frame->payload[5];

    if (scene_id >= LUMEN_MAX_SCENES || strip_id >= current->strip_count) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (part_id >= LUMEN_MAX_PARTS || step_count > LUMEN_MAX_STEPS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (loop > LUMEN_LOOP_V5_MAX || on > 1) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->scene_op = true;
    outcome->scene_opcode = LUMEN_CMD_SCENE_PART;
    outcome->scene_id = scene_id;
    outcome->scene_strip = strip_id;
    outcome->scene_part = part_id;
    outcome->scene_step_count = step_count;
    outcome->scene_loop = loop;
    outcome->scene_on = on;
}

/*
 * SceneStep 0x26：scene_id, strip_id, part_id, step_index, duration(2),
 * 两层各 9 字节（§6.2 / §7.1）。
 *
 * 命令层判：下标范围、时长区间、两层形状（与 v4 的段完全同一份规则，复用
 * lumen_segment_validate_shape）。「step_index < step_count」需要场景表的上下文，
 * 由引擎判（§6.2 明确单步增量写入）。
 */
static void dispatch_scene_step(const lumen_frame_t *frame, const lumen_state_t *current,
                                lumen_command_outcome_t *outcome)
{
    uint8_t scene_id = frame->payload[0];
    uint8_t strip_id = frame->payload[1];
    uint8_t part_id = frame->payload[2];
    uint8_t step_index = frame->payload[3];
    uint16_t duration = (uint16_t)(frame->payload[4] | ((uint16_t)frame->payload[5] << 8));

    if (scene_id >= LUMEN_MAX_SCENES || strip_id >= current->strip_count) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (part_id >= LUMEN_MAX_PARTS || step_index >= LUMEN_MAX_STEPS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (duration < LUMEN_STEP_MIN_MS || duration > LUMEN_STEP_MAX_MS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }

    /* 两层按 §7.1 的 9 字节定宽解码，再走与段 / blob 同一份形状校验。 */
    lumen_segment_t probe;
    memset(&probe, 0, sizeof(probe));
    probe.active = true;
    (void)lumen_layer_decode(&frame->payload[6], &probe.layer[0]);
    (void)lumen_layer_decode(&frame->payload[15], &probe.layer[1]);
    /*
     * 混合方式**不在线上**（§6.2）：layer1 为空 → 覆盖；非空 → 按亮度叠加。
     * 这里规范化成校验期望的值，让 validate_shape 第 5 步不误判。
     */
    probe.blend = lumen_layer_is_empty(&probe.layer[1]) ? (uint8_t)LUMEN_BLEND_OVER
                                                        : (uint8_t)LUMEN_BLEND_LUMA;
    if (lumen_segment_validate_shape(&probe) != LUMEN_RESULT_OK) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }

    outcome->result_code = LUMEN_RESULT_OK;
    outcome->scene_op = true;
    outcome->scene_opcode = LUMEN_CMD_SCENE_STEP;
    outcome->scene_id = scene_id;
    outcome->scene_strip = strip_id;
    outcome->scene_part = part_id;
    outcome->scene_step_index = step_index;
    outcome->scene_duration_ms = duration;
    memcpy(outcome->scene_layer[0], &frame->payload[6], 9);
    memcpy(outcome->scene_layer[1], &frame->payload[15], 9);
}

/* SceneName 0x27：scene_id, name_len, name[24]。 */
static void dispatch_scene_name(const lumen_frame_t *frame, lumen_command_outcome_t *outcome)
{
    uint8_t scene_id = frame->payload[0];
    uint8_t name_len = frame->payload[1];
    if (scene_id >= LUMEN_MAX_SCENES || name_len > LUMEN_NAME_BYTES) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->scene_op = true;
    outcome->scene_opcode = LUMEN_CMD_SCENE_NAME;
    outcome->scene_id = scene_id;
    outcome->scene_name_len = name_len;
    memset(outcome->scene_name, 0, sizeof(outcome->scene_name));
    if (name_len > 0) {
        memcpy(outcome->scene_name, &frame->payload[2], name_len);
    }
}

/* ActivateScene 0x28 / QueryScene 0x29：都只有 1 字节 scene_id（§6）。 */
static void dispatch_scene_single_id(const lumen_frame_t *frame, uint8_t opcode,
                                     lumen_command_outcome_t *outcome)
{
    uint8_t scene_id = frame->payload[0];
    if (scene_id >= LUMEN_MAX_SCENES) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->scene_op = true;
    outcome->scene_opcode = opcode;
    outcome->scene_id = scene_id;
}

bool lumen_command_changes_state(uint8_t command)
{
    /* docs/protocol-v5.md §9.6：任何会改变持久化内容或输出内容的命令。
     * 查询（含 QueryLayout / QueryScene）与 SelfTest 不在其中。 */
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
    case LUMEN_CMD_SET_LED_COUNT:
    case LUMEN_CMD_SET_STRIP_POWER:
    case LUMEN_CMD_LAYOUT_WRITE:
    case LUMEN_CMD_LAYOUT_PART:
    case LUMEN_CMD_LAYOUT_SEG:
    case LUMEN_CMD_LAYOUT_COMMIT:
    case LUMEN_CMD_SCENE_PART:
    case LUMEN_CMD_SCENE_STEP:
    case LUMEN_CMD_SCENE_NAME:
    case LUMEN_CMD_ACTIVATE_SCENE:
        return true;
    default:
        return false;
    }
}

void lumen_command_dispatch(const lumen_frame_t *frame, const lumen_state_t *current,
                            const lumen_layout_store_t *layout, uint8_t max_brightness,
                            lumen_command_outcome_t *outcome)
{
    if (frame == NULL || current == NULL || outcome == NULL) {
        return;
    }

    /*
     * 先把 current 拷到本地：调用方允许 current 与 outcome->next 指向同一块内存
     * （「把上一条命令的结果当下一条命令的输入」是 host 测试的常见写法），
     * 下面的 memset 会先把 outcome 清零。
     */
    const lumen_state_t baseline = *current;

    /* 默认：状态不变、结果码未知、不碰自检，等具体分支覆盖。 */
    memset(outcome, 0, sizeof(*outcome));
    outcome->result_code = LUMEN_RESULT_UNKNOWN_COMMAND;
    outcome->next = baseline;

    /*
     * §5 顺序：command (0x02) → payload 长度 (0x04) → payload 取值 (0x01)。
     * 先判命令字是否协议已知，再判该命令的载荷长度，最后才看取值。
     */
    if (!lumen_command_is_known(frame->command)) {
        return; /* 退役 / 保留 / 设备→小程序命令字 → 0x02 */
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
         * 这里**不能 return**——必须走到统一收尾，否则 SetLedCount 不会置
         * cancels_selftest（§9.6 要求灯珠数量变更同样取消自检）。
         */
        dispatch_set_led_count(frame, current, outcome);
        break;

    case LUMEN_CMD_SET_STRIP_POWER:
        dispatch_set_strip_power(frame, current, outcome);
        break;

    case LUMEN_CMD_LAYOUT_WRITE:
        dispatch_layout_write(frame, current, outcome);
        break;

    case LUMEN_CMD_LAYOUT_PART:
        dispatch_layout_part(frame, current, layout, outcome);
        break;

    case LUMEN_CMD_LAYOUT_SEG:
        dispatch_layout_seg(frame, current, layout, outcome);
        break;

    case LUMEN_CMD_LAYOUT_COMMIT:
        dispatch_layout_commit(outcome);
        break;

    case LUMEN_CMD_QUERY_LAYOUT:
        dispatch_query_layout(frame, current, outcome);
        break;

    case LUMEN_CMD_SCENE_PART:
        dispatch_scene_part(frame, current, outcome);
        break;

    case LUMEN_CMD_SCENE_STEP:
        dispatch_scene_step(frame, current, outcome);
        break;

    case LUMEN_CMD_SCENE_NAME:
        dispatch_scene_name(frame, outcome);
        break;

    case LUMEN_CMD_ACTIVATE_SCENE:
        dispatch_scene_single_id(frame, LUMEN_CMD_ACTIVATE_SCENE, outcome);
        break;

    case LUMEN_CMD_QUERY_SCENE:
        dispatch_scene_single_id(frame, LUMEN_CMD_QUERY_SCENE, outcome);
        break;

    case LUMEN_CMD_QUERY_STATE:
        /* §9.1：回 ACK 0x00，随后由调用方补一条 StateReport。
         * 查询不取消自检，也不改共享状态。 */
        outcome->result_code = LUMEN_RESULT_OK;
        outcome->state_report = true;
        break;

    case LUMEN_CMD_QUERY_STRIP_CONFIG:
        /* 无载荷查询：ACK 之后一条 StripConfigReport 0x87（§7.4）。 */
        outcome->result_code = LUMEN_RESULT_OK;
        outcome->strip_config_query = true;
        break;

    case LUMEN_CMD_QUERY_DEVICE_INFO:
        /* 无载荷查询：ACK 之后一条 DeviceInfoReport 0x88（§7.4）。 */
        outcome->result_code = LUMEN_RESULT_OK;
        outcome->device_info_query = true;
        break;

    case LUMEN_CMD_SELF_TEST:
        /* §9.6 第 1 条：立即回 ACK 0x00；序列由调用方启动。
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
     * 统一收尾（§9.6）：只要命令属于「改变状态」的类别且已被接受，就要求
     * 调用方结束自检——即使 state_changed 为 false（值没变）。
     * 非法命令不取消自检，因为新命令并未生效。
     */
    outcome->cancels_selftest =
        outcome->result_code == LUMEN_RESULT_OK && lumen_command_changes_state(frame->command);
}
