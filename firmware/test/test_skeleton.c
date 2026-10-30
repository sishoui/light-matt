/*
 * Host 单元测试：不依赖 ESP-IDF，不连硬件。
 *
 * 主要覆盖：
 *   1. docs/protocol-testvectors.json 里的全部用例（两端共用的唯一向量文件）：
 *      - app_to_device 合法帧：解码字段与编码结果逐字节一致；
 *      - app_to_device 非法帧：解码失败原因 / 结果码与向量一致；
 *      - device_to_app 帧：解码，并用 ACK / Event / StateReport 编码器逐字节复现；
 *   2. SetPower / SetBrightness / SetColor / SetAll reducer 的取值与状态语义
 *      （含亮度钳位、开关解耦、SetAll 原子性、相同值不 commit），
 *      未实现命令的明确回退；
 *   3. state 默认值/钳位/8 字节布局与 gamma + 亮度乘算。
 *
 * 运行：firmware/test/run-tests.cmd（会把工作目录切到仓库根，再传向量路径）。
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "command.h"
#include "gamma.h"
#include "led_count_job.h"
#include "protocol.h"
#include "save_scheduler.h"
#include "selftest.h"
#include "state.h"
#include "state_blob.h"

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
    int command;
    int seq;
    int result_code; /* -1 = 缺失或 null（静默丢弃） */
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
        if (!json_get_string(object, "name", c.name, sizeof(c.name)) ||
            !json_get_string(object, "direction", c.direction, sizeof(c.direction)) ||
            !json_get_string(object, "frame_hex", c.frame_hex, sizeof(c.frame_hex)) ||
            !json_get_bool(object, "frame_valid", &c.frame_valid)) {
            fprintf(stderr, "[FAIL] malformed vector case near: %.60s\n", object);
            free(text);
            return -1;
        }
        json_get_string(object, "payload_hex", c.payload_hex, sizeof(c.payload_hex));
        json_get_int(object, "command", &c.command);
        json_get_int(object, "seq", &c.seq);
        json_get_int(object, "result_code", &c.result_code);

        fn(&c);
        ++count;
        p = end + 1;
    }

    free(text);
    return count;
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
        /* 向量不涉及构建期上限，按 255 跑 reducer。 */
        lumen_command_dispatch(&frame, &before, 255, &outcome);

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
        } else if (frame.command == LUMEN_CMD_SET_COLOR) {
            /* SetColor：只写 RGB，不动 power / brightness（向量取值恒合法）。 */
            CHECK(c->result_code >= 0);
            CHECK(outcome.result_code == (uint8_t)c->result_code);
            CHECK(outcome.next.power == before.power);
            CHECK(outcome.next.brightness == before.brightness);
            CHECK(outcome.next.r == frame.payload[0]);
            CHECK(outcome.next.g == frame.payload[1]);
            CHECK(outcome.next.b == frame.payload[2]);
            CHECK(outcome.state_changed == (before.r != frame.payload[0] ||
                                            before.g != frame.payload[1] ||
                                            before.b != frame.payload[2]));
        } else if (frame.command == LUMEN_CMD_SET_ALL) {
            /* SetAll：五字段原子生效；向量 payload 合法且亮度在 0-255 内。 */
            CHECK(c->result_code >= 0);
            CHECK(outcome.result_code == (uint8_t)c->result_code);
            CHECK(outcome.next.power == frame.payload[0]);
            CHECK(outcome.next.brightness == frame.payload[1]);
            CHECK(outcome.next.r == frame.payload[2]);
            CHECK(outcome.next.g == frame.payload[3]);
            CHECK(outcome.next.b == frame.payload[4]);
            CHECK(outcome.next.led_count == before.led_count);
            CHECK(outcome.state_changed == (before.power != frame.payload[0] ||
                                            before.brightness != frame.payload[1] ||
                                            before.r != frame.payload[2] ||
                                            before.g != frame.payload[3] ||
                                            before.b != frame.payload[4]));
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
            uint16_t expected =
                (uint16_t)(frame.payload[0] | ((uint16_t)frame.payload[1] << 8));
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
        CHECK(frame.payload_len == 8);
        len = lumen_protocol_encode_state_report(frame.seq, frame.payload, out, sizeof(out));
        break;
    default:
        CHECK(false);
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
    const uint8_t data[] = {0xA5, 0x01, 0x01, 0x01, 0x01, 0x01};
    CHECK(lumen_protocol_checksum(data, sizeof(data)) == 0x55);

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
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 1);

    /* 已是开灯：ACK 0x00 但不重复 commit */
    lumen_command_dispatch(&frame, &outcome.next, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.power == 1);

    /* 非法取值 0x02：0x01，状态不变 */
    lumen_frame_t bad = {0};
    bad.command = LUMEN_CMD_SET_POWER;
    bad.payload_len = 1;
    bad.payload[0] = 2;
    lumen_command_dispatch(&bad, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.power == state.power);

    /* 载荷长度不符：0x04，状态不变 */
    bad.payload_len = 2;
    bad.payload[0] = 1;
    bad.payload[1] = 0;
    lumen_command_dispatch(&bad, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.state_changed);

    /* QueryState（§6.1）：回 0x00 + 请求 StateReport，不改状态、不取消自检。
     * 0x06 自 #12 起已实现，单独覆盖在 test_set_led_count_reducer()；
     * 0x07 自 #13 起已实现，见下面的 selftest 断言。 */
    {
        lumen_frame_t known = {0};
        known.command = LUMEN_CMD_QUERY_STATE;
        known.payload_len = lumen_command_payload_len(LUMEN_CMD_QUERY_STATE);
        lumen_command_dispatch(&known, &state, 255, &outcome);
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
    lumen_command_dispatch(&selftest, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.start_selftest);
    CHECK(!outcome.cancels_selftest);
    CHECK(memcmp(&outcome.next, &state, sizeof(state)) == 0);

    /* 保留 / 未知 / 设备→小程序命令字：0x02 */
    const uint8_t unknown[] = {0x00, 0x08, 0x7F, 0x80, 0x81, 0x82, 0xFF};
    for (size_t i = 0; i < sizeof(unknown); ++i) {
        lumen_frame_t f = {0};
        f.command = unknown[i];
        lumen_command_dispatch(&f, &state, 255, &outcome);
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
        lumen_command_dispatch(&frame, &before, 255, &outcome);
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
    lumen_command_dispatch(&frame, &zero, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.power == 1);
    CHECK(outcome.next.brightness == 0);

    /* 相同值不 commit（避免无意义刷新 / NVS 写入），ACK 仍为 0x00。 */
    lumen_state_t same = state;
    same.brightness = 128;
    frame.payload[0] = 128;
    lumen_command_dispatch(&frame, &same, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.brightness == 128);

    /* 钳位而不是拒绝：max_brightness=180 时，200 / 255 都落到 180。 */
    frame.payload[0] = 200;
    lumen_command_dispatch(&frame, &state, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.brightness == 180);
    CHECK(outcome.next.power == 1);

    frame.payload[0] = 255;
    lumen_command_dispatch(&frame, &state, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.next.brightness == 180);

    /* 钳位后的值与当前值相同：不 commit。 */
    lumen_state_t at_cap = state;
    at_cap.brightness = 180;
    frame.payload[0] = 255;
    lumen_command_dispatch(&frame, &at_cap, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);

    /* 上限之内的值不受影响。 */
    frame.payload[0] = 100;
    lumen_command_dispatch(&frame, &state, 180, &outcome);
    CHECK(outcome.next.brightness == 100);

    /* max_brightness = 0：任何值都被钳到 0，仍然回 0x00。 */
    frame.payload[0] = 255;
    lumen_command_dispatch(&frame, &state, 0, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.next.brightness == 0);
    CHECK(outcome.next.power == 1);

    /* 载荷长度不符：0x04，状态不变。 */
    frame.payload_len = 2;
    frame.payload[0] = 100;
    frame.payload[1] = 0;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
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
    lumen_command_dispatch(&power, &lit, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 0);
    CHECK(outcome.next.brightness == 77);

    power.payload[0] = 1;
    lumen_command_dispatch(&power, &outcome.next, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 1);
    CHECK(outcome.next.brightness == 77);
}

/*
 * SetColor：3 字节 RGB 全部取值合法（0-255），只写颜色。
 * 关键约束（#10）：不改 power、不改 brightness；相同值不 commit。
 */
static void test_set_color_reducer(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 1;
    state.brightness = 77;
    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SET_COLOR;
    frame.seq = 3;
    frame.payload_len = 3;
    lumen_command_outcome_t outcome;

    /* 边界：全黑 / 全白 / 三组单通道 / 一个中间值。 */
    const uint8_t colors[6][3] = {
        {0, 0, 0},       /* 下边界：全 0 */
        {255, 255, 255}, /* 上边界：全 255 */
        {255, 0, 0},     /* 单通道 R */
        {0, 255, 0},     /* 单通道 G */
        {0, 0, 255},     /* 单通道 B */
        {128, 64, 32},   /* 中间值 */
    };
    lumen_state_t before = state;
    for (size_t i = 0; i < sizeof(colors) / sizeof(colors[0]); ++i) {
        frame.payload[0] = colors[i][0];
        frame.payload[1] = colors[i][1];
        frame.payload[2] = colors[i][2];
        lumen_command_dispatch(&frame, &before, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
        CHECK(outcome.next.r == colors[i][0]);
        CHECK(outcome.next.g == colors[i][1]);
        CHECK(outcome.next.b == colors[i][2]);
        /* 颜色命令绝不碰开关与亮度（§7：关灯也保存颜色）。 */
        CHECK(outcome.next.power == before.power);
        CHECK(outcome.next.brightness == before.brightness);
        CHECK(outcome.next.led_count == before.led_count);
        CHECK(outcome.state_changed == (before.r != colors[i][0] ||
                                        before.g != colors[i][1] ||
                                        before.b != colors[i][2]));
        before = outcome.next;
    }

    /* 三个字节全部相同：ACK 0x00，但不 commit。 */
    lumen_state_t same = state;
    same.r = 10;
    same.g = 20;
    same.b = 30;
    frame.payload[0] = 10;
    frame.payload[1] = 20;
    frame.payload[2] = 30;
    lumen_command_dispatch(&frame, &same, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.r == 10 && outcome.next.g == 20 && outcome.next.b == 30);

    /* 只有一个通道变化也要 commit（不能只看 r）。 */
    frame.payload[0] = 10;
    frame.payload[1] = 20;
    frame.payload[2] = 31;
    lumen_command_dispatch(&frame, &same, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.b == 31);

    /* 关灯态下选颜色：power 仍为 0，颜色被保存（开灯即生效）。 */
    lumen_state_t dark = state;
    dark.power = 0;
    frame.payload[0] = 0;
    frame.payload[1] = 128;
    frame.payload[2] = 255;
    lumen_command_dispatch(&frame, &dark, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 0);
    CHECK(outcome.next.brightness == dark.brightness);
    CHECK(outcome.next.r == 0 && outcome.next.g == 128 && outcome.next.b == 255);

    /* 命令层不做 gamma：载荷原样进入状态（255 仍是 255，不是 gamma 后的值）。 */
    frame.payload[0] = 128;
    frame.payload[1] = 64;
    frame.payload[2] = 32;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.next.r == 128 && outcome.next.g == 64 && outcome.next.b == 32);

    /* 载荷长度不符：0x04，状态不变。 */
    frame.payload_len = 2;
    frame.payload[0] = 1;
    frame.payload[1] = 2;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.r == state.r && outcome.next.g == state.g && outcome.next.b == state.b);

    frame.payload_len = 4;
    frame.payload[0] = 1;
    frame.payload[1] = 2;
    frame.payload[2] = 3;
    frame.payload[3] = 4;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.state_changed);
}

