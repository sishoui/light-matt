#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "effects.h"
#include "protocol.h"
#include "segment_store.h"

/*
 * 剧本存储 + 下发暂存区 + 播放时间轴（纯模块，无 ESP-IDF 头，host 可测）。
 *
 * 职责（docs/v2-effects-engine.md §6）：
 *  - 最多 MAX_SCRIPTS 套**已提交**剧本，每套 ≤ MAX_STAGES 个阶段；
 *  - 每阶段 = 时长 + MAX_STRIPS × MAX_SEGMENTS 个段配置（段带 active 位）；
 *  - 下发暂存区：ScriptBegin 分配并清空，ScriptStage / ScriptSegment 填充，
 *    ScriptCommit 做**整份校验**后原子替换，ScriptAbort 丢弃；
 *  - 播放头推进：`while (elapsed >= duration)` 追上所有过期阶段，不卡在旧阶段。
 *
 * 不做的事：gamma / 亮度（渲染层）、NVS（state_store）、时间源（调用方传 now_ms）。
 *
 * 回滚语义（#21 §6 / #32 验收点）：commit 失败时**只丢弃暂存区**，
 * 已提交的那一套完全不动。commit 成功才整体覆盖。
 */

/* 播放状态（State 字节 12，docs/protocol.md §7）。 */
typedef enum {
    LUMEN_PLAYBACK_STOPPED = 0,
    LUMEN_PLAYBACK_PLAYING = 1,
    LUMEN_PLAYBACK_PAUSED = 2,
} lumen_playback_state_t;

/* 一个阶段：固定时长 + 全部灯带的段配置（段用 active 位标记是否使用）。 */
typedef struct {
    uint16_t duration_ms; /* 1-65535；0 = 该阶段还没有时长（commit 时拒绝） */
    lumen_segment_t segments[LUMEN_MAX_STRIPS][LUMEN_MAX_SEGMENTS];
} lumen_script_stage_t;

/* 一套已提交（或正在暂存）的剧本。 */
typedef struct {
    bool committed;   /* 已提交才可激活 / 播放 */
    uint8_t stage_count; /* 1-8 */
    uint8_t strip_count; /* 1-8，本剧本覆盖的灯带数 */
    lumen_script_stage_t stages[LUMEN_MAX_STAGES];
} lumen_script_t;

/* 下发暂存区 + 已提交剧本表。同一时刻只允许一套在暂存（带 script_id 标记）。 */
typedef struct {
    lumen_script_t committed[LUMEN_MAX_SCRIPTS];
    lumen_script_t staging;
    bool staging_active;
    uint8_t staging_script_id;
    uint16_t frames_written; /* 本次下发已接受的 ScriptSegment 帧数（0x86 用） */
} lumen_script_store_t;

/* 播放时间轴。时间全部由调用方传入，模块内部不读时钟。 */
typedef struct {
    uint8_t script_id;    /* LUMEN_NO_SCRIPT = 没有激活剧本 */
    uint8_t stage_index;  /* 当前阶段（播放头） */
    uint8_t state;        /* lumen_playback_state_t */
    bool loop;            /* 循环开关 */
    bool hold_last;       /* 非循环播完：停在最后阶段画面 */
    uint32_t elapsed_ms;  /* 当前阶段内已播放时长（不含暂停时间） */
    uint32_t last_tick_ms;/* 上一次推进/冻结的时刻（真实时间） */
    uint32_t pause_offset_ms; /* 累计暂停时长；script_time = now - offset */
} lumen_script_playback_t;

void lumen_script_store_init(lumen_script_store_t *store);

/*
 * ScriptBegin：在暂存区分配/清空该 script_id。
 * 参数非法（id 越界、stage_count / strip_count 越界）返回 false，暂存区不变。
 * 重新 Begin 同一个 id 等价于「重来一次」，不需要先 Abort。
 */
bool lumen_script_begin(lumen_script_store_t *store, uint8_t script_id, uint8_t stage_count,
                        uint8_t strip_count);

/* ScriptStage：写阶段时长。stage_index 必须 < 本次下发的 stage_count，时长非 0。 */
bool lumen_script_stage(lumen_script_store_t *store, uint8_t script_id, uint8_t stage_index,
                        uint16_t duration_ms);

