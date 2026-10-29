/*
 * Host 单元测试：不依赖 ESP-IDF，不连硬件。
 *
 * 覆盖协议信封（合法帧、坏 magic、坏 version、坏 length、坏 checksum、
 * 短帧、超长帧、未知命令回显 seq）以及 ACK / Event / StateReport 编码。
 * 另外覆盖 state 默认值/钳位/8 字节布局与 gamma + 亮度乘算。
 *
 * 运行：firmware/test/run-tests.cmd
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

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
        uint8_t _expected[64];                                                         \
        size_t _expected_len = hex_to_bytes((expected_hex), _expected, sizeof(_expected)); \
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

static size_t hex_to_bytes(const char *hex, uint8_t *out, size_t cap)
{
    size_t n = 0;
    while (*hex != '\0') {
        if (*hex == ' ' || *hex == '\n' || *hex == '\t') {
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
    uint8_t buf[64];
    size_t len = hex_to_bytes(hex, buf, sizeof(buf));
    if (len == (size_t)-1) {
        fprintf(stderr, "[FAIL] bad test hex: %s\n", hex);
        ++g_failures;
        return LUMEN_DECODE_SILENT;
    }
    return lumen_protocol_decode(buf, len, frame, result_code);
}

static void test_checksum(void)
{
    const uint8_t data[] = {0xA5, 0x01, 0x01, 0x01, 0x01, 0x01};
    CHECK(lumen_protocol_checksum(data, sizeof(data)) == 0x55);

    const uint8_t empty[] = {0x00};
    CHECK(lumen_protocol_checksum(empty, 0) == 0xFF);
}

static void test_decode_valid(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;

    lumen_decode_status_t status = decode_hex("A5010101010155", &frame, &rc);
    CHECK(status == LUMEN_DECODE_OK);
    CHECK(rc == LUMEN_RESULT_OK);
    CHECK(frame.command == 0x01);
    CHECK(frame.seq == 0x01);
    CHECK(frame.payload_len == 1);
    CHECK(frame.payload[0] == 0x01);
}

static void test_decode_bad_magic(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;

    lumen_decode_status_t status = decode_hex("A60101010101", &frame, &rc);
    CHECK(status == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_MAGIC);
    /* 坏帧也要保留 header，供 ACK 回显 */
    CHECK(frame.command == 0x01);
    CHECK(frame.seq == 0x01);
}

static void test_decode_bad_version(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;

    lumen_decode_status_t status = decode_hex("A50201010101", &frame, &rc);
    CHECK(status == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_UNSUPPORTED_VERSION);
    CHECK(frame.command == 0x01);
    CHECK(frame.seq == 0x01);
}

static void test_decode_bad_length(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;

    /* 声明 15 字节载荷：超过协议上限 14 */
    lumen_decode_status_t status = decode_hex("A50101010F00", &frame, &rc);
    CHECK(status == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_LENGTH);

    /* 声明 1 字节载荷，实际 8 字节（多出拖尾） */
    status = decode_hex("A501010101015500", &frame, &rc);
    CHECK(status == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_LENGTH);

    /* 声明 14 字节、实际 21 字节：超过整帧 20 字节上限 */
    status = decode_hex("A50101010E000102030405060708090A0B0C0D0000", &frame, &rc);
    CHECK(status == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_LENGTH);
}

static void test_decode_bad_checksum(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;

    lumen_decode_status_t status = decode_hex("A5010101010154", &frame, &rc);
    CHECK(status == LUMEN_DECODE_ERROR);
    CHECK(rc == LUMEN_RESULT_BAD_CHECKSUM);
    CHECK(frame.command == 0x01);
    CHECK(frame.seq == 0x01);
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

static void test_decode_unknown_command_echoes_seq(void)
{
    lumen_frame_t frame;
    uint8_t rc = 0xFF;
    lumen_decode_status_t status = decode_hex("A501082A0027", &frame, &rc);

    /* 信封合法；命令字是否已知属于 #8 的命令层，这里原样交给上层 */
    CHECK(status == LUMEN_DECODE_OK);
    CHECK(rc == LUMEN_RESULT_OK);
    CHECK(frame.command == 0x08);
    CHECK(frame.seq == 0x2A);
    CHECK(frame.payload_len == 0);
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

static void test_encode_ack(void)
{
    uint8_t out[32];
    size_t len = lumen_protocol_encode_ack(0x03, 0x02, LUMEN_RESULT_OK, out, sizeof(out));
    CHECK(len == 8);
    CHECK_BYTES(out, "A5018003020200D2", len);

    /* 输出缓冲不足必须失败，不能截断 */
    CHECK(lumen_protocol_encode_ack(0x03, 0x02, LUMEN_RESULT_OK, out, 7) == 0);
}

static void test_encode_event(void)
{
    uint8_t out[32];
    size_t len = lumen_protocol_encode_event(0x01, 0x04, out, sizeof(out));
    CHECK(len == 8);
    CHECK_BYTES(out, "A5018100020104D1", len);
}

static void test_encode_state_report(void)
{
    const uint8_t state[8] = {0x01, 0x80, 0xFF, 0xB4, 0x78, 0x1E, 0x00, 0xFF};
    uint8_t out[32];
    size_t len = lumen_protocol_encode_state_report(0x09, state, out, sizeof(out));
    CHECK(len == 14);
    CHECK_BYTES(out, "A5018209080180FFB4781E00FFFD", len);
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
    state.brightness = 180;

    uint8_t out[8];
    lumen_state_to_bytes(&state, 200, out);
    CHECK_BYTES(out, "00B4FFB4781E00C8", sizeof(out));

    /* 越界亮度按 max_brightness 钳位后再进 State */
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

int main(void)
{
    test_checksum();
    test_decode_valid();
    test_decode_bad_magic();
    test_decode_bad_version();
    test_decode_bad_length();
    test_decode_bad_checksum();
    test_decode_short();
    test_decode_unknown_command_echoes_seq();
    test_decode_max_payload();
    test_encode_ack();
    test_encode_event();
    test_encode_state_report();
    test_encode_limits();
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
