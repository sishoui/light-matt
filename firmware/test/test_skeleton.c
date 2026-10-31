/*
 * Host 单元测试：不依赖 ESP-IDF，不连硬件。
 *
 * 主要覆盖：
 *   1. docs/protocol-testvectors.json 里的全部用例（两端共用的唯一向量文件）：
 *      - app_to_device 合法帧：解码字段与编码结果逐字节一致；
 *      - app_to_device 非法帧：解码失败原因 / 结果码与向量一致；
 *      - device_to_app 帧：解码，并用 ACK / Event / StateReport 编码器逐字节复现；
 *   2. SetPower / SetBrightness / SetLedCount reducer 的取值与状态语义
 *      （含亮度钳位、开关解耦、相同值不 commit），以及 v2 退役命令
 *      （0x03 / 0x04）与未实现命令的明确回退；
 *   3. state 默认值/钳位/14 字节布局与 gamma + 亮度乘算。
 *
 * 运行：firmware/test/run-tests.cmd（会把工作目录切到仓库根，再传向量路径）。
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "command.h"
#include "effects.h"
#include "gamma.h"
#include "led_count_job.h"
#include "protocol.h"
#include "save_scheduler.h"
#include "script_blob.h"
#include "script_store.h"
#include "segment_store.h"
#include "selftest.h"
#include "state.h"
#include "state_blob.h"
#include "strip_planar.h"

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
        uint8_t _expected[128];                                                        \
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
    uint8_t buf[256];
    size_t len = hex_to_bytes(hex, buf, sizeof(buf));
    if (len == (size_t)-1) {
        fprintf(stderr, "[FAIL] bad test hex: %s\n", hex);
        ++g_failures;
        return LUMEN_DECODE_SILENT;
    }
    return lumen_protocol_decode(buf, len, frame, result_code);
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
        lumen_segment_t seg = {
            .active = true,
            .start = (uint8_t)start,
            .end = (uint8_t)end,
            .type = LUMEN_EFFECT_STATIC,
            .hue = 0,
            .sat = 255,
            .period_ms = 0,
            .p5 = 0,
            .flags = 0,
            .t0_ms = 0,
        };
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

typedef struct {
    char name[80];
    char direction[24];
    char frame_hex[128];
    char payload_hex[64];
    char prior_segments[64]; /* 可选：段命令的前置段表，如 "0:0-15"（仅 host 测试用） */
    /*
     * 可选：#32 剧本命令的**设备侧前置状态**，形如
     *   "14:000401;15:0000E803;15:0100F401;17:00"
     * 每一项是 `命令字(十进制):载荷hex`，按顺序重放到一个本地剧本表上。
     * 这让「整份下发 → commit → 上一套是否还在」能被向量驱动，而不是只在
     * 下面的独立断言里覆盖。
     */
    char prior_script[512];
    int command;
    int seq;
    int result_code; /* -1 = 缺失或 null（静默丢弃） */
    /*
     * 可选：设备侧（引擎整份校验后）的最终结果码。命令层只做形状校验，
     * ScriptCommit 的越界 / 重叠 / 缺阶段只有引擎能判——两者不同时用这个
     * 字段钉住设备真实回的结果码。
     */
    int device_ack;
    /* 可选：本帧处理完后，script_id:stage_count 形式的前一套必须仍完好。 */
    char keep_script[32];
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
    char object[2048];
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
 * 这不是完整的引擎：它只做 §10.4 的下发流程（Begin → Stage → Segment → Commit），
 * 用来把一个用例的**设备侧前置状态**表达成向量数据。解析失败返回 false。
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
        char item[128];
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
            if (len != 4 || !lumen_script_stage(store, payload[0], payload[1], duration)) {
                return false;
            }
            break;
        }
        case LUMEN_CMD_SCRIPT_SEGMENT: {
            if (len < 7) {
                return false;
            }
            lumen_segment_t seg;
            memset(&seg, 0, sizeof(seg));
            seg.active = true;
            seg.start = payload[4];
            seg.end = payload[5];
            seg.type = payload[6];
            seg.hue = (uint16_t)(payload[7] | ((uint16_t)payload[8] << 8));
            seg.sat = payload[9];
            if (len > 10) {
                seg.period_ms = (uint16_t)(payload[10] | ((uint16_t)payload[11] << 8));
                seg.p5 = payload[12];
                seg.flags = payload[13];
            }
            if (!lumen_script_segment(store, payload[0], payload[1], payload[2], payload[3], &seg,
                                      NULL)) {
                return false;
            }
            break;
        }
        case LUMEN_CMD_SCRIPT_COMMIT: {
            uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};
            if (len != 1 || !lumen_script_commit(store, payload[0], counts)) {
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
                                  outcome->script_duration_ms)
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
        return lumen_script_commit(store, outcome->script_id, counts) ? LUMEN_RESULT_OK
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

