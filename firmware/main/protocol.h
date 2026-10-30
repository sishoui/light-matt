#pragma once

#include <stddef.h>
#include <stdint.h>

/*
 * lumen 协议 v2 的字节级契约，唯一真相是 docs/protocol.md。
 *
 * 本文件只提供「信封」层面的纯函数：
 *   - 解码 magic / version / length / checksum，原样交出 command / seq / payload；
 *   - 编码 ACK / Event / StateReport。
 * 命令字是否已知、载荷长度与取值是否合法属于命令层（#8），不在本文件实现。
 *
 * v2 不向后兼容：version 为 0x02，信封、校验和、结果码、seq 语义沿用 v1。
 */

#define LUMEN_MAGIC 0xA5
#define LUMEN_VERSION 0x02
#define LUMEN_MAX_FRAME 20
#define LUMEN_MAX_PAYLOAD 14
#define LUMEN_HEADER_LEN 5
#define LUMEN_FRAME_OVERHEAD 6
#define LUMEN_MAX_LEDS 64

/* v2 协议常量（docs/protocol.md §1）。 */
#define LUMEN_MAX_STRIPS 8
#define LUMEN_MAX_SEGMENTS 8 /* 每条灯带 */
#define LUMEN_MAX_STAGES 8   /* 每套剧本 */
#define LUMEN_MAX_SCRIPTS 4
#define LUMEN_STATE_BYTES 14
#define LUMEN_NO_SCRIPT 0xFF /* script_id 用 0xFF 表示「无激活剧本」 */

/* 协议命令字常量。这里只定义字节值，不定义语义。 */
typedef enum {
    LUMEN_CMD_SET_POWER = 0x01,
    LUMEN_CMD_SET_BRIGHTNESS = 0x02,
    /*
     * 0x03 / 0x04 是 v1 的 SetColor / SetAll，v2 已退役（收到回 0x02 未知命令）。
     * 枚举值保留只为日志可读与压力模式的历史引用；命令层不再接受。
     */
    LUMEN_CMD_SET_COLOR = 0x03,
    LUMEN_CMD_SET_ALL = 0x04,
    LUMEN_CMD_QUERY_STATE = 0x05,
    LUMEN_CMD_SET_LED_COUNT = 0x06,
    LUMEN_CMD_SELF_TEST = 0x07,

    /* v2 新命令从 0x10 起（docs/protocol.md §6）。 */
    LUMEN_CMD_SET_SEGMENT = 0x10,
    LUMEN_CMD_CLEAR_SEGMENT = 0x11,
    LUMEN_CMD_QUERY_STRIP = 0x12,
    LUMEN_CMD_SET_PLAYBACK = 0x13,
    LUMEN_CMD_SCRIPT_BEGIN = 0x14,
    LUMEN_CMD_SCRIPT_STAGE = 0x15,
    LUMEN_CMD_SCRIPT_SEGMENT = 0x16,
    LUMEN_CMD_SCRIPT_COMMIT = 0x17,
    LUMEN_CMD_SCRIPT_ABORT = 0x18,
    LUMEN_CMD_ACTIVATE_SCRIPT = 0x19,
    LUMEN_CMD_QUERY_SCRIPT = 0x1A,

    LUMEN_CMD_ACK = 0x80,
    LUMEN_CMD_EVENT = 0x81,
    LUMEN_CMD_STATE_REPORT = 0x82,
    LUMEN_CMD_SEGMENT_REPORT = 0x83,
    LUMEN_CMD_SEGMENT_LIST_END = 0x84,
    LUMEN_CMD_SCRIPT_SUMMARY = 0x85,
    LUMEN_CMD_SCRIPT_PROGRESS = 0x86,
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
    /* ScriptCommit 校验失败（detail = 失败的 script_id），剧本下发见 §10。 */
    LUMEN_EVENT_SCRIPT_COMMIT_FAILED = 0x02,
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

/* StateReport 0x82：载荷为 LUMEN_STATE_BYTES(14) 字节 State，seq 回显查询请求。 */
size_t lumen_protocol_encode_state_report(uint8_t seq,
                                          const uint8_t state[LUMEN_STATE_BYTES],
                                          uint8_t *out, size_t out_cap);

/*
 * SegmentReport 0x83：载荷与 SetSegment 同构（8 或 12 字节），seq 回显 QueryStrip。
 *
 * params 是类型对应的参数块（静态 3 字节 / 动画 7 字节），由调用方按
 * lumen_effect_param_len(type) 提供；长度不符时返回 0。
 */
size_t lumen_protocol_encode_segment_report(uint8_t seq, uint8_t strip_id, uint8_t seg_id,
                                            uint8_t start, uint8_t end, uint8_t type,
                                            const uint8_t *params, uint8_t param_len,
                                            uint8_t *out, size_t out_cap);

/* SegmentListEnd 0x84：载荷 [strip_id, seg_mask]，seq 回显 QueryStrip。 */
size_t lumen_protocol_encode_segment_list_end(uint8_t seq, uint8_t strip_id, uint8_t seg_mask,
                                              uint8_t *out, size_t out_cap);
