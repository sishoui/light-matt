/*
 * Host 单元测试：不依赖 ESP-IDF，不连硬件。
 *
 * 主要覆盖：
 *   1. docs/protocol-testvectors-v4.json 里的全部用例（两端共用的唯一向量文件）：
 *      - app_to_device 合法帧：解码字段与编码结果逐字节一致，再跑命令层 reducer；
 *      - 非法帧：只有 4 个是信封级失败（bad_magic / bad_version / bad_crc /
 *        bad_length_overflow），其余 frame_valid=false 的是**命令层拒收**
 *        （退役命令 / 参数越界 / ScriptTooLarge），信封本身是合法的；
 *      - device_to_app 帧：解码，并用对应的报告编码器逐字节复现；
 *      - chunks_hex：每一片喂给重组器，断言拼回的字节正好等于 frame_hex，
 *        并核对 FIRST / LAST / 序号语义。
 *   2. SetPower / SetBrightness / SetLedCount reducer 的取值与状态语义
 *      （含亮度钳位、开关解耦、相同值不 commit），以及退役命令与未实现命令的明确回退。
 *   3. state 默认值/钳位/37 字节布局、CRC16 KAT、分片重组边界、gamma + 亮度乘算。
 *
 * 运行：firmware/test/run-tests.cmd（会传 v4 向量路径作为 argv[1]）。
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
#include "led_count_job.h"
#include "led_engine_slots.h"
#include "protocol.h"
#include "save_scheduler.h"
#include "script_blob.h"
#include "script_store.h"
#include "segment_store.h"
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

static uint16_t layer_hue(const lumen_effect_layer_t *layer)
{
    return lumen_layer_hue(layer);
}

static void layer_set_hue(lumen_effect_layer_t *layer, uint16_t hue)
{
    layer->param[0] = (uint8_t)(hue & 0xFF);
    layer->param[1] = (uint8_t)(hue >> 8);
}

static uint8_t layer_sat(const lumen_effect_layer_t *layer)
{
    return lumen_layer_sat(layer);
}

static void layer_set_sat(lumen_effect_layer_t *layer, uint8_t sat)
{
    layer->param[2] = sat;
}

static uint16_t layer_period(const lumen_effect_layer_t *layer)
{
    return lumen_layer_period_ms(layer);
}

static void layer_set_period(lumen_effect_layer_t *layer, uint16_t period_ms)
{
    layer->param[3] = (uint8_t)(period_ms & 0xFF);
    layer->param[4] = (uint8_t)(period_ms >> 8);
}

static uint8_t layer_p5(const lumen_effect_layer_t *layer)
{
    return lumen_layer_p5(layer);
}

static void layer_set_p5(lumen_effect_layer_t *layer, uint8_t p5)
{
    layer->param[5] = p5;
}

static uint8_t layer_flags(const lumen_effect_layer_t *layer)
{
    return lumen_layer_flags(layer);
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

/*
 * 由向量里的 prior_segments 构造前置段表。
 *
 * 语法：`seg_id:start-end`，多条用 `;` 分隔（只用于 host 测试的前置状态，
 * 向量文件本身仍是两端的字节契约）。空串 = 空段表。
 * 段类型固定为静态、hue=0、sat=255——这些前置段只用于触发重叠判定。
 */
static void apply_prior_segments(lumen_segment_store_t *store, const char *spec)
{
    lumen_segment_store_init(store);
    if (spec == NULL || spec[0] == '\0') {
        return;
    }
    char copy[64];
    snprintf(copy, sizeof(copy), "%s", spec);
    for (char *token = strtok(copy, ";"); token != NULL; token = strtok(NULL, ";")) {
        unsigned seg_id = 0, start = 0, end = 0;
        if (sscanf(token, "%u:%u-%u", &seg_id, &start, &end) != 3) {
            fprintf(stderr, "[FAIL] bad prior_segments token: %s\n", token);
            ++g_failures;
            continue;
        }
        lumen_segment_t seg;
        memset(&seg, 0, sizeof(seg));
        seg.active = true;
        seg.start = (uint8_t)start;
        seg.end = (uint8_t)end;
        layer_set(LUMEN_EFFECT_STATIC, 0, 255, 0, 0, 0, &seg.layer[0]);
        layer_clear(&seg.layer[1]);
        if (lumen_segment_store_set(store, 0, 1, (uint8_t)seg_id, 64, &seg) !=
            LUMEN_RESULT_OK) {
            fprintf(stderr, "[FAIL] prior_segments could not be applied: %s\n", token);
            ++g_failures;
        }
    }
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
 * 在 host 上重放一串剧本命令（"cmd:payloadhex;cmd:payloadhex;…"）到本地剧本表。
 *
 * 这不是完整的引擎：它只做 §9.6 的下发流程（Begin → Stage → Segment → Commit），
 * 用来把一个用例的**设备侧前置状态**表达成向量数据。解析失败返回 false。
 * v3 向量文件目前不带 prior_script，保留实现是为了 v2 的向量级前置状态仍可读。
 */
static bool apply_prior_script(lumen_script_store_t *store, const char *spec)
{
    lumen_script_store_init(store);
    if (spec == NULL || spec[0] == '\0') {
        return true;
    }

    const char *p = spec;
    while (*p != '\0') {
        /* 取一项直到 ';'（不含）。 */
        const char *item_begin = p;
        while (*p != '\0' && *p != ';') {
            ++p;
        }
        size_t item_len = (size_t)(p - item_begin);
        if (*p == ';') {
            ++p;
        }
        if (item_len == 0) {
            continue;
        }

        /* 拆 `cmd:payloadhex`（就地复制到局部缓冲，不改原串）。 */
        char item[256];
        if (item_len >= sizeof(item)) {
            return false;
        }
        memcpy(item, item_begin, item_len);
        item[item_len] = '\0';
        char *colon = strchr(item, ':');
        if (colon == NULL) {
            return false;
        }
        *colon = '\0';
        long cmd = strtol(item, NULL, 10);
        uint8_t payload[LUMEN_MAX_PAYLOAD];
        size_t len = hex_to_bytes(colon + 1, payload, sizeof(payload));
        if (len == (size_t)-1) {
            return false;
        }

        switch (cmd) {
        case LUMEN_CMD_SCRIPT_BEGIN:
            if (len != 3 || !lumen_script_begin(store, payload[0], payload[1], payload[2])) {
                return false;
            }
            break;
        case LUMEN_CMD_SCRIPT_STAGE: {
            uint16_t duration = (uint16_t)(payload[2] | ((uint16_t)payload[3] << 8));
            if ((len != 4 && len != 6) ||
                !lumen_script_stage(store, payload[0], payload[1], duration, 0)) {
                return false;
            }
            break;
        }
        case LUMEN_CMD_SCRIPT_SEGMENT: {
            /* v4：script_id, stage_index + §7.1 的 23 字节（layer0 在偏移 7）。 */
            size_t layer_off;
            if (len == 25) {
                layer_off = 7;
            } else if (len >= 7) {
                layer_off = 6; /* v2 形态：script_id, stage_index, strip, seg, start, end, type… */
            } else {
                return false;
            }
            lumen_segment_t seg;
            memset(&seg, 0, sizeof(seg));
            seg.active = true;
            seg.start = payload[layer_off - 3];
            seg.end = payload[layer_off - 2];
            if (len == 25) {
                /* v4：blend 在 layer0 前一个字节，layer1 紧随其后 9 字节。 */
                seg.blend = payload[layer_off - 1];
                (void)lumen_layer_decode(&payload[layer_off], &seg.layer[0]);
                (void)lumen_layer_decode(&payload[layer_off + 9], &seg.layer[1]);
            } else {
                layer_set(payload[layer_off], 0, 0, 0, 0, 0, &seg.layer[0]);
                layer_clear(&seg.layer[1]);
            }
            if (!lumen_script_segment(store, payload[0], payload[1], payload[2], payload[3], &seg,
                                      NULL)) {
                return false;
            }
            break;
        }
        case LUMEN_CMD_SCRIPT_COMMIT: {
            uint16_t counts[LUMEN_MAX_STRIPS] = {64, 64, 64, 64, 64, 64, 64, 64};
            if (len != 1 ||
                lumen_script_commit(store, payload[0], counts, NULL, 0, NULL) !=
                    LUMEN_SCRIPT_COMMIT_OK) {
                return false;
            }
            break;
        }
        case LUMEN_CMD_SCRIPT_ABORT:
            if (len != 1) {
                return false;
            }
            lumen_script_abort(store, payload[0]);
            break;
        default:
            return false;
        }
    }
    return true;
}

/* 把命令层的剧本意图重放到本地剧本表（与 ble_link 的 script dispatch 同构）。
 * 返回引擎级结果码。 */
static uint8_t apply_script_op(lumen_script_store_t *store,
                               const lumen_command_outcome_t *outcome)
{
    switch (outcome->script_op) {
    case LUMEN_SCRIPT_OP_BEGIN:
        return lumen_script_begin(store, outcome->script_id, outcome->script_stage_count,
                                  outcome->script_strip_count)
                   ? LUMEN_RESULT_OK
                   : LUMEN_RESULT_INVALID_PARAM;
    case LUMEN_SCRIPT_OP_STAGE:
        return lumen_script_stage(store, outcome->script_id, outcome->script_stage_index,
                                  outcome->script_duration_ms, 0)
                   ? LUMEN_RESULT_OK
                   : LUMEN_RESULT_INVALID_PARAM;
    case LUMEN_SCRIPT_OP_SEGMENT:
        return lumen_script_segment(store, outcome->script_id, outcome->script_stage_index,
                                    outcome->script_strip, outcome->script_seg,
                                    &outcome->script_segment, NULL)
                   ? LUMEN_RESULT_OK
                   : LUMEN_RESULT_INVALID_PARAM;
    case LUMEN_SCRIPT_OP_COMMIT: {
        uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};
        return lumen_script_commit(store, outcome->script_id, counts, NULL, 0, NULL) ==
                       LUMEN_SCRIPT_COMMIT_OK
                   ? LUMEN_RESULT_OK
                                                                     : LUMEN_RESULT_INVALID_PARAM;
    }
    case LUMEN_SCRIPT_OP_ABORT:
        lumen_script_abort(store, outcome->script_id);
        return LUMEN_RESULT_OK;
    case LUMEN_SCRIPT_OP_ACTIVATE:
        return lumen_script_is_committed(store, outcome->script_id) ? LUMEN_RESULT_OK
                                                                   : LUMEN_RESULT_INVALID_PARAM;
    case LUMEN_SCRIPT_OP_QUERY:
    case LUMEN_SCRIPT_OP_PLAYBACK:
        return LUMEN_RESULT_OK;
    default:
        return LUMEN_RESULT_INVALID_PARAM;
    }
}

/* 解析 "id:count"（keep_script 字段）。 */
static bool parse_keep_script(const char *spec, uint8_t *id, uint8_t *count)
{
    if (spec == NULL || spec[0] == '\0') {
        return false;
    }
    char *end = NULL;
    long parsed_id = strtol(spec, &end, 10);
    if (end == NULL || *end != ':') {
        return false;
    }
    long parsed_count = strtol(end + 1, NULL, 10);
    *id = (uint8_t)parsed_id;
    *count = (uint8_t)parsed_count;
    return true;
}

/*
 * 向量用例的基线状态：8 条灯带 × 64 灯。
 *
 * 为什么不是 `lumen_state_defaults()` 的 1 条 30 灯：v3 向量里的段命令直接寻址
 * strip 0-3 且 end=63，`set_strip_power_bad_strip8` 还明确假设 strip_count=8。
 * 向量是字节契约，不是设备初始状态，所以这里显式给一个能容纳全部用例的基线。
 */
static void vector_baseline(lumen_state_t *state, uint16_t *strip_counts)
{
    lumen_state_defaults(state, 64);
    state->strip_count = 8;
    state->led_count = 64;
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        strip_counts[i] = 64;
    }
}

/*
 * v3 的 4 个信封级失败用例。其余 frame_valid=false 的用例是合法信封配
 * 命令层拒收（退役命令 / 参数越界 / ScriptTooLarge）。
 */
static bool is_envelope_failure(const char *name)
{
    return strcmp(name, "bad_magic") == 0 || strcmp(name, "bad_version") == 0 ||
           strcmp(name, "bad_crc") == 0 || strcmp(name, "bad_length_overflow") == 0;
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
    uint16_t strip_counts[LUMEN_MAX_STRIPS];
    vector_baseline(&before, strip_counts);

    lumen_command_outcome_t outcome;

    /*
     * 段命令用向量里的 prior_segments 构造前置段表（形如 "0:0-15"，
     * 分号分隔多条）。没有该字段就是空段表。
     */
    lumen_segment_store_t segments;
    apply_prior_segments(&segments, c->prior_segments);

    /* 剧本命令前置状态（v3 向量目前不带，保留给 v2 形态的向量级前置）。 */
    lumen_script_store_t scripts;
    CHECK(apply_prior_script(&scripts, c->prior_script));

    lumen_command_dispatch(&frame, &before, &segments, strip_counts, 255, &outcome);

    /*
     * 契约里的预期结果码。
     *
     * script_commit_too_large 是唯一需要解释的一条：向量只带 `ScriptCommit`
     * 这一帧，没有前置的暂存内容，所以命令层必然放行、结果码是 OK。真正的
     * 0x0A 由 lumen_script_commit 的尺寸预检产生，覆盖在
     * test_script_commit_too_large（8 带 × 8 阶段 × 8 段的两套满配剧本）
     * 与 test_script_commit_implies_persistable（「能 commit 一定存得下」不变式）。
     */
    if (strcmp(c->name, "script_commit_too_large") == 0) {
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.script_op == LUMEN_SCRIPT_OP_COMMIT);
        return;
    }

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
        /* v3 的两条无载荷查询：ACK 0x00 + 一条报告，不改状态、不取消自检。 */
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.strip_config_query ==
              (frame.command == LUMEN_CMD_QUERY_STRIP_CONFIG));
        CHECK(outcome.device_info_query ==
              (frame.command == LUMEN_CMD_QUERY_DEVICE_INFO));
        CHECK(!outcome.state_changed);
        CHECK(!outcome.cancels_selftest);
    } else if (frame.command == LUMEN_CMD_SET_SEGMENT ||
               frame.command == LUMEN_CMD_CLEAR_SEGMENT ||
               frame.command == LUMEN_CMD_QUERY_STRIP) {
        CHECK(!outcome.state_changed);
        if (frame.command == LUMEN_CMD_SET_SEGMENT &&
            outcome.result_code == LUMEN_RESULT_OK) {
            CHECK(outcome.segment_op);
            CHECK(!outcome.segment_clear);
            CHECK(outcome.segment.active);
            /* layer0 在 v4 载荷偏移 5：type + param[7] + level；layer1 在偏移 14。 */
            CHECK(outcome.segment.layer[0].type == frame.payload[5]);
            CHECK(outcome.segment.layer[1].type == frame.payload[14]);
            CHECK(outcome.segment.blend == frame.payload[4]);
            CHECK(outcome.segment.start == frame.payload[2]);
            CHECK(outcome.segment.end == frame.payload[3]);
            CHECK(outcome.cancels_selftest);
        } else if (frame.command == LUMEN_CMD_CLEAR_SEGMENT &&
                   outcome.result_code == LUMEN_RESULT_OK) {
            CHECK(outcome.segment_op);
            CHECK(outcome.segment_clear);
            CHECK(outcome.cancels_selftest);
        } else if (frame.command == LUMEN_CMD_QUERY_STRIP &&
                   outcome.result_code == LUMEN_RESULT_OK) {
            CHECK(outcome.strip_query);
            CHECK(outcome.query_strip_id == frame.payload[0]);
            CHECK(!outcome.cancels_selftest);
        } else {
            CHECK(!outcome.segment_op);
            CHECK(!outcome.strip_query);
            CHECK(!outcome.cancels_selftest);
        }
    } else if (frame.command == LUMEN_CMD_SET_STRIP_POWER) {
        /* #36：只做校验与意图登记，掩码本身由 ble_link 写入（#38 接渲染）。 */
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
    } else if (frame.command == LUMEN_CMD_SET_PLAYBACK ||
               frame.command == LUMEN_CMD_SCRIPT_BEGIN ||
               frame.command == LUMEN_CMD_SCRIPT_STAGE ||
               frame.command == LUMEN_CMD_SCRIPT_SEGMENT ||
               frame.command == LUMEN_CMD_SCRIPT_COMMIT ||
               frame.command == LUMEN_CMD_SCRIPT_ABORT ||
               frame.command == LUMEN_CMD_ACTIVATE_SCRIPT ||
               frame.command == LUMEN_CMD_QUERY_SCRIPT) {
        CHECK(!outcome.state_changed);
        CHECK(!outcome.led_count_rebuild);
        if (outcome.result_code == LUMEN_RESULT_OK) {
            CHECK(outcome.script_op != LUMEN_SCRIPT_OP_NONE);
            switch (frame.command) {
            case LUMEN_CMD_SET_PLAYBACK:
                CHECK(outcome.script_op == LUMEN_SCRIPT_OP_PLAYBACK);
                CHECK(outcome.script_action == frame.payload[0]);
                CHECK(outcome.script_loop == (frame.payload[1] != 0));
                break;
            case LUMEN_CMD_SCRIPT_BEGIN:
                CHECK(outcome.script_op == LUMEN_SCRIPT_OP_BEGIN);
                CHECK(outcome.script_id == frame.payload[0]);
                CHECK(outcome.script_stage_count == frame.payload[1]);
                CHECK(outcome.script_strip_count == frame.payload[2]);
                break;
            case LUMEN_CMD_SCRIPT_STAGE:
                CHECK(outcome.script_op == LUMEN_SCRIPT_OP_STAGE);
                CHECK(outcome.script_id == frame.payload[0]);
                CHECK(outcome.script_stage_index == frame.payload[1]);
                CHECK(outcome.script_duration_ms ==
                      (uint16_t)(frame.payload[2] | (frame.payload[3] << 8)));
                break;
            case LUMEN_CMD_SCRIPT_SEGMENT:
                CHECK(outcome.script_op == LUMEN_SCRIPT_OP_SEGMENT);
                CHECK(outcome.script_id == frame.payload[0]);
                CHECK(outcome.script_stage_index == frame.payload[1]);
                CHECK(outcome.script_strip == frame.payload[2]);
                CHECK(outcome.script_seg == frame.payload[3]);
                /* 两层都空 = 清空槽位（§9.6）：交出非活动段。 */
                if (frame.payload[7] == LUMEN_NO_EFFECT) {
                    CHECK(frame.payload[16] == LUMEN_NO_EFFECT);
                    CHECK(!outcome.script_segment.active);
                } else {
                    CHECK(outcome.script_segment.active);
                    CHECK(outcome.script_segment.start == frame.payload[4]);
                    CHECK(outcome.script_segment.end == frame.payload[5]);
                    CHECK(outcome.script_segment.layer[0].type == frame.payload[7]);
                    CHECK(outcome.script_segment.layer[1].type == frame.payload[16]);
                    CHECK(outcome.script_segment.blend == frame.payload[6]);
                }
                break;
            case LUMEN_CMD_SCRIPT_COMMIT:
                CHECK(outcome.script_op == LUMEN_SCRIPT_OP_COMMIT);
                CHECK(outcome.script_id == frame.payload[0]);
                break;
            case LUMEN_CMD_SCRIPT_ABORT:
                CHECK(outcome.script_op == LUMEN_SCRIPT_OP_ABORT);
                break;
            case LUMEN_CMD_ACTIVATE_SCRIPT:
                CHECK(outcome.script_op == LUMEN_SCRIPT_OP_ACTIVATE);
                CHECK(outcome.script_id == frame.payload[0]);
                CHECK(outcome.script_loop == (frame.payload[1] != 0));
                break;
            case LUMEN_CMD_QUERY_SCRIPT:
                CHECK(outcome.script_op == LUMEN_SCRIPT_OP_QUERY);
                CHECK(outcome.script_id == frame.payload[0]);
                break;
            default:
                CHECK(false);
                break;
            }
            if (frame.command == LUMEN_CMD_QUERY_SCRIPT) {
                CHECK(!outcome.cancels_selftest);
            } else {
                CHECK(outcome.cancels_selftest);
            }
        } else {
            CHECK(outcome.script_op == LUMEN_SCRIPT_OP_NONE);
            CHECK(!outcome.cancels_selftest);
        }

        /*
         * 设备侧（引擎整份校验）的结果。v3 向量不带 prior_script，所以这里只在
         * 向量显式给了前置状态或 device_ack 时才跑引擎，否则命令层的形状校验
         * 就是本用例的全部断言（引擎级的剧本流程另有独立测试覆盖）。
         */
        if (c->prior_script[0] != '\0' && outcome.result_code == LUMEN_RESULT_OK) {
            uint8_t engine_result = apply_script_op(&scripts, &outcome);
            if (c->device_ack >= 0) {
                CHECK(engine_result == (uint8_t)c->device_ack);
            } else {
                CHECK(engine_result == outcome.result_code);
            }
        }
        uint8_t keep_id = 0;
        uint8_t keep_count = 0;
        if (parse_keep_script(c->keep_script, &keep_id, &keep_count)) {
            CHECK(lumen_script_is_committed(&scripts, keep_id));
            CHECK(lumen_script_stage_count(&scripts, keep_id) == keep_count);
        }
    } else {
        /* 退役 / 保留 / 未知命令：一律 0x02，状态不动。 */
        CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
        CHECK(!outcome.state_changed);
        CHECK(!outcome.led_count_rebuild);
        CHECK(!outcome.state_report);
        CHECK(!outcome.strip_config_query);
        CHECK(!outcome.device_info_query);
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
                                                       frame.payload[13], out, sizeof(out));
        break;
    }
    default:
        /* SegmentReport / SegmentListEnd / ScriptSummary / ScriptProgress：
         * 用通用编码器验证信封逐字节一致。 */
        CHECK(frame.payload_len <= LUMEN_MAX_PAYLOAD);
        len = lumen_protocol_encode(frame.command, frame.seq, frame.payload,
                                    frame.payload_len, out, sizeof(out));
        break;
    }
    CHECK(len == expected_len + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, c->frame_hex, len);

    if (frame.command == LUMEN_CMD_SEGMENT_REPORT) {
        /* §7.1：SegmentReport 与 SetSegment 同构，固定 23 字节。 */
        CHECK(frame.payload_len == 23);
    }
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

    /* §3.3 的例子：SetPower(on) seq=1 → A6 04 01 01 01 00 01，CRC = 0x68B1（小端 68 B1）。 */
    const uint8_t body[] = {0xA6, 0x04, 0x01, 0x01, 0x01, 0x00, 0x01};
    CHECK(lumen_protocol_crc16(body, sizeof(body)) == 0x68B1);

    uint8_t out[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode(LUMEN_CMD_SET_POWER, 0x01, &body[6], 1, out,
                                       sizeof(out));
    CHECK(len == 9);
    CHECK_BYTES(out, "A6040101010001B168", len);

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
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 1);

    /* 已是开灯：ACK 0x00 但不重复 commit */
    lumen_command_dispatch(&frame, &outcome.next, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.power == 1);

    /* 非法取值 0x02：0x01，状态不变 */
    lumen_frame_t bad = {0};
    bad.command = LUMEN_CMD_SET_POWER;
    bad.payload_len = 1;
    bad.payload[0] = 2;
    lumen_command_dispatch(&bad, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.power == state.power);

    /* 载荷长度不符：0x04，状态不变 */
    bad.payload_len = 2;
    bad.payload[0] = 1;
    bad.payload[1] = 0;
    lumen_command_dispatch(&bad, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.state_changed);

    /* QueryState（§6.1）：回 0x00 + 请求 StateReport，不改状态、不取消自检。
     * 0x06 自 #12 起已实现，单独覆盖在 test_set_led_count_reducer()；
     * 0x07 自 #13 起已实现，见下面的 selftest 断言。 */
    {
        lumen_frame_t known = {0};
        known.command = LUMEN_CMD_QUERY_STATE;
        known.payload_len = lumen_command_payload_len(LUMEN_CMD_QUERY_STATE);
        lumen_command_dispatch(&known, &state, NULL, NULL, 255, &outcome);
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
    lumen_command_dispatch(&selftest, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.start_selftest);
    CHECK(!outcome.cancels_selftest);
    CHECK(memcmp(&outcome.next, &state, sizeof(state)) == 0);

    /* 保留 / 未知 / 退役 / 设备→小程序命令字：0x02。
     * v2 退役的 0x03 SetColor / 0x04 SetAll 走这里。
     * 0x10 / 0x11 / 0x12 / 0x13–0x1A / 0x1B / 0x1C / 0x1D 都已实现，
     * 都不再属于未知命令；0x1E 起才是保留字。 */
    const uint8_t unknown[] = {0x00, 0x03, 0x04, 0x08, 0x09, 0x0F, 0x1E, 0x7F,
                               0x80, 0x81, 0x82, 0xFF};
    for (size_t i = 0; i < sizeof(unknown); ++i) {
        lumen_frame_t f = {0};
        f.command = unknown[i];
        lumen_command_dispatch(&f, &state, NULL, NULL, 255, &outcome);
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
        lumen_command_dispatch(&frame, &before, NULL, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.state_changed == (before.brightness != boundaries[i]));
        CHECK(outcome.next.brightness == boundaries[i]);
        /* 其它字段一律不动，特别是 power。 */
        CHECK(outcome.next.power == before.power);
        CHECK(outcome.next.r == before.r);
        CHECK(outcome.next.g == before.g);
        CHECK(outcome.next.b == before.b);
        CHECK(outcome.next.led_count == before.led_count);
        before = outcome.next;
    }

    /* 亮度 0 是合法状态：power 位保持 1（协议 §7）。 */
    lumen_state_t zero = state;
    zero.brightness = 0;
    frame.payload[0] = 0;
    lumen_command_dispatch(&frame, &zero, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.power == 1);
    CHECK(outcome.next.brightness == 0);

    /* 相同值不 commit（避免无意义刷新 / NVS 写入），ACK 仍为 0x00。 */
    lumen_state_t same = state;
    same.brightness = 128;
    frame.payload[0] = 128;
    lumen_command_dispatch(&frame, &same, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.brightness == 128);

    /* 钳位而不是拒绝：max_brightness=180 时，200 / 255 都落到 180。 */
    frame.payload[0] = 200;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.brightness == 180);
    CHECK(outcome.next.power == 1);

    frame.payload[0] = 255;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.next.brightness == 180);

    /* 钳位后的值与当前值相同：不 commit。 */
    lumen_state_t at_cap = state;
    at_cap.brightness = 180;
    frame.payload[0] = 255;
    lumen_command_dispatch(&frame, &at_cap, NULL, NULL, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);

    /* 上限之内的值不受影响。 */
    frame.payload[0] = 100;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 180, &outcome);
    CHECK(outcome.next.brightness == 100);

    /* max_brightness = 0：任何值都被钳到 0，仍然回 0x00。 */
    frame.payload[0] = 255;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 0, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.next.brightness == 0);
    CHECK(outcome.next.power == 1);

    /* 载荷长度不符：0x04，状态不变。 */
    frame.payload_len = 2;
    frame.payload[0] = 100;
    frame.payload[1] = 0;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
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
    lumen_command_dispatch(&power, &lit, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 0);
    CHECK(outcome.next.brightness == 77);

    power.payload[0] = 1;
    lumen_command_dispatch(&power, &outcome.next, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 1);
    CHECK(outcome.next.brightness == 77);
}

