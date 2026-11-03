#pragma once

#include <stdbool.h>
#include <stddef.h>
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

/* 播放状态（State 字节 12，docs/protocol-v4.md §7）。 */
typedef enum {
    LUMEN_PLAYBACK_STOPPED = 0,
    LUMEN_PLAYBACK_PLAYING = 1,
    LUMEN_PLAYBACK_PAUSED = 2,
} lumen_playback_state_t;

/* 一个阶段：固定时长 + 淡入淡出时长 + 全部灯带的段配置（段用 active 位标记是否使用）。 */
typedef struct {
    uint16_t duration_ms; /* 1-65535；0 = 该阶段还没有时长（commit 时拒绝） */
    /*
     * fade_ms（v3 新增，docs/protocol-v4.md §9.6）：**格式预留，当前恒为 0**。
     * 非 0 值照常接受并持久化，但播放行为仍是硬切——过渡期要同时渲染两套阶段帧，
     * RMT 负载翻倍，与已实测的 BLE 抢 RMT ISR 问题叠加（见 docs/spec-v3.md 取舍）。
     * caps.bit1 保持 0，App 据此不展示过渡选项。
     */
    uint16_t fade_ms;
    lumen_segment_t segments[LUMEN_MAX_STRIPS][LUMEN_MAX_SEGMENTS];
} lumen_script_stage_t;

/* 一套已提交（或正在暂存）的剧本。
 *
 * RAM（v4 记录）：层从 8 涨到 9 字节、段从 24 涨到 28 字节后，
 *   sizeof(lumen_script_stage_t) = 8 灯带 × 8 段 × 28 + 4 ≈ 1796 字节
 *   sizeof(lumen_script_t)       = 8 阶段 × 1796 + 3 ≈ 14.4 KB
 *   sizeof(lumen_script_store_t) = 5 套（4 committed + 1 staging）× 14.4 KB
 *                                ≈ 70 KB（v3 约 61.5 KB、v2 约 41 KB）
 * 其中约 56 KB 是静态区（led_engine 的 s_scripts），另有 8 灯带 × 8 段 × 28
 * = 1792 字节的阶段渲染快照。C3 的 ~400KB SRAM 要与 NimBLE 共用；v4 净增约
 * 8.4 KB。刷机后配置回默认值、RAM 增量已在上板时复核（见 docs/protocol-v4.md §10）。
 */
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

/*
 * ScriptStage：写阶段时长与 fade。stage_index 必须 < 本次下发的 stage_count，时长非 0。
 * fade_ms 接受任意值（含非 0）但只存储，播放行为仍是硬切（见结构体注释）。
 */
bool lumen_script_stage(lumen_script_store_t *store, uint8_t script_id, uint8_t stage_index,
                        uint16_t duration_ms, uint16_t fade_ms);

/*
 * ScriptSegment：写某阶段某条灯带的一个段槽位。
 * 结构校验（id / 下标 / type / 区间基本形状）在这里；**区间与重叠的权威校验
 * 在 commit**（docs/protocol-v4.md §10.4：失败回滚发生在 ScriptCommit）。
 * frames_written 非 NULL 时写回累计接受帧数（0x86 进度）。
 */
bool lumen_script_segment(lumen_script_store_t *store, uint8_t script_id, uint8_t stage_index,
                          uint8_t strip_id, uint8_t seg_id, const lumen_segment_t *segment,
                          uint16_t *frames_written);

/* ScriptCommit 的结果（docs/protocol-v4.md §10.4「能提交的一定能持久化」）。 */
typedef enum {
    LUMEN_SCRIPT_COMMIT_OK = 0,
    LUMEN_SCRIPT_COMMIT_INVALID = 1,   /* 整份校验不过 → InvalidParam (0x01) */
    LUMEN_SCRIPT_COMMIT_TOO_LARGE = 2, /* 编码后超持久化上限 → ScriptTooLarge (0x0A) */
} lumen_script_commit_result_t;

