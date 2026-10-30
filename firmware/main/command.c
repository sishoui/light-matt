#include "command.h"

#include <stddef.h>

bool lumen_command_is_known(uint8_t command)
{
    /*
     * 只包含「已实现」的命令（docs/protocol.md §11）。0x03 / 0x04 在 v2 退役，
     * 0x10-0x1A 由 #25 / #32 逐票加入；两者现在都落到 default → 0x02 未知命令，
     * 小程序能明确看到「该命令需要升级固件」。
     */
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
    case LUMEN_CMD_QUERY_STATE:
    case LUMEN_CMD_SET_LED_COUNT:
    case LUMEN_CMD_SELF_TEST:
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
        return 0;
    case LUMEN_CMD_SET_LED_COUNT:
        /* v2：strip_id + count 小端（docs/protocol.md §6）。 */
        return 3;
    default:
        return 0;
    }
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
    /* 协议 §11.2 第 5 条列出的改变状态命令；QueryState / SelfTest 不在其中。
     * v2 的 0x03 / 0x04 已退役，不再属于这一类别。 */
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
    case LUMEN_CMD_SET_LED_COUNT:
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
 *  - strip_id 目前只接受 0：多灯带（#29）尚未实现，其它值回 0x01。
 *    先校验 strip_id 再校验数量，保证「这条命令到底改哪条灯带」先被确认。
 *  - 越界（0、>64、小端读出的 65535 等）→ 0x01，不请求重建、不改状态。
 *  - 与当前数量相同时由 led_engine 判为「无需重建」，直接回 0x00。
 */
static void dispatch_set_led_count(const lumen_frame_t *frame,
                                   lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    if (strip_id != 0) {
        /* 多灯带 #29 落地；现在设备只有一条灯带，拒绝而不是静默忽略。 */
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
}

void lumen_command_dispatch(const lumen_frame_t *frame, const lumen_state_t *current,
                            uint8_t max_brightness, lumen_command_outcome_t *outcome)
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
    outcome->next = *current;

    /*
     * §10.2 顺序：command (0x02) → payload 长度 (0x04) → payload 取值 (0x01)。
     * 先判命令字是否协议已知，再判该命令的载荷长度，最后才看取值。
     */
    if (!lumen_command_is_known(frame->command)) {
        return; /* 0x08-0xFF（含保留命令、app 写入 0x80）→ 0x02 */
    }

    if (frame->payload_len != lumen_command_payload_len(frame->command)) {
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
        dispatch_set_led_count(frame, outcome);
        break;

    case LUMEN_CMD_QUERY_STATE:
        /* §6.1：回 ACK 0x00，随后由调用方补一条 StateReport。
         * 查询不取消自检（§11.2 第 6 条），也不改共享状态。 */
        outcome->result_code = LUMEN_RESULT_OK;
        outcome->state_report = true;
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
