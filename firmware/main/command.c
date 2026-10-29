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

void lumen_command_dispatch(const lumen_frame_t *frame, const lumen_state_t *current,
                            lumen_command_outcome_t *outcome)
{
    if (frame == NULL || current == NULL || outcome == NULL) {
        return;
    }

    /* 默认：状态不变、结果码未知，等具体分支覆盖。 */
    outcome->result_code = LUMEN_RESULT_UNKNOWN_COMMAND;
    outcome->state_changed = false;
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
        return;

    case LUMEN_CMD_SET_BRIGHTNESS:
    case LUMEN_CMD_SET_COLOR:
    case LUMEN_CMD_SET_ALL:
    case LUMEN_CMD_QUERY_STATE:
    case LUMEN_CMD_SET_LED_COUNT:
    case LUMEN_CMD_SELF_TEST:
        /* 本票只打通 SetPower；其余命令的语义留给 #9/#10/#12/#13。
         * 明确回「未实现」而不是假装成功，状态保持不变。 */
        outcome->result_code = LUMEN_RESULT_UNKNOWN_COMMAND;
        return;

    default:
        /* lumen_command_is_known 已过滤，走不到这里；防御性回 0x02。 */
        outcome->result_code = LUMEN_RESULT_UNKNOWN_COMMAND;
        return;
    }
}
