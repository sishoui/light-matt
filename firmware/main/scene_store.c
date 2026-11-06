#include "scene_store.h"

#include <string.h>

#include "effects.h"
#include "protocol.h"

static const uint8_t s_scene_magic[4] = {'L', 'M', 'S', '5'};

#define BLOB_OFF_VERSION 4
#define BLOB_OFF_NAME_LEN 5
#define BLOB_OFF_NAME 6
#define BLOB_OFF_RESERVED 30
#define BLOB_OFF_PARTS 32

/*
 * 每链 1 字节 part_count；随后每链每部位变长：
 *   step_count(1) | loop(1) | on(1) | steps[step_count]
 *   步：duration_ms(2 小端) | layer0 | layer1
 */
#define SCENE_HEADER_BYTES BLOB_OFF_PARTS

void lumen_scene_init(lumen_scene_t *scene)
{
    if (scene == NULL) {
        return;
    }
    memset(scene, 0, sizeof(*scene));
}

void lumen_scene_set_init(lumen_scene_set_t *set)
{
    if (set == NULL) {
        return;
    }
    memset(set, 0, sizeof(*set));
}

uint8_t lumen_scene_layer_encoded_size(const lumen_effect_layer_t *layer)
{
    if (layer == NULL) {
        return LUMEN_SCENE_LAYER_EMPTY_BYTES;
    }
    if (layer->type == LUMEN_LAYER_EMPTY) {
        return LUMEN_SCENE_LAYER_EMPTY_BYTES;
    }
    /*
     * 静态与熄灭的 param[3..6] 必须全 0（段校验第 7 步已保证），所以可以丢掉，
     * 只留 hue2 + sat + level 四个参数位 → 5 字节。
     */
    if (layer->type == LUMEN_EFFECT_STATIC || layer->type == LUMEN_EFFECT_OFF) {
        return LUMEN_SCENE_LAYER_STATIC_BYTES;
    }
    return LUMEN_SCENE_LAYER_ANIM_BYTES;
}

/* ---------------- 写入 ---------------- */