/*
 * ScriptCommit：对整份暂存做校验，通过才原子替换已提交剧本。
 *
 * 校验：stage_count ∈ 1..8、strip_count ∈ 1..8、每个阶段时长非 0、
 * 每个活动段的 type 已知且已实现、区间落在该灯带灯珠数内、同灯带内不重叠、
 * flags 保留位与周期下限（与 SetSegment 同一套规则）。
 *
 * 校验通过后**再编码一遍**到调用方给的暂存缓冲，检查持久化尺寸
 * （protocol-v4.md §10.4 的不变式：能 commit 的一定能持久化）。超限回
 * `LUMEN_SCRIPT_COMMIT_TOO_LARGE`，**RAM 里不会出现「已提交但存不下」的剧本**，
 * NVS 也不会收到任何写入。
 *
 * blob_out 可为 NULL（纯校验，不做尺寸检查），仅用于不需要持久化的纯逻辑测试。
 *
 * 失败时暂存区被丢弃，已提交剧本原样保留。
 */
lumen_script_commit_result_t lumen_script_commit(lumen_script_store_t *store, uint8_t script_id,
                                                 const uint16_t strip_counts[LUMEN_MAX_STRIPS],
                                                 uint8_t *blob_out, size_t blob_cap,
                                                 size_t *blob_len);

/* ScriptAbort：丢弃该 script_id 的暂存。已提交剧本不受影响。 */
void lumen_script_abort(lumen_script_store_t *store, uint8_t script_id);

/*
 * ClearScript 0x1E（#73）：清空一个已提交剧本（阶段数归零、所有段置空）。
 *
 * **未提交即成功**：对一个本来就没内容的 id 调用也返回 true，不报错
 * （命令是绝对值语义，与 ClearSegment 一致）。
 *
 * 若该 id 正好在暂存区（staging_active && staging_script_id == id），暂存也
 * 一并丢弃——否则用户「清空 → Abort」会看到一个不可预期的中间态。
 *
 * id 越界（>= LUMEN_MAX_SCRIPTS）或 store 为 NULL 返回 false，内容不变。
 * NVS 失败不在这里处理（调用方在落盘前做容量预检，见 script_blob.h）。
 */
bool lumen_script_store_clear(lumen_script_store_t *store, uint8_t script_id);

/*
 * 「清空了 cleared_script_id 之后，是否必须退回无激活剧本」——纯判定。
 *
 * 抽出来是为了让 host 能测这个决策：`active == cleared` 才需要停播并清空
 * 激活 id；没有激活剧本（LUMEN_NO_SCRIPT）或 id 越界时都不命中。
 * 越界的 cleared id 永远不算命中，避免把非法输入当成「正好删掉了正在播的那套」。
 */
bool lumen_script_should_deactivate(uint8_t active_script_id, uint8_t cleared_script_id);

/*
 * SetLedCount 之后的剧本裁剪（#72 漏项）：灯珠数变小后，任何 `end >= new_count`
 * 的活动段都必须失效——否则它会被写进 NVS，下次上电 `script_blob_decode`
 * 整份拒收，`led_engine` 回落到 `lumen_script_store_init`，**四套方案全部
 * 静默丢失**。
 *
 * 语义严格对齐 `lumen_segment_store_prune`：只清段槽位（memset 成 0，active
 * 归 false），**不自动缩短区间**；只看 `strip_id` 这一条灯带，其余灯带与
 * 其它槽位原样保留。
 *
 * 覆盖全部已提交槽位 + 暂存区（staging_active 时）。返回被丢弃的段数
 * （所有阶段相加）。
 *
 * strip_id 越界（>= LUMEN_MAX_STRIPS）或 store 为 NULL 返回 0，内容不变。
 */
uint16_t lumen_script_store_prune_strip(lumen_script_store_t *store, uint8_t strip_id,
                                        uint16_t new_count);

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

/*
 * 外部原因造成的「这一帧不算时间」（自检覆盖期间，v2-effects-engine §7.1）。
 *
 * 推进 last_tick_ms 但不累加 elapsed：下一帧的 delta 只覆盖一帧的正常间隔，
 * 自检的整整 2 秒不会被补进播放头。与 pause 的区别是**不改状态**——
 * UI 上仍是「播放中」，只是时间轴原地不动。
 */
void lumen_script_playback_hold(lumen_script_playback_t *playback, uint32_t now_ms);

/* 是否在播放或暂停（帧循环判据；暂停态也要保持响应）。 */
bool lumen_script_playback_active(const lumen_script_playback_t *playback);

/* 当前阶段时长；剧本/阶段非法返回 0。 */
uint16_t lumen_script_stage_duration(const lumen_script_t *script, uint8_t stage_index);
