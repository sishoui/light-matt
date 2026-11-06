#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "effects.h"
#include "layout_store.h"

/*
 * v5 场景存储：部位 → 时间轴（纯模块，无 ESP-IDF 头，host 可测）。
 *
 * 唯一真相是 docs/protocol-v5.md §6.2（写入语义）、§7.5（循环三值）与
 * §10.4（blob 布局）。
 *
 * 场景回答的是「每个部位的每一步放什么灯效」，**不含灯珠划分**（那是布局）。
 * 三个场景各占一个独立的持久化键（P6），所以一个场景最多
 * 8 链 × 8 部位 × 8 步 × 两层。
 */

/* 契约常量（docs/protocol-v5.md §1.1）。 */
#define LUMEN_MAX_STEPS 8
#define LUMEN_MAX_SCENES 3
#define LUMEN_STEP_MIN_MS 100
#define LUMEN_STEP_MAX_MS 60000

/*
 * 循环三值（§7.5，数值与 v4 相同、宿主从「剧本级」变成「每部位」）：
 *   0 不循环      走完停在最后一帧（T4）
 *   1 全部循环    走完回到第 1 步
 *   2 最后一步循环 前 N-1 步各播一次，之后原地重播末步
 */
typedef enum {
    LUMEN_LOOP_NONE_V5 = 0,
    LUMEN_LOOP_ALL_V5 = 1,
    LUMEN_LOOP_LAST_V5 = 2,
} lumen_loop_v5_t;
#define LUMEN_LOOP_V5_MAX LUMEN_LOOP_LAST_V5

/*
 * 一个步骤：时长 + 两层。
 *
 * 混合方式**不在线上**（§6.2）：layer1 为空 → 覆盖；非空 → 按亮度叠加。
 * 所以这里没有 blend 字段——合成时按「有无叠加层」推出来。
 */
typedef struct {
    uint16_t duration_ms; /* 100-60000 */
    lumen_effect_layer_t layer[LUMEN_MAX_LAYERS];
} lumen_scene_step_t;

/* 一个部位在某场景里的时间轴。 */
typedef struct {
    uint8_t step_count; /* 0-8；0 = 本场景不演（恒黑，S10） */
    uint8_t loop;       /* lumen_loop_v5_t */
    uint8_t on;         /* 0/1：部位开关（属于场景，不属于布局，T9） */
    lumen_scene_step_t step[LUMEN_MAX_STEPS];
} lumen_part_scene_t;

/* 一个场景：名字 + 8 链 × 8 部位的时间轴。 */
typedef struct {
    uint8_t name_len;
    uint8_t name[LUMEN_NAME_BYTES];
    uint8_t part_count[LUMEN_MAX_STRIPS];
    lumen_part_scene_t part[LUMEN_MAX_STRIPS][LUMEN_MAX_PARTS];
} lumen_scene_t;

/* 三个场景常驻（C1）。 */
typedef struct {
    lumen_scene_t scene[LUMEN_MAX_SCENES];
} lumen_scene_set_t;

/*
 * RAM 尺寸（实测，由下面的 _Static_assert 钉住）：
 *   层    9 字节（type + param[7] + level）
 *   步   20 字节（u16 时长 + 2 × 9 层，按 2 字节对齐）
 *   部位 164 字节（3 字节头 + 填充 + 8 × 20）
 *   场景 **10530 字节**（名字 25 + 链数 8 + 填充 + 64 × 164）
 * 三个场景常驻 = 31590 字节。
 *
 * docs/protocol-v5.md §11 原写「lumen_scene_t = 10400 B」是设计期估算，
 * 少算了 3 字节头与对齐；实现时按实测值落地并已改正 §11。
 */
_Static_assert(sizeof(lumen_scene_step_t) == 20, "lumen_scene_step_t must be 20 bytes");
_Static_assert(sizeof(lumen_part_scene_t) == 164, "lumen_part_scene_t must be 164 bytes");
_Static_assert(sizeof(lumen_scene_t) == 10530, "lumen_scene_t must be 10530 bytes");

/* blob：'LMS5' + 版本 + 名字 + 每链部分数据。最坏 10472 字节，硬上限 12288。 */
#define LUMEN_SCENE_BLOB_VERSION 1
#define LUMEN_SCENE_BLOB_MAX 12288

/*
 * 层在 blob 里的变长编码（§10.4）：
 *   空层 1 B（0xFF）
 *   静态 / 熄灭 5 B（type, hue2, sat, level）——param[3..6] 全 0，丢掉
 *   带动画 9 B（type, hue2, sat, period2, p5, flags, level）
 *
 * 变长是为了把最坏形态压到 12 KB 以内：8 链 × 8 部位 × 8 步 × 两层
 * 全带动画时每步 20 字节（2 时长 + 9 + 9），总共 10472。
 */