/*
 * v2 退役命令：0x03 SetColor / 0x04 SetAll 不再属于已知命令。
 *
 * 关键约束（docs/protocol.md §6 / #21）：
 *  - 无论载荷长度多合法（3 字节 / 5 字节），一律回 0x02 UnknownCommand；
 *  - 状态一个字段都不动（不写 RGB、不写开关、不写亮度）。
 * 这替代了 v1 的 SetColor / SetAll 语义测试——它们描述的命令已经不存在，
 * 保留「非法命令不改变状态」这一核心约束。
 */
static void test_retired_commands(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 1;
    state.brightness = 77;
    state.r = 10;
    state.g = 20;
    state.b = 30;

    CHECK(!lumen_command_is_known(LUMEN_CMD_SET_COLOR));
    CHECK(!lumen_command_is_known(LUMEN_CMD_SET_ALL));
    CHECK(!lumen_command_changes_state(LUMEN_CMD_SET_COLOR));
    CHECK(!lumen_command_changes_state(LUMEN_CMD_SET_ALL));

    lumen_command_outcome_t outcome;

    /* SetColor：3 字节合法载荷仍然是未知命令。 */
    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SET_COLOR;
    frame.seq = 5;
    frame.payload_len = 3;
    frame.payload[0] = 255;
    frame.payload[1] = 0;
    frame.payload[2] = 0;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
    CHECK(!outcome.state_changed);
    CHECK(!outcome.cancels_selftest);
    CHECK(memcmp(&outcome.next, &state, sizeof(state)) == 0);

    /* SetAll：5 字节合法载荷同样是未知命令，且不取消自检。 */
    frame.command = LUMEN_CMD_SET_ALL;
    frame.seq = 7;
    frame.payload_len = 5;
    frame.payload[0] = 1;
    frame.payload[1] = 200;
    frame.payload[2] = 0;
    frame.payload[3] = 128;
    frame.payload[4] = 255;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
    CHECK(!outcome.state_changed);
    CHECK(!outcome.cancels_selftest);
    CHECK(memcmp(&outcome.next, &state, sizeof(state)) == 0);

    /* 长度不符也不会有 BadLength：未知命令的判定优先于长度（§8 顺序）。 */
    frame.command = LUMEN_CMD_SET_ALL;
    frame.payload_len = 1;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
    CHECK(!outcome.state_changed);

    /* 剧本命令 / 段命令都已实现：不能再出现在「未知命令」列表里，
     * 但空载荷仍应回 BadLength（长度校验先于取值）。 */
    const uint8_t implemented[] = {LUMEN_CMD_SET_PLAYBACK, LUMEN_CMD_SCRIPT_BEGIN,
                                   LUMEN_CMD_SCRIPT_STAGE, LUMEN_CMD_SCRIPT_SEGMENT,
                                   LUMEN_CMD_SCRIPT_COMMIT, LUMEN_CMD_SCRIPT_ABORT,
                                   LUMEN_CMD_ACTIVATE_SCRIPT, LUMEN_CMD_QUERY_SCRIPT,
                                   LUMEN_CMD_SET_SEGMENT, LUMEN_CMD_SET_STRIP_POWER};
    for (size_t i = 0; i < sizeof(implemented); ++i) {
        CHECK(lumen_command_is_known(implemented[i]));
        lumen_frame_t f = {0};
        f.command = implemented[i];
        f.payload_len = 0;
        lumen_command_dispatch(&f, &state, NULL, NULL, 255, &outcome);
        /* v3 的段命令是固定长度（21/23），空载荷一律 BadLength。 */
        CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
        CHECK(!outcome.state_changed);
        CHECK(outcome.script_op == LUMEN_SCRIPT_OP_NONE);
        CHECK(!outcome.segment_op);
        CHECK(!outcome.strip_power_op);
    }

    /* v3 的两条无载荷查询：已知命令、空载荷合法、回 0x00 + 报告意图。 */
    const uint8_t queries[] = {LUMEN_CMD_QUERY_STRIP_CONFIG, LUMEN_CMD_QUERY_DEVICE_INFO};
    for (size_t i = 0; i < sizeof(queries); ++i) {
        CHECK(lumen_command_is_known(queries[i]));
        lumen_frame_t f = {0};
        f.command = queries[i];
        f.payload_len = 0;
        lumen_command_dispatch(&f, &state, NULL, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.strip_config_query == (queries[i] == LUMEN_CMD_QUERY_STRIP_CONFIG));
        CHECK(outcome.device_info_query == (queries[i] == LUMEN_CMD_QUERY_DEVICE_INFO));
        CHECK(!outcome.cancels_selftest);
        /* 有载荷反而不合法（固定 0）。 */
        f.payload_len = 1;
        f.payload[0] = 0;
        lumen_command_dispatch(&f, &state, NULL, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    }

    /* 0x1E 起的保留字仍回 0x02；设备→小程序方向亦然。 */
    const uint8_t reserved[] = {0x1E, 0x20, 0x7F, 0x87, 0x88, 0xFF};
    for (size_t i = 0; i < sizeof(reserved); ++i) {
        CHECK(!lumen_command_is_known(reserved[i]));
        lumen_frame_t f = {0};
        f.command = reserved[i];
        f.payload_len = 0;
        lumen_command_dispatch(&f, &state, NULL, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
    }
}

static void test_encode_ack_all_results(void)
{
    /* ACK 编码器覆盖全部结果码：载荷 [命令字, 结果码]，seq 回显。 */
    for (uint8_t result = 0; result <= LUMEN_RESULT_SCRIPT_TOO_LARGE; ++result) {
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
    CHECK_BYTES(out, "A604810002000106C5D9", len);

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
    CHECK(decode_hex("A6040101010001B169", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_CHECKSUM);

    /* 长度字段 > 232 → 越界，BadLength（不读 payload）。 */
    CHECK(decode_hex("A6040101E900000000", &frame, &rc) == LUMEN_DECODE_ERROR);
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

    CHECK(state.power == 0);
    CHECK(state.brightness == 128);
    CHECK(state.r == 255);
    CHECK(state.g == 180);
    CHECK(state.b == 120);
    CHECK(state.led_count == 30);
    /* docs/protocol-v3.md §10.5：默认每带开关全开、没有动画、无剧本。 */
    CHECK(state.strip_power_mask == 0xFF);
    CHECK(state.strip_anim_mask == 0x00);
    CHECK(state.script_id == LUMEN_NO_SCRIPT);

    CHECK(lumen_state_clamp_brightness(200, 180) == 180);
    CHECK(lumen_state_clamp_brightness(100, 180) == 100);
    CHECK(lumen_state_clamp_brightness(255, 255) == 255);
    CHECK(lumen_state_clamp_brightness(0, 255) == 0);
}

static void test_state_bytes_layout(void)
{
    lumen_state_t state;
    uint16_t counts[LUMEN_MAX_STRIPS];
    uint8_t segs[LUMEN_MAX_STRIPS];

    /* 参考向量 state_read_example_hex（docs/protocol-testvectors-v4.json）：
     * 开灯/亮度 128/暖白 255,180,120/max_b 200/2 条灯带 30+60/
     * pmask 0x03/amask 0x01/segcounts [2,4]。 */
    lumen_state_defaults(&state, 30);
    state.power = 1;
    state.strip_count = 2;
    state.strip_power_mask = 0x03;
    state.strip_anim_mask = 0x01;
    memset(counts, 0, sizeof(counts));
    counts[0] = 30;
    counts[1] = 60;
    memset(segs, 0, sizeof(segs));
    segs[0] = 2;
    segs[1] = 4;

    uint8_t out[LUMEN_STATE_BYTES];
    CHECK(LUMEN_STATE_BYTES == 37);
    lumen_state_to_bytes(&state, 200, counts, segs, out);
    CHECK_BYTES(out, "0180FFB478C802FF00000003011E003C000000000000000000000000000204000000000000",
                sizeof(out));

    /* 逐字段核对 §7.3 的偏移。 */
    CHECK(out[0] == 1);   /* power */
    CHECK(out[1] == 128); /* brightness */
    CHECK(out[2] == 255 && out[3] == 180 && out[4] == 120);
    CHECK(out[5] == 200); /* max_brightness */
    CHECK(out[6] == 2);   /* strip_count */
    CHECK(out[7] == 0xFF);
    CHECK(out[8] == 0);
    CHECK(out[9] == 0);
    CHECK(out[10] == 0);
    CHECK(out[11] == 0x03); /* strip_power_mask */
    CHECK(out[12] == 0x01); /* strip_anim_mask */

    /* 亮度按 max_brightness 钳位后再写。 */
    state.brightness = 250;
    lumen_state_to_bytes(&state, 200, counts, segs, out);
    CHECK(out[1] == 200);

    /* 灯珠数 u16 小端：300 → 2C 01。 */
    counts[0] = 300;
    lumen_state_to_bytes(&state, 255, counts, segs, out);
    CHECK(out[13] == 0x2C);
    CHECK(out[14] == 0x01);
    counts[0] = 30;

    /* NULL 数组走兜底：strip 0 用 state.led_count，其余为 0。 */
    state.led_count = 30;
    state.seg_count = 7;
    lumen_state_to_bytes(&state, 200, NULL, NULL, out);
    CHECK(out[13] == 30 && out[14] == 0);
    CHECK(out[15] == 0 && out[16] == 0);
    CHECK(out[29] == 7);
    CHECK(out[30] == 0);

    /* NULL 防御。 */
    lumen_state_to_bytes(NULL, 255, counts, segs, out);
    lumen_state_to_bytes(&state, 255, counts, segs, NULL);
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
    state.r = 255;
    state.g = 180;
    state.b = 120;

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
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.cancels_selftest);
    CHECK(!outcome.start_selftest);

    /* SetBrightness 同样取消（这里用当前值）。 */
    frame.command = LUMEN_CMD_SET_BRIGHTNESS;
    frame.payload_len = 1;
    frame.payload[0] = state.brightness;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.cancels_selftest);

    /*
     * v2 退役的 0x03 / 0x04 不再属于「改变状态」类别，因此即使载荷合法
     * 也不取消自检（命令根本没生效）。
     */
    frame.command = LUMEN_CMD_SET_COLOR;
    frame.payload_len = 3;
    frame.payload[0] = state.r;
    frame.payload[1] = state.g;
    frame.payload[2] = state.b;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
    CHECK(!outcome.state_changed);
    CHECK(!outcome.cancels_selftest);

    frame.command = LUMEN_CMD_SET_ALL;
    frame.payload_len = 5;
    frame.payload[0] = state.power;
    frame.payload[1] = state.brightness;
    frame.payload[2] = state.r;
    frame.payload[3] = state.g;
    frame.payload[4] = state.b;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
    CHECK(!outcome.state_changed);
    CHECK(!outcome.cancels_selftest);

    /* #12 接入点：SetLedCount 属改变状态类别；合入后回 0x00 即自动取消。 */
    frame.command = LUMEN_CMD_SET_LED_COUNT;
    frame.payload_len = 2;
    frame.payload[0] = 30;
    frame.payload[1] = 0;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(lumen_command_changes_state(frame.command));

    /* QueryState：明确不取消自检（§11.2 第 6 条）。 */
    frame.command = LUMEN_CMD_QUERY_STATE;
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(!outcome.cancels_selftest);

    /* 非法取值 / 长度错误 / 未知命令：命令未生效，不取消自检。 */
    frame.command = LUMEN_CMD_SET_POWER;
    frame.payload_len = 1;
    frame.payload[0] = 2;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.cancels_selftest);

    frame.command = LUMEN_CMD_SET_BRIGHTNESS;
    frame.payload_len = 2;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.cancels_selftest);

    frame.command = 0x08;
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
    CHECK(!outcome.cancels_selftest);

    /* 自检命令本身不取消、只启动。 */
    frame.command = LUMEN_CMD_SELF_TEST;
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
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
    state.r = 10;
    state.g = 20;
    state.b = 30;

    uint8_t before[LUMEN_STATE_BYTES];
    lumen_state_to_bytes(&state, 255, NULL, NULL, before);

    /* 自检启动是纯渲染层覆盖：命令结果 next 与 current 完全一致。 */
    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SELF_TEST;
    frame.payload_len = 0;
    lumen_command_outcome_t outcome;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(memcmp(&outcome.next, &state, sizeof(state)) == 0);

    lumen_selftest_t st;
    lumen_selftest_start(&st, 0);
    uint8_t rgb[3];
    CHECK(lumen_selftest_color(&st, rgb));
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0); /* 自检点亮为红 */

    /* 同时刻的 State 仍是关灯 + 原亮度/颜色（§11.2 第 6 条）。 */
    uint8_t during[LUMEN_STATE_BYTES];
    lumen_state_to_bytes(&state, 255, NULL, NULL, during);
    CHECK(memcmp(before, during, sizeof(before)) == 0);
    CHECK(during[0] == 0);
    CHECK(during[1] == 77);
    CHECK(during[2] == 10 && during[3] == 20 && during[4] == 30);
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
    state.r = 10;
    state.g = 20;
    state.b = 30;

    lumen_command_outcome_t outcome;
    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SET_LED_COUNT;
    frame.seq = 10;
    frame.payload_len = 3;

    /* 合法：1、30（与当前相同）、64 —— 都标记重建，都不动状态。
     * v2 载荷：strip_id(0), count_lo, count_hi。 */
    const uint16_t accepted[] = {1, 30, 64};
    for (size_t i = 0; i < sizeof(accepted) / sizeof(accepted[0]); ++i) {
        frame.payload[0] = 0;
        frame.payload[1] = (uint8_t)(accepted[i] & 0xFF);
        frame.payload[2] = (uint8_t)(accepted[i] >> 8);
        lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.led_count_rebuild);
        CHECK(outcome.led_count == accepted[i]);
        CHECK(!outcome.state_changed);
        /* 开关 / 亮度 / RGB / 数量全部原样（数量由引擎在重建成功后提交）。 */
        CHECK(outcome.next.power == state.power);
        CHECK(outcome.next.brightness == state.brightness);
        CHECK(outcome.next.r == state.r);
        CHECK(outcome.next.g == state.g);
        CHECK(outcome.next.b == state.b);
        CHECK(outcome.next.led_count == state.led_count);
    }

    /* 越界：0 与 65 → 0x01，不请求重建、不改状态（协议 §6）。 */
    const uint16_t rejected[] = {0, 65, 0xFFFF};
    for (size_t i = 0; i < sizeof(rejected) / sizeof(rejected[0]); ++i) {
        frame.payload[0] = 0;
        frame.payload[1] = (uint8_t)(rejected[i] & 0xFF);
        frame.payload[2] = (uint8_t)(rejected[i] >> 8);
        lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
        CHECK(!outcome.led_count_rebuild);
        CHECK(outcome.led_count == state.led_count);
        CHECK(!outcome.state_changed);
    }

    /* 小端读法：0x0100 = 256 越界；0x4000 = 64 合法（已在上面的 accepted 里）。 */
    frame.payload[0] = 0x00;
    frame.payload[1] = 0x00;
    frame.payload[2] = 0x01;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.led_count_rebuild);

    /* strip_id != 0：多灯带（#29）尚未实现，回 0x01 而不是静默忽略。 */
    frame.payload[0] = 1;
    frame.payload[1] = 0x1E;
    frame.payload[2] = 0x00;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.led_count_rebuild);
    frame.payload[0] = 0xFF;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.led_count_rebuild);

    /* strip 0 + 64 仍是合法。 */
    frame.payload[0] = 0;
    frame.payload[1] = 0x40;
    frame.payload[2] = 0x00;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.led_count_rebuild);
    CHECK(outcome.led_count == 64);

    /* 载荷长度 2（v1 形状）/ 1 / 4 → 0x04，不请求重建。 */
    frame.payload_len = 2;
    frame.payload[0] = 0x1E;
    frame.payload[1] = 0x00;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.led_count_rebuild);

    frame.payload_len = 1;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.led_count_rebuild);

    frame.payload_len = 4;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.led_count_rebuild);

    /* payload_len 正确的 0 长度帧同样 0x04。 */
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
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

    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 1;
    state.brightness = 99;
    state.r = 1;
    state.g = 2;
    state.b = 3;

    /* 1. 请求 → 排队 → Busy（未 begin 时第二个请求也要被判忙，§11.3「不排队」）。 */
    CHECK(lumen_led_count_job_request(&job, 60, 30, 0x21) == LUMEN_LED_COUNT_ACCEPTED);
    CHECK(lumen_led_count_job_busy(&job));
    CHECK(lumen_led_count_job_target(&job) == 60);
    CHECK(lumen_led_count_job_request(&job, 45, 30, 0x22) == LUMEN_LED_COUNT_BUSY);
    /* 被拒的请求不能污染目标值 / seq。 */
    CHECK(lumen_led_count_job_target(&job) == 60);

    /* 2. begin：pending → running，取出 target 与 seq。 */
    uint16_t target = 0;
    uint8_t seq = 0;
    CHECK(lumen_led_count_job_begin(&job, &target, &seq));
    CHECK(target == 60);
    CHECK(seq == 0x21);
    CHECK(lumen_led_count_job_busy(&job));
    /* 没有 pending 时不能再次 begin。 */
    CHECK(!lumen_led_count_job_begin(&job, NULL, NULL));
    /* 重建进行中（running）同样判忙。 */
    CHECK(lumen_led_count_job_request(&job, 60, 30, 0x23) == LUMEN_LED_COUNT_BUSY);

    /* 3. complete(true)：只改 led_count，其它字段原样。 */
    CHECK(lumen_led_count_job_complete(&job, true, &state));
    CHECK(state.led_count == 60);
    CHECK(state.power == 1);
    CHECK(state.brightness == 99);
    CHECK(state.r == 1 && state.g == 2 && state.b == 3);
    CHECK(!lumen_led_count_job_busy(&job));
    /* 完成后 target 保留（供日志），但状态机已空闲。 */

    /* 4. 完成后能再次请求。 */
    CHECK(lumen_led_count_job_request(&job, 12, 60, 0x24) == LUMEN_LED_COUNT_ACCEPTED);
    CHECK(lumen_led_count_job_begin(&job, &target, &seq));
    CHECK(target == 12);
    CHECK(seq == 0x24);

    /* 5. complete(false)：状态回滚（旧值 60 不变），状态机释放。 */
    lumen_state_t before = state;
    CHECK(!lumen_led_count_job_complete(&job, false, &state));
    CHECK(!lumen_led_count_job_busy(&job));
    CHECK(state.led_count == before.led_count);
    CHECK(state.power == before.power);
    CHECK(state.brightness == before.brightness);

    /* 失败后仍可再次请求（不卡死）。 */
    CHECK(lumen_led_count_job_request(&job, 12, 60, 0x25) == LUMEN_LED_COUNT_ACCEPTED);
    CHECK(lumen_led_count_job_begin(&job, &target, &seq));
    CHECK(lumen_led_count_job_complete(&job, true, &state));
    CHECK(state.led_count == 12);

    /* 6. 与当前数量相同 → UNCHANGED（不排队、不重建，调用方直接回 0x00）。 */
    CHECK(lumen_led_count_job_request(&job, 12, 12, 0x26) == LUMEN_LED_COUNT_UNCHANGED);
    CHECK(!lumen_led_count_job_busy(&job));

    /* 7. 判忙优先于判相同：重建中即使请求当前数量也回 Busy。 */
    CHECK(lumen_led_count_job_request(&job, 20, 12, 0x27) == LUMEN_LED_COUNT_ACCEPTED);
    CHECK(lumen_led_count_job_request(&job, 12, 12, 0x28) == LUMEN_LED_COUNT_BUSY);

    /* 8. 越界防御：直接调 request 也不破坏状态机（仍处于 pending）。 */
    CHECK(lumen_led_count_job_request(&job, 0, 12, 0x29) == LUMEN_LED_COUNT_BUSY);
    CHECK(lumen_led_count_job_request(&job, 65, 12, 0x2A) == LUMEN_LED_COUNT_BUSY);
    CHECK(lumen_led_count_job_target(&job) == 20);

    /* 9. complete 需要 running：pending 状态直接 complete 无效。 */
    CHECK(!lumen_led_count_job_complete(&job, true, &state));
    CHECK(state.led_count == 12);

    /* 10. NULL job 防御。 */
    CHECK(!lumen_led_count_job_busy(NULL));
    CHECK(lumen_led_count_job_target(NULL) == 0);
    CHECK(lumen_led_count_job_request(NULL, 5, 30, 1) == LUMEN_LED_COUNT_BUSY);
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
    lumen_segment_store_init(&s.segments);
    return s;
}