/*
 * SetAll 原子性（协议 §11.1）：5 个字段要么全部生效，要么全部不生效。
 */
static void test_set_all_atomicity(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 1;
    state.brightness = 200;
    state.r = 10;
    state.g = 20;
    state.b = 30;

    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SET_ALL;
    frame.seq = 4;
    frame.payload_len = 5;
    lumen_command_outcome_t outcome;

    /* power = 0x02 非法：回 0x01，brightness / RGB 一个都不写。 */
    frame.payload[0] = 2;
    frame.payload[1] = 0;
    frame.payload[2] = 255;
    frame.payload[3] = 0;
    frame.payload[4] = 0;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.power == state.power);
    CHECK(outcome.next.brightness == state.brightness);
    CHECK(outcome.next.r == state.r);
    CHECK(outcome.next.g == state.g);
    CHECK(outcome.next.b == state.b);
    CHECK(outcome.next.led_count == state.led_count);

    /* power = 0xFF 同样非法。 */
    frame.payload[0] = 0xFF;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.state_changed);

    /* 非法 power 且其它字段恰好与当前值相同：仍回 0x01（先校验后赋值）。 */
    frame.payload[1] = state.brightness;
    frame.payload[2] = state.r;
    frame.payload[3] = state.g;
    frame.payload[4] = state.b;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.state_changed);

    /* 载荷长度不符：0x04，整帧不生效。 */
    frame.payload[0] = 1;
    frame.payload_len = 4;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.state_changed);

    frame.payload_len = 5;
}

