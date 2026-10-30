#include "script_store.h"

#include <stddef.h>
#include <string.h>

/*
 * 剧本存储、暂存区与播放时间轴。
 *
 * 核心约束（docs/v2-effects-engine.md §6 / 21-design.md §6）：
 *  - 下发是多帧的，所以必须先暂存、commit 时整份校验、再原子替换；
 *  - commit 失败**只丢暂存**，已提交的那一套原样保留（回滚语义）；
 *  - 播放头推进用 while 追上过期阶段，避免 BLE 延迟导致卡在旧阶段；
 *  - 暂停不是「停表再重开」，而是把暂停时长累进 pause_offset_ms，
 *    因此 script_time 在暂停期间不前进、恢复后从原位置继续。
 */

/* 段配置的静态形状校验（不做区间/重叠，那些在 commit 做）。 */
static bool segment_shape_ok(const lumen_segment_t *seg)
{
    if (seg == NULL) {
        return false;
    }
    if (!lumen_effect_type_known(seg->type)) {
        return false;
    }
    if (seg->start > seg->end) {
        return false;
    }
    return true;
}

/* 同灯带内活动段两两检查交集（闭区间）。 */
static bool stage_has_overlap(const lumen_script_stage_t *stage, uint8_t strip)
{
    for (uint8_t a = 0; a < LUMEN_MAX_SEGMENTS; ++a) {
        const lumen_segment_t *sa = &stage->segments[strip][a];
        if (!sa->active) {
            continue;
        }
        for (uint8_t b = (uint8_t)(a + 1u); b < LUMEN_MAX_SEGMENTS; ++b) {
            const lumen_segment_t *sb = &stage->segments[strip][b];
            if (!sb->active) {
                continue;
            }
            if (!(sa->end < sb->start || sb->end < sa->start)) {
                return true;
            }
        }
    }
    return false;
}

/*
 * 单个段的 commit 级校验：区间越界 / flags 保留位 / 周期下限。
 *
 * 复用 segment_store 的**单段**规则（不含重叠），这样命令层与剧本层的拒收
 * 规则永远一致，不会各写一份。重叠由 stage_has_overlap 单独判过。
 *
 * 这里刻意**不**构造 1KB 的临时 lumen_segment_store_t：commit 跑在 NimBLE
 * 主机任务的 4KB 栈上，而 lumen_script_store_t 本身（~40KB）在静态区。
 */
static uint8_t validate_stage_segment(uint8_t strip_id, uint8_t strip_count, uint16_t led_count,
                                      const lumen_segment_t *seg)
{
    return lumen_segment_store_validate_single(strip_id, strip_count, (uint8_t)led_count, seg);
}

void lumen_script_store_init(lumen_script_store_t *store)
{
    if (store == NULL) {
        return;
    }
    memset(store, 0, sizeof(*store));
}

bool lumen_script_begin(lumen_script_store_t *store, uint8_t script_id, uint8_t stage_count,
                        uint8_t strip_count)
{
    if (store == NULL || script_id >= LUMEN_MAX_SCRIPTS) {
        return false;
    }
    if (stage_count < 1 || stage_count > LUMEN_MAX_STAGES) {
        return false;
    }
    if (strip_count < 1 || strip_count > LUMEN_MAX_STRIPS) {
        return false;
    }
    /*
     * 重新 Begin 同一个 id 等价于「重来一次」：直接清空暂存，不需要先 Abort
     * （21-design §6）。不同 id 的 Begin 也覆盖暂存——同一时刻只能有一套在写，
     * 这是协议「显式寻址、无隐式上下文」的代价，写进文档。
     */
    memset(&store->staging, 0, sizeof(store->staging));
    store->staging.stage_count = stage_count;
    store->staging.strip_count = strip_count;
    store->staging_active = true;
    store->staging_script_id = script_id;
    store->frames_written = 0;
    return true;
}

bool lumen_script_stage(lumen_script_store_t *store, uint8_t script_id, uint8_t stage_index,
                        uint16_t duration_ms)
{
    if (store == NULL || !store->staging_active || script_id != store->staging_script_id) {
        return false;
    }
    if (stage_index >= store->staging.stage_count) {
        return false;
    }
    /* duration 0 在这里就拒（§11.3 脚本类命令额外校验 duration_ms != 0）。 */
    if (duration_ms == 0) {
        return false;
    }
    store->staging.stages[stage_index].duration_ms = duration_ms;
    return true;
}

