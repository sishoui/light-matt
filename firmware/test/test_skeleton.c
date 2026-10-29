/*
 * Host 单元测试：不依赖 ESP-IDF，不连硬件。
 *
 * 主要覆盖：
 *   1. docs/protocol-testvectors.json 里的全部用例（两端共用的唯一向量文件）：
 *      - app_to_device 合法帧：解码字段与编码结果逐字节一致；
 *      - app_to_device 非法帧：解码失败原因 / 结果码与向量一致；
 *      - device_to_app 帧：解码，并用 ACK / Event / StateReport 编码器逐字节复现；
 *   2. SetPower / SetBrightness reducer 的取值与状态语义（含钳位与开关解耦），
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
#include "protocol.h"
#include "state.h"

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
        } else {
            /* 0x03-0x07 本票明确未实现，统一回 0x02；保留命令/未知命令同理。 */
            CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
            CHECK(!outcome.state_changed);
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

    /* 0x03-0x07 本票未实现：0x02（载荷长度正确时也不能改状态） */
    for (uint8_t cmd = LUMEN_CMD_SET_COLOR; cmd <= LUMEN_CMD_SELF_TEST; ++cmd) {
        lumen_frame_t known = {0};
        known.command = cmd;
        known.payload_len = lumen_command_payload_len(cmd);
        lumen_command_dispatch(&known, &state, 255, &outcome);
        CHECK(outcome.result_code == LUMEN_RESULT_UNKNOWN_COMMAND);
        CHECK(!outcome.state_changed);
        CHECK(lumen_command_is_known(cmd));
    }

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
    test_encode_ack_all_results();
    test_encode_limits();
    test_decode_short();
    test_decode_bad_frames_echo_header();
    test_decode_max_payload();
    test_state_defaults_and_clamp();
    test_state_bytes_layout();
    test_gamma();

    if (g_failures != 0) {
        fprintf(stderr, "\n%d/%d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("all %d checks passed\n", g_checks);
    return 0;
}