static void test_set_all_reducer(void)
{
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    state.power = 0;
    state.brightness = 128;
    state.r = 255;
    state.g = 180;
    state.b = 120;

    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SET_ALL;
    frame.seq = 5;
    frame.payload_len = 5;
    lumen_command_outcome_t outcome;

    /* 正常路径：五个字段一起生效，led_count 与 max_brightness 不参与。 */
    frame.payload[0] = 1;
    frame.payload[1] = 200;
    frame.payload[2] = 0;
    frame.payload[3] = 128;
    frame.payload[4] = 255;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 1);
    CHECK(outcome.next.brightness == 200);
    CHECK(outcome.next.r == 0);
    CHECK(outcome.next.g == 128);
    CHECK(outcome.next.b == 255);
    CHECK(outcome.next.led_count == state.led_count);

    /* power = 0 也保存亮度与 RGB（§7：关灯保留亮度、也保存颜色）。 */
    frame.payload[0] = 0;
    frame.payload[1] = 42;
    frame.payload[2] = 1;
    frame.payload[3] = 2;
    frame.payload[4] = 3;
    lumen_command_dispatch(&frame, &outcome.next, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 0);
    CHECK(outcome.next.brightness == 42);
    CHECK(outcome.next.r == 1 && outcome.next.g == 2 && outcome.next.b == 3);

    /* 五个字段全部相同：ACK 0x00 但不 commit（不刷灯、不写 NVS）。 */
    lumen_command_dispatch(&frame, &outcome.next, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);

    /* 只有 power 变化也要 commit（原子帧里任一字段变化即整体提交）。 */
    frame.payload[0] = 1;
    lumen_command_dispatch(&frame, &outcome.next, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.power == 1);
    CHECK(outcome.next.brightness == 42);
    CHECK(outcome.next.r == 1 && outcome.next.g == 2 && outcome.next.b == 3);

    /* 亮度钳位与 SetBrightness 一致（§11.4）：200 / 255 → 180，仍回 0x00。 */
    frame.payload[0] = 1;
    frame.payload[1] = 200;
    frame.payload[2] = 255;
    frame.payload[3] = 180;
    frame.payload[4] = 120;
    lumen_command_dispatch(&frame, &state, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.state_changed);
    CHECK(outcome.next.brightness == 180);

    frame.payload[1] = 255;
    lumen_command_dispatch(&frame, &state, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.next.brightness == 180);

    /* 钳位后恰好等于当前值：整帧视为无变化，不 commit。 */
    lumen_state_t at_cap = state;
    at_cap.power = 1;
    at_cap.brightness = 180;
    at_cap.r = 255;
    at_cap.g = 180;
    at_cap.b = 120;
    frame.payload[0] = 1;
    frame.payload[1] = 255;
    frame.payload[2] = 255;
    frame.payload[3] = 180;
    frame.payload[4] = 120;
    lumen_command_dispatch(&frame, &at_cap, 180, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.next.brightness == 180);

    /* max_brightness = 0：亮度钳到 0，颜色/开关照常生效。 */
    frame.payload[0] = 1;
    frame.payload[1] = 255;
    frame.payload[2] = 10;
    frame.payload[3] = 20;
    frame.payload[4] = 30;
    lumen_command_dispatch(&frame, &state, 0, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(outcome.next.brightness == 0);
    CHECK(outcome.next.power == 1);
    CHECK(outcome.next.r == 10 && outcome.next.g == 20 && outcome.next.b == 30);
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
     * 与向量 event_storage_failed 逐字节一致（detail = SetAll 0x04）。 */
    uint8_t out[LUMEN_MAX_FRAME];
    size_t len =
        lumen_protocol_encode_event(LUMEN_EVENT_STORAGE_FAILED, 0x04, out, sizeof(out));
    CHECK(len == 8);
    CHECK(len == 2 + LUMEN_FRAME_OVERHEAD);
    CHECK(out[0] == 0xA5);
    CHECK(out[1] == 0x01);
    CHECK(out[2] == 0x81);
    CHECK(out[3] == 0x00);
    CHECK(out[4] == 2);
    CHECK(out[5] == LUMEN_EVENT_STORAGE_FAILED);
    CHECK(out[6] == 0x04);
    CHECK(out[7] == 0xD1);
    CHECK_BYTES(out, "A5018100020104D1", len);

    /* seq 不随连接序号变化：换 detail 也应始终是 0x00。 */
    len = lumen_protocol_encode_event(LUMEN_EVENT_STORAGE_FAILED, 0x01, out, sizeof(out));
    CHECK(len == 8);
    CHECK(out[3] == 0x00);
    CHECK(out[6] == 0x01);

    /*
     * #12 补充：每个可能触发持久化的命令字都能编出来，detail 原样透传，
     * 且编出来的帧能用同一信封解回（两端共用一份契约）。
     */
    const uint8_t commands[] = {LUMEN_CMD_SET_POWER, LUMEN_CMD_SET_BRIGHTNESS,
                                LUMEN_CMD_SET_COLOR, LUMEN_CMD_SET_ALL,
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
    CHECK(lumen_protocol_encode_event(LUMEN_EVENT_STORAGE_FAILED, LUMEN_CMD_SET_ALL, out, 7) ==
          0);
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
    CHECK(decode_hex("A501010101", &frame, &rc) == LUMEN_DECODE_SILENT);
    CHECK(decode_hex("", &frame, &rc) == LUMEN_DECODE_SILENT);
    CHECK(lumen_protocol_decode(NULL, 0, &frame, &rc) == LUMEN_DECODE_SILENT);
}

static void test_decode_bad_frames_echo_header(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;

    /* 坏帧也要保留 header，供 ACK 回显 seq / 命令字 */
    CHECK(decode_hex("A60101010101", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_MAGIC);
    CHECK(frame.command == 0x01);
    CHECK(frame.seq == 0x01);

    CHECK(decode_hex("A50201010101", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_UNSUPPORTED_VERSION);

    CHECK(decode_hex("A5010101010154", &frame, &rc) == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_CHECKSUM);
}

static void test_decode_max_payload(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;
    lumen_decode_status_t status =
        decode_hex("A5017F050E000102030405060708090A0B0C0D6C", &frame, &rc);

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

    uint8_t out[8];
    lumen_state_to_bytes(&state, 255, out);
    /* 与 docs/protocol-testvectors.json 的 state_read_example_hex 一致 */
    CHECK_BYTES(out, "0180FFB4781E00FF", sizeof(out));

    state.brightness = 250;
    lumen_state_to_bytes(&state, 200, out);
    CHECK(out[1] == 200);
    CHECK(out[7] == 200);

    state.led_count = 300;
    lumen_state_to_bytes(&state, 255, out);
    CHECK(out[5] == 0x2C);
    CHECK(out[6] == 0x01);
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

    /* 五类改变状态的命令都属于「改变状态」类别（含 #12 的 SetLedCount）。 */
    const uint8_t changing[] = {LUMEN_CMD_SET_POWER, LUMEN_CMD_SET_BRIGHTNESS,
                                LUMEN_CMD_SET_COLOR, LUMEN_CMD_SET_ALL,
                                LUMEN_CMD_SET_LED_COUNT};
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
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.cancels_selftest);
    CHECK(!outcome.start_selftest);

    /* SetBrightness / SetColor / SetAll 同样取消（这里都用当前值）。 */
    frame.command = LUMEN_CMD_SET_BRIGHTNESS;
    frame.payload_len = 1;
    frame.payload[0] = state.brightness;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.cancels_selftest);

    frame.command = LUMEN_CMD_SET_COLOR;
    frame.payload_len = 3;
    frame.payload[0] = state.r;
    frame.payload[1] = state.g;
    frame.payload[2] = state.b;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.cancels_selftest);

    frame.command = LUMEN_CMD_SET_ALL;
    frame.payload_len = 5;
    frame.payload[0] = state.power;
    frame.payload[1] = state.brightness;
    frame.payload[2] = state.r;
    frame.payload[3] = state.g;
    frame.payload[4] = state.b;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(outcome.cancels_selftest);

    /* #12 接入点：SetLedCount 属改变状态类别；合入后回 0x00 即自动取消。 */
    frame.command = LUMEN_CMD_SET_LED_COUNT;
    frame.payload_len = 2;
    frame.payload[0] = 30;
    frame.payload[1] = 0;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(lumen_command_changes_state(frame.command));

    /* QueryState：明确不取消自检（§11.2 第 6 条）。 */
    frame.command = LUMEN_CMD_QUERY_STATE;
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(!outcome.cancels_selftest);

    /* 非法取值 / 长度错误 / 未知命令：命令未生效，不取消自检。 */
    frame.command = LUMEN_CMD_SET_POWER;
    frame.payload_len = 1;
    frame.payload[0] = 2;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.cancels_selftest);

    frame.command = LUMEN_CMD_SET_BRIGHTNESS;
    frame.payload_len = 2;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.cancels_selftest);

    frame.command = 0x08;
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
    CHECK(!outcome.cancels_selftest);

    /* 自检命令本身不取消、只启动。 */
    frame.command = LUMEN_CMD_SELF_TEST;
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
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

    uint8_t before[8];
    lumen_state_to_bytes(&state, 255, before);

    /* 自检启动是纯渲染层覆盖：命令结果 next 与 current 完全一致。 */
    lumen_frame_t frame = {0};
    frame.command = LUMEN_CMD_SELF_TEST;
    frame.payload_len = 0;
    lumen_command_outcome_t outcome;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_OK);
    CHECK(!outcome.state_changed);
    CHECK(memcmp(&outcome.next, &state, sizeof(state)) == 0);

    lumen_selftest_t st;
    lumen_selftest_start(&st, 0);
    uint8_t rgb[3];
    CHECK(lumen_selftest_color(&st, rgb));
    CHECK(rgb[0] == 255 && rgb[1] == 0 && rgb[2] == 0); /* 自检点亮为红 */

    /* 同时刻的 State 仍是关灯 + 原亮度/颜色（§11.2 第 6 条）。 */
    uint8_t during[8];
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

    /* gamma 2.2：50% 输入应落在 56 附近，而不是 128 */
    uint8_t mid = lumen_gamma_apply(128, 255);
    CHECK(mid >= 54 && mid <= 58);

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
    frame.payload_len = 2;

    /* 合法：1、30（与当前相同）、64 —— 都标记重建，都不动状态。 */
    const uint16_t accepted[] = {1, 30, 64};
    for (size_t i = 0; i < sizeof(accepted) / sizeof(accepted[0]); ++i) {
        frame.payload[0] = (uint8_t)(accepted[i] & 0xFF);
        frame.payload[1] = (uint8_t)(accepted[i] >> 8);
        lumen_command_dispatch(&frame, &state, 255, &outcome);
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
        frame.payload[0] = (uint8_t)(rejected[i] & 0xFF);
        frame.payload[1] = (uint8_t)(rejected[i] >> 8);
        lumen_command_dispatch(&frame, &state, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
        CHECK(!outcome.led_count_rebuild);
        CHECK(outcome.led_count == state.led_count);
        CHECK(!outcome.state_changed);
    }

    /* 小端读法：0x0100 = 256 越界；0x4000 = 64 合法（已在上面的 accepted 里）。 */
    frame.payload[0] = 0x00;
    frame.payload[1] = 0x01;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_INVALID_PARAM);
    CHECK(!outcome.led_count_rebuild);

    /* 载荷长度 1 / 3 → 0x04，不请求重建。 */
    frame.payload_len = 1;
    frame.payload[0] = 0x1E;
    frame.payload[1] = 0x00;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.led_count_rebuild);

    frame.payload_len = 3;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.led_count_rebuild);

    /* payload_len 正确的 0 长度帧同样 0x04。 */
    frame.payload_len = 0;
    lumen_command_dispatch(&frame, &state, 255, &outcome);
    CHECK(outcome.result_code == LUMEN_RESULT_BAD_LENGTH);
    CHECK(!outcome.led_count_rebuild);

    /* 命令表：0x06 已知且载荷 2 字节。 */
    CHECK(lumen_command_is_known(LUMEN_CMD_SET_LED_COUNT));
    CHECK(lumen_command_payload_len(LUMEN_CMD_SET_LED_COUNT) == 2);
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