static void run_app_case(const vector_case_t *c)
{
    lumen_frame_t frame;
    uint8_t result_code = 0xFF;
    lumen_decode_status_t status = decode_hex(c->frame_hex, &frame, &result_code);

    if (c->frame_valid) {
        CHECK(status == LUMEN_DECODE_OK);
        CHECK(result_code == LUMEN_RESULT_OK);
        if (c->command >= 0) {
            CHECK(frame.command == (uint8_t)c->command);
        }
        if (c->seq >= 0) {
            CHECK(frame.seq == (uint8_t)c->seq);
        }

        uint8_t expected_payload[LUMEN_MAX_PAYLOAD];
        size_t expected_len = hex_to_bytes(c->payload_hex, expected_payload,
                                           sizeof(expected_payload));
        CHECK(expected_len != (size_t)-1);
        CHECK(frame.payload_len == (uint8_t)expected_len);
        CHECK(memcmp(frame.payload, expected_payload, expected_len) == 0);

        /* 命令层：所有非法取值/长度/未知命令都不能改变状态。 */
        lumen_state_t before;
        lumen_state_defaults(&before, 30);
        lumen_command_outcome_t outcome;

        /*
         * 段命令用向量里的 prior_segments 构造前置段表（形如 "0:0-15"，
         * 分号分隔多条）。没有该字段就是空段表。这让「重叠 → InvalidParam」
         * 可以被向量驱动，而不是只在下面的独立断言里覆盖。
         */
        lumen_segment_store_t segments;
        apply_prior_segments(&segments, c->prior_segments);

        /*
         * #32：剧本命令前置状态。prior_script 用同一套纯模块重放
         * Begin/Stage/Segment/Commit，得到「上一套已提交剧本」。
         * 这让失败路径可以断言「旧剧本还在」，而不是只在别处单独测。
         */
        lumen_script_store_t scripts;
        CHECK(apply_prior_script(&scripts, c->prior_script));

        /* 向量不涉及构建期上限，按 255 跑 reducer。 */
        lumen_command_dispatch(&frame, &before, &segments, NULL, 255, &outcome);

        if (frame.command == LUMEN_CMD_SET_POWER) {
            /* SetPower 结果码必须与向量一致。 */
            CHECK(c->result_code >= 0);
            CHECK(outcome.result_code == (uint8_t)c->result_code);
            if (outcome.result_code == LUMEN_RESULT_OK) {
                CHECK(outcome.next.power == frame.payload[0]);
                CHECK(outcome.state_changed == (before.power != frame.payload[0]));
            } else {
                CHECK(!outcome.state_changed);
                CHECK(outcome.next.power == before.power);
            }
        } else if (frame.command == LUMEN_CMD_SET_BRIGHTNESS) {
            /* SetBrightness 同样实现语义：载荷在 0-255 内，不需要钳位。 */
            CHECK(c->result_code >= 0);
            CHECK(outcome.result_code == (uint8_t)c->result_code);
            CHECK(outcome.next.power == before.power);
            CHECK(outcome.next.brightness == frame.payload[0]);
            CHECK(outcome.state_changed == (before.brightness != frame.payload[0]));
        } else if (frame.command == LUMEN_CMD_SELF_TEST) {
            /* #13：SelfTest 立即回 0x00 并启动自检，但不改共享状态。 */
            CHECK(c->result_code >= 0);
            CHECK(outcome.result_code == (uint8_t)c->result_code);
            CHECK(outcome.start_selftest);
            CHECK(!outcome.cancels_selftest);
            CHECK(!outcome.state_changed);
            CHECK(outcome.next.power == before.power);
            CHECK(outcome.next.brightness == before.brightness);
            CHECK(outcome.next.r == before.r);
            CHECK(outcome.next.g == before.g);
            CHECK(outcome.next.b == before.b);
            CHECK(outcome.next.led_count == before.led_count);
        } else if (frame.command == LUMEN_CMD_SET_LED_COUNT) {
            /*
             * SetLedCount（#12）：合法取值只标记「需要重建」，不改 next、
             * state_changed 保持 false——数量要等渲染任务重建句柄成功后才写入
             * 共享状态（§11.3）。越界 → 0x01 且不请求重建。
             *
             * #13：合法取值同时必须取消自检（§11.2 第 5 条），即使
             * state_changed 为 false——这条断言是两票的接缝。
             */
            CHECK(c->result_code >= 0);
            CHECK(outcome.result_code == (uint8_t)c->result_code);
            /* v2 载荷：strip_id, count_lo, count_hi。 */
            uint16_t expected =
                (uint16_t)(frame.payload[1] | ((uint16_t)frame.payload[2] << 8));
            CHECK(!outcome.state_changed);
            CHECK(outcome.next.power == before.power);
            CHECK(outcome.next.brightness == before.brightness);
            CHECK(outcome.next.r == before.r);
            CHECK(outcome.next.g == before.g);
            CHECK(outcome.next.b == before.b);
            if (outcome.result_code == LUMEN_RESULT_OK) {
                CHECK(outcome.led_count_rebuild);
                CHECK(outcome.led_count == expected);
                CHECK(outcome.next.led_count == before.led_count);
                CHECK(outcome.cancels_selftest);
            } else {
                CHECK(!outcome.led_count_rebuild);
                CHECK(outcome.led_count == before.led_count);
                CHECK(!outcome.cancels_selftest);
            }
        } else if (frame.command == LUMEN_CMD_QUERY_STATE) {
            /* #6.1：QueryState 回 0x00 + 请求 StateReport，不改共享状态、
             * 不取消自检。结果码直接对向量断言——这里以前硬编码 0x02，
             * 导致向量里 query_state 的 result_code 从未被真正校验。 */
            CHECK(c->result_code >= 0);
            CHECK(outcome.result_code == (uint8_t)c->result_code);
            CHECK(outcome.result_code == LUMEN_RESULT_OK);
            CHECK(outcome.state_report);
            CHECK(!outcome.state_changed);
            CHECK(!outcome.cancels_selftest);
            CHECK(!outcome.led_count_rebuild);
            CHECK(outcome.next.power == before.power);
            CHECK(outcome.next.brightness == before.brightness);
            CHECK(outcome.next.r == before.r);
            CHECK(outcome.next.g == before.g);
            CHECK(outcome.next.b == before.b);
            CHECK(outcome.next.led_count == before.led_count);
        } else if (frame.command == LUMEN_CMD_SET_SEGMENT ||
                   frame.command == LUMEN_CMD_CLEAR_SEGMENT ||
                   frame.command == LUMEN_CMD_QUERY_STRIP) {
            /*
             * #25：段命令的结果码完全由向量断言（正常 / 重叠 / 越界 / 长度不符 /
             * 未知 type / 尚未实现的动画类型）。共享状态一律不变——段配置不在
             * lumen_state_t 里，摘要字段由 led_engine 写入后重算。
             */
            CHECK(c->result_code >= 0);
            CHECK(outcome.result_code == (uint8_t)c->result_code);
            CHECK(!outcome.state_changed);
            CHECK(!outcome.led_count_rebuild);
            CHECK(outcome.next.power == before.power);
            CHECK(outcome.next.brightness == before.brightness);
            CHECK(outcome.next.r == before.r);
            CHECK(outcome.next.g == before.g);
            CHECK(outcome.next.b == before.b);
            CHECK(outcome.next.led_count == before.led_count);

            if (frame.command == LUMEN_CMD_SET_SEGMENT &&
                outcome.result_code == LUMEN_RESULT_OK) {
                CHECK(outcome.segment_op);
                CHECK(!outcome.segment_clear);
                CHECK(outcome.segment.active);
                CHECK(outcome.segment.type == frame.payload[4]);
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
                /* 查询不取消自检（与 QueryState 同一条规则）。 */
                CHECK(!outcome.cancels_selftest);
            } else {
                /* 失败路径：不得产生任何写入意图，也不取消自检。 */
                CHECK(!outcome.segment_op);
                CHECK(!outcome.strip_query);
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
            /*
             * #32 剧本命令：命令层只做形状校验（id / 下标 / type / 长度 /
             * 时长非 0），真正的暂存 / 提交 / 激活在引擎里。所以这里断言
             * 结果码与向量一致、产生了正确类型的操作意图、共享状态不变。
             */
            CHECK(c->result_code >= 0);
            CHECK(outcome.result_code == (uint8_t)c->result_code);
            CHECK(!outcome.state_changed);
            CHECK(!outcome.led_count_rebuild);
            CHECK(outcome.next.power == before.power);
            CHECK(outcome.next.brightness == before.brightness);
            CHECK(outcome.next.led_count == before.led_count);

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
                    CHECK(outcome.script_segment.start == frame.payload[4]);
                    CHECK(outcome.script_segment.end == frame.payload[5]);
                    CHECK(outcome.script_segment.type == frame.payload[6]);
                    CHECK(outcome.script_segment.hue ==
                          (uint16_t)(frame.payload[7] | (frame.payload[8] << 8)));
                    CHECK(outcome.script_segment.sat == frame.payload[9]);
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
                /*
                 * 剧本命令全部属于「改变状态」类别，要取消自检（§10.6 第 5 条）；
                 * QueryScript 例外——查询不改状态，不取消自检。
                 */
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
             * 设备侧（引擎整份校验）的结果码。命令层只判形状，ScriptCommit
             * 的缺阶段 / 越界 / 重叠只有引擎能判，所以有 device_ack 时以它为准。
             *
             * 命令层已拒的帧根本到不了引擎（ble_link 只在 result_code == OK
             * 时调用引擎），所以这里只在命令层放行时比较。
             */
            if (outcome.result_code == LUMEN_RESULT_OK) {
                uint8_t engine_result = apply_script_op(&scripts, &outcome);
                if (c->device_ack >= 0) {
                    CHECK(engine_result == (uint8_t)c->device_ack);
                } else {
                    CHECK(engine_result == outcome.result_code);
                }
            }

            /*
             * 失败回滚的向量级证据：本帧处理完后，keep_script 指定的那套
             * 剧本必须仍然存在且阶段数不变。
             */
            uint8_t keep_id = 0;
            uint8_t keep_count = 0;
            if (parse_keep_script(c->keep_script, &keep_id, &keep_count)) {
                CHECK(lumen_script_is_committed(&scripts, keep_id));
                CHECK(lumen_script_stage_count(&scripts, keep_id) == keep_count);
            }
        } else {
            /* 已知命令的兜底：结果码必须与向量一致，状态一律不变。
             * 保留命令 / 未知命令同理。 */
            CHECK(outcome.result_code == (uint8_t)c->result_code);
            CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
            CHECK(!outcome.state_changed);
            CHECK(!outcome.led_count_rebuild);
            CHECK(!outcome.state_report);
            CHECK(outcome.next.power == before.power);
            CHECK(outcome.next.brightness == before.brightness);
            CHECK(outcome.next.r == before.r);
            CHECK(outcome.next.g == before.g);
            CHECK(outcome.next.b == before.b);
            CHECK(outcome.next.led_count == before.led_count);
        }
    } else {
        if (c->result_code < 0) {
            /* short_frame：静默丢弃 */
            CHECK(status == LUMEN_DECODE_SILENT);
        } else {
            CHECK(status == LUMEN_DECODE_ERROR);
            CHECK(result_code == (uint8_t)c->result_code);
        }
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

    /* 设备→小程序帧必须能用同一个编码器逐字节复现（ACK / Event / StateReport）。 */
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
    default:
        /* SegmentReport / SegmentListEnd / ScriptSummary / ScriptProgress：
         * 由 #25 / #32 提供专用编码器，这里用通用编码器验证信封逐字节一致。 */
        CHECK(frame.payload_len <= LUMEN_MAX_PAYLOAD);
        len = lumen_protocol_encode(frame.command, frame.seq, frame.payload,
                                    frame.payload_len, out, sizeof(out));
        break;
    }
    CHECK(len == expected_len + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, c->frame_hex, len);
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
}

/* ---------------- 独立断言 ---------------- */

static void test_checksum(void)
{
    /* 协议 §3 例子：A5 02 01 01 01 01 → 0x54。 */
    const uint8_t data[] = {0xA5, 0x02, 0x01, 0x01, 0x01, 0x01};
    CHECK(lumen_protocol_checksum(data, sizeof(data)) == 0x54);

    const uint8_t empty[] = {0x00};
    CHECK(lumen_protocol_checksum(empty, 0) == 0xFF);
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
     * #25 起 0x10 / 0x11 / 0x12 已实现，#32 起 0x13–0x1A 也已实现，
     * 都不再属于未知命令。 */
    const uint8_t unknown[] = {0x00, 0x03, 0x04, 0x08, 0x09, 0x0F, 0x1B, 0x7F,
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

    /* #32 剧本命令已实现：不能再出现在「未知命令」列表里，
     * 但空载荷仍应回 BadLength（长度校验先于取值）。0x1B 起仍是保留字。 */
    const uint8_t implemented[] = {LUMEN_CMD_SET_PLAYBACK, LUMEN_CMD_SCRIPT_BEGIN,
                                   LUMEN_CMD_SCRIPT_STAGE, LUMEN_CMD_SCRIPT_SEGMENT,
                                   LUMEN_CMD_SCRIPT_COMMIT, LUMEN_CMD_SCRIPT_ABORT,
                                   LUMEN_CMD_ACTIVATE_SCRIPT, LUMEN_CMD_QUERY_SCRIPT};
    for (size_t i = 0; i < sizeof(implemented); ++i) {
        CHECK(lumen_command_is_known(implemented[i]));
        lumen_frame_t f = {0};
        f.command = implemented[i];
        f.payload_len = 0;
        lumen_command_dispatch(&f, &state, NULL, NULL, 255, &outcome);
        /* ScriptSegment 载荷 < 7 也是 BadLength；其余命令期望长度 > 0。 */
        CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
        CHECK(!outcome.state_changed);
        CHECK(outcome.script_op == LUMEN_SCRIPT_OP_NONE);
    }

    /* 0x1B 起的保留字仍回 0x02。 */
    const uint8_t reserved[] = {0x1B, 0x20, 0x7F};
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
    for (uint8_t result = 0; result <= LUMEN_RESULT_INTERNAL_ERROR; ++result) {
        uint8_t out[LUMEN_MAX_FRAME];
        size_t len =
            lumen_protocol_encode_ack(0x5A, LUMEN_CMD_SET_POWER, result, out, sizeof(out));
        CHECK(len == 8);
        CHECK(out[0] == LUMEN_MAGIC);
        CHECK(out[1] == LUMEN_VERSION);
        CHECK(out[2] == LUMEN_CMD_ACK);
        CHECK(out[3] == 0x5A);
        CHECK(out[4] == 2);
        CHECK(out[5] == LUMEN_CMD_SET_POWER);
        CHECK(out[6] == result);
        CHECK(out[7] == lumen_protocol_checksum(out, 7));
    }

    /* 缓冲不足必须失败，不能截断 */
    uint8_t out[LUMEN_MAX_FRAME];
    CHECK(lumen_protocol_encode_ack(0x03, 0x02, LUMEN_RESULT_OK, out, 7) == 0);
}

static void test_encode_event_storage_failed(void)
{
    /* §10.3：NVS 写失败用 Event 0x81 上报，载荷 [0x01, 原命令字]，seq 固定 0。
     * 与向量 event_storage_failed 逐字节一致（detail = SetLedCount 0x06）。 */
    uint8_t out[LUMEN_MAX_FRAME];
    size_t len =
        lumen_protocol_encode_event(LUMEN_EVENT_STORAGE_FAILED, 0x06, out, sizeof(out));
    CHECK(len == 8);
    CHECK(len == 2 + LUMEN_FRAME_OVERHEAD);
    CHECK(out[0] == 0xA5);
    CHECK(out[1] == 0x02);
    CHECK(out[2] == 0x81);
    CHECK(out[3] == 0x00);
    CHECK(out[4] == 2);
    CHECK(out[5] == LUMEN_EVENT_STORAGE_FAILED);
    CHECK(out[6] == 0x06);
    CHECK(out[7] == 0xCE);
    CHECK_BYTES(out, "A5028100020106CE", len);

    /* seq 不随连接序号变化：换 detail 也应始终是 0x00。 */
    len = lumen_protocol_encode_event(LUMEN_EVENT_STORAGE_FAILED, 0x01, out, sizeof(out));
    CHECK(len == 8);
    CHECK(out[3] == 0x00);
    CHECK(out[6] == 0x01);

    /*
     * #12 补充：每个可能触发持久化的命令字都能编出来，detail 原样透传，
     * 且编出来的帧能用同一信封解回（两端共用一份契约）。
     */
    /* v2 的 0x03 / 0x04 已退役，不再触发持久化；这里只覆盖仍然存在的命令。 */
    const uint8_t commands[] = {LUMEN_CMD_SET_POWER, LUMEN_CMD_SET_BRIGHTNESS,
                                LUMEN_CMD_SET_LED_COUNT};
    for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); ++i) {
        uint8_t frame[LUMEN_MAX_FRAME];
        size_t n = lumen_protocol_encode_event(LUMEN_EVENT_STORAGE_FAILED, commands[i], frame,
                                               sizeof(frame));
        CHECK(n == 8);
        CHECK(frame[3] == 0x00); /* seq 固定 0 */
        CHECK(frame[5] == LUMEN_EVENT_STORAGE_FAILED);
        CHECK(frame[6] == commands[i]);
        CHECK(frame[7] == lumen_protocol_checksum(frame, 7));

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
                                      7) == 0);
}