bool lumen_script_segment(lumen_script_store_t *store, uint8_t script_id, uint8_t stage_index,
                          uint8_t strip_id, uint8_t seg_id, const lumen_segment_t *segment,
                          uint16_t *frames_written)
{
    if (store == NULL || !store->staging_active || script_id != store->staging_script_id) {
        return false;
    }
    if (stage_index >= store->staging.stage_count) {
        return false;
    }
    if (strip_id >= store->staging.strip_count || strip_id >= LUMEN_MAX_STRIPS) {
        return false;
    }
    if (seg_id >= LUMEN_MAX_SEGMENTS || !segment_shape_ok(segment)) {
        return false;
    }

    lumen_segment_t applied = *segment;
    applied.active = true;
    /*
     * t0_ms 在剧本里无意义（每阶段的相位在切换时由渲染层统一重置），
     * 这里清 0 避免把下发时刻的时间戳带进持久化数据。
     */
    applied.t0_ms = 0;
    store->staging.stages[stage_index].segments[strip_id][seg_id] = applied;
    ++store->frames_written;
    if (frames_written != NULL) {
        *frames_written = store->frames_written;
    }
    return true;
}

bool lumen_script_commit(lumen_script_store_t *store, uint8_t script_id,
                         const uint16_t strip_counts[LUMEN_MAX_STRIPS])
{
    if (store == NULL || script_id >= LUMEN_MAX_SCRIPTS) {
        return false;
    }
    if (!store->staging_active || script_id != store->staging_script_id) {
        return false;
    }

    lumen_script_t *candidate = &store->staging;

    /*
     * 整份校验。任何一条不过都走 fail：只丢暂存，已提交剧本完全不动。
     * 顺序固定，日志上能看出是哪一步拒的（调用方按返回值上报即可）。
     */
    bool ok = true;
    if (candidate->stage_count < 1 || candidate->stage_count > LUMEN_MAX_STAGES) {
        ok = false;
    }
    if (candidate->strip_count < 1 || candidate->strip_count > LUMEN_MAX_STRIPS) {
        ok = false;
    }

    if (ok) {
        for (uint8_t st = 0; st < candidate->stage_count && ok; ++st) {
            const lumen_script_stage_t *stage = &candidate->stages[st];
            /* 缺阶段（时长为 0）→ 拒绝。 */
            if (stage->duration_ms == 0) {
                ok = false;
                break;
            }
            for (uint8_t strip = 0; strip < candidate->strip_count && ok; ++strip) {
                uint16_t led_count = strip_counts != NULL ? strip_counts[strip] : 0;
                if (led_count == 0 || led_count > LUMEN_MAX_LEDS) {
                    ok = false;
                    break;
                }
                if (stage_has_overlap(stage, strip)) {
                    ok = false;
                    break;
                }
                for (uint8_t seg = 0; seg < LUMEN_MAX_SEGMENTS; ++seg) {
                    const lumen_segment_t *candidate_seg = &stage->segments[strip][seg];
                    if (!candidate_seg->active) {
                        continue;
                    }
                    if (validate_stage_segment(strip, candidate->strip_count, led_count,
                                               candidate_seg) != LUMEN_RESULT_OK) {
                        ok = false;
                        break;
                    }
                }
            }
        }
    }

    if (!ok) {
        /* 失败回滚：丢弃暂存，已提交剧本原样保留（验收点）。 */
        memset(&store->staging, 0, sizeof(store->staging));
        store->staging_active = false;
        store->staging_script_id = LUMEN_NO_SCRIPT;
        store->frames_written = 0;
        return false;
    }

    /*
     * 通过：原子替换。先把 committed 标记置上，再整份拷贝——中途没有可观察的
     * 半套状态，因为调用方持锁（引擎侧）且这里不释放任何东西。
     */
    candidate->committed = true;
    store->committed[script_id] = *candidate;
    store->committed[script_id].committed = true;

    memset(&store->staging, 0, sizeof(store->staging));
    store->staging_active = false;
    store->staging_script_id = LUMEN_NO_SCRIPT;
    return true;
}