#define LUMEN_SCENE_LAYER_EMPTY_BYTES 1
#define LUMEN_SCENE_LAYER_STATIC_BYTES 5
#define LUMEN_SCENE_LAYER_ANIM_BYTES 9
/* 单步最坏：2 字节时长 + 两层各 9 字节。 */
#define LUMEN_SCENE_STEP_MAX_BYTES 20
/* 单部位最坏：3 字节头 + 8 步 × 20。 */
#define LUMEN_SCENE_PART_MAX_BYTES (3 + LUMEN_MAX_STEPS * LUMEN_SCENE_STEP_MAX_BYTES)

/* 全清：名字为空串、每个部位 0 步 / 不循环 / 开关全开。 */
void lumen_scene_set_init(lumen_scene_set_t *set);
void lumen_scene_init(lumen_scene_t *scene);

/* 该层的编码长度（1 / 5 / 9）。未知类型按 9 字节算（调用方先校验过）。 */
uint8_t lumen_scene_layer_encoded_size(const lumen_effect_layer_t *layer);

/*
 * ScenePart 0x25 的语义：写一个部位的时间轴头（步数 / 循环 / 开关）。
 *
 * 改 step_count 时**清空**该部位原有步骤（新一次编排从空开始）。
 * 返回 LUMEN_RESULT_OK / INVALID_PARAM。
 */
uint8_t lumen_scene_set_part(lumen_scene_t *scene, uint8_t strip_id, uint8_t part_id,
                             uint8_t step_count, uint8_t loop, uint8_t on,
                             uint8_t strip_count, uint8_t part_count);

/*
 * SceneStep 0x26 的语义：**单步增量**写入（E5：不重传整场景）。
 *
 * 直接写 RAM 表并标脏，2 秒防抖落盘；没有 staging（§6.2）。
 * 步号 ≥ step_count 时 InvalidParam。
 *
 * 校验顺序：scene/strip/part/step 下标 → 时长区间 → 两层形状
 * （layer0 非空、空层的 level 与参数全 0、逐层 level ≤ 100、各类型参数规则，
 * 全部复用 lumen_segment_validate_shape 的同一份规则）。
 */
uint8_t lumen_scene_set_step(lumen_scene_t *scene, uint8_t strip_id, uint8_t part_id,
                             uint8_t step_index, uint16_t duration_ms,
                             const lumen_effect_layer_t layer0,
                             const lumen_effect_layer_t layer1, uint8_t strip_count,
                             uint8_t part_count);

/* SceneName 0x27：写场景名（name_len ≤ 24，不足 24 字节补 0）。 */
uint8_t lumen_scene_set_name(lumen_scene_t *scene, uint8_t name_len, const uint8_t *name);

/*
 * 取某部位某一步（越界返回 NULL）。
 */
const lumen_scene_step_t *lumen_scene_step(const lumen_scene_t *scene, uint8_t strip_id,
                                           uint8_t part_id, uint8_t step_index);

/*
 * 部位在该场景是否真的要出光：step_count > 0 且 on == 1。
 *
 * 开关只灭灯、**不停时钟**（T8/T9）：时钟推进不看这个函数，合成时才门控。
 */
bool lumen_scene_part_plays(const lumen_scene_t *scene, uint8_t strip_id, uint8_t part_id);

/*
 * 部位的总时长（所有步的时长之和）。0 步返回 0。
 * 用 uint32 存：8 步 × 60000ms = 480000，超过 16 位。
 */
uint32_t lumen_scene_part_total_ms(const lumen_part_scene_t *part);

/*
 * 编码 / 解码场景 blob（§10.4）。
 *
 * encode 返回字节数；超过 LUMEN_SCENE_BLOB_MAX 时返回 0（调用方回
 * StorageFailed 并保留 RAM，§10.4 末段）。out_cap 不足同样返回 0。
 *
 * decode 校验长度、magic、版本、名字、每部位步数与每步时长 / 层规则。
 * 任一失败返回 false 且**不写 out**。
 */
size_t lumen_scene_blob_encode(const lumen_scene_t *scene, uint8_t *out, size_t out_cap);
bool lumen_scene_blob_decode(const uint8_t *blob, size_t len, lumen_scene_t *out);

/* 该场景编码后的字节数（不实际写缓冲，用于容量预检与单测）。 */
size_t lumen_scene_blob_size(const lumen_scene_t *scene);