uint8_t lumen_scene_set_part(lumen_scene_t *scene, uint8_t strip_id, uint8_t part_id,
                             uint8_t step_count, uint8_t loop, uint8_t on, uint8_t strip_count,
                             uint8_t part_count)
{
    if (scene == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (strip_id >= LUMEN_MAX_STRIPS || strip_id >= strip_count || strip_count > LUMEN_MAX_STRIPS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (part_id >= LUMEN_MAX_PARTS || part_id >= part_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (step_count > LUMEN_MAX_STEPS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (loop > LUMEN_LOOP_V5_MAX || on > 1) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    /* 时间轴头的链数取「本场景记录过的 part_count」；见 §6.2 末段。 */
    if (strip_id >= LUMEN_MAX_STRIPS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    lumen_part_scene_t *part = &scene->part[strip_id][part_id];
    /*
     * 只有**步数真的变了**才清空步骤。
     *
     * 这条很重要：`ScenePart` 同时携带「步数 / 循环 / 开关」，而界面上的部位
     * 开关与循环档位都用同一条命令下发（§6.2 只有一个时间轴头命令）。如果每次
     * 都清空，用户点一下部位开关就会把整个时间轴抹掉——直接违反 T9「父开关关掉
     * 再打开时原来的编排仍然在」与用户故事 29。
     */
    bool steps_change = part->step_count != step_count;
    part->step_count = step_count;
    part->loop = loop;
    part->on = on;
    if (steps_change) {
        memset(part->step, 0, sizeof(part->step));
    }
    return LUMEN_RESULT_OK;
}

uint8_t lumen_scene_set_step(lumen_scene_t *scene, uint8_t strip_id, uint8_t part_id,
                             uint8_t step_index, uint16_t duration_ms,
                             const lumen_effect_layer_t layer0,
                             const lumen_effect_layer_t layer1, uint8_t strip_count,
                             uint8_t part_count)
{
    if (scene == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (strip_id >= LUMEN_MAX_STRIPS || strip_id >= strip_count || strip_count > LUMEN_MAX_STRIPS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (part_id >= LUMEN_MAX_PARTS || part_id >= part_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    lumen_part_scene_t *part = &scene->part[strip_id][part_id];
    if (step_index >= LUMEN_MAX_STEPS || step_index >= part->step_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (duration_ms < LUMEN_STEP_MIN_MS || duration_ms > LUMEN_STEP_MAX_MS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    /*
     * 两层形状校验复用段存储的同一份规则（§7.1）：模型一致——一步的两层
     * 与 v4 一个段的两层是同一套编码与约束，只是宿主从「段」换成了「步」。
     */
    lumen_segment_t probe;
    memset(&probe, 0, sizeof(probe));
    probe.active = true;
    probe.layer[0] = layer0;
    probe.layer[1] = layer1;
    /*
     * v5 的混合方式不在线上：layer1 为空 → 覆盖（blend 0），非空 → 按亮度叠加。
     * 这里把 blend 规范化成校验期望的值，让 validate_shape 的第 5 步不误判。
     */
    probe.blend = lumen_layer_is_empty(&layer1) ? (uint8_t)LUMEN_BLEND_OVER
                                                : (uint8_t)LUMEN_BLEND_LUMA;
    if (lumen_segment_validate_shape(&probe) != LUMEN_RESULT_OK) {
        return LUMEN_RESULT_INVALID_PARAM;
    }

    part->step[step_index].duration_ms = duration_ms;
    part->step[step_index].layer[0] = layer0;
    part->step[step_index].layer[1] = layer1;
    return LUMEN_RESULT_OK;
}

uint8_t lumen_scene_set_name(lumen_scene_t *scene, uint8_t name_len, const uint8_t *name)
{
    if (scene == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (name_len > LUMEN_NAME_BYTES) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (name_len > 0 && name == NULL) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    memset(scene->name, 0, sizeof(scene->name));
    if (name_len > 0) {
        memcpy(scene->name, name, name_len);
    }
    scene->name_len = name_len;
    return LUMEN_RESULT_OK;
}

/* ---------------- 查询 ---------------- */

const lumen_scene_step_t *lumen_scene_step(const lumen_scene_t *scene, uint8_t strip_id,
                                           uint8_t part_id, uint8_t step_index)
{
    if (scene == NULL || strip_id >= LUMEN_MAX_STRIPS || part_id >= LUMEN_MAX_PARTS ||
        step_index >= LUMEN_MAX_STEPS) {
        return NULL;
    }
    const lumen_part_scene_t *part = &scene->part[strip_id][part_id];
    if (step_index >= part->step_count) {
        return NULL;
    }
    return &part->step[step_index];
}

bool lumen_scene_part_plays(const lumen_scene_t *scene, uint8_t strip_id, uint8_t part_id)
{
    if (scene == NULL || strip_id >= LUMEN_MAX_STRIPS || part_id >= LUMEN_MAX_PARTS) {
        return false;
    }
    const lumen_part_scene_t *part = &scene->part[strip_id][part_id];
    return part->step_count > 0 && part->on != 0;
}

uint32_t lumen_scene_part_total_ms(const lumen_part_scene_t *part)
{
    if (part == NULL) {
        return 0;
    }
    uint32_t total = 0;
    for (uint8_t i = 0; i < part->step_count && i < LUMEN_MAX_STEPS; ++i) {
        total += part->step[i].duration_ms;
    }
    return total;
}

/* ---------------- blob ---------------- */

/* 一层的变长编码。返回写入字节数。 */
static size_t layer_encode(const lumen_effect_layer_t *layer, uint8_t *out)
{
    size_t n = lumen_scene_layer_encoded_size(layer);
    if (n == LUMEN_SCENE_LAYER_EMPTY_BYTES) {
        out[0] = LUMEN_LAYER_EMPTY;
        return 1;
    }
    out[0] = layer->type;
    out[1] = layer->param[0]; /* hue 低 */
    out[2] = layer->param[1]; /* hue 高 */
    out[3] = layer->param[2]; /* sat */
    if (n == LUMEN_SCENE_LAYER_STATIC_BYTES) {
        out[4] = layer->level;
        return LUMEN_SCENE_LAYER_STATIC_BYTES;
    }
    out[4] = layer->param[3]; /* period 低 */
    out[5] = layer->param[4]; /* period 高 */
    out[6] = layer->param[5]; /* p5 */
    out[7] = layer->param[6]; /* flags */
    out[8] = layer->level;
    return LUMEN_SCENE_LAYER_ANIM_BYTES;
}

/* 一层的变长解码。返回消耗的字节数；0 表示类型非法。 */
static size_t layer_decode(const uint8_t *in, size_t avail, lumen_effect_layer_t *out)
{
    if (avail < 1) {
        return 0;
    }
    memset(out, 0, sizeof(*out));
    if (in[0] == LUMEN_LAYER_EMPTY) {
        out->type = LUMEN_LAYER_EMPTY;
        return 1;
    }
    if (!lumen_effect_type_known(in[0])) {
        return 0;
    }
    bool is_static = in[0] == LUMEN_EFFECT_STATIC || in[0] == LUMEN_EFFECT_OFF;
    size_t need = is_static ? LUMEN_SCENE_LAYER_STATIC_BYTES : LUMEN_SCENE_LAYER_ANIM_BYTES;
    if (avail < need) {
        return 0;
    }
    out->type = in[0];
    out->param[0] = in[1];
    out->param[1] = in[2];
    out->param[2] = in[3];
    if (is_static) {
        out->level = in[4];
    } else {
        out->param[3] = in[4];
        out->param[4] = in[5];
        out->param[5] = in[6];
        out->param[6] = in[7];
        out->level = in[8];
    }
    return need;
}

size_t lumen_scene_blob_size(const lumen_scene_t *scene)
{
    if (scene == NULL) {
        return 0;
    }
    size_t total = (size_t)SCENE_HEADER_BYTES + LUMEN_MAX_STRIPS;
    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        for (uint8_t part = 0; part < LUMEN_MAX_PARTS; ++part) {
            const lumen_part_scene_t *p = &scene->part[strip][part];
            total += 3; /* step_count / loop / on */
            for (uint8_t s = 0; s < p->step_count && s < LUMEN_MAX_STEPS; ++s) {
                total += 2; /* duration */
                total += lumen_scene_layer_encoded_size(&p->step[s].layer[0]);
                total += lumen_scene_layer_encoded_size(&p->step[s].layer[1]);
            }
        }
    }
    return total;
}

size_t lumen_scene_blob_encode(const lumen_scene_t *scene, uint8_t *out, size_t out_cap)
{
    if (scene == NULL || out == NULL) {
        return 0;
    }
    size_t need = lumen_scene_blob_size(scene);
    if (need == 0 || need > LUMEN_SCENE_BLOB_MAX || need > out_cap) {
        return 0; /* 超过硬上限 = StorageFailed（§10.4），调用方保留 RAM */
    }
    memset(out, 0, need);
    memcpy(&out[0], s_scene_magic, sizeof(s_scene_magic));
    out[BLOB_OFF_VERSION] = LUMEN_SCENE_BLOB_VERSION;
    out[BLOB_OFF_NAME_LEN] = scene->name_len;
    memcpy(&out[BLOB_OFF_NAME], scene->name, LUMEN_NAME_BYTES);
    /* out[BLOB_OFF_RESERVED .. BLOB_OFF_RESERVED+1] 已是 0。 */

    uint8_t *p = &out[SCENE_HEADER_BYTES];
    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        /*
         * 每链的 part_count 取「本场景里该链实际有步骤的部位数」。
         *
         * 布局是权威（它决定哪些部位存在），场景只负责时间轴。为了 blob
         * 自描述且与布局解耦（§6.2：两张表），这里记的是本场景**编排过**的
         * 部位数；解码端按它恢复 step_count 为 0 的部位头。
         */
        uint8_t parts = 0;
        for (uint8_t part = 0; part < LUMEN_MAX_PARTS; ++part) {
            if (scene->part[strip][part].step_count > 0) {
                parts = (uint8_t)(part + 1);
            }
        }
        *p++ = parts;
    }

    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        for (uint8_t part = 0; part < LUMEN_MAX_PARTS; ++part) {
            const lumen_part_scene_t *ps = &scene->part[strip][part];
            *p++ = ps->step_count;
            *p++ = ps->loop;
            *p++ = ps->on;
            for (uint8_t s = 0; s < ps->step_count && s < LUMEN_MAX_STEPS; ++s) {
                *p++ = (uint8_t)(ps->step[s].duration_ms & 0xFF);
                *p++ = (uint8_t)(ps->step[s].duration_ms >> 8);
                p += layer_encode(&ps->step[s].layer[0], p);
                p += layer_encode(&ps->step[s].layer[1], p);
            }
        }
    }

    size_t written = (size_t)(p - out);
    if (written != need) {
        return 0; /* 自检：算出来的长度必须与实际写出的一致 */
    }
    return written;
}

bool lumen_scene_blob_decode(const uint8_t *blob, size_t len, lumen_scene_t *out)
{
    if (blob == NULL || out == NULL) {
        return false;
    }
    if (len < SCENE_HEADER_BYTES + LUMEN_MAX_STRIPS || len > LUMEN_SCENE_BLOB_MAX) {
        return false;
    }
    if (memcmp(&blob[0], s_scene_magic, sizeof(s_scene_magic)) != 0) {
        return false;
    }
    if (blob[BLOB_OFF_VERSION] != LUMEN_SCENE_BLOB_VERSION) {
        return false;
    }
    uint8_t name_len = blob[BLOB_OFF_NAME_LEN];
    if (name_len > LUMEN_NAME_BYTES) {
        return false;
    }
    for (uint8_t i = name_len; i < LUMEN_NAME_BYTES; ++i) {
        if (blob[BLOB_OFF_NAME + i] != 0) {
            return false;
        }
    }

    /*
     * **必须静态**：lumen_scene_t 是 10530 字节，而本函数经
     * lumen_state_store_load_scene 跑在 app_main 任务的 3584 字节栈上。
     * 放局部变量会在「NVS 里已有场景数据」的那次启动打穿栈保护——真机表现是
     * 刷完固件第一次能起来（无持久化数据、走不到这一段），写入场景后一复位就
     * 反复 panic 重启，连蓝牙广播都起不来。
     *
     * 解码在同一把调用里完成，最后整体拷给 out，所以复用安全。
     */
    static lumen_scene_t decoded;
    memset(&decoded, 0, sizeof(decoded));
    decoded.name_len = name_len;
    memcpy(decoded.name, &blob[BLOB_OFF_NAME], LUMEN_NAME_BYTES);

    const uint8_t *limit = blob + len;
    const uint8_t *p = &blob[SCENE_HEADER_BYTES];
    uint8_t part_count[LUMEN_MAX_STRIPS];
    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        part_count[strip] = *p++;
        if (part_count[strip] > LUMEN_MAX_PARTS) {
            return false;
        }
    }

    for (uint8_t strip = 0; strip < LUMEN_MAX_STRIPS; ++strip) {
        for (uint8_t part = 0; part < LUMEN_MAX_PARTS; ++part) {
            if (p + 3 > limit) {
                return false;
            }
            uint8_t step_count = *p++;
            uint8_t loop = *p++;
            uint8_t on = *p++;
            if (step_count > LUMEN_MAX_STEPS || loop > LUMEN_LOOP_V5_MAX || on > 1) {
                return false;
            }
            /* 未编排过的部位槽位必须是空头，否则是坏 blob。 */
            if (part >= part_count[strip] && (step_count != 0 || loop != 0 || on != 0)) {
                return false;
            }
            lumen_part_scene_t *ps = &decoded.part[strip][part];
            ps->step_count = step_count;
            ps->loop = loop;
            ps->on = on;
            for (uint8_t s = 0; s < step_count; ++s) {
                if (p + 2 > limit) {
                    return false;
                }
                uint16_t duration = (uint16_t)(p[0] | ((uint16_t)p[1] << 8));
                p += 2;
                if (duration < LUMEN_STEP_MIN_MS || duration > LUMEN_STEP_MAX_MS) {
                    return false;
                }
                lumen_effect_layer_t l0;
                size_t n0 = layer_decode(p, (size_t)(limit - p), &l0);
                if (n0 == 0) {
                    return false;
                }
                p += n0;
                lumen_effect_layer_t l1;
                size_t n1 = layer_decode(p, (size_t)(limit - p), &l1);
                if (n1 == 0) {
                    return false;
                }
                p += n1;
                /* 层规则与写入路径同一份（§7.1）。 */
                lumen_segment_t probe;
                memset(&probe, 0, sizeof(probe));
                probe.active = true;
                probe.layer[0] = l0;
                probe.layer[1] = l1;
                probe.blend = lumen_layer_is_empty(&l1) ? (uint8_t)LUMEN_BLEND_OVER
                                                        : (uint8_t)LUMEN_BLEND_LUMA;
                if (lumen_segment_validate_shape(&probe) != LUMEN_RESULT_OK) {
                    return false;
                }
                ps->step[s].duration_ms = duration;
                ps->step[s].layer[0] = l0;
                ps->step[s].layer[1] = l1;
            }
        }
    }
    /* 尾部不能有剩余字节（长度必须与内容一致）。 */
    if (p != limit) {
        return false;
    }

    *out = decoded; /* 全部通过才写：绝不半套加载 */
    return true;
}