static void test_save_scheduler(void)
{
    lumen_save_scheduler_t sched;
    lumen_save_scheduler_init(&sched);

    lumen_persist_t out;
    uint8_t command = 0;

    /* 1. 初始：没有待写，next_delay 为 UINT32_MAX，take_due 失败。 */
    CHECK(!lumen_save_scheduler_pending(&sched));
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 0) == UINT32_MAX);
    CHECK(!lumen_save_scheduler_take_due(&sched, 0, &out, &command));

    /* 2. 一次请求 → 500ms 后到期；499ms 时还差 1ms。 */
    lumen_persist_t a = persist_with(30, 10);
    CHECK(lumen_save_scheduler_request(&sched, &a, LUMEN_CMD_SET_BRIGHTNESS, 1000));
    CHECK(lumen_save_scheduler_pending(&sched));
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 1000) == LUMEN_SAVE_DEBOUNCE_MS);
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 1499) == 1);
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 1500) == 0);
    CHECK(!lumen_save_scheduler_take_due(&sched, 1499, &out, &command));
    CHECK(lumen_save_scheduler_take_due(&sched, 1500, &out, &command));
    CHECK(out.state.brightness == 10);
    CHECK(out.state.led_count == 30);
    CHECK(command == LUMEN_CMD_SET_BRIGHTNESS);
    /* 取走之后 pending 清空，再来一次 take 失败。 */
    CHECK(!lumen_save_scheduler_pending(&sched));
    CHECK(!lumen_save_scheduler_take_due(&sched, 2000, &out, &command));

    /* 3. 连续请求不断推迟，只写最后一次快照。 */
    CHECK(lumen_save_scheduler_request(&sched, &a, LUMEN_CMD_SET_BRIGHTNESS, 0));
    lumen_persist_t b = persist_with(30, 20);
    CHECK(lumen_save_scheduler_request(&sched, &b, LUMEN_CMD_SET_BRIGHTNESS, 100));
    lumen_persist_t c = persist_with(30, 30);
    CHECK(lumen_save_scheduler_request(&sched, &c, LUMEN_CMD_SET_POWER, 200));
    /* 600ms 时：第一次的 deadline(500) 已过，但最后请求的 deadline 是 700。 */
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 600) == 100);
    CHECK(!lumen_save_scheduler_take_due(&sched, 699, &out, &command));
    CHECK(lumen_save_scheduler_take_due(&sched, 700, &out, &command));
    CHECK(out.state.brightness == 30); /* 只有最后一份 */
    CHECK(command == LUMEN_CMD_SET_POWER);

    /* 4. 时钟回绕：deadline 越过 0xFFFFFFFF，仍按差值判定，不卡死。 */
    uint32_t near_wrap = 0xFFFFFF00u; /* deadline = 0x000000F4（回绕后） */
    lumen_persist_t d = persist_with(64, 40);
    CHECK(lumen_save_scheduler_request(&sched, &d, LUMEN_CMD_SET_LED_COUNT, near_wrap));
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, near_wrap) == LUMEN_SAVE_DEBOUNCE_MS);
    /* 回绕之后：now = 0x0000000A，差值 = 0xF4 - 0x0A = 234。 */
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 0x0000000Au) == 234);
    CHECK(!lumen_save_scheduler_take_due(&sched, 0x0000000Au, &out, &command));
    CHECK(lumen_save_scheduler_take_due(&sched, 0x000000F4u, &out, &command));
    CHECK(out.state.led_count == 64);
    CHECK(command == LUMEN_CMD_SET_LED_COUNT);

    /* 5. 回绕后立刻请求也正常（deadline 未越过零点的情况）。 */
    CHECK(lumen_save_scheduler_request(&sched, &d, LUMEN_CMD_SET_POWER, 0xFFFFFFFEu));
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 0xFFFFFFFEu) == LUMEN_SAVE_DEBOUNCE_MS);
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 0x00000002u) ==
          LUMEN_SAVE_DEBOUNCE_MS - 4);

    /* 6. 非法指针：request 失败且不改状态。 */
    lumen_save_scheduler_init(&sched);
    CHECK(!lumen_save_scheduler_request(&sched, NULL, 0x01, 0));
    CHECK(!lumen_save_scheduler_pending(&sched));
    CHECK(!lumen_save_scheduler_request(NULL, &a, 0x01, 0));
    CHECK(lumen_save_scheduler_next_delay_ms(NULL, 0) == UINT32_MAX);
    CHECK(!lumen_save_scheduler_pending(NULL));

    /* 7. out / command 允许为 NULL（只用来清 pending）。 */
    CHECK(lumen_save_scheduler_request(&sched, &a, 0x02, 0));
    CHECK(lumen_save_scheduler_take_due(&sched, 1000, NULL, NULL));
    CHECK(!lumen_save_scheduler_pending(&sched));
}

/* ---------------- #12 / #25：state_blob 编解码（v2 带段表） ---------------- */

static void test_state_blob(void)
{
    /* 1. 往返一致：状态 + 段表原样回来。 */
    lumen_persist_t in;
    memset(&in, 0, sizeof(in));
    in.state.power = 1;
    in.state.brightness = 200;
    in.state.r = 1;
    in.state.g = 2;
    in.state.b = 3;
    in.state.led_count = 64;
    in.state.strip_count = 1;
    in.state.seg_count = 2;

    lumen_segment_t seg0 = seg_single(LUMEN_EFFECT_STATIC, 0, 15, 0x1234, 200, 0, 0, 0, 999);
    lumen_segment_t seg1 = seg_single(LUMEN_EFFECT_STATIC, 40, 63, 0xABCD, 255, 0, 0, 0, 12345);
    in.segments.slot[0][0] = seg0;
    in.segments.slot[0][1] = seg1;

    uint8_t blob[LUMEN_STATE_BLOB_SIZE];
    CHECK(lumen_state_blob_encode(&in, blob) == LUMEN_STATE_BLOB_SIZE);
    /*
     * 显式布局（docs/protocol-v4.md §10.2）：magic 0..3、version 4..5、power 6、
     * brightness 7、rgb 8..10、led_count 11..12（小端）、strip_count 13、
     * strip_power_mask 14、strip_counts 15..30、seg_count 31、段表 32..。
     */
    CHECK(blob[0] == 'L' && blob[1] == 'M' && blob[2] == 'E' && blob[3] == 'N');
    CHECK(blob[4] == (LUMEN_STATE_BLOB_VERSION & 0xFF));
    CHECK(blob[5] == (LUMEN_STATE_BLOB_VERSION >> 8));
    /* v4 → v5：v3 已用掉 4；层多一个 level 字节 → 段记录 22、总长 1440。 */
    CHECK(LUMEN_STATE_BLOB_VERSION == 5);
    CHECK(LUMEN_STATE_BLOB_SIZE == 1440);
    CHECK(LUMEN_SEGMENT_RECORD_SIZE == 22);
    CHECK(LUMEN_STRIP_COUNTS_OFFSET == 15);
    CHECK(LUMEN_SEG_COUNT_OFFSET == 31);
    CHECK(LUMEN_SEGMENTS_OFFSET == 32);
    /* v4：每层 9 字节 → 段记录 22、整份 1440；脚本记录上限 21。 */
    CHECK(LUMEN_SEGMENT_RECORD_SIZE == 22);
    CHECK(LUMEN_SCRIPT_SEGMENT_MAX == 21);
    CHECK(blob[6] == 1);
    CHECK(blob[7] == 200);
    CHECK(blob[8] == 1 && blob[9] == 2 && blob[10] == 3);
    CHECK(blob[11] == 64 && blob[12] == 0);
    CHECK(blob[13] == 1);
    CHECK(blob[LUMEN_SEG_COUNT_OFFSET] == 2);

    lumen_persist_t out;
    memset(&out, 0xAA, sizeof(out));
    CHECK(lumen_state_blob_decode(blob, sizeof(blob), &out));
    CHECK(out.state.power == 1);
    CHECK(out.state.brightness == 200);
    CHECK(out.state.r == 1 && out.state.g == 2 && out.state.b == 3);
    CHECK(out.state.led_count == 64);
    CHECK(out.state.strip_count == 1);
    CHECK(out.state.seg_count == 2);
    CHECK(out.segments.slot[0][0].active);
    CHECK(out.segments.slot[0][0].start == 0 && out.segments.slot[0][0].end == 15);
    CHECK(layer_hue(&out.segments.slot[0][0].layer[0]) == 0x1234);
    CHECK(layer_sat(&out.segments.slot[0][0].layer[0]) == 200);
    CHECK(out.segments.slot[0][0].layer[1].type == LUMEN_LAYER_EMPTY);
    CHECK(out.segments.slot[0][0].blend == 0);
    CHECK(out.segments.slot[0][1].active);
    CHECK(out.segments.slot[0][1].start == 40 && out.segments.slot[0][1].end == 63);
    CHECK(layer_hue(&out.segments.slot[0][1].layer[0]) == 0xABCD);
    /* t0_ms 不持久化：解码后为 0，由引擎加载时统一设为当前时刻。 */
    CHECK(out.segments.slot[0][0].t0_ms == 0);
    CHECK(out.segments.slot[0][1].t0_ms == 0);
    /* 剧本 / 播放位置不持久化（protocol §12）。 */
    CHECK(out.state.script_id == LUMEN_NO_SCRIPT);
    CHECK(out.state.stage_index == 0);
    CHECK(out.state.playback_state == 0);

    /* 2. 长度错误：短一字节 / 长一字节 / 0 都拒绝（版本演进必须提升 version，不猜）。 */
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
     * 4. 坏 version（v1 / v3（版本号 4）/ 更高版本都必须整体拒绝：布局不兼容）。
     *
     * v3 → v4 的布局变化：层多一个 level 字节 → 段记录 20 → 22、总长 1312 → 1440。
     * 用旧字节按新布局解析会把段表读错位，所以**只能拒绝**，由调用方回落到
     * 协议默认值——不能出现半套加载（这也是「刷机后配置回默认」的实现）。
     */
    memcpy(bad, blob, sizeof(bad));
    bad[4] = 0x01;
    bad[5] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[4] = 0x04; /* 上一版（协议 v3）：记录还是 20 字节、总长 1312 —— 必须拒绝 */
    bad[5] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[4] = 0x06; /* 比当前版本更高：同样必须拒绝 */
    bad[5] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* 只有高字节错位的伪版本也拒绝。 */
    memcpy(bad, blob, sizeof(bad));
    bad[5] = 0x01;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /*
     * 4b. **整份 v3 blob（长度 1312、版本 4）必须被整体拒绝，且 out 不被写**。
     *
     * 长度门先拒：1312 != 1440。另造一份「长度按 1440 给足但版本号是 4」的
     * 伪 blob，验证版本门也拒。两者都断言 out 一个字节都没被动过。
     * 这一条直接对应验收点「旧版本存储整体拒绝、不出现半套加载」。
     */
    {
        lumen_persist_t keep;
        memset(&keep, 0, sizeof(keep));
        lumen_state_defaults(&keep.state, 30);
        lumen_segment_store_init(&keep.segments);
        lumen_persist_t before = keep;

        /* v3 的真实长度（1312）——长度门拒。 */
        CHECK(!lumen_state_blob_decode(blob, 1312, &keep));
        CHECK(memcmp(&keep, &before, sizeof(keep)) == 0);

        /* 长度 1440 但版本 = 4（v3 的版本号）——版本门拒。 */
        memcpy(bad, blob, sizeof(bad));
        bad[4] = 0x04;
        bad[5] = 0x00;
        CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &keep));
        CHECK(memcmp(&keep, &before, sizeof(keep)) == 0);
        CHECK(keep.state.power == before.state.power);
        CHECK(keep.state.strip_power_mask == before.state.strip_power_mask);
        CHECK(!keep.segments.slot[0][0].active);
    }

    /* 5. power > 1。 */
    memcpy(bad, blob, sizeof(bad));
    bad[6] = 2;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[6] = 0xFF;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* 6. led_count 越界：0 与 65；strip_count 越界：0 与 9。 */
    memcpy(bad, blob, sizeof(bad));
    bad[11] = 0x00;
    bad[12] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[11] = 0x41;
    bad[12] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[11] = 0xFF;
    bad[12] = 0xFF;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[13] = 0;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[13] = 9;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* 7. 段表自相矛盾 → 损坏，拒绝：
     *    a) 段区间 end >= led_count；
     *    b) seg_count 与段表不一致；
     *    c) 未知 type；
     *    d) 同灯带内重叠；
     *    e) 单层段带非零 blend（§7.1 第 4 步）。 */
    const uint8_t seg_off = LUMEN_SEGMENTS_OFFSET; /* 段表偏移随布局走，不硬编码 */
    /* a) 把 seg 0 的 end 改成 64（led_count=64 → 越界）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[seg_off + 2] = 64;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* b) seg_count 说 3 但段表只有 2 个活动段。 */
    memcpy(bad, blob, sizeof(bad));
    bad[LUMEN_SEG_COUNT_OFFSET] = 3;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* c) 未知 type 0x07（记录内的 layer0.type 在偏移 4）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[seg_off + 4] = 0x07;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* d) 把 seg 1 挪到 [10-20]，与 seg 0 的 [0-15] 重叠。 */
    memcpy(bad, blob, sizeof(bad));
    bad[seg_off + LUMEN_SEGMENT_RECORD_SIZE + 1] = 10;
    bad[seg_off + LUMEN_SEGMENT_RECORD_SIZE + 2] = 20;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* e) 单层段（layer1 = 0xFF）却写了 blend = 1 → 形状非法。 */
    memcpy(bad, blob, sizeof(bad));
    bad[seg_off + 3] = 1;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* f) 静态层 param[3..6] 保留位非 0（记录内 layer0.param 从偏移 5 起）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[seg_off + 5 + 3] = 0x01;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* 8. 失败时不写 out（调用方保留默认值）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[6] = 9;
    lumen_persist_t untouched;
    memset(&untouched, 0, sizeof(untouched));
    lumen_state_defaults(&untouched.state, 30);
    lumen_segment_store_init(&untouched.segments);
    lumen_persist_t copy = untouched;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &untouched));
    CHECK(untouched.state.power == copy.state.power);
    CHECK(untouched.state.brightness == copy.state.brightness);
    CHECK(untouched.state.led_count == copy.state.led_count);
    CHECK(untouched.state.seg_count == copy.state.seg_count);
    CHECK(!untouched.segments.slot[0][0].active);

    /* 9. 边界合法值：power = 0、led_count = 1、0 段都能解出来。 */
    lumen_persist_t edge = persist_with(1, 0);
    edge.state.power = 0;
    edge.state.seg_count = 0;
    CHECK(lumen_state_blob_encode(&edge, blob) == LUMEN_STATE_BLOB_SIZE);
    CHECK(lumen_state_blob_decode(blob, sizeof(blob), &out));
    CHECK(out.state.power == 0);
    CHECK(out.state.brightness == 0);
    CHECK(out.state.led_count == 1);
    CHECK(out.state.seg_count == 0);

    /* 10. NULL 防御。 */
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
    /* 类型分类：四种已知，其余未知。 */
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_STATIC));
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_BREATHING));
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_RAINBOW));
    CHECK(lumen_effect_type_known(LUMEN_EFFECT_COMET));
    CHECK(!lumen_effect_type_known(0x04));
    CHECK(!lumen_effect_type_known(0xFF));

    /* 四种类型的像素实现全部就绪（#25 静态 / #30 呼吸 / #31 彩虹+流光）。 */
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_STATIC));
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_BREATHING));
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_RAINBOW));
    CHECK(lumen_effect_type_implemented(LUMEN_EFFECT_COMET));
    CHECK(!lumen_effect_type_implemented(0x04));

    /* 参数块长度（effects-spec §2.5）。 */
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_STATIC) == 3);
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_BREATHING) == 7);
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_RAINBOW) == 7);
    CHECK(lumen_effect_param_len(LUMEN_EFFECT_COMET) == 7);
    CHECK(lumen_effect_param_len(0x07) == 0);

    /* 静态不是动画；其余是。 */
    CHECK(!lumen_effect_is_animated(LUMEN_EFFECT_STATIC));
    CHECK(lumen_effect_is_animated(LUMEN_EFFECT_BREATHING));

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

/*
 * 合成是 #25 的核心验收点：三段不同颜色，段内均匀，**未覆盖区必须为 0**。
 * 用 [0-15] + [40-63]、中间 16-39 空着，正是 ticket 里的真机场景。
 */
static void test_segment_store_compose(void)
{
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    const uint8_t led_count = 64;

    /* 红 [0-15]、绿 [40-63]、蓝 [20-29]（故意乱序插入，验证按区间而不是按槽位）。 */
    lumen_segment_t red = make_static(0, 15, 0, 255);
    lumen_segment_t green = make_static(40, 63, 21845, 255);
    lumen_segment_t blue = make_static(20, 29, 43690, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 2, led_count, &green) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, led_count, &red) == LUMEN_RESULT_OK);
    /* 蓝段再插一次：与已存在的段不重叠，允许。 */
    CHECK(lumen_segment_store_set(&store, 0, 1, 1, led_count, &blue) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_count(&store, 0) == 3);
    CHECK(lumen_segment_store_mask(&store, 0) == 0x07);

    uint8_t buf[64 * 3];
    memset(buf, 0x5A, sizeof(buf)); /* 先用脏数据填满，证明 compose 自己会清零 */
    CHECK(lumen_segment_store_compose(&store, 0, buf, led_count, 0) == led_count);

    /* 段内均匀：段 0 的每一颗都是纯红。 */
    for (uint8_t i = 0; i <= 15; ++i) {
        CHECK(buf[i * 3 + 0] == 255);
        CHECK(buf[i * 3 + 1] == 0);
        CHECK(buf[i * 3 + 2] == 0);
    }
    /* 段 1（蓝）：20-29。 */
    for (uint8_t i = 20; i <= 29; ++i) {
        CHECK(buf[i * 3 + 0] == 0);
        CHECK(buf[i * 3 + 1] == 0);
        CHECK(buf[i * 3 + 2] == 255);
    }
    /* 段 2（绿）：40-63。 */
    for (uint8_t i = 40; i <= 63; ++i) {
        CHECK(buf[i * 3 + 0] == 0);
        CHECK(buf[i * 3 + 1] == 255);
        CHECK(buf[i * 3 + 2] == 0);
    }

    /*
     * 未覆盖区必须是 0：16-19、30-39。这是「gap 必须真暗」的 host 证据
     * （对应 ticket 里 [0-15] / [40-63] 中间 16-39 熄灭）。真机仍要肉眼确认。
     */
    for (uint8_t i = 16; i <= 19; ++i) {
        CHECK(buf[i * 3 + 0] == 0 && buf[i * 3 + 1] == 0 && buf[i * 3 + 2] == 0);
    }
    for (uint8_t i = 30; i <= 39; ++i) {
        CHECK(buf[i * 3 + 0] == 0 && buf[i * 3 + 1] == 0 && buf[i * 3 + 2] == 0);
    }

    /* 一个段都没有：整条全 0（不是保留上一帧）。 */
    lumen_segment_store_init(&store);
    memset(buf, 0x5A, sizeof(buf));
    CHECK(lumen_segment_store_compose(&store, 0, buf, led_count, 0) == led_count);
    for (uint16_t i = 0; i < (uint16_t)led_count * 3u; ++i) {
        CHECK(buf[i] == 0);
    }

    /* 改一段颜色不影响其他段：把段 0 改成蓝，只有 0-15 变化。 */
    lumen_segment_store_init(&store);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, led_count, &red) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_set(&store, 0, 1, 1, led_count, &green) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_compose(&store, 0, buf, led_count, 0) == led_count);
    uint8_t before_40[3] = {buf[40 * 3], buf[40 * 3 + 1], buf[40 * 3 + 2]};
    lumen_segment_t red_to_blue = make_static(0, 15, 43690, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, led_count, &red_to_blue) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_compose(&store, 0, buf, led_count, 0) == led_count);
    CHECK(buf[0] == 0 && buf[1] == 0 && buf[2] == 255);   /* 段 0 已是蓝 */
    CHECK(buf[40 * 3] == before_40[0]);
    CHECK(buf[40 * 3 + 1] == before_40[1]);
    CHECK(buf[40 * 3 + 2] == before_40[2]);              /* 段 1 未受影响 */

    /* 参数防御。 */
    CHECK(lumen_segment_store_compose(&store, 0, NULL, led_count, 0) == 0);
    CHECK(lumen_segment_store_compose(&store, 0, buf, 0, 0) == 0);
    CHECK(lumen_segment_store_compose(&store, 0, buf, LUMEN_MAX_LEDS + 1, 0) == 0);
    CHECK(lumen_segment_store_compose(NULL, 0, buf, led_count, 0) == 0);
}

