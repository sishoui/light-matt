#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "protocol.h"
#include "script_store.h"
#include "segment_store.h"
#include "state.h"

/*
 * 命令层：信封已通过 docs/protocol.md §10.2 的
 * magic → version → length → checksum 校验后，由 ble_link 调用。
 *
 * 本文件是纯 reducer（旧状态 + 命令 → 新状态 + 结果码），不依赖 NimBLE、
 * FreeRTOS 或 NVS，因此可以在 host 上直接单测。命令层负责 §10.2 后半段：
 * command → payload 长度 → payload 取值。
 *
 * #8 实现 SetPower 0x01；#9 实现 SetBrightness 0x02；#12 实现 SetLedCount 0x06
 * 的取值校验与「需要重建句柄」标记（真正的重建在 led_engine 的渲染任务里）；
 * #13 实现 SelfTest 0x07 的命令语义（ACK 0x00 + 启动自检）；QueryState 0x05
 * 置 state_report，由 ble_link 在 ACK 之后补一条 StateReport（§6.1）；
 * #25 实现段配置 0x10 SetSegment / 0x11 ClearSegment / 0x12 QueryStrip。
 *
 * v2（#21）退役了 0x03 SetColor / 0x04 SetAll：命令层不再认识它们，落到
 * UnknownCommand。颜色只通过 0x10 SetSegment 下发。
 */

typedef struct {
    uint8_t result_code;   /* uint8_t 而非枚举，便于直接进 ACK 载荷 */
    bool state_changed;    /* false 时 next 与 current 相同，调用方不必 commit */
    /*
     * 自检控制（协议 §11.2）。调用方必须在写共享状态之前处理这两个标志：
     *  - start_selftest：0x07 已被接受，立即开始（或重启）自检序列；
     *  - cancels_selftest：该命令属于「改变状态」类别且已通过校验，必须
     *    结束自检再应用 next。即使 state_changed 为 false 也要结束——例如
     *    把开关设成当前值，它仍然是「改变状态的命令」，按 §11.2 第 5 条
     *    会取消自检。
     * 查询状态、读 State、自检命令本身都不置 cancels_selftest。
     */
    bool start_selftest;
    bool cancels_selftest;
    /* QueryState 专用（§6.1）：ACK 之后要补一条 StateReport 0x82。
     * 状态同步的主路径是 State 特征值 read，这条只是次要/调试通道。 */
    bool state_report;
    /* SetLedCount 专用（§11.3）：合法取值时置 true。数量要等渲染任务重建
     * led_strip 句柄成功后才写入共享状态，ACK 也必须等重建结果。 */
    bool led_count_rebuild;
    uint16_t led_count;    /* 目标灯珠数量；仅在 led_count_rebuild 为 true 时有效 */
    uint8_t led_count_strip; /* 哪条灯带要改数量（#29 多条独立） */

    /*
     * 段配置（#25）。0x10 / 0x11 置 segment_op：命令层已完成 §11.3 第 4-9 步
     * 的全部校验（区间与重叠用的是传入的段配置快照），调用方据此写/清槽位。
     * 段配置不在 lumen_state_t 里，所以 state_changed 保持 false——摘要字段
     * （seg_count 与 State 字节 2-4 的基准色）由 led_engine 在写入后重算。
     */
    bool segment_op;
    bool segment_clear;    /* true = ClearSegment 0x11，false = SetSegment 0x10 */
    uint8_t segment_strip; /* strip_id */
    uint8_t segment_id;    /* seg_id */
    lumen_segment_t segment; /* SetSegment 的目标段（t0_ms 由引擎填） */

    /* QueryStrip 0x12：ACK 之后要回 seg_count 条 SegmentReport + SegmentListEnd。 */
    bool strip_query;
    uint8_t query_strip_id;

    /*
     * #32 剧本（0x13–0x1A）。命令层只做形状校验；真正的暂存 / 提交 /
     * 激活由 led_engine 在锁内执行（它持剧本表），这里只交出意图。
     *
     * script_op 取值见 lumen_script_op_t；script_stage_index / script_strip /
     * script_seg / script_segment / script_loop 按 op 解释。
     */
    uint8_t script_op;
    uint8_t script_id;
    uint8_t script_action;   /* SetPlayback 的 action：0 stop / 1 play / 2 pause */
    uint8_t script_stage_count;
    uint8_t script_strip_count;
    uint8_t script_stage_index;
    uint16_t script_duration_ms;
    uint8_t script_strip;
    uint8_t script_seg;
    lumen_segment_t script_segment;
    bool script_loop;

    lumen_state_t next;    /* 命令生效后的完整状态（未生效时等于 current） */
} lumen_command_outcome_t;

