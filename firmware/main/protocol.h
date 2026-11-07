#pragma once

#include <stddef.h>
#include <stdint.h>

/*
 * lumen 协议 v5 的字节级契约，唯一真相是 docs/protocol-v5.md。
 *
 * 本文件只提供「信封」层面的纯函数：
 *   - 解码 magic / version / length / crc16，原样交出 command / seq / payload；
 *   - 编码 ACK / Event / StateReport / 各条固定宽度报告。
 * 命令字是否已知、载荷长度与取值是否合法属于命令层（command.[ch]），不在本文件实现。
 *
 * v5 不向后兼容：magic 0xA6（未变）、**version 0x05**、16 位小端长度、CRC16
 * （CCITT-FALSE）。v4 帧一律回 UnsupportedVersion，不做双版本解码。
 * 分片头（BLE 传输层）不在信封里，见 chunk_reasm.h。
 */

#define LUMEN_MAGIC 0xA6
#define LUMEN_VERSION 0x05
#define LUMEN_MAX_FRAME 240
#define LUMEN_MAX_PAYLOAD 232
#define LUMEN_HEADER_LEN 6
#define LUMEN_FRAME_OVERHEAD 8 /* header 6 + crc16 2 */
/* 单条灯带的灯珠上限（docs/protocol-v5.md §1.1）。 */
#define LUMEN_MAX_LEDS 100
/* 固件版本（DeviceInfoReport 首两个字节）：主版本 = v >> 8，次版本 = v & 0xFF。 */
#define LUMEN_FIRMWARE_VERSION 0x0500

/* v5 协议常量（docs/protocol-v5.md §1.1）。 */
#define LUMEN_MAX_STRIPS 8
#define LUMEN_MAX_PARTS 8     /* 每条链的部位数 */
#define LUMEN_MAX_PART_SEGS 8 /* 每个部位的灯珠段数 */
#define LUMEN_MAX_STEPS 8     /* 每个部位的步骤数 */
#define LUMEN_MAX_SCENES 3    /* 设备侧场景数 */
#define LUMEN_MAX_LAYERS 2    /* 每步最多两层（底层 + 叠加层） */
#define LUMEN_NAME_BYTES 24   /* 部位名 / 场景名的字节上限 */
#define LUMEN_STEP_MIN_MS 100
#define LUMEN_STEP_MAX_MS 60000
#define LUMEN_STATE_BYTES 32
#define LUMEN_LAYOUT_PART_BYTES 29 /* LayoutPart 载荷（含相位模式，§9.2） */
#define LUMEN_LAYOUT_REPORT_BYTES 45 /* LayoutReport 载荷（§7.2，与 LayoutPart 同构） */
#define LUMEN_SCENE_STEP_BYTES 24  /* SceneStep / SceneStepReport 载荷 */
#define LUMEN_SCENE_NAME_BYTES 26  /* SceneName / SceneListEnd 载荷 */
#define LUMEN_NO_EFFECT 0xFF       /* 层类型 0xFF 表示「空层」 */
/* 部位相位模式的取值上限（0 连续 / 1 各自起点，§9.2）。LayoutPart 与
 * LayoutReport 都带这一字节，所以界在这里而不是布局存储里。 */
#define LUMEN_PHASE_MAX 1

/* 分片容量（docs/protocol-v5.md §3.2）：chunk_capacity = min(mtu-3, 180)，
 * 单次写的数据上限再减 1 字节分片头。 */
#define LUMEN_MAX_CHUNK_CAPACITY 180
#define LUMEN_MAX_CHUNK_DATA (LUMEN_MAX_CHUNK_CAPACITY - 1)

/* 协议命令字常量。这里只定义字节值，不定义语义。 */
typedef enum {
    LUMEN_CMD_SET_POWER = 0x01,
    LUMEN_CMD_SET_BRIGHTNESS = 0x02,
    /*
     * 0x03 / 0x04 是 v1 的 SetColor / SetAll，v2 已退役（收到回 0x02 未知命令）。
     * 枚举值保留只为日志可读；命令层不再接受。
     */
    LUMEN_CMD_SET_COLOR = 0x03,
    LUMEN_CMD_SET_ALL = 0x04,
    LUMEN_CMD_QUERY_STATE = 0x05,
    LUMEN_CMD_SET_LED_COUNT = 0x06,
    LUMEN_CMD_SELF_TEST = 0x07,

    /* v2 / v3 的段与剧本族（0x10-0x1E）：v5 **整族退役**，一律回 0x02。
     * 枚举值保留只为「这段码不复用」的可读性，命令层不接受。 */
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

    /* v3 新增、v5 保留。 */
    LUMEN_CMD_SET_STRIP_POWER = 0x1B,
    LUMEN_CMD_QUERY_STRIP_CONFIG = 0x1C,
    LUMEN_CMD_QUERY_DEVICE_INFO = 0x1D,
    LUMEN_CMD_CLEAR_SCRIPT = 0x1E, /* v4 加入，v5 退役 */

    /* v5 布局族（docs/protocol-v5.md §6）：灯组 → 部位 → 灯珠段。 */
    LUMEN_CMD_LAYOUT_WRITE = 0x20,
    LUMEN_CMD_LAYOUT_PART = 0x21,
    LUMEN_CMD_LAYOUT_SEG = 0x22,
    LUMEN_CMD_LAYOUT_COMMIT = 0x23,
    LUMEN_CMD_QUERY_LAYOUT = 0x24,

    /* v5 场景族：部位 → 步骤 → 两层。 */
    LUMEN_CMD_SCENE_PART = 0x25,
    LUMEN_CMD_SCENE_STEP = 0x26,
    LUMEN_CMD_SCENE_NAME = 0x27,
    LUMEN_CMD_ACTIVATE_SCENE = 0x28,
    LUMEN_CMD_QUERY_SCENE = 0x29,

    LUMEN_CMD_ACK = 0x80,
    LUMEN_CMD_EVENT = 0x81,
    LUMEN_CMD_STATE_REPORT = 0x82,
    /* 0x83-0x86（段报告 / 段列表收尾 / 剧本摘要 / 剧本进度）在 v5 已删除。 */
    LUMEN_CMD_STRIP_CONFIG_REPORT = 0x87,
    LUMEN_CMD_DEVICE_INFO_REPORT = 0x88,
    LUMEN_CMD_LAYOUT_REPORT = 0x89,
    LUMEN_CMD_LAYOUT_LIST_END = 0x8A,
    LUMEN_CMD_SCENE_PART_REPORT = 0x8B,
    LUMEN_CMD_SCENE_STEP_REPORT = 0x8C,
    LUMEN_CMD_SCENE_LIST_END = 0x8D,
} lumen_command_t;