static void test_encode_limits(void)
{
    uint8_t payload[15] = {0};
    uint8_t out[32];

    CHECK(lumen_protocol_encode(0x08, 0x01, payload, 15, out, sizeof(out)) == 0);
    CHECK(lumen_protocol_encode(0x08, 0x01, payload, 14, out, 19) == 0);
    CHECK(lumen_protocol_encode(0x08, 0x01, payload, 14, out, 20) == 20);
    CHECK(lumen_protocol_encode(0x08, 0x01, payload, 0, NULL, 20) == 0);
}

static void test_decode_short(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;

    /* 不足 6 字节：连 seq 都读不可靠，静默丢弃 */
    CHECK(decode_hex("A502010101", &frame, &rc) == LUMEN_DECODE_SILENT);
    CHECK(decode_hex("", &frame, &rc) == LUMEN_DECODE_SILENT);
    CHECK(lumen_protocol_decode(NULL, 0, &frame, &rc) == LUMEN_DECODE_SILENT);
}

static void test_decode_bad_frames_echo_header(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;

    /* 坏帧也要保留 header，供 ACK 回显 seq / 命令字 */
    CHECK(decode_hex("A6020101010153", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_MAGIC);
    CHECK(frame.command == 0x01);
    CHECK(frame.seq == 0x01);

    /* version 0x01（v1）现在是不支持的版本 → 0x07。 */
    CHECK(decode_hex("A5010101010155", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_UNSUPPORTED_VERSION);

    CHECK(decode_hex("A5020101010155", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_CHECKSUM);
}

static void test_decode_max_payload(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;
    lumen_decode_status_t status =
        decode_hex("A5027F050E000102030405060708090A0B0C0D6B", &frame, &rc);

    CHECK(status == LUMEN_DECODE_OK);
    CHECK(rc == LUMEN_RESULT_OK);
    CHECK(frame.command == 0x7F);
    CHECK(frame.seq == 0x05);
    CHECK(frame.payload_len == 14);
    for (uint8_t i = 0; i < 14; ++i) {
        CHECK(frame.payload[i] == i);
    }
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

    CHECK(lumen_state_clamp_brightness(200, 180) == 180);
    CHECK(lumen_state_clamp_brightness(100, 180) == 100);
    CHECK(lumen_state_clamp_brightness(255, 255) == 255);
    CHECK(lumen_state_clamp_brightness(0, 255) == 0);
}

static void test_state_bytes_layout(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 1;

    /* v2：State 固定 14 字节；0-7 与 v1 完全一致。 */
    uint8_t out[LUMEN_STATE_BYTES];
    lumen_state_to_bytes(&state, 255, out);
    /* 与 docs/protocol-testvectors.json 的 state_read_example_hex 一致 */
    CHECK_BYTES(out, "0180FFB4781E00FF0100FF000000", sizeof(out));

    state.brightness = 250;
    lumen_state_to_bytes(&state, 200, out);
    CHECK(out[1] == 200);
    CHECK(out[7] == 200);

    state.led_count = 300;
    lumen_state_to_bytes(&state, 255, out);
    CHECK(out[5] == 0x2C);
    CHECK(out[6] == 0x01);

    /* 8-13：strip_count / seg_count / script_id / stage_index /
     * playback_state / flags，默认值来自 lumen_state_defaults。 */
    lumen_state_defaults(&state, 30);
    CHECK(state.strip_count == 1);
    CHECK(state.seg_count == 0);
    CHECK(state.script_id == LUMEN_NO_SCRIPT);
    CHECK(state.stage_index == 0);
    CHECK(state.playback_state == 0);
    CHECK(state.flags == 0);

    state.strip_count = 8;
    state.seg_count = 3;
    state.script_id = 2;
    state.stage_index = 5;
    state.playback_state = 2;
    state.flags = 0x03;
    lumen_state_to_bytes(&state, 255, out);
    CHECK(out[8] == 8);
    CHECK(out[9] == 3);
    CHECK(out[10] == 2);
    CHECK(out[11] == 5);
    CHECK(out[12] == 2);
    CHECK(out[13] == 0x03);

    /* 前 8 字节不因新增字段而改变布局。 */
    CHECK(out[0] == 0 && out[5] == 30 && out[6] == 0 && out[7] == 255);

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
    lumen_state_to_bytes(&state, 255, before);

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
    lumen_state_to_bytes(&state, 255, during);
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

    lumen_segment_t seg0 = {
        .active = true, .start = 0, .end = 15, .type = LUMEN_EFFECT_STATIC,
        .hue = 0x1234, .sat = 200, .period_ms = 0, .p5 = 0, .flags = 0, .t0_ms = 999,
    };
    lumen_segment_t seg1 = {
        .active = true, .start = 40, .end = 63, .type = LUMEN_EFFECT_STATIC,
        .hue = 0xABCD, .sat = 255, .period_ms = 0, .p5 = 0, .flags = 0, .t0_ms = 12345,
    };
    in.segments.slot[0][0] = seg0;
    in.segments.slot[0][1] = seg1;

    uint8_t blob[LUMEN_STATE_BLOB_SIZE];
    CHECK(lumen_state_blob_encode(&in, blob) == LUMEN_STATE_BLOB_SIZE);
    /* 显式布局：magic 0..3、version 4..5、power 6、brightness 7、rgb 8..10、
     * led_count 11..12（小端）、strip_count 13、seg_count 14。 */
    CHECK(blob[0] == 'L' && blob[1] == 'M' && blob[2] == 'E' && blob[3] == 'N');
    CHECK(blob[4] == (LUMEN_STATE_BLOB_VERSION & 0xFF));
    CHECK(blob[5] == (LUMEN_STATE_BLOB_VERSION >> 8));
    CHECK(LUMEN_STATE_BLOB_VERSION == 3); /* v2 → v3：加了每条灯带的灯珠数 */
    CHECK(blob[6] == 1);
    CHECK(blob[7] == 200);
    CHECK(blob[8] == 1 && blob[9] == 2 && blob[10] == 3);
    CHECK(blob[11] == 64 && blob[12] == 0);
    CHECK(blob[13] == 1 && blob[14] == 2);

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
    CHECK(out.segments.slot[0][0].hue == 0x1234);
    CHECK(out.segments.slot[0][0].sat == 200);
    CHECK(out.segments.slot[0][1].active);
    CHECK(out.segments.slot[0][1].start == 40 && out.segments.slot[0][1].end == 63);
    CHECK(out.segments.slot[0][1].hue == 0xABCD);
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

    /* 4. 坏 version（v1 现在必须拒绝：布局不兼容）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[4] = 0x01;
    bad[5] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[4] = 0x04; /* 比当前版本更高：同样必须拒绝 */
    bad[5] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* 只有高字节错位的伪版本也拒绝。 */
    memcpy(bad, blob, sizeof(bad));
    bad[5] = 0x01;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

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
     *    d) 同灯带内重叠。 */
    const uint8_t seg_off = LUMEN_SEGMENTS_OFFSET; /* 段表偏移随布局走，不硬编码 */
    /* a) 把 seg 0 的 end 改成 64（led_count=64 → 越界）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[seg_off + 2] = 64;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* b) seg_count 说 3 但段表只有 2 个活动段。 */
    memcpy(bad, blob, sizeof(bad));
    bad[14] = 3;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* c) 未知 type 0x07。 */
    memcpy(bad, blob, sizeof(bad));
    bad[seg_off + 3] = 0x07;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* d) 把 seg 1 挪到 [10-20]，与 seg 0 的 [0-15] 重叠。 */
    memcpy(bad, blob, sizeof(bad));
    bad[seg_off + LUMEN_SEGMENT_RECORD_SIZE + 1] = 10;
    bad[seg_off + LUMEN_SEGMENT_RECORD_SIZE + 2] = 20;
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

    lumen_segment_t seg = {
        .active = true, .start = 10, .end = 19, .type = LUMEN_EFFECT_STATIC,
        .hue = 0, .sat = 255,
    };
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
    unknown.type = 0x7F;
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
    lumen_segment_t seg;
    memset(&seg, 0, sizeof(seg));
    seg.active = true;
    seg.start = start;
    seg.end = end;
    seg.type = LUMEN_EFFECT_STATIC;
    seg.hue = hue;
    seg.sat = sat;
    return seg;
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
    CHECK(lumen_segment_store_get(&store, 0, 0)->hue == 43690);

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
    flagged.flags = 0x01;
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
    breathing.type = LUMEN_EFFECT_BREATHING;
    breathing.period_ms = 1000;
    CHECK(lumen_segment_store_validate(&fresh, 0, 1, 5, led_count, &breathing) ==
          LUMEN_RESULT_OK);

    lumen_segment_t rainbow = make_static(0, 4, 0, 255);
    rainbow.type = LUMEN_EFFECT_RAINBOW;
    rainbow.period_ms = 500;
    CHECK(lumen_segment_store_validate(&fresh, 0, 1, 5, led_count, &rainbow) ==
          LUMEN_RESULT_OK);

    lumen_segment_t comet = make_static(0, 4, 0, 255);
    comet.type = LUMEN_EFFECT_COMET;
    comet.period_ms = 500;
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
    lumen_segment_t seg = {
        .active = true, .start = 0, .end = 9, .type = LUMEN_EFFECT_BREATHING,
        .hue = 0, .sat = 255, .period_ms = 1000, .p5 = 0, .flags = 0, .t0_ms = 0,
    };
    uint8_t rgb[3];
    lumen_effect_pixel(&seg, 5, 0, rgb);
    CHECK(rgb[0] == 0 && rgb[1] == 0 && rgb[2] == 0);
    lumen_effect_pixel(&seg, 5, 500, rgb); /* 峰值 */
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0);

    /* min_level 大 → 谷底仍很亮（几乎不呼吸）。 */
    seg.p5 = 200;
    lumen_effect_pixel(&seg, 5, 0, rgb);
    CHECK(rgb[0] >= 195 && rgb[0] <= 205);

    /* 波形切换真的改变输出（肉眼可分辨的前提）：锯齿在中点约半亮。 */
    seg.p5 = 0;
    seg.flags = (uint8_t)(LUMEN_WAVE_SAWTOOTH << 1);
    lumen_effect_pixel(&seg, 5, 250, rgb); /* 1/4 周期 */
    CHECK(rgb[0] >= 60 && rgb[0] <= 70);   /* 0.25 × 255 ≈ 64 */

    /* 正弦在 1/4 周期约半亮（与锯齿不同）。 */
    seg.flags = (uint8_t)(LUMEN_WAVE_SINE << 1);
    lumen_effect_pixel(&seg, 5, 250, rgb);
    CHECK(rgb[0] >= 120 && rgb[0] <= 135);

    /* 三角在 1/4 周期约半亮；方波在 1/4 周期满亮。 */
    seg.flags = (uint8_t)(LUMEN_WAVE_TRIANGLE << 1);
    lumen_effect_pixel(&seg, 5, 250, rgb);
    CHECK(rgb[0] >= 120 && rgb[0] <= 135);
    seg.flags = (uint8_t)(LUMEN_WAVE_SQUARE << 1);
    lumen_effect_pixel(&seg, 5, 250, rgb);
    CHECK(rgb[0] == 255);

    /* flag bit0（reverse）不影响呼吸输出（保留位，无实际意义）。 */
    seg.flags = (uint8_t)((LUMEN_WAVE_SINE << 1) | 0x01);
    uint8_t rgb_rev[3];
    seg.flags = (uint8_t)(LUMEN_WAVE_SINE << 1);
    lumen_effect_pixel(&seg, 5, 125, rgb);
    seg.flags = (uint8_t)((LUMEN_WAVE_SINE << 1) | 0x01);
    lumen_effect_pixel(&seg, 5, 125, rgb_rev);
    CHECK(memcmp(rgb, rgb_rev, 3) == 0);

    /*
     * 一段呼吸 + 一段静态共存：合成后静态段不随时间变，呼吸段随时间变。
     * 这是 ticket「一段呼吸 + 一段静态，互不干扰」的 host 证据。
     */
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);
    lumen_segment_t b = {
        .active = true, .start = 0, .end = 9, .type = LUMEN_EFFECT_BREATHING,
        .hue = 0, .sat = 255, .period_ms = 1000, .p5 = 0, .flags = 0, .t0_ms = 0,
    };
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
    lumen_segment_t seg;
    memset(&seg, 0, sizeof(seg));
    seg.active = true;
    seg.start = start;
    seg.end = end;
    seg.type = type;
    seg.hue = hue;
    seg.sat = sat;
    seg.period_ms = period_ms;
    seg.p5 = p5;
    seg.flags = flags;
    seg.t0_ms = t0_ms;
    return seg;
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
    flat.hue = 40000;
    CHECK(lumen_effect_rainbow_hue(&flat, 9, 250) == 56384);
    /* 基准 hue 靠近满圈时正确回绕到小值（不是负数/错色）。 */
    flat.hue = 60000;
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
    full.sat = 0;
    for (uint16_t i = 0; i < 16; ++i) {
        lumen_effect_pixel(&full, i, 0, first);
        CHECK(first[0] == 255 && first[1] == 255 && first[2] == 255);
    }

    /* 时间推进让同一颗灯换色（动画真的在走）。 */
    full.sat = 255;
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
    breath.type = LUMEN_EFFECT_BREATHING;
    breath.period_ms = 1000;
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

