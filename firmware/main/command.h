#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "layout_store.h"
#include "protocol.h"
#include "scene_store.h"
#include "state.h"

/*
 * 命令层：信封已通过 docs/protocol-v5.md §3.1 的
 * magic → version → length → checksum 校验后，由 ble_link 调用。
 *
 * 本文件是纯 reducer（旧状态 + 命令 → 新状态 + 结果码 + 意图），不依赖 NimBLE、
 * FreeRTOS 或 NVS，因此可以在 host 上直接单测。命令层负责 §5 后半段：
 * command → payload 长度 → payload 取值。
 *
 * v5 的命令面（§6）：
 *   - 整机：SetPower 0x01 / SetBrightness 0x02 / QueryState 0x05 /
 *     SetLedCount 0x06 / SelfTest 0x07
 *   - 灯组：SetStripPower 0x1B / QueryStripConfig 0x1C / QueryDeviceInfo 0x1D
 *   - 布局族 0x20-0x24（灯组 → 部位 → 灯珠段）
 *   - 场景族 0x25-0x29（部位 → 步骤 → 两层）
 *
 * v4 的 0x10-0x1E（段与剧本族）**整族退役**，一律落到 UnknownCommand 0x02。
 */

typedef struct {
    uint8_t result_code;   /* uint8_t 而非枚举，便于直接进 ACK 载荷 */
    bool state_changed;    /* false 时 next 与 current 相同，调用方不必 commit */
    /*
     * 自检控制（§9.6）。调用方必须在写共享状态之前处理这两个标志：
     *  - start_selftest：0x07 已被接受，立即开始（或重启）自检序列；
     *  - cancels_selftest：该命令属于「改变状态」类别且已通过校验，必须
     *    结束自检再应用 next。即使 state_changed 为 false 也要结束——例如
     *    把开关设成当前值，它仍然是「改变状态的命令」（§9.6 末段）。
     * 查询命令与自检命令本身都不置 cancels_selftest。
     */
    bool start_selftest;
    bool cancels_selftest;
    /* QueryState 专用（§7.4）：ACK 之后要补一条 StateReport 0x82。 */
    bool state_report;
    /* SetLedCount 专用（§11.3）：合法取值时置 true。数量要等渲染任务重建
     * led_strip 句柄成功后才写入共享状态，ACK 也必须等重建结果。 */
    bool led_count_rebuild;
    uint16_t led_count;      /* 目标灯珠数量；仅在 led_count_rebuild 为 true 时有效 */
    uint8_t led_count_strip; /* 哪条灯带要改数量 */

    /*
     * SetStripPower 0x1B（§9.5）。命令层已按 §5 的顺序校验
     * （strip 已分配、on ∈ {0,1}），所以 result_code 为 OK 时调用方
     * 可以立即回 ACK，即使掩码还没写入。
     */
    bool strip_power_op;
    uint8_t strip_power_strip;
    bool strip_power_on;

    /*
     * QueryStripConfig 0x1C / QueryDeviceInfo 0x1D（§7.4）。
     * 两条查询都没有载荷、不改状态，回 ACK 之后各补一条固定报告。
     * 数据源（引脚表 / MAC）在 ble_link 侧，所以这里只置意图。
     */
    bool strip_config_query;
    bool device_info_query;

    /*
     * 布局族 0x20-0x25 的意图。命令层只做「单条命令能判定」的校验
     * （下标范围、name_len、seg_count、段区间形状）；「一颗灯珠只属一个
     * 部位」这条跨命令的不变量由引擎在布局表上判（§6.1 第 3 条）。
     */
    bool layout_op;
    uint8_t layout_opcode;    /* 原命令字：0x20 / 0x21 / 0x22 / 0x23 / 0x24 */
    uint8_t layout_strip;
    uint8_t layout_part;
    uint8_t layout_seg;
    uint8_t layout_start;
    uint8_t layout_end;
    uint8_t layout_part_count; /* 0x20 的目标部位数 */
    uint8_t layout_seg_count;  /* 0x21 的目标段数 */
    uint8_t layout_phase;      /* 0x21 的相位模式（0 连续 / 1 各自起点，§9.2） */
    uint8_t layout_name_len;   /* 0x21 的部位名长度 */
    uint8_t layout_name[LUMEN_NAME_BYTES];

    /*
     * 场景族 0x25-0x29 的意图。
     *
     * 0x26 的两层已经在这里完成 §7.1 的形状校验（与布局无关），引擎只负责
     * 「步号 < step_count」这类需要表上下文的判定（§6.2）。
     */
    bool scene_op;
    uint8_t scene_opcode;  /* 原命令字：0x25 / 0x26 / 0x27 / 0x28 / 0x29 */
    uint8_t scene_id;
    uint8_t scene_strip;
    uint8_t scene_part;
    uint8_t scene_step_index;
    uint8_t scene_step_count;
    uint8_t scene_loop;
    uint8_t scene_on;
    uint8_t scene_name_len;
    uint8_t scene_name[LUMEN_NAME_BYTES];
    uint16_t scene_duration_ms;
    /* 两层的 9 字节定宽线格式（§7.1），已由命令层做完形状校验。 */
    uint8_t scene_layer[LUMEN_MAX_LAYERS][9];

    lumen_state_t next;    /* 命令生效后的完整状态（未生效时等于 current） */
} lumen_command_outcome_t;