void lumen_script_abort(lumen_script_store_t *store, uint8_t script_id)
{
    if (store == NULL) {
        return;
    }
    if (store->staging_active && script_id == store->staging_script_id) {
        memset(&store->staging, 0, sizeof(store->staging));
        store->staging_active = false;
        store->staging_script_id = LUMEN_NO_SCRIPT;
        store->frames_written = 0;
    }
}

const lumen_script_t *lumen_script_get(const lumen_script_store_t *store, uint8_t script_id)
{
    if (store == NULL || script_id >= LUMEN_MAX_SCRIPTS) {
        return NULL;
    }
    if (!store->committed[script_id].committed) {
        return NULL;
    }
    return &store->committed[script_id];
}

bool lumen_script_is_committed(const lumen_script_store_t *store, uint8_t script_id)
{
    return lumen_script_get(store, script_id) != NULL;
}

uint8_t lumen_script_stage_count(const lumen_script_store_t *store, uint8_t script_id)
{
    const lumen_script_t *script = lumen_script_get(store, script_id);
    return script != NULL ? script->stage_count : 0;
}

/* ---------------- 播放时间轴 ---------------- */

void lumen_script_playback_init(lumen_script_playback_t *playback)
{
    if (playback == NULL) {
        return;
    }
    memset(playback, 0, sizeof(*playback));
    playback->script_id = LUMEN_NO_SCRIPT;
    playback->state = LUMEN_PLAYBACK_STOPPED;
}

void lumen_script_playback_select(lumen_script_playback_t *playback, uint8_t script_id, bool loop,
                                  uint32_t now_ms)
{
    if (playback == NULL) {
        return;
    }
    playback->script_id = script_id;
    playback->loop = loop;
    playback->stage_index = 0;
    playback->elapsed_ms = 0;
    playback->state = LUMEN_PLAYBACK_STOPPED;
    playback->hold_last = false;
    playback->pause_offset_ms = 0;
    playback->last_tick_ms = now_ms;
}

void lumen_script_playback_stop(lumen_script_playback_t *playback, uint32_t now_ms)
{
    if (playback == NULL) {
        return;
    }
    playback->stage_index = 0;
    playback->elapsed_ms = 0;
    playback->state = LUMEN_PLAYBACK_STOPPED;
    playback->hold_last = false;
    playback->pause_offset_ms = 0;
    playback->last_tick_ms = now_ms;
}

void lumen_script_playback_play(lumen_script_playback_t *playback, uint32_t now_ms)
{
    if (playback == NULL) {
        return;
    }
    if (playback->state == LUMEN_PLAYBACK_PAUSED) {
        /*
         * 暂停后继续：把暂停期间的真实时长记进 pause_offset_ms，
         * script_time = now - offset 因此连续——elapsed 与播放头原样保留，
         * 不会回到阶段开头（#32 验收点）。
         */
        playback->pause_offset_ms += (uint32_t)(now_ms - playback->last_tick_ms);
        playback->last_tick_ms = now_ms;
        playback->state = LUMEN_PLAYBACK_PLAYING;
        return;
    }
    if (playback->state == LUMEN_PLAYBACK_PLAYING) {
        return; /* 幂等：重复 play 不改变任何时间量 */
    }
    /* 停止后（或非循环播完）再 play：从阶段 0 重新开始。 */
    playback->stage_index = 0;
    playback->elapsed_ms = 0;
    playback->hold_last = false;
    playback->pause_offset_ms = 0;
    playback->last_tick_ms = now_ms;
    playback->state = LUMEN_PLAYBACK_PLAYING;
}

void lumen_script_playback_pause(lumen_script_playback_t *playback, uint32_t now_ms)
{
    if (playback == NULL || playback->state != LUMEN_PLAYBACK_PLAYING) {
        return;
    }
    playback->state = LUMEN_PLAYBACK_PAUSED;
    playback->last_tick_ms = now_ms;
}

uint32_t lumen_script_playback_time(const lumen_script_playback_t *playback, uint32_t now_ms)
{
    if (playback == NULL) {
        return 0;
    }
    /*
     * 只有 PLAYING 才让时间前进。暂停 / 停止 / 非循环播完时用 last_tick_ms
     * 冻结时间轴——画面因此保持不变（暂停冻结画面、播完停在最后一阶段）。
     * 恢复时 play() 把暂停时长补进 pause_offset，时间轴连续、不跳变。
     */
    uint32_t base = playback->state == LUMEN_PLAYBACK_PLAYING ? now_ms : playback->last_tick_ms;
    return (uint32_t)(base - playback->pause_offset_ms);
}

