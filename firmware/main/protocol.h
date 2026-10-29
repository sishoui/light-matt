#pragma once

#include <stddef.h>
#include <stdint.h>

/*
 * lumen 协议 v1 的字节级契约，唯一真相是 docs/protocol.md。
 *
 * 本文件只提供「信封」层面的纯函数：
 *   - 解码 magic / version / length / checksum，原样交出 command / seq / payload；
 *   - 编码 ACK / Event / StateReport。
 * 命令字是否已知、载荷长度与取值是否合法属于命令层（#8），不在本文件实现。
 */

#define LUMEN_MAGIC 0xA5
#define LUMEN_VERSION 0x01
#define LUMEN_MAX_FRAME 20
#define LUMEN_MAX_PAYLOAD 14
#define LUMEN_HEADER_LEN 5
#define LUMEN_FRAME_OVERHEAD 6
#define LUMEN_MAX_LEDS 64

/* 协议命令字常量。这里只定义字节值，不定义语义。 */
typedef enum {
    LUMEN_CMD_SET_POWER = 0x01,
    LUMEN_CMD_SET_BRIGHTNESS = 0x02,
    LUMEN_CMD_SET_COLOR = 0x03,
    LUMEN_CMD_SET_ALL = 0x04,
    LUMEN_CMD_QUERY_STATE = 0x05,
    LUMEN_CMD_SET_LED_COUNT = 0x06,
    LUMEN_CMD_SELF_TEST = 0x07,

    LUMEN_CMD_ACK = 0x80,
    LUMEN_CMD_EVENT = 0x81,
    LUMEN_CMD_STATE_REPORT = 0x82,
} lumen_command_t;

/* ACK 载荷第二个字节，见 docs/protocol.md §5。 */
typedef enum {
    LUMEN_RESULT_OK = 0x00,
    LUMEN_RESULT_INVALID_PARAM = 0x01,
    LUMEN_RESULT_UNKNOWN_COMMAND = 0x02,
    LUMEN_RESULT_BAD_CHECKSUM = 0x03,
    LUMEN_RESULT_BAD_LENGTH = 0x04,
    LUMEN_RESULT_BUSY = 0x05,
    LUMEN_RESULT_STORAGE_FAILED = 0x06,
    LUMEN_RESULT_UNSUPPORTED_VERSION = 0x07,
    LUMEN_RESULT_BAD_MAGIC = 0x08,
    LUMEN_RESULT_INTERNAL_ERROR = 0x09,
} lumen_result_t;

/* Event 0x81 的 event_code，见 docs/protocol.md §8。 */
typedef enum {
    LUMEN_EVENT_STORAGE_FAILED = 0x01,
} lumen_event_t;

typedef struct {
    uint8_t command;
    uint8_t seq;
    uint8_t payload_len;
    uint8_t payload[LUMEN_MAX_PAYLOAD];
} lumen_frame_t;

typedef enum {
    LUMEN_DECODE_OK = 0,
    LUMEN_DECODE_SILENT, /* 整帧不足 6 字节，无法可靠读出 seq，直接丢弃不回 ACK */
    LUMEN_DECODE_ERROR,  /* 信封无效，按 result_code 回 ACK */
} lumen_decode_status_t;

/*
 * 解码一帧的信封。
 *
 * 校验顺序固定为 magic → version → length → checksum。失败时仍尽量填充
 * out->command / out->seq，供上层回显 ACK。返回 LUMEN_DECODE_SILENT 时
 * result_code 无意义（置 0xFF）。
 *
 * 注意：本函数不判断命令字是否已知，也不校验命令载荷长度/取值；合法信封
 * 配未知命令时返回 LUMEN_DECODE_OK，由命令层回 0x02。
 */
lumen_decode_status_t lumen_protocol_decode(const uint8_t *data, size_t len,
                                            lumen_frame_t *out, uint8_t *result_code);

/* 对 magic..payload 末字节求和后按位取反。len 为参与计算的实际字节数。 */
uint8_t lumen_protocol_checksum(const uint8_t *data, size_t len);

/* 编码任意信封。payload_len > 14、整帧 > 20、缓冲不足或指针非法时返回 0。 */
size_t lumen_protocol_encode(uint8_t command, uint8_t seq, const uint8_t *payload,
                             uint8_t payload_len, uint8_t *out, size_t out_cap);

/* ACK 0x80：载荷 [原命令字, 结果码]，seq 回显请求。 */
size_t lumen_protocol_encode_ack(uint8_t seq, uint8_t command, uint8_t result,
                                 uint8_t *out, size_t out_cap);

/* Event 0x81：载荷 [event_code, detail]，seq 固定 0x00。 */
size_t lumen_protocol_encode_event(uint8_t event, uint8_t detail, uint8_t *out,
                                   size_t out_cap);

/* StateReport 0x82：载荷为 8 字节 State，seq 回显查询请求。 */
size_t lumen_protocol_encode_state_report(uint8_t seq, const uint8_t state[8],
                                          uint8_t *out, size_t out_cap);