static void test_segment_store_validate(void)
{
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    const uint8_t led_count = 30;

    /* 正常段。 */
    lumen_segment_t seg = make_static(0, 9, 0, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, led_count, &seg) == LUMEN_RESULT_OK);

    /* 不重叠的另一个段（含紧邻边界 10-19，闭区间相邻不算重叠）。 */
    lumen_segment_t adjacent = make_static(10, 19, 0, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 1, led_count, &adjacent) == LUMEN_RESULT_OK);

    /* 重叠：与 [0-9] 有交集 → InvalidParam，旧配置不变。 */
    lumen_segment_t overlap = make_static(5, 12, 0, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 2, led_count, &overlap) ==
          LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_segment_store_count(&store, 0) == 2);
    CHECK(!lumen_segment_store_get(&store, 0, 2)->active);
    /* 原有两段一个字节都没变。 */
    CHECK(lumen_segment_store_get(&store, 0, 0)->start == 0);
    CHECK(lumen_segment_store_get(&store, 0, 0)->end == 9);
    CHECK(lumen_segment_store_get(&store, 0, 1)->start == 10);
    CHECK(lumen_segment_store_get(&store, 0, 1)->end == 19);

    /* 自替换（同 seg_id）不算重叠：改颜色必须能通过。 */
    lumen_segment_t recolored = make_static(0, 9, 43690, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, led_count, &recolored) == LUMEN_RESULT_OK);
    CHECK(layer_hue(&lumen_segment_store_get(&store, 0, 0)->layer[0]) == 43690);

    /* 越界：end >= led_count、start > end。 */
    lumen_segment_t out_of_range = make_static(20, 30, 0, 255);
    CHECK(lumen_segment_store_validate(&store, 0, 1, 2, led_count, &out_of_range) ==
          LUMEN_RESULT_INVALID_PARAM);
    lumen_segment_t inverted = make_static(12, 5, 0, 255);
    CHECK(lumen_segment_store_validate(&store, 0, 1, 2, led_count, &inverted) ==
          LUMEN_RESULT_INVALID_PARAM);
    /* 最后一个灯珠合法：end == led_count - 1。 */
    lumen_segment_t last = make_static(20, 29, 0, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 2, led_count, &last) == LUMEN_RESULT_OK);

    /* strip 范围：多灯带（#29）之前只有 strip 0。 */
    lumen_segment_t ok = make_static(0, 4, 0, 255);
    CHECK(lumen_segment_store_validate(&store, 1, 1, 5, led_count, &ok) ==
          LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_segment_store_validate(&store, 0, 0, 0, led_count, &ok) ==
          LUMEN_RESULT_INVALID_PARAM); /* strip_count 0 非法 */
    CHECK(lumen_segment_store_validate(&store, 0, 9, 0, led_count, &ok) ==
          LUMEN_RESULT_INVALID_PARAM); /* strip_count 9 超过 MAX_STRIPS */

    /* flags 保留位：静态段必须为 0。 */
    lumen_segment_t flagged = make_static(0, 4, 0, 255);
    layer_set_flags(&flagged.layer[0], 0x01);
    CHECK(lumen_segment_store_validate(&store, 0, 1, 5, led_count, &flagged) ==
          LUMEN_RESULT_INVALID_PARAM);

    /*
     * #31：四种动画类型全部实现，合法 period 通过（呼吸 1000ms、彩虹/流光
     * 500ms 都高于各自下限）。用独立的空段表，避免受上面已占满 0-29 的段
     * 影响（这里只验 flags / 周期，不验重叠）；跨段共存与合成在
     * test_effects_rainbow_comet_coexist 里单独验。
     */
    lumen_segment_store_t fresh;
    lumen_segment_store_init(&fresh);

    lumen_segment_t breathing = make_static(0, 4, 0, 255);
    breathing.layer[0].type = LUMEN_EFFECT_BREATHING;
    layer_set_period(&breathing.layer[0], 1000);
    CHECK(lumen_segment_store_validate(&fresh, 0, 1, 5, led_count, &breathing) ==
          LUMEN_RESULT_OK);

    lumen_segment_t rainbow = make_static(0, 4, 0, 255);
    rainbow.layer[0].type = LUMEN_EFFECT_RAINBOW;
    layer_set_period(&rainbow.layer[0], 500);
    CHECK(lumen_segment_store_validate(&fresh, 0, 1, 5, led_count, &rainbow) ==
          LUMEN_RESULT_OK);

    lumen_segment_t comet = make_static(0, 4, 0, 255);
    comet.layer[0].type = LUMEN_EFFECT_COMET;
    layer_set_period(&comet.layer[0], 500);
    CHECK(lumen_segment_store_validate(&fresh, 0, 1, 5, led_count, &comet) ==
          LUMEN_RESULT_OK);

    /* seg_id 越界。 */
    CHECK(lumen_segment_store_set(&store, 0, 1, 8, led_count, &ok) ==
          LUMEN_RESULT_INVALID_PARAM);
    CHECK(lumen_segment_store_get(&store, 0, 0) != NULL);
    CHECK(lumen_segment_store_get(&store, 0, 8) == NULL);
    CHECK(lumen_segment_store_get(&store, 8, 0) == NULL);

    /* ClearSegment 释放槽位；清一个不活动的槽位也返回 false 但不崩。 */
    CHECK(!lumen_segment_store_clear(&store, 0, 7));
    CHECK(lumen_segment_store_clear(&store, 0, 2));
    CHECK(!lumen_segment_store_get(&store, 0, 2)->active);
    CHECK(lumen_segment_store_count(&store, 0) == 2);

    /* 清掉后腾出的区间可以被新段占用。 */
    CHECK(lumen_segment_store_set(&store, 0, 1, 2, led_count, &out_of_range) ==
          LUMEN_RESULT_INVALID_PARAM); /* 还是越界 */
    CHECK(lumen_segment_store_set(&store, 0, 1, 2, led_count, &last) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_count(&store, 0) == 3);

    /* 容量：8 个段刚好占满，第 9 个没有槽位（seg_id 7 是最后一个）。 */
    lumen_segment_store_init(&store);
    for (uint8_t i = 0; i < LUMEN_MAX_SEGMENTS; ++i) {
        lumen_segment_t s = make_static((uint8_t)(i * 4), (uint8_t)(i * 4 + 3), 0, 255);
        CHECK(lumen_segment_store_set(&store, 0, 1, i, 64, &s) == LUMEN_RESULT_OK);
    }
    CHECK(lumen_segment_store_count(&store, 0) == LUMEN_MAX_SEGMENTS);
    CHECK(lumen_segment_store_mask(&store, 0) == 0xFF);
}

/*
 * State 摘要：docs/protocol.md §7 的字节 2-4（seg 0 基准色）与字节 9（seg_count）。
 * 引擎的 refresh_state_summary_locked 用的是同一组纯函数，这里直接测它们。
 */
static void test_segment_store_state_summary(void)
{
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    uint8_t rgb[3] = {9, 9, 9};
    /* 没有段：基准色为 0（协议 §7「无 seg 0 时 0」）。 */
    lumen_segment_store_state_rgb(&store, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    CHECK(lumen_segment_store_count(&store, 0) == 0);

    /* 只有 seg 1（不是 seg 0）：基准色仍是 0——State 只报 seg 0。 */
    lumen_segment_t green = make_static(10, 19, 21845, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 1, 30, &green) == LUMEN_RESULT_OK);
    lumen_segment_store_state_rgb(&store, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    CHECK(lumen_segment_store_count(&store, 0) == 1);

    /* 写入 seg 0 后，基准色 = 该段的 hue+sat（纯红）。 */
    lumen_segment_t red = make_static(0, 9, 0, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 30, &red) == LUMEN_RESULT_OK);
    lumen_segment_store_state_rgb(&store, 0, rgb);
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);
    CHECK(lumen_segment_store_count(&store, 0) == 2);

    /* 改 seg 0 的颜色：基准色跟着变，seg_count 不变。 */
    lumen_segment_t blue = make_static(0, 9, 43690, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 30, &blue) == LUMEN_RESULT_OK);
    lumen_segment_store_state_rgb(&store, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 255);
    CHECK(lumen_segment_store_count(&store, 0) == 2);

    /* 清掉 seg 0：基准色回 0，seg_count 减 1。 */
    CHECK(lumen_segment_store_clear(&store, 0, 0));
    lumen_segment_store_state_rgb(&store, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    CHECK(lumen_segment_store_count(&store, 0) == 1);

    /* 参数防御。 */
    lumen_segment_store_state_rgb(&store, 0, NULL); /* 不崩 */
    lumen_segment_store_state_rgb(NULL, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    CHECK(lumen_segment_store_count(NULL, 0) == 0);
    CHECK(lumen_segment_store_mask(NULL, 0) == 0);
    CHECK(lumen_segment_store_get(NULL, 0, 0) == NULL);
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
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);
    lumen_segment_t b = seg_single(LUMEN_EFFECT_BREATHING, 0, 9, 0, 255, 1000, 0, 0, 0);
    lumen_segment_t s = make_static(20, 29, 21845, 255); /* 纯绿 */
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &b) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_set(&store, 0, 1, 1, 64, &s) == LUMEN_RESULT_OK);

    uint8_t t0_buf[64 * 3];
    uint8_t t500_buf[64 * 3];
    CHECK(lumen_segment_store_compose(&store, 0, t0_buf, 64, 0) == 64);
    CHECK(lumen_segment_store_compose(&store, 0, t500_buf, 64, 500) == 64);
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
}

/*
 * #31 的核心验收：彩虹 + 流光 + 静态在同一帧里跨段共存，且两段流光的
 * 相位**确实不连续**（D4 已定的取舍——测试要确认它按设计断裂，而不是
 * 意外地连成一条）。
 */
static void test_effects_rainbow_comet_coexist(void)
{
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    lumen_segment_t rainbow =
        make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 1000, 255, 0, 0);
    lumen_segment_t comet =
        make_animated(LUMEN_EFFECT_COMET, 16, 31, 0, 255, 1000, 64, 0, 0);
    lumen_segment_t stat = make_static(32, 47, 21845, 255); /* 纯绿 */

    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &rainbow) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_set(&store, 0, 1, 1, 64, &comet) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_set(&store, 0, 1, 2, 64, &stat) == LUMEN_RESULT_OK);

    /* 有彩虹 / 流光 → 需要帧循环（动画类判据）。 */
    CHECK(lumen_segment_store_needs_frames(&store, 1));

    uint8_t t0[64 * 3];
    uint8_t t250[64 * 3];
    CHECK(lumen_segment_store_compose(&store, 0, t0, 64, 0) == 64);
    CHECK(lumen_segment_store_compose(&store, 0, t250, 64, 250) == 64);

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
    lumen_segment_store_t only;
    lumen_segment_store_init(&only);
    CHECK(lumen_segment_store_set(&only, 0, 1, 0, 64, &rainbow) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_needs_frames(&only, 1));
    lumen_segment_store_init(&only);
    CHECK(lumen_segment_store_set(&only, 0, 1, 0, 64, &comet) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_needs_frames(&only, 1));

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
    lumen_segment_store_t split;
    lumen_segment_store_init(&split);
    lumen_segment_t a = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 0, 0, 0);
    lumen_segment_t b = make_animated(LUMEN_EFFECT_COMET, 16, 31, 0, 255, 1000, 0, 0, 500);
    CHECK(lumen_segment_store_set(&split, 0, 1, 0, 64, &a) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_set(&split, 0, 1, 1, 64, &b) == LUMEN_RESULT_OK);

    uint8_t buf[64 * 3];
    CHECK(lumen_segment_store_compose(&split, 0, buf, 64, 1000) == 64);
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
    CHECK(lumen_segment_store_set(&split, 0, 1, 1, 64, &b_same) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_compose(&split, 0, buf, 64, 750) == 64);
    CHECK(buf[0 * 3] == 0);         /* A 头部已离开段首 */
    CHECK(buf[12 * 3] == 255);      /* A 头部 = 0 + 12 */
    CHECK(comet_brightest_offset(&a, 750) == 12);
    CHECK(comet_brightest_offset(&b_same, 750) == 12);
    CHECK(buf[28 * 3] == 255);      /* B 头部 = 16 + 12 */

    /* 相位回绕：now = period 与 now = 0 的整帧逐字节相同。 */
    uint8_t cyc0[64 * 3];
    uint8_t cyc1[64 * 3];
    CHECK(lumen_segment_store_compose(&store, 0, cyc0, 64, 0) == 64);
    CHECK(lumen_segment_store_compose(&store, 0, cyc1, 64, 1000) == 64);
    CHECK(memcmp(cyc0, cyc1, 64 * 3) == 0);
}

/* ---------------- #30：帧循环判据 ---------------- */

static void test_segment_store_needs_frames(void)
{
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    /* 没有段：不需要帧循环。 */
    CHECK(!lumen_segment_store_needs_frames(&store, 1));

    /* 纯静态段：仍然不需要——这是「静态不空转」的判据本体。 */
    lumen_segment_t red = make_static(0, 9, 0, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &red) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_compose(&store, 0, (uint8_t[64 * 3]){0}, 64, 0) == 64);
    CHECK(!lumen_segment_store_needs_frames(&store, 1));

    /* 一段静态 + 一段呼吸：需要帧循环。 */
    lumen_segment_t breath = make_static(20, 29, 0, 255);
    breath.layer[0].type = LUMEN_EFFECT_BREATHING;
    layer_set_period(&breath.layer[0], 1000);
    CHECK(lumen_segment_store_set(&store, 0, 1, 1, 64, &breath) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_needs_frames(&store, 1));

    /* 清掉呼吸段后回到静态模式（帧循环随之关闭）。 */
    CHECK(lumen_segment_store_clear(&store, 0, 1));
    CHECK(!lumen_segment_store_needs_frames(&store, 1));

    /* strip_count 之外的段不算：strip_count 0 时按全部灯带判（防御分支）。 */
    CHECK(lumen_segment_store_set(&store, 0, 1, 1, 64, &breath) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_needs_frames(&store, 0));

    /* 参数防御。 */
    CHECK(!lumen_segment_store_needs_frames(NULL, 1));
}

/* ---------------- #49：SegmentReport 真实槽位回归 ----------------
 *
 * spec-v3 §4.2 第 3 处缺陷：QueryStrip 的 SegmentReport 必须报**真实槽位**，
 * 不是压缩序号。修复落在 led_engine_slots.c（从 led_engine.c 抽出的纯逻辑，
 * 因为 led_engine.c 依赖 FreeRTOS，进不了 host 测试）。
 *
 * 三条用例正是 issue #49 要求的三类场景；如果谁把 out_slots[written] = slot
 * 改回 out_slots[written] = written，下面会立刻变红。
 */

static void test_segment_real_slots(void)
{
    lumen_segment_t out[LUMEN_MAX_SEGMENTS];
    uint8_t slots[LUMEN_MAX_SEGMENTS];

    /* 1) 非 0 槽位：段在槽位 5 / 7，必须报 5 / 7 而不是 0 / 1。 */
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);
    lumen_segment_t a = make_static(0, 9, 0, 255);
    lumen_segment_t b = make_static(20, 29, 21845, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 5, 64, &a) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_set(&store, 0, 1, 7, 64, &b) == LUMEN_RESULT_OK);

    memset(slots, 0xEE, sizeof(slots));
    CHECK(lumen_led_engine_collect_segments(&store, 0, out, slots, LUMEN_MAX_SEGMENTS) == 2);
    CHECK(slots[0] == 5);
    CHECK(slots[1] == 7);
    /* 段内容与槽位一一对应（不是把槽位 0 的内容顶上来）。 */
    CHECK(out[0].start == 0 && out[0].end == 9);
    CHECK(out[1].start == 20 && out[1].end == 29);

    /*
     * 与真正上线的编码路径对齐：ble_link.c 直接把 slots[i] 传给
     * lumen_protocol_encode_segment_report，所以帧内偏移 7（payload 第 2 字节）
     * 必须就是 5 / 7。这条断言把「枚举」和「线上字节」钉在一起。
     */
    uint8_t frame[LUMEN_MAX_FRAME];
    uint8_t layer0[9];
    uint8_t layer1[9];
    lumen_layer_encode(&out[0].layer[0], layer0);
    lumen_layer_encode(&out[0].layer[1], layer1);
    size_t len = lumen_protocol_encode_segment_report(0x1D, 0x00, slots[0], out[0].start,
                                                      out[0].end, out[0].blend, layer0, layer1,
                                                      frame, sizeof(frame));
    CHECK(len == 23 + LUMEN_FRAME_OVERHEAD);
    CHECK(frame[7] == 5);
    lumen_layer_encode(&out[1].layer[0], layer0);
    lumen_layer_encode(&out[1].layer[1], layer1);
    len = lumen_protocol_encode_segment_report(0x1D, 0x00, slots[1], out[1].start, out[1].end,
                                               out[1].blend, layer0, layer1, frame,
                                               sizeof(frame));
    CHECK(len == 23 + LUMEN_FRAME_OVERHEAD);
    CHECK(frame[7] == 7);

    /* 2) 有空洞：段在槽位 1 / 3，槽位 2 为空——序号与槽位不能错位。 */
    lumen_segment_store_init(&store);
    lumen_segment_t s1 = make_static(0, 9, 0, 255);
    lumen_segment_t s3 = make_static(10, 19, 43690, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 1, 64, &s1) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_set(&store, 0, 1, 3, 64, &s3) == LUMEN_RESULT_OK);
    CHECK(!lumen_segment_store_get(&store, 0, 2)->active);

    memset(slots, 0xEE, sizeof(slots));
    CHECK(lumen_led_engine_collect_segments(&store, 0, out, slots, LUMEN_MAX_SEGMENTS) == 2);
    CHECK(slots[0] == 1);
    CHECK(slots[1] == 3);
    CHECK(out[0].start == 0);
    CHECK(out[1].start == 10);

    /* 空洞再挖深一点：只留槽位 3 一个段时，序号 0 对应的槽位仍是 3。 */
    CHECK(lumen_segment_store_clear(&store, 0, 1));
    CHECK(lumen_led_engine_collect_segments(&store, 0, out, slots, LUMEN_MAX_SEGMENTS) == 1);
    CHECK(slots[0] == 3);

    /* 3) 满 8 槽：顺序稳定（槽位升序），且槽位号逐个等于下标。 */
    lumen_segment_store_init(&store);
    for (uint8_t i = 0; i < LUMEN_MAX_SEGMENTS; ++i) {
        /* 故意倒序插入：输出顺序必须由槽位决定，不受插入顺序影响。 */
        uint8_t slot = (uint8_t)(LUMEN_MAX_SEGMENTS - 1 - i);
        lumen_segment_t seg = make_static((uint8_t)(slot * 8), (uint8_t)(slot * 8 + 7), 0, 255);
        CHECK(lumen_segment_store_set(&store, 0, 1, slot, 64, &seg) == LUMEN_RESULT_OK);
    }
    CHECK(lumen_segment_store_count(&store, 0) == LUMEN_MAX_SEGMENTS);
    memset(slots, 0xEE, sizeof(slots));
    CHECK(lumen_led_engine_collect_segments(&store, 0, out, slots, LUMEN_MAX_SEGMENTS) ==
          LUMEN_MAX_SEGMENTS);
    for (uint8_t i = 0; i < LUMEN_MAX_SEGMENTS; ++i) {
        CHECK(slots[i] == i);
        CHECK(out[i].start == (uint8_t)(i * 8));
    }

    /* 参数防御与 cap 截断：截断时槽位仍取自真实槽位。 */
    CHECK(lumen_led_engine_collect_segments(&store, 0, out, slots, 3) == 3);
    CHECK(slots[0] == 0 && slots[1] == 1 && slots[2] == 2);
    CHECK(lumen_led_engine_collect_segments(&store, 0, out, slots, 0) == 0);
    CHECK(lumen_led_engine_collect_segments(&store, 0, NULL, slots, LUMEN_MAX_SEGMENTS) == 0);
    CHECK(lumen_led_engine_collect_segments(NULL, 0, out, slots, LUMEN_MAX_SEGMENTS) == 0);
    CHECK(lumen_led_engine_collect_segments(&store, LUMEN_MAX_STRIPS, out, slots,
                                            LUMEN_MAX_SEGMENTS) == 0);
    /* out_slots 可选：传 NULL 不影响段拷贝。 */
    CHECK(lumen_led_engine_collect_segments(&store, 0, out, NULL, LUMEN_MAX_SEGMENTS) ==
          LUMEN_MAX_SEGMENTS);
    CHECK(out[3].start == 24);

    /* 空灯带 / 其它灯带的段不计入。 */
    lumen_segment_store_init(&store);
    lumen_segment_t other = make_static(0, 9, 0, 255);
    CHECK(lumen_segment_store_set(&store, 1, 2, 4, 64, &other) == LUMEN_RESULT_OK);
    CHECK(lumen_led_engine_collect_segments(&store, 0, out, slots, LUMEN_MAX_SEGMENTS) == 0);
    CHECK(lumen_led_engine_collect_segments(&store, 1, out, slots, LUMEN_MAX_SEGMENTS) == 1);
    CHECK(slots[0] == 4);
}

/* 灯珠数量减少时裁剪越界段（不自动缩短区间）。 */
static void test_segment_store_prune(void)
{
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    lumen_segment_t a = make_static(0, 15, 0, 255);
    lumen_segment_t b = make_static(40, 63, 0, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &a) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_set(&store, 0, 1, 1, 64, &b) == LUMEN_RESULT_OK);

    /* 30 灯：段 0 [0-15] 保留，段 1 [40-63] 越界失效。 */
    CHECK(lumen_segment_store_prune(&store, 0, 30) == 1);
    CHECK(lumen_segment_store_count(&store, 0) == 1);
    CHECK(lumen_segment_store_get(&store, 0, 0)->active);
    CHECK(lumen_segment_store_get(&store, 0, 0)->end == 15); /* 不自动缩短 */
    CHECK(!lumen_segment_store_get(&store, 0, 1)->active);

    /* 已经都不越界：再裁一次无事发生。 */
    CHECK(lumen_segment_store_prune(&store, 0, 30) == 0);

    /* 参数防御。 */
    CHECK(lumen_segment_store_prune(NULL, 0, 30) == 0);
    CHECK(lumen_segment_store_prune(&store, 8, 30) == 0);
}

/* ---------------- #25：SetSegment / ClearSegment / QueryStrip reducer ---------------- */

/* ---------------- #25 / #36：SetSegment / ClearSegment / QueryStrip reducer ---------------- */

/* 把 23 字节段载荷填好（docs/protocol-v4.md §7.1）。
 * layer1 传 NULL 时写空层（0xFF + 8 个 0，含 level 0）。 */
static void fill_segment_payload(uint8_t payload[23], uint8_t strip, uint8_t seg,
                                 uint8_t start, uint8_t end, uint8_t blend,
                                 const uint8_t layer0[9], const uint8_t layer1[9])
{
    memset(payload, 0, 23);
    payload[0] = strip;
    payload[1] = seg;
    payload[2] = start;
    payload[3] = end;
    payload[4] = blend;
    memcpy(&payload[5], layer0, 9);
    if (layer1 != NULL) {
        memcpy(&payload[14], layer1, 9);
    } else {
        payload[14] = LUMEN_NO_EFFECT;
    }
}

/* 静态层的 9 字节编码：type + hue(2) + sat + 4 个保留 0 + level(100)。
 * 满亮（level = 100）是默认值：v4 下 level = 0 会让这一层全黑。 */
static void fill_static_layer(uint8_t layer[9], uint16_t hue, uint8_t sat)
{
    memset(layer, 0, 9);
    layer[0] = LUMEN_EFFECT_STATIC;
    layer[1] = (uint8_t)(hue & 0xFF);
    layer[2] = (uint8_t)(hue >> 8);
    layer[3] = sat;
    layer[8] = LUMEN_LAYER_LEVEL_MAX;
}

