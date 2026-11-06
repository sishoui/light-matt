#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

/*
 * v5 布局存储：灯组 → 部位 → 灯珠段（纯模块，无 ESP-IDF 头，host 可测）。
 *
 * 唯一真相是 docs/protocol-v5.md §6.1（写入语义）与 §10.3（blob 布局）。
 *
 * 布局回答的是「一颗灯珠归哪个部位」，**不含时间轴**。三个场景共用这一份
 * （S8），所以它的生命周期与场景分开：只在 LayoutCommit 时落盘。
 *
 * 一条链上：
 *   - 最多 LUMEN_MAX_PARTS(8) 个部位；
 *   - 每个部位最多 LUMEN_MAX_PART_SEGS(8) 个**闭区间**灯珠段；
 *   - 一颗灯珠**只能属一个部位**（S3）——同链所有部位的所有段两两互斥；
 *   - 不被任何部位覆盖的灯珠**恒黑**（不是上一帧残留）。
 */

/* 契约常量（docs/protocol-v5.md §1.1）。 */
#define LUMEN_MAX_PARTS 8
#define LUMEN_MAX_PART_SEGS 8
/* 部位名 / 场景名的字节上限（UTF-8，不强制字符边界）。 */
#define LUMEN_NAME_BYTES 24
/* 一颗灯珠不属于任何部位时的哨兵值（lumen_layout_part_of_pixel）。 */
#define LUMEN_PART_NONE 0xFF

/*
 * 相位模式（S6）。
 *
 * 规格把它定为「布局属性」，但 v5.0 的线上**没有任何命令能改它**，§10.3 的
 * 每链记录也只有 `led_count | part_count | reserved(6)` 六个保留字节。
 * 因此本票（#155 walking skeleton）只实现 `连续`，不做每链持久化：
 * 保留字节按契约必须为 0，不能借来存相位。
 *
 * 两个值仍然作为 `lumen_scene_compose` / `lumen_layout_logical_index` 的参数
 * 存在，等到有线上位的票再加持久化——那时把保留字节之一升格、并改 blob 版本。
 */
typedef enum {
    LUMEN_PHASE_CONTINUOUS = 0,
    LUMEN_PHASE_PER_SEGMENT = 1,
} lumen_phase_mode_t;

/*
 * 一个灯珠段：闭区间 [start, end]，两颗都在该链的灯珠数之内。
 *
 * 写入是**分帧**的（LayoutPart 先声明 seg_count，随后逐条 LayoutSeg），所以
 * 声明了但还没写的段必须与「真的写了 0-0」区分开：未写的段两个字节都是
 * LUMEN_SEG_UNWRITTEN(0xFF)，参与校验时被当作「尚未占用」跳过；若
 * LayoutCommit 时仍有未写的段，整份校验失败（声明了却不写就是不完整）。
 * 0xFF 不会与合法段混淆：end 必须 < 100 ≤ 0xFF。
 */
#define LUMEN_SEG_UNWRITTEN 0xFF

typedef struct {
    uint8_t seg_count;
    uint8_t seg[LUMEN_MAX_PART_SEGS][2]; /* [i][0] = start, [i][1] = end */
} lumen_part_segs_t;

/* 一个部位：名字 + 灯珠段。一个部位的多段**完全共享**全部参数（S5）。 */
typedef struct {
    uint8_t name_len;               /* 0-24，单位为字节 */
    uint8_t name[LUMEN_NAME_BYTES]; /* NUL 补齐；解码端只信任 name_len */
    lumen_part_segs_t segs;
} lumen_part_layout_t;

/*
 * 布局存储：8 条链 × 8 个部位。
 *
 * RAM 尺寸 = 8（每链部位数）+ 64 × 42 = **2696 字节**，由下面的
 * _Static_assert 钉住。
 */
typedef struct {
    uint8_t part_count[LUMEN_MAX_STRIPS];
    lumen_part_layout_t part[LUMEN_MAX_STRIPS][LUMEN_MAX_PARTS];
} lumen_layout_store_t;

_Static_assert(sizeof(lumen_part_layout_t) == 42, "lumen_part_layout_t must be 42 bytes");
_Static_assert(sizeof(lumen_layout_store_t) == 2696,
               "lumen_layout_store_t must be 2696 bytes (docs/protocol-v5.md §11)");

/* blob：magic 'LML1' + 版本 + 链数 + 2 保留 + 每链 8 字节 + 64 × 42 字节 = 2760。 */
#define LUMEN_LAYOUT_BLOB_VERSION 1
#define LUMEN_LAYOUT_BLOB_SIZE 2760
/* NVS 写上限（§10.3）。编码后超过它一律 StorageFailed。 */
#define LUMEN_LAYOUT_BLOB_MAX 4096

/* 每链记录：led_count(1) | part_count(1) | reserved(6)。 */
#define LUMEN_LAYOUT_STRIP_RECORD_BYTES 8
#define LUMEN_LAYOUT_STRIP_LED_COUNT_OFFSET 0
#define LUMEN_LAYOUT_STRIP_PART_COUNT_OFFSET 1

/* 全清：所有链 0 个部位、所有名字为空、所有段为空。 */
void lumen_layout_store_init(lumen_layout_store_t *layout);

/*
 * LayoutWrite 0x20 的语义：把该链的部位数设为 part_count 并**清空**该链
 * 所有部位的名字与段。part_count == 0 表示这条链没有部位。
 *
 * 返回 LUMEN_RESULT_OK / INVALID_PARAM（strip_id 越界、part_count > 8）。
 * 失败时不修改任何字节。
 */
