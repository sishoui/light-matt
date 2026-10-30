#include "protocol.h"

#include <string.h>

uint8_t lumen_protocol_checksum(const uint8_t *data, size_t len)
{
    uint8_t sum = 0;
    for (size_t i = 0; i < len; ++i) {
        sum = (uint8_t)(sum + data[i]);
    }
    return (uint8_t)(~sum);
}

lumen_decode_status_t lumen_protocol_decode(const uint8_t *data, size_t len,
                                            lumen_frame_t *out, uint8_t *result_code)
{
    if (result_code != NULL) {
        *result_code = 0xFF;
    }
    if (out == NULL) {
        return LUMEN_DECODE_SILENT;
    }
    memset(out, 0, sizeof(*out));

    /* 整帧不足 6 字节：无法可靠定位 seq / checksum，协议规定静默丢弃。 */
    if (data == NULL || len < LUMEN_FRAME_OVERHEAD) {
        return LUMEN_DECODE_SILENT;
    }

    /* 先保存 header，坏帧也要尽量回显 seq / 命令字。 */
    out->command = data[2];
    out->seq = data[3];

    /* 校验顺序固定：magic → version → length → checksum。 */
    if (data[0] != LUMEN_MAGIC) {
        if (result_code != NULL) {
            *result_code = LUMEN_RESULT_BAD_MAGIC;
        }
        return LUMEN_DECODE_ERROR;
    }

    if (data[1] != LUMEN_VERSION) {
        if (result_code != NULL) {
            *result_code = LUMEN_RESULT_UNSUPPORTED_VERSION;
        }
        return LUMEN_DECODE_ERROR;
    }

    uint8_t declared = data[4];
    if (declared > LUMEN_MAX_PAYLOAD ||
        (size_t)LUMEN_FRAME_OVERHEAD + declared > LUMEN_MAX_FRAME) {
        if (result_code != NULL) {
            *result_code = LUMEN_RESULT_BAD_LENGTH;
        }
        return LUMEN_DECODE_ERROR;
    }

    /* 实际长度必须与声明的载荷长度严格匹配，多、少、拖尾都算坏帧。 */
    if (len != (size_t)LUMEN_FRAME_OVERHEAD + declared) {
        if (result_code != NULL) {
            *result_code = LUMEN_RESULT_BAD_LENGTH;
        }
        return LUMEN_DECODE_ERROR;
    }

    size_t covered = (size_t)LUMEN_HEADER_LEN + declared;
    if (data[covered] != lumen_protocol_checksum(data, covered)) {
        if (result_code != NULL) {
            *result_code = LUMEN_RESULT_BAD_CHECKSUM;
        }
        return LUMEN_DECODE_ERROR;
    }

    out->payload_len = declared;
    if (declared > 0) {
        memcpy(out->payload, &data[LUMEN_HEADER_LEN], declared);
    }

    if (result_code != NULL) {
        *result_code = LUMEN_RESULT_OK;
    }
    return LUMEN_DECODE_OK;
}

size_t lumen_protocol_encode(uint8_t command, uint8_t seq, const uint8_t *payload,
                             uint8_t payload_len, uint8_t *out, size_t out_cap)
{
    if (out == NULL || payload_len > LUMEN_MAX_PAYLOAD) {
        return 0;
    }
    if (payload_len > 0 && payload == NULL) {
        return 0;
    }

    size_t total = (size_t)LUMEN_FRAME_OVERHEAD + payload_len;
    if (total > LUMEN_MAX_FRAME || out_cap < total) {
        return 0;
    }

    out[0] = LUMEN_MAGIC;
    out[1] = LUMEN_VERSION;
    out[2] = command;
    out[3] = seq;
    out[4] = payload_len;
    if (payload_len > 0) {
        memcpy(&out[LUMEN_HEADER_LEN], payload, payload_len);
    }
    out[LUMEN_HEADER_LEN + payload_len] =
        lumen_protocol_checksum(out, (size_t)LUMEN_HEADER_LEN + payload_len);
    return total;
}

size_t lumen_protocol_encode_ack(uint8_t seq, uint8_t command, uint8_t result,
                                 uint8_t *out, size_t out_cap)
{
    uint8_t payload[2] = {command, result};
    return lumen_protocol_encode(LUMEN_CMD_ACK, seq, payload, sizeof(payload), out, out_cap);
}

size_t lumen_protocol_encode_event(uint8_t event, uint8_t detail, uint8_t *out,
                                   size_t out_cap)
{
    uint8_t payload[2] = {event, detail};
    /* Event 的 seq 固定 0x00，不随连接序号变化。 */
    return lumen_protocol_encode(LUMEN_CMD_EVENT, 0x00, payload, sizeof(payload), out, out_cap);
}

size_t lumen_protocol_encode_state_report(uint8_t seq,
                                          const uint8_t state[LUMEN_STATE_BYTES],
                                          uint8_t *out, size_t out_cap)
{
    if (state == NULL) {
        return 0;
    }
    return lumen_protocol_encode(LUMEN_CMD_STATE_REPORT, seq, state, LUMEN_STATE_BYTES, out,
                                 out_cap);
}

size_t lumen_protocol_encode_segment_report(uint8_t seq, uint8_t strip_id, uint8_t seg_id,
                                            uint8_t start, uint8_t end, uint8_t type,
                                            const uint8_t *params, uint8_t param_len,
                                            uint8_t *out, size_t out_cap)
{
    /* 载荷 = strip_id + seg_id + start + end + type + params（docs/protocol.md §8）。 */
    if (param_len == 0 || param_len > 7 || (param_len > 0 && params == NULL)) {
        return 0;
    }
    uint8_t payload[5 + 7];
    payload[0] = strip_id;
    payload[1] = seg_id;
    payload[2] = start;
    payload[3] = end;
    payload[4] = type;
    memcpy(&payload[5], params, param_len);
    return lumen_protocol_encode(LUMEN_CMD_SEGMENT_REPORT, seq, payload,
                                 (uint8_t)(5u + param_len), out, out_cap);
}

size_t lumen_protocol_encode_segment_list_end(uint8_t seq, uint8_t strip_id, uint8_t seg_mask,
                                              uint8_t *out, size_t out_cap)
{
    uint8_t payload[2] = {strip_id, seg_mask};
    return lumen_protocol_encode(LUMEN_CMD_SEGMENT_LIST_END, seq, payload, sizeof(payload), out,
                                 out_cap);
}

size_t lumen_protocol_encode_script_summary(uint8_t seq, uint8_t script_id, uint8_t stage_count,
                                            uint8_t flags, uint8_t active, uint8_t *out,
                                            size_t out_cap)
{
    /* 载荷 [script_id, stage_count, flags, active]（docs/protocol.md §8）。 */
    uint8_t payload[4] = {script_id, stage_count, flags, active};
    return lumen_protocol_encode(LUMEN_CMD_SCRIPT_SUMMARY, seq, payload, sizeof(payload), out,
                                 out_cap);
}

size_t lumen_protocol_encode_script_progress(uint8_t seq, uint8_t script_id,
                                             uint16_t frames_written, uint8_t *out,
                                             size_t out_cap)
{
    /* 载荷 [script_id, frames_lo, frames_hi]（docs/protocol.md §8）。 */
    uint8_t payload[3] = {script_id, (uint8_t)(frames_written & 0xFF),
                          (uint8_t)(frames_written >> 8)};
    return lumen_protocol_encode(LUMEN_CMD_SCRIPT_PROGRESS, seq, payload, sizeof(payload), out,
                                 out_cap);
}