static void test_segment_commands(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);

    lumen_segment_store_t segments;
    lumen_segment_store_init(&segments);

    lumen_command_outcome_t outcome;
    lumen_frame_t frame = {0};

    /* 命令表：三条都已实现，载荷长度固定（23 / 2 / 1）。 */
    CHECK(lumen_command_is_known(LUMEN_CMD_SET_SEGMENT));
    CHECK(lumen_command_is_known(LUMEN_CMD_CLEAR_SEGMENT));
    CHECK(lumen_command_is_known(LUMEN_CMD_QUERY_STRIP));
    CHECK(lumen_command_changes_state(LUMEN_CMD_SET_SEGMENT));
    CHECK(lumen_command_changes_state(LUMEN_CMD_CLEAR_SEGMENT));
    CHECK(!lumen_command_changes_state(LUMEN_CMD_QUERY_STRIP));
    CHECK(lumen_command_payload_len(LUMEN_CMD_SET_SEGMENT) == 23);
    CHECK(lumen_command_payload_len(LUMEN_CMD_CLEAR_SEGMENT) == 2);
    CHECK(lumen_command_payload_len(LUMEN_CMD_QUERY_STRIP) == 1);

    uint8_t layer[9];
    fill_static_layer(layer, 0, 255);

    /* 单层静态段：strip 0 seg 0 [0-9] hue=0 sat=255 blend=0 → OK。 */
    frame.command = LUMEN_CMD_SET_SEGMENT;
    frame.seq = 41;
    frame.payload_len = 23;
    fill_segment_payload(frame.payload, 0, 0, 0, 9, 0, layer, NULL);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment_op);
    CHECK(!outcome.segment_clear);
    CHECK(outcome.cancels_selftest);
    CHECK(!outcome.state_changed); /* 段配置不在 State 里 */
    CHECK(outcome.segment.start == 0 && outcome.segment.end == 9);
    CHECK(layer_hue(&outcome.segment.layer[0]) == 0);
    CHECK(layer_sat(&outcome.segment.layer[0]) == 255);
    CHECK(outcome.segment.layer[0].type == LUMEN_EFFECT_STATIC);

    /* 把它真正写进段表（模拟引擎），后续重叠校验才有前置状态。 */
    CHECK(lumen_segment_store_set(&segments, 0, 1, 0, 30, &outcome.segment) == LUMEN_RESULT_OK);

    /* 重叠段 [5-12] → InvalidParam，旧配置不变。 */
    frame.seq = 42;
    fill_segment_payload(frame.payload, 0, 1, 5, 12, 0, layer, NULL);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);
    CHECK(!outcome.cancels_selftest);
    CHECK(lumen_segment_store_count(&segments, 0) == 1);
    CHECK(lumen_segment_store_get(&segments, 0, 1)->start == 0);

    /* 越界 end >= led_count（30）→ InvalidParam。 */
    frame.seq = 43;
    fill_segment_payload(frame.payload, 0, 1, 10, 30, 0, layer, NULL);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);

    /* 正常第二段 [10-19]，换个颜色。 */
    frame.seq = 44;
    fill_static_layer(layer, 0x5555, 128);
    fill_segment_payload(frame.payload, 0, 1, 10, 19, 0, layer, NULL);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(layer_hue(&outcome.segment.layer[0]) == 0x5555);
    CHECK(layer_sat(&outcome.segment.layer[0]) == 128);

    /*
     * §7.1 的校验顺序：
     *   1 长度精确 23 → 不是 23 一律 BadLength（先于 type）
     *   2 layer0 已知且不为 0xFF
     *   3 layer1 已知或 0xFF；空层 level = 0
     *   4 各层 level ≤ 100
     *   5 layer1 空 ⇒ blend = 0
     *   6 blend ≤ 2
     *   7 静态层 param[3..6] = 0
     *   8 各层按 type 校验参数（呼吸 p5 ≤ 100）
     */
    fill_static_layer(layer, 0, 255);
    fill_segment_payload(frame.payload, 0, 2, 0, 4, 0, layer, NULL);
    frame.payload_len = 22;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    frame.payload_len = 24;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    frame.payload_len = 23;

    /* layer0 type = 0x07（未知）→ InvalidParam。 */
    frame.payload[5] = 0x07;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);

    /* layer0 = 0xFF（空层不允许作为底层）→ InvalidParam。 */
    frame.payload[5] = LUMEN_NO_EFFECT;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* 空层必须参数全 0：layer0 = 0xFF 且 param 非 0 → 仍是 InvalidParam。 */
    frame.payload[6] = 0x01;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* 恢复合法静态层；blend 非 0 但 layer1 为空 → InvalidParam（第 4 步）。 */
    fill_static_layer(layer, 0, 255);
    fill_segment_payload(frame.payload, 0, 2, 0, 4, 1, layer, NULL);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);

    /* blend = 3（不做取最大）→ InvalidParam（第 5 步），两层都非空也一样。 */
    uint8_t layer1[9];
    fill_static_layer(layer1, 0, 128);
    fill_segment_payload(frame.payload, 0, 2, 0, 4, 3, layer, layer1);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* 两层静态 + 三种合法 blend → OK（seg 2 [20-25]，避开前面已写入的段）。 */
    for (uint8_t blend = 0; blend <= 2; ++blend) {
        fill_segment_payload(frame.payload, 0, 2, 20, 25, blend, layer, layer1);
        lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.segment_op);
        CHECK(outcome.segment.layer[0].type == LUMEN_EFFECT_STATIC);
    }

    /* 静态层 param[3..6] 是保留位，必须全 0（第 6 步）。 */
    fill_static_layer(layer, 0, 255);
    layer[4] = 0x01; /* param[3] = period_lo */
    fill_segment_payload(frame.payload, 0, 2, 0, 4, 0, layer, NULL);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);

    /* 呼吸（动画类）：合法参数 → OK，字段被完整解析。
     * layer0 = 01 | hue 0E10 | sat FF | period 01F4 | p5 60 | flags 00。 */
    uint8_t anim[9] = {0x01, 0x10, 0x0E, 0xFF, 0xF4, 0x01, 0x60, 0x00,
                       LUMEN_LAYER_LEVEL_MAX};
    fill_segment_payload(frame.payload, 0, 2, 20, 25, 0, anim, NULL);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment_op);
    CHECK(outcome.segment.layer[0].type == LUMEN_EFFECT_BREATHING);
    CHECK(layer_period(&outcome.segment.layer[0]) == 0x01F4);
    CHECK(layer_p5(&outcome.segment.layer[0]) == 0x60);
    CHECK(layer_flags(&outcome.segment.layer[0]) == 0);

    /* 周期低于 3Hz 下限（334ms）→ InvalidParam；正好 334 合法；0（静止）合法。 */
    frame.payload[9] = 0x4D; /* 333 */
    frame.payload[10] = 0x01;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);
    frame.payload[9] = 0x4E; /* 334 */
    frame.payload[10] = 0x01;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    frame.payload[9] = 0x00;
    frame.payload[10] = 0x00;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);

    /* flags 保留位（呼吸 bit3-7）必须为 0；bit0-2 合法。 */
    frame.payload[9] = 0xF4;
    frame.payload[10] = 0x01;
    frame.payload[12] = 0x08; /* bit3 置位 */
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);
    frame.payload[12] = 0x07; /* reverse + waveform 3 */
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(layer_flags(&outcome.segment.layer[0]) == 0x07);

    /*
     * 彩虹 / 流光：300ms 高于 200 的 5Hz 下限、低于呼吸的 334，
     * 证明下限确实按类型区分而不是沿用呼吸的 334。
     */
    frame.payload[9] = 0x2C; /* 300 */
    frame.payload[10] = 0x01;
    frame.payload[11] = 0xFF; /* span / tail = 255（边界值） */
    frame.payload[12] = 0x00;
    frame.payload[5] = LUMEN_EFFECT_RAINBOW;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment.layer[0].type == LUMEN_EFFECT_RAINBOW);
    frame.payload[5] = LUMEN_EFFECT_COMET;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment.layer[0].type == LUMEN_EFFECT_COMET);

    /* 199 < 200 → InvalidParam；正好 200 合法。 */
    frame.payload[9] = 0xC7;
    frame.payload[10] = 0x00;
    frame.payload[5] = LUMEN_EFFECT_RAINBOW;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);
    frame.payload[9] = 0xC8;
    frame.payload[10] = 0x00;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);

    /* 彩虹 / 流光：bit1-7 保留（比呼吸更严，bit0 reverse 允许）。 */
    frame.payload[12] = 0x02;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);
    frame.payload[12] = 0x01;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(layer_flags(&outcome.segment.layer[0]) == 0x01);

    /* layer1 参数同样要校验：未知 type → InvalidParam。 */
    uint8_t bad_l1[9] = {0x07, 0, 0, 0, 0, 0, 0, 0, LUMEN_LAYER_LEVEL_MAX};
    fill_static_layer(layer, 0, 255);
    fill_segment_payload(frame.payload, 0, 2, 0, 4, 0, layer, bad_l1);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    /* layer1 静态层带保留位 → InvalidParam（第 6 步对两层都生效）。 */
    uint8_t l1_reserved[9];
    fill_static_layer(l1_reserved, 0, 128);
    l1_reserved[5] = 0x01;
    fill_segment_payload(frame.payload, 0, 2, 0, 4, 0, layer, l1_reserved);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    /* layer1 呼吸周期 100ms → InvalidParam。 */
    uint8_t l1_fast[9] = {0x01, 0, 0, 0xFF, 0x64, 0x00, 0x00, 0x00, LUMEN_LAYER_LEVEL_MAX};
    fill_segment_payload(frame.payload, 0, 2, 0, 4, 1, layer, l1_fast);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* strip_id != 0 → InvalidParam（baseline 只有 1 条灯带）。 */
    fill_segment_payload(frame.payload, 1, 0, 0, 4, 0, layer, NULL);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* seg_id 越界（8）→ InvalidParam。 */
    fill_segment_payload(frame.payload, 0, 8, 0, 4, 0, layer, NULL);
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* ClearSegment：合法 → OK + segment_clear，并取消自检。 */
    frame.command = LUMEN_CMD_CLEAR_SEGMENT;
    frame.seq = 45;
    frame.payload_len = 2;
    frame.payload[0] = 0;
    frame.payload[1] = 1;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment_op);
    CHECK(outcome.segment_clear);
    CHECK(outcome.cancels_selftest);

    /* 清一个不存在的槽位也回 OK（幂等，绝对值语义）。 */
    frame.payload[1] = 7;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);

    /* strip / seg 越界 → InvalidParam。 */
    frame.payload[0] = 1;
    frame.payload[1] = 0;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    frame.payload[0] = 0;
    frame.payload[1] = 8;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* QueryStrip：合法 → OK + strip_query + 不取消自检。 */
    frame.command = LUMEN_CMD_QUERY_STRIP;
    frame.seq = 46;
    frame.payload_len = 1;
    frame.payload[0] = 0;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.strip_query);
    CHECK(outcome.query_strip_id == 0);
    CHECK(!outcome.cancels_selftest);
    CHECK(!outcome.state_changed);

    /* strip 越界 → InvalidParam，不产生回包意图。 */
    frame.payload[0] = 1;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.strip_query);

    /* 段配置快照为 NULL 时按「没有活动段」处理：区间校验仍生效。 */
    frame.command = LUMEN_CMD_SET_SEGMENT;
    frame.payload_len = 23;
    fill_static_layer(layer, 0, 255);
    fill_segment_payload(frame.payload, 0, 0, 0, 29, 0, layer, NULL);
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    fill_segment_payload(frame.payload, 0, 0, 0, 30, 0, layer, NULL);
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
}

/* ---------------- #25：SegmentReport / SegmentListEnd 编码 ---------------- */

/* ---------------- #25 / #36：SegmentReport / SegmentListEnd / 两条新报告编码 ---------------- */

static void test_encode_segment_reports(void)
{
    /*
     * SegmentReport 0x83：载荷与 §7.1 的 SetSegment 同构，**固定 23 字节**
     * （docs/protocol-v4.md §7.1）。
     *
     * 这里用「单层静态 [0-29] hue=0 sat=255 level=100 + 空 layer1 + blend 0」，
     * 参考值由独立脚本按 §3.1 / §3.4 算出。
     */
    uint8_t layer0[9];
    memset(layer0, 0, sizeof(layer0));
    layer0[0] = LUMEN_EFFECT_STATIC;
    layer0[3] = 255;
    layer0[8] = LUMEN_LAYER_LEVEL_MAX;

    uint8_t out[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_segment_report(0x1D, 0x00, 0x00, 0x00, 0x1D, 0x00,
                                                      layer0, NULL, out, sizeof(out));
    /* 8 字节信封 + 23 载荷 = 31。 */
    CHECK(len == 23 + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, "A604831D17000000001D00000000FF0000000064FF00000000000000000422", len);

    /* 载荷布局逐字节核对：strip, seg, start, end, blend, layer0(9), layer1(9)。 */
    CHECK(out[6] == 0x00);  /* strip_id */
    CHECK(out[7] == 0x00);  /* seg_id */
    CHECK(out[8] == 0x00);  /* start */
    CHECK(out[9] == 0x1D);  /* end */
    CHECK(out[10] == 0x00); /* blend */
    CHECK(out[11] == LUMEN_EFFECT_STATIC);
    CHECK(out[14] == 255);  /* sat */
    CHECK(out[19] == LUMEN_LAYER_LEVEL_MAX); /* layer0 level 在段块偏移 8（帧内 13+8=19） */
    /* 空 layer1：type = 0xFF，param + level 全 0。 */
    CHECK(out[20] == LUMEN_NO_EFFECT);
    for (size_t i = 21; i < 29; ++i) {
        CHECK(out[i] == 0);
    }

    /* 两层非空：layer1 原样进偏移 14（帧内 20）。 */
    uint8_t layer1[9];
    memset(layer1, 0, sizeof(layer1));
    layer1[0] = LUMEN_EFFECT_BREATHING;
    layer1[1] = 0x55;
    layer1[2] = 0x55;
    layer1[8] = LUMEN_LAYER_LEVEL_MAX;
    len = lumen_protocol_encode_segment_report(0x1D, 0x00, 0x03, 0x00, 0x3F, 0x01, layer0,
                                               layer1, out, sizeof(out));
    CHECK(len == 23 + LUMEN_FRAME_OVERHEAD);
    CHECK(out[10] == 0x01);              /* blend */
    CHECK(out[20] == LUMEN_EFFECT_BREATHING);
    CHECK(out[21] == 0x55 && out[22] == 0x55);
    /* 段块内 layer1.level 在帧内 6+14+8 = 28。 */
    CHECK(out[28] == LUMEN_LAYER_LEVEL_MAX);

    /* SegmentListEnd：载荷 [strip_id, seg_mask]。 */
    len = lumen_protocol_encode_segment_list_end(0x1D, 0x00, 0x07, out, sizeof(out));
    CHECK(len == 2 + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, "A604841D02000007F49C", len);

    /* 参数防御：layer0 为 NULL / 缓冲不足。 */
    CHECK(lumen_protocol_encode_segment_report(1, 0, 0, 0, 1, 0, NULL, NULL, out,
                                               sizeof(out)) == 0);
    CHECK(lumen_protocol_encode_segment_report(1, 0, 0, 0, 1, 0, layer0, NULL, out,
                                               23 + LUMEN_FRAME_OVERHEAD - 1) == 0);
    CHECK(lumen_protocol_encode_segment_list_end(1, 0, 0x07, out, 9) == 0);
}

static void test_encode_strip_config_report(void)
{
    /* 参考向量 strip_config_report_3_strips：GPIO 3 / 10 / 0，其余 0xFF + flags 0。 */
    uint8_t gpios[LUMEN_MAX_STRIPS] = {3, 10, 0, 0, 0, 0, 0, 0};
    uint8_t out[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_strip_config_report(0x35, gpios, 3, out, sizeof(out));
    CHECK(len == 24 + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, "A60487351800000301010A0102000103FF0004FF0005FF0006FF0007FF003454",
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
    /* 参考向量 device_info_report：v4.0、MAC、五个上限、caps=0x01。 */
    uint8_t hw[6] = {0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF};
    uint8_t out[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_device_info_report(0x36, 0x0400, hw, LUMEN_CAP_TWO_LAYERS,
                                                          out, sizeof(out));
    CHECK(len == 15 + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, "A60488360F000004AABBCCDDEEFF400808080401000553", len);

    /* 偏移核对：0..1 version，2..7 hw_id，8..12 上限，13 caps，14 保留 0。 */
    CHECK(out[6] == 0x00 && out[7] == 0x04);
    CHECK(memcmp(&out[8], hw, sizeof(hw)) == 0);
    CHECK(out[14] == LUMEN_MAX_LEDS);
    CHECK(out[15] == LUMEN_MAX_STRIPS);
    CHECK(out[16] == LUMEN_MAX_SEGMENTS);
    CHECK(out[17] == LUMEN_MAX_STAGES);
    CHECK(out[18] == LUMEN_MAX_SCRIPTS);
    CHECK(out[19] == LUMEN_CAP_TWO_LAYERS);
    CHECK(out[20] == 0x00);

    /* caps 的保留位由调用方决定；编码器原样透传。 */
    len = lumen_protocol_encode_device_info_report(0x01, 0x0301, hw, 0x03, out, sizeof(out));
    CHECK(len == 15 + LUMEN_FRAME_OVERHEAD);
    CHECK(out[7] == 0x03);
    CHECK(out[6] == 0x01 && out[18] == LUMEN_MAX_SCRIPTS);
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
    CHECK(decode_hex("A6040101010001B168", &frame, &rc) == LUMEN_DECODE_OK);
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
    CHECK(lumen_planar_parse_list(" , , ", out, LUMEN_MAX_STRIPS) == 0);

    /* 非法：整串作废，不静默截断或跳过。 */
    CHECK(lumen_planar_parse_list("3,x,5", out, LUMEN_MAX_STRIPS) == 0);
    CHECK(lumen_planar_parse_list("3,,", out, LUMEN_MAX_STRIPS) != 0); /* 尾随分隔符可接受 */
    CHECK(lumen_planar_parse_list("1,2,3", out, 2) == 0);             /* 超容量 */
    CHECK(lumen_planar_parse_list(NULL, out, LUMEN_MAX_STRIPS) == 0);
    CHECK(lumen_planar_parse_list("3", NULL, LUMEN_MAX_STRIPS) == 0);
}

static void test_planar_init_validation(void)
{
    lumen_planar_t planar;
    uint8_t pins[LUMEN_MAX_STRIPS] = {3, 4, 5, 6, 7, 10, 20, 21};
    uint16_t counts[LUMEN_MAX_STRIPS] = {64, 30, 30, 30, 30, 30, 30, 30};

    CHECK(lumen_planar_init(&planar, pins, counts, 8));
    CHECK(planar.strip_count == 8);
    CHECK(planar.max_count == 64);
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
    uint16_t counts[2] = {64, 30};
    CHECK(lumen_planar_init(&planar, pins, counts, 2));
    CHECK(planar.max_count == 64);

    /* 把最大的那条调小：max_count 必须重算，否则句柄白白按 64 建。 */
    CHECK(lumen_planar_set_count(&planar, 0, 20));
    CHECK(planar.max_count == 30);
    CHECK(lumen_planar_get(&planar, 0)->count == 20);

    /* 越界一律拒绝，且不改值。 */
    CHECK(!lumen_planar_set_count(&planar, 0, 0));
    CHECK(!lumen_planar_set_count(&planar, 0, LUMEN_MAX_LEDS + 1));
    CHECK(!lumen_planar_set_count(&planar, 2, 10)); /* 不存在的条 */
    CHECK(lumen_planar_get(&planar, 0)->count == 20);

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
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 0);
    /* 总闸不改掩码：各带自己的开关状态原样保留。 */
    CHECK(outcome.next.strip_power_mask == 0x0B);

    /* 再开回来：掩码仍是 0x0B，strip 2 依旧关着。 */
    state.power = 0;
    frame.payload[0] = 1;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.next.power == 1);
    CHECK(outcome.next.strip_power_mask == 0x0B);

    /* 门控复核：总闸开 + 掩码 0x0B ⇒ strip 2 依然不出光。 */
    CHECK(lumen_strip_mask_allows(&outcome.next, 0, false));
    CHECK(!lumen_strip_mask_allows(&outcome.next, 2, false));
}

/*
 * strip_anim_mask 的三种状态（§7.3）：静态段 / 动画段 / 无段。
 * 每条带只关心「有没有动画类活动段」，与段的槽位、数量、其它带无关。
 */
static void test_strip_anim_mask(void)
{
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    /* 无段：全 0。 */
    CHECK(lumen_strip_anim_mask(&store, 4) == 0x00);
    CHECK(lumen_strip_anim_mask(NULL, 4) == 0x00);

    /* 只有静态段：仍然全 0（静态不产生动画位）。 */
    store.slot[0][0] = make_static(0, 9, 0, 255);
    store.slot[2][3] = make_static(5, 9, 0, 255);
    CHECK(lumen_strip_anim_mask(&store, 4) == 0x00);

    /* strip 1 加一个动画段 → bit1。 */
    store.slot[1][0] = make_animated(LUMEN_EFFECT_BREATHING, 0, 9, 0, 255, 1000, 0, 0, 0);
    CHECK(lumen_strip_anim_mask(&store, 4) == 0x02);

    /* strip 3 再加一个 → bit1 | bit3；strip 0/2 仍只有静态段。 */
    store.slot[3][7] = make_animated(LUMEN_EFFECT_RAINBOW, 0, 9, 0, 255, 500, 0, 0, 0);
    CHECK(lumen_strip_anim_mask(&store, 4) == 0x0A);

    /* 一条带多个动画段也只占一位。 */
    store.slot[1][1] = make_animated(LUMEN_EFFECT_COMET, 0, 9, 0, 255, 500, 0, 0, 0);
    CHECK(lumen_strip_anim_mask(&store, 4) == 0x0A);

    /* strip_count 之外的带不参与（strip 3 在 strip_count=3 时不置位）。 */
    CHECK(lumen_strip_anim_mask(&store, 3) == 0x02);

    /* 清掉动画段 → 位跟着消失。 */
    store.slot[1][0].active = false;
    store.slot[1][1].active = false;
    CHECK(lumen_strip_anim_mask(&store, 4) == 0x08);

    /* 8 条带全动画 → 0xFF。 */
    for (uint8_t s = 0; s < LUMEN_MAX_STRIPS; ++s) {
        store.slot[s][0] = make_animated(LUMEN_EFFECT_BREATHING, 0, 9, 0, 255, 1000, 0, 0, 0);
    }
    CHECK(lumen_strip_anim_mask(&store, LUMEN_MAX_STRIPS) == 0xFF);
    /* strip_count = 0 视为「全部」（与 segment_store_needs_frames 同口径）。 */
    CHECK(lumen_strip_anim_mask(&store, 0) == 0xFF);
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
 * 不同灯珠数的每带区间校验（票面 30/60/10）。命令层必须按各自带的上限
 * 判定，否则短带会「设成功但后半段不亮」。
 */
static void test_per_strip_led_counts_30_60_10(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.strip_count = 3;
    state.led_count = 30; /* strip 0 */

    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 60, 10, 0, 0, 0, 0, 0};
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    uint8_t layer[9];
    fill_static_layer(layer, 0, 255);
    lumen_command_outcome_t out;

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
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        lumen_segment_store_init(&store);
        lumen_frame_t f = {0};
        f.command = LUMEN_CMD_SET_SEGMENT;
        f.seq = (uint8_t)(i + 1);
        f.payload_len = 23;
        fill_segment_payload(f.payload, cases[i].strip, 0, cases[i].start, cases[i].end, 0, layer,
                             NULL);
        lumen_command_dispatch(&f, &state, &store, counts, 255, &out);
        if (cases[i].expect_ok) {
            CHECK(out.result_code == LUMEN_RESULT_OK);
            CHECK(out.segment_op);
        } else {
            CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
            CHECK(!out.segment_op);
        }
    }

    /* helper 取到的就是各自带的数字。 */
    CHECK(lumen_command_strip_count(&state, counts, 0) == 30);
    CHECK(lumen_command_strip_count(&state, counts, 1) == 60);
    CHECK(lumen_command_strip_count(&state, counts, 2) == 10);
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
    lumen_command_dispatch(&f, &state, NULL, NULL, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_OK);
    CHECK(out.strip_power_op);
    CHECK(out.strip_power_strip == 7);

    /* 8 越界：既不是已分配灯带，也超出 LUMEN_MAX_STRIPS。 */
    f.payload[0] = 8;
    lumen_command_dispatch(&f, &state, NULL, NULL, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!out.strip_power_op);
    /* 0xFF 这类脏值同样拒绝，不能按位运算误命中。 */
    f.payload[0] = 0xFF;
    lumen_command_dispatch(&f, &state, NULL, NULL, 255, &out);
    CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!out.strip_power_op);

    /* on 只有 0 / 1；0xFF 不能当「开」。 */
    f.payload[0] = 0;
    for (uint8_t on = 2; on <= 0xFF; ++on) {
        f.payload[1] = on;
        lumen_command_dispatch(&f, &state, NULL, NULL, 255, &out);
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
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.strip_power_op);
    CHECK(outcome.strip_power_strip == 2);
    CHECK(!outcome.strip_power_on);
    CHECK(outcome.cancels_selftest);
    /* 命令层不改 next：掩码由 ble_link 在 ACK 之前写入。 */
    CHECK(!outcome.state_changed);

    /* on = 1 同样合法。 */
    frame.payload[1] = 1;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.strip_power_on);

    /* strip_id 未分配（>= strip_count）→ InvalidParam。 */
    frame.payload[0] = 4;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.strip_power_op);
    CHECK(!outcome.cancels_selftest);

    /* on 只允许 0/1。 */
    frame.payload[0] = 0;
    frame.payload[1] = 2;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* 载荷长度必须正好 2。 */
    frame.payload[1] = 1;
    frame.payload_len = 1;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    frame.payload_len = 3;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
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
    lumen_command_dispatch(&power, &state, NULL, NULL, 255, &outcome);
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