static void test_segment_commands(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);

    lumen_segment_store_t segments;
    lumen_segment_store_init(&segments);

    lumen_command_outcome_t outcome;
    lumen_frame_t frame = {0};

    /* 命令表：三条都已实现，载荷长度固定/变长分别正确。 */
    CHECK(lumen_command_is_known(LUMEN_CMD_SET_SEGMENT));
    CHECK(lumen_command_is_known(LUMEN_CMD_CLEAR_SEGMENT));
    CHECK(lumen_command_is_known(LUMEN_CMD_QUERY_STRIP));
    CHECK(lumen_command_changes_state(LUMEN_CMD_SET_SEGMENT));
    CHECK(lumen_command_changes_state(LUMEN_CMD_CLEAR_SEGMENT));
    CHECK(!lumen_command_changes_state(LUMEN_CMD_QUERY_STRIP));
    CHECK(lumen_command_payload_len(LUMEN_CMD_CLEAR_SEGMENT) == 2);
    CHECK(lumen_command_payload_len(LUMEN_CMD_QUERY_STRIP) == 1);

    /* 静态段：strip 0 seg 0 [0-9] hue=0 sat=255 → OK。 */
    frame.command = LUMEN_CMD_SET_SEGMENT;
    frame.seq = 41;
    frame.payload_len = 8;
    frame.payload[0] = 0;    /* strip */
    frame.payload[1] = 0;    /* seg */
    frame.payload[2] = 0;    /* start */
    frame.payload[3] = 9;    /* end */
    frame.payload[4] = 0x00; /* type static */
    frame.payload[5] = 0x00; /* hue lo */
    frame.payload[6] = 0x00; /* hue hi */
    frame.payload[7] = 0xFF; /* sat */
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment_op);
    CHECK(!outcome.segment_clear);
    CHECK(outcome.cancels_selftest);
    CHECK(!outcome.state_changed); /* 段配置不在 State 里 */
    CHECK(outcome.segment.start == 0 && outcome.segment.end == 9);
    CHECK(outcome.segment.hue == 0 && outcome.segment.sat == 255);

    /* 把它真正写进段表（模拟引擎），后续重叠校验才有前置状态。 */
    CHECK(lumen_segment_store_set(&segments, 0, 1, 0, 30, &outcome.segment) == LUMEN_RESULT_OK);

    /* 重叠段 [5-12] → InvalidParam，旧配置不变。 */
    frame.seq = 42;
    frame.payload[1] = 1;
    frame.payload[2] = 5;
    frame.payload[3] = 12;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);
    CHECK(!outcome.cancels_selftest);
    CHECK(lumen_segment_store_count(&segments, 0) == 1);
    CHECK(lumen_segment_store_get(&segments, 0, 1)->start == 0);

    /* 越界 end >= led_count（30）→ InvalidParam。 */
    frame.seq = 43;
    frame.payload[1] = 1;
    frame.payload[2] = 10;
    frame.payload[3] = 30;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);

    /* 正常第二段 [10-19]。 */
    frame.seq = 44;
    frame.payload[2] = 10;
    frame.payload[3] = 19;
    frame.payload[5] = 0x55;
    frame.payload[6] = 0x55; /* hue = 0x5555 */
    frame.payload[7] = 128;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment.hue == 0x5555);
    CHECK(outcome.segment.sat == 128);

    /* 类型校验顺序（§11.3 第 4 步先于长度）：
     * type=0x07（未知）+ 8 字节 → InvalidParam，不是 BadLength。 */
    frame.command = LUMEN_CMD_SET_SEGMENT;
    frame.payload_len = 8;
    frame.payload[4] = 0x07;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* type 已知但长度不符 → BadLength。 */
    frame.payload[4] = 0x00;
    frame.payload_len = 7;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);

    /* #30：呼吸（已知且已实现）→ OK，参数被完整解析到 outcome.segment。
     * 载荷 12 字节：strip seg start end type hue_lo hue_hi sat period_lo period_hi p5 flags。 */
    frame.payload_len = 12;
    frame.payload[4] = 0x01; /* breathing */
    frame.payload[5] = 0x10;
    frame.payload[6] = 0x0E; /* hue = 0x0E10 */
    frame.payload[7] = 0xFF; /* sat */
    frame.payload[8] = 0xF4;
    frame.payload[9] = 0x01; /* period = 0x01F4 = 500ms */
    frame.payload[10] = 0x60; /* min_level = 96 */
    frame.payload[11] = 0x00; /* flags: waveform 0 (sine) */
    frame.payload[2] = 20;
    frame.payload[3] = 25;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment_op);
    CHECK(outcome.segment.type == LUMEN_EFFECT_BREATHING);
    CHECK(outcome.segment.period_ms == 0x01F4);
    CHECK(outcome.segment.p5 == 0x60);
    CHECK(outcome.segment.flags == 0);

    /* 周期低于 3Hz 下限（334ms）→ InvalidParam，不产生写入意图。 */
    frame.payload[8] = 0x4D; /* 333 */
    frame.payload[9] = 0x01;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);
    /* 正好 334 是合法下限。 */
    frame.payload[8] = 0x4E; /* 334 */
    frame.payload[9] = 0x01;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    /* period = 0（静止）不受下限约束。 */
    frame.payload[8] = 0x00;
    frame.payload[9] = 0x00;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);

    /* flags 保留位（bit3-7）必须为 0。 */
    frame.payload[8] = 0xF4;
    frame.payload[9] = 0x01;
    frame.payload[11] = 0x08; /* bit3 置位 */
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);
    /* bit0 reverse 与 bit1-2 waveform 是允许的。 */
    frame.payload[11] = 0x07; /* reverse + waveform 3 */
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment.flags == 0x07);

    /*
     * 彩虹 / 流光（#31）：已实现，合法周期 → OK，写入意图带正确 type。
     * 用 300ms（高于 200 的 5Hz 下限、低于呼吸的 334）证明这两类的下限
     * 确实按类型区分，而不是沿用呼吸的 334。
     */
    frame.payload_len = 12;
    frame.payload[8] = 0x2C; /* 300 */
    frame.payload[9] = 0x01;
    frame.payload[10] = 0xFF; /* span / tail = 255（边界值） */
    frame.payload[11] = 0x00;
    frame.payload[4] = 0x02;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment_op);
    CHECK(outcome.segment.type == LUMEN_EFFECT_RAINBOW);
    frame.payload[4] = 0x03;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment.type == LUMEN_EFFECT_COMET);

    /* 彩虹 / 流光：period 199 < 200 → InvalidParam（5Hz 下限）。 */
    frame.payload[8] = 0xC7; /* 199 */
    frame.payload[9] = 0x00;
    frame.payload[4] = 0x02;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);
    /* 正好 200 是合法下限。 */
    frame.payload[8] = 0xC8;
    frame.payload[9] = 0x00;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);

    /* 彩虹 / 流光：bit1-7 保留（比呼吸更严，bit0 reverse 允许）。 */
    frame.payload[11] = 0x02; /* bit1 置位 */
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.segment_op);
    frame.payload[11] = 0x01; /* 只有 reverse */
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.segment.flags == 0x01);

    /* 静态段却给了 12 字节载荷：先读 type 再定长 → BadLength。 */
    frame.payload[4] = 0x00;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);

    /* strip_id != 0 → InvalidParam（多灯带 #29）。 */
    frame.payload_len = 8;
    frame.payload[0] = 1;
    lumen_command_dispatch(&frame, &state, &segments, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);

    /* seg_id 越界（8）→ InvalidParam。 */
    frame.payload[0] = 0;
    frame.payload[1] = 8;
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
    frame.payload_len = 8;
    frame.payload[0] = 0;
    frame.payload[1] = 0;
    frame.payload[2] = 0;
    frame.payload[3] = 29;
    frame.payload[4] = 0x00;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    frame.payload[3] = 30;
    lumen_command_dispatch(&frame, &state, NULL, NULL, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
}