static lumen_state_t state_with(uint16_t leds, uint8_t brightness)
{
    lumen_state_t s;
    lumen_state_defaults(&s, leds);
    s.brightness = brightness;
    return s;
}

static void test_save_scheduler(void)
{
    lumen_save_scheduler_t sched;
    lumen_save_scheduler_init(&sched);

    lumen_state_t out;
    uint8_t command = 0;

    /* 1. 初始：没有待写，next_delay 为 UINT32_MAX，take_due 失败。 */
    CHECK(!lumen_save_scheduler_pending(&sched));
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 0) == UINT32_MAX);
    CHECK(!lumen_save_scheduler_take_due(&sched, 0, &out, &command));

    /* 2. 一次请求 → 500ms 后到期；499ms 时还差 1ms。 */
    lumen_state_t a = state_with(30, 10);
    CHECK(lumen_save_scheduler_request(&sched, &a, LUMEN_CMD_SET_BRIGHTNESS, 1000));
    CHECK(lumen_save_scheduler_pending(&sched));
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 1000) == LUMEN_SAVE_DEBOUNCE_MS);
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 1499) == 1);
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 1500) == 0);
    CHECK(!lumen_save_scheduler_take_due(&sched, 1499, &out, &command));
    CHECK(lumen_save_scheduler_take_due(&sched, 1500, &out, &command));
    CHECK(out.brightness == 10);
    CHECK(out.led_count == 30);
    CHECK(command == LUMEN_CMD_SET_BRIGHTNESS);
    /* 取走之后 pending 清空，再来一次 take 失败。 */
    CHECK(!lumen_save_scheduler_pending(&sched));
    CHECK(!lumen_save_scheduler_take_due(&sched, 2000, &out, &command));

    /* 3. 连续请求不断推迟，只写最后一次快照。 */
    CHECK(lumen_save_scheduler_request(&sched, &a, LUMEN_CMD_SET_BRIGHTNESS, 0));
    lumen_state_t b = state_with(30, 20);
    CHECK(lumen_save_scheduler_request(&sched, &b, LUMEN_CMD_SET_COLOR, 100));
    lumen_state_t c = state_with(30, 30);
    CHECK(lumen_save_scheduler_request(&sched, &c, LUMEN_CMD_SET_ALL, 200));
    /* 600ms 时：第一次的 deadline(500) 已过，但最后请求的 deadline 是 700。 */
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 600) == 100);
    CHECK(!lumen_save_scheduler_take_due(&sched, 699, &out, &command));
    CHECK(lumen_save_scheduler_take_due(&sched, 700, &out, &command));
    CHECK(out.brightness == 30); /* 只有最后一份 */
    CHECK(command == LUMEN_CMD_SET_ALL);

    /* 4. 时钟回绕：deadline 越过 0xFFFFFFFF，仍按差值判定，不卡死。 */
    uint32_t near_wrap = 0xFFFFFF00u; /* deadline = 0x000000F4（回绕后） */
    lumen_state_t d = state_with(64, 40);
    CHECK(lumen_save_scheduler_request(&sched, &d, LUMEN_CMD_SET_LED_COUNT, near_wrap));
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, near_wrap) == LUMEN_SAVE_DEBOUNCE_MS);
    /* 回绕之后：now = 0x0000000A，差值 = 0xF4 - 0x0A = 234。 */
    CHECK(lumen_save_scheduler_next_delay_ms(&sched, 0x0000000Au) == 234);
    CHECK(!lumen_save_scheduler_take_due(&sched, 0x0000000Au, &out, &command));
    CHECK(lumen_save_scheduler_take_due(&sched, 0x000000F4u, &out, &command));
    CHECK(out.led_count == 64);
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