/* ACK 载荷第二个字节，见 docs/protocol-v5.md §5。 */
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
    /* 0x0A 是 v4 的 ScriptTooLarge，v5 不再发送；编号不复用。 */
} lumen_result_t;

/* Event 0x81 的 event_code，见 docs/protocol-v5.md §7.4。 */
typedef enum {
    LUMEN_EVENT_STORAGE_FAILED = 0x01,
    /* 0x02 是 v4 的剧本提交失败，v5 不再发送。 */
} lumen_event_t;

/* 设备能力位（DeviceInfoReport 的 caps，docs/protocol-v5.md §7.4）。 */
#define LUMEN_CAP_TWO_LAYERS 0x01 /* bit0：支持两层叠加 */
#define LUMEN_CAP_FADE 0x02       /* bit1：fade 已实现（v5 仍为 0） */

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
 * （docs/protocol-v5.md §3.4）。标准校验值 "123456789" → 0x29B1。
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

/* StateReport 0x82：载荷为 LUMEN_STATE_BYTES(32) 字节 State，seq 回显查询请求。 */
size_t lumen_protocol_encode_state_report(uint8_t seq,
                                          const uint8_t state[LUMEN_STATE_BYTES],
                                          uint8_t *out, size_t out_cap);

/*
 * StripConfigReport 0x87（24 字节）：8 × [strip_id, gpio, flags]。
 *
 * gpios 是构建期引脚表（长度 LUMEN_MAX_STRIPS）；第 i 条在 i < strip_count 时
 * 报真实引脚与 flags bit0=已分配，其余报 gpio=0xFF、flags=0（docs/protocol-v5.md §7.4）。
 * 协议只读引脚表，不能改映射。
 */
size_t lumen_protocol_encode_strip_config_report(uint8_t seq,
                                                 const uint8_t gpios[LUMEN_MAX_STRIPS],
                                                 uint8_t strip_count, uint8_t *out,
                                                 size_t out_cap);

/*
 * DeviceInfoReport 0x88（15 字节）：固件版本、6 字节 BT MAC（打印顺序）、
 * 五个上限、caps、保留字节 0（docs/protocol-v5.md §7.4）。
 */
size_t lumen_protocol_encode_device_info_report(uint8_t seq, uint16_t firmware_version,
                                                const uint8_t hw_id[6], uint8_t caps,
                                                uint8_t *out, size_t out_cap);

/*
 * LayoutReport 0x89（45 字节）：strip_id, part_id, name_len, name[24],
 * seg_count, phase, 8 × (start, end)。未用的段写 0/0（docs/protocol-v5.md §7.2）。
 */
size_t lumen_protocol_encode_layout_report(uint8_t seq, uint8_t strip_id, uint8_t part_id,
                                           uint8_t name_len, const uint8_t name[LUMEN_NAME_BYTES],
                                           uint8_t seg_count, uint8_t phase, const uint8_t seg[][2],
                                           uint8_t *out, size_t out_cap);

/* LayoutListEnd 0x8A（2 字节）：strip_id, part_mask（bit i = 部位 i 有段）。 */
size_t lumen_protocol_encode_layout_list_end(uint8_t seq, uint8_t strip_id, uint8_t part_mask,
                                             uint8_t *out, size_t out_cap);

/* ScenePartReport 0x8B（6 字节）：scene_id, strip_id, part_id, step_count, loop, on。 */
size_t lumen_protocol_encode_scene_part_report(uint8_t seq, uint8_t scene_id, uint8_t strip_id,
                                               uint8_t part_id, uint8_t step_count, uint8_t loop,
                                               uint8_t on, uint8_t *out, size_t out_cap);

/*
 * SceneStepReport 0x8C（24 字节）：与 SceneStep **同构**（只是方向相反）。
 * layer0 / layer1 是 9 字节定宽线格式，由调用方按类型编码。
 */
size_t lumen_protocol_encode_scene_step_report(uint8_t seq, uint8_t scene_id, uint8_t strip_id,
                                               uint8_t part_id, uint8_t step_index,
                                               uint16_t duration_ms, const uint8_t layer0[9],
                                               const uint8_t layer1[9], uint8_t *out,
                                               size_t out_cap);

/* SceneListEnd 0x8D（26 字节）：scene_id, name_len, name[24]。 */
size_t lumen_protocol_encode_scene_list_end(uint8_t seq, uint8_t scene_id, uint8_t name_len,
                                            const uint8_t name[LUMEN_NAME_BYTES], uint8_t *out,
                                            size_t out_cap);