/* ---------------- #25：SegmentReport / SegmentListEnd 编码 ---------------- */

static void test_encode_segment_reports(void)
{
    /* 与 docs/protocol-testvectors.json 的 segment_report_static 逐字节一致。 */
    uint8_t params[3] = {0x00, 0x00, 0xFF};
    uint8_t out[LUMEN_MAX_FRAME];
    size_t len = lumen_protocol_encode_segment_report(0x1D, 0x00, 0x00, 0x00, 0x1D, 0x00,
                                                      params, 3, out, sizeof(out));
    CHECK(len == 8 + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, "A502831D080000001D000000FF94", len);

    /* 呼吸用例 12B 载荷：params 7 字节。 */
    uint8_t anim[7] = {0x10, 0x0E, 0xFF, 0xF4, 0x01, 0x60, 0x00};
    len = lumen_protocol_encode_segment_report(0x1D, 0x00, 0x01, 0x00, 0x09, 0x01, anim, 7, out,
                                               sizeof(out));
    CHECK(len == 12 + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, "A502831D0C0001000901100EFFF40160002F", len);

    /* SegmentListEnd：载荷 [strip_id, seg_mask]。 */
    len = lumen_protocol_encode_segment_list_end(0x1D, 0x00, 0x07, out, sizeof(out));
    CHECK(len == 2 + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, "A502841D020007AE", len);

    /* 参数防御：0 长度 / 超过 7 / NULL params / 缓冲不足。 */
    CHECK(lumen_protocol_encode_segment_report(1, 0, 0, 0, 1, 0, params, 0, out, sizeof(out)) ==
          0);
    CHECK(lumen_protocol_encode_segment_report(1, 0, 0, 0, 1, 0, params, 8, out, sizeof(out)) ==
          0);
    CHECK(lumen_protocol_encode_segment_report(1, 0, 0, 0, 1, 0, NULL, 3, out, sizeof(out)) ==
          0);
    CHECK(lumen_protocol_encode_segment_report(1, 0, 0, 0, 1, 0, anim, 7, out, 17) == 0);
    CHECK(lumen_protocol_encode_segment_list_end(1, 0, 0x07, out, 7) == 0);
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
static void test_set_segment_uses_own_strip_count(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 64);
    state.strip_count = 8;
    state.led_count = 64; /* strip 0 */

    uint16_t strip_counts[LUMEN_MAX_STRIPS] = {64, 30, 30, 10, 30, 30, 30, 30};
    lumen_segment_store_t store;
    lumen_segment_store_init(&store);

    /* 静态段 [0-40] 打到 strip 3（只有 10 灯）→ 越界，必须拒绝。 */
    {
        lumen_frame_t f;
        f.command = LUMEN_CMD_SET_SEGMENT;
        f.seq = 1;
        f.payload_len = 8;
        f.payload[0] = 3; /* strip_id */
        f.payload[1] = 0; /* seg_id */
        f.payload[2] = 0; /* start */
        f.payload[3] = 40; /* end：>= 10 → 越界 */
        f.payload[4] = LUMEN_EFFECT_STATIC;
        f.payload[5] = 0x00;
        f.payload[6] = 0x00;
        f.payload[7] = 255;
        lumen_command_outcome_t out;
        lumen_command_dispatch(&f, &state, &store, strip_counts, 255, &out);
        CHECK(out.result_code == LUMEN_RESULT_INVALID_PARAM);
    }

    /* 同一帧打到 strip 0（64 灯）→ 合法。证明差异确实来自 per-strip 表。 */
    {
        lumen_frame_t f;
        f.command = LUMEN_CMD_SET_SEGMENT;
        f.seq = 2;
        f.payload_len = 8;
        f.payload[0] = 0;
        f.payload[1] = 0;
        f.payload[2] = 0;
        f.payload[3] = 40;
        f.payload[4] = LUMEN_EFFECT_STATIC;
        f.payload[5] = 0x00;
        f.payload[6] = 0x00;
        f.payload[7] = 255;
        lumen_command_outcome_t out;
        lumen_command_dispatch(&f, &state, &store, strip_counts, 255, &out);
        CHECK(out.result_code == LUMEN_RESULT_OK);
        CHECK(out.segment_op);
    }

    /* strip 3 的合法上界 [0-9] 必须被接受。 */
    {
        lumen_frame_t f;
        f.command = LUMEN_CMD_SET_SEGMENT;
        f.seq = 3;
        f.payload_len = 8;
        f.payload[0] = 3;
        f.payload[1] = 0;
        f.payload[2] = 0;
        f.payload[3] = 9;
        f.payload[4] = LUMEN_EFFECT_STATIC;
        f.payload[5] = 0x00;
        f.payload[6] = 0x00;
        f.payload[7] = 255;
        lumen_command_outcome_t out;
        lumen_command_dispatch(&f, &state, &store, strip_counts, 255, &out);
        CHECK(out.result_code == LUMEN_RESULT_OK);
    }

    /* strip_counts == NULL 时退回 State 的 led_count（单灯带兼容）。 */
    {
        lumen_frame_t f;
        f.command = LUMEN_CMD_SET_SEGMENT;
        f.seq = 4;
        f.payload_len = 8;
        f.payload[0] = 0;
        f.payload[1] = 1;
        f.payload[2] = 0;
        f.payload[3] = 40;
        f.payload[4] = LUMEN_EFFECT_STATIC;
        f.payload[5] = 0x00;
        f.payload[6] = 0x00;
        f.payload[7] = 255;
        lumen_command_outcome_t out;
        lumen_command_dispatch(&f, &state, &store, NULL, 255, &out);
        CHECK(out.result_code == LUMEN_RESULT_OK);
    }

    /* helper 本身的边界。 */
    CHECK(lumen_command_strip_count(&state, strip_counts, 3) == 10);
    CHECK(lumen_command_strip_count(&state, NULL, 3) == 64); /* 退回 strip 0 */
    CHECK(lumen_command_strip_count(&state, strip_counts, 0) == 64);
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
        if (!lumen_script_stage(store, script_id, st, duration_ms)) {
            return false;
        }
        lumen_segment_t seg = make_static(0, 9, (uint16_t)(st * 4096u), 255);
        if (!lumen_script_segment(store, script_id, st, 0, 0, &seg, NULL)) {
            return false;
        }
    }
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};
    return lumen_script_commit(store, script_id, counts);
}