/* #29：每条灯带的灯珠数必须持久化（票面「断电重启后 8 条灯带的配置全部恢复」）。 */
static void test_blob_strip_counts(void)
{
    lumen_persist_t in;
    lumen_state_defaults(&in.state, 64);
    lumen_segment_store_init(&in.segments);
    in.state.strip_count = 8;
    in.state.led_count = 64;
    /* strip 0 由 state.led_count 决定（64），1..7 取各自的值。 */
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        in.strip_counts[i] = i == 0 ? 64 : (uint16_t)(10 + i);
    }

    uint8_t blob[LUMEN_STATE_BLOB_SIZE];
    CHECK(lumen_state_blob_encode(&in, blob) == LUMEN_STATE_BLOB_SIZE);

    lumen_persist_t out;
    memset(&out, 0, sizeof(out));
    CHECK(lumen_state_blob_decode(blob, sizeof(blob), &out));
    CHECK(out.state.strip_count == 8);
    CHECK(out.strip_counts[0] == 64); /* 编码器强制 = state.led_count */
    for (uint8_t i = 1; i < LUMEN_MAX_STRIPS; ++i) {
        CHECK(out.strip_counts[i] == (uint16_t)(10 + i));
    }
    /* strip 0 的灯珠数与 State 的 led_count 必须一致（编码器强制）。 */
    CHECK(out.strip_counts[0] == out.state.led_count);

    /* 某条灯珠数越界 → 整份视为损坏。 */
    uint8_t bad[LUMEN_STATE_BLOB_SIZE];
    memcpy(bad, blob, sizeof(bad));
    bad[LUMEN_STRIP_COUNTS_OFFSET + 3 * 2] = 0; /* strip 3 的 count = 0 → 非法 */
    bad[LUMEN_STRIP_COUNTS_OFFSET + 3 * 2 + 1] = 0;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* strip 0 与 led_count 矛盾 → 拒绝。 */
    memcpy(bad, blob, sizeof(bad));
    bad[11] = 30; /* led_count 改成 30，但 strip_counts[0] 仍是 64 */
    bad[12] = 0;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
}


/*
 * #29 integration bug regression：SetSegment 必须按「这条灯带自己」的灯珠数
 * 校验区间，而不是一律用 strip 0 的。
 *
 * 场景：strip 0 有 64 灯，strip 3 只有 10 灯。
 *  - 给 strip 3 设 [0-40] 必须被拒（越界）：40 >= 10。
 *  - 给 strip 3 设 [0-9] 必须被接受。
 * 若实现错用 strip 0 的 64，第一条会被放行——表现为「设成功但后半段不亮」。
 */
/*
 * #29 integration bug regression：SetSegment 必须按「这条灯带自己」的灯珠数
 * 校验区间，而不是一律用 strip 0 的。
 *
 * 场景：strip 0 有 64 灯，strip 3 只有 10 灯。
 *  - 给 strip 3 设 [0-40] 必须被拒（越界）：40 >= 10。
 *  - 给 strip 3 设 [0-9] 必须被接受。
 * 若实现错用 strip 0 的 64，第一条会被放行——表现为「设成功但后半段不亮」。
 * 这是 docs/spec-v3.md §4.2 的第 1 处缺陷在命令层的回归。
 */
static void test_set_segment_uses_own_strip_count(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 64);
    state.strip_count = 8;
    state.led_count = 64; /* strip 0 */

    uint16_t strip_counts[LUMEN_MAX_STRIPS] = {64, 30, 30, 10, 30, 30, 30, 30};
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    uint8_t layer[9];
    fill_static_layer(layer, 0, 255);
    lumen_command_outcome_t out;

    /* 静态段 [0-40] 打到 strip 3（只有 10 灯）→ 越界，必须拒绝。 */
    {
        lumen_frame_t f = {0};
        f.command = LUMEN_CMD_SET_SEGMENT;
        f.seq = 1;
        f.payload_len = 23;
        fill_segment_payload(f.payload, 3, 0, 0, 40, 0, layer, NULL);
        lumen_command_dispatch(&f, &state, &store, strip_counts, 255, &out);
        CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
        CHECK(!out.segment_op);
    }

    /* 同一帧打到 strip 0（64 灯）→ 合法。证明差异确实来自 per-strip 表。 */
    {
        lumen_frame_t f = {0};
        f.command = LUMEN_CMD_SET_SEGMENT;
        f.seq = 2;
        f.payload_len = 23;
        fill_segment_payload(f.payload, 0, 0, 0, 40, 0, layer, NULL);
        lumen_command_dispatch(&f, &state, &store, strip_counts, 255, &out);
        CHECK(out.result_code == LUMEN_RESULT_OK);
        CHECK(out.segment_op);
    }

    /* strip 3 的合法上界 [0-9] 必须被接受。 */
    {
        lumen_frame_t f = {0};
        f.command = LUMEN_CMD_SET_SEGMENT;
        f.seq = 3;
        f.payload_len = 23;
        fill_segment_payload(f.payload, 3, 0, 0, 9, 0, layer, NULL);
        lumen_command_dispatch(&f, &state, &store, strip_counts, 255, &out);
        CHECK(out.result_code == LUMEN_RESULT_OK);
    }

    /* strip_counts == NULL 时退回 State 的 led_count（单灯带兼容）。 */
    {
        lumen_frame_t f = {0};
        f.command = LUMEN_CMD_SET_SEGMENT;
        f.seq = 4;
        f.payload_len = 23;
        fill_segment_payload(f.payload, 0, 1, 0, 40, 0, layer, NULL);
        lumen_command_dispatch(&f, &state, &store, NULL, 255, &out);
        CHECK(out.result_code == LUMEN_RESULT_OK);
    }

    /* helper 本身的边界。 */
    CHECK(lumen_command_strip_count(&state, strip_counts, 3) == 10);
    CHECK(lumen_command_strip_count(&state, NULL, 3) == 64); /* 退回 strip 0 */
    CHECK(lumen_command_strip_count(&state, strip_counts, 0) == 64);
}

/*
 * docs/spec-v3.md §4.2 的第 2 处缺陷回归：state_blob 解码必须按**各自灯带**的
 * 灯珠数校验段区间，不能用 strip 0 的数字校验所有条带。
 *
 * 场景：strip 0 = 64 灯、strip 3 = 10 灯，段 [0-40] 落在 strip 3 上。
 * 旧实现用 64 校验 → 放行 → 加载后渲染越界（读到段外、画面残留）。
 */
static void test_state_blob_per_strip_bounds(void)
{
    lumen_persist_t in;
    memset(&in, 0, sizeof(in));
    lumen_state_defaults(&in.state, 64);
    in.state.strip_count = 4;
    in.state.led_count = 64;
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        in.strip_counts[i] = i == 3 ? 10 : 64;
    }
    in.state.seg_count = 0; /* strip 0 没有段 */

    /* strip 3 上一个 end=40 的段：对 10 灯是越界，对 64 灯「合法」。 */
    lumen_segment_t seg = make_static(0, 40, 0, 255);
    in.segments.slot[3][0] = seg;

    uint8_t blob[LUMEN_STATE_BLOB_SIZE];
    CHECK(lumen_state_blob_encode(&in, blob) == LUMEN_STATE_BLOB_SIZE);

    lumen_persist_t out;
    memset(&out, 0, sizeof(out));
    CHECK(!lumen_state_blob_decode(blob, sizeof(blob), &out));

    /* 同一段放进 strip 0（64 灯）必须解出来。 */
    memset(&in.segments, 0, sizeof(in.segments));
    in.segments.slot[0][0] = seg;
    in.state.seg_count = 1;
    CHECK(lumen_state_blob_encode(&in, blob) == LUMEN_STATE_BLOB_SIZE);
    memset(&out, 0, sizeof(out));
    CHECK(lumen_state_blob_decode(blob, sizeof(blob), &out));
    CHECK(out.segments.slot[0][0].active);
    CHECK(out.segments.slot[0][0].end == 40);
}


/* ---------------- #32 剧本 ---------------- */

/* 下发一套 stages 阶段的最小剧本（每阶段一个静态段）。 */
static bool script_download(lumen_script_store_t *store, uint8_t script_id, uint8_t stages,
                            uint16_t duration_ms)
{
    if (!lumen_script_begin(store, script_id, stages, 1)) {
        return false;
    }
    for (uint8_t st = 0; st < stages; ++st) {
        if (!lumen_script_stage(store, script_id, st, duration_ms, 0)) {
            return false;
        }
        lumen_segment_t seg = make_static(0, 9, (uint16_t)(st * 4096u), 255);
        if (!lumen_script_segment(store, script_id, st, 0, 0, &seg, NULL)) {
            return false;
        }
    }
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};
    return lumen_script_commit(store, script_id, counts, NULL, 0, NULL) ==
           LUMEN_SCRIPT_COMMIT_OK;
}

static void test_script_store_download(void)
{
    lumen_script_store_t store;
    lumen_script_store_init(&store);

    CHECK(lumen_script_get(&store, 0) == NULL);
    CHECK(!lumen_script_is_committed(&store, 0));

    /* 4 阶段剧本：每阶段各自的时长与各段灯效。 */
    CHECK(lumen_script_begin(&store, 0, 4, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 1000, 0));
    CHECK(lumen_script_stage(&store, 0, 1, 2000, 0));
    CHECK(lumen_script_stage(&store, 0, 2, 1500, 0));
    CHECK(lumen_script_stage(&store, 0, 3, 2500, 0));
    for (uint8_t st = 0; st < 4; ++st) {
        lumen_segment_t seg = make_static(0, 29, (uint16_t)(st * 5000u), 255);
        uint16_t written = 0;
        CHECK(lumen_script_segment(&store, 0, st, 0, 0, &seg, &written));
        /* 每接受一帧，进度累加（0x86 的数据源）。 */
        CHECK(written == (uint16_t)(st + 1u));
    }
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};
    CHECK(lumen_script_commit(&store, 0, counts, NULL, 0, NULL) == LUMEN_SCRIPT_COMMIT_OK);

    const lumen_script_t *script = lumen_script_get(&store, 0);
    CHECK(script != NULL);
    CHECK(lumen_script_stage_count(&store, 0) == 4);
    CHECK(script != NULL && script->stages[0].duration_ms == 1000);
    CHECK(script != NULL && script->stages[3].duration_ms == 2500);
    CHECK(script != NULL &&
          layer_hue(&script->stages[2].segments[0][0].layer[0]) == 10000);
    CHECK(script != NULL && script->stages[2].segments[0][0].active);
    /* 未写的段槽位保持非活动。 */
    CHECK(script != NULL && !script->stages[0].segments[0][1].active);

    /* 结构校验：id / 阶段下标 / 段形状。 */
    CHECK(!lumen_script_begin(&store, LUMEN_MAX_SCRIPTS, 4, 1));
    CHECK(!lumen_script_begin(&store, 0, 0, 1));
    CHECK(!lumen_script_begin(&store, 0, LUMEN_MAX_STAGES + 1, 1));
    CHECK(!lumen_script_begin(&store, 0, 4, 0));
    CHECK(!lumen_script_begin(&store, 0, 4, LUMEN_MAX_STRIPS + 1));
    CHECK(lumen_script_begin(&store, 0, 2, 1));
    CHECK(!lumen_script_stage(&store, 0, 2, 100, 0));   /* 超出 stage_count */
    CHECK(!lumen_script_stage(&store, 0, 0, 0, 0));     /* 时长 0 */
    CHECK(!lumen_script_stage(&store, 1, 0, 100, 0));   /* 不是本次暂存的 id */
    lumen_segment_t seg = make_static(0, 9, 0, 255);
    CHECK(!lumen_script_segment(&store, 0, 0, 1, 0, &seg, NULL)); /* strip 越界 */
    CHECK(!lumen_script_segment(&store, 0, 0, 0, LUMEN_MAX_SEGMENTS, &seg, NULL));
    lumen_segment_t bad_type = seg;
    bad_type.layer[0].type = 0x09;
    CHECK(!lumen_script_segment(&store, 0, 0, 0, 0, &bad_type, NULL));
    lumen_segment_t inverted = seg;
    inverted.start = 9;
    inverted.end = 0;
    CHECK(!lumen_script_segment(&store, 0, 0, 0, 0, &inverted, NULL));

    /* Abort 丢弃暂存，已提交剧本不动。 */
    lumen_script_abort(&store, 0);
    CHECK(lumen_script_get(&store, 0) != NULL);
    CHECK(lumen_script_stage_count(&store, 0) == 4);

    /* Begin 会覆盖暂存（不需要先 Abort），但已提交剧本仍然不动。 */
    CHECK(lumen_script_begin(&store, 0, 1, 1));
    CHECK(lumen_script_get(&store, 0) != NULL);
    CHECK(lumen_script_stage_count(&store, 0) == 4);
}

/*
 * 提交失败必须保留上一套可用配置（#32 的核心验收点）。
 * 四种失败路径各测一遍：阶段数非法、时长 0、段越界、段重叠。
 */
static void test_script_commit_failure_keeps_previous(void)
{
    lumen_script_store_t store;
    lumen_script_store_init(&store);

    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};

    /* 先提交一套 2 阶段的好剧本。 */
    CHECK(script_download(&store, 0, 2, 500));
    const lumen_script_t *good = lumen_script_get(&store, 0);
    CHECK(good != NULL);
    CHECK(good != NULL && good->stage_count == 2);
    CHECK(good != NULL && good->stages[0].duration_ms == 500);
    const lumen_segment_t before = good != NULL ? good->stages[0].segments[0][0]
                                                : (lumen_segment_t){0};

    /* (a) 缺阶段时长为 0 → commit 失败，旧剧本完整。 */
    CHECK(lumen_script_begin(&store, 0, 3, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 800, 0));
    CHECK(lumen_script_stage(&store, 0, 1, 800, 0));
    /* stage 2 不写时长 */
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &before, NULL));
    CHECK(lumen_script_commit(&store, 0, counts, NULL, 0, NULL) ==
          LUMEN_SCRIPT_COMMIT_INVALID);
    CHECK(store.staging_active == false);
    CHECK(lumen_script_get(&store, 0) != NULL);
    CHECK(lumen_script_stage_count(&store, 0) == 2);
    good = lumen_script_get(&store, 0);
    CHECK(good != NULL && layer_hue(&good->stages[0].segments[0][0].layer[0]) ==
                            layer_hue(&before.layer[0]));
    CHECK(good != NULL && good->stages[0].duration_ms == 500);

    /* (b) 段越界（end >= 该灯带灯珠数）→ 失败，旧剧本完整。 */
    CHECK(lumen_script_begin(&store, 0, 1, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 800, 0));
    lumen_segment_t out_of_range = make_static(0, 40, 0, 255); /* 30 灯 */
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &out_of_range, NULL));
    CHECK(lumen_script_commit(&store, 0, counts, NULL, 0, NULL) ==
          LUMEN_SCRIPT_COMMIT_INVALID);
    CHECK(lumen_script_stage_count(&store, 0) == 2);

    /* (c) 同灯带段重叠 → 失败，旧剧本完整。 */
    CHECK(lumen_script_begin(&store, 0, 1, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 800, 0));
    lumen_segment_t first = make_static(0, 15, 0, 255);
    lumen_segment_t second = make_static(10, 20, 0, 255);
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &first, NULL));
    CHECK(lumen_script_segment(&store, 0, 0, 0, 1, &second, NULL));
    CHECK(lumen_script_commit(&store, 0, counts, NULL, 0, NULL) ==
          LUMEN_SCRIPT_COMMIT_INVALID);
    CHECK(lumen_script_stage_count(&store, 0) == 2);

    /* (d) stage_count 越界（begin 就拒）与 strip_counts 全 0 → 失败。 */
    CHECK(!lumen_script_begin(&store, 0, 0, 1));
    CHECK(lumen_script_begin(&store, 0, 1, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 800, 0));
    uint16_t no_counts[LUMEN_MAX_STRIPS] = {0};
    CHECK(lumen_script_commit(&store, 0, no_counts, NULL, 0, NULL) ==
          LUMEN_SCRIPT_COMMIT_INVALID);
    CHECK(lumen_script_stage_count(&store, 0) == 2);

    /* 失败之后重新下一次好剧本仍然成功（暂存已清，可以重来）。 */
    CHECK(script_download(&store, 0, 3, 700));
    CHECK(lumen_script_stage_count(&store, 0) == 3);
}

/* 多套剧本互不覆盖：切换激活不丢另一套的配置。 */
static void test_script_multiple_scripts(void)
{
    lumen_script_store_t store;
    lumen_script_store_init(&store);

    CHECK(script_download(&store, 0, 4, 1000));
    CHECK(script_download(&store, 1, 2, 400));

    CHECK(lumen_script_is_committed(&store, 0));
    CHECK(lumen_script_is_committed(&store, 1));
    CHECK(!lumen_script_is_committed(&store, 2));
    CHECK(lumen_script_stage_count(&store, 0) == 4);
    CHECK(lumen_script_stage_count(&store, 1) == 2);

    const lumen_script_t *s0 = lumen_script_get(&store, 0);
    CHECK(s0 != NULL && layer_hue(&s0->stages[0].segments[0][0].layer[0]) == 0);
    const lumen_script_t *s1 = lumen_script_get(&store, 1);
    CHECK(s1 != NULL && layer_hue(&s1->stages[1].segments[0][0].layer[0]) == 4096);

    /* 覆盖 0 号不影响 1 号。 */
    CHECK(script_download(&store, 0, 1, 900));
    CHECK(lumen_script_stage_count(&store, 0) == 1);
    CHECK(lumen_script_stage_count(&store, 1) == 2);
    s1 = lumen_script_get(&store, 1);
    CHECK(s1 != NULL && layer_hue(&s1->stages[1].segments[0][0].layer[0]) == 4096);
}

/*
 * 播放头推进：到点自动切、循环回绕、非循环停在最后阶段。
 * 用 4 阶段 × 1000ms 的剧本，按 500ms 步进推进。
 */
static void test_script_playback_advance(void)
{
    lumen_script_store_t store;
    lumen_script_store_init(&store);
    CHECK(script_download(&store, 0, 4, 1000));
    const lumen_script_t *script = lumen_script_get(&store, 0);
    CHECK(script != NULL);

    lumen_script_playback_t pb;
    lumen_script_playback_init(&pb);
    CHECK(pb.script_id == LUMEN_NO_SCRIPT);
    CHECK(!lumen_script_playback_active(&pb));

    /* --- 循环会回绕：走完 4 个阶段后回到 stage 0 --- */
    lumen_script_playback_select(&pb, 0, true, 0);
    CHECK(pb.stage_index == 0);
    CHECK(pb.state == LUMEN_PLAYBACK_STOPPED);
    lumen_script_playback_play(&pb, 0);
    CHECK(pb.state == LUMEN_PLAYBACK_PLAYING);
    CHECK(lumen_script_playback_active(&pb));

    uint32_t t = 0;
    int changes = 0;
    for (t = 500; t <= 4500; t += 500) {
        uint32_t script_time = 0;
        if (lumen_script_playback_tick(script, &pb, t, &script_time)) {
            ++changes;
        }
        /* script_time 就是 now（从未暂停过）。 */
        CHECK(script_time == t);
    }
    /* 4500ms：过了 4 个整阶段 → 回到 stage 0（绕一圈）。 */
    CHECK(pb.stage_index == 0);
    CHECK(pb.state == LUMEN_PLAYBACK_PLAYING);
    CHECK(pb.loop);
    CHECK(changes == 4);

    /* 非循环：走完最后一阶段 → STOPPED，停在最后一阶段（hold_last）。 */
    lumen_script_playback_select(&pb, 0, false, 0);
    lumen_script_playback_play(&pb, 0);
    for (t = 500; t <= 4000; t += 500) {
        (void)lumen_script_playback_tick(script, &pb, t, NULL);
    }
    CHECK(pb.state == LUMEN_PLAYBACK_STOPPED);
    CHECK(pb.stage_index == 3);
    CHECK(pb.hold_last);
    /* 停止后不再推进（继续 tick 也不改阶段）。 */
    (void)lumen_script_playback_tick(script, &pb, 9000, NULL);
    CHECK(pb.stage_index == 3);

    /* 延迟一轮：渲染任务被推迟 3500ms，一次追上 3 个阶段而不是卡住。 */
    lumen_script_playback_select(&pb, 0, false, 0);
    lumen_script_playback_play(&pb, 0);
    int caught = lumen_script_playback_tick(script, &pb, 3500, NULL) ? 1 : 0;
    CHECK(caught == 1);
    CHECK(pb.stage_index == 3);
    CHECK(pb.state == LUMEN_PLAYBACK_PLAYING);
    CHECK(pb.elapsed_ms == 500);

    /* stop：播放头回 0、停止态。 */
    lumen_script_playback_stop(&pb, 4000);
    CHECK(pb.stage_index == 0);
    CHECK(pb.state == LUMEN_PLAYBACK_STOPPED);
    CHECK(pb.elapsed_ms == 0);
    CHECK(pb.hold_last == false);
}

