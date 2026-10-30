#include "command.h"

#include <stddef.h>

bool lumen_command_is_known(uint8_t command)
{
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
    case LUMEN_CMD_SET_COLOR:
    case LUMEN_CMD_SET_ALL:
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
    case LUMEN_CMD_SET_COLOR:
        return 3;
    case LUMEN_CMD_SET_ALL:
        return 5;
    case LUMEN_CMD_QUERY_STATE:
    case LUMEN_CMD_SELF_TEST:
        return 0;
    case LUMEN_CMD_SET_LED_COUNT:
        return 2;
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

/*
 * SetColor 0x03：载荷 3 字节 R, G, B，各 0-255，没有非法取值。
 *
 * 关键语义：
 *  - 颜色是用户空间 RGB，命令层不做 gamma；gamma 只发生在渲染路径
 *    （led_engine → lumen_gamma_apply），见 protocol §7 与 spec §6。
 *  - 只写 r/g/b，绝不动 power 与 brightness：关灯时选颜色也会保存下来，
 *    开灯即生效；调色不会顺带开灯或改亮度。
 *  - 三个字节都与当前值相同时不 commit（ACK 仍为 0x00）。
 */
static void dispatch_set_color(const lumen_frame_t *frame, const lumen_state_t *current,
                               lumen_command_outcome_t *outcome)
{
    uint8_t r = frame->payload[0];
    uint8_t g = frame->payload[1];
    uint8_t b = frame->payload[2];

    outcome->result_code = LUMEN_RESULT_OK;
    if (current->r != r || current->g != g || current->b != b) {
        outcome->next.r = r;
        outcome->next.g = g;
        outcome->next.b = b;
        outcome->state_changed = true;
    }
}

/*
 * SetAll 0x04：载荷 5 字节 power, brightness, R, G, B，按 §11.1 原子生效。
 *
 * 关键语义：
 *  - 原子性：power 不是 0/1 时回 0x01，brightness / RGB 一个都不写。
 *    实现方式就是「先校验，后赋值」——任何字段校验失败都在第一次赋值之前返回。
 *  - brightness 与 SetBrightness 同一条钳位规则（§11.4）：越界不拒绝，钳位后回 0x00。
 *  - 即使 power = 0，载荷里的 brightness / RGB 也会被保存（§7）：关灯保留颜色与亮度。
 *  - RGB 是用户空间颜色，命令层不做 gamma。
 *  - 五个字段（钳位后的 brightness）与当前值全部相同则不 commit。
 */
static void dispatch_set_all(const lumen_frame_t *frame, const lumen_state_t *current,
                             uint8_t max_brightness, lumen_command_outcome_t *outcome)
{
    uint8_t power = frame->payload[0];
    if (power > 1) {
        /* §11.1：power 非法 → 0x01，整帧不生效。 */
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }

    uint8_t brightness = lumen_state_clamp_brightness(frame->payload[1], max_brightness);
    uint8_t r = frame->payload[2];
    uint8_t g = frame->payload[3];
    uint8_t b = frame->payload[4];

    outcome->result_code = LUMEN_RESULT_OK;
    if (current->power != power || current->brightness != brightness || current->r != r ||
        current->g != g || current->b != b) {
        outcome->next.power = power;
        outcome->next.brightness = brightness;
        outcome->next.r = r;
        outcome->next.g = g;
        outcome->next.b = b;
        outcome->state_changed = true;
    }
}

bool lumen_command_changes_state(uint8_t command)
{
    /* 协议 §11.2 第 5 条列出的五类命令；QueryState / SelfTest 不在其中。 */
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
    case LUMEN_CMD_SET_COLOR:
    case LUMEN_CMD_SET_ALL:
    case LUMEN_CMD_SET_LED_COUNT:
        return true;
    default:
        return false;
    }
}

/*
 * SetLedCount 0x06：载荷 2 字节小端，合法 1-64（§6）。
 *
 * 关键语义（§11.3）：
 *  - 这里只校验并标记「需要重建」。数量必须在渲染任务重建 led_strip 成功后
 *    才写入共享状态，ACK 也要等重建结果——所以本 reducer 不改 next、
 *    state_changed 保持 false，由 led_engine 在重建完成时提交 / 回滚。
 *  - 越界（0、>64、小端读出的 65535 等）→ 0x01，不请求重建、不改状态。
 *  - 与当前数量相同时由 led_engine 判为「无需重建」，直接回 0x00。
 */
static void dispatch_set_led_count(const lumen_frame_t *frame,
                                   lumen_command_outcome_t *outcome)
{
    uint16_t count = (uint16_t)(frame->payload[0] | ((uint16_t)frame->payload[1] << 8));
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

    case LUMEN_CMD_SET_COLOR:
        dispatch_set_color(frame, current, outcome);
        break;

    case LUMEN_CMD_SET_ALL:
        dispatch_set_all(frame, current, max_brightness, outcome);
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