/* ---------------- #12：state_blob 编解码 ---------------- */

static void test_state_blob(void)
{
    /* 1. 往返一致：所有字段原样回来。 */
    lumen_state_t in;
    in.power = 1;
    in.brightness = 200;
    in.r = 1;
    in.g = 2;
    in.b = 3;
    in.led_count = 64;

    uint8_t blob[LUMEN_STATE_BLOB_SIZE];
    CHECK(lumen_state_blob_encode(&in, blob) == LUMEN_STATE_BLOB_SIZE);
    /* 显式布局：magic 0..3、version 4..5、power 6、brightness 7、rgb 8..10、
     * led_count 11..12（小端）。 */
    CHECK(blob[0] == 'L' && blob[1] == 'M' && blob[2] == 'E' && blob[3] == 'N');
    CHECK(blob[4] == (LUMEN_STATE_BLOB_VERSION & 0xFF));
    CHECK(blob[5] == (LUMEN_STATE_BLOB_VERSION >> 8));
    CHECK(blob[6] == 1);
    CHECK(blob[7] == 200);
    CHECK(blob[8] == 1 && blob[9] == 2 && blob[10] == 3);
    CHECK(blob[11] == 64 && blob[12] == 0);

    lumen_state_t out;
    memset(&out, 0xAA, sizeof(out));
    CHECK(lumen_state_blob_decode(blob, sizeof(blob), &out));
    CHECK(out.power == 1);
    CHECK(out.brightness == 200);
    CHECK(out.r == 1 && out.g == 2 && out.b == 3);
    CHECK(out.led_count == 64);

    /* 小端数量：300 → 2C 01（虽然 300 超出协议上限，编码器不在业务层校验；
     * 解码器会拒绝，见下）。 */
    lumen_state_t wide;
    lumen_state_defaults(&wide, 30);
    wide.led_count = 0x0123;
    CHECK(lumen_state_blob_encode(&wide, blob) == LUMEN_STATE_BLOB_SIZE);
    CHECK(blob[11] == 0x23 && blob[12] == 0x01);

    /* 2. 长度错误：12 / 14 字节都拒绝（版本演进必须提升 version，不猜）。 */
    lumen_state_defaults(&in, 30);
    CHECK(lumen_state_blob_encode(&in, blob) == LUMEN_STATE_BLOB_SIZE);
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

    /* 4. 坏 version（0 与 2）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[4] = 0x00;
    bad[5] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[4] = 0x02;
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

    /* 6. led_count 越界：0 与 65。 */
    memcpy(bad, blob, sizeof(bad));
    bad[11] = 0x00;
    bad[12] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    memcpy(bad, blob, sizeof(bad));
    bad[11] = 0x41;
    bad[12] = 0x00;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));
    /* 0xFFFF（小端 FF FF）同样越界。 */
    memcpy(bad, blob, sizeof(bad));
    bad[11] = 0xFF;
    bad[12] = 0xFF;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &out));

    /* 7. 失败时不写 out（调用方保留默认值）。 */
    memcpy(bad, blob, sizeof(bad));
    bad[6] = 9;
    lumen_state_t untouched;
    lumen_state_defaults(&untouched, 30);
    lumen_state_t copy = untouched;
    CHECK(!lumen_state_blob_decode(bad, sizeof(bad), &untouched));
    CHECK(untouched.power == copy.power);
    CHECK(untouched.brightness == copy.brightness);
    CHECK(untouched.led_count == copy.led_count);

    /* 8. 边界合法值：power = 0、led_count = 1 都能解出来。 */
    lumen_state_t edge;
    lumen_state_defaults(&edge, 1);
    edge.power = 0;
    edge.brightness = 0;
    CHECK(lumen_state_blob_encode(&edge, blob) == LUMEN_STATE_BLOB_SIZE);
    CHECK(lumen_state_blob_decode(blob, sizeof(blob), &out));
    CHECK(out.power == 0);
    CHECK(out.brightness == 0);
    CHECK(out.led_count == 1);

    /* 9. NULL 防御。 */
    CHECK(lumen_state_blob_encode(NULL, blob) == 0);
    CHECK(lumen_state_blob_encode(&in, NULL) == 0);
    CHECK(!lumen_state_blob_decode(NULL, LUMEN_STATE_BLOB_SIZE, &out));
    CHECK(!lumen_state_blob_decode(blob, LUMEN_STATE_BLOB_SIZE, NULL));
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
    test_set_color_reducer();
    test_set_all_atomicity();
    test_set_all_reducer();
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
    test_set_led_count_reducer();
    test_led_count_job();
    test_save_scheduler();
    test_state_blob();

    if (g_failures != 0) {
        fprintf(stderr, "\n%d/%d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("all %d checks passed\n", g_checks);
    return 0;
}