/*
 * ScriptSegment：写某阶段某条灯带的一个段槽位。
 * 结构校验（id / 下标 / type / 区间基本形状）在这里；**区间与重叠的权威校验
 * 在 commit**（docs/protocol.md §10.4：失败回滚发生在 ScriptCommit）。
 * frames_written 非 NULL 时写回累计接受帧数（0x86 进度）。
 */
bool lumen_script_segment(lumen_script_store_t *store, uint8_t script_id, uint8_t stage_index,
                          uint8_t strip_id, uint8_t seg_id, const lumen_segment_t *segment,
                          uint16_t *frames_written);

/*
 * ScriptCommit：对整份暂存做校验，通过才原子替换已提交剧本。
 *
 * 校验：stage_count ∈ 1..8、strip_count ∈ 1..8、每个阶段时长非 0、
 * 每个活动段的 type 已知且已实现、区间落在该灯带灯珠数内、同灯带内不重叠、
 * flags 保留位与周期下限（与 SetSegment 同一套规则）。
 *
 * strip_counts 长度须为 LUMEN_MAX_STRIPS（每条灯带自己的灯珠数）。
 * **失败：丢弃暂存区，已提交剧本原样保留，返回 false。**
 */
bool lumen_script_commit(lumen_script_store_t *store, uint8_t script_id,
                         const uint16_t strip_counts[LUMEN_MAX_STRIPS]);

/* ScriptAbort：丢弃该 script_id 的暂存。已提交剧本不受影响。 */
void lumen_script_abort(lumen_script_store_t *store, uint8_t script_id);

/* 取已提交剧本；不存在返回 NULL。 */
const lumen_script_t *lumen_script_get(const lumen_script_store_t *store, uint8_t script_id);

/* 是否有已提交剧本。 */
bool lumen_script_is_committed(const lumen_script_store_t *store, uint8_t script_id);

/* 已提交剧本的阶段数；不存在返回 0。 */
uint8_t lumen_script_stage_count(const lumen_script_store_t *store, uint8_t script_id);

/* ---------------- 播放时间轴 ---------------- */

void lumen_script_playback_init(lumen_script_playback_t *playback);

/* 激活：选剧本、写 loop，播放头回到 0、停止态（不自动播放）。 */
void lumen_script_playback_select(lumen_script_playback_t *playback, uint8_t script_id, bool loop,
                                  uint32_t now_ms);

/* stop：播放头回 0，停止态，画面交回静态配置。 */
void lumen_script_playback_stop(lumen_script_playback_t *playback, uint32_t now_ms);

/*
 * play：从**当前播放头**继续。
 *  - 暂停后继续：只把状态改回 PLAYING，elapsed 与播放头原样保留；
 *    暂停期间的真实时长记进 pause_offset_ms，script_time 因此不跳变。
 *  - 停止后 / 非循环播完后：从阶段 0 重新开始。
 */
void lumen_script_playback_play(lumen_script_playback_t *playback, uint32_t now_ms);

/* pause：冻结播放头。下一个 tick 会把暂停时长累进 pause_offset_ms。 */
void lumen_script_playback_pause(lumen_script_playback_t *playback, uint32_t now_ms);

/*
 * 推进播放头（渲染任务每帧调用一次）。
 *
 * PLAYING 时用 `while (elapsed >= duration)` 追上所有过期阶段：
 * BLE 可能把渲染任务推迟超过一个阶段，一次补齐而不是卡在旧阶段。
 * 非循环走完最后阶段 → STOPPED + hold_last（停在最后一阶段画面）。
 *
 * 返回 true 表示阶段变了（调用方据此重置各段 t0_ms，即「阶段切换重置相位」）。
 * script_time_ms 非 NULL 时写回剧本时间轴（= now - 累计暂停时长），
 * 渲染层用它作为段相位基准：暂停时该值不变，画面因此冻结。
 */
bool lumen_script_playback_tick(const lumen_script_t *script,
                                lumen_script_playback_t *playback, uint32_t now_ms,
                                uint32_t *script_time_ms);

/* 当前的剧本时间轴（now - pause_offset）。暂停时保持常数。 */
uint32_t lumen_script_playback_time(const lumen_script_playback_t *playback, uint32_t now_ms);

/* 是否在播放或暂停（帧循环判据；暂停态也要保持响应）。 */
bool lumen_script_playback_active(const lumen_script_playback_t *playback);

/* 当前阶段时长；剧本/阶段非法返回 0。 */
uint16_t lumen_script_stage_duration(const lumen_script_t *script, uint8_t stage_index);