/*
 * 分发一条已通过信封校验的帧。
 *
 * current / layout 不能为 NULL；layout 是**只读**的布局快照（命令层用它判
 * 「part_id < 该链部位数」这类需要布局上下文的边界）。调用方保证 frame 非 NULL。
 *
 * 返回前总是填充 outcome->next（未生效时复制 current）与全部意图字段，
 * 因此调用方可以无条件读取。
 *
 * 只有 state_changed 为 true 时才应写入共享状态；led_count_rebuild 为 true 时
 * 应请求重建句柄；layout_op / scene_op 为 true 时应把意图交给引擎；
 * cancels_selftest 为 true 时必须在应用之前结束自检。
 */
void lumen_command_dispatch(const lumen_frame_t *frame, const lumen_state_t *current,
                            const lumen_layout_store_t *layout, uint8_t max_brightness,
                            lumen_command_outcome_t *outcome);

/* 协议 §6 定义的已知（已实现）命令字。保留字、退役字与设备→小程序方向不算。 */
bool lumen_command_is_known(uint8_t command);

/*
 * 该命令是否属于「改变状态」的类别（§9.6）：任何会**改变持久化内容**或
 * 输出内容的命令都算——SetPower / SetBrightness / SetLedCount / SetStripPower /
 * 布局族 / 场景族。
 *
 * QueryState / SelfTest / QueryStripConfig / QueryDeviceInfo / QueryLayout /
 * QueryScene 不算；v2 与 v4 退役的命令也不算。
 *
 * 取消规则在 dispatch 的统一收尾里执行，因此任何新增的「改变状态」命令只要
 * 加进本函数就会自动取消自检——不需要再去改 ble_link 或 led_engine。
 */
bool lumen_command_changes_state(uint8_t command);

/* 已知命令的固定载荷长度（docs/protocol-v5.md §6 命令表）。未知命令返回 0。 */
uint8_t lumen_command_payload_len(uint8_t command);

/*
 * 载荷长度是否符合命令要求（§5 的「载荷长度」一步）。
 * v5 全部命令都是固定长度，所以这里就是等值比较。
 */
bool lumen_command_payload_len_ok(const lumen_frame_t *frame);

/*
 * 取某条灯带的灯珠数。走 State 的逐条数组（v5 起它是权威值）；
 * 越界 / 未初始化时按协议上限 LUMEN_MAX_LEDS 处理。
 * 纯函数，host 可直接测。
 */
uint16_t lumen_command_strip_count(const lumen_state_t *current, uint8_t strip_id);