static void test_script_store_download(void)
{
    lumen_script_store_t store;
    lumen_script_store_init(&store);

    CHECK(lumen_script_get(&store, 0) == NULL);
    CHECK(!lumen_script_is_committed(&store, 0));

    /* 4 阶段剧本：每阶段各自的时长与各段灯效。 */
    CHECK(lumen_script_begin(&store, 0, 4, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 1000));
    CHECK(lumen_script_stage(&store, 0, 1, 2000));
    CHECK(lumen_script_stage(&store, 0, 2, 1500));
    CHECK(lumen_script_stage(&store, 0, 3, 2500));
    for (uint8_t st = 0; st < 4; ++st) {
        lumen_segment_t seg = make_static(0, 29, (uint16_t)(st * 5000u), 255);
        uint16_t written = 0;
        CHECK(lumen_script_segment(&store, 0, st, 0, 0, &seg, &written));
        /* 每接受一帧，进度累加（0x86 的数据源）。 */
        CHECK(written == (uint16_t)(st + 1u));
    }
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 0, 0, 0, 0, 0, 0, 0};
    CHECK(lumen_script_commit(&store, 0, counts));

    const lumen_script_t *script = lumen_script_get(&store, 0);
    CHECK(script != NULL);
    CHECK(lumen_script_stage_count(&store, 0) == 4);
    CHECK(script != NULL && script->stages[0].duration_ms == 1000);
    CHECK(script != NULL && script->stages[3].duration_ms == 2500);
    CHECK(script != NULL && script->stages[2].segments[0][0].hue == 10000);
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
    CHECK(!lumen_script_stage(&store, 0, 2, 100));   /* 超出 stage_count */
    CHECK(!lumen_script_stage(&store, 0, 0, 0));     /* 时长 0 */
    CHECK(!lumen_script_stage(&store, 1, 0, 100));   /* 不是本次暂存的 id */
    lumen_segment_t seg = make_static(0, 9, 0, 255);
    CHECK(!lumen_script_segment(&store, 0, 0, 1, 0, &seg, NULL)); /* strip 越界 */
    CHECK(!lumen_script_segment(&store, 0, 0, 0, LUMEN_MAX_SEGMENTS, &seg, NULL));
    lumen_segment_t bad_type = seg;
    bad_type.type = 0x09;
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
    CHECK(lumen_script_stage(&store, 0, 0, 800));
    CHECK(lumen_script_stage(&store, 0, 1, 800));
    /* stage 2 不写时长 */
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &before, NULL));
    CHECK(!lumen_script_commit(&store, 0, counts));
    CHECK(store.staging_active == false);
    CHECK(lumen_script_get(&store, 0) != NULL);
    CHECK(lumen_script_stage_count(&store, 0) == 2);
    good = lumen_script_get(&store, 0);
    CHECK(good != NULL && good->stages[0].segments[0][0].hue == before.hue);
    CHECK(good != NULL && good->stages[0].duration_ms == 500);

    /* (b) 段越界（end >= 该灯带灯珠数）→ 失败，旧剧本完整。 */
    CHECK(lumen_script_begin(&store, 0, 1, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 800));
    lumen_segment_t out_of_range = make_static(0, 40, 0, 255); /* 30 灯 */
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &out_of_range, NULL));
    CHECK(!lumen_script_commit(&store, 0, counts));
    CHECK(lumen_script_stage_count(&store, 0) == 2);

    /* (c) 同灯带段重叠 → 失败，旧剧本完整。 */
    CHECK(lumen_script_begin(&store, 0, 1, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 800));
    lumen_segment_t first = make_static(0, 15, 0, 255);
    lumen_segment_t second = make_static(10, 20, 0, 255);
    CHECK(lumen_script_segment(&store, 0, 0, 0, 0, &first, NULL));
    CHECK(lumen_script_segment(&store, 0, 0, 0, 1, &second, NULL));
    CHECK(!lumen_script_commit(&store, 0, counts));
    CHECK(lumen_script_stage_count(&store, 0) == 2);

    /* (d) stage_count 越界（begin 就拒）与 strip_counts 全 0 → 失败。 */
    CHECK(!lumen_script_begin(&store, 0, 0, 1));
    CHECK(lumen_script_begin(&store, 0, 1, 1));
    CHECK(lumen_script_stage(&store, 0, 0, 800));
    uint16_t no_counts[LUMEN_MAX_STRIPS] = {0};
    CHECK(!lumen_script_commit(&store, 0, no_counts));
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
    CHECK(s0 != NULL && s0->stages[0].segments[0][0].hue == 0);
    const lumen_script_t *s1 = lumen_script_get(&store, 1);
    CHECK(s1 != NULL && s1->stages[1].segments[0][0].hue == 4096);

    /* 覆盖 0 号不影响 1 号。 */
    CHECK(script_download(&store, 0, 1, 900));
    CHECK(lumen_script_stage_count(&store, 0) == 1);
    CHECK(lumen_script_stage_count(&store, 1) == 2);
    s1 = lumen_script_get(&store, 1);
    CHECK(s1 != NULL && s1->stages[1].segments[0][0].hue == 4096);
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