uint16_t lumen_script_stage_duration(const lumen_script_t *script, uint8_t stage_index)
{
    if (script == NULL || stage_index >= script->stage_count) {
        return 0;
    }
    return script->stages[stage_index].duration_ms;
}

bool lumen_script_playback_tick(const lumen_script_t *script, lumen_script_playback_t *playback,
                                uint32_t now_ms, uint32_t *script_time_ms)
{
    if (playback == NULL) {
        return false;
    }
    if (script == NULL || playback->script_id == LUMEN_NO_SCRIPT) {
        if (script_time_ms != NULL) {
            *script_time_ms = lumen_script_playback_time(playback, now_ms);
        }
        return false;
    }

    bool stage_changed = false;

    if (playback->state == LUMEN_PLAYBACK_PLAYING) {
        /* 自上帧以来经过的真实时间；回绕安全（无符号减法）。 */
        uint32_t delta = (uint32_t)(now_ms - playback->last_tick_ms);
        playback->last_tick_ms = now_ms;
        playback->elapsed_ms += delta;

        uint8_t guard = 0;
        /*
         * while 而不是 if：渲染任务可能被 BLE 推迟超过一个阶段，一次补齐
         * 所有过期阶段（v2-effects-engine §6.1）。
         */
        while (guard++ < 255u) {
            uint16_t duration = lumen_script_stage_duration(script, playback->stage_index);
            if (duration == 0) {
                /* 剧本损坏（commit 已保证不会）：停在停止态，别死循环。 */
                playback->state = LUMEN_PLAYBACK_STOPPED;
                playback->stage_index = 0;
                playback->elapsed_ms = 0;
                stage_changed = true;
                break;
            }
            if (playback->elapsed_ms < duration) {
                break;
            }
            playback->elapsed_ms -= duration;

            uint8_t next = (uint8_t)(playback->stage_index + 1u);
            if (next >= script->stage_count) {
                if (playback->loop) {
                    next = 0; /* 循环：回到第一阶段 */
                } else {
                    /* 非循环：停在最后一阶段画面，停止态。 */
                    playback->state = LUMEN_PLAYBACK_STOPPED;
                    playback->hold_last = true;
                    playback->elapsed_ms = (uint32_t)duration; /* 停在末尾，不再前进 */
                    playback->stage_index = (uint8_t)(script->stage_count - 1u);
                    stage_changed = true;
                    break;
                }
            }
            playback->stage_index = next;
            stage_changed = true;
        }
    } else {
        /*
         * 停止 / 暂停：**不更新 last_tick_ms**。
         * 暂停时刻就是 last_tick，play() 用 (now - last_tick) 补进 pause_offset；
         * 若这里每帧把 last_tick 推到 now，暂停时长就永远补不进去，恢复时会
         * 一次性跳掉整个暂停区间。
         */
    }

    if (script_time_ms != NULL) {
        *script_time_ms = lumen_script_playback_time(playback, now_ms);
    }
    return stage_changed;
}

void lumen_script_playback_hold(lumen_script_playback_t *playback, uint32_t now_ms)
{
    if (playback == NULL || playback->state != LUMEN_PLAYBACK_PLAYING) {
        return;
    }
    /*
     * 把这段时间同时记进 pause_offset 并推 last_tick_ms：
     *  - elapsed 不动 → 播放头不会被自检的 2 秒推过一整个阶段；
     *  - script_time = now - pause_offset 保持不变 → 自检结束后相位不跳。
     * 与 pause() 的区别是**不改 playback_state**（UI 上仍是「播放中」）。
     */
    uint32_t delta = (uint32_t)(now_ms - playback->last_tick_ms);
    playback->pause_offset_ms += delta;
    playback->last_tick_ms = now_ms;
}

bool lumen_script_playback_active(const lumen_script_playback_t *playback)
{
    if (playback == NULL) {
        return false;
    }
    return playback->script_id != LUMEN_NO_SCRIPT &&
           (playback->state == LUMEN_PLAYBACK_PLAYING ||
            playback->state == LUMEN_PLAYBACK_PAUSED);
}
