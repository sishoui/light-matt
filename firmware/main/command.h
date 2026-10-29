#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "protocol.h"
#include "state.h"

/*
 * 命令层：信封已通过 docs/protocol.md §10.2 的
 * magic → version → length → checksum 校验后，由 ble_link 调用。
 *
 * 本文件是纯 reducer（旧状态 + 命令 → 新状态 + 结果码），不依赖 NimBLE、
 * FreeRTOS 或 NVS，因此可以在 host 上直接单测。命令层负责 §10.2 后半段：
 * command → payload 长度 → payload 取值。
 *
 * 本票（#8）只实现 SetPower 0x01 的语义。0x02-0x07 是协议已定义的命令，
 * 但语义属于后续票（#9/#10/#12/#13）；它们一律回 0x02（UnknownCommand）
 * ——这是本票允许的「明确未实现」路径，不是协议最终行为。
 */

typedef struct {
    uint8_t result_code;   /* uint8_t 而非枚举，便于直接进 ACK 载荷 */
    bool state_changed;    /* false 时 next 与 current 相同，调用方不必 commit */
    lumen_state_t next;    /* 命令生效后的完整状态（未生效时等于 current） */
} lumen_command_outcome_t;

/*
 * 分发一条已通过信封校验的帧。
 *
 * current / outcome 不能为 NULL；调用方保证 frame 非 NULL。
 * 返回前总是填充 outcome->next（未生效时复制 current），因此调用方可以
 * 无条件读取，但只有 state_changed 为 true 时才应写入共享状态。
 *
 * 错误路径（0x01 / 0x02 / 0x04）一律不修改状态。
 */
void lumen_command_dispatch(const lumen_frame_t *frame, const lumen_state_t *current,
                            lumen_command_outcome_t *outcome);

/* 协议 §6 定义的已知命令字（0x01-0x07）。保留字与设备→小程序方向不算。 */
bool lumen_command_is_known(uint8_t command);

/* 已知命令的载荷长度（§6 命令表）。未知命令返回 0，调用方先判断 known。 */
uint8_t lumen_command_payload_len(uint8_t command);