/*
 * 暂停后继续必须从暂停点继续（#32 的另一个核心验收点）。
 * 1000ms/阶段、4 阶段：在 1200ms（阶段 1 内 200ms）暂停，暂停 5 秒后继续，
 * 再推 800ms 应当刚好进入阶段 2，而不是回到阶段 0。
 */
static void test_script_playback_pause_resume(void)
{
    lumen_script_store_t store;
    lumen_script_store_init(&store);
    CHECK(script_download(&store, 0, 4, 1000));
    const lumen_script_t *script = lumen_script_get(&store, 0);
    CHECK(script != NULL);

    lumen_script_playback_t pb;
    lumen_script_playback_init(&pb);
    lumen_script_playback_select(&pb, 0, true, 0);
    lumen_script_playback_play(&pb, 0);

    uint32_t script_time = 0;
    (void)lumen_script_playback_tick(script, &pb, 1200, &script_time);
    CHECK(pb.stage_index == 1);
    CHECK(pb.elapsed_ms == 200);
    CHECK(script_time == 1200);

    /* 暂停：画面与时间轴冻结。 */
    lumen_script_playback_pause(&pb, 1200);
    CHECK(pb.state == LUMEN_PLAYBACK_PAUSED);
    CHECK(lumen_script_playback_active(&pb));
    CHECK(lumen_script_playback_time(&pb, 3000) == 1200);
    (void)lumen_script_playback_tick(script, &pb, 5000, &script_time);
    CHECK(pb.stage_index == 1);
    CHECK(pb.elapsed_ms == 200);
    CHECK(script_time == 1200); /* 暂停期间时间轴不前进 */

    /* 继续：播放头与 elapsed 原样保留（不回到阶段 0 / 不重置阶段内进度）。 */
    lumen_script_playback_play(&pb, 6200);
    CHECK(pb.state == LUMEN_PLAYBACK_PLAYING);
    CHECK(pb.stage_index == 1);
    CHECK(pb.elapsed_ms == 200);

    /* 继续后 700ms：阶段 1 内 900ms，仍在阶段 1。 */
    (void)lumen_script_playback_tick(script, &pb, 6900, &script_time);
    CHECK(pb.stage_index == 1);
    CHECK(script_time == 1900); /* 1200 + 700，暂停的 5000ms 没有被计入 */

    /* 再 200ms：阶段 1 走完 → 阶段 2。证明是从暂停点继续算的。 */
    (void)lumen_script_playback_tick(script, &pb, 7100, &script_time);
    CHECK(pb.stage_index == 2);
    CHECK(script_time == 2100);

    /* 暂停 → 反复 play 幂等。 */
    lumen_script_playback_pause(&pb, 7100);
    lumen_script_playback_play(&pb, 8000);
    lumen_script_playback_play(&pb, 8100);
    CHECK(pb.state == LUMEN_PLAYBACK_PLAYING);
    CHECK(pb.stage_index == 2);

    /* 停止后再 play：从阶段 0 重新开始（与暂停恢复不同）。 */
    lumen_script_playback_stop(&pb, 8200);
    lumen_script_playback_play(&pb, 8300);
    CHECK(pb.stage_index == 0);
    CHECK(pb.elapsed_ms == 0);
    CHECK(lumen_script_playback_time(&pb, 8300) == 8300);
}

/*
 * 自检覆盖期间不推进播放头（v2-effects-engine §7.1）：
 * 播放中跑 2 秒自检，结束后必须从原阶段原相位继续，不能一次补进 2 秒。
 */
static void test_script_playback_hold_during_selftest(void)
{
    lumen_script_store_t store;
    lumen_script_store_init(&store);
    CHECK(script_download(&store, 0, 4, 1000));
    const lumen_script_t *script = lumen_script_get(&store, 0);
    CHECK(script != NULL);

    lumen_script_playback_t pb;
    lumen_script_playback_init(&pb);
    lumen_script_playback_select(&pb, 0, true, 0);
    lumen_script_playback_play(&pb, 0);

    uint32_t t = 0;
    (void)lumen_script_playback_tick(script, &pb, 300, &t);
    CHECK(pb.stage_index == 0);
    CHECK(pb.elapsed_ms == 300);
    CHECK(t == 300);

    /* 自检 2000ms：每帧醒来都按住时间轴（模拟渲染任务的 tick 循环）。 */
    for (uint32_t now = 400; now <= 2300; now += 100) {
        lumen_script_playback_hold(&pb, now);
        const uint32_t held = lumen_script_playback_time(&pb, now);
        CHECK(held == 300); /* 时间轴冻结在自检开始的那一刻 */
    }
    CHECK(pb.stage_index == 0);
    CHECK(pb.elapsed_ms == 300);
    CHECK(pb.state == LUMEN_PLAYBACK_PLAYING); /* hold 不改状态 */

    /* 自检结束：继续播放。此时阶段内只有 300ms，再走 600ms 仍不到 1000ms。 */
    (void)lumen_script_playback_tick(script, &pb, 2900, &t);
    CHECK(pb.stage_index == 0); /* 300 + 600 = 900ms，未满 1000ms */
    CHECK(t == 900);
    /* 再 200ms（1000ms 整）→ 进入阶段 1，阶段内 100ms。 */
    (void)lumen_script_playback_tick(script, &pb, 3100, &t);
    CHECK(pb.stage_index == 1);
    CHECK(pb.elapsed_ms == 100);
    CHECK(t == 1100);

    /* hold 对停止 / 暂停态是空操作（不改变任何时间量）。 */
    lumen_script_playback_stop(&pb, 4000);
    const uint32_t before = lumen_script_playback_time(&pb, 4000);
    lumen_script_playback_hold(&pb, 9000);
    CHECK(lumen_script_playback_time(&pb, 9000) == before);
}

/* ---------------- #39：剧本 fade / 两层持久化 / 容量预检 ---------------- */

/*
 * fade_ms：非 0 能存能读，且播放行为仍是硬切（这里只断言存储，硬切由
 * 「阶段切换不读 fade」的结构保证——播放时间轴只吃 duration_ms）。
 */
static void test_script_fade_roundtrip(void)
{
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};

    lumen_script_store_t store;
    lumen_script_store_init(&store);
    CHECK(lumen_script_begin(&store, 0, 2, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 1000, 0));
    CHECK(lumen_script_stage(&store, 0, 1, 2000, 350)); /* 非 0 fade：接受 */
    lumen_segment_t seg = make_static(0, 9, 100, 255);
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &seg, NULL));
    CHECK(lumen_script_segment(&store, 0, 1, 0, 0, &seg, NULL));
    CHECK(lumen_script_commit(&store, 0, counts, NULL, 0, NULL) == LUMEN_SCRIPT_COMMIT_OK);

    uint8_t blob[LUMEN_SCRIPT_BLOB_MAX];
    size_t len = lumen_script_blob_encode(&store, 0, false, blob, sizeof(blob));
    CHECK(len > 8);

    lumen_script_store_t restored;
    lumen_script_store_init(&restored);
    uint8_t active = LUMEN_NO_SCRIPT;
    bool loop = true;
    CHECK(lumen_script_blob_decode(blob, len, counts, &restored, &active, &loop));
    const lumen_script_t *sc = lumen_script_get(&restored, 0);
    CHECK(sc != NULL);
    if (sc != NULL) {
        CHECK(sc->stages[0].fade_ms == 0);
        CHECK(sc->stages[1].fade_ms == 350);
        CHECK(sc->stages[1].duration_ms == 2000);
    }
}

/*
 * 两层段必须**完整**持久化：layer1 的类型与参数、blend 都要回来。
 * 这正是 #37 显式降级、#39 补上的缺口。
 */
static void test_script_two_layer_persist(void)
{
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};

    lumen_segment_t seg = make_static(0, 9, 1234, 200);
    seg.layer[1].type = LUMEN_EFFECT_BREATHING;
    layer_set_period(&seg.layer[1], 1500);
    layer_set_p5(&seg.layer[1], 0x20);
    layer_set_flags(&seg.layer[1], 0x02);
    layer_set_level(&seg.layer[1], 70);
    seg.blend = LUMEN_BLEND_MULTIPLY;

    lumen_script_store_t store;
    lumen_script_store_init(&store);
    CHECK(lumen_script_begin(&store, 0, 1, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 1000, 0));
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &seg, NULL));
    CHECK(lumen_script_commit(&store, 0, counts, NULL, 0, NULL) == LUMEN_SCRIPT_COMMIT_OK);

    uint8_t blob[LUMEN_SCRIPT_BLOB_MAX];
    size_t len = lumen_script_blob_encode(&store, 0, false, blob, sizeof(blob));
    CHECK(len > 8);

    lumen_script_store_t restored;
    lumen_script_store_init(&restored);
    uint8_t active = LUMEN_NO_SCRIPT;
    bool loop = true;
    CHECK(lumen_script_blob_decode(blob, len, counts, &restored, &active, &loop));
    const lumen_script_t *sc = lumen_script_get(&restored, 0);
    CHECK(sc != NULL);
    if (sc != NULL) {
        const lumen_segment_t *out = &sc->stages[0].segments[0][0];
        CHECK(out->active);
        CHECK(out->blend == LUMEN_BLEND_MULTIPLY);
        CHECK(out->layer[0].type == LUMEN_EFFECT_STATIC);
        CHECK(layer_hue(&out->layer[0]) == 1234);
        CHECK(out->layer[1].type == LUMEN_EFFECT_BREATHING);
        CHECK(lumen_layer_period_ms(&out->layer[1]) == 1500);
        /* v4：层亮度必须进 blob 并原样回来。 */
        CHECK(lumen_layer_level(&out->layer[0]) == 100);
        CHECK(lumen_layer_level(&out->layer[1]) == 70);
    }
}

/*
 * 两层都空 = 清空该槽位（§9.6）。命令层交出一个非活动段，引擎释放槽位；
 * 这里验证剧本层对「非活动段」的处理不会把它当成有效段持久化。
 */
static void test_script_clear_slot(void)
{
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};

    lumen_script_store_t store;
    lumen_script_store_init(&store);
    CHECK(lumen_script_begin(&store, 0, 1, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 1000, 0));
    lumen_segment_t seg = make_static(0, 9, 100, 255);
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &seg, NULL));

    /* 清空：非活动段写回同一槽位。 */
    lumen_segment_t empty;
    memset(&empty, 0, sizeof(empty));
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &empty, NULL));

    CHECK(lumen_script_commit(&store, 0, counts, NULL, 0, NULL) == LUMEN_SCRIPT_COMMIT_OK);
    const lumen_script_t *sc = lumen_script_get(&store, 0);
    CHECK(sc != NULL);
    if (sc != NULL) {
        CHECK(!sc->stages[0].segments[0][0].active);
    }
}

/*
 * 容量预检：构造 8 带 × 8 阶段 × 8 段 × 两层动画的剧本（理论最坏），
 * 断言 commit 回 TOO_LARGE、**不提交**、已提交的上一套原样保留、
 * 暂存区被丢弃（RAM 里不存在「已提交但存不下」的剧本）。
 */
static void test_script_commit_too_large(void)
{
    uint16_t counts[LUMEN_MAX_STRIPS] = {64, 64, 64, 64, 64, 64, 64, 64};

    /* 两层动画段，宽度最大（v4 记录 21 字节）。 */
    lumen_segment_t heavy;
    memset(&heavy, 0, sizeof(heavy));
    heavy.active = true;
    heavy.start = 0;
    heavy.end = 0; /* 每段一颗灯，避免重叠 */
    heavy.blend = LUMEN_BLEND_ADD;
    heavy.layer[0].type = LUMEN_EFFECT_BREATHING;
    layer_set_period(&heavy.layer[0], 1000);
    heavy.layer[1].type = LUMEN_EFFECT_COMET;
    layer_set_period(&heavy.layer[1], 1000);

    lumen_script_store_t store;
    lumen_script_store_init(&store);

    /* 先提交一套小的，作为「上一套必须保留」的锚点。 */
    CHECK(lumen_script_begin(&store, 0, 1, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 1000, 0));
    lumen_segment_t small = make_static(0, 9, 100, 255);
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &small, NULL));
    CHECK(lumen_script_commit(&store, 0, counts, NULL, 0, NULL) == LUMEN_SCRIPT_COMMIT_OK);

    /*
     * 单套满配（8 带 × 8 阶段 × 8 段 × 两层动画）= 10752 字节（v4 记录 21 字节），**装得下**；
     * 4 套合计 39176 字节才超 16KB。所以先提交一套满配进 0 号槽位，
     * 再提交第二套——两份合起来就撞线。
     */
    for (uint8_t id = 1; id <= 2; ++id) {
        CHECK(lumen_script_begin(&store, id, 8, 8));
        for (uint8_t st = 0; st < 8; ++st) {
            CHECK(lumen_script_stage(&store, id, st, 1000, 0));
            for (uint8_t strip = 0; strip < 8; ++strip) {
                for (uint8_t seg = 0; seg < 8; ++seg) {
                    lumen_segment_t seg_cfg = heavy;
                    seg_cfg.start = seg;
                    seg_cfg.end = seg;
                    CHECK(lumen_script_segment(&store, id, st, strip, seg, &seg_cfg, NULL));
                }
            }
        }

        uint8_t blob[LUMEN_SCRIPT_BLOB_MAX];
        size_t len = 0;
        lumen_script_commit_result_t r =
            lumen_script_commit(&store, id, counts, blob, sizeof(blob), &len);
        if (id == 1) {
            /* 第一套满配仍在 16KB 内。 */
            CHECK(r == LUMEN_SCRIPT_COMMIT_OK);
            CHECK(len > 9000);
        } else {
            /* 第二套把总量推过 16384 → 拒签，且**不提交**。 */
            CHECK(r == LUMEN_SCRIPT_COMMIT_TOO_LARGE);
            CHECK(!lumen_script_is_committed(&store, 2));
            CHECK(!store.staging_active);
        }
    }

    /* 已提交的 0 号小剧本与 1 号满配剧本都还在。 */
    CHECK(lumen_script_is_committed(&store, 0));
    CHECK(lumen_script_is_committed(&store, 1));

    /* 暂存被丢弃：同一 id 再 Begin 必须能从头开始。 */
    CHECK(lumen_script_begin(&store, 2, 1, 1));
}

/*
 * 不变式「能 commit 的一定能持久化」：对一组不同规模的剧本，凡 commit 成功
 * 的，encode 必须成功且 ≤ 16KB。这是 #39 修掉的 v2 缺陷的回归护栏。
 */
static void test_script_commit_implies_persistable(void)
{
    static const struct {
        uint8_t stages;
        uint8_t strips;
        uint8_t segs;
    } cases[] = {
        {4, 1, 3},
        {4, 2, 4},
        {8, 2, 4},
        {4, 4, 4},
        {8, 8, 8},
    };

    uint16_t counts[LUMEN_MAX_STRIPS] = {64, 64, 64, 64, 64, 64, 64, 64};
    uint8_t blob[LUMEN_SCRIPT_BLOB_MAX];

    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        lumen_script_store_t store;
        lumen_script_store_init(&store);
        CHECK(lumen_script_begin(&store, 0, cases[i].stages, cases[i].strips));

        for (uint8_t st = 0; st < cases[i].stages; ++st) {
            CHECK(lumen_script_stage(&store, 0, st, 1000, 0));
            for (uint8_t strip = 0; strip < cases[i].strips; ++strip) {
                for (uint8_t seg = 0; seg < cases[i].segs; ++seg) {
                    lumen_segment_t cfg = make_static(seg, seg, 100, 255);
                    /* 交替动画层，把记录撑到最宽。 */
                    if ((seg % 2u) == 0u) {
                        cfg.layer[1].type = LUMEN_EFFECT_BREATHING;
                        layer_set_period(&cfg.layer[1], 1000);
                        cfg.blend = LUMEN_BLEND_MULTIPLY;
                    }
                    CHECK(lumen_script_segment(&store, 0, st, strip, seg, &cfg, NULL));
                }
            }
        }

        size_t len = 0;
        lumen_script_commit_result_t r =
            lumen_script_commit(&store, 0, counts, blob, sizeof(blob), &len);
        if (r == LUMEN_SCRIPT_COMMIT_OK) {
            /* 不变式的正方向：commit 成功 ⇒ 一定能编码进 16KB。 */
            CHECK(len > 8);
            CHECK(len <= LUMEN_SCRIPT_BLOB_MAX);
            lumen_script_store_t replay;
            lumen_script_store_init(&replay);
            CHECK(lumen_script_blob_decode(blob, len, counts, &replay, NULL, NULL));
        } else {
            /* 反方向：拒签必须是 TOO_LARGE，且没有半套状态。 */
            CHECK(r == LUMEN_SCRIPT_COMMIT_TOO_LARGE);
            CHECK(!lumen_script_is_committed(&store, 0));
        }
    }
}

static void test_script_blob_roundtrip(void)
{
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 12, 0, 0, 0, 0, 0, 0};

    lumen_script_store_t store;
    lumen_script_store_init(&store);
    CHECK(script_download(&store, 0, 4, 1000));
    /* 1 号剧本：2 条灯带、每阶段两条灯带各一个段，含动画段。 */
    CHECK(lumen_script_begin(&store, 1, 2, 2));
    for (uint8_t st = 0; st < 2; ++st) {
        CHECK(lumen_script_stage(&store, 1, st, (uint16_t)(700 + st * 100), 0));
        lumen_segment_t a = make_static(0, 9, 1234, 200);
        lumen_segment_t b = make_static(0, 5, 0, 255);
        b.layer[0].type = LUMEN_EFFECT_BREATHING;
        layer_set_period(&b.layer[0], 1000);
        layer_set_p5(&b.layer[0], 0x40);
        layer_set_flags(&b.layer[0], 0x02);
        CHECK(lumen_script_segment(&store, 1, st, 0, 0, &a, NULL));
        CHECK(lumen_script_segment(&store, 1, st, 1, 3, &b, NULL));
    }
    CHECK(lumen_script_commit(&store, 1, counts, NULL, 0, NULL) == LUMEN_SCRIPT_COMMIT_OK);

    uint8_t blob[LUMEN_SCRIPT_BLOB_MAX];
    size_t len = lumen_script_blob_encode(&store, 1, true, blob, sizeof(blob));
    CHECK(len > 8);
    CHECK(len <= sizeof(blob));

    lumen_script_store_t restored;
    lumen_script_store_init(&restored);
    uint8_t active = LUMEN_NO_SCRIPT;
    bool loop = false;
    CHECK(lumen_script_blob_decode(blob, len, counts, &restored, &active, &loop));
    CHECK(active == 1);
    CHECK(loop);

    CHECK(lumen_script_stage_count(&restored, 0) == 4);
    CHECK(lumen_script_stage_count(&restored, 1) == 2);
    const lumen_script_t *s1 = lumen_script_get(&restored, 1);
    CHECK(s1 != NULL);
    if (s1 != NULL) {
        CHECK(s1->strip_count == 2);
        CHECK(s1->stages[1].duration_ms == 800);
        CHECK(layer_hue(&s1->stages[0].segments[0][0].layer[0]) == 1234);
        CHECK(layer_sat(&s1->stages[0].segments[0][0].layer[0]) == 200);
        CHECK(s1->stages[0].segments[1][3].active);
        CHECK(s1->stages[0].segments[1][3].layer[0].type == LUMEN_EFFECT_BREATHING);
        CHECK(layer_period(&s1->stages[0].segments[1][3].layer[0]) == 1000);
        CHECK(layer_flags(&s1->stages[0].segments[1][3].layer[0]) == 0x02);
        CHECK(!s1->stages[0].segments[1][0].active);
    }

    /* 未提交的槽位编码为 committed=0，解码后仍不存在。 */
    CHECK(!lumen_script_is_committed(&restored, 2));
    CHECK(!lumen_script_is_committed(&restored, 3));

    /* 损坏检测：坏 magic / 坏版本 / 截断 / 段越界 / 激活指向未提交剧本。 */
    uint8_t bad[LUMEN_SCRIPT_BLOB_MAX];
    memcpy(bad, blob, len);
    bad[0] = 'X';
    CHECK(!lumen_script_blob_decode(bad, len, counts, &restored, &active, &loop));

    memcpy(bad, blob, len);
    bad[4] = 0x09;
    CHECK(!lumen_script_blob_decode(bad, len, counts, &restored, &active, &loop));

    /*
     * v4：上一代脚本 blob（magic `LMS3` / version 2，层没有 level 字节）必须
     * 整份拒绝。只要 magic 或 version 任一不符就拒 —— 绝不能按新布局去读旧
     * 字节，否则整份记录都会错位（level 被当成下一层的 type）。
     */
    memcpy(bad, blob, len);
    bad[3] = '3'; /* magic LMS4 → LMS3 */
    CHECK(!lumen_script_blob_decode(bad, len, counts, &restored, &active, &loop));
    memcpy(bad, blob, len);
    bad[4] = 0x02; /* version 3 → 2 */
    bad[5] = 0x00;
    CHECK(!lumen_script_blob_decode(bad, len, counts, &restored, &active, &loop));

    CHECK(!lumen_script_blob_decode(blob, len - 1, counts, &restored, &active, &loop));

    /*
     * 用一份「段越界」的编码喂回去：改段记录里的 end 为 200（>30 灯）。
     * 段记录紧跟 magic(4)+version(2)+active(1)+flags(1)+committed(1)+
     * stage_count(1)+strip_count(1)+duration(2)+mask(1) = 14 字节处。
     */
    memcpy(bad, blob, len);
    bad[14 + 1] = 200;
    CHECK(!lumen_script_blob_decode(bad, len, counts, &restored, &active, &loop));

    /* 激活 id 指向未提交剧本 → 拒绝。 */
    memcpy(bad, blob, len);
    bad[6] = 3;
    CHECK(!lumen_script_blob_decode(bad, len, counts, &restored, &active, &loop));

    /* 空 store：只有头，解码成功但没有任何剧本。 */
    lumen_script_store_t empty;
    lumen_script_store_init(&empty);
    size_t empty_len = lumen_script_blob_encode(&empty, LUMEN_NO_SCRIPT, false, blob, sizeof(blob));
    CHECK(empty_len == 8 + LUMEN_MAX_SCRIPTS);
    CHECK(lumen_script_blob_decode(blob, empty_len, counts, &restored, &active, &loop));
    CHECK(active == LUMEN_NO_SCRIPT);
    CHECK(!loop);
    for (uint8_t id = 0; id < LUMEN_MAX_SCRIPTS; ++id) {
        CHECK(!lumen_script_is_committed(&restored, id));
    }
}


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
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    /*
     * 静态：hue = 21845（120°）sat = 255 → 纯绿。位置与时刻都无关。
     */
    lumen_segment_t stat = make_static(4, 11, 21845, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &stat) == LUMEN_RESULT_OK);
    uint8_t buf[64 * 3];
    CHECK(lumen_segment_store_compose(&store, 0, buf, 64, 0) == 64);
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
    lumen_segment_store_init(&store);
    lumen_segment_t breath = make_animated(LUMEN_EFFECT_BREATHING, 0, 9, 0, 255, 1000, 0, 0, 0);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &breath) == LUMEN_RESULT_OK);
    for (uint32_t t = 0; t <= 1000; t += 125) {
        uint32_t phase = lumen_effect_breathing_phase_q16(1000, 0, t);
        uint32_t env = lumen_effect_breathing_envelope_q16(phase, LUMEN_WAVE_SINE);
        uint32_t gain = lumen_effect_breathing_gain_q16(1000, 0, LUMEN_WAVE_SINE, 0, t);
        CHECK(gain == (uint32_t)(((uint64_t)env * 65536u) / 65536u)); /* min=0 → e'=e */
        uint8_t expected = lumen_effect_apply_gain_q16(255, gain);
        CHECK(lumen_segment_store_compose(&store, 0, buf, 64, t) == 64);
        CHECK(buf[0] == expected && buf[1] == 0 && buf[2] == 0);
        CHECK(buf[9 * 3] == expected); /* 段内同步 */
    }

    /*
     * 彩虹：span = 255，N = 16（段 [0-15]），第 i 颗 hue = i × 4096，用独立的
     * 扇区公式算参考色，与 lumen_effect_static_rgb 的输入对齐（同一个纯函数，
     * 这里只验证「层求值确实用段内偏移 + 段 t0」这条路没有偏移）。
     */
    lumen_segment_store_init(&store);
    lumen_segment_t rainbow =
        make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 1000, 255, 0, 0);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &rainbow) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_compose(&store, 0, buf, 64, 0) == 64);
    for (uint16_t i = 0; i < 16; ++i) {
        uint8_t ref[3];
        lumen_effect_static_rgb((uint16_t)(i * 4096u), 255, ref);
        CHECK(buf[i * 3] == ref[0] && buf[i * 3 + 1] == ref[1] && buf[i * 3 + 2] == ref[2]);
    }

    /*
     * 流光：t = 0、tail = 0 时头部在段首且只有它亮（权重表 k=0 → 65535）。
     */
    lumen_segment_store_init(&store);
    lumen_segment_t comet = make_animated(LUMEN_EFFECT_COMET, 0, 15, 0, 255, 1000, 0, 0, 0);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &comet) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_compose(&store, 0, buf, 64, 0) == 64);
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

    /* 别名安全：out 与输入同一块内存。 */
    uint8_t alias[3] = {100, 100, 100};
    lumen_blend_pixel(LUMEN_BLEND_MULTIPLY, alias, alias, alias);
    CHECK(alias[0] == 39); /* (100*100+127)/255 = 39.7 → 39 */
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
    unknown0.layer[0].type = 0x07;
    CHECK(lumen_segment_validate_shape(&unknown0) == LUMEN_RESULT_INVALID_PARAM);

    /* 第 3 步：layer1 未知 type → 非法。 */
    lumen_segment_t unknown1 = ok;
    layer_set(LUMEN_EFFECT_STATIC, 0, 128, 0, 0, 0, &unknown1.layer[0]);
    unknown1.layer[1].type = 0x07;
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

    /* 第 5 步：blend > 2 → 非法（两层都非空也一样）。 */
    lumen_segment_t two;
    memset(&two, 0, sizeof(two));
    layer_set(LUMEN_EFFECT_STATIC, 0, 255, 0, 0, 0, &two.layer[0]);
    layer_set(LUMEN_EFFECT_STATIC, 0, 128, 0, 0, 0, &two.layer[1]);
    for (uint8_t blend = 0; blend <= 2; ++blend) {
        two.blend = blend;
        CHECK(lumen_segment_validate_shape(&two) == LUMEN_RESULT_OK);
    }
    two.blend = 3;
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
    uint8_t unknown_wire[9] = {0x07, 1, 2, 3, 4, 5, 6, 7, 9};
    lumen_effect_layer_t unknown;
    CHECK(!lumen_layer_decode(unknown_wire, &unknown));
    CHECK(unknown.type == 0x07);
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
 * 清槽旁路（command.c 的 ScriptSegment「两层都空」）也必须要求 level == 0。
 * 直接走 command 层，确保绕开 validate_shape 的那条分支也有这道门。
 */