uint8_t lumen_layout_store_write(lumen_layout_store_t *layout, uint8_t strip_id,
                                 uint8_t part_count, uint8_t strip_count);

/*
 * LayoutPart 0x21 的语义：写名字与段数。
 *
 * name_len ≤ 24；name 不足 24 字节的部分补 0（解码端只信任 name_len）。
 * seg_count ≤ 8。写 seg_count 时**清空**该部位原有的段（新一次划分从空
 * 开始，避免旧段悄悄留下来）。
 *
 * 返回 LUMEN_RESULT_OK / INVALID_PARAM（下标越界、part_id ≥ 该链部位数、
 * name_len > 24、seg_count > 8）。失败时不修改任何字节。
 */
uint8_t lumen_layout_store_set_part(lumen_layout_store_t *layout, uint8_t strip_id,
                                    uint8_t part_id, uint8_t name_len, const uint8_t *name,
                                    uint8_t seg_count, uint8_t strip_count);

/*
 * LayoutSeg 0x22 的语义：写一个部位的第 seg_id 个灯珠段。
 *
 * 校验顺序（§6.1 第 3 条）：
 *   strip / part / seg 下标范围 → start ≤ end → end < led_count →
 *   与**同链其它所有部位的所有段**互斥（S3）。
 *
 * 压到别的部位 → InvalidParam，旧布局保持不变（S4：不自动裁剪、不覆盖）。
 * 段号等于自身时视为替换。
 */
uint8_t lumen_layout_store_set_seg(lumen_layout_store_t *layout, uint8_t strip_id,
                                   uint8_t part_id, uint8_t seg_id, uint8_t start, uint8_t end,
                                   uint16_t led_count, uint8_t strip_count);

/*
 * 整份校验（LayoutCommit 与 blob 解码共用同一份规则）：
 *   - 每链 part_count ≤ 8；
 *   - 每部位 seg_count ≤ 8、name_len ≤ 24；
 *   - 每段 start ≤ end 且 end < 该链灯珠数；
 *   - 同链所有部位的所有段两两互斥。
 *
 * strip_counts 长度须为 LUMEN_MAX_STRIPS；为 NULL 时退回 LUMEN_MAX_LEDS。
 * 返回 LUMEN_RESULT_OK / INVALID_PARAM。
 */
uint8_t lumen_layout_store_validate(const lumen_layout_store_t *layout, uint8_t strip_count,
                                    const uint16_t *strip_counts);

/*
 * 该链是否有任何**已经划出灯珠**的部位（至少一段）。
 *
 * 与「part_count > 0」不同：LayoutWrite 之后、LayoutSeg 之前，部位存在但
 * 没有段，此时这条链仍然整条黑。
 */
bool lumen_layout_store_has_segments(const lumen_layout_store_t *layout, uint8_t strip_id);

/* 该链某颗灯珠归属的部位号；不属于任何部位返回 LUMEN_PART_NONE。 */
uint8_t lumen_layout_part_of_pixel(const lumen_layout_store_t *layout, uint8_t strip_id,
                                   uint16_t index);

/* 取一个部位（越界或未声明返回 NULL）。 */
const lumen_part_layout_t *lumen_layout_store_part(const lumen_layout_store_t *layout,
                                                   uint8_t strip_id, uint8_t part_id);

/* 某部位覆盖的灯珠总数（所有段长度之和）。 */
uint16_t lumen_layout_part_pixel_count(const lumen_part_layout_t *part);

/*
 * 某颗灯珠在该部位里的**逻辑下标**。
 *
 * 连续相位（S6）下 = 该灯珠在覆盖集合里的升序名次：部位占 1-5 与 20-25 时
 * 序列是 1,2,3,4,5,20,…,25，对应逻辑下标 0..10。
 * 各自起点相位下 = 段内偏移（第二段的 20 也是 0）。
 *
 * index 不在该部位覆盖范围内时返回 0（调用方不该问）。
 */
uint16_t lumen_layout_logical_index(const lumen_part_layout_t *part, uint16_t index,
                                    lumen_phase_mode_t phase);

/*
 * 编码 / 解码布局 blob（§10.3）。
 *
 * 每链记录里的 led_count 是自校验用的冗余（State blob 才是灯珠数的权威），
 * 由 strip_counts 传入；为 NULL 时写 0 表示「本 blob 不带灯珠数」。
 *
 * encode 返回写入的字节数（失败 0）。out_cap 至少 LUMEN_LAYOUT_BLOB_SIZE。
 *
 * decode 校验长度、magic、版本、链数、以及 lumen_layout_store_validate 的
 * 同一份规则（用 blob 自带的 led_count）。任一失败返回 false 且**不写 out**
 * ——调用方保留默认值（绝不出现半套加载）。
 */
size_t lumen_layout_blob_encode(const lumen_layout_store_t *layout, uint8_t strip_count,
                                const uint16_t *strip_counts, uint8_t *out, size_t out_cap);
bool lumen_layout_blob_decode(const uint8_t *blob, size_t len, uint8_t *out_strip_count,
                              lumen_layout_store_t *out);

/*
 * 解码出的每链灯珠数（blob 自带，0 = 该 blob 没写）。与 State 的权威值不一致
 * 时调用方应以 State 为准，并用它再跑一次 lumen_layout_store_validate。
 */
void lumen_layout_blob_strip_counts(const uint8_t *blob, size_t len, uint16_t *out_counts);
