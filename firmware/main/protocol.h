#pragma once

#include <stddef.h>
#include <stdint.h>

/*
 * lumen 协议 v4 的字节级契约，唯一真相是 docs/protocol-v4.md。
 *
 * 本文件只提供「信封」层面的纯函数：
 *   - 解码 magic / version / length / crc16，原样交出 command / seq / payload；
 *   - 编码 ACK / Event / StateReport / SegmentReport / 两条新报告。
 * 命令字是否已知、载荷长度与取值是否合法属于命令层（command.[ch]），不在本文件实现。
 *
 * v4 不向后兼容：magic 0xA6（未变）、**version 0x04**、16 位小端长度、CRC16
 * （CCITT-FALSE）。v3 帧一律回 UnsupportedVersion，不做双版本解码。
 * 分片头（BLE 传输层）不在信封里，见 chunk_reasm.h。
 */

#define LUMEN_MAGIC 0xA6
#define LUMEN_VERSION 0x04
#define LUMEN_MAX_FRAME 240
#define LUMEN_MAX_PAYLOAD 232
#define LUMEN_HEADER_LEN 6
#define LUMEN_FRAME_OVERHEAD 8 /* header 6 + crc16 2 */
/*
 * 单条灯带的灯珠上限（docs/protocol-v4.md §1.1）。
 *
 * #72 从 64 抬到 100：`start` / `end` 本来就是 1 字节（100 < 255），
 * SetLedCount 仍是 3 字节载荷，state blob 尺寸与灯珠数无关——**线上布局不变**。
 * 涨的只有固件侧的缓冲（TDM 帧 8 × 300 字节）与这个校验常量。
 */
#define LUMEN_MAX_LEDS 100

/* v4 协议常量（docs/protocol-v4.md §1.1）。 */
#define LUMEN_MAX_STRIPS 8
#define LUMEN_MAX_SEGMENTS 8 /* 每条灯带 */
#define LUMEN_MAX_STAGES 8   /* 每套剧本 */
#define LUMEN_MAX_SCRIPTS 4
#define LUMEN_MAX_LAYERS 2
#define LUMEN_MAX_STAGE_MS 65535
#define LUMEN_STATE_BYTES 37
#define LUMEN_NO_SCRIPT 0xFF /* script_id 用 0xFF 表示「无激活剧本」 */
#define LUMEN_NO_EFFECT 0xFF /* 层类型 0xFF 表示「空层」 */

/* 分片容量（docs/protocol-v4.md §2.1 / §3.2）：chunk_capacity = min(mtu-3, 180)，
 * 单次写的数据上限再减 1 字节分片头。 */
#define LUMEN_MAX_CHUNK_CAPACITY 180
#define LUMEN_MAX_CHUNK_DATA (LUMEN_MAX_CHUNK_CAPACITY - 1)

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

    /* v2 新命令从 0x10 起（docs/protocol-v4.md §6）。 */
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

    /* v3 新增（docs/protocol-v4.md §6）。 */
    LUMEN_CMD_SET_STRIP_POWER = 0x1B,
    LUMEN_CMD_QUERY_STRIP_CONFIG = 0x1C,
    LUMEN_CMD_QUERY_DEVICE_INFO = 0x1D,
    /*
     * #73：原保留区 0x1E-0x7F 的最低一位，用来真正删掉一套已提交剧本
     * （docs/protocol-v4.md §6 / §9.6）。**协议版本号不变**：旧固件收到 0x1E
     * 按未知命令回 0x02，不会误改任何东西，因此不需要升版本。
     */
    LUMEN_CMD_CLEAR_SCRIPT = 0x1E,

    LUMEN_CMD_ACK = 0x80,
    LUMEN_CMD_EVENT = 0x81,
    LUMEN_CMD_STATE_REPORT = 0x82,
    LUMEN_CMD_SEGMENT_REPORT = 0x83,
    LUMEN_CMD_SEGMENT_LIST_END = 0x84,
    LUMEN_CMD_SCRIPT_SUMMARY = 0x85,
    LUMEN_CMD_SCRIPT_PROGRESS = 0x86,
    LUMEN_CMD_STRIP_CONFIG_REPORT = 0x87,
    LUMEN_CMD_DEVICE_INFO_REPORT = 0x88,
} lumen_command_t;

/* ACK 载荷第二个字节，见 docs/protocol-v4.md §5。 */
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
    /* 剧本编码后超过持久化上限（docs/protocol-v4.md §10.4）；#39 实现预检。 */
    LUMEN_RESULT_SCRIPT_TOO_LARGE = 0x0A,
} lumen_result_t;

/* Event 0x81 的 event_code，见 docs/protocol-v4.md §7.4。 */
typedef enum {
    LUMEN_EVENT_STORAGE_FAILED = 0x01,
    /* ScriptCommit 校验失败（detail = 失败的 script_id），剧本下发见 §9.6。 */
    LUMEN_EVENT_SCRIPT_COMMIT_FAILED = 0x02,
} lumen_event_t;

/* 设备能力位（DeviceInfoReport 的 caps，docs/protocol-v4.md §7.4）。 */
#define LUMEN_CAP_TWO_LAYERS 0x01 /* bit0：支持两层叠加 */
#define LUMEN_CAP_FADE 0x02       /* bit1：fade 已实现（当前为 0，#39 之后才置位） */

typedef struct {
    uint8_t command;
    uint8_t seq;
    uint8_t payload_len;
    uint8_t payload[LUMEN_MAX_PAYLOAD];
} lumen_frame_t;

