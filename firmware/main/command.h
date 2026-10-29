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
 * #8 实现 SetPower 0x01；#9 实现 SetBrightness 0x02；#10 实现 SetColor 0x03
 * 与 SetAll 0x04；#12 实现 SetLedCount 0x06 的取值校验与「需要重建句柄」
 * 标记（真正的重建在 led_engine 的渲染任务里）。0x05 与 0x07 的语义属于
 * #13，仍回 0x02（UnknownCommand）——这是「明确未实现」路径，不是协议最终行为。
 */

typedef struct {
    uint8_t result_code;   /* uint8_t 而非枚举，便于直接进 ACK 载荷 */
    bool state_changed;    /* false 时 next 与 current 相同，调用方不必 commit */
    /* SetLedCount 专用（§11.3）：合法取值时置 true。数量要等渲染任务重建
     * led_strip 句柄成功后才写入共享状态，ACK 也必须等重建结果。 */
    bool led_count_rebuild;
    uint16_t led_count;    /* 目标灯珠数量；仅在 led_count_rebuild 为 true 时有效 */
    lumen_state_t next;    /* 命令生效后的完整状态（未生效时等于 current） */
} lumen_command_outcome_t;

/*
 * 分发一条已通过信封校验的帧。
 *
 * current / outcome 不能为 NULL；调用方保证 frame 非 NULL。
 * 返回前总是填充 outcome->next（未生效时复制 current）与 led_count_rebuild /
 * led_count，因此调用方可以无条件读取；只有 state_changed 为 true 时才应
 * 写入共享状态，只有 led_count_rebuild 为 true 时才应请求重建句柄。
 *
 * max_brightness 是构建期亮度上限（协议 §11.4）：SetBrightness 与 SetAll
 * 载荷里的 brightness 会被钳位到这个值而不是拒绝。调用方传
 * lumen_led_engine_max_brightness()；host 单测直接传测试值。
 *
 * 错误路径（0x01 / 0x02 / 0x04）一律不修改状态。
 */
void lumen_command_dispatch(const lumen_frame_t *frame, const lumen_state_t *current,
                            uint8_t max_brightness, lumen_command_outcome_t *outcome);

/* 协议 §6 定义的已知命令字（0x01-0x07）。保留字与设备→小程序方向不算。 */
bool lumen_command_is_known(uint8_t command);

/* 已知命令的载荷长度（§6 命令表）。未知命令返回 0，调用方先判断 known。 */
uint8_t lumen_command_payload_len(uint8_t command);