static void test_script_blob_roundtrip(void)
{
    uint16_t counts[LUMEN_MAX_STRIPS] = {30, 12, 0, 0, 0, 0, 0, 0};

    lumen_script_store_t store;
    lumen_script_store_init(&store);
    CHECK(script_download(&store, 0, 4, 1000));
    /* 1 号剧本：2 条灯带、每阶段两条灯带各一个段，含动画段。 */
    CHECK(lumen_script_begin(&store, 1, 2, 2));
    for (uint8_t st = 0; st < 2; ++st) {
        CHECK(lumen_script_stage(&store, 1, st, (uint16_t)(700 + st * 100)));
        lumen_segment_t a = make_static(0, 9, 1234, 200);
        lumen_segment_t b = make_static(0, 5, 0, 255);
        b.type = LUMEN_EFFECT_BREATHING;
        b.period_ms = 1000;
        b.p5 = 0x40;
        b.flags = 0x02;
        CHECK(lumen_script_segment(&store, 1, st, 0, 0, &a, NULL));
        CHECK(lumen_script_segment(&store, 1, st, 1, 3, &b, NULL));
    }
    CHECK(lumen_script_commit(&store, 1, counts));

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
        CHECK(s1->stages[0].segments[0][0].hue == 1234);
        CHECK(s1->stages[0].segments[0][0].sat == 200);
        CHECK(s1->stages[0].segments[1][3].active);
        CHECK(s1->stages[0].segments[1][3].type == LUMEN_EFFECT_BREATHING);
        CHECK(s1->stages[0].segments[1][3].period_ms == 1000);
        CHECK(s1->stages[0].segments[1][3].flags == 0x02);
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
}

int main(int argc, char **argv)
{
    const char *vectors = argc > 1 ? argv[1] : "docs/protocol-testvectors.json";

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
    test_segment_commands();
    test_encode_segment_reports();
    test_effects_breathing_phase();
    test_effects_breathing_envelope();
    test_effects_breathing_gain_and_pixel();
    test_effects_rainbow_hue();
    test_effects_rainbow_pixel();
    test_effects_comet_gain();
    test_effects_rainbow_comet_coexist();
    test_blob_strip_counts();
    test_set_segment_uses_own_strip_count();
    test_script_store_download();
    test_script_commit_failure_keeps_previous();
    test_script_multiple_scripts();
    test_script_playback_advance();
    test_script_playback_pause_resume();
    test_script_playback_hold_during_selftest();
    test_script_blob_roundtrip();
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