typedef enum {
    LUMEN_DECODE_OK = 0,
    /* 整帧不足 8 字节（连 crc 都放不下），无法可靠读出 seq，直接丢弃不回 ACK。 */
    LUMEN_DECODE_SILENT,
    LUMEN_DECODE_ERROR, /* 信封无效，按 result_code 回 ACK */
} lumen_decode_status_t;

/*
 * 解码一帧的信封。
 *
 * 校验顺序固定为 magic → version → length 越界 → 实际长度 → crc16。失败时仍尽量
 * 填充 out->command / out->seq，供上层回显 ACK。返回 LUMEN_DECODE_SILENT 时
 * result_code 无意义（置 0xFF）。
 *
 * 注意：本函数不判断命令字是否已知，也不校验命令载荷长度/取值；合法信封
 * 配未知命令时返回 LUMEN_DECODE_OK，由命令层回 0x02。
 */
lumen_decode_status_t lumen_protocol_decode(const uint8_t *data, size_t len,
                                            lumen_frame_t *out, uint8_t *result_code);

/*
 * CRC16 CCITT-FALSE：poly 0x1021、init 0xFFFF、不反转、无末尾异或
 * （docs/protocol-v4.md §3.4）。标准校验值 "123456789" → 0x29B1。
 */
uint16_t lumen_protocol_crc16(const uint8_t *data, size_t len);

/* 编码任意信封。payload_len > 232、整帧 > 240、缓冲不足或指针非法时返回 0。
 * payload_len == 0 时 payload 允许为 NULL。 */
size_t lumen_protocol_encode(uint8_t command, uint8_t seq, const uint8_t *payload,
                             uint8_t payload_len, uint8_t *out, size_t out_cap);

/* ACK 0x80：载荷 [原命令字, 结果码]，seq 回显请求。 */
size_t lumen_protocol_encode_ack(uint8_t seq, uint8_t command, uint8_t result,
                                 uint8_t *out, size_t out_cap);

/* Event 0x81：载荷 [event_code, detail]，seq 固定 0x00。 */
size_t lumen_protocol_encode_event(uint8_t event, uint8_t detail, uint8_t *out,
                                   size_t out_cap);

/* StateReport 0x82：载荷为 LUMEN_STATE_BYTES(37) 字节 State，seq 回显查询请求。 */
size_t lumen_protocol_encode_state_report(uint8_t seq,
                                          const uint8_t state[LUMEN_STATE_BYTES],
                                          uint8_t *out, size_t out_cap);

/*
 * SegmentReport 0x83：载荷与 §7.1 的 SetSegment 同构，**固定 23 字节**
 * （docs/protocol-v4.md §7.1；报告与下发同构）。
 *
 * layer0 / layer1 都是 **9 字节**定宽层（type + 7 字节参数 + level），由调用方
 * 按类型编码。layer1 传 NULL 表示空层（写入 0xFF + 8 个 0）。layer0 不得为 NULL。
 */
size_t lumen_protocol_encode_segment_report(uint8_t seq, uint8_t strip_id, uint8_t seg_id,
                                            uint8_t start, uint8_t end, uint8_t blend,
                                            const uint8_t layer0[9], const uint8_t layer1[9],
                                            uint8_t *out, size_t out_cap);

/* SegmentListEnd 0x84：载荷 [strip_id, seg_mask]，seq 回显 QueryStrip。 */
size_t lumen_protocol_encode_segment_list_end(uint8_t seq, uint8_t strip_id, uint8_t seg_mask,
                                              uint8_t *out, size_t out_cap);

/*
 * ScriptSummary 0x85：载荷 [script_id, stage_count, flags, active]，seq 回显 QueryScript。
 * flags bit0 = loop，bit1 = active；active 是 0/1 的独立字节（与 State 的 flags
 * 同位掩码不同，这里是显式字段，按 §7.4 的字段顺序编码）。
 */
size_t lumen_protocol_encode_script_summary(uint8_t seq, uint8_t script_id, uint8_t stage_count,
                                            uint8_t flags, uint8_t active, uint8_t *out,
                                            size_t out_cap);

/* ScriptProgress 0x86：载荷 [script_id, frames_lo, frames_hi]，seq 回显下发请求。 */
size_t lumen_protocol_encode_script_progress(uint8_t seq, uint8_t script_id,
                                             uint16_t frames_written, uint8_t *out,
                                             size_t out_cap);

/*
 * StripConfigReport 0x87（24 字节）：8 × [strip_id, gpio, flags]。
 *
 * gpios 是构建期引脚表（长度 LUMEN_MAX_STRIPS）；第 i 条在 i < strip_count 时
 * 报真实引脚与 flags bit0=已分配，其余报 gpio=0xFF、flags=0（docs/protocol-v4.md §7.4）。
 * 协议只读引脚表，不能改映射。
 */
size_t lumen_protocol_encode_strip_config_report(uint8_t seq,
                                                 const uint8_t gpios[LUMEN_MAX_STRIPS],
                                                 uint8_t strip_count, uint8_t *out,
                                                 size_t out_cap);

/*
 * DeviceInfoReport 0x88（15 字节）：固件版本、6 字节 BT MAC（打印顺序）、
 * 五个上限、caps、保留字节 0（docs/protocol-v4.md §7.4）。
 */
size_t lumen_protocol_encode_device_info_report(uint8_t seq, uint16_t firmware_version,
                                                const uint8_t hw_id[6], uint8_t caps,
                                                uint8_t *out, size_t out_cap);
