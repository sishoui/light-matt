/*
 * Host 单元测试：不依赖 ESP-IDF，不连硬件。
 *
 * 主要覆盖：
 *   1. docs/protocol-testvectors-v5.json 里的全部用例（两端共用的唯一向量文件）：
 *      - app_to_device 合法帧：解码字段与编码结果逐字节一致，再跑命令层 reducer；
 *      - 非法帧：只有 4 个是信封级失败（bad_magic / bad_version / bad_crc /
 *        bad_length_overflow），其余 frame_valid=false 的是**命令层拒收**
 *        （退役命令 / 参数越界 / ScriptTooLarge），信封本身是合法的；
 *      - device_to_app 帧：解码，并用对应的报告编码器逐字节复现；
 *      - chunks_hex：每一片喂给重组器，断言拼回的字节正好等于 frame_hex，
 *        并核对 FIRST / LAST / 序号语义。
 *   2. SetPower / SetBrightness / SetLedCount reducer 的取值与状态语义
 *      （含亮度钳位、开关解耦、相同值不 commit），以及退役命令与未实现命令的明确回退。
 *   3. state 默认值/钳位/32 字节布局、CRC16 KAT、分片重组边界、gamma + 亮度乘算。
 *
 * 运行：firmware/test/run-tests.cmd（会传 v5 向量路径作为 argv[1]）。
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "command.h"
#include "chunk_reasm.h"
#include "effects.h"
#include "gamma.h"
#include "layout_store.h"
#include "led_count_job.h"
#include "protocol.h"
#include "save_scheduler.h"
#include "scene_compose.h"
#include "scene_store.h"
#include "selftest.h"
#include "state.h"
#include "state_blob.h"
#include "strip_planar.h"
#include "strip_power.h"

static int g_checks;
static int g_failures;

#define CHECK(cond)                                                                    \
    do {                                                                               \
        ++g_checks;                                                                    \
        if (!(cond)) {                                                                 \
            fprintf(stderr, "[FAIL] %s:%d: %s\n", __FILE__, __LINE__, #cond);          \
            ++g_failures;                                                              \
        }                                                                              \
    } while (0)

#define CHECK_BYTES(actual, expected_hex, expected_len)                                \
    do {                                                                               \
        uint8_t _expected[512];                                                        \
        size_t _expected_len =                                                         \
            hex_to_bytes((expected_hex), _expected, sizeof(_expected));                \
        ++g_checks;                                                                    \
        if (_expected_len != (expected_len) ||                                         \
            memcmp((actual), _expected, (expected_len)) != 0) {                        \
            fprintf(stderr, "[FAIL] %s:%d: bytes mismatch\n  expect %s\n  actual ",    \
                    __FILE__, __LINE__, (expected_hex));                               \
            for (size_t _i = 0; _i < (expected_len); ++_i) {                           \
                fprintf(stderr, "%02X", (actual)[_i]);                                 \
            }                                                                          \
            fprintf(stderr, "\n");                                                     \
            ++g_failures;                                                              \
        }                                                                              \
    } while (0)

/*
 * 按测试函数统计断言数（#108）。
 *
 * 断言的唯一计数者是 g_checks。这里只在每个测试函数前后各读一次，把差值打出来，
 * 前缀固定成 "TESTCOUNT <函数名> <断言数>"，编排器（scripts/test-run.mjs）按前缀解析。
 *
 * 关键约束：统计行只走 printf，绝不调用 CHECK / CHECK_BYTES，否则会把自己也算进去，
 * 断言总数就不再是 13996 了。tests/test-run.test.ts 守着「各行之和 == 总数」。
 */
static void report_test_count(const char *label, int before)
{
    printf("TESTCOUNT %s %d\n", label, g_checks - before);
}

#define RUN_TEST(fn)                                                                   \
    do {                                                                               \
        int _before = g_checks;                                                        \
        fn();                                                                          \
        report_test_count(#fn, _before);                                               \
    } while (0)

/* ---------------- 十六进制 ---------------- */

static size_t hex_to_bytes(const char *hex, uint8_t *out, size_t cap)
{
    size_t n = 0;
    while (*hex != '\0') {
        if (*hex == ' ' || *hex == '\n' || *hex == '\t' || *hex == '\r') {
            ++hex;
            continue;
        }
        if (n >= cap || hex[1] == '\0') {
            return (size_t)-1;
        }
        unsigned value = 0;
        if (sscanf(hex, "%2x", &value) != 1) {
            return (size_t)-1;
        }
        out[n++] = (uint8_t)value;
        hex += 2;
    }
    return n;
}

static lumen_decode_status_t decode_hex(const char *hex, lumen_frame_t *frame,
                                        uint8_t *result_code)
{
    /* v3 逻辑帧上限 240 字节；留余量给「超长帧」用例。 */
    uint8_t buf[512];
    size_t len = hex_to_bytes(hex, buf, sizeof(buf));
    if (len == (size_t)-1) {
        fprintf(stderr, "[FAIL] bad test hex: %s\n", hex);
        ++g_failures;
        return LUMEN_DECODE_SILENT;
    }
    return lumen_protocol_decode(buf, len, frame, result_code);
}

/* ---------------- 两层段的测试辅助 ----------------
 *
 * 生产代码里 layer 的 param 是定宽字节数组（§7.1），测试里频繁按「hue / sat /
 * period / p5 / flags」读写 layer0，用下面这组小访问器代替平铺字段，避免在
 * 每个断言里手写 param 下标（下标写错会让整组测试静默测错字节）。
 */

/*
 * 构造一个灯效层。**level 默认 100（满亮）**：v4 引入层亮度后，level = 0
 * 会让整层全黑——所有既有效果测试都会静默变成「全 0 断言」，所以这里的
 * 默认值必须是 100。层亮度的专项测试显式改 out->level。
 */
static void layer_set(uint8_t type, uint16_t hue, uint8_t sat, uint16_t period_ms, uint8_t p5,
                      uint8_t flags, lumen_effect_layer_t *out)
{
    memset(out, 0, sizeof(*out));
    out->type = type;
    out->param[0] = (uint8_t)(hue & 0xFF);
    out->param[1] = (uint8_t)(hue >> 8);
    out->param[2] = sat;
    out->param[3] = (uint8_t)(period_ms & 0xFF);
    out->param[4] = (uint8_t)(period_ms >> 8);
    out->param[5] = p5;
    out->param[6] = flags;
    out->level = (type == LUMEN_LAYER_EMPTY) ? 0 : LUMEN_LAYER_LEVEL_MAX;
}

/* 显式设置层亮度（v4 测试用）。 */
static void layer_set_level(lumen_effect_layer_t *layer, uint8_t level)
{
    layer->level = level;
}

static void layer_clear(lumen_effect_layer_t *out)
{
    memset(out, 0, sizeof(*out));
    out->type = LUMEN_LAYER_EMPTY;
}

static void layer_set_hue(lumen_effect_layer_t *layer, uint16_t hue)
{
    layer->param[0] = (uint8_t)(hue & 0xFF);
    layer->param[1] = (uint8_t)(hue >> 8);
}

static void layer_set_sat(lumen_effect_layer_t *layer, uint8_t sat)
{
    layer->param[2] = sat;
}

static void layer_set_period(lumen_effect_layer_t *layer, uint16_t period_ms)
{
    layer->param[3] = (uint8_t)(period_ms & 0xFF);
    layer->param[4] = (uint8_t)(period_ms >> 8);
}

static void layer_set_p5(lumen_effect_layer_t *layer, uint8_t p5)
{
    layer->param[5] = p5;
}

static void layer_set_flags(lumen_effect_layer_t *layer, uint8_t flags)
{
    layer->param[6] = flags;
}

/* 单层段（layer1 = 空层、blend = 0）：v2 行为的直接对应物。 */
static lumen_segment_t seg_single(uint8_t type, uint8_t start, uint8_t end, uint16_t hue,
                                  uint8_t sat, uint16_t period_ms, uint8_t p5, uint8_t flags,
                                  uint32_t t0_ms)
{
    lumen_segment_t seg;
    memset(&seg, 0, sizeof(seg));
    seg.active = true;
    seg.start = start;
    seg.end = end;
    seg.blend = 0;
    layer_set(type, hue, sat, period_ms, p5, flags, &seg.layer[0]);
    layer_clear(&seg.layer[1]);
    seg.t0_ms = t0_ms;
    return seg;
}


/* ---------------- 段表 shim（仅测试用） ----------------
 *
 * v5 删掉了 segment_store（段表）——线上是「布局 + 场景」，渲染走
 * lumen_scene_compose。但**灯效像素语义**（单层 / 两层 / blend / 层亮度 /
 * 相位）没有变，它们仍然直接测 lumen_effect_pixel。
 *
 * 这个 shim 只做 v4 段表那三件事，让那批像素断言能继续以「这些段在同一帧里
 * 各占一段」的方式表达：
 *   - set   ：形状校验（复用 lumen_segment_validate_shape）+ 区间 + 重叠；
 *   - compose：memset 0 → 逐段逐颗调 lumen_effect_pixel（= v5 的散回逻辑）；
 *   - needs_frames：任一段是动画类。
 *
 * 它**不是**生产代码，也不被任何固件路径引用；生产合成只有
 * scene_compose.c 一处。
 */
typedef struct {
    lumen_segment_t slot[LUMEN_MAX_STRIPS][LUMEN_MAX_PART_SEGS];
} test_seg_store_t;

static void test_seg_init(test_seg_store_t *store)
{
    memset(store, 0, sizeof(*store));
}

static uint8_t test_seg_set(test_seg_store_t *store, uint8_t strip, uint8_t strip_count,
                            uint8_t seg_id, uint8_t led_count, const lumen_segment_t *candidate)
{
    if (store == NULL || candidate == NULL || seg_id >= LUMEN_MAX_PART_SEGS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (lumen_segment_validate_shape(candidate) != LUMEN_RESULT_OK) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (strip_count == 0 || strip_count > LUMEN_MAX_STRIPS || strip >= strip_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (led_count == 0 || led_count > LUMEN_MAX_LEDS) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    if (candidate->start > candidate->end || candidate->end >= led_count) {
        return LUMEN_RESULT_INVALID_PARAM;
    }
    for (uint8_t i = 0; i < LUMEN_MAX_PART_SEGS; ++i) {
        const lumen_segment_t *other = &store->slot[strip][i];
        if (i == seg_id || !other->active) {
            continue;
        }
        if (!(candidate->end < other->start || other->end < candidate->start)) {
            return LUMEN_RESULT_INVALID_PARAM;
        }
    }
    store->slot[strip][seg_id] = *candidate;
    store->slot[strip][seg_id].active = true;
    return LUMEN_RESULT_OK;
}

static uint8_t test_seg_count(const test_seg_store_t *store, uint8_t strip)
{
    uint8_t n = 0;
    for (uint8_t i = 0; i < LUMEN_MAX_PART_SEGS; ++i) {
        if (store->slot[strip][i].active) {
            ++n;
        }
    }
    return n;
}

/*
 * 合成一条链：先整块清零（未覆盖 = 真黑），再逐段逐颗调 lumen_effect_pixel。
 * 与 scene_compose.c 的「清零 → 求值 → 散回」形状一致，只是段的几何直接来自
 * 槽位而不是布局。
 */
static uint16_t test_seg_compose(const test_seg_store_t *store, uint8_t strip, uint8_t *buf,
                                 uint16_t led_count, uint32_t now_ms)
{
    if (store == NULL || buf == NULL || led_count == 0 || led_count > LUMEN_MAX_LEDS) {
        return 0;
    }
    memset(buf, 0, (size_t)led_count * 3u);
    for (uint8_t i = 0; i < LUMEN_MAX_PART_SEGS; ++i) {
        const lumen_segment_t *seg = &store->slot[strip][i];
        if (!seg->active) {
            continue;
        }
        for (uint16_t px = seg->start; px <= seg->end && px < led_count; ++px) {
            uint8_t rgb[3];
            lumen_effect_pixel(seg, px, now_ms, rgb);
            buf[px * 3u + 0] = rgb[0];
            buf[px * 3u + 1] = rgb[1];
            buf[px * 3u + 2] = rgb[2];
        }
    }
    return led_count;
}

static bool test_seg_needs_frames(const test_seg_store_t *store, uint8_t strip_count)
{
    if (store == NULL) {
        return false;
    }
    if (strip_count == 0 || strip_count > LUMEN_MAX_STRIPS) {
        strip_count = LUMEN_MAX_STRIPS;
    }
    for (uint8_t strip = 0; strip < strip_count; ++strip) {
        for (uint8_t i = 0; i < LUMEN_MAX_PART_SEGS; ++i) {
            if (lumen_segment_is_animated(&store->slot[strip][i])) {
                return true;
            }
        }
    }
    return false;
}

/* ---------------- 极简 JSON 字段读取 ----------------
 * 测试向量文件是人工维护的固定格式：顶层对象 + 扁平 cases 数组，每个用例
 * 对象里没有嵌套对象或转义字符。下面的扫描只依赖这个前提，不追求通用性；
 * 一旦格式变化会显式报错，不会静默跳过。
 */

static const char *json_find_key(const char *obj, const char *key)
{
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    return strstr(obj, pattern);
}

static bool json_get_string(const char *obj, const char *key, char *out, size_t cap)
{
    const char *p = json_find_key(obj, key);
    if (p == NULL) {
        return false;
    }
    p = strchr(p, ':');
    if (p == NULL) {
        return false;
    }
    ++p;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') {
        ++p;
    }
    if (*p != '"') {
        return false;
    }
    ++p;
    size_t n = 0;
    while (*p != '\0' && *p != '"') {
        if (n + 1 >= cap) {
            return false;
        }
        out[n++] = *p++;
    }
    if (*p != '"') {
        return false;
    }
    out[n] = '\0';
    return true;
}

/* 返回 false 表示字段缺失或为 null。 */
static bool json_get_int(const char *obj, const char *key, int *out)
{
    const char *p = json_find_key(obj, key);
    if (p == NULL) {
        return false;
    }
    p = strchr(p, ':');
    if (p == NULL) {
        return false;
    }
    ++p;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') {
        ++p;
    }
    if (*p == 'n') {
        return false;
    }
    char *end = NULL;
    long value = strtol(p, &end, 10);
    if (end == p) {
        return false;
    }
    *out = (int)value;
    return true;
}

static bool json_get_bool(const char *obj, const char *key, bool *out)
{
    const char *p = json_find_key(obj, key);
    if (p == NULL) {
        return false;
    }
    p = strchr(p, ':');
    if (p == NULL) {
        return false;
    }
    ++p;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') {
        ++p;
    }
    if (strncmp(p, "true", 4) == 0) {
        *out = true;
        return true;
    }
    if (strncmp(p, "false", 5) == 0) {
        *out = false;
        return true;
    }
    return false;
}

/* ---------------- 向量用例 ---------------- */

/*
 * chunks_hex 是**字符串数组**："chunks_hex": ["C0A6...", "41FF..."]。
 *
 * 现有的 json_get_string 只会读 `"key": "value"`，遇到 `[` 直接失败。这里写一个
 * 专用的扫描：定位 "chunks_hex" → 冒号 → `[` → 逐个引号串。只依赖「数组元素
 * 都是不带转义的 hex 字符串」这个前提（向量文件是人工维护的固定格式），
 * 格式变化会显式报错，不会静默跳过。
 */
#define MAX_CHUNKS 8
typedef struct {
    char hex[MAX_CHUNKS][512];
    int count;
} chunks_hex_t;

static bool json_get_chunks(const char *obj, chunks_hex_t *out)
{
    out->count = 0;
    const char *p = json_find_key(obj, "chunks_hex");
    if (p == NULL) {
        return false;
    }
    p = strchr(p, '[');
    if (p == NULL) {
        return false;
    }
    ++p;
    for (;;) {
        while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n' || *p == ',') {
            ++p;
        }
        if (*p == ']') {
            return out->count > 0;
        }
        if (*p != '"') {
            return false;
        }
        ++p;
        size_t n = 0;
        while (*p != '\0' && *p != '"') {
            if (out->count >= MAX_CHUNKS || n + 1 >= sizeof(out->hex[0])) {
                return false;
            }
            out->hex[out->count][n++] = *p++;
        }
        if (*p != '"') {
            return false;
        }
        out->hex[out->count][n] = '\0';
        ++out->count;
        ++p;
    }
}

typedef struct {
    char name[80];
    char direction[24];
    char frame_hex[512];
    char payload_hex[512];
    chunks_hex_t chunks;
    char prior_segments[64]; /* 可选：段命令的前置段表，如 "0:0-15"（仅 host 测试用） */
    /*
     * 可选：剧本命令的**设备侧前置状态**，形如 "20:000401;21:0000E803;23:00"。
     * 每一项是 `命令字(十进制):载荷hex`，按顺序重放到一个本地剧本表上。
     */
    char prior_script[512];
    int command;
    int seq;
    int result_code; /* -1 = 缺失或 null（静默丢弃） */
    /*
     * 可选：设备侧（引擎整份校验后）的最终结果码。命令层只做形状校验，
     * ScriptCommit 的越界 / 重叠 / 缺阶段只有引擎能判。
     */
    int device_ack;
    /* 可选：本帧处理完后，script_id:stage_count 形式的前一套必须仍完好。 */
    char keep_script[32];
    /*
     * v3 的语义：frame_valid == true 表示**这条命令应当成功**；
     * false 表示「命令层拒收，result_code 是预期结果码」——它仍可能是
     * 合法信封（例如退役命令 / 参数越界）。
     */
    bool frame_valid;
} vector_case_t;

/* 返回读到的用例数；文件或格式问题返回 -1。 */
static int for_each_case(const char *path, void (*fn)(const vector_case_t *))
{
    FILE *fp = fopen(path, "rb");
    if (fp == NULL) {
        fprintf(stderr, "[FAIL] cannot open vectors: %s\n", path);
        return -1;
    }
    if (fseek(fp, 0, SEEK_END) != 0) {
        fclose(fp);
        return -1;
    }
    long size = ftell(fp);
    if (size <= 0) {
        fclose(fp);
        return -1;
    }
    rewind(fp);
    char *text = malloc((size_t)size + 1);
    if (text == NULL) {
        fclose(fp);
        return -1;
    }
    size_t read = fread(text, 1, (size_t)size, fp);
    fclose(fp);
    text[read] = '\0';

    const char *cases = strstr(text, "\"cases\"");
    if (cases == NULL) {
        fprintf(stderr, "[FAIL] vectors missing \"cases\"\n");
        free(text);
        return -1;
    }
    const char *p = strchr(cases, '[');
    if (p == NULL) {
        free(text);
        return -1;
    }

    int count = 0;
    /*
     * 8KB：一个用例最多带 3 个 chunks（每片 ~500 字符）+ 其余字段。
     * 旧的 2048 装不下 chunks 数组。
     */
    static char object[8192];
    for (;;) {
        while (*p != '\0' && *p != '{' && *p != ']') {
            ++p;
        }
        if (*p == '\0' || *p == ']') {
            break;
        }
        const char *end = strchr(p, '}');
        if (end == NULL) {
            break;
        }
        size_t len = (size_t)(end - p) + 1;
        if (len >= sizeof(object)) {
            fprintf(stderr, "[FAIL] vector case too large\n");
            free(text);
            return -1;
        }
        memcpy(object, p, len);
        object[len] = '\0';

        vector_case_t c;
        memset(&c, 0, sizeof(c));
        c.command = -1;
        c.seq = -1;
        c.result_code = -1;
        c.device_ack = -1;
        if (!json_get_string(object, "name", c.name, sizeof(c.name)) ||
            !json_get_string(object, "direction", c.direction, sizeof(c.direction)) ||
            !json_get_string(object, "frame_hex", c.frame_hex, sizeof(c.frame_hex)) ||
            !json_get_bool(object, "frame_valid", &c.frame_valid)) {
            fprintf(stderr, "[FAIL] malformed vector case near: %.60s\n", object);
            free(text);
            return -1;
        }
        json_get_string(object, "payload_hex", c.payload_hex, sizeof(c.payload_hex));
        json_get_string(object, "prior_segments", c.prior_segments, sizeof(c.prior_segments));
        json_get_string(object, "prior_script", c.prior_script, sizeof(c.prior_script));
        json_get_string(object, "keep_script", c.keep_script, sizeof(c.keep_script));
        json_get_int(object, "command", &c.command);
        json_get_int(object, "seq", &c.seq);
        json_get_int(object, "result_code", &c.result_code);
        json_get_int(object, "device_ack", &c.device_ack);
        if (!json_get_chunks(object, &c.chunks)) {
            fprintf(stderr, "[FAIL] vector %s missing chunks_hex\n", c.name);
            free(text);
            return -1;
        }

        fn(&c);
        ++count;
        p = end + 1;
    }

    free(text);
    return count;
}




/*
 * 向量用例的基线状态：8 条灯带 × 64 灯。
 *
 * 为什么不是 `lumen_state_defaults()` 的 1 条 30 灯：v5 向量里的布局与场景命令
 * 直接寻址 strip 0-7，且段区间到 29（`layout_seg_radiator_11_29`），
 * `set_led_count_strip7_1` 还明确假设 strip_count=8。向量是字节契约，
 * 不是设备初始状态，所以这里显式给一个能容纳全部用例的基线。
 *
 * 布局表给成「strip 0 有 3 个部位、每部位 seg_count 都已声明」，这样
 * layout_seg_* 用例的 part_id / seg_id 校验才落在合法区间里——
 * 向量里的布局族用例本来就是按「已经 LayoutWrite + LayoutPart 过」的前置
 * 状态写的（§6.1 的分帧写入顺序）。
 */
static void vector_baseline(lumen_state_t *state, lumen_layout_store_t *layout)
{
    lumen_state_defaults(state, 64);
    state->strip_count = 8;
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        state->led_count[i] = 64;
    }

    lumen_layout_store_init(layout);
    /*
     * strip 0：三个部位，段数分别是 1 / 1 / 1（覆盖 layout_seg_head_0_9、
     * layout_seg_monitor_single、layout_seg_radiator_11_29 三条用例）。
     * 段本身**不预写**：用例要自己写进去，且要能检出重叠。
     */
    (void)lumen_layout_store_write(layout, 0, 3, state->strip_count);
    for (uint8_t p = 0; p < 3; ++p) {
        (void)lumen_layout_store_set_part(layout, 0, p, 0, NULL, 1, LUMEN_PHASE_CONTINUOUS, state->strip_count);
    }
    state->part_count[0] = 3;
}

/*
 * v5 的 5 个信封级失败用例。其余 frame_valid=false 的用例是合法信封配
 * 命令层拒收（退役命令 / 参数越界）。
 */
static bool is_envelope_failure(const char *name)
{
    return strcmp(name, "bad_magic") == 0 || strcmp(name, "bad_version_v4") == 0 ||
           strcmp(name, "bad_version_v3") == 0 || strcmp(name, "bad_crc") == 0 ||
           strcmp(name, "bad_length_overflow") == 0;
}

static void run_app_case(const vector_case_t *c)
{
    lumen_frame_t frame;
    uint8_t result_code = 0xFF;
    lumen_decode_status_t status = decode_hex(c->frame_hex, &frame, &result_code);

    if (is_envelope_failure(c->name)) {
        /* 信封就坏了：不执行命令，按 §5 的顺序回对应结果码。 */
        CHECK(c->result_code >= 0);
        CHECK(status == LUMEN_DECODE_ERROR);
        CHECK(result_code == (uint8_t)c->result_code);
        return;
    }

    /* 其余用例（含 frame_valid=false）的信封必须合法。 */
    CHECK(status == LUMEN_DECODE_OK);
    CHECK(result_code == LUMEN_RESULT_OK);
    if (c->command >= 0) {
        CHECK(frame.command == (uint8_t)c->command);
    }
    if (c->seq >= 0) {
        CHECK(frame.seq == (uint8_t)c->seq);
    }

    uint8_t expected_payload[LUMEN_MAX_PAYLOAD];
    size_t expected_len =
        hex_to_bytes(c->payload_hex, expected_payload, sizeof(expected_payload));
    CHECK(expected_len != (size_t)-1);
    CHECK(frame.payload_len == (uint8_t)expected_len);
    CHECK(memcmp(frame.payload, expected_payload, expected_len) == 0);

    lumen_state_t before;
    lumen_layout_store_t layout;
    vector_baseline(&before, &layout);

    lumen_command_outcome_t outcome;
    lumen_command_dispatch(&frame, &before, &layout, 255, &outcome);

    /* 契约里的预期结果码。 */
    CHECK(c->result_code >= 0);
    CHECK(outcome.result_code == (uint8_t)c->result_code);

    if (frame.command == LUMEN_CMD_SET_POWER) {
        if (outcome.result_code == LUMEN_RESULT_OK) {
            CHECK(outcome.next.power == frame.payload[0]);
            CHECK(outcome.state_changed == (before.power != frame.payload[0]));
        } else {
            CHECK(!outcome.state_changed);
            CHECK(outcome.next.power == before.power);
        }
    } else if (frame.command == LUMEN_CMD_SET_BRIGHTNESS) {
        CHECK(outcome.next.power == before.power);
        CHECK(outcome.next.brightness == frame.payload[0]);
        CHECK(outcome.state_changed == (before.brightness != frame.payload[0]));
    } else if (frame.command == LUMEN_CMD_SELF_TEST) {
        CHECK(outcome.start_selftest);
        CHECK(!outcome.cancels_selftest);
        CHECK(!outcome.state_changed);
    } else if (frame.command == LUMEN_CMD_SET_LED_COUNT) {
        uint16_t expected =
            (uint16_t)(frame.payload[1] | ((uint16_t)frame.payload[2] << 8));
        CHECK(!outcome.state_changed);
        if (outcome.result_code == LUMEN_RESULT_OK) {
            CHECK(outcome.led_count_rebuild);
            CHECK(outcome.led_count == expected);
            CHECK(outcome.cancels_selftest);
        } else {
            CHECK(!outcome.led_count_rebuild);
            CHECK(!outcome.cancels_selftest);
        }
    } else if (frame.command == LUMEN_CMD_QUERY_STATE) {
        CHECK(outcome.state_report);
        CHECK(!outcome.state_changed);
        CHECK(!outcome.cancels_selftest);
    } else if (frame.command == LUMEN_CMD_QUERY_STRIP_CONFIG ||
               frame.command == LUMEN_CMD_QUERY_DEVICE_INFO) {
        /* 两条无载荷查询：ACK 0x00 + 一条报告，不改状态、不取消自检。 */
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.strip_config_query ==
              (frame.command == LUMEN_CMD_QUERY_STRIP_CONFIG));
        CHECK(outcome.device_info_query ==
              (frame.command == LUMEN_CMD_QUERY_DEVICE_INFO));
        CHECK(!outcome.state_changed);
        CHECK(!outcome.cancels_selftest);
    } else if (frame.command == LUMEN_CMD_SET_STRIP_POWER) {
        CHECK(!outcome.state_changed);
        if (outcome.result_code == LUMEN_RESULT_OK) {
            CHECK(outcome.strip_power_op);
            CHECK(outcome.strip_power_strip == frame.payload[0]);
            CHECK(outcome.strip_power_on == (frame.payload[1] != 0));
            CHECK(outcome.cancels_selftest);
        } else {
            CHECK(!outcome.strip_power_op);
            CHECK(!outcome.cancels_selftest);
        }
    } else if (frame.command >= LUMEN_CMD_LAYOUT_WRITE &&
               frame.command <= LUMEN_CMD_QUERY_LAYOUT) {
        /* 布局族 0x20-0x24：只登记意图，不改 State（布局不在 State 里）。 */
        CHECK(!outcome.state_changed);
        if (outcome.result_code == LUMEN_RESULT_OK) {
            CHECK(outcome.layout_op);
            CHECK(outcome.layout_opcode == frame.command);
            switch (frame.command) {
            case LUMEN_CMD_LAYOUT_WRITE:
                CHECK(outcome.layout_strip == frame.payload[0]);
                CHECK(outcome.layout_part_count == frame.payload[1]);
                CHECK(outcome.cancels_selftest);
                break;
            case LUMEN_CMD_LAYOUT_PART:
                CHECK(outcome.layout_strip == frame.payload[0]);
                CHECK(outcome.layout_part == frame.payload[1]);
                CHECK(outcome.layout_name_len == frame.payload[2]);
                CHECK(outcome.layout_seg_count == frame.payload[27]);
                CHECK(memcmp(outcome.layout_name, &frame.payload[3],
                             LUMEN_NAME_BYTES) == 0);
                CHECK(outcome.cancels_selftest);
                break;
            case LUMEN_CMD_LAYOUT_SEG:
                CHECK(outcome.layout_strip == frame.payload[0]);
                CHECK(outcome.layout_part == frame.payload[1]);
                CHECK(outcome.layout_seg == frame.payload[2]);
                CHECK(outcome.layout_start == frame.payload[3]);
                CHECK(outcome.layout_end == frame.payload[4]);
                CHECK(outcome.cancels_selftest);
                break;
            case LUMEN_CMD_LAYOUT_COMMIT:
                CHECK(outcome.cancels_selftest);
                break;
            case LUMEN_CMD_QUERY_LAYOUT:
                CHECK(outcome.layout_strip == frame.payload[0]);
                CHECK(!outcome.cancels_selftest);
                break;
            default:
                CHECK(false);
                break;
            }
        } else {
            CHECK(!outcome.layout_op);
            CHECK(!outcome.cancels_selftest);
        }
    } else if (frame.command >= LUMEN_CMD_SCENE_PART &&
               frame.command <= LUMEN_CMD_QUERY_SCENE) {
        /* 场景族 0x25-0x29：同样只登记意图（场景也不在 State 里）。 */
        CHECK(!outcome.state_changed);
        if (outcome.result_code == LUMEN_RESULT_OK) {
            CHECK(outcome.scene_op);
            CHECK(outcome.scene_opcode == frame.command);
            switch (frame.command) {
            case LUMEN_CMD_SCENE_PART:
                CHECK(outcome.scene_id == frame.payload[0]);
                CHECK(outcome.scene_strip == frame.payload[1]);
                CHECK(outcome.scene_part == frame.payload[2]);
                CHECK(outcome.scene_step_count == frame.payload[3]);
                CHECK(outcome.scene_loop == frame.payload[4]);
                CHECK(outcome.scene_on == frame.payload[5]);
                CHECK(outcome.cancels_selftest);
                break;
            case LUMEN_CMD_SCENE_STEP:
                CHECK(outcome.scene_id == frame.payload[0]);
                CHECK(outcome.scene_strip == frame.payload[1]);
                CHECK(outcome.scene_part == frame.payload[2]);
                CHECK(outcome.scene_step_index == frame.payload[3]);
                CHECK(outcome.scene_duration_ms ==
                      (uint16_t)(frame.payload[4] | (frame.payload[5] << 8)));
                CHECK(memcmp(outcome.scene_layer[0], &frame.payload[6], 9) == 0);
                CHECK(memcmp(outcome.scene_layer[1], &frame.payload[15], 9) == 0);
                CHECK(outcome.cancels_selftest);
                break;
            case LUMEN_CMD_SCENE_NAME:
                CHECK(outcome.scene_id == frame.payload[0]);
                CHECK(outcome.scene_name_len == frame.payload[1]);
                CHECK(memcmp(outcome.scene_name, &frame.payload[2], LUMEN_NAME_BYTES) == 0);
                CHECK(outcome.cancels_selftest);
                break;
            case LUMEN_CMD_ACTIVATE_SCENE:
                CHECK(outcome.scene_id == frame.payload[0]);
                CHECK(outcome.cancels_selftest);
                break;
            case LUMEN_CMD_QUERY_SCENE:
                CHECK(outcome.scene_id == frame.payload[0]);
                CHECK(!outcome.cancels_selftest);
                break;
            default:
                CHECK(false);
                break;
            }
        } else {
            CHECK(!outcome.scene_op);
            CHECK(!outcome.cancels_selftest);
        }
    } else {
        /* 退役 / 保留 / 未知命令：一律 0x02，状态与全部意图都不动。 */
        CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
        CHECK(!outcome.state_changed);
        CHECK(!outcome.led_count_rebuild);
        CHECK(!outcome.state_report);
        CHECK(!outcome.strip_config_query);
        CHECK(!outcome.device_info_query);
        CHECK(!outcome.layout_op);
        CHECK(!outcome.scene_op);
        CHECK(!outcome.strip_power_op);
        CHECK(!outcome.cancels_selftest);
    }

    if (c->frame_valid) {
        /*
         * frame_valid=true 的语义是「命令成功」，所以结果码必须是 0x00。
         * 除了 SetLedCount 的延迟重建（仍回 0x00）外没有例外。
         */
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
    }
}

static void run_device_case(const vector_case_t *c)
{
    lumen_frame_t frame;
    uint8_t result_code = 0xFF;
    lumen_decode_status_t status = decode_hex(c->frame_hex, &frame, &result_code);

    CHECK(status == LUMEN_DECODE_OK);
    CHECK(result_code == LUMEN_RESULT_OK);
    if (c->command >= 0) {
        CHECK(frame.command == (uint8_t)c->command);
    }
    if (c->seq >= 0) {
        CHECK(frame.seq == (uint8_t)c->seq);
    }

    uint8_t expected_payload[LUMEN_MAX_PAYLOAD];
    size_t expected_len =
        hex_to_bytes(c->payload_hex, expected_payload, sizeof(expected_payload));
    CHECK(expected_len != (size_t)-1);
    CHECK(frame.payload_len == (uint8_t)expected_len);
    CHECK(memcmp(frame.payload, expected_payload, expected_len) == 0);

    /* 设备→小程序帧必须能用对应的编码器逐字节复现。 */
    uint8_t out[LUMEN_MAX_FRAME];
    size_t len = 0;
    switch (frame.command) {
    case LUMEN_CMD_ACK:
        CHECK(frame.payload_len == 2);
        len = lumen_protocol_encode_ack(frame.seq, frame.payload[0], frame.payload[1], out,
                                        sizeof(out));
        break;
    case LUMEN_CMD_EVENT:
        CHECK(frame.payload_len == 2);
        len = lumen_protocol_encode_event(frame.payload[0], frame.payload[1], out,
                                          sizeof(out));
        break;
    case LUMEN_CMD_STATE_REPORT:
        CHECK(frame.payload_len == LUMEN_STATE_BYTES);
        len = lumen_protocol_encode_state_report(frame.seq, frame.payload, out, sizeof(out));
        break;
    case LUMEN_CMD_STRIP_CONFIG_REPORT: {
        CHECK(frame.payload_len == 24);
        /* 从载荷还原引脚表：只对已分配（flags bit0）的记录取值。 */
        uint8_t gpios[LUMEN_MAX_STRIPS];
        uint8_t assigned = 0;
        for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
            CHECK(frame.payload[i * 3] == i);
            gpios[i] = frame.payload[i * 3 + 1];
            if ((frame.payload[i * 3 + 2] & 0x01u) != 0) {
                ++assigned;
            }
        }
        len = lumen_protocol_encode_strip_config_report(frame.seq, gpios, assigned, out,
                                                        sizeof(out));
        break;
    }
    case LUMEN_CMD_DEVICE_INFO_REPORT: {
        CHECK(frame.payload_len == 15);
        uint16_t version = (uint16_t)(frame.payload[0] | ((uint16_t)frame.payload[1] << 8));
        len = lumen_protocol_encode_device_info_report(frame.seq, version, &frame.payload[2],
                                                       frame.payload[14], out, sizeof(out));
        break;
    }
    case LUMEN_CMD_LAYOUT_REPORT: {
        /* 45 字节（§7.2）：strip | part | name_len | name[24] | seg_count | phase
         * | 8 × (start,end)。 */
        CHECK(frame.payload_len == LUMEN_LAYOUT_REPORT_BYTES);
        CHECK(frame.payload[27] <= LUMEN_MAX_PART_SEGS);
        CHECK(frame.payload[28] <= LUMEN_PHASE_MAX);
        const uint8_t (*segs)[2] = NULL;
        uint8_t seg_buf[LUMEN_MAX_PART_SEGS][2];
        for (uint8_t i = 0; i < LUMEN_MAX_PART_SEGS; ++i) {
            seg_buf[i][0] = frame.payload[29 + i * 2];
            seg_buf[i][1] = frame.payload[29 + i * 2 + 1];
        }
        segs = (const uint8_t(*)[2])seg_buf;
        len = lumen_protocol_encode_layout_report(frame.seq, frame.payload[0], frame.payload[1],
                                                  frame.payload[2], &frame.payload[3],
                                                  frame.payload[27], frame.payload[28], segs, out,
                                                  sizeof(out));
        break;
    }
    case LUMEN_CMD_LAYOUT_LIST_END:
        CHECK(frame.payload_len == 2);
        len = lumen_protocol_encode_layout_list_end(frame.seq, frame.payload[0], frame.payload[1],
                                                    out, sizeof(out));
        break;
    case LUMEN_CMD_SCENE_PART_REPORT:
        CHECK(frame.payload_len == 6);
        len = lumen_protocol_encode_scene_part_report(
            frame.seq, frame.payload[0], frame.payload[1], frame.payload[2], frame.payload[3],
            frame.payload[4], frame.payload[5], out, sizeof(out));
        break;
    case LUMEN_CMD_SCENE_STEP_REPORT: {
        /* 与 SceneStep 同构（§7.4）：24 字节。 */
        CHECK(frame.payload_len == LUMEN_SCENE_STEP_BYTES);
        uint16_t duration = (uint16_t)(frame.payload[4] | ((uint16_t)frame.payload[5] << 8));
        len = lumen_protocol_encode_scene_step_report(
            frame.seq, frame.payload[0], frame.payload[1], frame.payload[2], frame.payload[3],
            duration, &frame.payload[6], &frame.payload[15], out, sizeof(out));
        break;
    }
    case LUMEN_CMD_SCENE_LIST_END:
        CHECK(frame.payload_len == LUMEN_SCENE_NAME_BYTES);
        len = lumen_protocol_encode_scene_list_end(frame.seq, frame.payload[0], frame.payload[1],
                                                   &frame.payload[2], out, sizeof(out));
        break;
    default:
        /* 其余设备→小程序帧：用通用编码器验证信封逐字节一致。 */
        CHECK(frame.payload_len <= LUMEN_MAX_PAYLOAD);
        len = lumen_protocol_encode(frame.command, frame.seq, frame.payload,
                                    frame.payload_len, out, sizeof(out));
        break;
    }
    CHECK(len == expected_len + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, c->frame_hex, len);
}

/*
 * 分片一致性（两端对称，§3.2）：
 *   - 逐片喂给重组器，拼回的字节必须正好等于 frame_hex；
 *   - 首片 FIRST、末片 LAST，单分片两者兼具；
 *   - 序号从 0 递增（仅诊断用，但向量里是这么生成的）。
 */
static void check_chunks(const vector_case_t *c)
{
    CHECK(c->chunks.count > 0);
    CHECK(c->chunks.count <= MAX_CHUNKS);

    lumen_reasm_t reasm;
    lumen_reasm_init(&reasm);

    uint8_t assembled[LUMEN_REASM_CAPACITY];
    size_t assembled_len = 0;
    uint32_t now = 1000;

    for (int i = 0; i < c->chunks.count; ++i) {
        uint8_t raw[512];
        size_t raw_len = hex_to_bytes(c->chunks.hex[i], raw, sizeof(raw));
        CHECK(raw_len != (size_t)-1);
        CHECK(raw_len >= 2);

        uint8_t ctrl = raw[0];
        bool first = (ctrl & LUMEN_CHUNK_FIRST) != 0;
        bool last = (ctrl & LUMEN_CHUNK_LAST) != 0;
        CHECK(first == (i == 0));
        CHECK(last == (i == c->chunks.count - 1));
        CHECK((ctrl & LUMEN_CHUNK_INDEX_MASK) == (uint8_t)i);

        lumen_reasm_status_t st =
            lumen_reasm_feed(&reasm, ctrl, &raw[1], raw_len - 1, now);
        now += 10;
        if (i + 1 < c->chunks.count) {
            CHECK(st == LUMEN_REASM_PENDING);
        } else {
            CHECK(st == LUMEN_REASM_COMPLETE);
            assembled_len = reasm.len;
            memcpy(assembled, reasm.data, assembled_len);
        }
    }

    uint8_t expected[LUMEN_MAX_FRAME];
    size_t expected_len = hex_to_bytes(c->frame_hex, expected, sizeof(expected));
    CHECK(expected_len != (size_t)-1);
    CHECK(assembled_len == expected_len);
    CHECK(memcmp(assembled, expected, expected_len) == 0);

    /* 单分片（不分片）的帧 ctrl 必须是 0xC0——不许裸帧（§3.2）。 */
    if (c->chunks.count == 1) {
        uint8_t only[512];
        size_t only_len = hex_to_bytes(c->chunks.hex[0], only, sizeof(only));
        CHECK(only_len != (size_t)-1);
        CHECK(only[0] == LUMEN_CHUNK_SINGLE);
    }
}

static void dispatch_case(const vector_case_t *c)
{
    if (strcmp(c->direction, "app_to_device") == 0) {
        run_app_case(c);
    } else if (strcmp(c->direction, "device_to_app") == 0) {
        run_device_case(c);
    } else {
        fprintf(stderr, "[FAIL] unknown direction: %s\n", c->direction);
        ++g_failures;
    }
    check_chunks(c);
}

/* ---------------- 独立断言 ---------------- */

static void test_checksum(void)
{
    /* 标准校验值（docs/protocol-v4.md §3.4 / §11）："123456789" → 0x29B1。 */
    const char *kat = "123456789";
    CHECK(lumen_protocol_crc16((const uint8_t *)kat, strlen(kat)) == 0x29B1);

    /* §3.3 的例子：SetPower(on) seq=1 → A6 05 01 01 01 00 01，CRC = 0x2D11（小端 11 2D）。 */
    const uint8_t body[] = {0xA6, 0x05, 0x01, 0x01, 0x01, 0x00, 0x01};
    CHECK(lumen_protocol_crc16(body, sizeof(body)) == 0x2D11);

    uint8_t out[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode(LUMEN_CMD_SET_POWER, 0x01, &body[6], 1, out,
                                       sizeof(out));
    CHECK(len == 9);
    CHECK_BYTES(out, "A6050101010001112D", len);

    /* 空输入：初值 0xFFFF 原样返回（CRC 的定义，不是错误）。 */
    CHECK(lumen_protocol_crc16(NULL, 0) == 0xFFFF);
    CHECK(lumen_protocol_crc16(body, 0) == 0xFFFF);

    /* 双字节长度字段：232 字节载荷编得出来，233 字节被拒（§1.1 的上限）。 */
    uint8_t big[LUMEN_MAX_PAYLOAD];
    memset(big, 0x5A, sizeof(big));
    len = lumen_protocol_encode(0x7F, 0x01, big, LUMEN_MAX_PAYLOAD, out, sizeof(out));
    CHECK(len == LUMEN_MAX_FRAME);
    CHECK(out[4] == (uint8_t)(LUMEN_MAX_PAYLOAD & 0xFF));
    CHECK(out[5] == (uint8_t)(LUMEN_MAX_PAYLOAD >> 8));
    CHECK(len == LUMEN_FRAME_OVERHEAD + LUMEN_MAX_PAYLOAD);
}

static void test_set_power_reducer(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    lumen_frame_t frame = {0};
    lumen_command_outcome_t outcome;

    /* 开灯：状态改变 */
    frame.command = LUMEN_CMD_SET_POWER;
    frame.seq = 1;
    frame.payload_len = 1;
    frame.payload[0] = 1;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 1);

    /* 已是开灯：ACK 0x00 但不重复 commit */
    lumen_command_dispatch(&frame, &outcome.next, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.power == 1);

    /* 非法取值 0x02：0x01，状态不变 */
    lumen_frame_t bad = {0};
    bad.command = LUMEN_CMD_SET_POWER;
    bad.payload_len = 1;
    bad.payload[0] = 2;
    lumen_command_dispatch(&bad, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.power == state.power);

    /* 载荷长度不符：0x04，状态不变 */
    bad.payload_len = 2;
    bad.payload[0] = 1;
    bad.payload[1] = 0;
    lumen_command_dispatch(&bad, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.state_changed);

    /* QueryState（§6.1）：回 0x00 + 请求 StateReport，不改状态、不取消自检。
     * 0x06 自 #12 起已实现，单独覆盖在 test_set_led_count_reducer()；
     * 0x07 自 #13 起已实现，见下面的 selftest 断言。 */
    {
        lumen_frame_t known = {0};
        known.command = LUMEN_CMD_QUERY_STATE;
        known.payload_len = lumen_command_payload_len(LUMEN_CMD_QUERY_STATE);
        lumen_command_dispatch(&known, &state, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.state_report);
        CHECK(!outcome.state_changed);
        CHECK(!outcome.start_selftest);
        CHECK(!outcome.cancels_selftest);
        CHECK(!outcome.led_count_rebuild);
        CHECK(lumen_command_is_known(LUMEN_CMD_QUERY_STATE));
    }

    /* 0x07 SelfTest（#13）：立即回 0x00、不改状态、启动自检 */
    lumen_frame_t selftest = {0};
    selftest.command = LUMEN_CMD_SELF_TEST;
    selftest.payload_len = 0;
    lumen_command_dispatch(&selftest, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.start_selftest);
    CHECK(!outcome.cancels_selftest);
    CHECK(memcmp(&outcome.next, &state, sizeof(state)) == 0);

    /* 保留 / 未知 / 退役 / 设备→小程序命令字：0x02。
     * v2 退役的 0x03 SetColor / 0x04 SetAll 走这里。
     * 0x10 / 0x11 / 0x12 / 0x13–0x1A / 0x1B / 0x1C / 0x1D / 0x1E(ClearScript) 都已实现，
     * 都不再属于未知命令；0x1F 起才是保留字。 */
    const uint8_t unknown[] = {0x00, 0x03, 0x04, 0x08, 0x09, 0x0F, 0x1F, 0x7F,
                               0x80, 0x81, 0x82, 0xFF};
    for (size_t i = 0; i < sizeof(unknown); ++i) {
        lumen_frame_t f = {0};
        f.command = unknown[i];
        lumen_command_dispatch(&f, &state, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
        CHECK(!outcome.state_changed);
    }
}

/*
 * SetBrightness：0-255 全部合法（协议 §6），但按 §11.4 钳位到构建期上限。
 * 亮度与开关解耦：亮度 0 不清 power，关灯不改 brightness。
 */
static void test_set_brightness_reducer(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 1;
    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SET_BRIGHTNESS;
    frame.seq = 2;
    frame.payload_len = 1;
    lumen_command_outcome_t outcome;

    /* 边界值逐个下发：0 / 1 / 128 / 254 / 255，全部 0x00。 */
    const uint8_t boundaries[] = {0, 1, 128, 254, 255};
    lumen_state_t before = state;
    for (size_t i = 0; i < sizeof(boundaries); ++i) {
        frame.payload[0] = boundaries[i];
        lumen_command_dispatch(&frame, &before, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.state_changed == (before.brightness != boundaries[i]));
        CHECK(outcome.next.brightness == boundaries[i]);
        /* 其它字段一律不动，特别是 power。 */
        CHECK(outcome.next.power == before.power);
        /* v5 的 State 没有 RGB 摘要（§7.3）；用逐条灯珠数证明别的字段没动。 */
        for (uint8_t s = 0; s < LUMEN_MAX_STRIPS; ++s) {
            CHECK(outcome.next.led_count[s] == before.led_count[s]);
        }
        CHECK(outcome.next.strip_count == before.strip_count);
        CHECK(outcome.next.active_scene == before.active_scene);
        before = outcome.next;
    }

    /* 亮度 0 是合法状态：power 位保持 1（协议 §7）。 */
    lumen_state_t zero = state;
    zero.brightness = 0;
    frame.payload[0] = 0;
    lumen_command_dispatch(&frame, &zero, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.power == 1);
    CHECK(outcome.next.brightness == 0);

    /* 相同值不 commit（避免无意义刷新 / NVS 写入），ACK 仍为 0x00。 */
    lumen_state_t same = state;
    same.brightness = 128;
    frame.payload[0] = 128;
    lumen_command_dispatch(&frame, &same, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.brightness == 128);

    /* 钳位而不是拒绝：max_brightness=180 时，200 / 255 都落到 180。 */
    frame.payload[0] = 200;
    lumen_command_dispatch(&frame, &state, NULL, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.brightness == 180);
    CHECK(outcome.next.power == 1);

    frame.payload[0] = 255;
    lumen_command_dispatch(&frame, &state, NULL, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.next.brightness == 180);

    /* 钳位后的值与当前值相同：不 commit。 */
    lumen_state_t at_cap = state;
    at_cap.brightness = 180;
    frame.payload[0] = 255;
    lumen_command_dispatch(&frame, &at_cap, NULL, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);

    /* 上限之内的值不受影响。 */
    frame.payload[0] = 100;
    lumen_command_dispatch(&frame, &state, NULL, 180, &outcome);
    CHECK(outcome.next.brightness == 100);

    /* max_brightness = 0：任何值都被钳到 0，仍然回 0x00。 */
    frame.payload[0] = 255;
    lumen_command_dispatch(&frame, &state, NULL, 0, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.next.brightness == 0);
    CHECK(outcome.next.power == 1);

    /* 载荷长度不符：0x04，状态不变。 */
    frame.payload_len = 2;
    frame.payload[0] = 100;
    frame.payload[1] = 0;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.brightness == state.brightness);

    /* 关灯再开：SetPower 不改变 brightness（关灯保留亮度）。 */
    lumen_state_t lit = state;
    lit.power = 1;
    lit.brightness = 77;
    lumen_frame_t power = {0};
    power.command = LUMEN_CMD_SET_POWER;
    power.payload_len = 1;
    power.payload[0] = 0;
    lumen_command_dispatch(&power, &lit, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 0);
    CHECK(outcome.next.brightness == 77);

    power.payload[0] = 1;
    lumen_command_dispatch(&power, &outcome.next, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 1);
    CHECK(outcome.next.brightness == 77);
}

/*
 * 退役命令（v5 的 §6 末段）：0x03 / 0x04（v2 退役）与整个 0x10-0x1E
 * 段 / 剧本族一律回 0x02 UnknownCommand。
 *
 * 关键约束：

 *  - 无论载荷长度多合法，一律回 0x02（**命令字判定优先于长度**，§5 顺序）；
 *  - 状态一个字段都不动，全部意图字段也不置位。
 *
 * 这一组是票 #155 的验收项「v4 命令必须回未知命令」的 host 侧证据；
 * 向量文件里的 `retired_*` 用例是字节级证据，两边覆盖同一件事。
 */
static void test_retired_commands(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 1;
    state.brightness = 77;
    state.active_scene = 2;

    const uint8_t retired[] = {
        LUMEN_CMD_SET_COLOR,      LUMEN_CMD_SET_ALL,          LUMEN_CMD_SET_SEGMENT,
        LUMEN_CMD_CLEAR_SEGMENT,  LUMEN_CMD_QUERY_STRIP,      LUMEN_CMD_SET_PLAYBACK,
        LUMEN_CMD_SCRIPT_BEGIN,   LUMEN_CMD_SCRIPT_STAGE,     LUMEN_CMD_SCRIPT_SEGMENT,
        LUMEN_CMD_SCRIPT_COMMIT,  LUMEN_CMD_SCRIPT_ABORT,     LUMEN_CMD_ACTIVATE_SCRIPT,
        LUMEN_CMD_QUERY_SCRIPT,   LUMEN_CMD_CLEAR_SCRIPT,
    };
    lumen_command_outcome_t outcome;
    for (size_t i = 0; i < sizeof(retired); ++i) {
        CHECK(!lumen_command_is_known(retired[i]));
        CHECK(!lumen_command_changes_state(retired[i]));

        lumen_frame_t frame = {0};
        frame.command = retired[i];
        frame.seq = (uint8_t)(i + 1);
        /* 给足「看起来合法」的载荷：命令字判定必须优先于长度。 */
        frame.payload_len = (uint8_t)(retired[i] == LUMEN_CMD_SCRIPT_SEGMENT ? 25 : 23);
        memset(frame.payload, 0x5A, frame.payload_len);
        lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
        CHECK(!outcome.state_changed);
        CHECK(!outcome.cancels_selftest);
        CHECK(!outcome.layout_op);
        CHECK(!outcome.scene_op);
        CHECK(!outcome.strip_power_op);
        CHECK(!outcome.state_report);
        /* 退役命令**不修改** next：一个字节都不该与 current 不同。 */
        CHECK(memcmp(&outcome.next, &state, sizeof(state)) == 0);
    }

    /* v5 已知命令：空载荷一律 BadLength（长度校验先于取值，§5）。 */
    const uint8_t implemented[] = {
        LUMEN_CMD_SET_POWER,       LUMEN_CMD_SET_BRIGHTNESS,  LUMEN_CMD_SET_LED_COUNT,
        LUMEN_CMD_SET_STRIP_POWER, LUMEN_CMD_LAYOUT_WRITE,    LUMEN_CMD_LAYOUT_PART,
        LUMEN_CMD_LAYOUT_SEG,      LUMEN_CMD_QUERY_LAYOUT,    LUMEN_CMD_SCENE_PART,
        LUMEN_CMD_SCENE_STEP,      LUMEN_CMD_SCENE_NAME,      LUMEN_CMD_ACTIVATE_SCENE,
        LUMEN_CMD_QUERY_SCENE,
    };
    for (size_t i = 0; i < sizeof(implemented); ++i) {
        CHECK(lumen_command_is_known(implemented[i]));
        lumen_frame_t f = {0};
        f.command = implemented[i];
        f.payload_len = 0;
        lumen_command_dispatch(&f, &state, NULL, 255, &outcome);
        /* 以上全是定宽命令（1/2/3/5/6/24/26/28 字节），空载荷一律 BadLength。 */
        CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
        CHECK(!outcome.state_changed);
        CHECK(!outcome.layout_op);
        CHECK(!outcome.scene_op);
        CHECK(!outcome.strip_power_op);
        CHECK(!outcome.cancels_selftest);
    }

    /* v5 的三条无载荷查询/自检：空载荷合法。 */
    const uint8_t zero_len[] = {LUMEN_CMD_QUERY_STATE, LUMEN_CMD_SELF_TEST,
                                LUMEN_CMD_QUERY_STRIP_CONFIG, LUMEN_CMD_QUERY_DEVICE_INFO,
                                LUMEN_CMD_LAYOUT_COMMIT};
    for (size_t i = 0; i < sizeof(zero_len); ++i) {
        CHECK(lumen_command_is_known(zero_len[i]));
        CHECK(lumen_command_payload_len(zero_len[i]) == 0);
    }

    /* 两条灯组查询：回 0x00 + 报告意图，不改状态、不取消自检。 */
    const uint8_t queries[] = {LUMEN_CMD_QUERY_STRIP_CONFIG, LUMEN_CMD_QUERY_DEVICE_INFO};
    for (size_t i = 0; i < sizeof(queries); ++i) {
        lumen_frame_t f = {0};
        f.command = queries[i];
        f.payload_len = 0;
        lumen_command_dispatch(&f, &state, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.strip_config_query == (queries[i] == LUMEN_CMD_QUERY_STRIP_CONFIG));
        CHECK(outcome.device_info_query == (queries[i] == LUMEN_CMD_QUERY_DEVICE_INFO));
        CHECK(!outcome.cancels_selftest);
        /* 有载荷反而不合法（固定 0）。 */
        f.payload_len = 1;
        f.payload[0] = 0;
        lumen_command_dispatch(&f, &state, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    }

    /*
     * 保留字与设备→小程序方向仍回 0x02。0x1F 是布局族之前的空洞；
     * 0x2A-0x7F 是保留区；0x83-0x86 是 v5 已删除的报告；0xFF 是哨兵。
     */
    const uint8_t reserved[] = {0x00, 0x1F, 0x2A, 0x7F, 0x80, 0x83, 0x84, 0x85, 0x86, 0xFF};
    for (size_t i = 0; i < sizeof(reserved); ++i) {
        CHECK(!lumen_command_is_known(reserved[i]));
        lumen_frame_t f = {0};
        f.command = reserved[i];
        f.payload_len = 0;
        lumen_command_dispatch(&f, &state, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
        CHECK(!outcome.cancels_selftest);
    }

    /* 设备→小程序方向的新报告也必须回 0x02（小程序永不写这些码）。 */
    const uint8_t reports[] = {LUMEN_CMD_LAYOUT_REPORT, LUMEN_CMD_LAYOUT_LIST_END,
                               LUMEN_CMD_SCENE_PART_REPORT, LUMEN_CMD_SCENE_STEP_REPORT,
                               LUMEN_CMD_SCENE_LIST_END};
    for (size_t i = 0; i < sizeof(reports); ++i) {
        CHECK(!lumen_command_is_known(reports[i]));
        CHECK(!lumen_command_changes_state(reports[i]));
    }
}

static void test_encode_ack_all_results(void)
{
    /* ACK 编码器覆盖全部结果码：载荷 [命令字, 结果码]，seq 回显。 */
    for (uint8_t result = 0; result <= LUMEN_RESULT_INTERNAL_ERROR; ++result) {
        uint8_t out[LUMEN_MAX_FRAME];
        size_t len =
            lumen_protocol_encode_ack(0x5A, LUMEN_CMD_SET_POWER, result, out, sizeof(out));
        /* v3：header 6 + 2 字节载荷 + crc 2 = 10。 */
        CHECK(len == 10);
        CHECK(out[0] == LUMEN_MAGIC);
        CHECK(out[1] == LUMEN_VERSION);
        CHECK(out[2] == LUMEN_CMD_ACK);
        CHECK(out[3] == 0x5A);
        CHECK(out[4] == 2);
        CHECK(out[5] == 0);
        CHECK(out[6] == LUMEN_CMD_SET_POWER);
        CHECK(out[7] == result);
        uint16_t crc = lumen_protocol_crc16(out, 8);
        CHECK(out[8] == (uint8_t)(crc & 0xFF));
        CHECK(out[9] == (uint8_t)(crc >> 8));
    }

    /* 缓冲不足必须失败，不能截断：CRC 在 out[8]，所以 cap 9 也不够。 */
    uint8_t out[LUMEN_MAX_FRAME];
    CHECK(lumen_protocol_encode_ack(0x03, 0x02, LUMEN_RESULT_OK, out, 9) == 0);
    CHECK(lumen_protocol_encode_ack(0x03, 0x02, LUMEN_RESULT_OK, out, 10) == 10);
}

static void test_encode_event_storage_failed(void)
{
    /* §10.3：NVS 写失败用 Event 0x81 上报，载荷 [0x01, 原命令字]，seq 固定 0。 */
    uint8_t out[LUMEN_MAX_FRAME];
    size_t len =
        lumen_protocol_encode_event(LUMEN_EVENT_STORAGE_FAILED, 0x06, out, sizeof(out));
    CHECK(len == 10);
    CHECK(len == 2 + LUMEN_FRAME_OVERHEAD);
    CHECK(out[0] == LUMEN_MAGIC);
    CHECK(out[1] == LUMEN_VERSION);
    CHECK(out[2] == 0x81);
    CHECK(out[3] == 0x00);
    CHECK(out[4] == 2);
    CHECK(out[5] == 0);
    CHECK(out[6] == LUMEN_EVENT_STORAGE_FAILED);
    CHECK(out[7] == 0x06);
    CHECK_BYTES(out, "A605810002000106A461", len);

    /* seq 不随连接序号变化：换 detail 也应始终是 0x00。 */
    len = lumen_protocol_encode_event(LUMEN_EVENT_STORAGE_FAILED, 0x01, out, sizeof(out));
    CHECK(len == 10);
    CHECK(out[3] == 0x00);
    CHECK(out[7] == 0x01);

    /*
     * 每个可能触发持久化的命令字都能编出来，detail 原样透传，
     * 且编出来的帧能用同一信封解回（两端共用一份契约）。
     */
    const uint8_t commands[] = {LUMEN_CMD_SET_POWER, LUMEN_CMD_SET_BRIGHTNESS,
                                LUMEN_CMD_SET_LED_COUNT};
    for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); ++i) {
        uint8_t frame[LUMEN_MAX_FRAME];
        size_t n = lumen_protocol_encode_event(LUMEN_EVENT_STORAGE_FAILED, commands[i], frame,
                                               sizeof(frame));
        CHECK(n == 10);
        CHECK(frame[3] == 0x00); /* seq 固定 0 */
        CHECK(frame[6] == LUMEN_EVENT_STORAGE_FAILED);
        CHECK(frame[7] == commands[i]);

        lumen_frame_t decoded;
        uint8_t rc = 0xFF;
        CHECK(lumen_protocol_decode(frame, n, &decoded, &rc) == LUMEN_DECODE_OK);
        CHECK(decoded.command == LUMEN_CMD_EVENT);
        CHECK(decoded.seq == 0x00);
        CHECK(decoded.payload_len == 2);
        CHECK(decoded.payload[0] == LUMEN_EVENT_STORAGE_FAILED);
        CHECK(decoded.payload[1] == commands[i]);
    }

    /* 缓冲不足必须失败，不能截断。 */
    CHECK(lumen_protocol_encode_event(LUMEN_EVENT_STORAGE_FAILED, LUMEN_CMD_SET_LED_COUNT, out,
                                      9) == 0);
}

static void test_encode_limits(void)
{
    /* v3：载荷上限 232、整帧 240、header+crc 8 字节。 */
    uint8_t payload[LUMEN_MAX_PAYLOAD + 1];
    memset(payload, 0, sizeof(payload));
    uint8_t out[LUMEN_MAX_FRAME + 8];

    CHECK(lumen_protocol_encode(0x08, 0x01, payload, LUMEN_MAX_PAYLOAD + 1, out,
                                sizeof(out)) == 0);
    CHECK(lumen_protocol_encode(0x08, 0x01, payload, LUMEN_MAX_PAYLOAD, out,
                                LUMEN_MAX_FRAME - 1) == 0);
    CHECK(lumen_protocol_encode(0x08, 0x01, payload, LUMEN_MAX_PAYLOAD, out, LUMEN_MAX_FRAME) ==
          LUMEN_MAX_FRAME);
    /* 0 长度载荷允许 NULL。 */
    CHECK(lumen_protocol_encode(0x08, 0x01, NULL, 0, out, sizeof(out)) == LUMEN_FRAME_OVERHEAD);
    /* 非 0 长度载荷必须是有效指针。 */
    CHECK(lumen_protocol_encode(0x08, 0x01, NULL, 1, out, sizeof(out)) == 0);
}

static void test_decode_short(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;

    /* 不足 8 字节（header 6 + crc 2）：连 crc 都放不下，静默丢弃。 */
    CHECK(decode_hex("A6030101", &frame, &rc) == LUMEN_DECODE_SILENT);
    CHECK(decode_hex("A603010101", &frame, &rc) == LUMEN_DECODE_SILENT);
    CHECK(decode_hex("", &frame, &rc) == LUMEN_DECODE_SILENT);
    CHECK(lumen_protocol_decode(NULL, 0, &frame, &rc) == LUMEN_DECODE_SILENT);
}

static void test_decode_bad_frames_echo_header(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;

    /* 坏帧也要保留 header，供 ACK 回显 seq / 命令字。 */
    CHECK(decode_hex("A50301010100010000", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_MAGIC);
    CHECK(frame.command == 0x01);
    CHECK(frame.seq == 0x01);

    /* version 0x02（v2）现在是不支持的版本 → 0x07。 */
    CHECK(decode_hex("A60201010100010000", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_UNSUPPORTED_VERSION);

    /* CRC 错：用 §3.3 的合法帧把 CRC 高字节改掉。 */
    CHECK(decode_hex("A60501010100011169", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_CHECKSUM);

    /* 长度字段 > 232 → 越界，BadLength（不读 payload）。 */
    CHECK(decode_hex("A6050101E900000000", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_LENGTH);
}

static void test_decode_max_payload(void)
{
    /* 232 字节载荷的合法帧：编出来再解回去，字段逐字节一致。 */
    uint8_t payload[LUMEN_MAX_PAYLOAD];
    for (size_t i = 0; i < sizeof(payload); ++i) {
        payload[i] = (uint8_t)i;
    }
    uint8_t frame_bytes[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode(0x7F, 0x05, payload, sizeof(payload), frame_bytes,
                                       sizeof(frame_bytes));
    CHECK(len == LUMEN_MAX_FRAME);

    lumen_frame_t frame;
    uint8_t rc = 0xFF;
    CHECK(lumen_protocol_decode(frame_bytes, len, &frame, &rc) == LUMEN_DECODE_OK);
    CHECK(rc == LUMEN_RESULT_OK);
    CHECK(frame.command == 0x7F);
    CHECK(frame.seq == 0x05);
    CHECK(frame.payload_len == LUMEN_MAX_PAYLOAD);
    CHECK(memcmp(frame.payload, payload, sizeof(payload)) == 0);

    /* 声明 232 但实际只有 231 字节（丢掉最后一个 payload 字节）→ BadLength。 */
    uint8_t truncated[LUMEN_MAX_FRAME];
    memcpy(truncated, frame_bytes, LUMEN_HEADER_LEN + 231);
    uint16_t crc = lumen_protocol_crc16(truncated, LUMEN_HEADER_LEN + 231);
    truncated[LUMEN_HEADER_LEN + 231] = (uint8_t)(crc & 0xFF);
    truncated[LUMEN_HEADER_LEN + 232] = (uint8_t)(crc >> 8);
    CHECK(lumen_protocol_decode(truncated, LUMEN_MAX_FRAME - 1, &frame, &rc) ==
          LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_LENGTH);
}

static void test_state_defaults_and_clamp(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);

    /* docs/protocol-v5.md §10.6：关灯、亮度 128、每带开关全开、
     * 只有 strip 0 有灯珠数、active_scene 0、没有已提交布局。 */
    CHECK(state.power == 0);
    CHECK(state.brightness == 128);
    CHECK(state.strip_count == 1);
    CHECK(state.strip_power_mask == 0xFF);
    CHECK(state.active_scene == 0);
    CHECK(state.layout_valid == 0);
    CHECK(state.led_count[0] == 30);
    for (uint8_t i = 1; i < LUMEN_MAX_STRIPS; ++i) {
        CHECK(state.led_count[i] == 0);
    }
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        CHECK(state.part_count[i] == 0);
    }

    CHECK(lumen_state_clamp_brightness(200, 180) == 180);
    CHECK(lumen_state_clamp_brightness(100, 180) == 100);
    CHECK(lumen_state_clamp_brightness(255, 255) == 255);
    CHECK(lumen_state_clamp_brightness(0, 255) == 0);
}

static void test_state_bytes_layout(void)
{
    lumen_state_t state;

    /*
     * 参考向量 state_read_example_hex（docs/protocol-testvectors-v5.json）：
     * 开灯 / 亮度 128 / max_b 200 / 2 条灯带 30+60 / pmask 0x03 /
     * active_scene 0 / layout_valid 1 / part_count {0,1,2,…}。
     *
     * 这条断言是「§7.3 的 32 字节布局」的逐字节证据：字段顺序或偏移改了，
     * 它会立刻红。
     */
    CHECK(LUMEN_STATE_BYTES == 32);
    lumen_state_defaults(&state, 30);
    state.power = 1;
    state.brightness = 128;
    state.strip_count = 2;
    state.strip_power_mask = 0x03;
    state.active_scene = 0;
    state.layout_valid = 1;
    state.led_count[0] = 30;
    state.led_count[1] = 60;
    state.part_count[0] = 0;
    state.part_count[1] = 1;
    state.part_count[2] = 2;

    uint8_t out[LUMEN_STATE_BYTES];
    lumen_state_to_bytes(&state, 200, out);
    CHECK_BYTES(out,
                "0180C802030001001E003C000000000000000000000000000001020000000000",
                sizeof(out));

    /* 逐字段核对 §7.3 的偏移。 */
    CHECK(out[0] == 0x01); /* power */
    CHECK(out[1] == 128);  /* brightness */
    CHECK(out[2] == 200);  /* max_brightness */
    CHECK(out[3] == 2);    /* strip_count */
    CHECK(out[4] == 0x03); /* strip_power_mask */
    CHECK(out[5] == 0);    /* active_scene */
    CHECK(out[6] == 1);    /* layout_valid */
    CHECK(out[7] == 0);    /* reserved */
    CHECK(out[8] == 30 && out[9] == 0);   /* led_count[0] 小端 */
    CHECK(out[10] == 60 && out[11] == 0); /* led_count[1] 小端 */
    CHECK(out[24] == 0 && out[25] == 1 && out[26] == 2); /* part_count[0..2] */

    /* 亮度按 max_brightness 钳位后再写，State 里的原值不动。 */
    state.brightness = 250;
    lumen_state_to_bytes(&state, 200, out);
    CHECK(out[1] == 200);
    CHECK(state.brightness == 250);
    state.brightness = 128;

    /* layout_valid 只有 0/1，其它非零一律编码成 1。 */
    state.layout_valid = 0x7F;
    lumen_state_to_bytes(&state, 200, out);
    CHECK(out[6] == 1);
    state.layout_valid = 1;

    /* 灯珠数 u16 小端。 */
    state.led_count[0] = 300;
    lumen_state_to_bytes(&state, 255, out);
    CHECK(out[8] == 0x2C);
    CHECK(out[9] == 0x01);
    state.led_count[0] = 30;

    /* NULL 防御。 */
    lumen_state_to_bytes(NULL, 255, out);
    lumen_state_to_bytes(&state, 255, NULL);
}

/*
 * 自检序列（协议 §11.2）：红 → 绿 → 蓝 → 白，每色 500ms，共 2s。
 * 纯函数 + 注入时间，不依赖 FreeRTOS 与硬件。
 */
static void test_selftest_sequence(void)
{
    lumen_selftest_t st;
    uint8_t rgb[3] = {0xEE, 0xEE, 0xEE};
    const int64_t t0 = 1000000;

    lumen_selftest_reset(&st);
    CHECK(!lumen_selftest_active(&st));
    CHECK(lumen_selftest_next_step_in_us(&st, t0) == -1);
    CHECK(!lumen_selftest_color(&st, rgb)); /* 未激活时不写 out */
    CHECK(rgb[0] == 0xEE);

    lumen_selftest_start(&st, t0);
    CHECK(lumen_selftest_active(&st));
    CHECK(lumen_selftest_step(&st) == 0);
    CHECK(lumen_selftest_next_step_in_us(&st, t0) == LUMEN_SELFTEST_STEP_US);

    /* 第 1 色：红，0 ≤ t < 500ms */
    CHECK(lumen_selftest_advance(&st, t0));
    CHECK(lumen_selftest_color(&st, rgb));
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);
    CHECK(strcmp(lumen_selftest_step_name(lumen_selftest_step(&st)), "red") == 0);

    CHECK(lumen_selftest_advance(&st, t0 + 499999));
    CHECK(lumen_selftest_step(&st) == 0);
    CHECK(lumen_selftest_next_step_in_us(&st, t0 + 499999) == 1);

    /* 第 2 色：绿，500ms ≤ t < 1000ms */
    CHECK(lumen_selftest_advance(&st, t0 + 500000));
    CHECK(lumen_selftest_color(&st, rgb));
    CHECK(rgb[0] == 0 && rgb[1] == 255 && rgb[2] == 0);
    CHECK(lumen_selftest_next_step_in_us(&st, t0 + 500000) == LUMEN_SELFTEST_STEP_US);

    /* 第 3 色：蓝 */
    CHECK(lumen_selftest_advance(&st, t0 + 1000000));
    CHECK(lumen_selftest_color(&st, rgb));
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 255);

    /* 第 4 色：白 */
    CHECK(lumen_selftest_advance(&st, t0 + 1500000));
    CHECK(lumen_selftest_color(&st, rgb));
    CHECK(rgb[0] == 255 && rgb[1] == 255 && rgb[2] == 255);

    /* 2s 之前仍停在白 */
    CHECK(lumen_selftest_advance(&st, t0 + 1999999));
    CHECK(lumen_selftest_step(&st) == 3);

    /* 2s 整：序列自动结束，颜色不再覆盖 */
    CHECK(!lumen_selftest_advance(&st, t0 + 2000000));
    CHECK(!lumen_selftest_active(&st));
    CHECK(!lumen_selftest_color(&st, rgb));
    CHECK(lumen_selftest_next_step_in_us(&st, t0 + 2000000) == -1);
}

/* 渲染任务被延迟唤醒时按墙钟推进，不补播错过的颜色。 */
static void test_selftest_late_wake(void)
{
    lumen_selftest_t st;
    uint8_t rgb[3];
    lumen_selftest_start(&st, 0);

    /* 一次醒来已过 1.6s：直接是第 4 色（白），前面三色不补播。 */
    CHECK(lumen_selftest_advance(&st, 1600000));
    CHECK(lumen_selftest_color(&st, rgb));
    CHECK(rgb[0] == 255 && rgb[1] == 255 && rgb[2] == 255);

    /* 再晚 1s：超过 2s，直接结束。 */
    CHECK(!lumen_selftest_advance(&st, 2600000));
    CHECK(!lumen_selftest_active(&st));
}

/* 重复收到自检命令：重新从红色开始并重新计时（§11.2 第 7 条）。 */
static void test_selftest_restart(void)
{
    lumen_selftest_t st;
    uint8_t rgb[3];

    lumen_selftest_start(&st, 1000);
    CHECK(lumen_selftest_advance(&st, 1000 + 1200000));
    CHECK(lumen_selftest_step(&st) == 2); /* 蓝 */

    lumen_selftest_start(&st, 1000 + 1300000);
    CHECK(lumen_selftest_step(&st) == 0);
    CHECK(lumen_selftest_next_step_in_us(&st, 1000 + 1300000) == LUMEN_SELFTEST_STEP_US);

    /* 旧起点已经远超 2s，但重启后按新起点计算，仍是红色。 */
    CHECK(lumen_selftest_advance(&st, 1000 + 1300000 + 1000));
    CHECK(lumen_selftest_color(&st, rgb));
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);

    CHECK(lumen_selftest_advance(&st, 1000 + 1300000 + 500000));
    CHECK(lumen_selftest_color(&st, rgb));
    CHECK(rgb[1] == 255);
}

/* 改状态命令立即取消自检；QueryState 不取消；非法命令不取消。 */
static void test_selftest_cancel_rules(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 1;
    state.brightness = 128;
    state.active_scene = 1;

    lumen_command_outcome_t outcome;
    lumen_frame_t frame = {0};

    /* v2 的三类改变状态命令（0x03 / 0x04 已退役，不算）。 */
    const uint8_t changing[] = {LUMEN_CMD_SET_POWER, LUMEN_CMD_SET_BRIGHTNESS,
                                LUMEN_CMD_SET_LED_COUNT};
    const uint8_t not_changing[] = {LUMEN_CMD_SET_COLOR, LUMEN_CMD_SET_ALL};
    for (size_t i = 0; i < sizeof(not_changing); ++i) {
        CHECK(!lumen_command_changes_state(not_changing[i]));
    }
    for (size_t i = 0; i < sizeof(changing); ++i) {
        CHECK(lumen_command_changes_state(changing[i]));
    }
    CHECK(!lumen_command_changes_state(LUMEN_CMD_QUERY_STATE));
    CHECK(!lumen_command_changes_state(LUMEN_CMD_SELF_TEST));
    CHECK(!lumen_command_changes_state(0x08));

    /* 值没变化（state_changed=false）的 SetPower 仍要取消自检（第 5 条）。 */
    frame.command = LUMEN_CMD_SET_POWER;
    frame.payload_len = 1;
    frame.payload[0] = 1;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.cancels_selftest);
    CHECK(!outcome.start_selftest);

    /* SetBrightness 同样取消（这里用当前值）。 */
    frame.command = LUMEN_CMD_SET_BRIGHTNESS;
    frame.payload_len = 1;
    frame.payload[0] = state.brightness;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.cancels_selftest);

    /*
     * v2 退役的 0x03 / 0x04 不再属于「改变状态」类别，因此即使载荷合法
     * 也不取消自检（命令根本没生效）。
     */
    frame.command = LUMEN_CMD_SET_COLOR;
    frame.payload_len = 3;
    frame.payload[0] = 255;
    frame.payload[1] = 180;
    frame.payload[2] = 120;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
    CHECK(!outcome.state_changed);
    CHECK(!outcome.cancels_selftest);

    frame.command = LUMEN_CMD_SET_ALL;
    frame.payload_len = 5;
    frame.payload[0] = state.power;
    frame.payload[1] = state.brightness;
    frame.payload[2] = 255;
    frame.payload[3] = 180;
    frame.payload[4] = 120;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
    CHECK(!outcome.state_changed);
    CHECK(!outcome.cancels_selftest);

    /* #12 接入点：SetLedCount 属改变状态类别；合入后回 0x00 即自动取消。 */
    frame.command = LUMEN_CMD_SET_LED_COUNT;
    frame.payload_len = 2;
    frame.payload[0] = 30;
    frame.payload[1] = 0;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(lumen_command_changes_state(frame.command));

    /* QueryState：明确不取消自检（§11.2 第 6 条）。 */
    frame.command = LUMEN_CMD_QUERY_STATE;
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(!outcome.cancels_selftest);

    /* 非法取值 / 长度错误 / 未知命令：命令未生效，不取消自检。 */
    frame.command = LUMEN_CMD_SET_POWER;
    frame.payload_len = 1;
    frame.payload[0] = 2;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.cancels_selftest);

    frame.command = LUMEN_CMD_SET_BRIGHTNESS;
    frame.payload_len = 2;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.cancels_selftest);

    frame.command = 0x08;
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
    CHECK(!outcome.cancels_selftest);

    /* 自检命令本身不取消、只启动。 */
    frame.command = LUMEN_CMD_SELF_TEST;
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.start_selftest);
    CHECK(!outcome.cancels_selftest);
    CHECK(!outcome.state_changed);
}

/*
 * 自检期间状态不变：State read 编码出的始终是存储状态，不是自检颜色。
 * 自检开始时是关灯态，存储状态仍为关灯（结束回关灯由渲染层保证）。
 */
static void test_selftest_leaves_state_untouched(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 0;
    state.brightness = 77;
    state.active_scene = 2;

    uint8_t before[LUMEN_STATE_BYTES];
    lumen_state_to_bytes(&state, 255, before);

    /* 自检启动是纯渲染层覆盖：命令结果 next 与 current 完全一致。 */
    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SELF_TEST;
    frame.payload_len = 0;
    lumen_command_outcome_t outcome;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(memcmp(&outcome.next, &state, sizeof(state)) == 0);

    lumen_selftest_t st;
    lumen_selftest_start(&st, 0);
    uint8_t rgb[3];
    CHECK(lumen_selftest_color(&st, rgb));
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0); /* 自检点亮为红 */

    /* 同时刻的 State 仍是关灯 + 原亮度/场景（§9.6 第 6 条）。 */
    uint8_t during[LUMEN_STATE_BYTES];
    lumen_state_to_bytes(&state, 255, during);
    CHECK(memcmp(before, during, sizeof(before)) == 0);
    CHECK(during[0] == 0);              /* power */
    CHECK(during[1] == 77);             /* brightness */
    CHECK(during[5] == 2);              /* active_scene 未被自检改动 */
}

/*
 * 渲染合成规则（§11.2 第 2/3/4 条）：自检激活时用自检色 + max_brightness，
 * 不看存储的 power/brightness；结束后回到存储状态（关灯回关灯）。
 * lumen_selftest_compose() 是 led_engine 里唯一一处这类判断。
 */
static void test_selftest_compose(void)
{
    uint8_t rgb[3] = {0, 0, 0};
    uint8_t brightness = 0;
    const uint8_t stored_rgb[3] = {10, 20, 30};

    /* 1) 未激活：关灯 -> 亮度 0，颜色保留存储值（与 #8 行为一致）。 */
    lumen_selftest_t st;
    lumen_selftest_reset(&st);
    lumen_selftest_compose(&st, 0, 77, stored_rgb, 200, rgb, &brightness);
    CHECK(brightness == 0);
    CHECK(rgb[0] == 10 && rgb[1] == 20 && rgb[2] == 30);

    /* 2) 未激活、开灯：亮度直接用存储值（钳位在调用方做）。 */
    lumen_selftest_compose(&st, 1, 77, stored_rgb, 200, rgb, &brightness);
    CHECK(brightness == 77);
    CHECK(rgb[0] == 10 && rgb[1] == 20 && rgb[2] == 30);

    /* 3) 关灯态启动自检：点亮为红，亮度取 max_brightness（§11.2 第 4 条）。 */
    lumen_selftest_start(&st, 0);
    lumen_selftest_advance(&st, 0);
    lumen_selftest_compose(&st, 0, 77, stored_rgb, 200, rgb, &brightness);
    CHECK(brightness == 200);
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);

    /* 4) 自检期间每一步都是满值颜色 + 同一个 max_brightness，与存储亮度无关。 */
    const uint8_t expected[4][3] = {
        {255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {255, 255, 255}};
    for (int i = 0; i < 4; ++i) {
        lumen_selftest_advance(&st, (int64_t)i * LUMEN_SELFTEST_STEP_US);
        lumen_selftest_compose(&st, 0, 1, stored_rgb, 128, rgb, &brightness);
        CHECK(brightness == 128);
        CHECK(rgb[0] == expected[i][0]);
        CHECK(rgb[1] == expected[i][1]);
        CHECK(rgb[2] == expected[i][2]);
    }

    /* 5) 序列走完：回到存储状态，关灯态回关灯（§11.2 第 3/4 条）。 */
    lumen_selftest_advance(&st, 4 * LUMEN_SELFTEST_STEP_US);
    CHECK(!lumen_selftest_active(&st));
    lumen_selftest_compose(&st, 0, 77, stored_rgb, 200, rgb, &brightness);
    CHECK(brightness == 0);
    CHECK(rgb[0] == 10 && rgb[1] == 20 && rgb[2] == 30);

    /* 6) 取消后同样立刻回存储状态。 */
    lumen_selftest_start(&st, 0);
    lumen_selftest_stop(&st);
    lumen_selftest_compose(&st, 1, 77, stored_rgb, 200, rgb, &brightness);
    CHECK(brightness == 77);
    CHECK(rgb[0] == 10 && rgb[1] == 20 && rgb[2] == 30);

    /* 7) max_brightness = 0 时自检也输出 0 亮度（钳位语义，不特判）。 */
    lumen_selftest_start(&st, 0);
    lumen_selftest_compose(&st, 0, 77, stored_rgb, 0, rgb, &brightness);
    CHECK(brightness == 0);
    CHECK(rgb[0] == 255); /* 颜色仍是自检色，亮度为 0 由 gamma 乘算归零 */

    /* 8) NULL 自检指针按未激活处理，且不写非法指针。 */
    lumen_selftest_compose(NULL, 1, 77, stored_rgb, 200, rgb, &brightness);
    CHECK(brightness == 77);
    CHECK(rgb[0] == 10 && rgb[1] == 20 && rgb[2] == 30);
}

static void test_gamma(void)
{
    lumen_gamma_init();

    CHECK(lumen_gamma_apply(0, 255) == 0);
    CHECK(lumen_gamma_apply(255, 255) == 255);
    CHECK(lumen_gamma_apply(255, 0) == 0);
    CHECK(lumen_gamma_apply(0, 0) == 0);

    /* 亮度乘算线性：255 * 128 / 255 = 128 */
    CHECK(lumen_gamma_apply(255, 128) == 128);

    /*
     * gamma 2.2 混 30% 线性：50% 输入落在 78 附近（纯 gamma 是 56）。
     * 混合是为了保住暗部色相——次要通道在纯 gamma 下会先被量化到 0，
     * 表现为橙色呼吸到暗部变纯红（真机实测）。
     */
    uint8_t mid = lumen_gamma_apply(128, 255);
    CHECK(mid >= 76 && mid <= 80);

    /*
     * 暗部保色回归（#30 真机发现的缺陷）：橙色 (255,128,0) 呼吸到 e=0.10 时，
     * G 通道必须仍然可见（>0）。纯 gamma 2.2 下这里 G 已被压成 0 → 只剩红。
     */
    CHECK(lumen_gamma_apply(26, 200) > 0);  /* R: 255*0.10 */
    CHECK(lumen_gamma_apply(13, 200) > 0);  /* G: 128*0.10，这是关键 */

    uint8_t previous = 0;
    for (int i = 0; i <= 255; ++i) {
        uint8_t value = lumen_gamma_apply((uint8_t)i, 255);
        CHECK(value >= previous);
        previous = value;
    }

    /*
     * v4 合成顺序：**先乘亮度，再 gamma 一次**（lumen_gamma_apply_pixel_scaled）。
     *
     *   out = gamma(round(in × brightness / 255))
     *
     * 与 v3 的「先 gamma 再乘亮度」在 brightness < 255 时数值不同：
     *   in = 128、brightness = 128:
     *     v3: gamma(128) × 128 / 255 = 78 × 128 / 255 ≈ 39
     *     v4: gamma(64)               = 28
     * 这条断言把两套顺序的差异钉死——若有人把 led_render 改回旧顺序，这里会红。
     */
    {
        uint8_t in3[3] = {128, 0, 0};
        uint8_t out3[3] = {0, 0, 0};
        lumen_gamma_apply_pixel_scaled(in3, 128, out3);
        CHECK(out3[0] == lumen_gamma_apply((uint8_t)64, 255)); /* gamma(64) = 28 */
        CHECK(out3[0] == 28);
        CHECK(out3[0] < lumen_gamma_apply(128, 128)); /* 39 —— 旧顺序（v3）更亮 */
    }

    /* brightness = 255 时两套顺序逐字节一致（v4 的兼容锚点）。 */
    for (int i = 0; i <= 255; i += 17) {
        uint8_t full_in[3] = {(uint8_t)i, (uint8_t)i, (uint8_t)i};
        uint8_t a[3];
        uint8_t b[3];
        lumen_gamma_apply_pixel(full_in, 255, a);
        lumen_gamma_apply_pixel_scaled(full_in, 255, b);
        CHECK(memcmp(a, b, 3) == 0);
    }

    /* brightness = 0 → 全黑（两种顺序都是）。 */
    {
        uint8_t any[3] = {255, 128, 0};
        uint8_t out3[3] = {9, 9, 9};
        lumen_gamma_apply_pixel_scaled(any, 0, out3);
        CHECK(out3[0] == 0 && out3[1] == 0 && out3[2] == 0);
    }

    /* 原地调用（in 与 out 同址）安全。 */
    {
        uint8_t inplace[3] = {255, 128, 0};
        lumen_gamma_apply_pixel_scaled(inplace, 200, inplace);
        CHECK(inplace[0] > 0 && inplace[1] > 0);
    }
}

/* ---------------- #12：SetLedCount reducer ---------------- */

/*
 * command 层（0x06）：只做取值校验 + 「需要重建」标记。
 *
 * 关键语义（§11.3）：数量不能在这里写进 next，因为共享状态要等渲染任务重建
 * 句柄成功后才更新；ACK 也必须等重建结果。所以合法取值一律 state_changed=false。
 */
static void test_set_led_count_reducer(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 1;
    state.brightness = 77;
    state.strip_count = 2;
    state.led_count[1] = 45;

    lumen_command_outcome_t outcome;
    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SET_LED_COUNT;
    frame.seq = 10;
    frame.payload_len = 3;

    /* 合法：1、30（与当前相同）、64、100（#72 的新上限）—— 都标记重建，都不动状态。
     * v2 载荷：strip_id(0), count_lo, count_hi。 */
    const uint16_t accepted[] = {1, 30, 64, 100};
    for (size_t i = 0; i < sizeof(accepted) / sizeof(accepted[0]); ++i) {
        frame.payload[0] = 0;
        frame.payload[1] = (uint8_t)(accepted[i] & 0xFF);
        frame.payload[2] = (uint8_t)(accepted[i] >> 8);
        lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.led_count_rebuild);
        CHECK(outcome.led_count == accepted[i]);
        CHECK(!outcome.state_changed);
        /* 开关 / 亮度 / 逐条灯珠数全部原样（数量由引擎在重建成功后提交）。 */
        CHECK(outcome.next.power == state.power);
        CHECK(outcome.next.brightness == state.brightness);
        for (uint8_t t = 0; t < LUMEN_MAX_STRIPS; ++t) {
            CHECK(outcome.next.led_count[t] == state.led_count[t]);
        }
    }

    /* 越界：0 与 101（#72 上限抬到 100，101 是新拒绝边界）→ 0x01，
     * 不请求重建、不改状态（协议 §6）。 */
    const uint16_t rejected[] = {0, 101, 0xFFFF};
    for (size_t i = 0; i < sizeof(rejected) / sizeof(rejected[0]); ++i) {
        frame.payload[0] = 0;
        frame.payload[1] = (uint8_t)(rejected[i] & 0xFF);
        frame.payload[2] = (uint8_t)(rejected[i] >> 8);
        lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
        CHECK(!outcome.led_count_rebuild);
        /* 未请求重建时 outcome->led_count 保留 reducer 的零值（不是 state 的数字）。 */
        CHECK(!outcome.state_changed);
    }

    /* 小端读法：0x0100 = 256 越界；0x4000 = 64 合法（已在上面的 accepted 里）。 */
    frame.payload[0] = 0x00;
    frame.payload[1] = 0x00;
    frame.payload[2] = 0x01;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.led_count_rebuild);

    /* strip_id 落在已配置范围内（state.strip_count = 2）→ 合法，登记重建。 */
    frame.payload[0] = 1;
    frame.payload[1] = 0x1E;
    frame.payload[2] = 0x00;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.led_count_rebuild);
    CHECK(outcome.led_count == 30);
    CHECK(outcome.led_count_strip == 1);
    /* 未配置的链（>= strip_count）→ 0x01。 */
    frame.payload[0] = 0xFF;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.led_count_rebuild);

    /* strip 0 + 64 仍是合法。 */
    frame.payload[0] = 0;
    frame.payload[1] = 0x40;
    frame.payload[2] = 0x00;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.led_count_rebuild);
    CHECK(outcome.led_count == 64);

    /* strip 0 + 100（#72 的新上限）也合法，线上仍是 3 字节载荷。 */
    frame.payload[0] = 0;
    frame.payload[1] = 0x64;
    frame.payload[2] = 0x00;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.led_count_rebuild);
    CHECK(outcome.led_count == 100);
    CHECK(!outcome.state_changed);

    /* strip 0 + 101 → 0x01：新上限之外的第一颗。 */
    frame.payload[0] = 0;
    frame.payload[1] = 0x65;
    frame.payload[2] = 0x00;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.led_count_rebuild);

    /* 载荷长度 2（v1 形状）/ 1 / 4 → 0x04，不请求重建。 */
    frame.payload_len = 2;
    frame.payload[0] = 0x1E;
    frame.payload[1] = 0x00;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.led_count_rebuild);

    frame.payload_len = 1;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.led_count_rebuild);

    frame.payload_len = 4;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.led_count_rebuild);

    /* payload_len 正确的 0 长度帧同样 0x04。 */
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.led_count_rebuild);

    /* 命令表：0x06 已知且载荷 3 字节（v2 加了 strip_id）。 */
    CHECK(lumen_command_is_known(LUMEN_CMD_SET_LED_COUNT));
    CHECK(lumen_command_payload_len(LUMEN_CMD_SET_LED_COUNT) == 3);
}

/* ---------------- #12：led_count_job 重建状态机 ---------------- */

static void test_led_count_job(void)
{
    lumen_led_count_job_t job;
    lumen_led_count_job_init(&job);

    CHECK(!lumen_led_count_job_busy(&job));
    CHECK(lumen_led_count_job_target(&job) == 0);
    CHECK(lumen_led_count_job_strip(&job) == 0);

    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 1;
    state.brightness = 99;
    state.active_scene = 2;
    state.strip_count = 4;
    state.led_count[0] = 30;
    state.led_count[1] = 40;

    /* 1. 请求 → 排队 → Busy（未 begin 时第二个请求也要被判忙，§11.3「不排队」）。 */
    CHECK(lumen_led_count_job_request(&job, 0, 60, 30, 0x21) == LUMEN_LED_COUNT_ACCEPTED);
    CHECK(lumen_led_count_job_busy(&job));
    CHECK(lumen_led_count_job_target(&job) == 60);
    CHECK(lumen_led_count_job_strip(&job) == 0);
    CHECK(lumen_led_count_job_request(&job, 0, 45, 30, 0x22) == LUMEN_LED_COUNT_BUSY);
    /* 被拒的请求不能污染目标值 / seq / strip。 */
    CHECK(lumen_led_count_job_target(&job) == 60);
    CHECK(lumen_led_count_job_strip(&job) == 0);

    /* 2. begin：pending → running，取出 target / strip / seq。 */
    uint16_t target = 0;
    uint8_t seq = 0;
    CHECK(lumen_led_count_job_begin(&job, &target, &seq));
    CHECK(target == 60);
    CHECK(seq == 0x21);
    CHECK(lumen_led_count_job_strip(&job) == 0);
    CHECK(lumen_led_count_job_busy(&job));
    /* 没有 pending 时不能再次 begin。 */
    CHECK(!lumen_led_count_job_begin(&job, NULL, NULL));
    /* 重建进行中（running）同样判忙。 */
    CHECK(lumen_led_count_job_request(&job, 0, 60, 30, 0x23) == LUMEN_LED_COUNT_BUSY);

    /* 3. complete(true)：只改**那条灯带**的数量，其它字段原样。 */
    CHECK(lumen_led_count_job_complete(&job, true, &state));
    CHECK(state.led_count[0] == 60);
    CHECK(state.led_count[1] == 40); /* 别的条不受影响 */
    CHECK(state.power == 1);
    CHECK(state.brightness == 99);
    CHECK(state.active_scene == 2);
    CHECK(state.strip_count == 4);
    CHECK(!lumen_led_count_job_busy(&job));

    /* 4. 完成后能再次请求；strip 1 的目标落进 led_count[1]。 */
    CHECK(lumen_led_count_job_request(&job, 1, 12, 40, 0x24) == LUMEN_LED_COUNT_ACCEPTED);
    CHECK(lumen_led_count_job_begin(&job, &target, &seq));
    CHECK(target == 12);
    CHECK(seq == 0x24);
    CHECK(lumen_led_count_job_strip(&job) == 1);

    /* 5. complete(false)：状态回滚（旧值不变），状态机释放。 */
    lumen_state_t before = state;
    CHECK(!lumen_led_count_job_complete(&job, false, &state));
    CHECK(!lumen_led_count_job_busy(&job));
    CHECK(state.led_count[0] == before.led_count[0]);
    CHECK(state.led_count[1] == before.led_count[1]);
    CHECK(state.power == before.power);
    CHECK(state.brightness == before.brightness);

    /* 失败后仍可再次请求（不卡死）。 */
    CHECK(lumen_led_count_job_request(&job, 1, 12, 40, 0x25) == LUMEN_LED_COUNT_ACCEPTED);
    CHECK(lumen_led_count_job_begin(&job, &target, &seq));
    CHECK(lumen_led_count_job_complete(&job, true, &state));
    CHECK(state.led_count[1] == 12);
    CHECK(state.led_count[0] == 60); /* strip 0 仍是上一步的值 */

    /* 6. 与当前数量相同 → UNCHANGED（不排队、不重建，调用方直接回 0x00）。 */
    CHECK(lumen_led_count_job_request(&job, 1, 12, 12, 0x26) == LUMEN_LED_COUNT_UNCHANGED);
    CHECK(!lumen_led_count_job_busy(&job));

    /* 7. 判忙优先于判相同：重建中即使请求当前数量也回 Busy。 */
    CHECK(lumen_led_count_job_request(&job, 0, 20, 60, 0x27) == LUMEN_LED_COUNT_ACCEPTED);
    CHECK(lumen_led_count_job_request(&job, 0, 60, 60, 0x28) == LUMEN_LED_COUNT_BUSY);

    /* 8. 越界防御：直接调 request 也不破坏状态机（仍处于 pending）。 */
    CHECK(lumen_led_count_job_request(&job, 0, 0, 60, 0x29) == LUMEN_LED_COUNT_BUSY);
    CHECK(lumen_led_count_job_request(&job, 0, LUMEN_MAX_LEDS + 1, 60, 0x2A) ==
          LUMEN_LED_COUNT_BUSY);
    /* strip 越界同样拒绝（v5 起 lead_count 是逐条数组，越界会写坏内存）。 */
    CHECK(lumen_led_count_job_request(&job, LUMEN_MAX_STRIPS, 20, 60, 0x2B) ==
          LUMEN_LED_COUNT_BUSY);
    CHECK(lumen_led_count_job_target(&job) == 20);
    CHECK(lumen_led_count_job_strip(&job) == 0);

    /* 9. complete 需要 running：pending 状态直接 complete 无效。 */
    CHECK(!lumen_led_count_job_complete(&job, true, &state));
    CHECK(state.led_count[0] == 60);

    /* 10. NULL job 防御。 */
    CHECK(!lumen_led_count_job_busy(NULL));
    CHECK(lumen_led_count_job_target(NULL) == 0);
    CHECK(lumen_led_count_job_strip(NULL) == 0);
    CHECK(lumen_led_count_job_request(NULL, 0, 5, 30, 1) == LUMEN_LED_COUNT_BUSY);
    CHECK(!lumen_led_count_job_begin(NULL, NULL, NULL));
    CHECK(!lumen_led_count_job_complete(NULL, true, &state));
    lumen_led_count_job_init(NULL); /* 不崩即通过 */
}

/* ---------------- #12：save_scheduler 500ms debounce ---------------- */

static lumen_persist_t persist_with(uint16_t leds, uint8_t brightness)
{
    lumen_persist_t s;
    memset(&s, 0, sizeof(s));
    lumen_state_defaults(&s.state, leds);
    s.state.brightness = brightness;
    return s;
}


static void test_save_scheduler(void)
{
    lumen_save_scheduler_t sched;
    lumen_save_scheduler_init(&sched);

    /* 调度器只存指针，不拷贝：blob 必须比 request 活得久。 */
    static uint8_t blob_a[32];
    static uint8_t blob_b[32];
    static uint8_t blob_c[32];
    static uint8_t blob_d[32];
    memset(blob_a, 0xAA, sizeof(blob_a));
    memset(blob_b, 0xBB, sizeof(blob_b));
    memset(blob_c, 0xCC, sizeof(blob_c));
    memset(blob_d, 0xDD, sizeof(blob_d));

    const uint8_t *out_blob = NULL;
    uint32_t out_len = 0;
    uint8_t command = 0;

    /* 1. 初始：五个键都没有待写，earliest_delay 为 UINT32_MAX。 */
    for (unsigned k = 0; k < LUMEN_SAVE_KEY_COUNT; ++k) {
        CHECK(!lumen_save_scheduler_pending(&sched, (lumen_save_key_t)k));
        CHECK(lumen_save_scheduler_next_delay_ms(&sched, (lumen_save_key_t)k, 0) == UINT32_MAX);
    }
    CHECK(lumen_save_scheduler_earliest_delay_ms(&sched, 0) == UINT32_MAX);
    CHECK(!lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_STATE, 0, &out_blob, &out_len,
                                         &command));

    /* 2. 一次请求 → 500ms 后到期；499ms 时还差 1ms。 */
    CHECK(lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_STATE, blob_a, sizeof(blob_a),
                                       LUMEN_CMD_SET_BRIGHTNESS, 1000, LUMEN_SAVE_DEBOUNCE_MS));
    CHECK(lumen_save_scheduler_pending(&sched, LUMEN_SAVE_KEY_STATE));
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, LUMEN_SAVE_KEY_STATE, 1000) ==
          LUMEN_SAVE_DEBOUNCE_MS);
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, LUMEN_SAVE_KEY_STATE, 1499) == 1);
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, LUMEN_SAVE_KEY_STATE, 1500) == 0);
    CHECK(!lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_STATE, 1499, &out_blob, &out_len,
                                         &command));
    CHECK(lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_STATE, 1500, &out_blob, &out_len,
                                        &command));
    CHECK(out_blob == blob_a);
    CHECK(out_len == sizeof(blob_a));
    CHECK(command == LUMEN_CMD_SET_BRIGHTNESS);
    /* 取走之后 pending 清空，再来一次 take 失败。 */
    CHECK(!lumen_save_scheduler_pending(&sched, LUMEN_SAVE_KEY_STATE));
    CHECK(!lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_STATE, 2000, &out_blob, &out_len,
                                         &command));

    /* 3. 连续请求不断推迟，只写最后一次快照。 */
    CHECK(lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_STATE, blob_a, sizeof(blob_a),
                                       LUMEN_CMD_SET_BRIGHTNESS, 0, LUMEN_SAVE_DEBOUNCE_MS));
    CHECK(lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_STATE, blob_b, sizeof(blob_b),
                                       LUMEN_CMD_SET_BRIGHTNESS, 100, LUMEN_SAVE_DEBOUNCE_MS));
    CHECK(lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_STATE, blob_c, sizeof(blob_c),
                                       LUMEN_CMD_SET_POWER, 200, LUMEN_SAVE_DEBOUNCE_MS));
    /* 600ms 时：第一次的 deadline(500) 已过，但最后请求的 deadline 是 700。 */
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, LUMEN_SAVE_KEY_STATE, 600) == 100);
    CHECK(!lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_STATE, 699, &out_blob, &out_len,
                                         &command));
    CHECK(lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_STATE, 700, &out_blob, &out_len,
                                        &command));
    CHECK(out_blob == blob_c); /* 只有最后一份 */
    CHECK(command == LUMEN_CMD_SET_POWER);

    /*
     * 4. **五个键各自独立计时**（v5 的核心：单键单快照装不下 layout + 3 场景）。
     *    layout 的 debounce 是 0（立即落盘），场景是 2000ms。
     */
    CHECK(lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_LAYOUT, blob_d, sizeof(blob_d),
                                       LUMEN_CMD_LAYOUT_COMMIT, 1000, 0));
    CHECK(lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_SCENE0, blob_a, sizeof(blob_a),
                                       LUMEN_CMD_SCENE_STEP, 1000,
                                       LUMEN_SAVE_SCENE_DEBOUNCE_MS));
    CHECK(lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_SCENE2, blob_b, sizeof(blob_b),
                                       LUMEN_CMD_SCENE_NAME, 1000,
                                       LUMEN_SAVE_SCENE_DEBOUNCE_MS));
    /* 同一时刻：layout 已到期（0ms），场景还差 2000。 */
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, LUMEN_SAVE_KEY_LAYOUT, 1000) == 0);
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, LUMEN_SAVE_KEY_SCENE0, 1000) ==
          LUMEN_SAVE_SCENE_DEBOUNCE_MS);
    /* earliest 取最早的：layout 的 0。 */
    CHECK(lumen_save_scheduler_earliest_delay_ms(&sched, 1000) == 0);
    CHECK(lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_LAYOUT, 1000, &out_blob, &out_len,
                                        &command));
    CHECK(out_blob == blob_d);
    CHECK(command == LUMEN_CMD_LAYOUT_COMMIT);
    /* layout 取走后，最早的变成场景的 2000。 */
    CHECK(lumen_save_scheduler_earliest_delay_ms(&sched, 1000) == LUMEN_SAVE_SCENE_DEBOUNCE_MS);
    /* scene1 从来没请求过，不受 scene0/scene2 影响。 */
    CHECK(!lumen_save_scheduler_pending(&sched, LUMEN_SAVE_KEY_SCENE1));
    /* 场景键之间也不互相覆盖。 */
    CHECK(lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_SCENE0, 3000, &out_blob, &out_len,
                                        &command));
    CHECK(out_blob == blob_a);
    CHECK(lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_SCENE2, 3000, &out_blob, &out_len,
                                        &command));
    CHECK(out_blob == blob_b);
    CHECK(!lumen_save_scheduler_pending(&sched, LUMEN_SAVE_KEY_SCENE0));
    CHECK(!lumen_save_scheduler_pending(&sched, LUMEN_SAVE_KEY_SCENE2));

    /* 5. 时钟回绕：deadline 越过 0xFFFFFFFF，仍按差值判定，不卡死。 */
    uint32_t near_wrap = 0xFFFFFF00u;
    CHECK(lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_STATE, blob_d, sizeof(blob_d),
                                       LUMEN_CMD_SET_LED_COUNT, near_wrap,
                                       LUMEN_SAVE_DEBOUNCE_MS));
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, LUMEN_SAVE_KEY_STATE, near_wrap) ==
          LUMEN_SAVE_DEBOUNCE_MS);
    /* 回绕之后：now = 0x0000000A，差值 = 0xF4 - 0x0A = 234。 */
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, LUMEN_SAVE_KEY_STATE, 0x0000000Au) == 234);
    CHECK(!lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_STATE, 0x0000000Au, &out_blob,
                                         &out_len, &command));
    CHECK(lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_STATE, 0x000000F4u, &out_blob,
                                        &out_len, &command));
    CHECK(out_blob == blob_d);
    CHECK(command == LUMEN_CMD_SET_LED_COUNT);

    /* 6. 回绕后立刻请求也正常。 */
    CHECK(lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_STATE, blob_d, sizeof(blob_d),
                                       LUMEN_CMD_SET_POWER, 0xFFFFFFFEu,
                                       LUMEN_SAVE_DEBOUNCE_MS));
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, LUMEN_SAVE_KEY_STATE, 0xFFFFFFFEu) ==
          LUMEN_SAVE_DEBOUNCE_MS);
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, LUMEN_SAVE_KEY_STATE, 0x00000002u) ==
          LUMEN_SAVE_DEBOUNCE_MS - 4);

    /* 7. 非法参数：空指针 / 零长度 / 越界 key 一律失败且不改状态。 */
    lumen_save_scheduler_init(&sched);
    CHECK(!lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_STATE, NULL, 32, 0x01, 0,
                                        LUMEN_SAVE_DEBOUNCE_MS));
    CHECK(!lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_STATE, blob_a, 0, 0x01, 0,
                                        LUMEN_SAVE_DEBOUNCE_MS));
    CHECK(!lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_COUNT, blob_a, 32, 0x01, 0,
                                        LUMEN_SAVE_DEBOUNCE_MS));
    CHECK(!lumen_save_scheduler_request(NULL, LUMEN_SAVE_KEY_STATE, blob_a, 32, 0x01, 0,
                                        LUMEN_SAVE_DEBOUNCE_MS));
    CHECK(!lumen_save_scheduler_pending(&sched, LUMEN_SAVE_KEY_STATE));
    CHECK(lumen_save_scheduler_next_delay_ms(NULL, LUMEN_SAVE_KEY_STATE, 0) == UINT32_MAX);
    CHECK(lumen_save_scheduler_earliest_delay_ms(NULL, 0) == UINT32_MAX);
    CHECK(!lumen_save_scheduler_pending(NULL, LUMEN_SAVE_KEY_STATE));
    CHECK(!lumen_save_scheduler_take_due(NULL, LUMEN_SAVE_KEY_STATE, 0, NULL, NULL, NULL));

    /* 8. out 参数允许为 NULL（只用来清 pending）。 */
    CHECK(lumen_save_scheduler_request(&sched, LUMEN_SAVE_KEY_STATE, blob_a, sizeof(blob_a),
                                       0x02, 0, LUMEN_SAVE_DEBOUNCE_MS));
    CHECK(lumen_save_scheduler_take_due(&sched, LUMEN_SAVE_KEY_STATE, 1000, NULL, NULL, NULL));
    CHECK(!lumen_save_scheduler_pending(&sched, LUMEN_SAVE_KEY_STATE));
}

/* ---------------- #12 / #25：state_blob 编解码（v2 带段表） ---------------- */

static void test_state_blob(void)
{
    /* 1. 往返一致：32 字节 State 原样回来。 */
    lumen_persist_t in;
    memset(&in, 0, sizeof(in));
    in.state.power = 1;
    in.state.brightness = 200;
    in.state.strip_count = 3;
    in.state.strip_power_mask = 0x07;
    in.state.active_scene = 2;
    in.state.led_count[0] = 64;
    in.state.led_count[1] = 30;
    in.state.led_count[2] = 100;

    uint8_t blob[LUMEN_STATE_BLOB_SIZE];
    CHECK(lumen_state_blob_encode(&in, blob) == LUMEN_STATE_BLOB_SIZE);
    /*
     * 显式布局（docs/protocol-v5.md §10.2）：magic 0..3、version 4..5、
     * power 6、brightness 7、strip_count 8、strip_power_mask 9、
     * active_scene 10、reserved 11..15、led_count[8] 16..31。
     */
    CHECK(blob[0] == 'L' && blob[1] == 'M' && blob[2] == 'E' && blob[3] == 'N');
    CHECK(blob[4] == (LUMEN_STATE_BLOB_VERSION & 0xFF));
    CHECK(blob[5] == (LUMEN_STATE_BLOB_VERSION >> 8));
    /* v5 的 blob 版本是 6（v4 的 5 是「状态 + 段表」1440 字节，格式不同）。 */
    CHECK(LUMEN_STATE_BLOB_VERSION == 6);
    CHECK(LUMEN_STATE_BLOB_SIZE == 32);
    CHECK(blob[6] == 1);
    CHECK(blob[7] == 200);
    CHECK(blob[8] == 3);
    CHECK(blob[9] == 0x07);
    CHECK(blob[10] == 2);
    /* 11..15 保留字节必须为 0（§10.2）。 */
    for (uint8_t i = 11; i < 16; ++i) {
        CHECK(blob[i] == 0);
    }
    CHECK(blob[16] == 64 && blob[17] == 0);  /* led_count[0] 小端 */
    CHECK(blob[18] == 30 && blob[19] == 0);  /* led_count[1] */
    CHECK(blob[20] == 100 && blob[21] == 0); /* led_count[2] */

    lumen_persist_t out;
    memset(&out, 0xAA, sizeof(out));
    CHECK(lumen_state_blob_decode(blob, sizeof(blob), &out));
    CHECK(out.state.power == 1);
    CHECK(out.state.brightness == 200);
    CHECK(out.state.strip_count == 3);
    CHECK(out.state.strip_power_mask == 0x07);
    CHECK(out.state.active_scene == 2);
    CHECK(out.state.led_count[0] == 64);
    CHECK(out.state.led_count[1] == 30);
    CHECK(out.state.led_count[2] == 100);
    /* layout_valid 不持久化在 state 键里：它由布局键的加载结果决定（§10.2）。 */
    CHECK(out.state.layout_valid == 0);
    /* 部位数来自布局键，State blob 不含（§10.2）。 */
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        CHECK(out.state.part_count[i] == 0);
    }

    /* 2. 长度错误：短一字节 / 长一字节 / 0 都拒绝。 */
    CHECK(!lumen_state_blob_decode(blob, LUMEN_STATE_BLOB_SIZE - 1, &out));
    CHECK(!lumen_state_blob_decode(blob, LUMEN_STATE_BLOB_SIZE + 1, &out));
    CHECK(!lumen_state_blob_decode(blob, 0, &out));

    /* 3. 坏 magic。 */
    uint8_t bad[LUMEN_STATE_BLOB_SIZE];
    memcpy(bad, blob, sizeof(bad));
    bad[0] = 'X';
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[3] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /*
     * 4. 坏 version：**任何别的版本都整体拒绝**。
     *
     * v4 的 blob（版本 5）是「状态 + 段表」1440 字节，v5 拆成了五个键、State
     * 只剩 32 字节，布局完全不同。绝不能「尽量解析」——错位的字段会写出越界
     * 灯珠数。调用方因此回落到协议默认值（一次干净的重置，不是半套状态），
     * 这也正是「刷机后设备配置回到默认值」的实现来源。
     */
    memcpy(bad, blob, sizeof(bad));
    bad[4] = 0x01;
    bad[5] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[4] = 0x05; /* v4 的版本号：状态 + 段表，1440 字节 —— 必须拒绝 */
    bad[5] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[4] = 0x07; /* 比当前版本更高：同样必须拒绝 */
    bad[5] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* 只有高字节错位的伪版本也拒绝。 */
    memcpy(bad, blob, sizeof(bad));
    bad[5] = 0x01;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /*
     * 4b. 「旧版本存储整体拒绝、不出现半套加载」：断言 out 一个字节都没被动过。
     */
    {
        lumen_persist_t keep;
        memset(&keep, 0, sizeof(keep));
        lumen_state_defaults(&keep.state, 30);
        lumen_persist_t before = keep;

        /* v4 的真实长度（1440）——长度门拒。 */
        CHECK(!lumen_state_blob_decode(blob, 1440, &keep));
        CHECK(memcmp(&keep, &before, sizeof(keep)) == 0);

        /* 长度 32 但版本 = 5（v4 的版本号）——版本门拒。 */
        memcpy(bad, blob, sizeof(bad));
        bad[4] = 0x05;
        bad[5] = 0x00;
        CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &keep));
        CHECK(memcmp(&keep, &before, sizeof(keep)) == 0);
        CHECK(keep.state.power == before.state.power);
        CHECK(keep.state.strip_power_mask == before.state.strip_power_mask);
    }

    /* 5. power > 1。 */
    memcpy(bad, blob, sizeof(bad));
    bad[6] = 2;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[6] = 0xFF;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* 6. strip_count 越界（0 / 9）、active_scene 越界（3）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[8] = 0;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[8] = 9;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[10] = 3;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[10] = 0xFF;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* 7. 保留字节非 0 → 不是本格式，整份拒绝（§10.2）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[11] = 1;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[15] = 1;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* 8. 灯珠数：已配置链必须 1-100；未配置槽位必须为 0。 */
    memcpy(bad, blob, sizeof(bad));
    bad[16] = 0x00;
    bad[17] = 0x00; /* strip 0 = 0（已配置） */
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[16] = 0x65; /* strip 0 = 101 */
    bad[17] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[16] = 0xFF;
    bad[17] = 0xFF;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* strip 3（未配置，strip_count = 3 只覆盖 0-2）写了非 0 灯珠数 → 拒绝。 */
    memcpy(bad, blob, sizeof(bad));
    bad[22] = 10;
    bad[23] = 0;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* 9. 失败时不写 out（调用方保留默认值）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[6] = 9;
    lumen_persist_t untouched;
    memset(&untouched, 0, sizeof(untouched));
    lumen_state_defaults(&untouched.state, 30);
    lumen_persist_t copy = untouched;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &untouched));
    CHECK(memcmp(&untouched, &copy, sizeof(untouched)) == 0);

    /* 10. 边界合法值：power = 0、strip_count = 1、led_count = 1 / 100 都能解出来。 */
    lumen_persist_t edge = persist_with(1, 0);
    edge.state.power = 0;
    CHECK(lumen_state_blob_encode(&edge, blob) == LUMEN_STATE_BLOB_SIZE);
    CHECK(lumen_state_blob_decode(blob, sizeof(blob), &out));
    CHECK(out.state.power == 0);
    CHECK(out.state.brightness == 0);
    CHECK(out.state.led_count[0] == 1);

    lumen_persist_t edge_max = persist_with(100, 255);
    CHECK(lumen_state_blob_encode(&edge_max, blob) == LUMEN_STATE_BLOB_SIZE);
    CHECK(lumen_state_blob_decode(blob, sizeof(blob), &out));
    CHECK(out.state.led_count[0] == 100);
    CHECK(out.state.brightness == 255);

    /* 11. NULL 防御。 */
    CHECK(lumen_state_blob_encode(NULL, blob) == 0);
    CHECK(lumen_state_blob_encode(&in, NULL) == 0);
    CHECK(!lumen_state_blob_decode(NULL, LUMEN_STATE_BLOB_SIZE, &out));
    CHECK(!lumen_state_blob_decode(blob, LUMEN_STATE_BLOB_SIZE, NULL));
}

/* ---------------- #25：effects（静态纯函数） ---------------- */

static void test_effects_static_rgb(void)
{
    uint8_t rgb[3];

    /* 色相扇区映射：0=红、1/3 圈=绿、2/3 圈=蓝；sat=255 时第 3 通道为 255。 */
    lumen_effect_static_rgb(0, 255, rgb);
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);
    lumen_effect_static_rgb(21845, 255, rgb); /* 120° */
    CHECK(rgb[0] == 0 && rgb[1] == 255 && rgb[2] == 0);
    lumen_effect_static_rgb(43690, 255, rgb); /* 240° */
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 255);

    /* sat=0 是纯白，与色相无关。 */
    for (uint32_t hue = 0; hue <= 0xFFFF; hue += 0x1111) {
        lumen_effect_static_rgb((uint16_t)hue, 0, rgb);
        CHECK(rgb[0] == 255 && rgb[1] == 255 && rgb[2] == 255);
    }

    /* 协议默认暖白 255/180/120：用 sat=180、hue 落红色扇区端点近似验证。
     * 这里只断言「各通道单调且不越界」，具体 hue 反解与小程序端一致性由
     * 真机颜色核对（hue 与 RGB 的映射不是协议字节契约）。 */
    for (uint32_t hue = 0; hue < 0x10000; hue += 257) {
        lumen_effect_static_rgb((uint16_t)hue, 200, rgb);
        for (int i = 0; i < 3; ++i) {
            CHECK(rgb[i] <= 255);
        }
        /* 最大通道 = sat + (255 - sat) = 255（V=1）。 */
        CHECK(rgb[0] == 255 || rgb[1] == 255 || rgb[2] == 255);
    }

    /* hue 回绕：0xFFFF 与 0 同一个扇区端点，差不超过一步。 */
    uint8_t last[3];
    lumen_effect_static_rgb(0xFFFF, 255, last);
    CHECK(last[0] == 255 && last[1] == 0 && last[2] == 0); /* 359.99° 仍是纯红 */

    /* NULL 防御。 */
    lumen_effect_static_rgb(0, 255, NULL);
}

static void test_effects_dispatch(void)
{
    /* 类型分类：#74 起七种已知，其余未知。 */
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_STATIC));
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_BREATHING));
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_RAINBOW));
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_COMET));
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_STROBE));
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_HEARTBEAT));
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_OFF));
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_FLICKER));
    CHECK(!lumen_effect_type_known(0x08));
    CHECK(!lumen_effect_type_known(0xFF));

    /* 八种类型的像素实现全部就绪（#25 / #30 / #31 / #74 / #98）。 */
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_STATIC));
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_BREATHING));
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_RAINBOW));
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_COMET));
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_STROBE));
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_HEARTBEAT));
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_OFF));
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_FLICKER));
    CHECK(!lumen_effect_type_implemented(0x08));

    /* 参数块长度（effects-spec §2.8）：所有动画类型都复用 7 字节。 */
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_STATIC) == 3);
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_BREATHING) == 7);
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_RAINBOW) == 7);
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_COMET) == 7);
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_STROBE) == 7);
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_HEARTBEAT) == 7);
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_OFF) == 7);
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_FLICKER) == 7);
    CHECK(lumen_effect_param_len(0x08) == 0);

    /* 静态与熄灭不是动画（熄灭是常量黑，不该逼渲染层逐帧重画）；其余是。 */
    CHECK(!lumen_effect_is_animated(LUMEN_EFFECT_STATIC));
    CHECK(!lumen_effect_is_animated(LUMEN_EFFECT_OFF));
    CHECK(lumen_effect_is_animated(LUMEN_EFFECT_BREATHING));
    CHECK(lumen_effect_is_animated(LUMEN_EFFECT_RAINBOW));
    CHECK(lumen_effect_is_animated(LUMEN_EFFECT_COMET));
    CHECK(lumen_effect_is_animated(LUMEN_EFFECT_STROBE));
    CHECK(lumen_effect_is_animated(LUMEN_EFFECT_HEARTBEAT));
    CHECK(!lumen_effect_is_animated(LUMEN_LAYER_EMPTY));

    lumen_segment_t seg = seg_single(LUMEN_EFFECT_STATIC, 10, 19, 0, 255, 0, 0, 0, 0);
    CHECK(lumen_effect_segment_length(&seg) == 10);
    CHECK(lumen_effect_index_in_segment(&seg, 10) == 0);
    CHECK(lumen_effect_index_in_segment(&seg, 19) == 9);

    lumen_segment_t inactive = seg;
    inactive.active = false;
    CHECK(lumen_effect_segment_length(&inactive) == 0);
    CHECK(lumen_effect_segment_length(NULL) == 0);

    /* 静态像素：段内每颗灯同一颜色，与位置和时刻无关。 */
    uint8_t a[3];
    uint8_t b[3];
    lumen_effect_pixel(&seg, 10, 0, a);
    lumen_effect_pixel(&seg, 19, 999999, b);
    CHECK(a[0] == 255 && a[1] == 0 && a[2] == 0);
    CHECK(memcmp(a, b, 3) == 0);

    /* 越界下标不写像素（合成层不会这样调用，这是防御）。 */
    uint8_t zero[3] = {1, 2, 3};
    lumen_effect_pixel(&seg, 9, 0, zero);
    CHECK(zero[0] == 0 && zero[1] == 0 && zero[2] == 0);

    /* 动画类型与未知类型：未知类型在 #25/#30/#31 都返回黑色（防御，不是降级
     * 路径）。彩虹的像素由 test_effects_rainbow_* 单独断言。 */
    lumen_segment_t unknown = seg;
    unknown.layer[0].type = 0x7F;
    memset(a, 0xEE, sizeof(a));
    lumen_effect_pixel(&unknown, 10, 0, a);
    CHECK(a[0] == 0 && a[1] == 0 && a[2] == 0);

    /* 非活动段 / NULL 段。 */
    memset(a, 0xEE, sizeof(a));
    lumen_effect_pixel(&inactive, 10, 0, a);
    CHECK(a[0] == 0 && a[1] == 0 && a[2] == 0);
    lumen_effect_pixel(NULL, 10, 0, a);
    CHECK(a[0] == 0 && a[1] == 0 && a[2] == 0);
    lumen_effect_pixel(&seg, 10, 0, NULL); /* 不崩即通过 */
}

/* ---------------- #25：segment_store 校验 / 合成 ---------------- */

static lumen_segment_t make_static(uint8_t start, uint8_t end, uint16_t hue, uint8_t sat)
{
    /* 单层静态段：layer1 = 空层、blend = 0（= v2 里「没有第二层」的语义）。 */
    return seg_single(LUMEN_EFFECT_STATIC, start, end, hue, sat, 0, 0, 0, 0);
}




/* ---------------- #30：呼吸包络 / 相位 ---------------- */

static void test_effects_breathing_phase(void)
{
    /* period = 0 是静止：相位恒 0，不论 now / t0。 */
    CHECK(lumen_effect_breathing_phase_q16(0, 0, 0) == 0);
    CHECK(lumen_effect_breathing_phase_q16(0, 12345, 999999) == 0);

    /* 周期起点与半周期。 */
    CHECK(lumen_effect_breathing_phase_q16(1000, 5000, 5000) == 0);
    CHECK(lumen_effect_breathing_phase_q16(1000, 5000, 5500) == 32768);
    /* 一个完整周期后回到 0（phase 由 mod 算出，不累计）。 */
    CHECK(lumen_effect_breathing_phase_q16(1000, 5000, 6000) == 0);
    /* 1/4 周期 = 16384。 */
    CHECK(lumen_effect_breathing_phase_q16(1000, 0, 250) == 16384);

    /*
     * 无符号减法的回绕语义：now < t0（49 天回绕）时得到巨大正数，
     * 先 mod 仍然给出正确相位，不会变成负数/巨值。
     */
    uint32_t late = 0xFFFFFF00u;
    CHECK(lumen_effect_breathing_phase_q16(1000, late, (uint32_t)(late + 250u)) == 16384);

    /*
     * **天花板溢出测试**（effects-spec §6 的已知陷阱）：
     * period_ms = 65535，r 取到最大 65534 时 (uint64_t)r << 16 = 4294836224，
     * 距 2^32 只剩 131072。若用 32 位中间量，这个值虽然还没溢出，但任何
     * 减法/加一偏差都会翻车。断言相位落在 [0, 65536) 且随 r 单调——
     * 也就是「没有回绕成小值」。
     */
    const uint16_t max_period = 65535;
    const uint32_t t0 = 0;
    uint32_t prev = 0;
    /* 稀疏扫全周期（5 个采样点足够看趋势），末尾 40ms 逐毫秒密集扫。 */
    for (uint32_t r = 1; r < max_period; r += 1009u) {
        uint32_t phase = lumen_effect_breathing_phase_q16(max_period, t0, r);
        /* 永远 < 65536（Q16 的一整圈），从不回绕成小值。 */
        CHECK(phase < 65536u);
        /* 单调：r 增大，相位不减（同一周期内）。 */
        CHECK(phase >= prev);
        prev = phase;
    }
    for (uint32_t r = 65495u; r < max_period; ++r) {
        uint32_t phase = lumen_effect_breathing_phase_q16(max_period, t0, r);
        CHECK(phase < 65536u);
        CHECK(phase >= prev);
        /* 危险区：r<<16 已非常接近 2^32，32 位写法会在这里失真。 */
        CHECK(phase >= 65494u);
        prev = phase;
    }
    /* r 的最大合法值（65534，因为 r = elapsed % period 恒 < period）。 */
    CHECK(lumen_effect_breathing_phase_q16(max_period, 0, 65534u) == 65534u);
    /* 65534 在 Q16 里几乎是一整圈，绝不能变成 0 或负数。 */
    CHECK(lumen_effect_breathing_phase_q16(max_period, 0, 65534u) > 65500u);

    /*
     * 无论 t0 多大、now 越过 32 位回绕点，相位都必须等于「真实经过时间 mod period」。
     * 这是 49 天回绕的等价测试。
     */
    uint32_t t0_wrap = 0xFFFFFFFFu;
    uint32_t now_wrap = 0x00000010u; /* 回绕后前进 17ms */
    CHECK(lumen_effect_breathing_phase_q16(1000, t0_wrap, now_wrap) ==
          (uint32_t)(((uint64_t)17u << 16) / 1000u));
}

static void test_effects_breathing_envelope(void)
{
    /* 四种波形：相位 0 都应为最暗（方波亦然，首尾各留 10% 斜坡）。 */
    CHECK(lumen_effect_breathing_envelope_q16(0, LUMEN_WAVE_SINE) == 0);
    CHECK(lumen_effect_breathing_envelope_q16(0, LUMEN_WAVE_TRIANGLE) == 0);
    CHECK(lumen_effect_breathing_envelope_q16(0, LUMEN_WAVE_SAWTOOTH) == 0);
    CHECK(lumen_effect_breathing_envelope_q16(0, LUMEN_WAVE_SQUARE) == 0);

    /* 半周期：正弦/三角为满亮；锯齿为半亮；方波为满亮（高电平）。 */
    CHECK(lumen_effect_breathing_envelope_q16(32768, LUMEN_WAVE_SINE) >= 65534u);
    CHECK(lumen_effect_breathing_envelope_q16(32768, LUMEN_WAVE_TRIANGLE) >= 65534u);
    /* 锯齿 phase 0.5 → 32768 左右。 */
    uint16_t saw_mid = lumen_effect_breathing_envelope_q16(32768, LUMEN_WAVE_SAWTOOTH);
    CHECK(saw_mid >= 32760u && saw_mid <= 32770u);
    CHECK(lumen_effect_breathing_envelope_q16(32768, LUMEN_WAVE_SQUARE) == 65535u);

    /* 正弦在 1/4 与 3/4 周期：对称，约 0.5。
     * 0.5 × (1 - cos(π/2)) = 0.5。查表 64 点误差允许 ±1%。 */
    uint16_t sine_q = lumen_effect_breathing_envelope_q16(16384, LUMEN_WAVE_SINE);
    uint16_t sine_3q = lumen_effect_breathing_envelope_q16(49152, LUMEN_WAVE_SINE);
    CHECK(sine_q >= 32000u && sine_q <= 33500u);
    CHECK(sine_3q >= 32000u && sine_3q <= 33500u);
    /* 对称。 */
    CHECK(sine_q > sine_3q ? (sine_q - sine_3q) < 300u : (sine_3q - sine_q) < 300u);

    /* 正弦端点：p 接近 65535 时回到 0（与起点连续）。 */
    CHECK(lumen_effect_breathing_envelope_q16(65535, LUMEN_WAVE_SINE) < 300u);

    /*
     * 查表插值的下溢回归（本函数曾用 uint32 算 hi-lo）：
     * 表是先升后降的，下降段 hi < lo。取一个**不在表点上**的下降相位
     * （index=33、frac=512 → p = 33*1024 + 512 = 34304），真值约 65100，
     * 必须落在峰值附近，不能是 uint32 下溢后变成的巨值或负值截断。
     */
    uint16_t sine_desc = lumen_effect_breathing_envelope_q16(34304, LUMEN_WAVE_SINE);
    CHECK(sine_desc > 64500u && sine_desc <= 65535u);
    /* 同一区间里 r 越大越暗（单调下降），跨过多个表点验证。 */
    uint16_t prev_sine = 65535u;
    for (uint32_t p = 33792u; p <= 65024u; p += 1024u) {
        uint16_t v = lumen_effect_breathing_envelope_q16(p, LUMEN_WAVE_SINE);
        CHECK(v <= prev_sine);
        prev_sine = v;
    }
    /* 上升段同理：跨表点单调不减，且都在合法范围。 */
    prev_sine = 0;
    for (uint32_t p = 0; p <= 32768u; p += 1024u) {
        uint16_t v = lumen_effect_breathing_envelope_q16(p, LUMEN_WAVE_SINE);
        CHECK(v >= prev_sine);
        CHECK(v <= 65535u);
        prev_sine = v;
    }

    /* 三角：单调上升到中点再下降；p=1/4 为 0.5。 */
    CHECK(lumen_effect_breathing_envelope_q16(16384, LUMEN_WAVE_TRIANGLE) >= 32760u);
    CHECK(lumen_effect_breathing_envelope_q16(16384, LUMEN_WAVE_TRIANGLE) <= 32770u);
    CHECK(lumen_effect_breathing_envelope_q16(49152, LUMEN_WAVE_TRIANGLE) >= 32760u);

    /* 锯齿：线性上升，p 越大越大。 */
    for (uint32_t p = 0; p < 65536u; p += 4096u) {
        uint16_t lo = lumen_effect_breathing_envelope_q16(p, LUMEN_WAVE_SAWTOOTH);
        CHECK(lo == (uint16_t)p || lo == (uint16_t)(p & 0xFFFFu));
    }

    /*
     * 方波的 10% 斜坡（effects-spec §2.2「两端各留 10% 线性斜坡」）：
     * p = 5% 时应约在 0.5（上升沿中段），p = 65% 在下降沿中段也约 0.5，
     * 而 p = 30% / 80% 分别是满亮 / 全黑。
     */
    uint16_t square_up_mid = lumen_effect_breathing_envelope_q16(3277, LUMEN_WAVE_SQUARE);
    CHECK(square_up_mid >= 32000u && square_up_mid <= 33500u);
    uint16_t square_down_mid = lumen_effect_breathing_envelope_q16(36045, LUMEN_WAVE_SQUARE);
    CHECK(square_down_mid >= 32000u && square_down_mid <= 33500u);
    CHECK(lumen_effect_breathing_envelope_q16(19661, LUMEN_WAVE_SQUARE) == 65535u); /* 30% */
    CHECK(lumen_effect_breathing_envelope_q16(52429, LUMEN_WAVE_SQUARE) == 0);      /* 80% */

    /* 未知 waveform 值按正弦处理（不静默变黑）。 */
    CHECK(lumen_effect_breathing_envelope_q16(32768, 9) >= 65534u);
}

static void test_effects_breathing_gain_and_pixel(void)
{
    /*
     * min_level 极值（effects-spec §3.2）：
     *  - min_level = 0：e' 在包络谷底能到 0（全黑），峰值满亮；
     *  - min_level = 255：e' 恒为满亮（几乎不呼吸）；
     *  - 中间值：谷底 = min_level/255，峰值 = 1。
     */
    const uint16_t period = 1000;
    const uint32_t t0 = 0;
    const uint8_t wave = LUMEN_WAVE_SINE;

    /* 谷底在 phase 0（t = t0）。 */
    uint32_t g0 = lumen_effect_breathing_gain_q16(period, 0, wave, t0, 0);
    CHECK(g0 == 0); /* min_level 0 → 全黑 */
    /* 峰值在 phase 0.5（t = 500ms）。 */
    uint32_t gpeak = lumen_effect_breathing_gain_q16(period, 0, wave, t0, 500);
    CHECK(gpeak >= 65534u);

    /* min_level = 255：任何时刻都满亮。 */
    for (uint32_t t = 0; t <= 1000; t += 100) {
        uint32_t g = lumen_effect_breathing_gain_q16(period, 255, wave, t0, t);
        CHECK(g == 65535u);
    }

    /* min_level = 128：谷底约 128/255 ≈ 0.502（Q16 ≈ 32897）。 */
    uint32_t gmin = lumen_effect_breathing_gain_q16(period, 128, wave, t0, 0);
    CHECK(gmin >= 32800u && gmin <= 33000u);
    /* 且仍能呼吸到满亮。 */
    uint32_t gmax = lumen_effect_breathing_gain_q16(period, 128, wave, t0, 500);
    CHECK(gmax >= 65534u);

    /* period = 0：相位恒 0 → 停在谷底（min_level 决定亮度），不随时间变。 */
    uint32_t gp0_a = lumen_effect_breathing_gain_q16(0, 64, wave, 0, 100);
    uint32_t gp0_b = lumen_effect_breathing_gain_q16(0, 64, wave, 0, 900000);
    CHECK(gp0_a == gp0_b);
    CHECK(gp0_a >= 16000u && gp0_a <= 17000u); /* 64/255 ≈ 0.251 × 65535 ≈ 16448 */

    /* 增益缩放：0 增益得 0，满增益原样返回，四舍五入。 */
    CHECK(lumen_effect_apply_gain_q16(255, 0) == 0);
    CHECK(lumen_effect_apply_gain_q16(255, 65535) == 255);
    CHECK(lumen_effect_apply_gain_q16(255, 32768) == 128); /* 127.5 → 128 */
    CHECK(lumen_effect_apply_gain_q16(0, 65535) == 0);

    /*
     * 整颗像素：纯红呼吸，谷底必须能到全黑（ticket 的「min_level = 0 暗到全黑」）。
     */
    lumen_segment_t seg = seg_single(LUMEN_EFFECT_BREATHING, 0, 9, 0, 255, 1000, 0, 0, 0);
    uint8_t rgb[3];
    lumen_effect_pixel(&seg, 5, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    lumen_effect_pixel(&seg, 5, 500, rgb); /* 峰值 */
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);

    /* v4：呼吸 p5 是 0-100 的百分比。谷底 80% × level 100% → 约 0.8×255 ≈ 204。 */
    layer_set_p5(&seg.layer[0], 80);
    lumen_effect_pixel(&seg, 5, 0, rgb);
    CHECK(rgb[0] >= 195 && rgb[0] <= 210);

    /*
     * v4 新语义：谷底 = level × minLevel%。
     * level = 50、p5 = 40 → 谷底 20% → 0.2 × 255 ≈ 51；峰值 = 50% ≈ 128。
     */
    layer_set_p5(&seg.layer[0], 40);
    layer_set_level(&seg.layer[0], 50);
    lumen_effect_pixel(&seg, 5, 0, rgb);
    CHECK(rgb[0] >= 45 && rgb[0] <= 58);
    lumen_effect_pixel(&seg, 5, 500, rgb);
    CHECK(rgb[0] >= 120 && rgb[0] <= 135);
    /* level = 0 → 整层不出光，任何时刻都是黑。 */
    layer_set_level(&seg.layer[0], 0);
    lumen_effect_pixel(&seg, 5, 500, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    /* 恢复满亮，供后续波形测试使用。 */
    layer_set_level(&seg.layer[0], LUMEN_LAYER_LEVEL_MAX);

    /* 波形切换真的改变输出（肉眼可分辨的前提）：锯齿在中点约半亮。 */
    layer_set_p5(&seg.layer[0], 0);
    layer_set_flags(&seg.layer[0], (uint8_t)(LUMEN_WAVE_SAWTOOTH << 1));
    lumen_effect_pixel(&seg, 5, 250, rgb); /* 1/4 周期 */
    CHECK(rgb[0] >= 60 && rgb[0] <= 70);   /* 0.25 × 255 ≈ 64 */

    /* 正弦在 1/4 周期约半亮（与锯齿不同）。 */
    layer_set_flags(&seg.layer[0], (uint8_t)(LUMEN_WAVE_SINE << 1));
    lumen_effect_pixel(&seg, 5, 250, rgb);
    CHECK(rgb[0] >= 120 && rgb[0] <= 135);

    /* 三角在 1/4 周期约半亮；方波在 1/4 周期满亮。 */
    layer_set_flags(&seg.layer[0], (uint8_t)(LUMEN_WAVE_TRIANGLE << 1));
    lumen_effect_pixel(&seg, 5, 250, rgb);
    CHECK(rgb[0] >= 120 && rgb[0] <= 135);
    layer_set_flags(&seg.layer[0], (uint8_t)(LUMEN_WAVE_SQUARE << 1));
    lumen_effect_pixel(&seg, 5, 250, rgb);
    CHECK(rgb[0] == 255);

    /* flag bit0（reverse）不影响呼吸输出（保留位，无实际意义）。 */
    layer_set_flags(&seg.layer[0], (uint8_t)(LUMEN_WAVE_SINE << 1));
    uint8_t rgb_rev[3];
    lumen_effect_pixel(&seg, 5, 125, rgb);
    layer_set_flags(&seg.layer[0], (uint8_t)((LUMEN_WAVE_SINE << 1) | 0x01));
    lumen_effect_pixel(&seg, 5, 125, rgb_rev);
    CHECK(memcmp(rgb, rgb_rev, 3) == 0);

    /*
     * 一段呼吸 + 一段静态共存：合成后静态段不随时间变，呼吸段随时间变。
     * 这是 ticket「一段呼吸 + 一段静态，互不干扰」的 host 证据。
     */
    test_seg_store_t store;
    test_seg_init(&store);
    lumen_segment_t b = seg_single(LUMEN_EFFECT_BREATHING, 0, 9, 0, 255, 1000, 0, 0, 0);
    lumen_segment_t s = make_static(20, 29, 21845, 255); /* 纯绿 */
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &b) == LUMEN_RESULT_OK);
    CHECK(test_seg_set(&store, 0, 1, 1, 64, &s) == LUMEN_RESULT_OK);

    uint8_t t0_buf[64 * 3];
    uint8_t t500_buf[64 * 3];
    CHECK(test_seg_compose(&store, 0, t0_buf, 64, 0) == 64);
    CHECK(test_seg_compose(&store, 0, t500_buf, 64, 500) == 64);
    /* 呼吸段灯珠 0 在 t=0 全黑，在 t=500 满亮。 */
    CHECK(t0_buf[0] == 0 && t0_buf[1] == 0 && t0_buf[2] == 0);
    CHECK(t500_buf[0] == 255 && t500_buf[1] == 0 && t500_buf[2] == 0);
    /* 静态绿段两个时刻完全相同。 */
    CHECK(memcmp(&t0_buf[20 * 3], &t500_buf[20 * 3], 30) == 0);
    CHECK(t0_buf[20 * 3 + 1] == 255);

    /* 未覆盖区（10-19、30-63）仍为 0。 */
    for (uint16_t i = 10; i <= 19; ++i) {
        CHECK(t500_buf[i * 3] == 0 && t500_buf[i * 3 + 1] == 0 && t500_buf[i * 3 + 2] == 0);
    }
    for (uint16_t i = 30; i < 64; ++i) {
        CHECK(t500_buf[i * 3] == 0 && t500_buf[i * 3 + 1] == 0 && t500_buf[i * 3 + 2] == 0);
    }
}

/* ---------------- #31：彩虹 / 流光 ---------------- */

static lumen_segment_t make_animated(uint8_t type, uint8_t start, uint8_t end, uint16_t hue,
                                     uint8_t sat, uint16_t period_ms, uint8_t p5, uint8_t flags,
                                     uint32_t t0_ms)
{
    return seg_single(type, start, end, hue, sat, period_ms, p5, flags, t0_ms);
}

/* 段内某偏移的最大权重下标（流光头部）。tail > 0 时头部唯一性不保证，调用方自行判断。 */
static uint16_t comet_brightest_offset(const lumen_segment_t *seg, uint32_t now_ms)
{
    uint16_t n = lumen_effect_segment_length(seg);
    uint16_t best = 0;
    uint32_t best_gain = 0;
    for (uint16_t off = 0; off < n; ++off) {
        uint32_t gain =
            lumen_effect_comet_gain_q16(seg, (uint16_t)(seg->start + off), now_ms);
        if (gain > best_gain) {
            best_gain = gain;
            best = off;
        }
    }
    return best;
}

static void test_effects_rainbow_hue(void)
{
    /* span = 0：整条同色，色相只随时间走（§3.3 第一条验收点）。 */
    lumen_segment_t flat = make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 1000, 0, 0, 0);
    for (uint16_t i = 0; i < 16; ++i) {
        CHECK(lumen_effect_rainbow_hue(&flat, i, 0) == 0);
        CHECK(lumen_effect_rainbow_hue(&flat, i, 250) == 16384); /* 1/4 周期 */
        CHECK(lumen_effect_rainbow_hue(&flat, i, 500) == 32768); /* 半周期 */
    }
    /* 一个 / 两个完整周期后回到起点（相位由 mod 算出，不累计）。 */
    CHECK(lumen_effect_rainbow_hue(&flat, 3, 1000) == 0);
    CHECK(lumen_effect_rainbow_hue(&flat, 3, 2000) == 0);
    /* 基准 hue 平移整段：40000 + 16384 = 56384，未回绕。 */
    layer_set_hue(&flat.layer[0], 40000);
    CHECK(lumen_effect_rainbow_hue(&flat, 9, 250) == 56384);
    /* 基准 hue 靠近满圈时正确回绕到小值（不是负数/错色）。 */
    layer_set_hue(&flat.layer[0], 60000);
    CHECK(lumen_effect_rainbow_hue(&flat, 9, 500) == (uint16_t)((60000u + 32768u) % 65536u));

    /* span = 255：沿灯带铺满一整圈（N = 16，每颗 65536/16 = 4096）。 */
    lumen_segment_t full = make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 1000, 255, 0, 0);
    for (uint16_t i = 0; i < 16; ++i) {
        CHECK(lumen_effect_rainbow_hue(&full, i, 0) == (uint16_t)(i * 4096u));
        /* 相位平移 1/4 圈：每颗灯 +16384，并正确回绕。 */
        uint16_t expected = (uint16_t)((i * 4096u + 16384u) & 0xFFFFu);
        CHECK(lumen_effect_rainbow_hue(&full, i, 250) == expected);
    }
    /* 一整圈后与起点逐像素相同（相位回绕）。 */
    for (uint16_t i = 0; i < 16; ++i) {
        CHECK(lumen_effect_rainbow_hue(&full, i, 1000) == lumen_effect_rainbow_hue(&full, i, 0));
        CHECK(lumen_effect_rainbow_hue(&full, i, 1001) == lumen_effect_rainbow_hue(&full, i, 1));
    }

    /*
     * 空间项用**段内偏移**而不是整条灯带下标：段 [8-23] 的第 0 颗仍是 hue 0。
     * 用错下标会让第二段的彩虹从半圈开始，跨段出现硬跳变。
     */
    lumen_segment_t offset =
        make_animated(LUMEN_EFFECT_RAINBOW, 8, 23, 0, 255, 1000, 255, 0, 0);
    CHECK(lumen_effect_rainbow_hue(&offset, 8, 0) == 0);
    CHECK(lumen_effect_rainbow_hue(&offset, 9, 0) == 4096);
    CHECK(lumen_effect_rainbow_hue(&offset, 23, 0) == (uint16_t)(15u * 4096u));

    /*
     * 中间 span 连续可调（ticket 第 3 条）：末端色相随 span 单调增长，
     * 不是 0 / 65535 的二值跳变。
     */
    uint16_t prev = 0;
    for (uint32_t span = 0; span <= 255; span += 51) {
        lumen_segment_t s =
            make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 1000, (uint8_t)span, 0, 0);
        CHECK(lumen_effect_rainbow_hue(&s, 0, 0) == 0);
        uint16_t end_hue = lumen_effect_rainbow_hue(&s, 15, 0);
        CHECK(end_hue >= prev);
        prev = end_hue;
    }
    /* span = 127 的末端 = 15/16 × 127/255 × 65536 ≈ 30600（既不是 0 也不是整圈）。 */
    lumen_segment_t half = make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 1000, 127, 0, 0);
    uint16_t half_end = lumen_effect_rainbow_hue(&half, 15, 0);
    CHECK(half_end >= 30500 && half_end <= 30700);
    CHECK(half_end != 0 && half_end != 0xFFFFu);

    /* reverse（flags bit0）：色相沿灯带递减。 */
    lumen_segment_t rev = make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 1000, 255, 0x01, 0);
    CHECK(lumen_effect_rainbow_hue(&rev, 0, 0) == 0);
    CHECK(lumen_effect_rainbow_hue(&rev, 1, 0) == (uint16_t)(65536u - 4096u)); /* 61440 */
    CHECK(lumen_effect_rainbow_hue(&rev, 15, 0) == 4096);
    /* 时间项与方向项可叠加，反向整圈也不出错。 */
    CHECK(lumen_effect_rainbow_hue(&rev, 1, 250) ==
          (uint16_t)((65536u - 4096u + 16384u) & 0xFFFFu));

    /*
     * **色相 32 位溢出（ticket 点名的最高风险项）**
     *
     * 满周期、最坏角：span = 255（空间项可达 65536）、基准 hue = 0xFFFF、
     * 相位拉到周期末端。逐像素与 **64 位参考值** 对齐——只要实现里任何一处
     * 用 32 位中间量并在满圈附近回绕，这里必然失配（错色）。
     *
     * 32 位写法的余量具体有多薄：phase = 65534 时
     *   (uint32_t)phase << 16 = 4,294,836,224（距 2^32 仅 131,072），
     * 再加 hue(65535) 与空间项(64512) 后是 4,294,966,271——距 2^32 只剩 1025。
     * 任何「先把相位再乘一次 65536」的写法（相位已经是 Q16 色相刻度）都会
     * 在这里翻车：4,294,901,760 + 65,535 + 64,512 = 4,295,031,807 > 2^32。
     * 用 64 位累加 + 最后一次性取模就没有这个问题。
     */
    lumen_segment_t corner =
        make_animated(LUMEN_EFFECT_RAINBOW, 0, 63, 0xFFFF, 255, 65535, 255, 0, 0);
    for (uint32_t t = 0; t < 65535u; t += 4093u) {
        uint32_t phase = lumen_effect_breathing_phase_q16(65535, 0, t);
        for (uint16_t i = 0; i < 64; ++i) {
            int64_t ref = (int64_t)0xFFFF + (int64_t)phase +
                          (int64_t)(((uint64_t)i * 255u * 65536u) / (64u * 255u));
            ref %= 65536;
            if (ref < 0) {
                ref += 65536;
            }
            CHECK(lumen_effect_rainbow_hue(&corner, i, t) == (uint16_t)ref);
        }
    }
    /* 周期末端（相位最大）单独密集扫：这里就是 32 位写法失真的地方。 */
    for (uint32_t t = 65000u; t < 65535u; t += 17u) {
        uint32_t phase = lumen_effect_breathing_phase_q16(65535, 0, t);
        for (uint16_t i = 0; i < 64; ++i) {
            int64_t ref = (int64_t)0xFFFF + (int64_t)phase +
                          (int64_t)(((uint64_t)i * 255u * 65536u) / (64u * 255u));
            ref %= 65536;
            if (ref < 0) {
                ref += 65536;
            }
            CHECK(lumen_effect_rainbow_hue(&corner, i, t) == (uint16_t)ref);
        }
    }

    /* 参数防御：非活动段 / NULL / 越界下标返回 0，不崩。 */
    lumen_segment_t off = full;
    off.active = false;
    CHECK(lumen_effect_rainbow_hue(&off, 0, 0) == 0);
    CHECK(lumen_effect_rainbow_hue(NULL, 0, 0) == 0);
    CHECK(lumen_effect_rainbow_hue(&full, 16, 0) == 0);
    CHECK(lumen_effect_rainbow_hue(&full, 0, 0) == 0); /* 边界：段首合法 */

    /*
     * #72：N = 100（新上限）下的最坏角。空间项的 pos_q16 = (99<<16)/100 = 64880，
     * 与 span=255 相乘是 4.25e9——32 位两段式写法只剩 1% 余量，64 位参考值
     * 必须逐像素吻合。这里把「上限抬到 100」的数学本身钉住。
     */
    lumen_segment_t wide =
        make_animated(LUMEN_EFFECT_RAINBOW, 0, 99, 0xFFFF, 255, 65535, 255, 0, 0);
    for (uint16_t i = 0; i < 100; ++i) {
        int64_t ref = (int64_t)0xFFFF +
                      (int64_t)(((uint64_t)i * 255u * 65536u) / (100u * 255u));
        ref %= 65536;
        if (ref < 0) {
            ref += 65536;
        }
        CHECK(lumen_effect_rainbow_hue(&wide, i, 0) == (uint16_t)ref);
    }
    /* 段末端（i = 99）的空间项 = 99/100 × 65536 = 64880；叠上基准 hue 0xFFFF
     * 再对 65536 取模 = (65535 + 64880) % 65536 = 64879 = 0xFD6F。 */
    CHECK(lumen_effect_rainbow_hue(&wide, 99, 0) == 0xFD6Fu);
}

static void test_effects_rainbow_pixel(void)
{
    /* 像素层：span = 0 整段同色；span = 255 段内颜色各不相同。 */
    lumen_segment_t flat = make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 1000, 0, 0, 0);
    uint8_t a[3];
    uint8_t b[3];
    lumen_effect_pixel(&flat, 0, 0, a);
    lumen_effect_pixel(&flat, 15, 0, b);
    CHECK(memcmp(a, b, 3) == 0);
    CHECK(a[0] == 255 && a[1] == 0 && a[2] == 0); /* hue 0 = 纯红 */

    /* 时间推进到约 1/3 圈后整段变绿（相位 ≈ 21823，扇区 1 的末端）。 */
    lumen_effect_pixel(&flat, 0, 333, a); /* phase ≈ 21823 */
    CHECK(a[0] <= 2 && a[1] >= 250 && a[2] == 0);

    lumen_segment_t full = make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 1000, 255, 0, 0);
    uint8_t first[3];
    lumen_effect_pixel(&full, 0, 0, first);
    CHECK(first[0] == 255 && first[1] == 0 && first[2] == 0);
    /* 第 4 颗（i=4，hue=16384）落在 90° 附近：绿通道明显大于红。 */
    lumen_effect_pixel(&full, 4, 0, first);
    CHECK(first[1] > first[0]);
    /* 第 8 颗（hue=32768）是 180°：主通道是绿/蓝，红应接近 0。 */
    lumen_effect_pixel(&full, 8, 0, first);
    CHECK(first[0] < 40);
    /* sat = 0 → 全白，与位置无关（V 恒为 1）。 */
    layer_set_sat(&full.layer[0], 0);
    for (uint16_t i = 0; i < 16; ++i) {
        lumen_effect_pixel(&full, i, 0, first);
        CHECK(first[0] == 255 && first[1] == 255 && first[2] == 255);
    }

    /* 时间推进让同一颗灯换色（动画真的在走）。 */
    layer_set_sat(&full.layer[0], 255);
    lumen_effect_pixel(&full, 3, 0, a);
    lumen_effect_pixel(&full, 3, 250, b);
    CHECK(memcmp(a, b, 3) != 0);
}

static void test_effects_comet_gain(void)
{
    const uint16_t n = 16;

    /* tail = 0：硬边，只有头部一颗亮（§3.4 第一条验收点）。 */
    lumen_segment_t hard = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 0, 0, 0);
    CHECK(lumen_effect_comet_gain_q16(&hard, 0, 0) == 65535); /* exp(0) = 1 */
    for (uint16_t off = 1; off < n; ++off) {
        CHECK(lumen_effect_comet_gain_q16(&hard, off, 0) == 0);
    }
    /* 头部随相位移动：半周期在中间，整周期回到起点。 */
    CHECK(comet_brightest_offset(&hard, 0) == 0);
    CHECK(comet_brightest_offset(&hard, 500) == 8);
    CHECK(comet_brightest_offset(&hard, 250) == 4);
    /* 相位回绕：t = period 与 t = 0 逐像素相同（头部回到段首）。 */
    CHECK(comet_brightest_offset(&hard, 1000) == 0);
    for (uint16_t off = 0; off < n; ++off) {
        CHECK(lumen_effect_comet_gain_q16(&hard, off, 1000) ==
              lumen_effect_comet_gain_q16(&hard, off, 0));
    }

    /*
     * tail = 255：整条都是尾。头部仍是最亮，尾部单调变暗但**不为 0**
     * （长拖尾）。沿灯带在头部之后的权重递减。
     */
    lumen_segment_t long_tail = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 255, 0, 0);
    uint32_t head = lumen_effect_comet_gain_q16(&long_tail, 0, 0);
    CHECK(head == 65535);
    uint32_t prev_gain = head;
    for (uint16_t off = 1; off < n; ++off) {
        uint32_t gain = lumen_effect_comet_gain_q16(&long_tail, off, 0);
        CHECK(gain < prev_gain); /* 严格递减（尾部） */
        CHECK(gain > 0);         /* 长尾覆盖整条，不提前截断 */
        prev_gain = gain;
    }
    /* 最远一颗约为 exp(-3 × 15/16) × 65535 ≈ 3400（不是 0）。 */
    CHECK(prev_gain >= 2500 && prev_gain <= 4000);

    /* tail = 0 与 tail = 255 之间连续（尾部覆盖灯珠数随 tail 单调增长）。 */
    lumen_segment_t mid = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 128, 0, 0);
    uint32_t mid_off8 = lumen_effect_comet_gain_q16(&mid, 8, 0);
    CHECK(mid_off8 > 0);                       /* tail = 128 时第 8 颗在尾内 */
    CHECK(lumen_effect_comet_gain_q16(&hard, 8, 0) == 0); /* tail = 0 时不在 */
    CHECK(lumen_effect_comet_gain_q16(&long_tail, 8, 0) > mid_off8); /* 尾更长更亮 */

    /*
     * reverse（flags bit0）：镜像段内下标。相位 0 时头部在段尾而不是段首；
     * 随时间从高索引走向低索引。
     */
    lumen_segment_t rev = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 0, 0x01, 0);
    CHECK(lumen_effect_comet_gain_q16(&rev, 15, 0) == 65535);
    CHECK(lumen_effect_comet_gain_q16(&rev, 0, 0) == 0);
    CHECK(comet_brightest_offset(&rev, 0) == 15);
    CHECK(comet_brightest_offset(&rev, 250) == 15 - 4);
    CHECK(comet_brightest_offset(&rev, 500) == 15 - 8);
    /* 正向与反向在同一时刻是镜像关系。 */
    for (uint16_t off = 0; off < n; ++off) {
        CHECK(lumen_effect_comet_gain_q16(&rev, off, 250) ==
              lumen_effect_comet_gain_q16(&hard, (uint16_t)(n - 1u - off), 250));
    }

    /* period = 0：静止，头部固定在段首（相位 0），不随时间变。 */
    lumen_segment_t still = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 0, 0, 0, 0);
    CHECK(lumen_effect_comet_gain_q16(&still, 0, 0) == 65535);
    CHECK(lumen_effect_comet_gain_q16(&still, 0, 123456) == 65535);
    CHECK(lumen_effect_comet_gain_q16(&still, 5, 123456) == 0);

    /* 段起点不为 0：头部落在段首像素上，而不是整条灯带的 0 号。 */
    lumen_segment_t offset = make_animated(LUMEN_EFFECT_COMET, 10, 25, 0, 255, 1000, 0, 0, 0);
    CHECK(lumen_effect_comet_gain_q16(&offset, 10, 0) == 65535);
    CHECK(lumen_effect_comet_gain_q16(&offset, 0, 0) == 0);
    CHECK(lumen_effect_comet_gain_q16(&offset, 18, 500) == 65535); /* 段内偏移 8 */

    /* 像素层：硬边头部是纯红，尾部按权重变暗；tail = 0 时非头全黑。 */
    lumen_segment_t seg = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 0, 0, 0);
    uint8_t rgb[3];
    lumen_effect_pixel(&seg, 0, 0, rgb);
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);
    lumen_effect_pixel(&seg, 3, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);

    lumen_segment_t tail = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 200, 0, 0);
    lumen_effect_pixel(&tail, 0, 0, rgb);
    CHECK(rgb[0] == 255);
    uint8_t trail[3];
    lumen_effect_pixel(&tail, 4, 0, trail);
    CHECK(trail[0] > 0 && trail[0] < 255); /* 拖尾：暗但不黑 */

    /* 参数防御。 */
    lumen_segment_t off = seg;
    off.active = false;
    CHECK(lumen_effect_comet_gain_q16(&off, 0, 0) == 0);
    CHECK(lumen_effect_comet_gain_q16(NULL, 0, 0) == 0);
    CHECK(lumen_effect_comet_gain_q16(&seg, 16, 0) == 0);

    /*
     * #72：N = 100（新上限）时 tail_n_q16 与 p×N 都在 uint32/uint64 内，
     * 且整条尾的单调性不破。tail = 255 时 tail_n_q16 = 100 × 65536 = 6.55e6。
     */
    lumen_segment_t wide_tail =
        make_animated(LUMEN_EFFECT_COMET, 0, 99, 0, 255, 1000, 255, 0, 0);
    uint32_t last_gain = 0;
    for (uint16_t i = 0; i < 100; ++i) {
        uint32_t gain = lumen_effect_comet_gain_q16(&wide_tail, i, 0);
        if (i > 0) {
            CHECK(gain < last_gain); /* 严格递减 */
        }
        CHECK(gain > 0); /* 100 颗的长尾也不提前截断 */
        last_gain = gain;
    }
}

/*
 * #74：爆闪 STROBE 0x04。
 *
 * 包络是方波 + 两端 5% 线性斜坡；duty 决定高电平占多少（0 = 永不亮，
 * 255 = 几乎常亮）。period_ms == 0 表示静止不出光。
 */
static void test_effects_strobe(void)
{
    const uint16_t period = 100; /* 10Hz：本帧率下的闪烁上界 */

    /* 中点占空比：前半亮、后半灭，两端各 5% 斜坡。 */
    CHECK(lumen_effect_strobe_gain_q16(period, 128, 0, 0) == 0); /* 相位 0 在斜坡起点 */
    uint32_t at_20 = lumen_effect_strobe_gain_q16(period, 128, 0, 20); /* 20% 位置 */
    CHECK(at_20 == 65535);
    CHECK(lumen_effect_strobe_gain_q16(period, 128, 0, 60) == 0); /* 60% 位置已在低电平 */
    /* 中点之后（duty 128 → hi ≈ 50.2%）已经开始下降，但还没到 0。 */
    uint32_t just_past = lumen_effect_strobe_gain_q16(period, 128, 0, 50);
    CHECK(just_past > 0 && just_past < 5000);

    /* duty = 0：恒 GND（不是「一个很窄的脉冲」）。 */
    for (uint32_t now = 0; now <= period; now += 5) {
        CHECK(lumen_effect_strobe_gain_q16(period, 0, 0, now) == 0);
    }

    /* duty = 255：近乎常亮（除去末尾 5% 的下降沿）。 */
    for (uint32_t now = 10; now <= 90; now += 10) {
        CHECK(lumen_effect_strobe_gain_q16(period, 255, 0, now) == 65535);
    }
    /* 末尾斜坡：99% 处只剩 1/5 斜坡的高度（≈20% 满值），且比 97% 处更暗。 */
    uint32_t tail = lumen_effect_strobe_gain_q16(period, 255, 0, 99);
    uint32_t tail_earlier = lumen_effect_strobe_gain_q16(period, 255, 0, 97);
    CHECK(tail > 0 && tail < 15000);
    CHECK(tail_earlier > tail);

    /* duty 越大，亮的时间越长：20% 处窄占空比已经灭了，宽占空比还满亮。 */
    CHECK(lumen_effect_strobe_gain_q16(period, 40, 0, 20) == 0);
    CHECK(lumen_effect_strobe_gain_q16(period, 153, 0, 20) == 65535);

    /* period = 0：静止不出光（不是停在亮端）。 */
    for (uint32_t now = 0; now <= 1000; now += 250) {
        CHECK(lumen_effect_strobe_gain_q16(0, 128, 0, now) == 0);
    }

    /* 周期回绕：now = t0 + k × period 与 now = t0 完全相同。 */
    for (uint32_t phase = 0; phase < 100; phase += 7) {
        CHECK(lumen_effect_strobe_gain_q16(period, 90, 500, 500 + phase) ==
              lumen_effect_strobe_gain_q16(period, 90, 500, 500 + phase + period * 3u));
    }

    /* 像素层：纯红爆闪，亮时满值、灭时全黑。 */
    lumen_segment_t seg =
        seg_single(LUMEN_EFFECT_STROBE, 0, 9, 0, 255, 100, 128, 0, 0);
    uint8_t rgb[3];
    lumen_effect_pixel(&seg, 3, 20, rgb);
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);
    lumen_effect_pixel(&seg, 3, 60, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);

    /* 段内每颗灯同步（包络只与时间有关，与位置无关）。 */
    uint8_t first[3];
    lumen_effect_pixel(&seg, 0, 30, first);
    for (uint16_t i = 1; i <= 9; ++i) {
        uint8_t other[3];
        lumen_effect_pixel(&seg, i, 30, other);
        CHECK(memcmp(first, other, 3) == 0);
    }
}

/*
 * #74：心跳 HEARTBEAT 0x05。
 *
 * 一个节拍内一大一小两次脉冲（flags bit0 = 双脉冲，默认开），其余时间谷底。
 * 周期 500-1500ms（40-120 BPM）。
 */
static void test_effects_heartbeat(void)
{
    const uint16_t period = 1000; /* 60 BPM */
    const uint8_t pulse = 60;     /* 界面固定中等：w ≈ 23.5% 周期 */

    /* 节拍起点与脉冲之间是谷底。 */
    CHECK(lumen_effect_heartbeat_gain_q16(period, pulse, true, 0, 0) == 0);
    CHECK(lumen_effect_heartbeat_gain_q16(period, pulse, true, 0, 240) == 0); /* 两次脉冲之间 */
    CHECK(lumen_effect_heartbeat_gain_q16(period, pulse, true, 0, 720) == 0); /* 第二次之后 */

    /* 第一次脉冲：上升并在 w 前达到满值。 */
    uint32_t g100 = lumen_effect_heartbeat_gain_q16(period, pulse, true, 0, 100);
    uint32_t g230 = lumen_effect_heartbeat_gain_q16(period, pulse, true, 0, 230);
    CHECK(g100 > 20000 && g100 < 35000);
    CHECK(g230 > 60000);

    /* 第二次脉冲：峰值约为第一次的 0.6（一大一小）。 */
    uint32_t g500 = lumen_effect_heartbeat_gain_q16(period, pulse, true, 0, 500);
    uint32_t g700 = lumen_effect_heartbeat_gain_q16(period, pulse, true, 0, 700);
    CHECK(g500 > 0 && g500 < 8000); /* 刚开始起升 */
    CHECK(g700 > 35000 && g700 < 41000);

    /* 双脉冲关闭（flags bit0 = 0）：第二次脉冲消失。 */
    CHECK(lumen_effect_heartbeat_gain_q16(period, pulse, false, 0, 500) == 0);
    CHECK(lumen_effect_heartbeat_gain_q16(period, pulse, false, 0, 700) == 0);
    /* 第一次脉冲不受开关影响。 */
    CHECK(lumen_effect_heartbeat_gain_q16(period, pulse, false, 0, 230) == g230);

    /* 周期只缩放时间轴：500ms 周期在 now = 115 处与 1000ms 在 230 处同相。 */
    CHECK(lumen_effect_heartbeat_gain_q16(500, pulse, true, 0, 115) == g230);
    CHECK(lumen_effect_heartbeat_gain_q16(1500, pulse, true, 0, 345) == g230);

    /* period = 0：静止不出光（谷底）。 */
    for (uint32_t now = 0; now <= 2000; now += 500) {
        CHECK(lumen_effect_heartbeat_gain_q16(0, pulse, true, 0, now) == 0);
    }

    /* 极窄脉冲仍有可见宽度（w 至少 1% 周期，不会整拍都是黑的）。 */
    uint32_t narrow = 0;
    for (uint32_t now = 0; now < 50; ++now) {
        uint32_t g = lumen_effect_heartbeat_gain_q16(period, 0, true, 0, now);
        if (g > narrow) {
            narrow = g;
        }
    }
    CHECK(narrow > 0);

    /* 像素层：纯红心跳，谷底全黑、峰值满值。 */
    lumen_segment_t seg =
        seg_single(LUMEN_EFFECT_HEARTBEAT, 0, 9, 0, 255, 1000, 60, 0x01, 0);
    uint8_t rgb[3];
    lumen_effect_pixel(&seg, 3, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    lumen_effect_pixel(&seg, 3, 230, rgb);
    CHECK(rgb[0] >= 240);
    /* 段内每颗灯同步。 */
    uint8_t first[3];
    lumen_effect_pixel(&seg, 0, 500, first);
    for (uint16_t i = 1; i <= 9; ++i) {
        uint8_t other[3];
        lumen_effect_pixel(&seg, i, 500, other);
        CHECK(memcmp(first, other, 3) == 0);
    }
}

/*
 * #74：熄灭 OFF 0x06。参数全 0，永不发光；level 与时刻都不改变结果。
 */
static void test_effects_off(void)
{
    lumen_segment_t seg = seg_single(LUMEN_EFFECT_OFF, 0, 9, 0, 0, 0, 0, 0, 0);
    uint8_t rgb[3] = {1, 2, 3};
    for (uint32_t now = 0; now <= 5000; now += 250) {
        lumen_effect_pixel(&seg, 3, now, rgb);
        CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    }
    /* level 任意值仍是全黑（熄灭没有亮度可言）。 */
    for (uint8_t level = 0; level <= 100; level += 50) {
        layer_set_level(&seg.layer[0], level);
        lumen_effect_pixel(&seg, 3, 1000, rgb);
        CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    }
    layer_set_level(&seg.layer[0], LUMEN_LAYER_LEVEL_MAX);

    /* 熄灭是常量画面：段不需要帧循环，灯带也不算「有动画」。 */
    CHECK(!lumen_segment_is_animated(&seg));
    test_seg_store_t store;
    test_seg_init(&store);
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &seg) == LUMEN_RESULT_OK);
    CHECK(!test_seg_needs_frames(&store, 1));
    uint8_t buf[64 * 3];
    memset(buf, 0x5A, sizeof(buf));
    CHECK(test_seg_compose(&store, 0, buf, 64, 0) == 64);
    for (uint16_t i = 0; i < 64; ++i) {
        CHECK(buf[i * 3] == 0 && buf[i * 3 + 1] == 0 && buf[i * 3 + 2] == 0);
    }

    /*
     * 熄灭作为叠加层（layer1）：协议层不额外拒绝，语义是「黑色叠加」。
     * blend = 覆盖时整段变黑；blend = 相乘结果也是黑。
     */
    lumen_segment_t overlay;
    memset(&overlay, 0, sizeof(overlay));
    overlay.active = true;
    overlay.start = 0;
    overlay.end = 9;
    overlay.blend = LUMEN_BLEND_OVER;
    layer_set(LUMEN_EFFECT_STATIC, 0, 255, 0, 0, 0, &overlay.layer[0]);
    layer_set(LUMEN_EFFECT_OFF, 0, 0, 0, 0, 0, &overlay.layer[1]);
    CHECK(lumen_segment_validate_shape(&overlay) == LUMEN_RESULT_OK);
    lumen_effect_pixel(&overlay, 3, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    overlay.blend = LUMEN_BLEND_MULTIPLY;
    lumen_effect_pixel(&overlay, 3, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
}

/*
 * #74 的校验规则（§7.1 第 8 步）：
 *   STROBE    flags == 0；period == 0 或 ≥ 100ms
 *   HEARTBEAT flags bit1-7 == 0（bit0 双脉冲）；period == 0 或 500-1500ms
 *   OFF       参数（含 hue / sat / p5 / flags / period）全 0
 */
static void test_effects_new_types_validation(void)
{
    const uint8_t led_count = 30;

    /* ---- 爆闪 ---- */
    lumen_segment_t strobe = seg_single(LUMEN_EFFECT_STROBE, 0, 9, 0, 255, 100, 128, 0, 0);
    CHECK(lumen_segment_validate_shape(&strobe) == LUMEN_RESULT_OK);
    layer_set_period(&strobe.layer[0], 0); /* 0 = 静止，合法 */
    CHECK(lumen_segment_validate_shape(&strobe) == LUMEN_RESULT_OK);
    layer_set_period(&strobe.layer[0], 99); /* 99ms < 100ms 下限 → 拒绝 */
    CHECK(lumen_segment_validate_shape(&strobe) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_period(&strobe.layer[0], 100);
    layer_set_flags(&strobe.layer[0], 0x01); /* 爆闪没有 flags 位 */
    CHECK(lumen_segment_validate_shape(&strobe) == LUMEN_RESULT_INVALID_PARAM);

    /* ---- 心跳 ---- */
    lumen_segment_t heart = seg_single(LUMEN_EFFECT_HEARTBEAT, 0, 9, 0, 255, 500, 60, 0x01, 0);
    CHECK(lumen_segment_validate_shape(&heart) == LUMEN_RESULT_OK);
    layer_set_period(&heart.layer[0], 1500);
    CHECK(lumen_segment_validate_shape(&heart) == LUMEN_RESULT_OK);
    layer_set_period(&heart.layer[0], 0); /* 0 = 静止，合法 */
    CHECK(lumen_segment_validate_shape(&heart) == LUMEN_RESULT_OK);
    layer_set_period(&heart.layer[0], 499); /* 499 < 500 下限 */
    CHECK(lumen_segment_validate_shape(&heart) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_period(&heart.layer[0], 1501); /* 1501 > 1500 上限 */
    CHECK(lumen_segment_validate_shape(&heart) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_period(&heart.layer[0], 1000);
    layer_set_flags(&heart.layer[0], 0x02); /* bit1-7 保留 */
    CHECK(lumen_segment_validate_shape(&heart) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_flags(&heart.layer[0], 0x00); /* 单脉冲合法 */
    CHECK(lumen_segment_validate_shape(&heart) == LUMEN_RESULT_OK);

    /* ---- 熄灭：参数必须全 0 ---- */
    lumen_segment_t off = seg_single(LUMEN_EFFECT_OFF, 0, 9, 0, 0, 0, 0, 0, 0);
    CHECK(lumen_segment_validate_shape(&off) == LUMEN_RESULT_OK);
    layer_set_hue(&off.layer[0], 1); /* hue 非 0 */
    CHECK(lumen_segment_validate_shape(&off) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_hue(&off.layer[0], 0);
    layer_set_sat(&off.layer[0], 1); /* sat 非 0 */
    CHECK(lumen_segment_validate_shape(&off) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_sat(&off.layer[0], 0);
    layer_set_period(&off.layer[0], 100); /* 周期非 0 */
    CHECK(lumen_segment_validate_shape(&off) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_period(&off.layer[0], 0);
    layer_set_p5(&off.layer[0], 1); /* p5 非 0 */
    CHECK(lumen_segment_validate_shape(&off) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_p5(&off.layer[0], 0);
    layer_set_flags(&off.layer[0], 1); /* flags 非 0 */
    CHECK(lumen_segment_validate_shape(&off) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_flags(&off.layer[0], 0);
    CHECK(lumen_segment_validate_shape(&off) == LUMEN_RESULT_OK);

    /* ---- 三种新类型都能作为 layer1（叠加层） ---- */
    lumen_segment_t layered = seg_single(LUMEN_EFFECT_STATIC, 0, 9, 21845, 255, 0, 0, 0, 0);
    layered.blend = LUMEN_BLEND_MULTIPLY;
    layer_set(LUMEN_EFFECT_STROBE, 0, 255, 100, 128, 0, &layered.layer[1]);
    CHECK(lumen_segment_validate_shape(&layered) == LUMEN_RESULT_OK);
    layer_set(LUMEN_EFFECT_HEARTBEAT, 0, 255, 1000, 60, 0x01, &layered.layer[1]);
    CHECK(lumen_segment_validate_shape(&layered) == LUMEN_RESULT_OK);
    layer_set(LUMEN_EFFECT_OFF, 0, 0, 0, 0, 0, &layered.layer[1]);
    CHECK(lumen_segment_validate_shape(&layered) == LUMEN_RESULT_OK);
    /* layer1 的越界参数与 layer0 同一份规则。 */
    layer_set_period(&layered.layer[1], 99); /* OFF 带周期 → 非法 */
    CHECK(lumen_segment_validate_shape(&layered) == LUMEN_RESULT_INVALID_PARAM);

    /* ---- 整套段校验（含 strip / 区间 / 重叠）走同一份规则 ---- */
    test_seg_store_t store;
    test_seg_init(&store);
    lumen_segment_t strobe_ok = seg_single(LUMEN_EFFECT_STROBE, 0, 9, 0, 255, 100, 128, 0, 0);
    CHECK(test_seg_set(&store, 0, 1, 0, led_count, &strobe_ok) == LUMEN_RESULT_OK);
    lumen_segment_t heart_ok = seg_single(LUMEN_EFFECT_HEARTBEAT, 10, 19, 0, 255, 1500, 60, 0x01, 0);
    CHECK(test_seg_set(&store, 0, 1, 1, led_count, &heart_ok) == LUMEN_RESULT_OK);
    lumen_segment_t off_ok = seg_single(LUMEN_EFFECT_OFF, 20, 29, 0, 0, 0, 0, 0, 0);
    CHECK(test_seg_set(&store, 0, 1, 2, led_count, &off_ok) == LUMEN_RESULT_OK);
    CHECK(test_seg_count(&store, 0) == 3);
    lumen_segment_t heart_bad = seg_single(LUMEN_EFFECT_HEARTBEAT, 0, 4, 0, 255, 200, 60, 0, 0);
    CHECK(test_seg_set(&store, 1, 1, 0, led_count, &heart_bad) ==
          LUMEN_RESULT_INVALID_PARAM);
    lumen_segment_t off_bad = seg_single(LUMEN_EFFECT_OFF, 0, 4, 0, 9, 0, 0, 0, 0);
    CHECK(test_seg_set(&store, 1, 1, 0, led_count, &off_bad) ==
          LUMEN_RESULT_INVALID_PARAM);
}

/*
 * #74：三种新类型只有爆闪 / 心跳需要帧循环；熄灭是常量黑。
 */
static void test_effects_new_types_animation(void)
{
    test_seg_store_t store;
    test_seg_init(&store);

    lumen_segment_t strobe = seg_single(LUMEN_EFFECT_STROBE, 0, 9, 0, 255, 100, 128, 0, 0);
    CHECK(lumen_segment_is_animated(&strobe));
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &strobe) == LUMEN_RESULT_OK);
    CHECK(test_seg_needs_frames(&store, 1));

    test_seg_init(&store);
    lumen_segment_t heart = seg_single(LUMEN_EFFECT_HEARTBEAT, 0, 9, 0, 255, 1000, 60, 1, 0);
    CHECK(lumen_segment_is_animated(&heart));
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &heart) == LUMEN_RESULT_OK);
    CHECK(test_seg_needs_frames(&store, 1));

    test_seg_init(&store);
    lumen_segment_t off = seg_single(LUMEN_EFFECT_OFF, 0, 9, 0, 0, 0, 0, 0, 0);
    CHECK(!lumen_segment_is_animated(&off));
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &off) == LUMEN_RESULT_OK);
    CHECK(!test_seg_needs_frames(&store, 1));

    /* 熄灭叠加在动画层上时仍需要帧循环（由 layer0 决定）。 */
    lumen_segment_t mixed;
    memset(&mixed, 0, sizeof(mixed));
    mixed.active = true;
    mixed.start = 0;
    mixed.end = 9;
    mixed.blend = LUMEN_BLEND_MULTIPLY;
    layer_set(LUMEN_EFFECT_BREATHING, 0, 255, 1000, 0, 0, &mixed.layer[0]);
    layer_set(LUMEN_EFFECT_OFF, 0, 0, 0, 0, 0, &mixed.layer[1]);
    CHECK(lumen_segment_is_animated(&mixed));
}

/* ---------------- #98 流光密度 / 实色拖尾 ---------------- */

/* 收集一段里所有满亮（65535）的段内偏移。 */
static uint16_t comet_heads(const lumen_segment_t *seg, uint32_t now_ms, uint16_t *out,
                            uint16_t cap)
{
    uint16_t n = lumen_effect_segment_length(seg);
    uint16_t count = 0;
    for (uint16_t off = 0; off < n && count < cap; ++off) {
        if (lumen_effect_comet_gain_q16(seg, (uint16_t)(seg->start + off), now_ms) == 65535) {
            out[count++] = off;
        }
    }
    return count;
}

/*
 * 造一段有 heads 个头的流光，**段长 = heads × 16**，保证 n 能被 heads 整除
 * ——这样每个头的相位都正好落在一颗灯珠上，测试才能精确断言头的位置。
 * 段长不能被头数整除时头会落在两颗灯之间（现实中很常见，也是允许的），
 * 但那种情况没法用「某颗灯满亮」判断头在哪。
 */
static lumen_segment_t make_comet_heads(uint8_t heads, uint8_t tail, bool solid,
                                        uint8_t flags_extra)
{
    uint8_t flags = (uint8_t)(flags_extra |
                              (uint8_t)(((heads - 1u) << LUMEN_COMET_DENSITY_SHIFT) &
                                        LUMEN_COMET_DENSITY_MASK));
    if (solid) {
        flags = (uint8_t)(flags | LUMEN_COMET_FLAG_SOLID_TAIL);
    }
    return make_animated(LUMEN_EFFECT_COMET, 0, (uint8_t)(heads * 16u - 1u), 0, 255, 1000, tail,
                         flags, 0);
}

static void test_effects_comet_density(void)
{
    uint16_t heads[8];

    /*
     * 头数量 = flags bit2-3 + 1。tail = 0 时每个头都只有一颗灯，
     * 所以「满亮的偏移」恰好就是头的位置，且沿整条**均分**。
     */
    for (uint8_t want = 1; want <= 4; ++want) {
        lumen_segment_t seg = make_comet_heads(want, 0, false, 0);
        uint16_t n = lumen_effect_segment_length(&seg);
        uint16_t count = comet_heads(&seg, 0, heads, sizeof(heads) / sizeof(heads[0]));
        CHECK(count == want);
        /* 第 k 个头领先 k/want 圈 ⇒ 段内偏移 k × n/want（n 是 want 的整数倍）。 */
        for (uint16_t k = 0; k < count; ++k) {
            CHECK(heads[k] == (uint16_t)((uint32_t)k * n / want));
        }
        /* 越过一整圈：相位回绕后头的位置不变。 */
        uint16_t again[8];
        uint16_t count2 = comet_heads(&seg, 1000, again, sizeof(again) / sizeof(again[0]));
        CHECK(count2 == count);
        for (uint16_t k = 0; k < count; ++k) {
            CHECK(again[k] == heads[k]);
        }
    }

    /*
     * 相位推进时每个头都前进：N=16、周期 1000ms，半周期时 1 个头到 8；
     * 2 个头时头 0 → 8、头 1 → 0（(1/2 + 1/2) mod 1）。
     */
    lumen_segment_t one = make_comet_heads(1, 0, false, 0);
    CHECK(comet_brightest_offset(&one, 500) == 8); /* n=16 的半条 */
    lumen_segment_t two = make_comet_heads(2, 0, false, 0); /* n=32 */
    /* 两个头相距半条；半周期后它们互换位置，所以集合仍是 {0, 16}。 */
    CHECK(comet_heads(&two, 500, heads, 8) == 2);
    CHECK(heads[0] == 0 && heads[1] == 16);

    /*
     * 多个头重叠时**取最大值**合成，绝不相加：满拖尾（tail = 255）时整条都被
     * 尾巴覆盖，但没有任何一颗的增益超过单个头部的 65535。
     */
    for (uint8_t want = 1; want <= 4; ++want) {
        lumen_segment_t seg = make_comet_heads(want, 255, false, 0);
        uint16_t len = lumen_effect_segment_length(&seg);
        for (uint16_t off = 0; off < len; ++off) {
            uint32_t gain = lumen_effect_comet_gain_q16(&seg, off, 0);
            CHECK(gain <= 65535u); /* 溢出即「相加」 */
            CHECK(gain > 0);       /* 满拖尾覆盖整条 */
        }
    }

    /* 多一个头只会更亮或不变，且永不翻倍（两段都取 32 颗以便逐位比较）。 */
    lumen_segment_t single = make_animated(LUMEN_EFFECT_COMET, 0, 31, 0, 255, 1000, 200, 0, 0);
    lumen_segment_t dual = make_animated(LUMEN_EFFECT_COMET, 0, 31, 0, 255, 1000, 200,
                                         (uint8_t)(1u << LUMEN_COMET_DENSITY_SHIFT), 0);
    for (uint16_t off = 0; off < 32; ++off) {
        uint32_t a = lumen_effect_comet_gain_q16(&single, off, 0);
        uint32_t b = lumen_effect_comet_gain_q16(&dual, off, 0);
        CHECK(b >= a);
        CHECK(b <= 65535u);
    }
    /* 不在任何头 / 尾路径上的位置逐字节相同（证明没有额外叠加）。 */
    CHECK(lumen_effect_comet_gain_q16(&single, 5, 0) ==
          lumen_effect_comet_gain_q16(&dual, 5, 0));
    CHECK(lumen_effect_comet_gain_q16(&single, 13, 0) ==
          lumen_effect_comet_gain_q16(&dual, 13, 0));

    /* 密度只在 flags bit2-3：bit4-7 非 0 会被校验拒。 */
    lumen_segment_t bad_flags =
        make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 8, 0x10, 0);
    CHECK(lumen_segment_validate_shape(&bad_flags) == LUMEN_RESULT_INVALID_PARAM);
    bad_flags = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 8, 0x0D, 0);
    CHECK(lumen_segment_validate_shape(&bad_flags) == LUMEN_RESULT_OK);
}

static void test_effects_comet_solid_tail(void)
{
    const uint16_t n = 16;

    /* 衰减拖尾：沿尾巴严格递减（tail = 255 覆盖整条，便于逐颗比较）。 */
    lumen_segment_t decayed = make_comet_heads(1, 255, false, 0);
    uint32_t prev = lumen_effect_comet_gain_q16(&decayed, 0, 0);
    CHECK(prev == 65535u);
    for (uint16_t off = 1; off < n; ++off) {
        uint32_t gain = lumen_effect_comet_gain_q16(&decayed, off, 0);
        CHECK(gain < prev);
        prev = gain;
    }

    /* 实色拖尾：尾部各颗**同亮**，但头部之后一颗立刻降到台阶值。 */
    lumen_segment_t solid = make_comet_heads(1, 255, true, 0);
    uint32_t head = lumen_effect_comet_gain_q16(&solid, 0, 0);
    uint32_t first_tail = lumen_effect_comet_gain_q16(&solid, 1, 0);
    CHECK(head == 65535u);
    CHECK(first_tail == LUMEN_COMET_SOLID_TAIL_GAIN_Q16);
    CHECK(first_tail < head); /* 头与尾之间有台阶，不糊成一片 */
    for (uint16_t off = 2; off < n; ++off) {
        CHECK(lumen_effect_comet_gain_q16(&solid, off, 0) == first_tail);
    }

    /* 两种拖尾观感明显不同：中间某一颗亮度差在 20% 以上。 */
    uint32_t d_mid = lumen_effect_comet_gain_q16(&decayed, n / 2, 0);
    uint32_t s_mid = lumen_effect_comet_gain_q16(&solid, n / 2, 0);
    CHECK(s_mid > d_mid + 65535u / 5u);

    /* 实色拖尾仍然尊重 tail 的长度：tail = 0 时尾部一颗都不亮。 */
    lumen_segment_t solid_hard = make_comet_heads(1, 0, true, 0);
    CHECK(lumen_effect_comet_gain_q16(&solid_hard, 0, 0) == 65535u);
    for (uint16_t off = 1; off < n; ++off) {
        CHECK(lumen_effect_comet_gain_q16(&solid_hard, off, 0) == 0);
    }

    /* reverse（bit0）与密度 / 拖尾互不干扰：两个头的位置整体镜像。 */
    lumen_segment_t mirrored = make_comet_heads(2, 0, false, LUMEN_COMET_FLAG_REVERSE); /* n=32 */
    uint16_t heads[8];
    uint16_t count = comet_heads(&mirrored, 0, heads, 8);
    CHECK(count == 2);
    CHECK(heads[0] == 15); /* n - 1 - 16，升序扫描时先遇到 */
    CHECK(heads[1] == 31); /* n - 1 - 0 */
}

/* ---------------- #98 随机闪烁 ---------------- */

/* 统计某一时刻亮着的灯珠数（增益 ≥ 半亮即算「亮着」）。 */
static uint16_t flicker_lit_count(uint16_t period, uint8_t duty, uint16_t n, uint32_t now_ms)
{
    uint16_t lit = 0;
    for (uint16_t i = 0; i < n; ++i) {
        if (lumen_effect_flicker_gain_q16(period, duty, i, n, 0, now_ms) >= 32768u) {
            ++lit;
        }
    }
    return lit;
}

static void test_effects_flicker(void)
{
    const uint16_t n = 100;

    /* 确定性：同一颗灯、同一时刻反复求值完全一致。 */
    for (uint16_t i = 0; i < n; i = (uint16_t)(i + 7)) {
        uint32_t a = lumen_effect_flicker_gain_q16(1000, 128, i, n, 1234, 5000);
        uint32_t b = lumen_effect_flicker_gain_q16(1000, 128, i, n, 1234, 5000);
        CHECK(a == b);
    }
    /* 同一时刻整条重算一遍（换调用顺序）结果不变——不是逐帧白噪声。 */
    uint32_t snapshot[100];
    for (uint16_t i = 0; i < n; ++i) {
        snapshot[i] = lumen_effect_flicker_gain_q16(1000, 128, i, n, 0, 4000);
    }
    for (uint16_t i = n; i-- > 0;) {
        CHECK(snapshot[i] == lumen_effect_flicker_gain_q16(1000, 128, i, n, 0, 4000));
    }

    /* 时间推进后画面确实变了（否则不是闪烁而是静态点阵）。 */
    bool any_changed = false;
    for (uint16_t i = 0; i < n; ++i) {
        if (snapshot[i] != lumen_effect_flicker_gain_q16(1000, 128, i, n, 0, 4500)) {
            any_changed = true;
            break;
        }
    }
    CHECK(any_changed);

    /* 密度控制同时亮着的比例：sparse 明显少于 dense，且都在合理区间。 */
    uint16_t sparse = 0;
    uint16_t dense = 0;
    uint16_t total = 0;
    for (uint32_t now = 0; now < 1000; now += 100) {
        sparse = (uint16_t)(sparse + flicker_lit_count(1000, 32, n, now));
        dense = (uint16_t)(dense + flicker_lit_count(1000, 224, n, now));
        total = (uint16_t)(total + n);
    }
    CHECK(sparse < dense);
    CHECK(dense > total / 2u);  /* 224/255 ≈ 88% 亮 */
    CHECK(sparse * 4u < total); /* 32/255 ≈ 12.5% 亮 */

    /* duty = 0 → 全灭；duty = 255 → 几乎全亮（只留两端的边沿斜坡）。 */
    CHECK(flicker_lit_count(1000, 0, n, 500) == 0);
    CHECK(flicker_lit_count(1000, 255, n, 500) > n * 9u / 10u);

    /* 每颗灯相位不同：同一时刻不是整条一起亮 / 一起灭。 */
    uint16_t lit = flicker_lit_count(1000, 128, n, 600);
    CHECK(lit > 0 && lit < n);

    /* period = 0：时间相位不前进，画面停在一张固定分布上。 */
    uint32_t still = lumen_effect_flicker_gain_q16(0, 128, 3, n, 0, 0);
    CHECK(still == lumen_effect_flicker_gain_q16(0, 128, 3, n, 0, 123456));

    /* 越界下标与 n = 0 防御。 */
    CHECK(lumen_effect_flicker_gain_q16(1000, 128, n, n, 0, 0) == 0);
    CHECK(lumen_effect_flicker_gain_q16(1000, 128, 0, 0, 0, 0) == 0);

    /* 像素层：基色恒定、只被方波开关；整段不是同亮同灭。 */
    lumen_segment_t seg = seg_single(LUMEN_EFFECT_FLICKER, 0, 99, 0, 255, 1000, 128, 0, 0);
    uint16_t bright = 0;
    uint16_t dark = 0;
    for (uint16_t i = 0; i < 100; ++i) {
        uint8_t rgb[3];
        lumen_effect_pixel(&seg, i, 600, rgb);
        CHECK(rgb[1] == 0 && rgb[2] == 0); /* 纯红基色 */
        if (rgb[0] > 128) {
            ++bright;
        } else if (rgb[0] == 0) {
            ++dark;
        }
    }
    CHECK(bright > 0 && dark > 0);

    /* ---- 校验（§7.1 第 8 步）：flags 必须 0、周期 0 或 ≥ 334ms ---- */
    CHECK(lumen_segment_validate_shape(&seg) == LUMEN_RESULT_OK);
    lumen_segment_t v = seg;
    layer_set_period(&v.layer[0], 0);
    CHECK(lumen_segment_validate_shape(&v) == LUMEN_RESULT_OK);
    layer_set_period(&v.layer[0], 333);
    CHECK(lumen_segment_validate_shape(&v) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_period(&v.layer[0], LUMEN_FLICKER_MIN_PERIOD_MS);
    CHECK(lumen_segment_validate_shape(&v) == LUMEN_RESULT_OK);
    layer_set_flags(&v.layer[0], 0x01);
    CHECK(lumen_segment_validate_shape(&v) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_flags(&v.layer[0], 0x00);
    CHECK(lumen_segment_validate_shape(&v) == LUMEN_RESULT_OK);

    /* 随机闪烁是动画类（需要帧循环）。 */
    CHECK(lumen_segment_is_animated(&seg));
    test_seg_store_t store;
    test_seg_init(&store);
    CHECK(test_seg_set(&store, 0, 1, 0, 100, &seg) == LUMEN_RESULT_OK);
    CHECK(test_seg_needs_frames(&store, 1));

    /* 作为 layer1 合法（与其它动画类型同一套规则）。 */
    lumen_segment_t layered = seg_single(LUMEN_EFFECT_STATIC, 0, 9, 21845, 255, 0, 0, 0, 0);
    layered.blend = LUMEN_BLEND_MULTIPLY;
    layer_set(LUMEN_EFFECT_FLICKER, 0, 255, 1000, 128, 0, &layered.layer[1]);
    CHECK(lumen_segment_validate_shape(&layered) == LUMEN_RESULT_OK);
    layer_set_period(&layered.layer[1], 100);
    CHECK(lumen_segment_validate_shape(&layered) == LUMEN_RESULT_INVALID_PARAM);
}

/* ---------------- #98 循环三档 ---------------- */





/*
 * #31 的核心验收：彩虹 + 流光 + 静态在同一帧里跨段共存，且两段流光的
 * 相位**确实不连续**（D4 已定的取舍——测试要确认它按设计断裂，而不是
 * 意外地连成一条）。
 */
static void test_effects_rainbow_comet_coexist(void)
{
    test_seg_store_t store;
    test_seg_init(&store);

    lumen_segment_t rainbow =
        make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 1000, 255, 0, 0);
    lumen_segment_t comet =
        make_animated(LUMEN_EFFECT_COMET, 16, 31, 0, 255, 1000, 64, 0, 0);
    lumen_segment_t stat = make_static(32, 47, 21845, 255); /* 纯绿 */

    CHECK(test_seg_set(&store, 0, 1, 0, 64, &rainbow) == LUMEN_RESULT_OK);
    CHECK(test_seg_set(&store, 0, 1, 1, 64, &comet) == LUMEN_RESULT_OK);
    CHECK(test_seg_set(&store, 0, 1, 2, 64, &stat) == LUMEN_RESULT_OK);

    /* 有彩虹 / 流光 → 需要帧循环（动画类判据）。 */
    CHECK(test_seg_needs_frames(&store, 1));

    uint8_t t0[64 * 3];
    uint8_t t250[64 * 3];
    CHECK(test_seg_compose(&store, 0, t0, 64, 0) == 64);
    CHECK(test_seg_compose(&store, 0, t250, 64, 250) == 64);

    /* 彩虹段：段内颜色变化，且随时间变化。 */
    CHECK(memcmp(&t0[0 * 3], &t0[8 * 3], 3) != 0);
    CHECK(memcmp(&t0[0 * 3], &t250[0 * 3], 3) != 0);
    /* 流光段：头部在 t=0 于 16，t=250 于 20（周期 1000，1/4 圈 = 4 颗）。 */
    CHECK(t0[16 * 3] == 255 && t0[16 * 3 + 1] == 0 && t0[16 * 3 + 2] == 0);
    CHECK(t250[20 * 3] == 255);
    CHECK(t250[16 * 3] == 0); /* 头部已经离开段首 */
    /* 静态段：两个时刻完全相同。 */
    CHECK(memcmp(&t0[32 * 3], &t250[32 * 3], 48) == 0);
    CHECK(t0[32 * 3 + 1] == 255 && t0[32 * 3] == 0);
    /* 未覆盖区（48-63）仍是 0。 */
    for (uint16_t i = 48; i < 64; ++i) {
        CHECK(t0[i * 3] == 0 && t0[i * 3 + 1] == 0 && t0[i * 3 + 2] == 0);
        CHECK(t250[i * 3] == 0 && t250[i * 3 + 1] == 0 && t250[i * 3 + 2] == 0);
    }

    /* 只有彩虹 / 只有流光时也需要帧循环（不是靠静态段顺带带起来的）。 */
    test_seg_store_t only;
    test_seg_init(&only);
    CHECK(test_seg_set(&only, 0, 1, 0, 64, &rainbow) == LUMEN_RESULT_OK);
    CHECK(test_seg_needs_frames(&only, 1));
    test_seg_init(&only);
    CHECK(test_seg_set(&only, 0, 1, 0, 64, &comet) == LUMEN_RESULT_OK);
    CHECK(test_seg_needs_frames(&only, 1));

    /*
     * **跨段相位不连续（D4）**
     *
     * 两段同参数流光，A [0-15] t0=0、B [16-31] t0=500ms（周期 1000）。
     * now = 1000 时：A 的段内相位 = 0 → 头部在 A 的偏移 0（像素 0）；
     *                 B 的段内相位 = 0.5 → 头部在 B 的偏移 8（像素 24）。
     *
     * 「意外连续」的实现会让两段的相位共享同一个时间基准，头部在
     * 像素 0 与 16 同时出现（或整条只有一条拖尾）。这里断言：
     *   - 两个头部都在、且偏移不同；
     *   - B 的段首像素（16）**不是**头部，边界上没有延续的拖尾；
     * 这就是「按设计断裂」的证据。
     */
    test_seg_store_t split;
    test_seg_init(&split);
    lumen_segment_t a = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 0, 0, 0);
    lumen_segment_t b = make_animated(LUMEN_EFFECT_COMET, 16, 31, 0, 255, 1000, 0, 0, 500);
    CHECK(test_seg_set(&split, 0, 1, 0, 64, &a) == LUMEN_RESULT_OK);
    CHECK(test_seg_set(&split, 0, 1, 1, 64, &b) == LUMEN_RESULT_OK);

    uint8_t buf[64 * 3];
    CHECK(test_seg_compose(&split, 0, buf, 64, 1000) == 64);
    CHECK(buf[0 * 3] == 255);  /* A 头部在段首 */
    CHECK(buf[15 * 3] == 0);   /* A 段尾已离开头部 */
    CHECK(buf[16 * 3] == 0);   /* B 段首不是头部 → 边界断裂 */
    CHECK(buf[24 * 3] == 255); /* B 头部在段内偏移 8 */
    CHECK(buf[25 * 3] == 0);   /* tail = 0：硬边，相邻像素不继承亮度 */

    /* 相位与几何上「连续」会得到的头部位置是 16（B 偏移 0）；断言它不是。 */
    CHECK(comet_brightest_offset(&b, 1000) == 8);
    CHECK(comet_brightest_offset(&a, 1000) == 0);

    /*
     * 反之，两段 t0 相同时头部偏移相同（每段各自从自己的 t0 起算），
     * 这也证明相位是**每段独立**而不是全局推进的单一相位。
     * now = 750 → 相位 0.75 → 头部在段内偏移 12。
     */
    lumen_segment_t b_same = make_animated(LUMEN_EFFECT_COMET, 16, 31, 0, 255, 1000, 0, 0, 0);
    CHECK(test_seg_set(&split, 0, 1, 1, 64, &b_same) == LUMEN_RESULT_OK);
    CHECK(test_seg_compose(&split, 0, buf, 64, 750) == 64);
    CHECK(buf[0 * 3] == 0);         /* A 头部已离开段首 */
    CHECK(buf[12 * 3] == 255);      /* A 头部 = 0 + 12 */
    CHECK(comet_brightest_offset(&a, 750) == 12);
    CHECK(comet_brightest_offset(&b_same, 750) == 12);
    CHECK(buf[28 * 3] == 255);      /* B 头部 = 16 + 12 */

    /* 相位回绕：now = period 与 now = 0 的整帧逐字节相同。 */
    uint8_t cyc0[64 * 3];
    uint8_t cyc1[64 * 3];
    CHECK(test_seg_compose(&store, 0, cyc0, 64, 0) == 64);
    CHECK(test_seg_compose(&store, 0, cyc1, 64, 1000) == 64);
    CHECK(memcmp(cyc0, cyc1, 64 * 3) == 0);
}

/* ---------------- #30：帧循环判据 ---------------- */


/* ---------------- #49：SegmentReport 真实槽位回归 ----------------
 *
 * spec-v3 §4.2 第 3 处缺陷：QueryStrip 的 SegmentReport 必须报**真实槽位**，
 * 不是压缩序号。修复落在 led_engine_slots.c（从 led_engine.c 抽出的纯逻辑，
 * 因为 led_engine.c 依赖 FreeRTOS，进不了 host 测试）。
 *
 * 三条用例正是 issue #49 要求的三类场景；如果谁把 out_slots[written] = slot
 * 改回 out_slots[written] = written，下面会立刻变红。
 */



/* ---------------- #25：SetSegment / ClearSegment / QueryStrip reducer ---------------- */

/* ---------------- #25 / #36：SetSegment / ClearSegment / QueryStrip reducer ---------------- */




/* ---------------- #25：SegmentReport / SegmentListEnd 编码 ---------------- */

/* ---------------- #25 / #36：SegmentReport / SegmentListEnd / 两条新报告编码 ---------------- */


static void test_encode_strip_config_report(void)
{
    /* 参考向量 strip_config_report_3_strips：GPIO 3 / 10 / 0，其余 0xFF + flags 0。 */
    uint8_t gpios[LUMEN_MAX_STRIPS] = {3, 10, 0, 0, 0, 0, 0, 0};
    uint8_t out[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_strip_config_report(0x35, gpios, 3, out, sizeof(out));
    CHECK(len == 24 + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, "A60587351800000301010A0102000103FF0004FF0005FF0006FF0007FF00D2A4",
                len);

    /* 逐条核对：[strip_id, gpio, flags]，flags bit0 = 已分配。 */
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        CHECK(out[6 + i * 3] == i);
        if (i < 3) {
            CHECK(out[6 + i * 3 + 1] == gpios[i]);
            CHECK(out[6 + i * 3 + 2] == 0x01);
        } else {
            CHECK(out[6 + i * 3 + 1] == 0xFF);
            CHECK(out[6 + i * 3 + 2] == 0x00);
        }
    }

    /* 8 条全分配、order 也全分配；超过 8 条视为非法（协议上限）。 */
    len = lumen_protocol_encode_strip_config_report(0x01, gpios, 8, out, sizeof(out));
    CHECK(len == 24 + LUMEN_FRAME_OVERHEAD);
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        CHECK(out[6 + i * 3 + 2] == 0x01);
    }
    CHECK(lumen_protocol_encode_strip_config_report(0x01, gpios, 9, out, sizeof(out)) == 0);
    CHECK(lumen_protocol_encode_strip_config_report(0x01, NULL, 3, out, sizeof(out)) == 0);
    CHECK(lumen_protocol_encode_strip_config_report(0x01, gpios, 3, out,
                                                    24 + LUMEN_FRAME_OVERHEAD - 1) == 0);
}

static void test_encode_device_info_report(void)
{
    /* 参考向量 device_info_report：v5.0、MAC、五个上限、caps=0x01。 */
    uint8_t hw[6] = {0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF};
    uint8_t out[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_device_info_report(0x36, LUMEN_FIRMWARE_VERSION, hw,
                                                          LUMEN_CAP_TWO_LAYERS, out, sizeof(out));
    CHECK(len == 15 + LUMEN_FRAME_OVERHEAD);
    CHECK(LUMEN_FIRMWARE_VERSION == 0x0500);
    CHECK_BYTES(out, "A60588360F000005AABBCCDDEEFF64080808080301C5B1", len);

    /*
     * 偏移核对（§7.4）：0..1 version，2..7 hw_id，8 max_leds，9 max_strips，
     * 10 max_parts，11 max_part_segs，12 max_steps，13 max_scenes，14 caps。
     */
    CHECK(out[6] == 0x00 && out[7] == 0x05);
    CHECK(memcmp(&out[8], hw, sizeof(hw)) == 0);
    CHECK(out[14] == LUMEN_MAX_LEDS);
    CHECK(out[15] == LUMEN_MAX_STRIPS);
    CHECK(out[16] == LUMEN_MAX_PARTS);
    CHECK(out[17] == LUMEN_MAX_PART_SEGS);
    CHECK(out[18] == LUMEN_MAX_STEPS);
    CHECK(out[19] == LUMEN_MAX_SCENES);
    CHECK(out[20] == LUMEN_CAP_TWO_LAYERS);

    /* caps 的保留位由调用方决定；编码器原样透传。 */
    len = lumen_protocol_encode_device_info_report(0x01, 0x0301, hw, 0x03, out, sizeof(out));
    CHECK(len == 15 + LUMEN_FRAME_OVERHEAD);
    CHECK(out[7] == 0x03);
    CHECK(out[6] == 0x01 && out[19] == LUMEN_MAX_SCENES);
    CHECK(lumen_protocol_encode_device_info_report(0x01, 0x0300, NULL, 0, out,
                                                   15 + LUMEN_FRAME_OVERHEAD) == 0);
}

static void test_reject_v2_protocol_frames(void)
{
    /*
     * v2 帧（magic 0xA5 / version 0x02）在 v3 固件上必须是明确失败，不能误解析。
     * 这两个字节是「刷新固件后旧小程序立刻看到 UnsupportedVersion / BadMagic」
     * 的唯一保证（docs/protocol-v3.md §4）。
     */
    lumen_frame_t frame;
    uint8_t rc = 0xFF;

    /* v2 的 SetLedCount(strip 0, 64) 帧：A5 02 06 01 03 00 40 00 0E。 */
    CHECK(decode_hex("A5020601030040000E", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_MAGIC);
    CHECK(frame.command == 0x06);

    /* magic 正确、version 为 2：UnsupportedVersion（版本先于 CRC 判，CRC 随便填）。 */
    CHECK(decode_hex("A6020601030040000E", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_UNSUPPORTED_VERSION);

    /*
     * 裸帧（没有分片头）同样不能进解码器：收到 ctrl=0xC0 打头的写入时，
     * 分片层已经剥掉 1 字节，所以以 0xC0 开头的「逻辑帧」只可能来自违规的
     * 裸帧实现——解码器按 BadMagic 拒绝，绝不猜。
     */
    CHECK(decode_hex("C0A6030101010001F0A0", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_MAGIC);

    /*
     * v4 的关键验收点：**新固件收到 v3 帧必须明确回 UnsupportedVersion，
     * 且能正常继续服务后续帧**（不做双版本解码）。
     *
     * v3 的 SetPower(on) seq=1：A6 03 01 01 01 00 01 F0 A0（magic 相同、
     * 只有 version 是 0x03）。version 在 magic 之后立即校验，所以回 0x07。
     */
    CHECK(decode_hex("A6030101010001F0A0", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_UNSUPPORTED_VERSION);
    CHECK(frame.command == 0x01);
    CHECK(frame.seq == 0x01);
    /* 同一解码器紧接着处理一条合法 v4 帧仍然成功：坏帧不影响后续。 */
    CHECK(decode_hex("A6050101010001112D", &frame, &rc) == LUMEN_DECODE_OK);
    CHECK(rc == LUMEN_RESULT_OK);
    CHECK(frame.command == 0x01 && frame.seq == 0x01 && frame.payload_len == 1);
    CHECK(frame.payload[0] == 0x01);
}



/* ---------------- #29 八引脚 TDM ---------------- */

static void test_planar_parse_list(void)
{
    uint16_t out[LUMEN_MAX_STRIPS];

    CHECK(lumen_planar_parse_list("3", out, LUMEN_MAX_STRIPS) == 1);
    CHECK(out[0] == 3);

    CHECK(lumen_planar_parse_list("3,4,5,6", out, LUMEN_MAX_STRIPS) == 4);
    CHECK(out[0] == 3 && out[1] == 4 && out[2] == 5 && out[3] == 6);

    /* 空白与逗号都当分隔符。 */
    CHECK(lumen_planar_parse_list(" 1 , 2 ,3 ", out, LUMEN_MAX_STRIPS) == 3);
    CHECK(out[0] == 1 && out[1] == 2 && out[2] == 3);

    /* 空串 / 纯分隔符 → 0 项。 */
    CHECK(lumen_planar_parse_list("", out, LUMEN_MAX_STRIPS) == 0);
    CHECK(lumen_planar_parse_list(" , ", out, LUMEN_MAX_STRIPS) == 0);

    /* 非法：整串作废，不静默截断或跳过。 */
    CHECK(lumen_planar_parse_list("3,x,5", out, LUMEN_MAX_STRIPS) == 0);
    CHECK(lumen_planar_parse_list("3,", out, LUMEN_MAX_STRIPS) != 0); /* 尾随分隔符可接受 */
    CHECK(lumen_planar_parse_list("1,2,3", out, 2) == 0);             /* 超容量 */
    CHECK(lumen_planar_parse_list(NULL, out, LUMEN_MAX_STRIPS) == 0);
    CHECK(lumen_planar_parse_list("3", NULL, LUMEN_MAX_STRIPS) == 0);
}

static void test_planar_init_validation(void)
{
    lumen_planar_t planar;
    uint8_t pins[LUMEN_MAX_STRIPS] = {3, 4, 5, 6, 7, 10, 20, 21};
    /* #72：100 是新上限，作为首条的最大值同时锁住 Kconfig/planar 的接受边界。 */
    uint16_t counts[LUMEN_MAX_STRIPS] = {100, 30, 30, 30, 30, 30, 30, 30};

    CHECK(lumen_planar_init(&planar, pins, counts, 8));
    CHECK(planar.strip_count == 8);
    CHECK(planar.max_count == 100);
    CHECK(lumen_planar_active_count(&planar) == 8);

    /* 灯珠数越界：整份拒绝，planar 保持上一次的合法内容。 */
    lumen_planar_t before = planar;
    counts[3] = 0;
    CHECK(!lumen_planar_init(&planar, pins, counts, 8));
    CHECK(memcmp(&planar, &before, sizeof(planar)) == 0);

    counts[3] = LUMEN_MAX_LEDS + 1;
    CHECK(!lumen_planar_init(&planar, pins, counts, 8));

    /* 引脚重复：TDM 下无法区分两条，必须拒绝。 */
    counts[3] = 30;
    uint8_t dup[2] = {3, 3};
    uint16_t dup_counts[2] = {30, 30};
    CHECK(!lumen_planar_init(&planar, dup, dup_counts, 2));

    /* 条数越界。 */
    CHECK(!lumen_planar_init(&planar, pins, counts, 0));
    CHECK(!lumen_planar_init(&planar, pins, counts, LUMEN_MAX_STRIPS + 1));

    /* 单条合法（走单灯带路径）。 */
    CHECK(lumen_planar_init(&planar, pins, counts, 1));
    CHECK(planar.strip_count == 1);
}

static void test_planar_round_robin(void)
{
    lumen_planar_t planar;
    uint8_t pins[4] = {3, 4, 5, 6};
    uint16_t counts[4] = {10, 20, 30, 40};
    CHECK(lumen_planar_init(&planar, pins, counts, 4));

    /* 严格轮询顺序 0,1,2,3,0,1,... */
    for (int round = 0; round < 3; ++round) {
        for (uint8_t i = 0; i < 4; ++i) {
            CHECK(lumen_planar_next(&planar) == i);
        }
    }

    /* 降级 1 号：轮询跳过它，顺序变成 0,2,3。 */
    CHECK(lumen_planar_mark_degraded(&planar, 1));
    CHECK(!lumen_planar_mark_degraded(&planar, 1)); /* 第二次不再算「首次」 */
    CHECK(lumen_planar_active_count(&planar) == 3);
    CHECK(lumen_planar_next(&planar) == 0);
    CHECK(lumen_planar_next(&planar) == 2);
    CHECK(lumen_planar_next(&planar) == 3);

    /* 恢复后重新参与。 */
    CHECK(lumen_planar_revive(&planar, 1));
    CHECK(!lumen_planar_revive(&planar, 1)); /* 本来就没降级 */
    CHECK(lumen_planar_active_count(&planar) == 4);
    for (uint8_t i = 0; i < 4; ++i) {
        CHECK(lumen_planar_next(&planar) == i);
    }

    /* 全部降级 → NONE，且不死循环（每次调用都立刻返回）。 */
    for (uint8_t i = 0; i < 4; ++i) {
        lumen_planar_mark_degraded(&planar, i);
    }
    CHECK(lumen_planar_active_count(&planar) == 0);
    for (int i = 0; i < 10; ++i) {
        CHECK(lumen_planar_next(&planar) == LUMEN_PLANAR_NONE);
    }

    /* 一条降级、其余正常：这是票面「一条不接不影响其它 7 条」。 */
    CHECK(lumen_planar_revive_all(&planar) == 4);
    CHECK(lumen_planar_active_count(&planar) == 4);
    lumen_planar_mark_degraded(&planar, 2);
    int seen = 0;
    for (uint8_t i = 0; i < 6; ++i) {
        uint8_t id = lumen_planar_next(&planar);
        CHECK(id != 2);
        CHECK(id != LUMEN_PLANAR_NONE);
        ++seen;
    }
    CHECK(seen == 6);
}

static void test_planar_set_count(void)
{
    lumen_planar_t planar;
    uint8_t pins[2] = {3, 4};
    uint16_t counts[2] = {100, 30};
    CHECK(lumen_planar_init(&planar, pins, counts, 2));
    CHECK(planar.max_count == 100);

    /* 把最大的那条调小：max_count 必须重算，否则句柄白白按 100 建。 */
    CHECK(lumen_planar_set_count(&planar, 0, 20));
    CHECK(planar.max_count == 30);
    CHECK(lumen_planar_get(&planar, 0)->count == 20);

    /* 越界一律拒绝，且不改值。#72：100 合法、101 拒绝。 */
    CHECK(!lumen_planar_set_count(&planar, 0, 0));
    CHECK(lumen_planar_set_count(&planar, 0, LUMEN_MAX_LEDS));
    CHECK(lumen_planar_get(&planar, 0)->count == LUMEN_MAX_LEDS);
    CHECK(!lumen_planar_set_count(&planar, 0, LUMEN_MAX_LEDS + 1));
    CHECK(!lumen_planar_set_count(&planar, 2, 10)); /* 不存在的条 */
    CHECK(lumen_planar_get(&planar, 0)->count == LUMEN_MAX_LEDS);

    /* 取不存在的条返回 NULL。 */
    CHECK(lumen_planar_get(&planar, 2) == NULL);
}

static void test_planar_stats(void)
{
    lumen_planar_stats_t st;
    lumen_planar_stats_reset(&st);
    CHECK(st.rounds == 0);
    CHECK(lumen_planar_stats_avg_us(&st) == 0);

    lumen_planar_note_round(&st, 17600, 8);
    lumen_planar_note_round(&st, 18000, 7);
    CHECK(st.rounds == 2);
    CHECK(st.strips_pushed == 15);
    CHECK(st.round_us_last == 18000);
    CHECK(st.round_us_max == 18000);
    CHECK(lumen_planar_stats_avg_us(&st) == 17800);

    /* 最大值只升不降。 */
    lumen_planar_note_round(&st, 1000, 8);
    CHECK(st.round_us_max == 18000);
    CHECK(st.round_us_last == 1000);

    /* 全 NULL 安全。 */
    lumen_planar_stats_reset(NULL);
    lumen_planar_note_round(NULL, 1, 1);
    CHECK(lumen_planar_stats_avg_us(NULL) == 0);
}

static void test_planar_null_safety(void)
{
    CHECK(lumen_planar_next(NULL) == LUMEN_PLANAR_NONE);
    CHECK(lumen_planar_active_count(NULL) == 0);
    CHECK(!lumen_planar_mark_degraded(NULL, 0));
    CHECK(!lumen_planar_revive(NULL, 0));
    CHECK(lumen_planar_revive_all(NULL) == 0);
    CHECK(!lumen_planar_set_count(NULL, 0, 10));
    CHECK(lumen_planar_get(NULL, 0) == NULL);
}

/* ---------------- #38：每带独立开关 / 动画位 / TDM 跳过 ---------------- */

/*
 * 出光门控真值表（docs/protocol-v3.md §7.3 / §9.5 / §9.7）：
 *   实际出光 = 全局 power && 该带掩码位；自检期间忽略每带开关。
 *
 * 这是单灯带路径（compose_frame）与 TDM 路径共用的唯一判据，所以在纯函数层
 * 把 8 种组合全部钉死，而不是在渲染层靠肉眼检查。
 */
static void test_strip_mask_allows(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.strip_count = 4;

    /* 默认全开：power=0 → 一律不出光（总闸优先于每带开关）。 */
    CHECK(state.strip_power_mask == 0xFF);
    CHECK(!lumen_strip_mask_allows(&state, 0, false));
    CHECK(!lumen_strip_mask_allows(&state, 3, false));

    /* 总闸打开 + 掩码全开 → 四条都出光。 */
    state.power = 1;
    for (uint8_t i = 0; i < 4; ++i) {
        CHECK(lumen_strip_mask_allows(&state, i, false));
    }

    /* 关 strip 2：只有它不出光，其余不受影响。 */
    state.strip_power_mask = 0x0B; /* 1011 */
    CHECK(lumen_strip_mask_allows(&state, 0, false));
    CHECK(lumen_strip_mask_allows(&state, 1, false));
    CHECK(!lumen_strip_mask_allows(&state, 2, false));
    CHECK(lumen_strip_mask_allows(&state, 3, false));

    /* 自检忽略每带开关（§9.7）：power=0、掩码=0 也必须全部点亮。 */
    state.power = 0;
    state.strip_power_mask = 0x00;
    for (uint8_t i = 0; i < 4; ++i) {
        CHECK(lumen_strip_mask_allows(&state, i, true));
    }
    /* 自检只看合法 strip_id：越界仍然 false（不能读到别的内存）。 */
    CHECK(!lumen_strip_mask_allows(&state, 8, true));

    /* NULL / 越界防御。 */
    CHECK(!lumen_strip_mask_allows(NULL, 0, false));
    CHECK(!lumen_strip_mask_allows(NULL, 0, true));
    state.power = 1;
    state.strip_power_mask = 0xFF;
    CHECK(!lumen_strip_mask_allows(&state, LUMEN_MAX_STRIPS, false));

    /* 掩码算术：置位 / 清位，越界不动。 */
    CHECK(lumen_strip_power_set_mask(0x00, 2, true) == 0x04);
    CHECK(lumen_strip_power_set_mask(0xFF, 2, false) == 0xFB);
    CHECK(lumen_strip_power_set_mask(0xFF, 2, true) == 0xFF);
    CHECK(lumen_strip_power_set_mask(0x0F, 8, true) == 0x0F); /* 越界原样返回 */
    CHECK(lumen_strip_power_set_mask(0x0F, 8, false) == 0x0F);
}

/*
 * 全局 SetPower(0) 只关总闸，**不改** strip_power_mask（§9.5）。
 * 关灯再开灯必须回到各带原来的开关状态。
 */
static void test_global_power_leaves_strip_mask(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.strip_count = 4;
    state.power = 1;
    state.strip_power_mask = 0x0B; /* strip 2 关着 */

    lumen_command_outcome_t outcome;
    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SET_POWER;
    frame.payload_len = 1;

    frame.payload[0] = 0;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 0);
    /* 总闸不改掩码：各带自己的开关状态原样保留。 */
    CHECK(outcome.next.strip_power_mask == 0x0B);

    /* 再开回来：掩码仍是 0x0B，strip 2 依旧关着。 */
    state.power = 0;
    frame.payload[0] = 1;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.next.power == 1);
    CHECK(outcome.next.strip_power_mask == 0x0B);

    /* 门控复核：总闸开 + 掩码 0x0B ⇒ strip 2 依然不出光。 */
    CHECK(lumen_strip_mask_allows(&outcome.next, 0, false));
    CHECK(!lumen_strip_mask_allows(&outcome.next, 2, false));
}







/*
 * TDM 跳过决策真值表（§9.5）。四象限：
 *   持续出光 → PUSH；刚关 → 推黑再跳过；一直黑 → 直接跳过；刚开 → 强制推送。
 */
static void test_strip_tdm_plan(void)
{
    /* 一直在：正常推（允许去重）。 */
    CHECK(lumen_strip_tdm_plan(true, true) == LUMEN_STRIP_TDM_PUSH);
    /* 刚被打开：必须绕过去重，否则上一帧黑帧会被当成「没变化」吞掉。 */
    CHECK(lumen_strip_tdm_plan(true, false) == LUMEN_STRIP_TDM_REENABLE);
    /* 刚被关掉：先推一帧全黑（WS2812B 锁存旧画面）。 */
    CHECK(lumen_strip_tdm_plan(false, true) == LUMEN_STRIP_TDM_BLACK_THEN_SKIP);
    /* 一直是黑：直接跳过，省一整帧 RMT —— 这就是关带缩短轮周期的来源。 */
    CHECK(lumen_strip_tdm_plan(false, false) == LUMEN_STRIP_TDM_SKIP);
}

/*
 * 逐条灯珠数（v5 起 State 的 led_count 是数组，§7.3）。
 *
 * 这里用 LayoutSeg 校验「段区间必须落在**这条链自己**的灯珠数内」：
 * 拿 strip 0 的数字去校验 strip 2 会放行真实越界（设成功但后半段不亮），
 * 或误拒合法段。
 */
static void test_per_strip_led_counts_30_60_10(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.strip_count = 3;
    state.led_count[0] = 30;
    state.led_count[1] = 60;
    state.led_count[2] = 10;

    /* helper 读的就是逐条数组。 */
    CHECK(lumen_command_strip_count(&state, 0) == 30);
    CHECK(lumen_command_strip_count(&state, 1) == 60);
    CHECK(lumen_command_strip_count(&state, 2) == 10);
    /* 未配置的槽位退回协议上限（不是 0——0 会让所有段被误拒）。 */
    CHECK(lumen_command_strip_count(&state, 7) == LUMEN_MAX_LEDS);
    /* 越界下标同样兜底到上限。 */
    CHECK(lumen_command_strip_count(&state, LUMEN_MAX_STRIPS) == LUMEN_MAX_LEDS);
    CHECK(lumen_command_strip_count(NULL, 0) == LUMEN_MAX_LEDS);

    struct {
        uint8_t strip;
        uint8_t start;
        uint8_t end;
        uint8_t expect_ok;
    } cases[] = {
        {0, 0, 29, 1},  /* 30 灯：上界 29 合法 */
        {0, 0, 30, 0},  /* 30 灯：30 越界 */
        {1, 0, 59, 1},  /* 60 灯：59 合法 */
        {1, 0, 60, 0},  /* 60 灯：60 越界 */
        {1, 0, 30, 1},  /* 60 灯也能装下 30 灯的区间 */
        {2, 0, 9, 1},   /* 10 灯：9 合法 */
        {2, 0, 10, 0},  /* 10 灯：10 越界 */
        {2, 0, 29, 0},  /* 30 灯的数字对 10 灯必须越界 */
    };
    lumen_command_outcome_t out;
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        /* 每条链先声明 1 个部位 + 1 个段槽位（LayoutWrite 会清空该链）。 */
        lumen_layout_store_t layout;
        lumen_layout_store_init(&layout);
        CHECK(lumen_layout_store_write(&layout, cases[i].strip, 1, state.strip_count) ==
              LUMEN_RESULT_OK);
        CHECK(lumen_layout_store_set_part(&layout, cases[i].strip, 0, 0, NULL, 1, LUMEN_PHASE_CONTINUOUS,
                                          state.strip_count) == LUMEN_RESULT_OK);

        lumen_frame_t f = {0};
        f.command = LUMEN_CMD_LAYOUT_SEG;
        f.seq = (uint8_t)(i + 1);
        f.payload_len = 5;
        f.payload[0] = cases[i].strip;
        f.payload[1] = 0; /* part */
        f.payload[2] = 0; /* seg */
        f.payload[3] = cases[i].start;
        f.payload[4] = cases[i].end;
        lumen_command_dispatch(&f, &state, &layout, 255, &out);
        if (cases[i].expect_ok) {
            CHECK(out.result_code == LUMEN_RESULT_OK);
            CHECK(out.layout_op);
            CHECK(out.layout_end == cases[i].end);
        } else {
            CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
            CHECK(!out.layout_op);
        }
    }
}

/*
 * 上限形态：100 灯 + 24 灯的混合配置，以及「两条链各自独立」。
 *
 * 段区间按各自链的灯珠数校验；布局里一颗灯珠只属一个部位（S3），
 * 所以 [0-49] 与 [50-99] 可以共存、重叠则拒。
 */
static void test_per_strip_led_counts_100_24(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 100);
    state.strip_count = 2;
    state.led_count[0] = 100;
    state.led_count[1] = 24;

    CHECK(lumen_command_strip_count(&state, 0) == 100);
    CHECK(lumen_command_strip_count(&state, 1) == 24);

    lumen_layout_store_t layout;
    lumen_layout_store_init(&layout);
    CHECK(lumen_layout_store_write(&layout, 0, 2, state.strip_count) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_write(&layout, 1, 1, state.strip_count) == LUMEN_RESULT_OK);
    /* strip 0 两个部位（各 1 段），strip 1 一个部位。 */
    for (uint8_t p = 0; p < 2; ++p) {
        CHECK(lumen_layout_store_set_part(&layout, 0, p, 0, NULL, 1, LUMEN_PHASE_CONTINUOUS, state.strip_count) ==
              LUMEN_RESULT_OK);
    }
    CHECK(lumen_layout_store_set_part(&layout, 1, 0, 0, NULL, 1, LUMEN_PHASE_CONTINUOUS, state.strip_count) ==
          LUMEN_RESULT_OK);

    struct {
        uint8_t strip;
        uint8_t part;
        uint8_t start;
        uint8_t end;
        uint8_t expect_ok;
    } cases[] = {
        {0, 0, 0, 49, 1},   /* 100 灯：前半段 */
        {1, 0, 0, 99, 0},   /* 24 灯：99 越界 */
        {1, 0, 0, 23, 1},   /* 24 灯：23 是最后一颗 */
        {0, 1, 50, 99, 1},  /* 100 灯：后半段（与前半段相邻不重叠） */
        {0, 1, 40, 60, 0},  /* 与部位 0 的 [0-49] 重叠 → S3 拒绝 */
    };
    lumen_command_outcome_t out;
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        lumen_frame_t f = {0};
        f.command = LUMEN_CMD_LAYOUT_SEG;
        f.seq = (uint8_t)(i + 1);
        f.payload_len = 5;
        f.payload[0] = cases[i].strip;
        f.payload[1] = cases[i].part;
        f.payload[2] = 0;
        f.payload[3] = cases[i].start;
        f.payload[4] = cases[i].end;
        lumen_command_dispatch(&f, &state, &layout, 255, &out);
        if (cases[i].expect_ok) {
            CHECK(out.result_code == LUMEN_RESULT_OK);
            CHECK(out.layout_op);
            /* 命令层只给意图；真正的写入由引擎在会话层提交。 */
            CHECK(lumen_layout_store_set_seg(&layout, cases[i].strip, cases[i].part, 0,
                                             cases[i].start, cases[i].end,
                                             state.led_count[cases[i].strip],
                                             state.strip_count) == LUMEN_RESULT_OK);
        } else {
            CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
            CHECK(!out.layout_op);
        }
    }

    /* 两条链各自独立的段：strip 0 两个部位、strip 1 一个部位，互不干扰。 */
    CHECK(lumen_layout_store_has_segments(&layout, 0));
    CHECK(lumen_layout_store_has_segments(&layout, 1));
    const lumen_part_layout_t *p1 = lumen_layout_store_part(&layout, 1, 0);
    CHECK(p1 != NULL);
    CHECK(p1->segs.seg[0][1] == 23);
    const lumen_part_layout_t *p0b = lumen_layout_store_part(&layout, 0, 1);
    CHECK(p0b != NULL);
    CHECK(p0b->segs.seg[0][0] == 50);
    /* 整份布局仍然自洽（无重叠、段都写齐）。 */
    uint16_t counts[LUMEN_MAX_STRIPS] = {100, 24, 0, 0, 0, 0, 0, 0};
    CHECK(lumen_layout_store_validate(&layout, state.strip_count, counts) == LUMEN_RESULT_OK);
}


/*
 * 8 条带边界下的 SetStripPower 校验：strip_id ∈ [0, strip_count) 且
 * strip_id < LUMEN_MAX_STRIPS，on ∈ {0,1}。多带场景的最后一格最容易被
 * 「<=」写错成放行 8。
 */
static void test_set_strip_power_validation_edges(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.strip_count = 8;

    lumen_command_outcome_t out;
    lumen_frame_t f = {0};
    f.command = LUMEN_CMD_SET_STRIP_POWER;
    f.payload_len = 2;

    /* 上界 7 合法。 */
    f.payload[0] = 7;
    f.payload[1] = 0;
    lumen_command_dispatch(&f, &state, NULL, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(out.strip_power_op);
    CHECK(out.strip_power_strip == 7);

    /* 8 越界：既不是已分配灯带，也超出 LUMEN_MAX_STRIPS。 */
    f.payload[0] = 8;
    lumen_command_dispatch(&f, &state, NULL, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!out.strip_power_op);
    /* 0xFF 这类脏值同样拒绝，不能按位运算误命中。 */
    f.payload[0] = 0xFF;
    lumen_command_dispatch(&f, &state, NULL, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!out.strip_power_op);

    /* on 只有 0 / 1；0xFF 不能当「开」。 */
    f.payload[0] = 0;
    for (uint8_t on = 2; on <= 0xFF; ++on) {
        f.payload[1] = on;
        lumen_command_dispatch(&f, &state, NULL, 255, &out);
        if (out.result_code != LUMEN_RESULT_INVALID_PARAM || out.strip_power_op) {
            CHECK(false);
            break;
        }
        if (on == 0xFF) {
            break; /* uint8_t 回绕，显式停在 0xFF */
        }
    }
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!out.strip_power_op);

    /* 掩码写入是纯算术：8 条全开 → 关 0/3/7 → 重开 3。 */
    uint8_t mask = 0xFF;
    mask = lumen_strip_power_set_mask(mask, 0, false);
    mask = lumen_strip_power_set_mask(mask, 3, false);
    mask = lumen_strip_power_set_mask(mask, 7, false);
    CHECK(mask == 0x76); /* 0111 0110 */
    mask = lumen_strip_power_set_mask(mask, 3, true);
    CHECK(mask == 0x7E); /* 0111 1110 */
}

/* ---------------- #36：SetStripPower / 分片重组 ---------------- */

/*
 * SetStripPower 0x1B（docs/protocol-v3.md §9.5）：命令层只校验并登记意图。
 * 掩码写入、推黑帧与 TDM 跳带属于 #38。
 */
static void test_set_strip_power_command(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.strip_count = 4;
    state.strip_power_mask = 0x0F;

    lumen_command_outcome_t outcome;
    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SET_STRIP_POWER;
    frame.seq = 1;
    frame.payload_len = 2;

    CHECK(lumen_command_is_known(LUMEN_CMD_SET_STRIP_POWER));
    CHECK(lumen_command_payload_len(LUMEN_CMD_SET_STRIP_POWER) == 2);
    /* §9.5：改每带开关算「改变状态」，要取消自检。 */
    CHECK(lumen_command_changes_state(LUMEN_CMD_SET_STRIP_POWER));

    /* 合法：strip 2 关。 */
    frame.payload[0] = 2;
    frame.payload[1] = 0;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.strip_power_op);
    CHECK(outcome.strip_power_strip == 2);
    CHECK(!outcome.strip_power_on);
    CHECK(outcome.cancels_selftest);
    /* 命令层不改 next：掩码由 ble_link 在 ACK 之前写入。 */
    CHECK(!outcome.state_changed);

    /* on = 1 同样合法。 */
    frame.payload[1] = 1;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.strip_power_on);

    /* strip_id 未分配（>= strip_count）→ InvalidParam。 */
    frame.payload[0] = 4;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.strip_power_op);
    CHECK(!outcome.cancels_selftest);

    /* on 只允许 0/1。 */
    frame.payload[0] = 0;
    frame.payload[1] = 2;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* 载荷长度必须正好 2。 */
    frame.payload[1] = 1;
    frame.payload_len = 1;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    frame.payload_len = 3;
    lumen_command_dispatch(&frame, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);

    /* 掩码的算术（ble_link 里同一段逻辑的纯拷贝）：清位 / 置位。 */
    uint8_t mask = 0x0F;
    mask = (uint8_t)(mask & (uint8_t)~(1u << 2));
    CHECK(mask == 0x0B);
    mask |= (uint8_t)(1u << 2);
    CHECK(mask == 0x0F);
    /* 全局 power 不改掩码（§9.5）：SetPower(0) 只是总闸。 */
    lumen_frame_t power = {0};
    power.command = LUMEN_CMD_SET_POWER;
    power.payload_len = 1;
    power.payload[0] = 0;
    lumen_command_dispatch(&power, &state, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.next.strip_power_mask == 0x0F);
}

/*
 * 分片重组（docs/protocol-v3.md §3.2）。状态机是纯的、注入 now_ms，
 * 所以这里直接驱动它，覆盖票面要求的六种情形。
 */
static void test_reasm_single_chunk(void)
{
    lumen_reasm_t r;
    lumen_reasm_init(&r);

    /* 不分片的帧也必须带 ctrl = 0xC0。 */
    const uint8_t frame[] = {0xA6, 0x03, 0x01, 0x01, 0x01, 0x00, 0x01, 0xF0, 0xA0};
    CHECK(lumen_reasm_feed(&r, LUMEN_CHUNK_SINGLE, frame, sizeof(frame), 0) ==
          LUMEN_REASM_COMPLETE);
    CHECK(r.len == sizeof(frame));
    CHECK(memcmp(r.data, frame, sizeof(frame)) == 0);
    /* 完成后 active 已复位：下一帧从 FIRST 重新开始，不会接在这帧后面。 */
    CHECK(!r.active);
    CHECK(!lumen_reasm_reset(&r));
}

static void test_reasm_multi_chunk(void)
{
    lumen_reasm_t r;
    lumen_reasm_init(&r);

    /* 与向量 chunking_two_chunks 同构：19 + 12 字节，ctrl 0x80 / 0x41。 */
    uint8_t part1[19];
    uint8_t part2[12];
    for (uint8_t i = 0; i < sizeof(part1); ++i) {
        part1[i] = i;
    }
    for (uint8_t i = 0; i < sizeof(part2); ++i) {
        part2[i] = (uint8_t)(100 + i);
    }

    CHECK(lumen_reasm_feed(&r, 0x80, part1, sizeof(part1), 0) == LUMEN_REASM_PENDING);
    CHECK(r.active);
    CHECK(r.len == sizeof(part1));
    CHECK(lumen_reasm_feed(&r, 0x41, part2, sizeof(part2), 20) == LUMEN_REASM_COMPLETE);
    CHECK(r.len == sizeof(part1) + sizeof(part2));
    CHECK(memcmp(r.data, part1, sizeof(part1)) == 0);
    CHECK(memcmp(&r.data[sizeof(part1)], part2, sizeof(part2)) == 0);

    /* 三片（与向量 chunking_three_chunks_state_report 同构：19 + 19 + 7）。 */
    uint8_t a[19];
    uint8_t b[19];
    uint8_t c[7];
    memset(a, 0xAA, sizeof(a));
    memset(b, 0xBB, sizeof(b));
    memset(c, 0xCC, sizeof(c));
    lumen_reasm_init(&r);
    CHECK(lumen_reasm_feed(&r, 0x80, a, sizeof(a), 0) == LUMEN_REASM_PENDING);
    CHECK(lumen_reasm_feed(&r, 0x01, b, sizeof(b), 5) == LUMEN_REASM_PENDING);
    CHECK(lumen_reasm_feed(&r, 0x42, c, sizeof(c), 10) == LUMEN_REASM_COMPLETE);
    CHECK(r.len == 45);
    CHECK(r.data[0] == 0xAA && r.data[18] == 0xAA);
    CHECK(r.data[19] == 0xBB && r.data[37] == 0xBB);
    CHECK(r.data[38] == 0xCC && r.data[44] == 0xCC);
}

static void test_reasm_first_reentry(void)
{
    lumen_reasm_t r;
    lumen_reasm_init(&r);

    uint8_t junk[8];
    memset(junk, 0xEE, sizeof(junk));
    const uint8_t frame[4] = {1, 2, 3, 4};

    /* 半截数据后收到新的 FIRST：旧缓冲被丢弃（latest-wins），不回报错误。 */
    CHECK(lumen_reasm_feed(&r, 0x80, junk, sizeof(junk), 0) == LUMEN_REASM_PENDING);
    CHECK(r.len == sizeof(junk));
    CHECK(lumen_reasm_feed(&r, LUMEN_CHUNK_SINGLE, frame, sizeof(frame), 10) ==
          LUMEN_REASM_COMPLETE);
    CHECK(r.len == sizeof(frame));
    CHECK(memcmp(r.data, frame, sizeof(frame)) == 0);

    /* FIRST 带序号 5 也照样从头收集（序号仅诊断用，不要求连续）。 */
    lumen_reasm_init(&r);
    CHECK(lumen_reasm_feed(&r, (uint8_t)(LUMEN_CHUNK_FIRST | 5), frame, 2, 0) ==
          LUMEN_REASM_PENDING);
    CHECK(lumen_reasm_feed(&r, (uint8_t)(LUMEN_CHUNK_LAST | 6), &frame[2], 2, 1) ==
          LUMEN_REASM_COMPLETE);
    CHECK(r.len == 4);
}

static void test_reasm_overflow(void)
{
    lumen_reasm_t r;
    uint8_t block[100];
    memset(block, 0x5A, sizeof(block));

    /* 正好填满 240 是合法的。 */
    lumen_reasm_init(&r);
    CHECK(lumen_reasm_feed(&r, 0x80, block, 100, 0) == LUMEN_REASM_PENDING);
    CHECK(lumen_reasm_feed(&r, 0x01, block, 100, 1) == LUMEN_REASM_PENDING);
    CHECK(lumen_reasm_feed(&r, 0x02, block, 40, 2) == LUMEN_REASM_PENDING);
    CHECK(lumen_reasm_feed(&r, 0x43, block, 0, 3) == LUMEN_REASM_COMPLETE);
    CHECK(r.len == LUMEN_MAX_FRAME);

    /* 241 → 溢出：缓冲丢弃、回 OVERFLOW（ble_link 据此回 BadLength）。 */
    lumen_reasm_init(&r);
    CHECK(lumen_reasm_feed(&r, 0x80, block, 100, 0) == LUMEN_REASM_PENDING);
    CHECK(lumen_reasm_feed(&r, 0x01, block, 100, 1) == LUMEN_REASM_PENDING);
    CHECK(lumen_reasm_feed(&r, 0x02, block, 41, 2) == LUMEN_REASM_OVERFLOW);
    CHECK(!r.active);
    CHECK(r.len == 0);

    /* 溢出后即使再来 LAST 也不会拼出半截帧。 */
    CHECK(lumen_reasm_feed(&r, LUMEN_CHUNK_SINGLE, block, 5, 3) == LUMEN_REASM_COMPLETE);
    CHECK(r.len == 5);
}

static void test_reasm_timeout(void)
{
    lumen_reasm_t r;
    lumen_reasm_init(&r);

    const uint8_t part[10] = {0};
    CHECK(lumen_reasm_feed(&r, 0x80, part, sizeof(part), 1000) == LUMEN_REASM_PENDING);

    /* 999ms：还没超时。 */
    CHECK(!lumen_reasm_expire(&r, 1999));
    CHECK(r.active);

    /* 1000ms（自上一个分片起算，含等号）：丢弃，返回 true，且**不发 ACK**
     * （本函数没有 ACK 通道——这正是 §3.2 规则 4 的语义）。 */
    CHECK(lumen_reasm_expire(&r, 2000));
    CHECK(!r.active);
    CHECK(r.len == 0);

    /* 没有进行中的重组时 expire 返回 false。 */
    CHECK(!lumen_reasm_expire(&r, 3000));

    /* 下一个分片到达时就地清掉过期缓冲：新数据不会接在旧数据后面。 */
    lumen_reasm_init(&r);
    CHECK(lumen_reasm_feed(&r, 0x80, part, sizeof(part), 0) == LUMEN_REASM_PENDING);
    const uint8_t fresh[3] = {7, 8, 9};
    CHECK(lumen_reasm_feed(&r, LUMEN_CHUNK_SINGLE, fresh, sizeof(fresh), 1000) ==
          LUMEN_REASM_COMPLETE);
    CHECK(r.len == sizeof(fresh));
    CHECK(memcmp(r.data, fresh, sizeof(fresh)) == 0);

    /* 时间回绕安全：now 比 last_ms 小（uint32 回绕）时按无符号差算。
     * last = 0xFFFFFF00，now = 0x400 → 差 0x500 = 1280ms > 1000 → 超时。 */
    lumen_reasm_init(&r);
    CHECK(lumen_reasm_feed(&r, 0x80, part, sizeof(part), 0xFFFFFF00u) == LUMEN_REASM_PENDING);
    CHECK(!lumen_reasm_expire(&r, 0x00000200u)); /* 差 0x300 = 768ms，未超时 */
    CHECK(lumen_reasm_expire(&r, 0x00000400u));  /* 差 0x500 = 1280ms，超时 */
}

static void test_reasm_orphan_and_helpers(void)
{
    lumen_reasm_t r;
    lumen_reasm_init(&r);

    const uint8_t data[4] = {1, 2, 3, 4};

    /* 没有 FIRST 的尾巴分片：静默丢弃，不建缓冲。 */
    CHECK(lumen_reasm_feed(&r, 0x01, data, sizeof(data), 0) == LUMEN_REASM_IGNORED);
    CHECK(!r.active);
    CHECK(r.len == 0);

    /* LAST 单独到达（空帧）：没有可解析内容 → IGNORED。 */
    CHECK(lumen_reasm_feed(&r, LUMEN_CHUNK_LAST, NULL, 0, 0) == LUMEN_REASM_IGNORED);

    /* NULL 防御。 */
    CHECK(lumen_reasm_feed(NULL, LUMEN_CHUNK_SINGLE, data, sizeof(data), 0) ==
          LUMEN_REASM_IGNORED);
    CHECK(!lumen_reasm_reset(NULL));
    CHECK(!lumen_reasm_expire(NULL, 0));
    lumen_reasm_init(NULL); /* 不崩即通过 */

    /* 发送侧切分（与接收端对称）。 */
    uint8_t frame[31];
    for (uint8_t i = 0; i < sizeof(frame); ++i) {
        frame[i] = i;
    }

    /*
     * capacity 是**单分片的数据上限**（= chunk_capacity - 1）。MTU 23 时
     * chunk_capacity = 20，数据上限 19：31 字节 → 2 片，19 + 12，
     * 与向量 chunking_two_chunks 的切片完全一致。
     */
    CHECK(lumen_reasm_chunk_count(sizeof(frame), 19) == 2);
    uint8_t chunk[32];
    size_t n = lumen_reasm_build_chunk(frame, sizeof(frame), 19, 0, chunk, sizeof(chunk));
    CHECK(n == 20); /* 19 字节数据 + 1 字节 ctrl */
    CHECK(chunk[0] == 0x80);
    CHECK(memcmp(&chunk[1], frame, 19) == 0);
    n = lumen_reasm_build_chunk(frame, sizeof(frame), 19, 1, chunk, sizeof(chunk));
    CHECK(n == 13); /* 12 字节数据 + ctrl，末片带 LAST */
    CHECK(chunk[0] == 0x41);
    CHECK(memcmp(&chunk[1], &frame[19], 12) == 0);

    /* 单分片：ctrl = 0xC0。 */
    CHECK(lumen_reasm_chunk_count(9, 179) == 1);
    n = lumen_reasm_build_chunk(frame, 9, 179, 0, chunk, sizeof(chunk));
    CHECK(n == 10);
    CHECK(chunk[0] == LUMEN_CHUNK_SINGLE);

    /* 越界 / 非法参数。 */
    CHECK(lumen_reasm_chunk_count(0, 19) == 0);
    CHECK(lumen_reasm_chunk_count(31, 0) == 0);
    CHECK(lumen_reasm_build_chunk(frame, 31, 19, 2, chunk, sizeof(chunk)) == 0);
    CHECK(lumen_reasm_build_chunk(frame, 31, 19, 0, chunk, 10) == 0);
    CHECK(lumen_reasm_build_chunk(NULL, 31, 19, 0, chunk, sizeof(chunk)) == 0);
    CHECK(lumen_reasm_build_chunk(frame, 31, 19, 0, NULL, sizeof(chunk)) == 0);

    /* 切出来的每一片都能被接收端拼回原帧（两端对称的硬证据）。 */
    lumen_reasm_init(&r);
    uint8_t count = lumen_reasm_chunk_count(sizeof(frame), 19);
    for (uint8_t i = 0; i < count; ++i) {
        n = lumen_reasm_build_chunk(frame, sizeof(frame), 19, i, chunk, sizeof(chunk));
        CHECK(n > 1);
        CHECK(lumen_reasm_feed(&r, chunk[0], &chunk[1], n - 1, i * 10) ==
              (i + 1 == count ? LUMEN_REASM_COMPLETE : LUMEN_REASM_PENDING));
    }
    CHECK(r.len == sizeof(frame));
    CHECK(memcmp(r.data, frame, sizeof(frame)) == 0);
}









/* ---------------- #32 剧本 ---------------- */








/* ---------------- #39：剧本 fade / 两层持久化 / 容量预检 ---------------- */




/* ---------------- #73 ClearScript 0x1E ---------------- */








/* ---------------- #72 漏项：灯珠数变小后裁剪剧本 ---------------- */





/* ---------------- #37：两层模型 / blend / 校验矩阵 / gamma 一次 ---------------- */

/*
 * 回归：单层段的行为必须与 v2 **逐字节相同**。
 *
 * 对四种灯效各取一组有代表性的参数，把「v2 的平铺字段」与「v3 的
 * layer[0] + 空 layer1」分别写成段，合成结果必须完全一致。这不是把实现抄
 * 两遍——v2 的期望值用独立的参考公式（就是 effects-spec §3 的公式本身）算。
 */
static void test_two_layer_single_layer_regression(void)
{
    test_seg_store_t store;
    test_seg_init(&store);

    /*
     * 静态：hue = 21845（120°）sat = 255 → 纯绿。位置与时刻都无关。
     */
    lumen_segment_t stat = make_static(4, 11, 21845, 255);
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &stat) == LUMEN_RESULT_OK);
    uint8_t buf[64 * 3];
    CHECK(test_seg_compose(&store, 0, buf, 64, 0) == 64);
    for (uint16_t i = 4; i <= 11; ++i) {
        CHECK(buf[i * 3] == 0 && buf[i * 3 + 1] == 255 && buf[i * 3 + 2] == 0);
    }
    for (uint16_t i = 0; i < 4; ++i) {
        CHECK(buf[i * 3] == 0 && buf[i * 3 + 1] == 0 && buf[i * 3 + 2] == 0);
    }
    CHECK(buf[12 * 3] == 0 && buf[12 * 3 + 1] == 0 && buf[12 * 3 + 2] == 0);

    /*
     * 呼吸：包络按 §3.2 独立重算，逐点比对。period 1000、min_level 0、正弦。
     */
    test_seg_init(&store);
    lumen_segment_t breath = make_animated(LUMEN_EFFECT_BREATHING, 0, 9, 0, 255, 1000, 0, 0, 0);
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &breath) == LUMEN_RESULT_OK);
    for (uint32_t t = 0; t <= 1000; t += 125) {
        uint32_t phase = lumen_effect_breathing_phase_q16(1000, 0, t);
        uint32_t env = lumen_effect_breathing_envelope_q16(phase, LUMEN_WAVE_SINE);
        uint32_t gain = lumen_effect_breathing_gain_q16(1000, 0, LUMEN_WAVE_SINE, 0, t);
        CHECK(gain == (uint32_t)(((uint64_t)env * 65536u) / 65536u)); /* min=0 → e'=e */
        uint8_t expected = lumen_effect_apply_gain_q16(255, gain);
        CHECK(test_seg_compose(&store, 0, buf, 64, t) == 64);
        CHECK(buf[0] == expected && buf[1] == 0 && buf[2] == 0);
        CHECK(buf[9 * 3] == expected); /* 段内同步 */
    }

    /*
     * 彩虹：span = 255，N = 16（段 [0-15]），第 i 颗 hue = i × 4096，用独立的
     * 扇区公式算参考色，与 lumen_effect_static_rgb 的输入对齐（同一个纯函数，
     * 这里只验证「层求值确实用段内偏移 + 段 t0」这条路没有偏移）。
     */
    test_seg_init(&store);
    lumen_segment_t rainbow =
        make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 1000, 255, 0, 0);
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &rainbow) == LUMEN_RESULT_OK);
    CHECK(test_seg_compose(&store, 0, buf, 64, 0) == 64);
    for (uint16_t i = 0; i < 16; ++i) {
        uint8_t ref[3];
        lumen_effect_static_rgb((uint16_t)(i * 4096u), 255, ref);
        CHECK(buf[i * 3] == ref[0] && buf[i * 3 + 1] == ref[1] && buf[i * 3 + 2] == ref[2]);
    }

    /*
     * 流光：t = 0、tail = 0 时头部在段首且只有它亮（权重表 k=0 → 65535）。
     */
    test_seg_init(&store);
    lumen_segment_t comet = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 0, 0, 0);
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &comet) == LUMEN_RESULT_OK);
    CHECK(test_seg_compose(&store, 0, buf, 64, 0) == 64);
    CHECK(buf[0] == 255 && buf[1] == 0 && buf[2] == 0);
    CHECK(buf[1 * 3] == 0);

    /*
     * 关键的一句：单层段（layer1 = 0xFF）走的就是「layer0 直出」，
     * 不经任何 blend。构建一个 blend 会被忽略的反例来证明这一点。
     */
    lumen_segment_t single = make_static(0, 3, 0, 255);
    uint8_t a[3];
    uint8_t b[3];
    lumen_effect_pixel(&single, 0, 0, a);
    CHECK(a[0] == 255 && a[1] == 0 && a[2] == 0);
    /* 即使有人把 blend 写成 2（相加），单层也不应该被改变。 */
    single.blend = LUMEN_BLEND_ADD;
    lumen_effect_pixel(&single, 0, 0, b);
    CHECK(memcmp(a, b, 3) == 0);
}

/* blend 数学（§7.2），含饱和与舍入边界。 */
static void test_blend_math(void)
{
    /* 覆盖：out = L1，与 L0 无关。 */
    uint8_t l0[3] = {10, 200, 255};
    uint8_t l1[3] = {1, 2, 3};
    uint8_t out[3];
    lumen_blend_pixel(LUMEN_BLEND_OVER, l0, l1, out);
    CHECK(out[0] == 1 && out[1] == 2 && out[2] == 3);
    /* L0 全 0 也还是 L1（覆盖不是相加）。 */
    uint8_t zero[3] = {0, 0, 0};
    lumen_blend_pixel(LUMEN_BLEND_OVER, zero, l1, out);
    CHECK(out[0] == 1 && out[1] == 2 && out[2] == 3);

    /* 相乘：255 × 255 → 255（(65025+127)/255 = 255，不舍入掉档）。 */
    uint8_t full[3] = {255, 255, 255};
    lumen_blend_pixel(LUMEN_BLEND_MULTIPLY, full, full, out);
    CHECK(out[0] == 255 && out[1] == 255 && out[2] == 255);

    /* 0 × 255 → 0（任何通道，含饱和通道）。 */
    lumen_blend_pixel(LUMEN_BLEND_MULTIPLY, zero, full, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);
    lumen_blend_pixel(LUMEN_BLEND_MULTIPLY, full, zero, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);

    /* 127 舍入：128 × 255 = 32640，(32640+127)/255 = 128.49… → 128。 */
    uint8_t half[3] = {128, 128, 128};
    lumen_blend_pixel(LUMEN_BLEND_MULTIPLY, half, full, out);
    CHECK(out[0] == 128);
    /* 1 × 128 = 128 → (128+127)/255 = 1（0.5 向上舍入）。 */
    uint8_t one[3] = {1, 1, 1};
    uint8_t h128[3] = {128, 128, 128};
    lumen_blend_pixel(LUMEN_BLEND_MULTIPLY, one, h128, out);
    CHECK(out[0] == 1);
    /* 2 × 64 = 128 → (128+127)/255 = 1。 */
    uint8_t two[3] = {2, 2, 2};
    uint8_t s64[3] = {64, 64, 64};
    lumen_blend_pixel(LUMEN_BLEND_MULTIPLY, two, s64, out);
    CHECK(out[0] == 1);

    /* 相加饱和：255 + 255 必须钳到 255（不能 uint8 回绕成 254/0）。 */
    lumen_blend_pixel(LUMEN_BLEND_ADD, full, full, out);
    CHECK(out[0] == 255 && out[1] == 255 && out[2] == 255);
    /* 200 + 100 = 300 → 255。 */
    uint8_t a200[3] = {200, 0, 128};
    uint8_t b100[3] = {100, 0, 127};
    lumen_blend_pixel(LUMEN_BLEND_ADD, a200, b100, out);
    CHECK(out[0] == 255); /* 300 → 255 */
    CHECK(out[1] == 0);
    CHECK(out[2] == 255); /* 255 恰好不越界 */
    /* 恰好 255 不钳位失真。 */
    uint8_t x255[3] = {255, 0, 1};
    lumen_blend_pixel(LUMEN_BLEND_ADD, x255, zero, out);
    CHECK(out[0] == 255);

    /* 未知 blend 按覆盖处理（防御，不把整段变黑）。 */
    lumen_blend_pixel(0x7F, l0, l1, out);
    CHECK(out[0] == 1 && out[1] == 2 && out[2] == 3);

    /*
     * 按亮度叠加（§7.2.1）：a = max(L1)/255，out = L1 + L0 × (1 − a)。
     *
     * 这是「流星叠彩虹」的正确形状：L1 的黑处必须原样露出 L0，L1 的亮处
     * 必须完全接管，中间值按亮度线性混合。
     */
    /* L1 全黑 → L0 原样透出（这是 OVER 做不到的那一条）。 */
    uint8_t bg[3] = {200, 100, 50};
    lumen_blend_pixel(LUMEN_BLEND_LUMA, bg, zero, out);
    CHECK(out[0] == 200 && out[1] == 100 && out[2] == 50);
    /* L1 满亮 → 完全接管，等价于覆盖。 */
    lumen_blend_pixel(LUMEN_BLEND_LUMA, bg, full, out);
    CHECK(out[0] == 255 && out[1] == 255 && out[2] == 255);
    /* 单通道亮：纯红流星（255,0,0）叠在灰背景上，a 必须取 1，不能被 0 通道拉低。 */
    uint8_t red_stream[3] = {255, 0, 0};
    uint8_t grey[3] = {128, 128, 128};
    lumen_blend_pixel(LUMEN_BLEND_LUMA, grey, red_stream, out);
    CHECK(out[0] == 255 && out[1] == 0 && out[2] == 0);
    /* 半亮：a = 128/255，L0 保留 (255−128)/255 ≈ 一半。 */
    uint8_t half_white[3] = {128, 128, 128};
    lumen_blend_pixel(LUMEN_BLEND_LUMA, full, half_white, out);
    /* scaled = (255 × 127 + 127)/255 = 127；out = 128 + 127 = 255（钳位）。 */
    CHECK(out[0] == 255);
    uint8_t bg64[3] = {64, 64, 64};
    lumen_blend_pixel(LUMEN_BLEND_LUMA, bg64, half_white, out);
    /* scaled = (64 × 127 + 127)/255 = 32；out = 128 + 32 = 160。 */
    CHECK(out[0] == 160);
    /* L0 全黑 + L1 半亮 → 就是 L1 本身（背景不贡献光）。 */
    lumen_blend_pixel(LUMEN_BLEND_LUMA, zero, half_white, out);
    CHECK(out[0] == 128);

    /* 别名安全：out 与输入同一块内存。 */
    uint8_t alias[3] = {100, 100, 100};
    lumen_blend_pixel(LUMEN_BLEND_MULTIPLY, alias, alias, alias);
    CHECK(alias[0] == 39); /* (100*100+127)/255 = 39.7 → 39 */
    uint8_t alias_luma[3] = {100, 100, 100};
    lumen_blend_pixel(LUMEN_BLEND_LUMA, alias_luma, alias_luma, alias_luma);
    /* a = 100/255，keep = 155：scaled = (100×155+127)/255 = 61；out = 100+61 = 161。 */
    CHECK(alias_luma[0] == 161);
}

/*
 * 校验矩阵（§7.1 第 2-7 步）。每一条都构建完整段再问
 * lumen_segment_validate_shape——命令层 / 剧本层 / blob 解码共用它。
 */
static void test_two_layer_validation_matrix(void)
{
    /* 基线：单层静态段（合法）。 */
    lumen_segment_t ok = make_static(0, 4, 0, 255);
    CHECK(lumen_segment_validate_shape(&ok) == LUMEN_RESULT_OK);

    /* 第 2 步：layer0 为空层 0xFF → 非法。 */
    lumen_segment_t empty0 = ok;
    layer_clear(&empty0.layer[0]);
    CHECK(lumen_segment_validate_shape(&empty0) == LUMEN_RESULT_INVALID_PARAM);

    /* 第 2 步：layer0 未知 type → 非法。 */
    lumen_segment_t unknown0 = ok;
    unknown0.layer[0].type = 0x08;
    CHECK(lumen_segment_validate_shape(&unknown0) == LUMEN_RESULT_INVALID_PARAM);

    /* 第 3 步：layer1 未知 type → 非法。 */
    lumen_segment_t unknown1 = ok;
    layer_set(LUMEN_EFFECT_STATIC, 0, 128, 0, 0, 0, &unknown1.layer[0]);
    unknown1.layer[1].type = 0x08;
    CHECK(lumen_segment_validate_shape(&unknown1) == LUMEN_RESULT_INVALID_PARAM);

    /* 第 3 步：空层的 param 非 0 → 非法（防未来语义漂移）。 */
    lumen_segment_t dirty_empty = ok;
    layer_clear(&dirty_empty.layer[1]);
    dirty_empty.layer[1].param[0] = 0x01;
    CHECK(lumen_segment_validate_shape(&dirty_empty) == LUMEN_RESULT_INVALID_PARAM);

    /* 第 4 步：单层（layer1 空）但 blend != 0 → 非法。 */
    for (uint8_t blend = 0; blend <= 2; ++blend) {
        lumen_segment_t single = ok;
        single.blend = blend;
        CHECK(lumen_segment_validate_shape(&single) ==
              (blend == 0 ? LUMEN_RESULT_OK : LUMEN_RESULT_INVALID_PARAM));
    }

    /* 第 5 步：blend > 3 → 非法（两层都非空也一样）。0-3 都合法。 */
    lumen_segment_t two;
    memset(&two, 0, sizeof(two));
    layer_set(LUMEN_EFFECT_STATIC, 0, 255, 0, 0, 0, &two.layer[0]);
    layer_set(LUMEN_EFFECT_STATIC, 0, 128, 0, 0, 0, &two.layer[1]);
    for (uint8_t blend = 0; blend <= 3; ++blend) {
        two.blend = blend;
        CHECK(lumen_segment_validate_shape(&two) == LUMEN_RESULT_OK);
    }
    two.blend = 4;
    CHECK(lumen_segment_validate_shape(&two) == LUMEN_RESULT_INVALID_PARAM);
    two.blend = 0xFF;
    CHECK(lumen_segment_validate_shape(&two) == LUMEN_RESULT_INVALID_PARAM);

    /* 第 6 步：静态层 param[3..6] 必须全 0——layer0 与 layer1 都要查。 */
    lumen_segment_t res0 = two;
    res0.blend = 0;
    res0.layer[0].param[3] = 0x01;
    CHECK(lumen_segment_validate_shape(&res0) == LUMEN_RESULT_INVALID_PARAM);
    res0 = two;
    res0.blend = 0;
    res0.layer[0].param[6] = 0x01;
    CHECK(lumen_segment_validate_shape(&res0) == LUMEN_RESULT_INVALID_PARAM);
    lumen_segment_t res1 = two;
    res1.blend = 0;
    res1.layer[1].param[5] = 0x01;
    CHECK(lumen_segment_validate_shape(&res1) == LUMEN_RESULT_INVALID_PARAM);

    /* 第 7 步：呼吸周期低于 334、flags 保留位 → 非法；0（静止）合法。 */
    lumen_segment_t fast = make_animated(LUMEN_EFFECT_BREATHING, 0, 4, 0, 255, 333, 0, 0, 0);
    CHECK(lumen_segment_validate_shape(&fast) == LUMEN_RESULT_INVALID_PARAM);
    fast = make_animated(LUMEN_EFFECT_BREATHING, 0, 4, 0, 255, 334, 0, 0, 0);
    CHECK(lumen_segment_validate_shape(&fast) == LUMEN_RESULT_OK);
    fast = make_animated(LUMEN_EFFECT_BREATHING, 0, 4, 0, 255, 0, 0, 0, 0);
    CHECK(lumen_segment_validate_shape(&fast) == LUMEN_RESULT_OK);
    /* 呼吸 bit3-7 保留。 */
    fast = make_animated(LUMEN_EFFECT_BREATHING, 0, 4, 0, 255, 1000, 0, 0x08, 0);
    CHECK(lumen_segment_validate_shape(&fast) == LUMEN_RESULT_INVALID_PARAM);
    /* 彩虹 199 非法、200 合法、bit1-7 保留。 */
    fast = make_animated(LUMEN_EFFECT_RAINBOW, 0, 4, 0, 255, 199, 0, 0, 0);
    CHECK(lumen_segment_validate_shape(&fast) == LUMEN_RESULT_INVALID_PARAM);
    fast = make_animated(LUMEN_EFFECT_RAINBOW, 0, 4, 0, 255, 200, 0, 0, 0);
    CHECK(lumen_segment_validate_shape(&fast) == LUMEN_RESULT_OK);
    fast = make_animated(LUMEN_EFFECT_RAINBOW, 0, 4, 0, 255, 200, 0, 0x02, 0);
    CHECK(lumen_segment_validate_shape(&fast) == LUMEN_RESULT_INVALID_PARAM);

    /* 第二层的参数同样要校验（例如 layer1 呼吸周期 100ms）。 */
    lumen_segment_t bad1 = ok;
    layer_set(LUMEN_EFFECT_STATIC, 0, 255, 0, 0, 0, &bad1.layer[0]);
    layer_set(LUMEN_EFFECT_BREATHING, 0, 255, 100, 0, 0, &bad1.layer[1]);
    bad1.blend = LUMEN_BLEND_MULTIPLY;
    CHECK(lumen_segment_validate_shape(&bad1) == LUMEN_RESULT_INVALID_PARAM);
    layer_set(LUMEN_EFFECT_BREATHING, 0, 255, 1000, 0, 0, &bad1.layer[1]);
    CHECK(lumen_segment_validate_shape(&bad1) == LUMEN_RESULT_OK);

    /* 空层作为 layer1 的合法形态：param 全 0。 */
    lumen_segment_t empty1 = ok;
    layer_clear(&empty1.layer[1]);
    CHECK(lumen_segment_validate_shape(&empty1) == LUMEN_RESULT_OK);
}

/* 层编解码：9 字节线格式与结构一一对应（v4 多一个 level 字节）。 */
static void test_layer_codec(void)
{
    uint8_t wire[9];
    lumen_effect_layer_t layer;

    /* 动画层往返。 */
    layer_set(LUMEN_EFFECT_COMET, 0xBEEF, 0x80, 500, 0x40, 0x01, &layer);
    layer_set_level(&layer, 42);
    lumen_layer_encode(&layer, wire);
    CHECK(wire[0] == LUMEN_EFFECT_COMET);
    CHECK(wire[1] == 0xEF && wire[2] == 0xBE); /* hue 小端 */
    CHECK(wire[3] == 0x80);                    /* sat */
    CHECK(wire[4] == 0xF4 && wire[5] == 0x01); /* period 500 */
    CHECK(wire[6] == 0x40);                    /* p5 */
    CHECK(wire[7] == 0x01);                    /* flags */
    CHECK(wire[8] == 42);                      /* level（第 9 字节） */
    lumen_effect_layer_t back;
    CHECK(lumen_layer_decode(wire, &back));
    CHECK(back.type == layer.type);
    CHECK(memcmp(back.param, layer.param, 7) == 0);
    CHECK(lumen_layer_hue(&back) == 0xBEEF);
    CHECK(lumen_layer_sat(&back) == 0x80);
    CHECK(lumen_layer_period_ms(&back) == 500);
    CHECK(lumen_layer_p5(&back) == 0x40);
    CHECK(lumen_layer_flags(&back) == 0x01);
    CHECK(lumen_layer_level(&back) == 42);

    /* 空层：decode 成功、is_empty 为真、参数与 level 全 0。 */
    uint8_t empty_wire[9] = {LUMEN_LAYER_EMPTY, 0, 0, 0, 0, 0, 0, 0, 0};
    lumen_effect_layer_t empty;
    CHECK(lumen_layer_decode(empty_wire, &empty));
    CHECK(lumen_layer_is_empty(&empty));
    CHECK(lumen_layer_empty_params_zero(&empty));
    /* v4：空层带非零 level → 不再是「空层形态」。 */
    empty_wire[8] = 50;
    CHECK(lumen_layer_decode(empty_wire, &empty));
    CHECK(!lumen_layer_empty_params_zero(&empty));

    /* 未知 type：形状非法，但字节仍然完整复制（便于日志）。 */
    uint8_t unknown_wire[9] = {0x08, 1, 2, 3, 4, 5, 6, 7, 9};
    lumen_effect_layer_t unknown;
    CHECK(!lumen_layer_decode(unknown_wire, &unknown));
    CHECK(unknown.type == 0x08);
    CHECK(unknown.param[0] == 1 && unknown.param[6] == 7);
    CHECK(unknown.level == 9);

    /* 静态层保留位检查（level 是独立字节，不受 param[3..6]=0 约束）。 */
    lumen_effect_layer_t stat;
    layer_set(LUMEN_EFFECT_STATIC, 100, 200, 0, 0, 0, &stat);
    CHECK(lumen_layer_static_reserved_zero(&stat));
    stat.param[4] = 1;
    CHECK(!lumen_layer_static_reserved_zero(&stat));
    layer_set(LUMEN_EFFECT_STATIC, 100, 200, 0, 0, 0, &stat);
    layer_set_level(&stat, 30);
    CHECK(lumen_layer_static_reserved_zero(&stat));

    CHECK(!lumen_layer_decode(NULL, &back));
    CHECK(!lumen_layer_decode(wire, NULL));
}

/* ---------------- v4：层亮度（level）语义 ---------------- */

/*
 * 纯函数 lumen_effect_apply_level_q8：round(value × level / 100)。
 * 这是 v4 §9.3 第 1 步（逐层压暗）的全部数学。
 */
static void test_apply_level_q8(void)
{
    /* 0 档 → 全黑；100 档 → 原样；50 档 → 半亮（四舍五入）。 */
    CHECK(lumen_effect_apply_level_q8(255, 0) == 0);
    CHECK(lumen_effect_apply_level_q8(255, 100) == 255);
    CHECK(lumen_effect_apply_level_q8(255, 50) == 128); /* 127.5 → 128 */
    CHECK(lumen_effect_apply_level_q8(0, 100) == 0);
    CHECK(lumen_effect_apply_level_q8(0, 50) == 0);
    /* 单调性：level 越大越亮。 */
    uint8_t prev = 0;
    for (uint8_t level = 0; level <= 100; ++level) {
        uint8_t v = lumen_effect_apply_level_q8(200, level);
        CHECK(v >= prev);
        prev = v;
    }
    /* 防御：> 100 按 100 处理（命令层已拒绝，这里不让坏配置变黑）。 */
    CHECK(lumen_effect_apply_level_q8(255, 101) == 255);
    CHECK(lumen_effect_apply_level_q8(255, 255) == 255);
}

/*
 * 静态层的三档亮度：0 全黑、50 半亮、100 满亮。
 * 对应验收点「零档、五十档、一百档都能正确出光」。
 */
static void test_layer_level_static_steps(void)
{
    lumen_segment_t seg = make_static(0, 9, 0, 255); /* hue=0 sat=255 → 纯红 255,0,0 */
    uint8_t rgb[3];

    layer_set_level(&seg.layer[0], 100);
    lumen_effect_pixel(&seg, 3, 0, rgb);
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);

    layer_set_level(&seg.layer[0], 50);
    lumen_effect_pixel(&seg, 3, 0, rgb);
    CHECK(rgb[0] == 128 && rgb[1] == 0 && rgb[2] == 0);

    layer_set_level(&seg.layer[0], 0);
    lumen_effect_pixel(&seg, 3, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
}

/*
 * 两层各自的 level 独立生效：layer0 全亮红 × layer1 半亮红，相乘后
 * (255 × 128 + 127) / 255 = 128。证明 level 在**合成之前**逐层施加。
 */
static void test_layer_level_independent_per_layer(void)
{
    lumen_segment_t seg;
    memset(&seg, 0, sizeof(seg));
    seg.active = true;
    seg.start = 0;
    seg.end = 9;
    seg.blend = LUMEN_BLEND_MULTIPLY;
    layer_set(LUMEN_EFFECT_STATIC, 0, 255, 0, 0, 0, &seg.layer[0]);
    layer_set(LUMEN_EFFECT_STATIC, 0, 255, 0, 0, 0, &seg.layer[1]);
    layer_set_level(&seg.layer[0], 100);
    layer_set_level(&seg.layer[1], 50);

    uint8_t rgb[3];
    lumen_effect_pixel(&seg, 4, 0, rgb);
    CHECK(rgb[0] == 128 && rgb[1] == 0 && rgb[2] == 0);

    /* 两层的 level 都 50 → 128 × 128 / 255 ≈ 64。 */
    layer_set_level(&seg.layer[0], 50);
    lumen_effect_pixel(&seg, 4, 0, rgb);
    CHECK(rgb[0] >= 62 && rgb[0] <= 66);
}

/*
 * level 与全局 brightness 按**乘积**生效（§9.3 的验收点）：
 *
 *   out = gamma(round(level(255) × brightness / 255))
 *
 * level 50 把 255 压到 128，brightness 128 再压到 64，gamma 一次得 28。
 * 全亮度（level 100 + brightness 255）仍是 255。
 */
static void test_level_times_brightness_then_gamma_once(void)
{
    lumen_gamma_init();
    lumen_segment_t seg = make_static(0, 9, 0, 255);
    uint8_t user[3];
    uint8_t out[3];

    /* level = 50：layer_pixel 交出用户空间 128。 */
    layer_set_level(&seg.layer[0], 50);
    lumen_effect_pixel(&seg, 2, 0, user);
    CHECK(user[0] == 128);

    /* 再乘全局 brightness 128 → 64，然后 gamma 一次。 */
    lumen_gamma_apply_pixel_scaled(user, 128, out);
    CHECK(out[0] == lumen_gamma_apply((uint8_t)64, 255));
    CHECK(out[0] == 28);

    /* 满亮满亮度：端到端 255。 */
    layer_set_level(&seg.layer[0], 100);
    lumen_effect_pixel(&seg, 2, 0, user);
    CHECK(user[0] == 255);
    lumen_gamma_apply_pixel_scaled(user, 255, out);
    CHECK(out[0] == 255);
}

/*
 * 亮度校验：> 100 拒绝；空层 level 必须为 0；呼吸 p5 > 100 拒绝；
 * 静态层 param[3..6] 规则不受 level 影响（level 是独立字节）。
 */
static void test_layer_level_validation(void)
{
    /* layer0 level 101 → 非法；100 / 0 合法。 */
    lumen_segment_t seg = make_static(0, 9, 0, 255);
    layer_set_level(&seg.layer[0], 101);
    CHECK(lumen_segment_validate_shape(&seg) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_level(&seg.layer[0], 100);
    CHECK(lumen_segment_validate_shape(&seg) == LUMEN_RESULT_OK);
    layer_set_level(&seg.layer[0], 0);
    CHECK(lumen_segment_validate_shape(&seg) == LUMEN_RESULT_OK);

    /* 空层（layer1）level != 0 → 非法。 */
    lumen_segment_t empty_level = make_static(0, 9, 0, 255);
    empty_level.layer[1].type = LUMEN_LAYER_EMPTY;
    empty_level.layer[1].level = 1;
    CHECK(lumen_segment_validate_shape(&empty_level) == LUMEN_RESULT_INVALID_PARAM);
    empty_level.layer[1].level = 0;
    CHECK(lumen_segment_validate_shape(&empty_level) == LUMEN_RESULT_OK);

    /* 第 2 层 level 101 同样非法。 */
    lumen_segment_t two;
    memset(&two, 0, sizeof(two));
    two.active = true;
    two.start = 0;
    two.end = 9;
    two.blend = LUMEN_BLEND_MULTIPLY;
    layer_set(LUMEN_EFFECT_STATIC, 0, 255, 0, 0, 0, &two.layer[0]);
    layer_set(LUMEN_EFFECT_STATIC, 0, 128, 0, 0, 0, &two.layer[1]);
    layer_set_level(&two.layer[1], 101);
    CHECK(lumen_segment_validate_shape(&two) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_level(&two.layer[1], 100);
    CHECK(lumen_segment_validate_shape(&two) == LUMEN_RESULT_OK);

    /* 静态层 param[3..6] 仍须全 0，与 level 无关。 */
    lumen_segment_t reserved = make_static(0, 9, 0, 255);
    layer_set_level(&reserved.layer[0], 40);
    CHECK(lumen_segment_validate_shape(&reserved) == LUMEN_RESULT_OK);
    reserved.layer[0].param[3] = 1;
    CHECK(lumen_segment_validate_shape(&reserved) == LUMEN_RESULT_INVALID_PARAM);

    /* 呼吸 p5（minLevel 百分比）> 100 → 非法；100 合法。 */
    lumen_segment_t breath = make_animated(LUMEN_EFFECT_BREATHING, 0, 9, 0, 255, 1000, 101, 0, 0);
    CHECK(lumen_segment_validate_shape(&breath) == LUMEN_RESULT_INVALID_PARAM);
    layer_set_p5(&breath.layer[0], 100);
    CHECK(lumen_segment_validate_shape(&breath) == LUMEN_RESULT_OK);
    layer_set_p5(&breath.layer[0], 0);
    CHECK(lumen_segment_validate_shape(&breath) == LUMEN_RESULT_OK);
}



/*
 * 呼吸谷底 = level × minLevel%（v4 的核心语义）。
 *
 * level = 100、min_pct = 50 → 谷底 50%（≈128）；
 * level = 50、min_pct = 100 → 谷底 = 峰值 = 50%（≈128），完全不呼吸；
 * level = 50、min_pct = 0  → 谷底 0、峰值 50%（≈128）。
 */
static void test_breathing_floor_is_level_times_min_pct(void)
{
    const uint16_t period = 1000;
    const uint8_t wave = LUMEN_WAVE_SINE;

    /* level 100、min 50：谷底 ≈ 0.5 × 65536。 */
    uint32_t g = lumen_effect_breathing_gain_pct_q16(period, 50, 100, wave, 0, 0);
    CHECK(g >= 32700u && g <= 32900u);
    /* 峰值仍是满亮。 */
    g = lumen_effect_breathing_gain_pct_q16(period, 50, 100, wave, 0, 500);
    CHECK(g >= 65534u);

    /* level 50、min 100：恒定 50%，不呼吸。 */
    uint32_t a = lumen_effect_breathing_gain_pct_q16(period, 100, 50, wave, 0, 0);
    uint32_t b = lumen_effect_breathing_gain_pct_q16(period, 100, 50, wave, 0, 500);
    CHECK(a == b);
    CHECK(a >= 32700u && a <= 32900u);

    /* level 50、min 0：谷底 0、峰值 50%。 */
    CHECK(lumen_effect_breathing_gain_pct_q16(period, 0, 50, wave, 0, 0) == 0);
    uint32_t peak = lumen_effect_breathing_gain_pct_q16(period, 0, 50, wave, 0, 500);
    CHECK(peak >= 32700u && peak <= 32900u);

    /* level 0：任何时刻都是 0（这一层不出光）。 */
    CHECK(lumen_effect_breathing_gain_pct_q16(period, 50, 0, wave, 0, 500) == 0);

    /* 像素级验证：level 50、min 100 → 恒约 128（红）。 */
    lumen_segment_t seg = seg_single(LUMEN_EFFECT_BREATHING, 0, 9, 0, 255, 1000, 100, 0, 0);
    layer_set_level(&seg.layer[0], 50);
    uint8_t r0[3];
    uint8_t r500[3];
    lumen_effect_pixel(&seg, 3, 0, r0);
    lumen_effect_pixel(&seg, 3, 500, r500);
    CHECK(r0[0] >= 126 && r0[0] <= 130);
    CHECK(memcmp(r0, r500, 3) == 0);
}

/*
 * gamma 只过一次：**在用户空间 blend，然后统一过 gamma**。
 *
 * 验收点「彩虹 + 呼吸相乘后暗部不塌陷」。两种顺序在这里给出可区分的数值：
 *
 *   正确：out = gamma(multiply(L0_user, L1_user))
 *   错误：out = multiply(gamma(L0_user), gamma(L1_user))
 *
 * gamma 是凸函数（暗部压缩），先 gamma 再相乘会让结果远小于正确顺序，
 * 这就是「暗部塌陷」。测试同时断言正确值与非零，并证明错误顺序确实更低。
 */
static void test_blend_gamma_once(void)
{
    lumen_gamma_init();

    /*
     * 取一组「暗部」输入：L0 = 64（彩虹的暗通道）、L1 = 96（呼吸的谷底附近）。
     * 用户空间相乘：64 × 96 = 6144，(6144+127)/255 = 24。
     */
    uint8_t l0[3] = {64, 64, 64};
    uint8_t l1[3] = {96, 96, 96};
    uint8_t user[3];
    lumen_blend_pixel(LUMEN_BLEND_MULTIPLY, l0, l1, user);
    CHECK(user[0] == 24);

    /* 正确顺序：用户空间合成后 gamma 一次。 */
    uint8_t once[3];
    lumen_gamma_apply_pixel(user, 255, once);

    /* 错误顺序：先 gamma 再合成。 */
    uint8_t gl0[3];
    uint8_t gl1[3];
    lumen_gamma_apply_pixel(l0, 255, gl0);
    lumen_gamma_apply_pixel(l1, 255, gl1);
    uint8_t twice[3];
    lumen_blend_pixel(LUMEN_BLEND_MULTIPLY, gl0, gl1, twice);

    /*
     * 关键断言：正确顺序的值必须**明显大于**错误顺序（gamma 是凸函数，
     * 先压缩再相乘会在暗部塌陷），而且必须非零。
     * 真实数值：gamma(64)≈31, gamma(96)≈48 → 错误 ≈ 6；正确 gamma(24)≈11。
     */
    CHECK(once[0] > 0);
    CHECK(twice[0] > 0);
    CHECK(once[0] > twice[0]);
    CHECK(once[0] == lumen_gamma_apply(24, 255));
    /* 用同一个 gamma 表交叉验证「错误顺序确实被压得更低」。 */
    CHECK(lumen_gamma_apply(24, 255) > lumen_gamma_apply(6, 255));

    /*
     * 整段路径：彩虹 + 呼吸相乘。layer0 用 period = 0（静止：色相恒为 0 →
     * 纯红，span = 0 整段同色），layer1 用 min_level = 0（真正会到全黑），
     * 这样只有呼吸在驱动时间，便于逐通道核对。
     * t=0 时呼吸谷底全黑 → 相乘整段黑；t=500 时呼吸峰值 → 结果等于彩虹本身。
     */
    test_seg_store_t store;
    test_seg_init(&store);
    lumen_segment_t seg;
    memset(&seg, 0, sizeof(seg));
    seg.active = true;
    seg.start = 0;
    seg.end = 15;
    seg.blend = LUMEN_BLEND_MULTIPLY;
    layer_set(LUMEN_EFFECT_RAINBOW, 0, 255, 0, 0, 0, &seg.layer[0]);
    layer_set(LUMEN_EFFECT_BREATHING, 0, 255, 1000, 0, 0, &seg.layer[1]);
    CHECK(lumen_segment_validate_shape(&seg) == LUMEN_RESULT_OK);
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &seg) == LUMEN_RESULT_OK);

    uint8_t dark[64 * 3];
    uint8_t bright[64 * 3];
    CHECK(test_seg_compose(&store, 0, dark, 64, 0) == 64);
    CHECK(test_seg_compose(&store, 0, bright, 64, 500) == 64);
    /* t=0：呼吸包络 0（min_level 0）→ 相乘为 0。 */
    for (uint16_t i = 0; i < 16; ++i) {
        CHECK(dark[i * 3] == 0 && dark[i * 3 + 1] == 0 && dark[i * 3 + 2] == 0);
    }
    /* t=500：呼吸满亮 → 与纯彩虹（单层）逐字节相同。 */
    test_seg_store_t pure;
    test_seg_init(&pure);
    lumen_segment_t solo = make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 0, 0, 0, 0);
    CHECK(test_seg_set(&pure, 0, 1, 0, 64, &solo) == LUMEN_RESULT_OK);
    uint8_t reference[64 * 3];
    CHECK(test_seg_compose(&pure, 0, reference, 64, 500) == 64);
    CHECK(memcmp(&bright[0], &reference[0], 16 * 3) == 0);

    /*
     * 中间时刻（呼吸半亮）的暗部必须不塌陷：彩虹段是纯红 (255,0,0)，
     * 与呼吸相乘后 R 约减半——远高于「先 gamma 再相乘」会把暗部压到的个位数。
     */
    uint8_t mid[64 * 3];
    CHECK(test_seg_compose(&store, 0, mid, 64, 250) == 64);
    uint8_t l0_pixel[3];
    uint8_t l1_pixel[3];
    lumen_layer_pixel(&seg, 0, 0, 250, l0_pixel);
    lumen_layer_pixel(&seg, 1, 0, 250, l1_pixel);
    uint8_t expected_user[3];
    lumen_blend_pixel(LUMEN_BLEND_MULTIPLY, l0_pixel, l1_pixel, expected_user);
    CHECK(mid[0] == expected_user[0]);
    CHECK(mid[0] > 0);
    /* 用户空间值（未经 gamma）必须等于合成结果——证明层里没偷偷过 gamma。 */
    CHECK(l0_pixel[0] == 255); /* 彩虹段首满红（用户空间） */
    CHECK(expected_user[0] > 100);
}

/* 两层的相位共享段上的 t0_ms（§9.4）。 */
static void test_two_layer_shared_phase(void)
{
    lumen_segment_t seg;
    memset(&seg, 0, sizeof(seg));
    seg.active = true;
    seg.start = 0;
    seg.end = 15;
    seg.blend = LUMEN_BLEND_ADD;
    /* 两层参数完全相同（同 hue / period），只是类型不同。 */
    layer_set(LUMEN_EFFECT_BREATHING, 0, 255, 1000, 0, 0, &seg.layer[0]);
    layer_set(LUMEN_EFFECT_BREATHING, 0, 255, 1000, 0, 0, &seg.layer[1]);
    seg.t0_ms = 1000;

    /* 两层在任意时刻的包络相同 → 相加是 2 × 单层，饱和钳位。 */
    for (uint32_t t = 1000; t <= 2000; t += 250) {
        uint8_t l0[3];
        uint8_t l1[3];
        uint8_t composed[3];
        lumen_layer_pixel(&seg, 0, 5, t, l0);
        lumen_layer_pixel(&seg, 1, 5, t, l1);
        CHECK(memcmp(l0, l1, 3) == 0); /* 共享同一个 t0_ms */
        lumen_effect_pixel(&seg, 5, t, composed);
        uint16_t sum = (uint16_t)l0[0] + (uint16_t)l1[0];
        CHECK(composed[0] == (sum > 255 ? 255 : sum));
    }

    /* 两层的不活动段 / 越界下标都返回全黑，不崩。 */
    uint8_t out[3];
    seg.active = false;
    lumen_layer_pixel(&seg, 0, 5, 0, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);
    seg.active = true;
    lumen_layer_pixel(&seg, 0, 99, 0, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);
    lumen_layer_pixel(&seg, 2, 5, 0, out); /* layer_index 越界 */
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);
    lumen_layer_pixel(NULL, 0, 5, 0, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);
    lumen_blend_pixel(LUMEN_BLEND_ADD, NULL, NULL, out); /* 不崩 */
}

/*
 * v5 的体积记录：层 9 字节、段 28 字节；**段表与剧本表已删除**
 * （布局 2696 B + 三个场景 31590 B 取代了 v4 的 1792 B 段表与 ~70 KB 剧本表，
 * 净省约 35 KB，见 docs/protocol-v5.md §11）。
 */
static void test_two_layer_ram_sizes(void)
{
    /* 段：active(1) + start/end/blend(3) + 2 × layer(9) + t0_ms(4) = 25，
     * 因 4 字节对齐涨到 28。 */
    CHECK(sizeof(lumen_effect_layer_t) == 9);
    CHECK(sizeof(lumen_segment_t) == 28);
    /* 一步：duration(2) + 两层各 9 = 20（场景的最小单位）。 */
    CHECK(sizeof(lumen_scene_step_t) == 20);
    /* 一个部位：step_count / loop / on(3) + 对齐 + 8 步 × 20 = 164。 */
    CHECK(sizeof(lumen_part_scene_t) == 164);
}

/*
 * 两层的帧循环判据：layer1 是动画也必须驱动帧循环。
 */
static void test_two_layer_needs_frames(void)
{
    test_seg_store_t store;
    test_seg_init(&store);

    /* 静态 + 静态（相乘）：常量画面，不需要帧循环。 */
    lumen_segment_t both_static;
    memset(&both_static, 0, sizeof(both_static));
    both_static.active = true;
    both_static.start = 0;
    both_static.end = 9;
    both_static.blend = LUMEN_BLEND_MULTIPLY;
    layer_set(LUMEN_EFFECT_STATIC, 0, 255, 0, 0, 0, &both_static.layer[0]);
    layer_set(LUMEN_EFFECT_STATIC, 0, 128, 0, 0, 0, &both_static.layer[1]);
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &both_static) == LUMEN_RESULT_OK);
    CHECK(!test_seg_needs_frames(&store, 1));
    CHECK(!lumen_segment_is_animated(&both_static));

    /* 静态 + 呼吸（相加）：layer1 动画 → 需要帧循环。 */
    lumen_segment_t layer1_anim = both_static;
    layer1_anim.blend = LUMEN_BLEND_ADD;
    layer_set(LUMEN_EFFECT_BREATHING, 0, 255, 1000, 0, 0, &layer1_anim.layer[1]);
    CHECK(lumen_segment_is_animated(&layer1_anim));
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &layer1_anim) == LUMEN_RESULT_OK);
    CHECK(test_seg_needs_frames(&store, 1));

    /* 单层静态仍然不需要（v2 的「静态不空转」不退化）。 */
    test_seg_init(&store);
    lumen_segment_t single = make_static(0, 9, 0, 255);
    CHECK(test_seg_set(&store, 0, 1, 0, 64, &single) == LUMEN_RESULT_OK);
    CHECK(!test_seg_needs_frames(&store, 1));

    /* 非活动段永远不算动画。 */
    lumen_segment_t idle = layer1_anim;
    idle.active = false;
    CHECK(!lumen_segment_is_animated(&idle));
}



/*
 * 色相丢失截断（#30 真机缺陷回归）：
 * 橙色呼吸到极暗处，G 先归零、R 还剩 1~2 —— 屏幕上是纯红，看起来像「闪一下红」。
 * 规则：输入 ≥2 通道非零、输出 <2 通道非零 → 整颗归零。
 */
static void test_gamma_hue_loss_clip(void)
{
    lumen_gamma_init();
    uint8_t out[3];

    /* 正常亮度：橙色完整保留。 */
    uint8_t orange[3] = {255, 128, 0};
    lumen_gamma_apply_pixel(orange, 200, out);
    CHECK(out[0] > 0);
    CHECK(out[1] > 0);

    /* 呼吸中段（e≈0.03）：仍然保色。 */
    uint8_t dim[3] = {8, 4, 0};
    lumen_gamma_apply_pixel(dim, 200, out);
    CHECK(out[0] > 0);
    CHECK(out[1] > 0);

    /*
     * 失真窗口（e≈0.010）：输入 (3,1,0) 两个通道非零，
     * gamma+亮度后 G 归零只剩 R → 必须整颗截断成黑，不能显示纯红。
     */
    uint8_t lossy[3] = {3, 1, 0};
    lumen_gamma_apply_pixel(lossy, 200, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);

    uint8_t lossy2[3] = {2, 1, 0};
    lumen_gamma_apply_pixel(lossy2, 200, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);

    /* 纯色不受影响：单通道输入即使很暗也保留（它本来就没有色相可丢）。 */
    uint8_t pure_red[3] = {3, 0, 0};
    lumen_gamma_apply_pixel(pure_red, 200, out);
    CHECK(out[0] >= 0); /* 不强制非零，关键是没被规则误杀成异常 */
    uint8_t bright_red[3] = {255, 0, 0};
    lumen_gamma_apply_pixel(bright_red, 200, out);
    CHECK(out[0] > 0 && out[1] == 0 && out[2] == 0);

    /* 纯白（三通道）极暗时也保色，不会被误截。 */
    uint8_t white[3] = {5, 5, 5};
    lumen_gamma_apply_pixel(white, 200, out);
    CHECK(out[0] == out[1] && out[1] == out[2]);

    /* 全黑保持黑。 */
    uint8_t black[3] = {0, 0, 0};
    lumen_gamma_apply_pixel(black, 200, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);

    /* 关灯（brightness=0）：多通道输入全部归零且不违反规则。 */
    uint8_t on[3] = {255, 128, 0};
    lumen_gamma_apply_pixel(on, 0, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);

    /* 原地调用（in 与 out 同一块内存）必须安全。 */
    uint8_t inplace[3] = {255, 128, 0};
    lumen_gamma_apply_pixel(inplace, 200, inplace);
    CHECK(inplace[0] > 0 && inplace[1] > 0);

    /*
     * v4 的 lumen_gamma_apply_pixel_scaled 必须保留同一条截断规则
     * （它作用在「已乘亮度」的值上，但只要输入是多通道就必须同样保色）。
     */
    lumen_gamma_apply_pixel_scaled(orange, 200, out);
    CHECK(out[0] > 0 && out[1] > 0);
    lumen_gamma_apply_pixel_scaled(dim, 200, out);
    CHECK(out[0] > 0 && out[1] > 0);
    lumen_gamma_apply_pixel_scaled(lossy, 200, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);
    lumen_gamma_apply_pixel_scaled(lossy2, 200, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);
    lumen_gamma_apply_pixel_scaled(bright_red, 200, out);
    CHECK(out[0] > 0 && out[1] == 0 && out[2] == 0);
    lumen_gamma_apply_pixel_scaled(white, 200, out);
    CHECK(out[0] == out[1] && out[1] == out[2]);
    lumen_gamma_apply_pixel_scaled(black, 200, out);
    CHECK(out[0] == 0 && out[1] == 0 && out[2] == 0);
    uint8_t inplace_scaled[3] = {255, 128, 0};
    lumen_gamma_apply_pixel_scaled(inplace_scaled, 200, inplace_scaled);
    CHECK(inplace_scaled[0] > 0 && inplace_scaled[1] > 0);
}

/* ================= v5（#155）：布局存储 ================= */

/* 建一条 3 部位 / 1 链的典型布局：眼灯 0-1、监视器 2、散热 3-9（30 灯）。 */
static void build_three_parts(lumen_layout_store_t *layout)
{
    lumen_layout_store_init(layout);
    CHECK(lumen_layout_store_write(layout, 0, 3, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_part(layout, 0, 0, 6, (const uint8_t *)"眼灯", 1, LUMEN_PHASE_CONTINUOUS, 1) ==
          LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_part(layout, 0, 1, 0, NULL, 1, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_part(layout, 0, 2, 0, NULL, 1, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(layout, 0, 0, 0, 0, 1, 30, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(layout, 0, 1, 0, 2, 2, 30, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(layout, 0, 2, 0, 3, 9, 30, 1) == LUMEN_RESULT_OK);
}

static void test_layout_sizes(void)
{
    /* 编译期断言之外再在运行时钉一次：这两块 RAM 的预算进验收报告。 */
    CHECK(sizeof(lumen_part_layout_t) == 43);
    CHECK(sizeof(lumen_layout_store_t) == 2760);
    CHECK(LUMEN_LAYOUT_BLOB_SIZE == 2824);
    CHECK(LUMEN_LAYOUT_BLOB_SIZE <= LUMEN_LAYOUT_BLOB_MAX);
    /* 每部位记录的内部分量：名字 + 段数 + 相位 + 8 段 × 2 字节。 */
    CHECK(LUMEN_MAX_PART_SEGS * 2 + 1 + LUMEN_NAME_BYTES + 1 + 1 == 43);
}

static void test_layout_part_of_pixel(void)
{
    lumen_layout_store_t layout;
    build_three_parts(&layout);

    /* 每颗灯珠归属谁（S3：一颗只属一个部位）。 */
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 0) == 0);
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 1) == 0);
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 2) == 1);
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 3) == 2);
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 9) == 2);
    /* 未覆盖的灯珠恒黑 → 归属是 NONE，不是 0（不能误归给眼灯）。 */
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 10) == LUMEN_PART_NONE);
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 29) == LUMEN_PART_NONE);
    /* 别的链没有任何部位。 */
    CHECK(lumen_layout_part_of_pixel(&layout, 1, 0) == LUMEN_PART_NONE);

    CHECK(lumen_layout_store_has_segments(&layout, 0));
    CHECK(!lumen_layout_store_has_segments(&layout, 1));
}

static void test_layout_write_clears(void)
{
    lumen_layout_store_t layout;
    build_three_parts(&layout);

    /* LayoutWrite 声明新数量：名字与段全清（§6.1 第 1 条）。 */
    CHECK(lumen_layout_store_write(&layout, 0, 2, 1) == LUMEN_RESULT_OK);
    CHECK(layout.part_count[0] == 2);
    const lumen_part_layout_t *p0 = lumen_layout_store_part(&layout, 0, 0);
    CHECK(p0 != NULL);
    CHECK(p0->name_len == 0);
    CHECK(p0->segs.seg_count == 0);
    CHECK(!lumen_layout_store_has_segments(&layout, 0));
    /* 被缩掉的第 3 个部位不再可见。 */
    CHECK(lumen_layout_store_part(&layout, 0, 2) == NULL);

    /* 0 个部位：这条链没有部位，未覆盖灯珠恒黑。 */
    CHECK(lumen_layout_store_write(&layout, 0, 0, 1) == LUMEN_RESULT_OK);
    CHECK(layout.part_count[0] == 0);
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 0) == LUMEN_PART_NONE);

    /* 越界拒绝且不改动。 */
    CHECK(lumen_layout_store_write(&layout, 0, 9, 1) == LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_layout_store_write(&layout, 8, 1, 8) == LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_layout_store_write(&layout, 1, 1, 1) == LUMEN_RESULT_INVALID_PARAM);
    CHECK(layout.part_count[0] == 0);
}

static void test_layout_part_name_padding(void)
{
    lumen_layout_store_t layout;
    lumen_layout_store_init(&layout);
    CHECK(lumen_layout_store_write(&layout, 0, 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_part(&layout, 0, 0, 6, (const uint8_t *)"眼灯", 0, LUMEN_PHASE_CONTINUOUS, 1) ==
          LUMEN_RESULT_OK);

    const lumen_part_layout_t *p = lumen_layout_store_part(&layout, 0, 0);
    CHECK(p != NULL);
    CHECK(p->name_len == 6);
    /* 6 字节 UTF-8 之后必须全是 0（NUL 补齐，§6.1 第 2 条）。 */
    for (uint8_t i = 6; i < LUMEN_NAME_BYTES; ++i) {
        CHECK(p->name[i] == 0);
    }

    /* 空名合法（name_len = 0）。 */
    CHECK(lumen_layout_store_set_part(&layout, 0, 0, 0, NULL, 0, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);
    CHECK(p->name_len == 0);

    /* 25 字节超上限。 */
    uint8_t too_long[32];
    memset(too_long, 'A', sizeof(too_long));
    CHECK(lumen_layout_store_set_part(&layout, 0, 0, 25, too_long, 0, LUMEN_PHASE_CONTINUOUS, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
    /* 恰好 24 字节合法。 */
    CHECK(lumen_layout_store_set_part(&layout, 0, 0, 24, too_long, 0, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);
    CHECK(p->name_len == 24);
    /* part_id 超过已声明数量。 */
    CHECK(lumen_layout_store_set_part(&layout, 0, 1, 0, NULL, 0, LUMEN_PHASE_CONTINUOUS, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
    /* seg_count 超上限。 */
    CHECK(lumen_layout_store_set_part(&layout, 0, 0, 0, NULL, 9, LUMEN_PHASE_CONTINUOUS, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
}

static void test_layout_seg_rejects_overlap(void)
{
    lumen_layout_store_t layout;
    build_three_parts(&layout);

    /*
     * S4：压到别的部位 → 整个命令拒绝，且**别的部位一块灯珠都没变**。
     * 散热占 3-9，眼灯想占 5-5 必须被拒。
     */
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 0, 5, 5, 30, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_layout_store_part(&layout, 0, 2)->segs.seg[0][0] == 3);
    CHECK(lumen_layout_store_part(&layout, 0, 2)->segs.seg[0][1] == 9);
    CHECK(lumen_layout_store_part(&layout, 0, 0)->segs.seg[0][0] == 0);
    CHECK(lumen_layout_store_part(&layout, 0, 0)->segs.seg[0][1] == 1);
    /* 不自动裁剪：眼灯自己的旧段也保持原样。 */
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 0) == 0);

    /* 半开区间不算冲突（3-9 与 10-12 相邻合法）。先把散热的段数放宽到 2。 */
    CHECK(lumen_layout_store_set_part(&layout, 0, 2, 0, NULL, 2, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 2, 0, 3, 9, 30, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 2, 1, 10, 12, 30, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 11) == 2);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 0, 11, 11, 30, 1) ==
          LUMEN_RESULT_INVALID_PARAM);

    /* 同一部位的另一个段也不能与自己的其它段冲突。 */
    CHECK(lumen_layout_store_part(&layout, 0, 2)->segs.seg_count == 2);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 2, 0, 5, 20, 30, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
    /* 替换自身不算冲突（段号相同）。 */
    CHECK(lumen_layout_store_set_seg(&layout, 0, 2, 0, 3, 9, 30, 1) == LUMEN_RESULT_OK);

    /* 段号 ≥ seg_count 被拒（必须先 LayoutPart 声明数量）。 */
    CHECK(lumen_layout_store_set_seg(&layout, 0, 2, 2, 20, 21, 30, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
}

/*
 * 分帧下发：LayoutPart 声明 seg_count 后、LayoutSeg 到达之前，剩下的槽位是
 * 「未写」而不是 0-0。否则第二个段会被误判成占用 0-0，把合法的 1-2 顶掉。
 */
static void test_layout_partial_write(void)
{
    lumen_layout_store_t layout;
    lumen_layout_store_init(&layout);
    CHECK(lumen_layout_store_write(&layout, 0, 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_part(&layout, 0, 0, 0, NULL, 2, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);

    /* 只写了段 1，段 0 还没到：段 1 不该被「段 0 的 0-0」顶掉。 */
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 1, 1, 2, 30, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 1) == 0);
    /* 未写的槽位不该占住灯珠 0。 */
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 0) == LUMEN_PART_NONE);
    /* 此时整份校验必须失败：声明了 2 段却只写了 1 段。 */
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};
    CHECK(lumen_layout_store_validate(&layout, 1, counts) == LUMEN_RESULT_INVALID_PARAM);

    /* 补上段 0 之后整份合法。 */
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 0, 0, 0, 30, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_validate(&layout, 1, counts) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 0) == 0);
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 1) == 0);
    CHECK(lumen_layout_part_of_pixel(&layout, 0, 2) == 0);
}

static void test_layout_seg_range(void)
{
    lumen_layout_store_t layout;
    lumen_layout_store_init(&layout);
    CHECK(lumen_layout_store_write(&layout, 0, 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_part(&layout, 0, 0, 0, NULL, 2, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);

    /* start > end → 拒。 */
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 0, 10, 9, 30, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
    /* end ≥ led_count → 拒（30 灯的链上第 30 颗是 0..29）。 */
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 0, 29, 30, 30, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
    /* end == led_count-1 合法。 */
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 0, 25, 29, 30, 1) == LUMEN_RESULT_OK);
    /* 单颗段合法。 */
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 1, 7, 7, 30, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_part_pixel_count(lumen_layout_store_part(&layout, 0, 0)) == 5 + 1);

    /* 一条链只能占 8 段 × 8 部位。 */
    CHECK(LUMEN_MAX_PART_SEGS == 8);
    CHECK(LUMEN_MAX_PARTS == 8);
}

static void test_layout_multi_segment_logical_index(void)
{
    /* 一个部位占 1-5 与 20-25（对称部位，S5 / S6）。 */
    lumen_part_layout_t part;
    memset(&part, 0, sizeof(part));
    part.segs.seg_count = 2;
    part.segs.seg[0][0] = 1;
    part.segs.seg[0][1] = 5;
    part.segs.seg[1][0] = 20;
    part.segs.seg[1][1] = 25;

    CHECK(lumen_layout_part_pixel_count(&part) == 5 + 6);

    /* 连续相位：逻辑下标是升序名次 → 1..5 是 0..4，20..25 是 5..10。 */
    part.phase = LUMEN_PHASE_CONTINUOUS;
    CHECK(lumen_layout_logical_index(&part, 1) == 0);
    CHECK(lumen_layout_logical_index(&part, 5) == 4);
    CHECK(lumen_layout_logical_index(&part, 20) == 5);
    CHECK(lumen_layout_logical_index(&part, 25) == 10);

    /* 各自起点相位：第二段从自己的 0 开始。相位取自部位自己的字段（S6）。 */
    part.phase = LUMEN_PHASE_PER_SEGMENT;
    CHECK(lumen_layout_logical_index(&part, 20) == 0);
    CHECK(lumen_layout_logical_index(&part, 25) == 5);
    CHECK(lumen_layout_logical_index(&part, 3) == 2);
    part.phase = LUMEN_PHASE_CONTINUOUS;

    /* 段顺序颠倒不影响结果（LayoutSeg 逐条写，写入顺序不该影响相位）。 */
    lumen_part_layout_t swapped = part;
    swapped.segs.seg[0][0] = 20;
    swapped.segs.seg[0][1] = 25;
    swapped.segs.seg[1][0] = 1;
    swapped.segs.seg[1][1] = 5;
    for (uint8_t i = 1; i <= 5; ++i) {
        uint16_t want = (uint16_t)(i - 1);
        CHECK(lumen_layout_logical_index(&swapped, i) == want);
    }
    for (uint8_t i = 20; i <= 25; ++i) {
        uint16_t want = (uint16_t)(i - 20 + 5);
        CHECK(lumen_layout_logical_index(&swapped, i) == want);
    }
}

static void test_layout_validate_whole(void)
{
    lumen_layout_store_t layout;
    build_three_parts(&layout);

    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};
    CHECK(lumen_layout_store_validate(&layout, 1, counts) == LUMEN_RESULT_OK);
    /* 没有灯珠数表时按协议上限 100 校验，仍然合法。 */
    CHECK(lumen_layout_store_validate(&layout, 1, NULL) == LUMEN_RESULT_OK);

    /* 段超出该链真实灯珠数 → 整份拒（散热是 3-9，链只有 5 颗时越界）。 */
    uint16_t short_counts[LUMEN_MAX_STRIPS] = {5, 0, 0, 0, 0, 0, 0, 0};
    CHECK(lumen_layout_store_validate(&layout, 1, short_counts) == LUMEN_RESULT_INVALID_PARAM);

    /* 未配置的链上有内容 → 整份拒（半套布局不许悄悄留着）。 */
    CHECK(lumen_layout_store_write(&layout, 3, 1, 4) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_validate(&layout, 1, counts) == LUMEN_RESULT_INVALID_PARAM);

    /* 链数越界。 */
    CHECK(lumen_layout_store_validate(&layout, 0, counts) == LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_layout_store_validate(&layout, 9, counts) == LUMEN_RESULT_INVALID_PARAM);
}

static void test_layout_blob_roundtrip(void)
{
    lumen_layout_store_t layout;
    build_three_parts(&layout);
    /* 散热的段数先放宽到 2，再写第二个不连续段。 */
    CHECK(lumen_layout_store_set_part(&layout, 0, 2, 0, NULL, 2, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 2, 0, 3, 9, 30, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 2, 1, 20, 25, 30, 1) == LUMEN_RESULT_OK);

    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 60, 0, 0, 0, 0, 0, 0};
    uint8_t blob[LUMEN_LAYOUT_BLOB_MAX];
    size_t n = lumen_layout_blob_encode(&layout, 2, counts, blob, sizeof(blob));
    CHECK(n == LUMEN_LAYOUT_BLOB_SIZE);

    /* magic / 版本 / 链数逐字节可读。 */
    CHECK(blob[0] == 'L' && blob[1] == 'M' && blob[2] == 'L' && blob[3] == '1');
    CHECK(blob[4] == LUMEN_LAYOUT_BLOB_VERSION);
    CHECK(blob[5] == 2);
    /* 每链记录：led_count | part_count | 6 个保留字节全 0。 */
    CHECK(blob[8] == 30);
    CHECK(blob[9] == 3);
    for (uint8_t i = 10; i < 16; ++i) {
        CHECK(blob[i] == 0);
    }
    CHECK(blob[16] == 60);
    CHECK(blob[17] == 0);

    lumen_layout_store_t back;
    uint8_t strips = 0;
    CHECK(lumen_layout_blob_decode(blob, n, &strips, &back));
    CHECK(strips == 2);
    CHECK(back.part_count[0] == 3);
    CHECK(back.part_count[1] == 0);
    const lumen_part_layout_t *p0 = lumen_layout_store_part(&back, 0, 0);
    CHECK(p0 != NULL && p0->name_len == 6);
    CHECK(memcmp(p0->name, "眼灯", 6) == 0);
    CHECK(p0->segs.seg_count == 1);
    CHECK(p0->segs.seg[0][0] == 0 && p0->segs.seg[0][1] == 1);
    const lumen_part_layout_t *p2 = lumen_layout_store_part(&back, 0, 2);
    CHECK(p2 != NULL && p2->segs.seg_count == 2);
    CHECK(p2->segs.seg[0][0] == 3 && p2->segs.seg[0][1] == 9);
    CHECK(p2->segs.seg[1][0] == 20 && p2->segs.seg[1][1] == 25);

    /* 冗余灯珠数可单独读出。 */
    uint16_t got_counts[LUMEN_MAX_STRIPS];
    lumen_layout_blob_strip_counts(blob, n, got_counts);
    CHECK(got_counts[0] == 30);
    CHECK(got_counts[1] == 60);
}

static void test_layout_blob_rejects_bad(void)
{
    lumen_layout_store_t layout;
    build_three_parts(&layout);
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};
    uint8_t blob[LUMEN_LAYOUT_BLOB_MAX];
    size_t n = lumen_layout_blob_encode(&layout, 1, counts, blob, sizeof(blob));
    CHECK(n == LUMEN_LAYOUT_BLOB_SIZE);

    lumen_layout_store_t out;
    uint8_t strips = 0;

    /* 长度不符。 */
    CHECK(!lumen_layout_blob_decode(blob, n - 1, &strips, &out));
    CHECK(!lumen_layout_blob_decode(blob, n + 1, &strips, &out));

    /* 每个坏字节都必须整份拒绝，且不写 out。 */
    struct {
        size_t off;
        uint8_t value;
    } mutations[] = {
        {0, 'X'},   /* magic */
        {4, LUMEN_LAYOUT_BLOB_VERSION + 1}, /* version 必须精确等于 2（#158 升版） */
        {5, 0},     /* strip_count 0 */
        {5, 9},     /* strip_count 9 */
        {9, 9},     /* part_count 9 */
        {10, 1},    /* 保留字节必须为 0 */
        {8, 200},   /* led_count > 100 */
        {72 + 26, 2}, /* 部位 0 的记录内偏移 26 = phase，只有 0/1 */
    };
    /*
     * 自检：确认上面每个偏移真的落在它声称的字段上。变异测试最容易犯的错
     * 是偏移写歪了——那时「整份拒绝」仍然成立（碰巧撞坏了别的字节），
     * 断言假绿。
     */
    CHECK(blob[72 + 0] == 6);  /* 部位 0 的 name_len = 6（眼灯） */
    CHECK(blob[72 + 25] == 1); /* 部位 0 的 seg_count = 1 */
    CHECK(blob[72 + 26] == 0); /* 部位 0 的 phase = 连续 */
    CHECK(blob[72 + 27] == 0 && blob[72 + 28] == 1); /* 段 0 = 0-1 */
    for (size_t i = 0; i < sizeof(mutations) / sizeof(mutations[0]); ++i) {
        uint8_t bad[LUMEN_LAYOUT_BLOB_MAX];
        memcpy(bad, blob, n);
        bad[mutations[i].off] = mutations[i].value;
        lumen_layout_store_t keep;
        memset(&keep, 0xAB, sizeof(keep));
        CHECK(!lumen_layout_blob_decode(bad, n, &strips, &keep));
        /* out 必须原封不动（0xAB 填充仍在）。 */
        CHECK(((const uint8_t *)&keep)[0] == 0xAB);
    }

    /*
     * 部位记录从偏移 72 开始，每 43 字节。部位 0 的段 0 从记录内偏移 27 起
     * （名字 1+24、段数 1、相位 1）。
     * 把眼灯的第一个段改成 5-5（与散热的 3-9 重叠）。
     */
    size_t part0 = 72;
    uint8_t overlapping[LUMEN_LAYOUT_BLOB_MAX];
    memcpy(overlapping, blob, n);
    overlapping[part0 + 27] = 5;
    overlapping[part0 + 28] = 5;
    CHECK(!lumen_layout_blob_decode(overlapping, n, &strips, &out));

    /* start > end。 */
    uint8_t inverted[LUMEN_LAYOUT_BLOB_MAX];
    memcpy(inverted, blob, n);
    inverted[part0 + 27] = 9;
    inverted[part0 + 28] = 0;
    CHECK(!lumen_layout_blob_decode(inverted, n, &strips, &out));

    /* 名字 name_len 之后有非 0 字节。 */
    uint8_t dirty_name[LUMEN_LAYOUT_BLOB_MAX];
    memcpy(dirty_name, blob, n);
    dirty_name[part0 + 1 + 10] = 'X';
    CHECK(!lumen_layout_blob_decode(dirty_name, n, &strips, &out));

    /* 未使用的部位槽位非 0（半套写入）。 */
    uint8_t ghost[LUMEN_LAYOUT_BLOB_MAX];
    memcpy(ghost, blob, n);
    size_t part5 = 72 + 5 * 43;
    ghost[part5 + 25] = 1; /* seg_count = 1，但 part_count[0] = 3 */
    CHECK(!lumen_layout_blob_decode(ghost, n, &strips, &out));

    /* 原样的 blob 仍然能解（证明上面的失败都来自变异，不是解析器坏了）。 */
    CHECK(lumen_layout_blob_decode(blob, n, &strips, &out));
}

/* ================= v5（#155）：场景存储 ================= */

static lumen_effect_layer_t make_static_layer(uint16_t hue, uint8_t sat, uint8_t level)
{
    lumen_effect_layer_t l;
    memset(&l, 0, sizeof(l));
    l.type = LUMEN_EFFECT_STATIC;
    l.param[0] = (uint8_t)(hue & 0xFF);
    l.param[1] = (uint8_t)(hue >> 8);
    l.param[2] = sat;
    l.level = level;
    return l;
}

static lumen_effect_layer_t make_empty_layer(void)
{
    lumen_effect_layer_t l;
    memset(&l, 0, sizeof(l));
    l.type = LUMEN_LAYER_EMPTY;
    return l;
}

static lumen_effect_layer_t make_anim_layer(uint8_t type, uint16_t hue, uint8_t sat,
                                            uint16_t period, uint8_t p5, uint8_t flags,
                                            uint8_t level)
{
    lumen_effect_layer_t l;
    memset(&l, 0, sizeof(l));
    l.type = type;
    l.param[0] = (uint8_t)(hue & 0xFF);
    l.param[1] = (uint8_t)(hue >> 8);
    l.param[2] = sat;
    l.param[3] = (uint8_t)(period & 0xFF);
    l.param[4] = (uint8_t)(period >> 8);
    l.param[5] = p5;
    l.param[6] = flags;
    l.level = level;
    return l;
}

/* 建一个「整条 / 1 步 / 常亮」的默认场景（票 #155 验收项）。 */
static void build_default_scene(lumen_scene_t *scene)
{
    lumen_scene_init(scene);
    CHECK(lumen_scene_set_name(scene, 6, (const uint8_t *)"待机") == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_part(scene, 0, 0, 1, LUMEN_LOOP_ALL_V5, 1, 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(scene, 0, 0, 0, 1000, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);
}

static void test_scene_sizes(void)
{
    CHECK(sizeof(lumen_scene_step_t) == 20);
    CHECK(sizeof(lumen_part_scene_t) == 164);
    CHECK(sizeof(lumen_scene_t) == 10530);
    CHECK(sizeof(lumen_scene_set_t) == 3 * 10530);
    CHECK(LUMEN_SCENE_BLOB_MAX == 12288);
    CHECK(LUMEN_SCENE_PART_MAX_BYTES == 163);
}

static void test_scene_set_part_clears(void)
{
    lumen_scene_t scene;
    build_default_scene(&scene);
    CHECK(scene.part[0][0].step_count == 1);
    CHECK(scene.part[0][0].on == 1);

    /* 改时间轴头：步数、循环、开关都能改，写步数会清空旧步骤。 */
    CHECK(lumen_scene_set_part(&scene, 0, 0, 0, LUMEN_LOOP_NONE_V5, 0, 1, 1) ==
          LUMEN_RESULT_OK);
    CHECK(scene.part[0][0].step_count == 0);
    CHECK(scene.part[0][0].loop == LUMEN_LOOP_NONE_V5);
    CHECK(scene.part[0][0].on == 0);
    CHECK(scene.part[0][0].step[0].duration_ms == 0);

    /* 0 步 = 本场景不演（S10），合法。 */
    CHECK(!lumen_scene_part_plays(&scene, 0, 0));

    /* 越界值。 */
    CHECK(lumen_scene_set_part(&scene, 0, 0, 9, LUMEN_LOOP_ALL_V5, 1, 1, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_scene_set_part(&scene, 0, 0, 1, 3, 1, 1, 1) == LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_scene_set_part(&scene, 0, 0, 1, LUMEN_LOOP_ALL_V5, 2, 1, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
    /* part_id 必须小于布局给的部位数。 */
    CHECK(lumen_scene_set_part(&scene, 0, 1, 1, LUMEN_LOOP_ALL_V5, 1, 1, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
    /* 链越界。 */
    CHECK(lumen_scene_set_part(&scene, 1, 0, 1, LUMEN_LOOP_ALL_V5, 1, 1, 1) ==
          LUMEN_RESULT_INVALID_PARAM);
}

static void test_scene_set_step_rules(void)
{
    lumen_scene_t scene;
    build_default_scene(&scene);

    /* 时长两端（T6：100ms - 60s）。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, LUMEN_STEP_MIN_MS,
                               make_static_layer(0, 255, 100), make_empty_layer(), 1, 1) ==
          LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, LUMEN_STEP_MAX_MS,
                               make_static_layer(0, 255, 100), make_empty_layer(), 1, 1) ==
          LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 99, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 0, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 60001, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_INVALID_PARAM);

    /* layer0 不能为空（§7.1）。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000, make_empty_layer(),
                               make_static_layer(0, 255, 100), 1, 1) ==
          LUMEN_RESULT_INVALID_PARAM);

    /* 空层的 level 必须为 0。 */
    lumen_effect_layer_t bad_empty = make_empty_layer();
    bad_empty.level = 50;
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000, make_static_layer(0, 255, 100), bad_empty,
                               1, 1) == LUMEN_RESULT_INVALID_PARAM);

    /* 层亮度 ≤ 100。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000, make_static_layer(0, 255, 101),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_INVALID_PARAM);

    /* 未知灯效类型。 */
    lumen_effect_layer_t unknown = make_static_layer(0, 255, 100);
    unknown.type = 0x09;
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000, unknown, make_empty_layer(), 1, 1) ==
          LUMEN_RESULT_INVALID_PARAM);

    /* 呼吸周期下限 334ms。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000,
                               make_anim_layer(LUMEN_EFFECT_BREATHING, 0, 255, 333, 30, 0, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000,
                               make_anim_layer(LUMEN_EFFECT_BREATHING, 0, 255, 334, 30, 0, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);

    /* 爆闪 flags 必须 0。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000,
                               make_anim_layer(LUMEN_EFFECT_STROBE, 0, 255, 100, 90, 0x01, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_INVALID_PARAM);

    /* 步号 ≥ step_count 被拒（必须先 ScenePart 声明步数）。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 1, 1000, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_INVALID_PARAM);
    /* 步号 8 超上限。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 8, 1000, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_INVALID_PARAM);
}

static void test_scene_loop_and_clock(void)
{
    lumen_scene_t scene;
    lumen_scene_init(&scene);
    CHECK(lumen_scene_set_part(&scene, 0, 0, 3, LUMEN_LOOP_LAST_V5, 1, 1, 1) ==
          LUMEN_RESULT_OK);

    /* 三档循环值。 */
    for (uint8_t loop = 0; loop <= 2; ++loop) {
        CHECK(lumen_scene_set_part(&scene, 0, 0, 3, loop, 1, 1, 1) == LUMEN_RESULT_OK);
        CHECK(scene.part[0][0].loop == loop);
    }

    /* 总时长是所有步之和（3 步 × 500 / 1000 / 1500）。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 500, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 1, 1000, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 2, 1500, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_part_total_ms(&scene.part[0][0]) == 3000);

    /* 开关只灭灯、不停时钟：plays 为假但步表与总时长不变（T8）。 */
    CHECK(lumen_scene_set_part(&scene, 0, 0, 3, LUMEN_LOOP_ALL_V5, 0, 1, 1) ==
          LUMEN_RESULT_OK);
    CHECK(!lumen_scene_part_plays(&scene, 0, 0));
    CHECK(scene.part[0][0].step_count == 3);
    /* 子开关状态独立保留（父开关不动它，T9）。 */
    CHECK(scene.part[0][0].on == 0);
}

static void test_scene_layer_sizes(void)
{
    /* 变长层的编码长度：空 1 / 静态与熄灭 5 / 带动画 9（§10.4）。 */
    lumen_effect_layer_t empty = make_empty_layer();
    CHECK(lumen_scene_layer_encoded_size(&empty) == 1);
    lumen_effect_layer_t stat = make_static_layer(1000, 200, 100);
    CHECK(lumen_scene_layer_encoded_size(&stat) == 5);
    lumen_effect_layer_t off = make_anim_layer(LUMEN_EFFECT_OFF, 0, 0, 0, 0, 0, 100);
    CHECK(lumen_scene_layer_encoded_size(&off) == 5);
    lumen_effect_layer_t rainbow =
        make_anim_layer(LUMEN_EFFECT_RAINBOW, 0, 255, 4000, 255, 0, 100);
    CHECK(lumen_scene_layer_encoded_size(&rainbow) == 9);
    CHECK(LUMEN_SCENE_LAYER_EMPTY_BYTES == 1);
    CHECK(LUMEN_SCENE_LAYER_STATIC_BYTES == 5);
    CHECK(LUMEN_SCENE_LAYER_ANIM_BYTES == 9);
}

/*
 * 票 #155 的验收项：「最大形态（8 链 × 8 部位 × 8 步 × 两层）编码后 ≤ 12 KB
 * 有单测」。这是三条存储风险里的第 1 条（体积全是设计期算术）的可执行答案。
 */
static void test_scene_blob_max_size(void)
{
    lumen_scene_t *scene = calloc(1, sizeof(lumen_scene_t));
    if (scene == NULL) {
        CHECK(false);
        return;
    }
    lumen_scene_init(scene);

    /* 全填满：8 链 × 8 部位 × 8 步，每步两层都带动画（最坏形态）。 */
    for (uint8_t strip = 0; strip < 8; ++strip) {
        for (uint8_t part = 0; part < 8; ++part) {
            CHECK(lumen_scene_set_part(scene, strip, part, 8, LUMEN_LOOP_ALL_V5, 1, 8, 8) ==
                  LUMEN_RESULT_OK);
            for (uint8_t step = 0; step < 8; ++step) {
                CHECK(lumen_scene_set_step(
                          scene, strip, part, step, 60000,
                          make_anim_layer(LUMEN_EFFECT_RAINBOW, 0, 255, 4000, 255, 0, 100),
                          make_anim_layer(LUMEN_EFFECT_COMET, 30000, 255, 1200, 8, 0x0F, 100), 8,
                          8) == LUMEN_RESULT_OK);
            }
        }
    }

    size_t worst = lumen_scene_blob_size(scene);
    /* 契约算术：40（头）+ 64×3（部位头）+ 512 步 × (2 + 9 + 9) = 40 + 192 + 10240。 */
    CHECK(worst == 10472);
    CHECK(worst <= LUMEN_SCENE_BLOB_MAX);
    printf("scene worst-case blob: %u bytes (limit %u)\n", (unsigned)worst,
           (unsigned)LUMEN_SCENE_BLOB_MAX);

    uint8_t *blob = malloc(LUMEN_SCENE_BLOB_MAX);
    if (blob == NULL) {
        CHECK(false);
        free(scene);
        return;
    }
    size_t n = lumen_scene_blob_encode(scene, blob, LUMEN_SCENE_BLOB_MAX);
    CHECK(n == worst);

    /* 能解回来，而且步数 / 时长 / 两层都在。 */
    lumen_scene_t *back = calloc(1, sizeof(lumen_scene_t));
    if (back != NULL) {
        CHECK(lumen_scene_blob_decode(blob, n, back));
        CHECK(back->part[7][7].step_count == 8);
        CHECK(back->part[7][7].step[7].duration_ms == 60000);
        CHECK(back->part[0][0].step[0].layer[0].type == LUMEN_EFFECT_RAINBOW);
        CHECK(back->part[0][0].step[0].layer[1].type == LUMEN_EFFECT_COMET);
        /* 变长编码不能丢字节：comet 的 flags 与 p5 必须原样回来。 */
        CHECK(back->part[0][0].step[0].layer[1].param[5] == 8);
        CHECK(back->part[0][0].step[0].layer[1].param[6] == 0x0F);
        free(back);
    }
    free(blob);
    free(scene);
}

static void test_scene_blob_roundtrip(void)
{
    lumen_scene_t scene;
    build_default_scene(&scene);
    /* 一步两层：静态打底 + 流光叠加（混合方式不在线上，由有无 layer1 决定）。 */
    CHECK(lumen_scene_set_part(&scene, 0, 0, 2, LUMEN_LOOP_LAST_V5, 1, 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 500, make_static_layer(0, 255, 100),
                               make_anim_layer(LUMEN_EFFECT_COMET, 30000, 255, 1200, 8, 0x01,
                                               100),
                               1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 1, 1500,
                               make_anim_layer(LUMEN_EFFECT_BREATHING, 21845, 200, 2000, 30, 0,
                                               50),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);

    uint8_t blob[LUMEN_SCENE_BLOB_MAX];
    size_t n = lumen_scene_blob_encode(&scene, blob, sizeof(blob));
    CHECK(n > 0);
    CHECK(n == lumen_scene_blob_size(&scene));

    /* magic / 版本 / 名字。 */
    CHECK(blob[0] == 'L' && blob[1] == 'M' && blob[2] == 'S' && blob[3] == '5');
    CHECK(blob[4] == LUMEN_SCENE_BLOB_VERSION);
    CHECK(blob[5] == 6);
    CHECK(memcmp(&blob[6], "待机", 6) == 0);

    lumen_scene_t back;
    CHECK(lumen_scene_blob_decode(blob, n, &back));
    CHECK(back.name_len == 6);
    CHECK(memcmp(back.name, "待机", 6) == 0);
    CHECK(back.part[0][0].step_count == 2);
    CHECK(back.part[0][0].loop == LUMEN_LOOP_LAST_V5);
    CHECK(back.part[0][0].on == 1);
    CHECK(back.part[0][0].step[0].duration_ms == 500);
    CHECK(back.part[0][0].step[0].layer[0].type == LUMEN_EFFECT_STATIC);
    CHECK(back.part[0][0].step[0].layer[1].type == LUMEN_EFFECT_COMET);
    CHECK(back.part[0][0].step[0].layer[1].param[6] == 0x01);
    CHECK(back.part[0][0].step[1].duration_ms == 1500);
    CHECK(back.part[0][0].step[1].layer[0].type == LUMEN_EFFECT_BREATHING);
    CHECK(back.part[0][0].step[1].layer[0].level == 50);
    CHECK(back.part[0][0].step[1].layer[1].type == LUMEN_LAYER_EMPTY);

    /* 逐字节往返：再编码一次必须完全一致。 */
    uint8_t again[LUMEN_SCENE_BLOB_MAX];
    size_t n2 = lumen_scene_blob_encode(&back, again, sizeof(again));
    CHECK(n2 == n);
    CHECK(memcmp(blob, again, n) == 0);
}

static void test_scene_blob_rejects_bad(void)
{
    lumen_scene_t scene;
    build_default_scene(&scene);
    uint8_t blob[LUMEN_SCENE_BLOB_MAX];
    size_t n = lumen_scene_blob_encode(&scene, blob, sizeof(blob));
    CHECK(n > 0);

    lumen_scene_t out;

    /* 长度：过短、超过硬上限。 */
    CHECK(!lumen_scene_blob_decode(blob, n - 1, &out));
    CHECK(!lumen_scene_blob_decode(blob, LUMEN_SCENE_BLOB_MAX + 1, &out));

    struct {
        size_t off;
        uint8_t value;
    } mutations[] = {
        {0, 'X'},   /* magic */
        {4, 9},     /* version */
        {5, 25},    /* name_len 超 24 */
        {6 + 7, 1}, /* name 填充里塞非 0 */
    };
    for (size_t i = 0; i < sizeof(mutations) / sizeof(mutations[0]); ++i) {
        uint8_t bad[LUMEN_SCENE_BLOB_MAX];
        memcpy(bad, blob, n);
        bad[mutations[i].off] = mutations[i].value;
        lumen_scene_t keep;
        memset(&keep, 0xCD, sizeof(keep));
        CHECK(!lumen_scene_blob_decode(bad, n, &keep));
        CHECK(((const uint8_t *)&keep)[0] == 0xCD);
    }

    /*
     * 每链 part_count 在偏移 32 起；部位头在 40 起。
     * 把一个部位的 step_count 改成 9（超过 MAX_STEPS）。
     */
    uint8_t bad_steps[LUMEN_SCENE_BLOB_MAX];
    memcpy(bad_steps, blob, n);
    CHECK(bad_steps[32] == 1); /* strip0 有 1 个部位 */
    bad_steps[40] = 9;
    CHECK(!lumen_scene_blob_decode(bad_steps, n, &out));

    /* loop 改成 3（三值只有 0/1/2）。 */
    uint8_t bad_loop[LUMEN_SCENE_BLOB_MAX];
    memcpy(bad_loop, blob, n);
    bad_loop[41] = 3;
    CHECK(!lumen_scene_blob_decode(bad_loop, n, &out));

    /* on 改成 2。 */
    uint8_t bad_on[LUMEN_SCENE_BLOB_MAX];
    memcpy(bad_on, blob, n);
    bad_on[42] = 2;
    CHECK(!lumen_scene_blob_decode(bad_on, n, &out));

    /* 时长改到 99ms（低于下限）。 */
    uint8_t bad_dur[LUMEN_SCENE_BLOB_MAX];
    memcpy(bad_dur, blob, n);
    bad_dur[43] = 99;
    bad_dur[44] = 0;
    CHECK(!lumen_scene_blob_decode(bad_dur, n, &out));

    /* 时长改到 60001ms（高于上限）。 */
    uint8_t bad_dur_hi[LUMEN_SCENE_BLOB_MAX];
    memcpy(bad_dur_hi, blob, n);
    bad_dur_hi[43] = (uint8_t)(60001 & 0xFF);
    bad_dur_hi[44] = (uint8_t)(60001 >> 8);
    CHECK(!lumen_scene_blob_decode(bad_dur_hi, n, &out));

    /* layer0 改成空层（§7.1 要求非空）。 */
    uint8_t bad_layer0[LUMEN_SCENE_BLOB_MAX];
    memcpy(bad_layer0, blob, n);
    bad_layer0[45] = LUMEN_LAYER_EMPTY;
    CHECK(!lumen_scene_blob_decode(bad_layer0, n, &out));

    /* 尾部多一个字节（长度必须与内容一致）。 */
    uint8_t extra[LUMEN_SCENE_BLOB_MAX + 1];
    memcpy(extra, blob, n);
    extra[n] = 0;
    CHECK(!lumen_scene_blob_decode(extra, n + 1, &out));

    /* 原样的仍能解。 */
    CHECK(lumen_scene_blob_decode(blob, n, &out));
}

static void test_scene_encode_capacity(void)
{
    lumen_scene_t scene;
    build_default_scene(&scene);

    /* out_cap 不足 → 0（调用方据此回 StorageFailed）。 */
    uint8_t small[16];
    CHECK(lumen_scene_blob_encode(&scene, small, sizeof(small)) == 0);

    /*
     * 空场景只有固定头部（32 字节头 + 每链 1 字节的 part_count）。
     *
     * 早先这里期望 `+ 64 * 3`（全部 64 个部位槽位的 3 字节头）——那条期望与
     * 实现不一致，正是 #162 抓到的真缺陷：`blob_size` / `encode` / `decode`
     * 对「没编排过的部位占不占空间」各说各话，结果每次场景恢复都失败
     * （保存成功、重启后三个场景全空）。现在三处统一为「不占」。
     */
    lumen_scene_t empty;
    lumen_scene_init(&empty);
    CHECK(lumen_scene_blob_size(&empty) == 32 + 8);
    uint8_t blob[LUMEN_SCENE_BLOB_MAX];
    size_t n = lumen_scene_blob_encode(&empty, blob, sizeof(blob));
    CHECK(n == 32 + 8);
    lumen_scene_t back;
    CHECK(lumen_scene_blob_decode(blob, n, &back));
    CHECK(back.part[0][0].step_count == 0);

    /*
     * 回归：**只编排一个部位**的场景必须能存能读（#162）。
     *
     * 这一条守着「三处对未编排部位的处理一致」。任何一个（size / encode /
     * decode）单独改回「算全部 64 槽位」，roundtrip 立刻断。
     */
    lumen_scene_t one;
    lumen_scene_init(&one);
    one.name_len = 2;
    one.name[0] = 'A';
    one.name[1] = 'B';
    one.part[0][0].step_count = 2;
    one.part[0][0].loop = LUMEN_LOOP_ALL_V5;
    one.part[0][0].on = 1;
    for (uint8_t s = 0; s < 2; ++s) {
        one.part[0][0].step[s].duration_ms = 1000;
        one.part[0][0].step[s].layer[0].type = LUMEN_EFFECT_STATIC;
        one.part[0][0].step[s].layer[0].param[0] = 0x1E;
        one.part[0][0].step[s].layer[0].param[2] = 0x80;
        one.part[0][0].step[s].layer[0].level = 100;
        one.part[0][0].step[s].layer[1].type = LUMEN_NO_EFFECT;
    }
    size_t one_need = lumen_scene_blob_size(&one);
    size_t one_wrote = lumen_scene_blob_encode(&one, blob, sizeof(blob));
    CHECK(one_need == one_wrote);
    CHECK(one_wrote > 32 + 8);
    lumen_scene_t one_back;
    lumen_scene_init(&one_back);
    CHECK(lumen_scene_blob_decode(blob, one_wrote, &one_back));
    CHECK(one_back.name_len == 2);
    CHECK(one_back.name[0] == 'A' && one_back.name[1] == 'B');
    CHECK(one_back.part[0][0].step_count == 2);
    CHECK(one_back.part[0][0].loop == LUMEN_LOOP_ALL_V5);
    CHECK(one_back.part[0][0].on == 1);
    CHECK(one_back.part[0][0].step[0].duration_ms == 1000);
    CHECK(one_back.part[0][0].step[1].layer[0].type == LUMEN_EFFECT_STATIC);
}

/* ================= v5（#155）：播放头推进（纯函数） ================= */

/* 建一个 n 步的部位时间轴，每步时长取 durations[]。 */
static void build_part_timeline(lumen_part_scene_t *part, const uint16_t *durations, uint8_t n,
                                uint8_t loop)
{
    memset(part, 0, sizeof(*part));
    part->step_count = n;
    part->loop = loop;
    part->on = 1;
    for (uint8_t i = 0; i < n; ++i) {
        part->step[i].duration_ms = durations[i];
        part->step[i].layer[0] = make_static_layer((uint16_t)(i * 1000), 255, 100);
        part->step[i].layer[1] = make_empty_layer();
    }
}

static void test_part_clock_basics(void)
{
    lumen_part_scene_t part;
    uint16_t durs[3] = {1000, 2000, 3000};
    build_part_timeline(&part, durs, 3, LUMEN_LOOP_ALL_V5);

    /* 未启动：finished、步 0、无进度。 */
    lumen_part_clock_t clock;
    memset(&clock, 0, sizeof(clock));    lumen_part_position_t pos = lumen_part_clock_advance(&part, &clock, 5000);
    CHECK(pos.finished);
    CHECK(pos.step_index == 0);
    CHECK(pos.elapsed_ms == 0);

    /* 启动后从 0 开始。 */
    lumen_part_clock_start(&clock, 1000);
    CHECK(clock.started);
    CHECK(clock.origin_ms == 1000);

    /* 重复启动不重置（编辑不打断时钟，E2）。 */
    lumen_part_clock_start(&clock, 9999);
    CHECK(clock.origin_ms == 1000);

    /* t = origin：第 1 步第 0 ms。 */
    pos = lumen_part_clock_advance(&part, &clock, 1000);
    CHECK(pos.step_index == 0 && pos.elapsed_ms == 0 && !pos.finished);

    /* t = origin + 999：第 1 步最后 1ms（边界：正好小于时长）。 */
    pos = lumen_part_clock_advance(&part, &clock, 1999);
    CHECK(pos.step_index == 0 && pos.elapsed_ms == 999);

    /* t = origin + 1000：正好等于时长 → 第 2 步第 0 ms（边界）。 */
    pos = lumen_part_clock_advance(&part, &clock, 2000);
    CHECK(pos.step_index == 1 && pos.elapsed_ms == 0);

    /* t = origin + 3000：第 3 步起点。 */
    pos = lumen_part_clock_advance(&part, &clock, 4000);
    CHECK(pos.step_index == 2 && pos.elapsed_ms == 0);

    /* 总时长 6000：全部循环 → t = origin + 6000 回到第 1 步。 */
    pos = lumen_part_clock_advance(&part, &clock, 7000);
    CHECK(pos.step_index == 0 && pos.elapsed_ms == 0 && !pos.finished);

    /* step_start_ms = now - elapsed，供 compose 当 t0 用。 */
    pos = lumen_part_clock_advance(&part, &clock, 7400);
    CHECK(pos.step_index == 0 && pos.elapsed_ms == 400);
    CHECK(pos.step_start_ms == 7000);

    /* now < origin（时钟回绕）按 0 处理，不出负数。 */
    pos = lumen_part_clock_advance(&part, &clock, 500);
    CHECK(pos.step_index == 0 && pos.elapsed_ms == 0);
}

static void test_part_clock_no_loop(void)
{
    lumen_part_scene_t part;
    uint16_t durs[2] = {1000, 2000};
    build_part_timeline(&part, durs, 2, LUMEN_LOOP_NONE_V5);

    lumen_part_clock_t clock;
    memset(&clock, 0, sizeof(clock));
    lumen_part_clock_start(&clock, 100);

    /* 走到末步中间。 */
    lumen_part_position_t pos = lumen_part_clock_advance(&part, &clock, 100 + 2000);
    CHECK(pos.step_index == 1 && pos.elapsed_ms == 1000 && !pos.finished);

    /* 越过总时长 → 停在最后一帧（T4：不熄灭、不回头）。 */
    pos = lumen_part_clock_advance(&part, &clock, 100 + 3000);
    CHECK(pos.step_index == 1 && pos.finished);
    CHECK(pos.elapsed_ms == 2000); /* 冻结在末步时长处 */
    /* 再往后也一样（最后一帧不再变化）。 */
    pos = lumen_part_clock_advance(&part, &clock, 100 + 100000);
    CHECK(pos.step_index == 1 && pos.elapsed_ms == 2000 && pos.finished);

    /* 单步 + 不循环：立即 finished，画面一直显示那一帧。 */
    lumen_part_scene_t single;
    uint16_t one[1] = {1000};
    build_part_timeline(&single, one, 1, LUMEN_LOOP_NONE_V5);
    lumen_part_clock_t c2;
    memset(&c2, 0, sizeof(c2));
    lumen_part_clock_start(&c2, 0);
    pos = lumen_part_clock_advance(&single, &c2, 0);
    CHECK(pos.step_index == 0 && !pos.finished);
    pos = lumen_part_clock_advance(&single, &c2, 1000);
    CHECK(pos.step_index == 0 && pos.finished);
}

static void test_part_clock_loop_last(void)
{
    lumen_part_scene_t part;
    uint16_t durs[3] = {1000, 2000, 4000};
    build_part_timeline(&part, durs, 3, LUMEN_LOOP_LAST_V5);
    /* 前 N-1 步合计 3000，末步 4000。 */

    lumen_part_clock_t clock;
    memset(&clock, 0, sizeof(clock));
    lumen_part_clock_start(&clock, 0);

    /* 前 N-1 步各播一次：t = 0/1000/3000 正常推进。 */
    lumen_part_position_t pos = lumen_part_clock_advance(&part, &clock, 0);
    CHECK(pos.step_index == 0 && pos.elapsed_ms == 0);
    pos = lumen_part_clock_advance(&part, &clock, 1000);
    CHECK(pos.step_index == 1 && pos.elapsed_ms == 0);
    pos = lumen_part_clock_advance(&part, &clock, 2999);
    CHECK(pos.step_index == 1 && pos.elapsed_ms == 1999);

    /* 进入末步。 */
    pos = lumen_part_clock_advance(&part, &clock, 3000);
    CHECK(pos.step_index == 2 && pos.elapsed_ms == 0);

    /* 末步中途。 */
    pos = lumen_part_clock_advance(&part, &clock, 5000);
    CHECK(pos.step_index == 2 && pos.elapsed_ms == 2000);
    CHECK(pos.step_start_ms == 3000);

    /* 末步走完 → 原地重播末步（不是回到第 1 步）。 */
    pos = lumen_part_clock_advance(&part, &clock, 7000);
    CHECK(pos.step_index == 2 && pos.elapsed_ms == 0);
    CHECK(pos.step_start_ms == 7000);

    /* 再过两轮仍然是末步。 */
    pos = lumen_part_clock_advance(&part, &clock, 3000 + 4000 * 3 + 1000);
    CHECK(pos.step_index == 2 && pos.elapsed_ms == 1000);

    /* 只有一个部位时，最后一步循环等价于全部循环。 */
    lumen_part_scene_t single;
    uint16_t one[1] = {500};
    build_part_timeline(&single, one, 1, LUMEN_LOOP_LAST_V5);
    lumen_part_clock_t c2;
    memset(&c2, 0, sizeof(c2));
    lumen_part_clock_start(&c2, 0);
    for (uint32_t t = 0; t < 3000; t += 100) {
        pos = lumen_part_clock_advance(&single, &c2, t);
        CHECK(pos.step_index == 0);
        CHECK(pos.elapsed_ms == t % 500);
    }
}

static void test_part_clock_zero_steps(void)
{
    lumen_part_scene_t part;
    memset(&part, 0, sizeof(part));
    part.loop = LUMEN_LOOP_ALL_V5;
    part.on = 1; /* 开关开着但 0 步 = 本场景不演（S10） */

    lumen_part_clock_t clock;
    memset(&clock, 0, sizeof(clock));
    lumen_part_clock_start(&clock, 1234);
    lumen_part_position_t pos = lumen_part_clock_advance(&part, &clock, 99999);
    CHECK(pos.finished);
    CHECK(pos.step_index == 0);
    CHECK(pos.elapsed_ms == 0);
}

/*
 * 长时间不漂移：播放头用绝对时间差值推进，不做累加。
 * 在 origin + 4 小时的位置求值，必须与「按总时长折回」的算术结果逐毫秒一致。
 */
static void test_part_clock_no_drift(void)
{
    lumen_part_scene_t part;
    uint16_t durs[3] = {333, 777, 1500};
    build_part_timeline(&part, durs, 3, LUMEN_LOOP_ALL_V5);
    const uint32_t total = 333 + 777 + 1500; /* 2610 */

    lumen_part_clock_t clock;
    memset(&clock, 0, sizeof(clock));
    lumen_part_clock_start(&clock, 1);
    for (uint32_t hour = 0; hour < 4; ++hour) {
        uint32_t now = 1 + hour * 3600000u + 12347u;
        uint32_t elapsed = (now - 1) % total;
        lumen_part_position_t pos = lumen_part_clock_advance(&part, &clock, now);
        /* 手工按同一份算术定位。 */
        uint32_t want_step = 0;
        uint32_t want_elapsed = elapsed;
        if (elapsed >= 333) {
            want_elapsed = elapsed - 333;
            want_step = 1;
            if (want_elapsed >= 777) {
                want_elapsed -= 777;
                want_step = 2;
            }
        }
        CHECK(pos.step_index == want_step);
        CHECK(pos.elapsed_ms == want_elapsed);
    }

    /*
     * 真实的 uint32 回绕：origin 接近上限、now 已绕到开头。
     * 差值 (now - origin) mod 2^32 = 0x300 = 768ms，必须照常推进，
     * 而不是被当成「now 比 origin 早」卡在 0。
     * 768 落在第 2 步（第 1 步 333ms 之后 435ms）。
     */
    lumen_part_clock_t wrap;
    memset(&wrap, 0, sizeof(wrap));
    lumen_part_clock_start(&wrap, 0xFFFFFF00u);
    lumen_part_position_t wrapped = lumen_part_clock_advance(&part, &wrap, 0x200u);
    CHECK(wrapped.step_index == 1);
    CHECK(wrapped.elapsed_ms == 768 - 333);

    /*
     * 反向跳变（调用方把时钟往前调、或 origin 还没写）：按 0 处理，
     * 不给出一个接近 2^32 的天文数字。
     */
    lumen_part_clock_t back;
    memset(&back, 0, sizeof(back));
    lumen_part_clock_start(&back, 5000);
    lumen_part_position_t rewound = lumen_part_clock_advance(&part, &back, 100);
    CHECK(rewound.step_index == 0);
    CHECK(rewound.elapsed_ms == 0);
}

/* ================= v5（#155）：合成（唯一渲染接缝） ================= */

/* 建一个「一条链 / 一个部位 / 覆盖整条」的布局 + 场景对。 */
static void build_whole_strip_pair(lumen_layout_store_t *layout, lumen_scene_t *scene,
                                   uint16_t led_count)
{
    lumen_layout_store_init(layout);
    CHECK(lumen_layout_store_write(layout, 0, 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_part(layout, 0, 0, 0, NULL, 1, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(layout, 0, 0, 0, 0, (uint8_t)(led_count - 1), led_count, 1) ==
          LUMEN_RESULT_OK);

    lumen_scene_init(scene);
    CHECK(lumen_scene_set_part(scene, 0, 0, 1, LUMEN_LOOP_ALL_V5, 1, 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(scene, 0, 0, 0, 1000, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);
}

static void test_compose_uncovered_is_black(void)
{
    /*
     * 票 #155 验收项：「未覆盖的灯珠恒黑」。布局里故意留一条没有部位的链、
     * 以及一条部位只覆盖前 3 颗的链——其余必须是**真黑**（不是上一帧残留，
     * 也不是暖白兜底）。
     */
    lumen_layout_store_t layout;
    lumen_scene_t scene;
    lumen_part_clocks_t clocks;
    lumen_part_clocks_init(&clocks);

    lumen_layout_store_init(&layout);
    /* 链 0：只有「整条 0-9」的一部分被覆盖（0-2）。 */
    CHECK(lumen_layout_store_write(&layout, 0, 1, 2) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_part(&layout, 0, 0, 0, NULL, 1, LUMEN_PHASE_CONTINUOUS, 2) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 0, 0, 2, 30, 2) == LUMEN_RESULT_OK);
    /* 链 1：故意一个部位都不建。 */
    CHECK(lumen_layout_store_write(&layout, 1, 0, 2) == LUMEN_RESULT_OK);

    lumen_scene_init(&scene);
    CHECK(lumen_scene_set_part(&scene, 0, 0, 1, LUMEN_LOOP_ALL_V5, 1, 2, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000, make_static_layer(0, 255, 100),
                               make_empty_layer(), 2, 1) == LUMEN_RESULT_OK);

    lumen_part_clocks_reset_strip(&clocks, 0, 1, 500);
    lumen_part_clocks_reset_strip(&clocks, 1, 0, 500);

    uint8_t buf[30 * 3];
    /* 先用脏值填满，证明 compose 真的清零（不是碰巧）。 */
    memset(buf, 0xAA, sizeof(buf));
    uint16_t n = lumen_scene_compose(&layout, &scene, &clocks, 600, 0, buf,
                                     30);
    CHECK(n == 30);

    /* 0-2：被覆盖，静态暖红出光（hue 0 sat 255 → 纯红）。 */
    CHECK(buf[0] > 0);
    CHECK(buf[1] == 0 && buf[2] == 0);
    CHECK(buf[6] > 0);
    CHECK(buf[2 * 3] > 0);
    /* 3-29：灰缝恒黑（真黑，不是 0xAA 残留）。 */
    for (uint16_t i = 3; i < 30; ++i) {
        CHECK(buf[i * 3] == 0);
        CHECK(buf[i * 3 + 1] == 0);
        CHECK(buf[i * 3 + 2] == 0);
    }

    /* 一条没有部位的链：整条黑。 */
    memset(buf, 0xAA, sizeof(buf));
    n = lumen_scene_compose(&layout, &scene, &clocks, 600, 1, buf, 30);
    CHECK(n == 30);
    for (uint16_t i = 0; i < 30; ++i) {
        CHECK(buf[i * 3] == 0 && buf[i * 3 + 1] == 0 && buf[i * 3 + 2] == 0);
    }
}

static void test_compose_part_switch(void)
{
    /* 部位开关只灭灯、不停时钟：关掉时全黑，重新打开时画面接着往下走（T8/T9）。 */
    lumen_layout_store_t layout;
    lumen_scene_t scene;
    lumen_part_clocks_t clocks;
    lumen_part_clocks_init(&clocks);
    build_whole_strip_pair(&layout, &scene, 10);

    /* 两步：第 1 步红 1000ms、第 2 步蓝 1000ms。 */
    CHECK(lumen_scene_set_part(&scene, 0, 0, 2, LUMEN_LOOP_ALL_V5, 1, 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);
    /* hue 43690 ≈ 240°（蓝）。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 1, 1000, make_static_layer(43690, 255, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);

    lumen_part_clocks_reset_strip(&clocks, 0, 1, 0);
    uint8_t buf[10 * 3];
    /* t=100：第 1 步（红）。 */
    lumen_scene_compose(&layout, &scene, &clocks, 100, 0, buf, 10);
    CHECK(buf[0] > 0);
    CHECK(buf[2] == 0);
    uint8_t red_sample = buf[0];

    /* 关掉部位：全黑。 */
    CHECK(lumen_scene_set_part(&scene, 0, 0, 2, LUMEN_LOOP_ALL_V5, 0, 1, 1) == LUMEN_RESULT_OK);
    lumen_scene_compose(&layout, &scene, &clocks, 100, 0, buf, 10);
    CHECK(buf[0] == 0 && buf[1] == 0 && buf[2] == 0);

    /*
     * 关着的时候时间照走：t=1100 仍在黑（关就是不亮），但时钟已经推进到第 2 步。
     * 「时钟没停」的证据必须从播放头本身读，不能从像素读——像素在关掉时恒黑。
     */
    lumen_scene_compose(&layout, &scene, &clocks, 1100, 0, buf, 10);
    CHECK(buf[0] == 0 && buf[1] == 0 && buf[2] == 0);
    lumen_part_position_t pos = lumen_part_clock_advance(&scene.part[0][0], &clocks.clock[0][0],
                                                         1100);
    CHECK(pos.step_index == 1); /* 已经在第 2 步，没有因为关掉而冻结 */
    CHECK(!pos.finished);

    /* 重新打开：画面接着第 2 步往下走（不是从头闪）。 */
    CHECK(lumen_scene_set_part(&scene, 0, 0, 2, LUMEN_LOOP_ALL_V5, 1, 1, 1) == LUMEN_RESULT_OK);
    /* 开关切换不能清掉时间轴（T9：重新打开时原来的编排仍在）。 */
    CHECK(scene.part[0][0].step_count == 2);
    CHECK(scene.part[0][0].step[1].layer[0].param[0] == (uint8_t)(43690 & 0xFF));
    lumen_scene_compose(&layout, &scene, &clocks, 1100, 0, buf, 10);
    CHECK(buf[2] > 0); /* 仍是蓝，不是红的第 1 步 */
    /* t=2100 → 折回第 1 步。 */
    lumen_scene_compose(&layout, &scene, &clocks, 2100, 0, buf, 10);
    CHECK(buf[0] == red_sample);
}

static void test_compose_multi_segment_shared_phase(void)
{
    /*
     * 一个部位占 0-4 与 10-14（多段共享全部参数，S5）。
     * 用彩虹验证「连续相位」下两段拼成一条逻辑灯带：20 颗一起铺满一圈色相，
     * 所以第 0 颗与第 10 颗的色相相差半圈。
     */
    lumen_layout_store_t layout;
    lumen_scene_t scene;
    lumen_part_clocks_t clocks;
    lumen_part_clocks_init(&clocks);

    lumen_layout_store_init(&layout);
    CHECK(lumen_layout_store_write(&layout, 0, 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_part(&layout, 0, 0, 0, NULL, 2, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 0, 0, 4, 20, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 1, 10, 14, 20, 1) == LUMEN_RESULT_OK);

    lumen_scene_init(&scene);
    CHECK(lumen_scene_set_part(&scene, 0, 0, 1, LUMEN_LOOP_ALL_V5, 1, 1, 1) == LUMEN_RESULT_OK);
    /* 彩虹 span 255 = 沿整条铺满一圈，period 0 = 静止（便于断言）。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000,
                               make_anim_layer(LUMEN_EFFECT_RAINBOW, 0, 255, 0, 255, 0, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);
    lumen_part_clocks_reset_strip(&clocks, 0, 1, 0);

    uint8_t buf[20 * 3];
    lumen_scene_compose(&layout, &scene, &clocks, 0, 0, buf, 20);

    /* 两段都出光。 */
    for (uint8_t i = 0; i <= 4; ++i) {
        CHECK(buf[i * 3] + buf[i * 3 + 1] + buf[i * 3 + 2] > 0);
    }
    for (uint8_t i = 10; i <= 14; ++i) {
        CHECK(buf[i * 3] + buf[i * 3 + 1] + buf[i * 3 + 2] > 0);
    }
    /* 中间灰缝恒黑。 */
    for (uint8_t i = 5; i <= 9; ++i) {
        CHECK(buf[i * 3] == 0 && buf[i * 3 + 1] == 0 && buf[i * 3 + 2] == 0);
    }
    /* 未覆盖的 15-19 也是黑。 */
    for (uint8_t i = 15; i < 20; ++i) {
        CHECK(buf[i * 3] == 0 && buf[i * 3 + 1] == 0 && buf[i * 3 + 2] == 0);
    }

    /*
     * 连续相位：第 7 个逻辑位置（物理 12）与第 2 个逻辑位置（物理 2）
     * 应该差 5/20 = 1/4 圈色相，所以两个像素不该相同。
     */
    CHECK(memcmp(&buf[12 * 3], &buf[2 * 3], 3) != 0);

    /*
     * 各自起点相位：两段各自从 0 起波，所以物理 0 与物理 10 的逻辑下标都是 0
     * → 颜色完全相同。
     *
     * 相位是**部位的属性**（S6，存进 blob），所以这里改的是 `part->phase`
     * 而不是给 compose 传参——正是这一票要证明的：改一个部位的模式不该
     * 影响任何别的部位，也不该需要重传布局。
     */
    layout.part[0][0].phase = LUMEN_PHASE_PER_SEGMENT;
    uint8_t buf2[20 * 3];
    lumen_scene_compose(&layout, &scene, &clocks, 0, 0, buf2, 20);
    CHECK(memcmp(&buf2[0], &buf2[10 * 3], 3) == 0);
    /* 段内仍按位置推进。 */
    CHECK(memcmp(&buf2[0], &buf2[4 * 3], 3) != 0);
    /* 连续相位下同一对不相同（证明两种模式真的不同）。 */
    CHECK(memcmp(&buf[0], &buf[10 * 3], 3) != 0);

    /* 改回连续，画面必须回到连续的样子（相位真的在驱动取样）。 */
    layout.part[0][0].phase = LUMEN_PHASE_CONTINUOUS;
    uint8_t buf3[20 * 3];
    lumen_scene_compose(&layout, &scene, &clocks, 0, 0, buf3, 20);
    CHECK(memcmp(&buf3[0], &buf3[10 * 3], 3) != 0);
    CHECK(memcmp(buf3, buf, sizeof(buf)) == 0);
}

static void test_compose_two_layers(void)
{
    /* 两层：静态打底 + 流光叠加。混合方式不在线上，由有无 layer1 决定（E6）。 */
    lumen_layout_store_t layout;
    lumen_scene_t scene;
    lumen_part_clocks_t clocks;
    lumen_part_clocks_init(&clocks);
    build_whole_strip_pair(&layout, &scene, 16);

    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000, make_static_layer(0, 255, 100),
                               make_anim_layer(LUMEN_EFFECT_COMET, 30000, 255, 1200, 8, 0x01,
                                               100),
                               1, 1) == LUMEN_RESULT_OK);
    lumen_part_clocks_reset_strip(&clocks, 0, 1, 0);

    uint8_t buf[16 * 3];
    uint16_t n = lumen_scene_compose(&layout, &scene, &clocks, 0, 0, buf,
                                     16);
    CHECK(n == 16);

    /* 按亮度叠加：流星亮处显流星、暗处透出背景层 —— 所以整条都不该全黑。 */
    size_t lit = 0;
    for (uint16_t i = 0; i < 16; ++i) {
        if (buf[i * 3] + buf[i * 3 + 1] + buf[i * 3 + 2] > 0) {
            ++lit;
        }
    }
    CHECK(lit == 16);

    /* 叠加层让画面随时间变化（动画在跑）。 */
    uint8_t later[16 * 3];
    lumen_scene_compose(&layout, &scene, &clocks, 400, 0, later, 16);
    CHECK(memcmp(buf, later, sizeof(buf)) != 0);
}

static void test_compose_phase_not_reset_by_edit(void)
{
    /*
     * 票 #155 验收项：「改颜色时动画相位不重置」。
     *
     * 做法：让动画（彩虹）跑到 t=500，然后**只改 layer0 的饱和 / 亮度**（不动
     * 步长与步数、不重启时钟），再在同一个 t 求值——除了颜色本身，相位必须还
     * 在 500ms 的位置，而不是回到 0。
     */
    lumen_layout_store_t layout;
    lumen_scene_t scene;
    lumen_part_clocks_t clocks;
    lumen_part_clocks_init(&clocks);
    build_whole_strip_pair(&layout, &scene, 8);

    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000,
                               make_anim_layer(LUMEN_EFFECT_RAINBOW, 0, 255, 1000, 255, 0, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);
    lumen_part_clocks_reset_strip(&clocks, 0, 1, 0);

    uint8_t before[8 * 3];
    lumen_scene_compose(&layout, &scene, &clocks, 500, 0, before, 8);

    /* 改层亮度（典型的「改效果参数」编辑），时钟不动。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000,
                               make_anim_layer(LUMEN_EFFECT_RAINBOW, 0, 255, 1000, 255, 0, 50),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);

    uint8_t after[8 * 3];
    lumen_scene_compose(&layout, &scene, &clocks, 500, 0, after, 8);

    /*
     * 色相的**相对分布**必须不变：亮度 100 → 50 是把每个通道整体减半，
     * 所以「第 0 颗 vs 第 4 颗」的亮度关系保持。如果相位被重置成 0，
     * 两者会退化成相同的色相（t=0 与 t=500 的分布不同）。
     */
    CHECK(after[0] <= before[0]);
    CHECK(after[4 * 3] <= before[4 * 3]);
    /* 相位没重置的关键证据：t=500 的画面与 t=0 的画面不同。 */
    uint8_t at_zero[8 * 3];
    lumen_scene_compose(&layout, &scene, &clocks, 0, 0, at_zero, 8);
    CHECK(memcmp(after, at_zero, sizeof(after)) != 0);
}

static void test_compose_needs_frames(void)
{
    lumen_layout_store_t layout;
    lumen_scene_t scene;
    build_whole_strip_pair(&layout, &scene, 8);

    /* 单步静态 → 不需要帧（与 v4 的静态段一致，零额外 CPU / RMT）。 */
    CHECK(!lumen_scene_strip_needs_frames(&layout, &scene, 0));

    /* 换成呼吸 → 需要帧。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000,
                               make_anim_layer(LUMEN_EFFECT_BREATHING, 0, 255, 1000, 30, 0, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_strip_needs_frames(&layout, &scene, 0));

    /* 熄灭不是动画。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000,
                               make_anim_layer(LUMEN_EFFECT_OFF, 0, 0, 0, 0, 0, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);
    CHECK(!lumen_scene_strip_needs_frames(&layout, &scene, 0));

    /* 有动画但部位关掉 → 不需要帧。 */
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 1000,
                               make_anim_layer(LUMEN_EFFECT_BREATHING, 0, 255, 1000, 30, 0, 100),
                               make_empty_layer(), 1, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_part(&scene, 0, 0, 1, LUMEN_LOOP_ALL_V5, 0, 1, 1) == LUMEN_RESULT_OK);
    CHECK(!lumen_scene_strip_needs_frames(&layout, &scene, 0));

    /* 0 步也不需要帧。 */
    CHECK(lumen_scene_set_part(&scene, 0, 0, 0, LUMEN_LOOP_ALL_V5, 1, 1, 1) == LUMEN_RESULT_OK);
    CHECK(!lumen_scene_strip_needs_frames(&layout, &scene, 0));

    /* 没有部位划分的链永远不需要帧。 */
    lumen_scene_init(&scene);
    CHECK(lumen_scene_set_part(&scene, 1, 0, 1, LUMEN_LOOP_ALL_V5, 1, 2, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 1, 0, 0, 1000,
                               make_anim_layer(LUMEN_EFFECT_RAINBOW, 0, 255, 4000, 255, 0, 100),
                               make_empty_layer(), 2, 1) == LUMEN_RESULT_OK);
    CHECK(!lumen_scene_strip_needs_frames(&layout, &scene, 1));
}

static void test_compose_isolated_parts(void)
{
    /*
     * 「编辑一个部位时其它部位完全不受影响」（规格 E3 / 用户故事 45）。
     * 两个部位各占一半灯珠、各自不同颜色与不同步表；推进时间后各自的步号
     * 各自走，互不拖累（T2：循环各走各的）。
     */
    lumen_layout_store_t layout;
    lumen_scene_t scene;
    lumen_part_clocks_t clocks;
    lumen_part_clocks_init(&clocks);

    lumen_layout_store_init(&layout);
    CHECK(lumen_layout_store_write(&layout, 0, 2, 1) == LUMEN_RESULT_OK);
    /* 部位 0：0-4（眼睛），部位 1：5-9（散热）。 */
    CHECK(lumen_layout_store_set_part(&layout, 0, 0, 0, NULL, 1, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_part(&layout, 0, 1, 0, NULL, 1, LUMEN_PHASE_CONTINUOUS, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 0, 0, 4, 10, 1) == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 1, 0, 5, 9, 10, 1) == LUMEN_RESULT_OK);

    lumen_scene_init(&scene);
    /* 眼睛：0.5 秒一步、两步循环（快）。 */
    CHECK(lumen_scene_set_part(&scene, 0, 0, 2, LUMEN_LOOP_ALL_V5, 1, 1, 2) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 0, 500, make_static_layer(0, 255, 100),
                               make_empty_layer(), 1, 2) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 0, 0, 1, 500, make_static_layer(43690, 255, 100),
                               make_empty_layer(), 1, 2) == LUMEN_RESULT_OK);
    /* 散热：2 秒一步、单步循环（慢）。 */
    CHECK(lumen_scene_set_part(&scene, 0, 1, 1, LUMEN_LOOP_ALL_V5, 1, 1, 2) == LUMEN_RESULT_OK);
    CHECK(lumen_scene_set_step(&scene, 0, 1, 0, 2000, make_static_layer(21845, 255, 100),
                               make_empty_layer(), 1, 2) == LUMEN_RESULT_OK);

    lumen_part_clocks_reset_strip(&clocks, 0, 2, 0);

    /* t=600：眼睛已到第 2 步（蓝），散热还在第 1 步（绿）。 */
    uint8_t buf[10 * 3];
    lumen_scene_compose(&layout, &scene, &clocks, 600, 0, buf, 10);
    CHECK(buf[0] == 0 && buf[2] > 0);          /* 眼睛：蓝 */
    CHECK(buf[5 * 3] == 0 && buf[5 * 3 + 1] > 0); /* 散热：绿 */
    CHECK(buf[5 * 3 + 2] == 0);

    /* t=1100：眼睛回到第 1 步（红），散热仍是第 1 步（绿）。 */
    lumen_scene_compose(&layout, &scene, &clocks, 1100, 0, buf, 10);
    CHECK(buf[0] > 0 && buf[2] == 0);
    CHECK(buf[5 * 3 + 1] > 0);

    /* 两条时间轴的总时长不同，说明它们真的各走各的。 */
    CHECK(lumen_scene_part_total_ms(&scene.part[0][0]) == 1000);
    CHECK(lumen_scene_part_total_ms(&scene.part[0][1]) == 2000);
}

static void test_compose_null_safety(void)
{
    lumen_layout_store_t layout;
    lumen_scene_t scene;
    lumen_part_clocks_t clocks;
    lumen_part_clocks_init(&clocks);
    build_whole_strip_pair(&layout, &scene, 4);
    lumen_part_clocks_reset_strip(&clocks, 0, 1, 0);

    uint8_t buf[12];
    memset(buf, 0x77, sizeof(buf));
    /* 无效参数一律返回 0 且不写 buf。 */
    CHECK(lumen_scene_compose(NULL, &scene, &clocks, 0, 0, buf, 4) == 0);
    CHECK(lumen_scene_compose(&layout, NULL, &clocks, 0, 0, buf, 4) == 0);
    CHECK(lumen_scene_compose(&layout, &scene, NULL, 0, 0, buf, 4) == 0);
    CHECK(lumen_scene_compose(&layout, &scene, &clocks, 0, 0, NULL, 4) ==
          0);
    CHECK(lumen_scene_compose(&layout, &scene, &clocks, 0, 8, buf, 4) ==
          0);
    CHECK(lumen_scene_compose(&layout, &scene, &clocks, 0, 0, buf, 0) ==
          0);
    CHECK(buf[0] == 0x77);

    /* build_segment 的边界。 */
    lumen_segment_t seg;
    lumen_part_clock_t *clock = &clocks.clock[0][0];
    CHECK(!lumen_scene_build_segment(NULL, 0, 0, 4, clock, 0, &seg));
    CHECK(!lumen_scene_build_segment(&scene, 8, 0, 4, clock, 0, &seg));
    CHECK(!lumen_scene_build_segment(&scene, 0, 8, 4, clock, 0, &seg));
    CHECK(!lumen_scene_build_segment(&scene, 0, 0, 4, clock, 0, NULL));
    CHECK(lumen_scene_build_segment(&scene, 0, 0, 4, clock, 0, &seg));
    /* 段的几何是逻辑 [0, n-1]，t0 是步起点，blend 由有无叠加层推出。 */
    CHECK(seg.start == 0 && seg.end == 3);
    CHECK(seg.t0_ms == 0);
    CHECK(seg.blend == LUMEN_BLEND_OVER);
    /* 部位开关关掉 → 不构造段。 */
    CHECK(lumen_scene_set_part(&scene, 0, 0, 1, LUMEN_LOOP_ALL_V5, 0, 1, 1) == LUMEN_RESULT_OK);
    CHECK(!lumen_scene_build_segment(&scene, 0, 0, 4, clock, 0, &seg));
}

/*
 * 造两层 9 字节线格式：layer0 = 静态（hue, sat）、layer1 = 空层。
 * 与 SceneStep 的第 6..14 / 15..23 字节一一对应。
 */
static void layers_static_and_empty(uint8_t l0[9], uint8_t l1[9], uint16_t hue, uint8_t sat)
{
    memset(l0, 0, 9);
    l0[0] = LUMEN_EFFECT_STATIC;
    l0[1] = (uint8_t)(hue & 0xFF);
    l0[2] = (uint8_t)(hue >> 8);
    l0[3] = sat;
    l0[8] = LUMEN_LAYER_LEVEL_MAX;
    memset(l1, 0, 9);
    l1[0] = LUMEN_LAYER_EMPTY;
}

/* 造两层：layer0 = 带动画类型（period）、layer1 = 空层。 */
static void layers_anim_and_empty(uint8_t l0[9], uint8_t l1[9], uint8_t type, uint16_t period)
{
    memset(l0, 0, 9);
    l0[0] = type;
    l0[4] = (uint8_t)(period & 0xFF);
    l0[5] = (uint8_t)(period >> 8);
    l0[8] = LUMEN_LAYER_LEVEL_MAX;
    memset(l1, 0, 9);
    l1[0] = LUMEN_LAYER_EMPTY;
}

/*
 * v5 布局族 reducer（#155）。docs/protocol-v5.md §6.1 / §6.2 / §7.2。
 *
 * 命令层只做「一条命令自己能判定」的部分；需要布局表上下文的边界（part_id 是否
 * 已声明、seg_id 是否 < seg_count、跨部位互斥）也在命令层判——因为它拿到布局
 * 快照。这里逐条断言那些边界，以及「失败时旧布局不变」。
 */
static void test_layout_commands(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.strip_count = 2;
    state.led_count[0] = 30;
    state.led_count[1] = 10;

    lumen_layout_store_t layout;
    lumen_layout_store_init(&layout);
    lumen_command_outcome_t out;

    /* LayoutWrite 0x20：声明部位数并清空该链。 */
    CHECK(lumen_command_payload_len(LUMEN_CMD_LAYOUT_WRITE) == 2);
    lumen_frame_t f = {0};
    f.command = LUMEN_CMD_LAYOUT_WRITE;
    f.payload_len = 2;
    f.payload[0] = 0;
    f.payload[1] = 3;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(out.layout_op);
    CHECK(out.layout_opcode == LUMEN_CMD_LAYOUT_WRITE);
    CHECK(out.layout_strip == 0);
    CHECK(out.layout_part_count == 3);
    CHECK(out.cancels_selftest);
    CHECK(!out.state_changed);
    CHECK(lumen_layout_store_write(&layout, out.layout_strip, out.layout_part_count,
                                    state.strip_count) == LUMEN_RESULT_OK);

    /* part_count 上限 8；strip 越界（= strip_count）必须拒。 */
    f.payload[1] = 9;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!out.layout_op);
    CHECK(!out.cancels_selftest);
    f.payload[0] = 2; /* strip_count = 2 → 只有 0/1 合法 */
    f.payload[1] = 1;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* LayoutPart 0x21：名字 + 段数。载荷 28 字节。 */
    CHECK(lumen_command_payload_len(LUMEN_CMD_LAYOUT_PART) == LUMEN_LAYOUT_PART_BYTES);
    f.command = LUMEN_CMD_LAYOUT_PART;
    f.payload_len = LUMEN_LAYOUT_PART_BYTES;
    memset(f.payload, 0, f.payload_len);
    f.payload[0] = 0;
    f.payload[1] = 0;
    f.payload[2] = 6;
    memcpy(&f.payload[3], "眼灯", 6);
    f.payload[27] = 1;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(out.layout_opcode == LUMEN_CMD_LAYOUT_PART);
    CHECK(out.layout_name_len == 6);
    CHECK(out.layout_seg_count == 1);
    CHECK(out.layout_name[0] == 0xE7); /* 「眼」的首字节，原样透传 */
    CHECK(lumen_layout_store_set_part(&layout, 0, 0, out.layout_name_len, out.layout_name,
                                       out.layout_seg_count, LUMEN_PHASE_CONTINUOUS,
                                       state.strip_count) == LUMEN_RESULT_OK);

    /* part_id 必须已声明（LayoutWrite 说 3 个部位 → 0/1/2 合法，3 非法）。 */
    f.payload[1] = 3;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    /* name_len > 24、seg_count > 8 都拒。 */
    f.payload[1] = 0;
    f.payload[2] = 25;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    f.payload[2] = 6;
    f.payload[27] = 9;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* LayoutSeg 0x22：区间 + 跨部位互斥。 */
    CHECK(lumen_command_payload_len(LUMEN_CMD_LAYOUT_SEG) == 5);
    f.command = LUMEN_CMD_LAYOUT_SEG;
    f.payload_len = 5;
    f.payload[0] = 0;
    f.payload[1] = 0;
    f.payload[2] = 0;
    f.payload[3] = 0;
    f.payload[4] = 9;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(out.layout_opcode == LUMEN_CMD_LAYOUT_SEG);
    CHECK(out.layout_start == 0 && out.layout_end == 9);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 0, 0, 0, 9, 30,
                                      state.strip_count) == LUMEN_RESULT_OK);

    /* start > end → 0x01；end >= 该链灯珠数 → 0x01。 */
    f.payload[3] = 9;
    f.payload[4] = 3;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    f.payload[3] = 0;
    f.payload[4] = 30; /* 这条链只有 30 颗（0-29） */
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* 压到别的部位（S3）→ 0x01，且**旧布局的段保持不变**（S4）。 */
    CHECK(lumen_layout_store_set_part(&layout, 0, 1, 0, NULL, 1, LUMEN_PHASE_CONTINUOUS, state.strip_count) ==
          LUMEN_RESULT_OK);
    f.payload[1] = 1;
    f.payload[3] = 5;
    f.payload[4] = 15; /* 与部位 0 的 [0-9] 重叠 */
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!out.layout_op);
    const lumen_part_layout_t *p0 = lumen_layout_store_part(&layout, 0, 0);
    CHECK(p0->segs.seg[0][0] == 0 && p0->segs.seg[0][1] == 9);
    const lumen_part_layout_t *p1 = lumen_layout_store_part(&layout, 0, 1);
    CHECK(p1->segs.seg[0][0] == LUMEN_SEG_UNWRITTEN); /* 未被写坏 */

    /* 相邻不重叠合法（10-29 接在 0-9 之后）。 */
    f.payload[3] = 10;
    f.payload[4] = 29;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(lumen_layout_store_set_seg(&layout, 0, 1, 0, 10, 29, 30, state.strip_count) ==
          LUMEN_RESULT_OK);
    /* 整份布局现在自洽。 */
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 10, 0, 0, 0, 0, 0, 0};
    CHECK(lumen_layout_store_validate(&layout, state.strip_count, counts) == LUMEN_RESULT_OK);

    /* seg_id 必须 < 该部位声明的 seg_count（部位 0 只声明了 1 个槽位）。 */
    f.payload[1] = 0;
    f.payload[2] = 1;
    f.payload[3] = 20;
    f.payload[4] = 25;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* LayoutCommit 0x23：无载荷；只登记意图（整份校验在引擎）。 */
    CHECK(lumen_command_payload_len(LUMEN_CMD_LAYOUT_COMMIT) == 0);
    f.command = LUMEN_CMD_LAYOUT_COMMIT;
    f.payload_len = 0;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(out.layout_opcode == LUMEN_CMD_LAYOUT_COMMIT);
    CHECK(out.cancels_selftest);

    /* QueryLayout 0x24：1 字节 strip；查询不取消自检。 */
    CHECK(lumen_command_payload_len(LUMEN_CMD_QUERY_LAYOUT) == 1);
    f.command = LUMEN_CMD_QUERY_LAYOUT;
    f.payload_len = 1;
    f.payload[0] = 0;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(out.layout_opcode == LUMEN_CMD_QUERY_LAYOUT);
    CHECK(!out.cancels_selftest);
    f.payload[0] = 2;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* 布局命令都不改 State（布局不在 State 里，§7.3）。 */
    CHECK(!out.state_changed);
}

/*
 * v5 场景族 reducer（#155）。docs/protocol-v5.md §6.2 / §7.5。
 *
 * 关键差异（相对 v4）：loop 是**每部位**的三值；SceneStep 是单步增量、
 * 两层混合方式**不在线上**（有叠加层 = 按亮度叠加，否则覆盖）。
 */
static void test_scene_commands(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.strip_count = 2;
    state.led_count[0] = 30;

    lumen_layout_store_t layout;
    lumen_layout_store_init(&layout);
    lumen_command_outcome_t out;

    /* ScenePart 0x25：scene, strip, part, step_count, loop, on。 */
    CHECK(lumen_command_payload_len(LUMEN_CMD_SCENE_PART) == 6);
    lumen_frame_t f = {0};
    f.command = LUMEN_CMD_SCENE_PART;
    f.payload_len = 6;
    f.payload[0] = 0; /* scene */
    f.payload[1] = 0; /* strip */
    f.payload[2] = 0; /* part */
    f.payload[3] = 2; /* step_count */
    f.payload[4] = 1; /* loop = 全部循环 */
    f.payload[5] = 1; /* on */
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(out.scene_op);
    CHECK(out.scene_opcode == LUMEN_CMD_SCENE_PART);
    CHECK(out.scene_id == 0 && out.scene_strip == 0 && out.scene_part == 0);
    CHECK(out.scene_step_count == 2);
    CHECK(out.scene_loop == 1);
    CHECK(out.scene_on == 1);
    CHECK(out.cancels_selftest);

    /* scene_id 只有 0-2；loop 只有三值；on 只有 0/1；step_count <= 8。 */
    struct {
        uint8_t scene, strip, part, steps, loop, on;
        uint8_t expect;
    } parts[] = {
        {3, 0, 0, 1, 1, 1, LUMEN_RESULT_INVALID_PARAM},   /* scene 越界 */
        {0, 2, 0, 1, 1, 1, LUMEN_RESULT_INVALID_PARAM},   /* strip 越界 */
        {0, 0, 8, 1, 1, 1, LUMEN_RESULT_INVALID_PARAM},   /* part 越界 */
        {0, 0, 0, 9, 1, 1, LUMEN_RESULT_INVALID_PARAM},   /* steps > 8 */
        {0, 0, 0, 1, 3, 1, LUMEN_RESULT_INVALID_PARAM},   /* loop 只有 0/1/2 */
        {0, 0, 0, 1, 1, 2, LUMEN_RESULT_INVALID_PARAM},   /* on 只有 0/1 */
        {0, 0, 0, 0, 0, 0, LUMEN_RESULT_OK},              /* 0 步合法（S10） */
        {2, 1, 7, 8, 2, 1, LUMEN_RESULT_OK},              /* 上限组合 */
    };
    for (size_t i = 0; i < sizeof(parts) / sizeof(parts[0]); ++i) {
        f.payload[0] = parts[i].scene;
        f.payload[1] = parts[i].strip;
        f.payload[2] = parts[i].part;
        f.payload[3] = parts[i].steps;
        f.payload[4] = parts[i].loop;
        f.payload[5] = parts[i].on;
        lumen_command_dispatch(&f, &state, &layout, 255, &out);
        CHECK(out.result_code == parts[i].expect);
        if (parts[i].expect == LUMEN_RESULT_OK) {
            CHECK(out.scene_op);
            CHECK(out.cancels_selftest);
        } else {
            CHECK(!out.scene_op);
            CHECK(!out.cancels_selftest);
        }
    }

    /* SceneStep 0x26：24 字节。两层 9 字节定宽。 */
    CHECK(lumen_command_payload_len(LUMEN_CMD_SCENE_STEP) == LUMEN_SCENE_STEP_BYTES);
    f.command = LUMEN_CMD_SCENE_STEP;
    f.payload_len = LUMEN_SCENE_STEP_BYTES;
    memset(f.payload, 0, f.payload_len);
    f.payload[0] = 0; /* scene */
    f.payload[1] = 0; /* strip */
    f.payload[2] = 0; /* part */
    f.payload[3] = 1; /* step_index */
    f.payload[4] = 0xE8; /* duration = 1000 */
    f.payload[5] = 0x03;
    layers_static_and_empty(&f.payload[6], &f.payload[15], 0, 255);
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(out.scene_opcode == LUMEN_CMD_SCENE_STEP);
    CHECK(out.scene_step_index == 1);
    CHECK(out.scene_duration_ms == 1000);
    CHECK(out.scene_layer[0][0] == LUMEN_EFFECT_STATIC);
    CHECK(out.scene_layer[1][0] == LUMEN_LAYER_EMPTY);
    CHECK(out.cancels_selftest);

    /* 时长区间 100-60000。 */
    f.payload[4] = 99;
    f.payload[5] = 0;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    f.payload[4] = 0;
    f.payload[5] = 0;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    /* 60000 = E8 03 反过来是 0xEA60 → 60 60 */
    f.payload[4] = 0x60;
    f.payload[5] = 0xEA;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(out.scene_duration_ms == 60000);
    f.payload[4] = 0x61; /* 60001 */
    f.payload[5] = 0xEA;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* 两层形状：layer0 不能为空；空层的 level 必须 0；level <= 100。 */
    f.payload[4] = 0xE8;
    f.payload[5] = 0x03;
    memset(&f.payload[6], 0, 9);
    f.payload[6] = LUMEN_LAYER_EMPTY; /* layer0 空 */
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    layers_static_and_empty(&f.payload[6], &f.payload[15], 0, 255);
    f.payload[14] = 101; /* layer0.level = 101 */
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    layers_static_and_empty(&f.payload[6], &f.payload[15], 0, 255);
    f.payload[15] = LUMEN_LAYER_EMPTY;
    f.payload[23] = 50; /* 空层 level 非 0 */
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* 未知类型 0x09 → 0x01。 */
    layers_static_and_empty(&f.payload[6], &f.payload[15], 0, 255);
    f.payload[6] = 0x09;
    f.payload[14] = 100;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* 呼吸周期下限 334：300 拒绝、334 通过。 */
    layers_anim_and_empty(&f.payload[6], &f.payload[15], LUMEN_EFFECT_BREATHING, 300);
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    layers_anim_and_empty(&f.payload[6], &f.payload[15], LUMEN_EFFECT_BREATHING, 334);
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);

    /* 爆闪 flags 必须为 0（§7.1 第 8 步）。 */
    layers_anim_and_empty(&f.payload[6], &f.payload[15], LUMEN_EFFECT_STROBE, 100);
    f.payload[13] = 0x01; /* layer0.flags = param[6]（payload 6 + 层内 7） */
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* 静态层 param[3..6] 保留位必须为 0。 */
    layers_static_and_empty(&f.payload[6], &f.payload[15], 0, 255);
    f.payload[10] = 0x01; /* layer0.param[3]（层内偏移 4：type 1 + param 7 + level 1） */
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* step_index < 8 与 part < 8 在上层判；场景与布局都不改 State。 */
    layers_static_and_empty(&f.payload[6], &f.payload[15], 0, 255);
    f.payload[3] = 8;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    f.payload[3] = 0;
    f.payload[2] = 8;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!out.state_changed);

    /* SceneName 0x27：26 字节；name_len <= 24。 */
    CHECK(lumen_command_payload_len(LUMEN_CMD_SCENE_NAME) == LUMEN_SCENE_NAME_BYTES);
    f.command = LUMEN_CMD_SCENE_NAME;
    f.payload_len = LUMEN_SCENE_NAME_BYTES;
    memset(f.payload, 0, f.payload_len);
    f.payload[0] = 1;
    f.payload[1] = 6;
    memcpy(&f.payload[2], "待机", 6);
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(out.scene_opcode == LUMEN_CMD_SCENE_NAME);
    CHECK(out.scene_id == 1);
    CHECK(out.scene_name_len == 6);
    CHECK(out.scene_name[0] == 0xE5);
    f.payload[1] = 25;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    f.payload[0] = 3;
    f.payload[1] = 6;
    lumen_command_dispatch(&f, &state, &layout, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* ActivateScene 0x28 / QueryScene 0x29：1 字节 scene_id。 */
    CHECK(lumen_command_payload_len(LUMEN_CMD_ACTIVATE_SCENE) == 1);
    CHECK(lumen_command_payload_len(LUMEN_CMD_QUERY_SCENE) == 1);
    for (uint8_t cmd = LUMEN_CMD_ACTIVATE_SCENE; cmd <= LUMEN_CMD_QUERY_SCENE; ++cmd) {
        f.command = cmd;
        f.payload_len = 1;
        f.payload[0] = 2;
        lumen_command_dispatch(&f, &state, &layout, 255, &out);
        CHECK(out.result_code == LUMEN_RESULT_OK);
        CHECK(out.scene_opcode == cmd);
        CHECK(out.scene_id == 2);
        /* 查询不取消自检；激活会。 */
        CHECK(out.cancels_selftest == (cmd == LUMEN_CMD_ACTIVATE_SCENE));
        f.payload[0] = 3;
        lumen_command_dispatch(&f, &state, &layout, 255, &out);
        CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    }
    CHECK(!out.state_changed);
}

/*
 * v5 的三条新报告编码器（LayoutReport / LayoutListEnd / ScenePartReport /
 * SceneStepReport / SceneListEnd）。逐字节对齐 §7.2 / §7.4 的参考向量。
 */
static void test_encode_v5_reports(void)
{
    uint8_t out[LUMEN_MAX_FRAME];

    /* LayoutReport 0x89：44 字节。参考向量 layout_report_eye_1_seg。 */
    uint8_t name[LUMEN_NAME_BYTES];
    memset(name, 0, sizeof(name));
    memcpy(name, "眼灯", 6);
    uint8_t segs[LUMEN_MAX_PART_SEGS][2];
    memset(segs, 0, sizeof(segs));
    segs[0][0] = 0;
    segs[0][1] = 1;
    size_t len = lumen_protocol_encode_layout_report(0x4C, 0, 0, 6, name, 1,
                                                     LUMEN_PHASE_PER_SEGMENT, segs, out,
                                                     sizeof(out));
    CHECK(len == LUMEN_LAYOUT_REPORT_BYTES + LUMEN_FRAME_OVERHEAD);
    CHECK(out[6] == 0 && out[7] == 0 && out[8] == 6);
    CHECK(out[6 + 27] == 1);
    /* 相位紧跟在 seg_count 之后（§7.2）。 */
    CHECK(out[6 + 28] == LUMEN_PHASE_PER_SEGMENT);
    CHECK(out[6 + 29] == 0 && out[6 + 30] == 1);
    /* 未用的段写 0/0。 */
    for (uint8_t i = 1; i < LUMEN_MAX_PART_SEGS; ++i) {
        CHECK(out[6 + 29 + i * 2] == 0 && out[6 + 29 + i * 2 + 1] == 0);
    }
    /* 参数越界拒绝。 */
    CHECK(lumen_protocol_encode_layout_report(0x01, 0, 0, LUMEN_NAME_BYTES + 1, name, 1,
                                              LUMEN_PHASE_CONTINUOUS, segs, out,
                                              sizeof(out)) == 0);
    CHECK(lumen_protocol_encode_layout_report(0x01, 0, 0, 6, name, LUMEN_MAX_PART_SEGS + 1,
                                              LUMEN_PHASE_CONTINUOUS, segs, out,
                                              sizeof(out)) == 0);
    /* 相位越界也拒（只有 0 / 1）。 */
    CHECK(lumen_protocol_encode_layout_report(0x01, 0, 0, 6, name, 1, LUMEN_PHASE_MAX + 1, segs,
                                              out, sizeof(out)) == 0);

    /* LayoutListEnd 0x8A：2 字节 [strip_id, part_mask]。 */
    len = lumen_protocol_encode_layout_list_end(0x4C, 0, 0x05, out, sizeof(out));
    CHECK(len == 2 + LUMEN_FRAME_OVERHEAD);
    CHECK(out[2] == LUMEN_CMD_LAYOUT_LIST_END);
    CHECK(out[6] == 0 && out[7] == 0x05);

    /* ScenePartReport 0x8B：6 字节。 */
    len = lumen_protocol_encode_scene_part_report(0x10, 0, 0, 0, 3, 1, 1, out, sizeof(out));
    CHECK(len == 6 + LUMEN_FRAME_OVERHEAD);
    CHECK(out[2] == LUMEN_CMD_SCENE_PART_REPORT);
    uint8_t expect_part[6] = {0, 0, 0, 3, 1, 1};
    CHECK(memcmp(&out[6], expect_part, 6) == 0);

    /* SceneStepReport 0x8C：24 字节，与 SceneStep 同构。 */
    uint8_t l0[9];
    uint8_t l1[9];
    layers_static_and_empty(l0, l1, 0, 255);
    len = lumen_protocol_encode_scene_step_report(0x10, 0, 0, 0, 0, 1000, l0, l1, out,
                                                  sizeof(out));
    CHECK(len == LUMEN_SCENE_STEP_BYTES + LUMEN_FRAME_OVERHEAD);
    CHECK(out[2] == LUMEN_CMD_SCENE_STEP_REPORT);
    CHECK(out[6] == 0 && out[7] == 0 && out[8] == 0 && out[9] == 0);
    CHECK(out[10] == 0xE8 && out[11] == 0x03); /* duration 1000 小端 */
    CHECK(memcmp(&out[12], l0, 9) == 0);
    CHECK(memcmp(&out[21], l1, 9) == 0);
    /* layer1 = NULL 时写空层（0xFF + 8 个 0）。 */
    len = lumen_protocol_encode_scene_step_report(0x10, 0, 0, 0, 0, 1000, l0, NULL, out,
                                                  sizeof(out));
    CHECK(len == LUMEN_SCENE_STEP_BYTES + LUMEN_FRAME_OVERHEAD);
    CHECK(out[21] == LUMEN_LAYER_EMPTY);
    for (uint8_t i = 1; i < 9; ++i) {
        CHECK(out[21 + i] == 0);
    }

    /* SceneListEnd 0x8D：26 字节 [scene_id, name_len, name[24]]。 */
    len = lumen_protocol_encode_scene_list_end(0x10, 1, 6, name, out, sizeof(out));
    CHECK(len == LUMEN_SCENE_NAME_BYTES + LUMEN_FRAME_OVERHEAD);
    CHECK(out[2] == LUMEN_CMD_SCENE_LIST_END);
    CHECK(out[6] == 1 && out[7] == 6);
    CHECK(memcmp(&out[8], name, 6) == 0);
    CHECK(lumen_protocol_encode_scene_list_end(0x10, 1, LUMEN_NAME_BYTES + 1, name, out,
                                               sizeof(out)) == 0);

    /* StateReport 载荷是 32 字节（v4 的 37 已作废）。 */
    CHECK(LUMEN_STATE_BYTES == 32);
    uint8_t state_bytes[LUMEN_STATE_BYTES] = {0};
    len = lumen_protocol_encode_state_report(0x07, state_bytes, out, sizeof(out));
    CHECK(len == LUMEN_STATE_BYTES + LUMEN_FRAME_OVERHEAD);
}

int main(int argc, char **argv)
{
    /* 默认路径只是兜底：run-tests.cmd 会显式传 v5 向量（docs/protocol-testvectors-v5.json）。 */
    const char *vectors = argc > 1 ? argv[1] : "docs/protocol-testvectors-v5.json";

    /* 向量阶段不在任何 test_*() 里跑，单独记一条 "vectors"，否则各行之和会少掉
       这一大块（约 2700 条），「各行之和 == 总数」这条对账就过不了。 */
    int vector_before = g_checks;
    int cases = for_each_case(vectors, dispatch_case);
    CHECK(cases > 0);
    if (cases > 0) {
        printf("vectors: %d cases from %s\n", cases, vectors);
    }
    report_test_count("vectors", vector_before);

    RUN_TEST(test_checksum);
    RUN_TEST(test_set_power_reducer);
    RUN_TEST(test_set_brightness_reducer);
    RUN_TEST(test_retired_commands);
    RUN_TEST(test_encode_ack_all_results);
    RUN_TEST(test_encode_event_storage_failed);
    RUN_TEST(test_encode_limits);
    RUN_TEST(test_decode_short);
    RUN_TEST(test_decode_bad_frames_echo_header);
    RUN_TEST(test_decode_max_payload);
    RUN_TEST(test_reject_v2_protocol_frames);
    RUN_TEST(test_state_defaults_and_clamp);
    RUN_TEST(test_state_bytes_layout);
    RUN_TEST(test_selftest_sequence);
    RUN_TEST(test_selftest_late_wake);
    RUN_TEST(test_selftest_restart);
    RUN_TEST(test_selftest_cancel_rules);
    RUN_TEST(test_selftest_leaves_state_untouched);
    RUN_TEST(test_selftest_compose);
    RUN_TEST(test_gamma);
    RUN_TEST(test_gamma_hue_loss_clip);
    RUN_TEST(test_two_layer_single_layer_regression);
    RUN_TEST(test_blend_math);
    RUN_TEST(test_two_layer_validation_matrix);
    RUN_TEST(test_layer_codec);
    RUN_TEST(test_apply_level_q8);
    RUN_TEST(test_layer_level_static_steps);
    RUN_TEST(test_layer_level_independent_per_layer);
    RUN_TEST(test_level_times_brightness_then_gamma_once);
    RUN_TEST(test_layer_level_validation);
    RUN_TEST(test_breathing_floor_is_level_times_min_pct);
    RUN_TEST(test_blend_gamma_once);
    RUN_TEST(test_two_layer_shared_phase);
    RUN_TEST(test_two_layer_ram_sizes);
    RUN_TEST(test_two_layer_needs_frames);
    RUN_TEST(test_set_led_count_reducer);
    RUN_TEST(test_led_count_job);
    RUN_TEST(test_save_scheduler);
    RUN_TEST(test_state_blob);
    RUN_TEST(test_effects_static_rgb);
    RUN_TEST(test_effects_dispatch);
    RUN_TEST(test_encode_strip_config_report);
    RUN_TEST(test_encode_device_info_report);
    RUN_TEST(test_effects_breathing_phase);
    RUN_TEST(test_effects_breathing_envelope);
    RUN_TEST(test_effects_breathing_gain_and_pixel);
    RUN_TEST(test_effects_rainbow_hue);
    RUN_TEST(test_effects_rainbow_pixel);
    RUN_TEST(test_effects_comet_gain);
    RUN_TEST(test_effects_comet_density);
    RUN_TEST(test_effects_comet_solid_tail);
    RUN_TEST(test_effects_flicker);
    RUN_TEST(test_effects_strobe);
    RUN_TEST(test_effects_heartbeat);
    RUN_TEST(test_effects_off);
    RUN_TEST(test_effects_new_types_validation);
    RUN_TEST(test_effects_new_types_animation);
    RUN_TEST(test_effects_rainbow_comet_coexist);
    RUN_TEST(test_set_strip_power_command);
    RUN_TEST(test_set_strip_power_validation_edges);
    RUN_TEST(test_strip_mask_allows);
    RUN_TEST(test_global_power_leaves_strip_mask);
    RUN_TEST(test_strip_tdm_plan);
    RUN_TEST(test_per_strip_led_counts_30_60_10);
    RUN_TEST(test_per_strip_led_counts_100_24);
    RUN_TEST(test_reasm_single_chunk);
    RUN_TEST(test_reasm_multi_chunk);
    RUN_TEST(test_reasm_first_reentry);
    RUN_TEST(test_reasm_overflow);
    RUN_TEST(test_reasm_timeout);
    RUN_TEST(test_reasm_orphan_and_helpers);
    RUN_TEST(test_planar_parse_list);
    RUN_TEST(test_planar_init_validation);
    RUN_TEST(test_planar_round_robin);
    RUN_TEST(test_planar_set_count);
    RUN_TEST(test_planar_stats);
    RUN_TEST(test_planar_null_safety);


    /* v5（#155）：布局与场景两套存储 */
    RUN_TEST(test_layout_sizes);
    RUN_TEST(test_layout_part_of_pixel);
    RUN_TEST(test_layout_write_clears);
    RUN_TEST(test_layout_part_name_padding);
    RUN_TEST(test_layout_seg_rejects_overlap);
    RUN_TEST(test_layout_seg_range);
    RUN_TEST(test_layout_partial_write);
    RUN_TEST(test_layout_multi_segment_logical_index);
    RUN_TEST(test_layout_validate_whole);
    RUN_TEST(test_layout_blob_roundtrip);
    RUN_TEST(test_layout_blob_rejects_bad);
    RUN_TEST(test_scene_sizes);
    RUN_TEST(test_scene_set_part_clears);
    RUN_TEST(test_scene_set_step_rules);
    RUN_TEST(test_scene_loop_and_clock);
    RUN_TEST(test_scene_layer_sizes);
    RUN_TEST(test_scene_blob_max_size);
    RUN_TEST(test_scene_blob_roundtrip);
    RUN_TEST(test_scene_blob_rejects_bad);
    RUN_TEST(test_scene_encode_capacity);

    /* v5（#155）：播放头推进与唯一渲染接缝 */
    RUN_TEST(test_part_clock_basics);
    RUN_TEST(test_part_clock_no_loop);
    RUN_TEST(test_part_clock_loop_last);
    RUN_TEST(test_part_clock_zero_steps);
    RUN_TEST(test_part_clock_no_drift);
    RUN_TEST(test_compose_uncovered_is_black);
    RUN_TEST(test_compose_part_switch);
    RUN_TEST(test_compose_multi_segment_shared_phase);
    RUN_TEST(test_compose_two_layers);
    RUN_TEST(test_compose_phase_not_reset_by_edit);
    RUN_TEST(test_compose_needs_frames);
    RUN_TEST(test_compose_isolated_parts);
    RUN_TEST(test_compose_null_safety);

    /* v5（#155）：两族新命令的 reducer 语义与三条新报告 */
    RUN_TEST(test_layout_commands);
    RUN_TEST(test_scene_commands);
    RUN_TEST(test_encode_v5_reports);

    if (g_failures != 0) {
        fprintf(stderr, "\n%d/%d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("all %d checks passed\n", g_checks);
    return 0;
}