/* #32 剧本命令的操作意图（outcome->script_op）。 */
typedef enum {
    LUMEN_SCRIPT_OP_NONE = 0,
    LUMEN_SCRIPT_OP_BEGIN,    /* 0x14 ScriptBegin */
    LUMEN_SCRIPT_OP_STAGE,    /* 0x15 ScriptStage */
    LUMEN_SCRIPT_OP_SEGMENT,  /* 0x16 ScriptSegment */
    LUMEN_SCRIPT_OP_COMMIT,   /* 0x17 ScriptCommit */
    LUMEN_SCRIPT_OP_ABORT,    /* 0x18 ScriptAbort */
    LUMEN_SCRIPT_OP_ACTIVATE, /* 0x19 ActivateScript */
    LUMEN_SCRIPT_OP_QUERY,    /* 0x1A QueryScript */
    LUMEN_SCRIPT_OP_PLAYBACK, /* 0x13 SetPlayback */
} lumen_script_op_t;

/*
 * 分发一条已通过信封校验的帧。
 *
 * current / outcome 不能为 NULL；调用方保证 frame 非 NULL。
 * 返回前总是填充 outcome->next（未生效时复制 current）、led_count_rebuild /
 * led_count、段配置操作字段，以及 start_selftest / cancels_selftest，因此
 * 调用方可以无条件读取。
 *
 * segments 是当前段配置的**只读**快照，用于 §11.3 第 5-9 步（strip 范围、
 * 区间、重叠、flags、周期）。传 NULL 表示「没有任何活动段」——host 单测与
 * 「段配置尚未加载」的场景都走这条路，区间校验仍然按灯珠数生效。
 *
 * strip_counts 是「每条灯带的灯珠数」只读数组（#29 多条独立，长度须为
 * LUMEN_MAX_STRIPS）。传 NULL 时退回 current->led_count（单灯带场景，
 * 也就是 #29 之前的全部行为）。**不要**用 current->led_count 校验
 * strip_id != 0 的段：那是 strip 0 的数字，会让真实越界被放行，
 * 或让合法段被误拒。
 *
 * 只有 state_changed 为 true 时才应写入共享状态；led_count_rebuild 为 true 时
 * 应请求重建句柄；segment_op 为 true 时应在 ACK 之前调用 led_engine 写/清段；
 * cancels_selftest 为 true 时必须在应用之前结束自检。
 */
void lumen_command_dispatch(const lumen_frame_t *frame, const lumen_state_t *current,
                            const lumen_segment_store_t *segments,
                            const uint16_t *strip_counts, uint8_t max_brightness,
                            lumen_command_outcome_t *outcome);

/*
 * 取某条灯带的灯珠数（#29）。strip_counts 为 NULL 时退回 current->led_count；
 * 结果钳到 1..LUMEN_MAX_LEDS。纯函数，host 可直接测。
 */
uint16_t lumen_command_strip_count(const lumen_state_t *current, const uint16_t *strip_counts,
                                   uint8_t strip_id);

/* 协议 §6 定义的已知（已实现）命令字。保留字、退役字与设备→小程序方向不算。 */
bool lumen_command_is_known(uint8_t command);

/*
 * 协议 §11.2 第 5 条：该命令是否属于「改变状态」的类别
 * （SetPower / SetBrightness / SetLedCount / SetSegment / ClearSegment）。
 * QueryState、SelfTest、QueryStrip 不算；v2 退役的 0x03 / 0x04 也不算。
 *
 * 取消规则在 dispatch 的统一收尾里执行，因此任何新增的「改变状态」命令只要
 * 加进本函数就会自动取消自检——不需要再去改 ble_link 或 led_engine。
 */
bool lumen_command_changes_state(uint8_t command);

/* 已知命令的固定载荷长度（§6 命令表）。未知命令返回 0。
 * SetSegment 是变长（8 或 12），这里返回 0，用 lumen_command_payload_len_ok 判断。 */
uint8_t lumen_command_payload_len(uint8_t command);

/*
 * 载荷长度是否符合命令要求（§11.3 第 3 步）。
 * 变长命令按「先读 type 再定长」：SetSegment 的 type 未知时长度无法判定，
 * 这里放行，交给第 4 步的 type 校验回 InvalidParam（与 21-design §8 的顺序一致）。
 */
bool lumen_command_payload_len_ok(const lumen_frame_t *frame);