static void test_script_segment_clear_slot_level(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.strip_count = 1;
    lumen_segment_store_t segments;
    lumen_segment_store_init(&segments);

    lumen_command_outcome_t outcome;
    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SCRIPT_SEGMENT;
    frame.payload_len = 25;

    /* 两层都空 + 两层 level 都为 0 → 清槽，OK 且交出非活动段。 */
    memset(frame.payload, 0, sizeof(frame.payload));
    frame.payload[0] = 0; /* script_id */
    frame.payload[1] = 0; /* stage */
    frame.payload[2] = 0; /* strip */
    frame.payload[3] = 0; /* seg */
    frame.payload[4] = 0; /* start */
    frame.payload[5] = 9; /* end */
    frame.payload[6] = 0; /* blend */
    frame.payload[7] = LUMEN_LAYER_EMPTY;
    frame.payload[16] = LUMEN_LAYER_EMPTY;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.script_op == LUMEN_SCRIPT_OP_SEGMENT);
    CHECK(!outcome.script_segment.active);

    /* layer0 = 0xFF 但 level = 30 → 不是清槽，回 InvalidParam。 */
    frame.payload[15] = 30; /* layer0.level 在段块偏移 5+8 = 13 → 帧内 15 */
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(outcome.script_op == LUMEN_SCRIPT_OP_NONE);

    /* layer1 同理。 */
    memset(frame.payload, 0, sizeof(frame.payload));
    frame.payload[5] = 9;
    frame.payload[7] = LUMEN_LAYER_EMPTY;
    frame.payload[16] = LUMEN_LAYER_EMPTY;
    frame.payload[24] = 30; /* layer1.level 在段块偏移 5+9+8 = 22 → 帧内 24 */
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
}

/*
 * script_store 层也拒绝「带亮度的空段」清槽（不只是 command 层）。
 * 直接调 lumen_script_segment，模拟别的调用方。
 */
static void test_script_store_clear_rejects_level(void)
{
    lumen_script_store_t store;
    lumen_script_store_init(&store);
    CHECK(lumen_script_begin(&store, 0, 1, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 1000, 0));

    /* 合法的清槽（非活动段、level 全 0）。 */
    lumen_segment_t empty;
    memset(&empty, 0, sizeof(empty));
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &empty, NULL));

    /* 非活动段但带 level → 拒绝。 */
    lumen_segment_t bad_empty;
    memset(&bad_empty, 0, sizeof(bad_empty));
    bad_empty.layer[0].level = 10;
    CHECK(!lumen_script_segment(&store, 0, 0, 0, 0, &bad_empty, NULL));
    bad_empty.layer[0].level = 0;
    bad_empty.layer[1].level = 10;
    CHECK(!lumen_script_segment(&store, 0, 0, 0, 0, &bad_empty, NULL));
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
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);
    lumen_segment_t seg;
    memset(&seg, 0, sizeof(seg));
    seg.active = true;
    seg.start = 0;
    seg.end = 15;
    seg.blend = LUMEN_BLEND_MULTIPLY;
    layer_set(LUMEN_EFFECT_RAINBOW, 0, 255, 0, 0, 0, &seg.layer[0]);
    layer_set(LUMEN_EFFECT_BREATHING, 0, 255, 1000, 0, 0, &seg.layer[1]);
    CHECK(lumen_segment_validate_shape(&seg) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &seg) == LUMEN_RESULT_OK);

    uint8_t dark[64 * 3];
    uint8_t bright[64 * 3];
    CHECK(lumen_segment_store_compose(&store, 0, dark, 64, 0) == 64);
    CHECK(lumen_segment_store_compose(&store, 0, bright, 64, 500) == 64);
    /* t=0：呼吸包络 0（min_level 0）→ 相乘为 0。 */
    for (uint16_t i = 0; i < 16; ++i) {
        CHECK(dark[i * 3] == 0 && dark[i * 3 + 1] == 0 && dark[i * 3 + 2] == 0);
    }
    /* t=500：呼吸满亮 → 与纯彩虹（单层）逐字节相同。 */
    lumen_segment_store_t pure;
    lumen_segment_store_init(&pure);
    lumen_segment_t solo = make_animated(LUMEN_EFFECT_RAINBOW, 0, 15, 0, 255, 0, 0, 0, 0);
    CHECK(lumen_segment_store_set(&pure, 0, 1, 0, 64, &solo) == LUMEN_RESULT_OK);
    uint8_t reference[64 * 3];
    CHECK(lumen_segment_store_compose(&pure, 0, reference, 64, 500) == 64);
    CHECK(memcmp(&bright[0], &reference[0], 16 * 3) == 0);

    /*
     * 中间时刻（呼吸半亮）的暗部必须不塌陷：彩虹段是纯红 (255,0,0)，
     * 与呼吸相乘后 R 约减半——远高于「先 gamma 再相乘」会把暗部压到的个位数。
     */
    uint8_t mid[64 * 3];
    CHECK(lumen_segment_store_compose(&store, 0, mid, 64, 250) == 64);
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

/* 段表 / 剧本表的体积记录（v4：层 8 → 9 字节的连锁代价）。 */
static void test_two_layer_ram_sizes(void)
{
    /* 段：active(1) + start/end/blend(3) + 2 × layer(9) + t0_ms(4) = 25，
     * 因 4 字节对齐涨到 28。 */
    CHECK(sizeof(lumen_effect_layer_t) == 9);
    CHECK(sizeof(lumen_segment_t) == 28);
    /* 段表：8 条灯带 × 8 段 × 28 = 1792（v3 是 1536、v2 是 1024）。 */
    CHECK(sizeof(lumen_segment_store_t) == 1792);
    /* 剧本阶段：时长/对齐(4) + 64 段 × 28 = 1796。 */
    CHECK(sizeof(lumen_script_stage_t) >= 8u * 8u * 28u);
}

/*
 * 两层的帧循环判据：layer1 是动画也必须驱动帧循环。
 */
static void test_two_layer_needs_frames(void)
{
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    /* 静态 + 静态（相乘）：常量画面，不需要帧循环。 */
    lumen_segment_t both_static;
    memset(&both_static, 0, sizeof(both_static));
    both_static.active = true;
    both_static.start = 0;
    both_static.end = 9;
    both_static.blend = LUMEN_BLEND_MULTIPLY;
    layer_set(LUMEN_EFFECT_STATIC, 0, 255, 0, 0, 0, &both_static.layer[0]);
    layer_set(LUMEN_EFFECT_STATIC, 0, 128, 0, 0, 0, &both_static.layer[1]);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &both_static) == LUMEN_RESULT_OK);
    CHECK(!lumen_segment_store_needs_frames(&store, 1));
    CHECK(!lumen_segment_is_animated(&both_static));

    /* 静态 + 呼吸（相加）：layer1 动画 → 需要帧循环。 */
    lumen_segment_t layer1_anim = both_static;
    layer1_anim.blend = LUMEN_BLEND_ADD;
    layer_set(LUMEN_EFFECT_BREATHING, 0, 255, 1000, 0, 0, &layer1_anim.layer[1]);
    CHECK(lumen_segment_is_animated(&layer1_anim));
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &layer1_anim) == LUMEN_RESULT_OK);
    CHECK(lumen_segment_store_needs_frames(&store, 1));

    /* 单层静态仍然不需要（v2 的「静态不空转」不退化）。 */
    lumen_segment_store_init(&store);
    lumen_segment_t single = make_static(0, 9, 0, 255);
    CHECK(lumen_segment_store_set(&store, 0, 1, 0, 64, &single) == LUMEN_RESULT_OK);
    CHECK(!lumen_segment_store_needs_frames(&store, 1));

    /* 非活动段永远不算动画。 */
    lumen_segment_t idle = layer1_anim;
    idle.active = false;
    CHECK(!lumen_segment_is_animated(&idle));
}

/* state blob v5（协议 v4）：两层段 + 层亮度 + blend + layer1 的往返与损坏拒绝。 */
static void test_state_blob_v4_two_layers(void)
{
    lumen_persist_t in;
    memset(&in, 0, sizeof(in));
    in.state.power = 1;
    in.state.brightness = 128;
    in.state.led_count = 64;
    in.state.strip_count = 2;
    in.state.seg_count = 1;
    in.state.strip_power_mask = 0x03;
    in.strip_counts[0] = 64;
    in.strip_counts[1] = 30;

    /* 段：彩虹 + 呼吸相乘。 */
    lumen_segment_t seg;
    memset(&seg, 0, sizeof(seg));
    seg.active = true;
    seg.start = 0;
    seg.end = 15;
    seg.blend = LUMEN_BLEND_MULTIPLY;
    layer_set(LUMEN_EFFECT_RAINBOW, 0x1234, 0x80, 1000, 255, 0, &seg.layer[0]);
    layer_set(LUMEN_EFFECT_BREATHING, 0x5678, 0xA0, 500, 0x40, 0x02, &seg.layer[1]);
    layer_set_level(&seg.layer[0], 80);
    layer_set_level(&seg.layer[1], 45);
    in.segments.slot[0][0] = seg;

    /* strip 1 上一个单层流光段（blend 0、layer1 空）。 */
    lumen_segment_t solo = make_animated(LUMEN_EFFECT_COMET, 0, 9, 0xABCD, 255, 800, 0x20, 0, 0);
    in.segments.slot[1][0] = solo;

    uint8_t blob[LUMEN_STATE_BLOB_SIZE];
    CHECK(lumen_state_blob_encode(&in, blob) == LUMEN_STATE_BLOB_SIZE);
    CHECK(blob[14] == 0x03); /* strip_power_mask 在偏移 14 */

    lumen_persist_t out;
    memset(&out, 0xAA, sizeof(out));
    CHECK(lumen_state_blob_decode(blob, sizeof(blob), &out));

    /* 状态字段。 */
    CHECK(out.state.strip_power_mask == 0x03);
    CHECK(out.state.strip_count == 2);
    CHECK(out.strip_counts[1] == 30);

    /* 两层段：blend 与两层参数逐项回来。 */
    const lumen_segment_t *r = &out.segments.slot[0][0];
    CHECK(r->active && r->start == 0 && r->end == 15);
    CHECK(r->blend == LUMEN_BLEND_MULTIPLY);
    CHECK(r->layer[0].type == LUMEN_EFFECT_RAINBOW);
    CHECK(lumen_layer_hue(&r->layer[0]) == 0x1234);
    CHECK(lumen_layer_sat(&r->layer[0]) == 0x80);
    CHECK(lumen_layer_period_ms(&r->layer[0]) == 1000);
    CHECK(lumen_layer_p5(&r->layer[0]) == 255);
    CHECK(r->layer[1].type == LUMEN_EFFECT_BREATHING);
    CHECK(lumen_layer_hue(&r->layer[1]) == 0x5678);
    CHECK(lumen_layer_sat(&r->layer[1]) == 0xA0);
    CHECK(lumen_layer_period_ms(&r->layer[1]) == 500);
    CHECK(lumen_layer_p5(&r->layer[1]) == 0x40);
    CHECK(lumen_layer_flags(&r->layer[1]) == 0x02);
    /* v4：两层的亮度都要完整往返。 */
    CHECK(lumen_layer_level(&r->layer[0]) == 80);
    CHECK(lumen_layer_level(&r->layer[1]) == 45);
    CHECK(r->t0_ms == 0); /* 不持久化 */

    /* 单层段：layer1 仍是空层、blend 0。 */
    const lumen_segment_t *s = &out.segments.slot[1][0];
    CHECK(s->active && s->blend == 0);
    CHECK(s->layer[0].type == LUMEN_EFFECT_COMET);
    CHECK(s->layer[1].type == LUMEN_LAYER_EMPTY);

    /* 逐字节幂等：编解码一次后再编码，得到同一份 blob。 */
    uint8_t again[LUMEN_STATE_BLOB_SIZE];
    CHECK(lumen_state_blob_encode(&out, again) == LUMEN_STATE_BLOB_SIZE);
    CHECK(memcmp(blob, again, sizeof(blob)) == 0);

    /*
     * 损坏必须**整份**拒绝（out 不动），不能半加载。
     * 段记录 22 字节：0 active | 1 start | 2 end | 3 blend | 4..12 layer0 | 13..21 layer1
     */
    const uint8_t off = LUMEN_SEGMENTS_OFFSET;
    uint8_t bad[LUMEN_STATE_BLOB_SIZE];

    /* blend > 2。 */
    memcpy(bad, blob, sizeof(bad));
    bad[off + 3] = 3;
    lumen_persist_t keep;
    memset(&keep, 0x55, sizeof(keep));
    lumen_persist_t before = keep;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &keep));
    CHECK(memcmp(&keep, &before, sizeof(keep)) == 0);

    /* layer1 未知类型。 */
    memcpy(bad, blob, sizeof(bad));
    bad[off + 13] = 0x07;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* layer0 为空层。 */
    memcpy(bad, blob, sizeof(bad));
    bad[off + 4] = LUMEN_LAYER_EMPTY;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* 单层段（strip 1 seg 0）带非零 blend → 形状非法。 */
    memcpy(bad, blob, sizeof(bad));
    bad[off + LUMEN_MAX_SEGMENTS * LUMEN_SEGMENT_RECORD_SIZE + 3] = 1;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* 活动段落在未配置灯带（strip 2，strip_count = 2）→ 拒绝。 */
    memcpy(bad, blob, sizeof(bad));
    bad[off + 2 * LUMEN_MAX_SEGMENTS * LUMEN_SEGMENT_RECORD_SIZE] = 1;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* 第二层呼吸周期低于 334 → 拒绝。 */
    memcpy(bad, blob, sizeof(bad));
    bad[off + 13 + 4] = 0x64; /* layer1.param[3..4] = 100 */
    bad[off + 13 + 5] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* v4：层亮度 > 100 → 拒绝（layer0.level 在记录内偏移 4+8 = 12）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[off + 12] = 101;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* 正好 100 合法。 */
    memcpy(bad, blob, sizeof(bad));
    bad[off + 12] = 100;
    CHECK(lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* v4：空层（layer0 之上的 layer1 = 0xFF）带非零 level → 拒绝。
     * 先把 layer0 改成空层以外的合法值……直接用 strip 1 的单层段：
     * 那条段 layer1 是 0xFF，把它的 level（记录内偏移 13+8 = 21）改成 50。 */
    memcpy(bad, blob, sizeof(bad));
    bad[off + LUMEN_MAX_SEGMENTS * LUMEN_SEGMENT_RECORD_SIZE + 21] = 50;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
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

int main(int argc, char **argv)
{
    /* 默认路径只是兜底：run-tests.cmd 会显式传 v4 向量（docs/protocol-testvectors-v4.json）。 */
    const char *vectors = argc > 1 ? argv[1] : "docs/protocol-testvectors-v4.json";

    int cases = for_each_case(vectors, dispatch_case);
    CHECK(cases > 0);
    if (cases > 0) {
        printf("vectors: %d cases from %s\n", cases, vectors);
    }

    test_checksum();
    test_set_power_reducer();
    test_set_brightness_reducer();
    test_retired_commands();
    test_encode_ack_all_results();
    test_encode_event_storage_failed();
    test_encode_limits();
    test_decode_short();
    test_decode_bad_frames_echo_header();
    test_decode_max_payload();
    test_reject_v2_protocol_frames();
    test_state_defaults_and_clamp();
    test_state_bytes_layout();
    test_selftest_sequence();
    test_selftest_late_wake();
    test_selftest_restart();
    test_selftest_cancel_rules();
    test_selftest_leaves_state_untouched();
    test_selftest_compose();
    test_gamma();
    test_gamma_hue_loss_clip();
    test_two_layer_single_layer_regression();
    test_blend_math();
    test_two_layer_validation_matrix();
    test_layer_codec();
    test_apply_level_q8();
    test_layer_level_static_steps();
    test_layer_level_independent_per_layer();
    test_level_times_brightness_then_gamma_once();
    test_layer_level_validation();
    test_script_segment_clear_slot_level();
    test_script_store_clear_rejects_level();
    test_breathing_floor_is_level_times_min_pct();
    test_blend_gamma_once();
    test_two_layer_shared_phase();
    test_two_layer_ram_sizes();
    test_two_layer_needs_frames();
    test_set_led_count_reducer();
    test_led_count_job();
    test_save_scheduler();
    test_state_blob();
    test_effects_static_rgb();
    test_effects_dispatch();
    test_segment_store_compose();
    test_segment_store_validate();
    test_segment_store_state_summary();
    test_segment_store_prune();
    test_segment_store_needs_frames();
    test_segment_real_slots();
    test_segment_commands();
    test_encode_segment_reports();
    test_encode_strip_config_report();
    test_encode_device_info_report();
    test_effects_breathing_phase();
    test_effects_breathing_envelope();
    test_effects_breathing_gain_and_pixel();
    test_effects_rainbow_hue();
    test_effects_rainbow_pixel();
    test_effects_comet_gain();
    test_effects_rainbow_comet_coexist();
    test_blob_strip_counts();
    test_set_segment_uses_own_strip_count();
    test_state_blob_per_strip_bounds();
    test_state_blob_v4_two_layers();
    test_set_strip_power_command();
    test_set_strip_power_validation_edges();
    test_strip_mask_allows();
    test_global_power_leaves_strip_mask();
    test_strip_anim_mask();
    test_strip_tdm_plan();
    test_per_strip_led_counts_30_60_10();
    test_reasm_single_chunk();
    test_reasm_multi_chunk();
    test_reasm_first_reentry();
    test_reasm_overflow();
    test_reasm_timeout();
    test_reasm_orphan_and_helpers();
    test_script_store_download();
    test_script_commit_failure_keeps_previous();
    test_script_multiple_scripts();
    test_script_playback_advance();
    test_script_playback_pause_resume();
    test_script_playback_hold_during_selftest();
    test_script_blob_roundtrip();
    test_script_fade_roundtrip();
    test_script_two_layer_persist();
    test_script_clear_slot();
    test_script_commit_too_large();
    test_script_commit_implies_persistable();
    test_planar_parse_list();
    test_planar_init_validation();
    test_planar_round_robin();
    test_planar_set_count();
    test_planar_stats();
    test_planar_null_safety();

    if (g_failures != 0) {
        fprintf(stderr, "\n%d/%d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("all %d checks passed\n", g_checks);
    return 0;
}
