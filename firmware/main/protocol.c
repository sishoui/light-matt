#include "protocol.h"

#include <string.h>

uint16_t lumen_protocol_crc16(const uint8_t *data, size_t len)
{
    uint16_t crc = 0xFFFF;
    if (data == NULL) {
        return crc;
    }
    for (size_t i = 0; i < len; ++i) {
        crc ^= (uint16_t)data[i] << 8;
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc & 0x8000u) ? (uint16_t)((crc << 1) ^ 0x1021u) : (uint16_t)(crc << 1);
        }
    }
    return crc;
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

    /* 整帧不足 8 字节：header(6) + crc(2) 都放不下，无法可靠定位 seq，静默丢弃。 */
    if (data == NULL || len < LUMEN_FRAME_OVERHEAD) {
        return LUMEN_DECODE_SILENT;
    }

    /* 先保存 header，坏帧也要尽量回显 seq / 命令字。 */
    out->command = data[2];
    out->seq = data[3];

    /* 校验顺序固定：magic → version → length 越界 → 实际长度 → crc16。 */
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

    size_t declared = (size_t)data[4] | ((size_t)data[5] << 8);
    if (declared > LUMEN_MAX_PAYLOAD || LUMEN_FRAME_OVERHEAD + declared > LUMEN_MAX_FRAME) {
        if (result_code != NULL) {
            *result_code = LUMEN_RESULT_BAD_LENGTH;
        }
        return LUMEN_DECODE_ERROR;
    }

    /* 实际长度必须与声明的载荷长度严格匹配，多、少、拖尾都算坏帧。 */
    if (len != LUMEN_FRAME_OVERHEAD + declared) {
        if (result_code != NULL) {
            *result_code = LUMEN_RESULT_BAD_LENGTH;
        }
        return LUMEN_DECODE_ERROR;
    }

    size_t covered = LUMEN_HEADER_LEN + declared;
    uint16_t expected = (uint16_t)data[covered] | ((uint16_t)data[covered + 1] << 8);
    if (expected != lumen_protocol_crc16(data, covered)) {
        if (result_code != NULL) {
            *result_code = LUMEN_RESULT_BAD_CHECKSUM;
        }
        return LUMEN_DECODE_ERROR;
    }

    out->payload_len = (uint8_t)declared;
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
    /* 16 位小端长度（docs/protocol-v5.md §3.1）。 */
    out[4] = (uint8_t)(payload_len & 0xFF);
    out[5] = (uint8_t)(payload_len >> 8);
    if (payload_len > 0) {
        memcpy(&out[LUMEN_HEADER_LEN], payload, payload_len);
    }
    uint16_t crc = lumen_protocol_crc16(out, (size_t)LUMEN_HEADER_LEN + payload_len);
    out[LUMEN_HEADER_LEN + payload_len] = (uint8_t)(crc & 0xFF);
    out[LUMEN_HEADER_LEN + payload_len + 1] = (uint8_t)(crc >> 8);
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

size_t lumen_protocol_encode_strip_config_report(uint8_t seq,
                                                 const uint8_t gpios[LUMEN_MAX_STRIPS],
                                                 uint8_t strip_count, uint8_t *out,
                                                 size_t out_cap)
{
    if (gpios == NULL) {
        return 0;
    }
    if (strip_count > LUMEN_MAX_STRIPS) {
        return 0;
    }
    /* 8 条固定记录：[strip_id, gpio, flags]，flags bit0 = 已分配（docs/protocol-v5.md §7.4）。 */
    uint8_t payload[LUMEN_MAX_STRIPS * 3];
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        uint8_t assigned = i < strip_count ? 1u : 0u;
        payload[i * 3] = i;
        payload[i * 3 + 1] = assigned != 0 ? gpios[i] : 0xFF;
        payload[i * 3 + 2] = assigned;
    }
    return lumen_protocol_encode(LUMEN_CMD_STRIP_CONFIG_REPORT, seq, payload, sizeof(payload),
                                 out, out_cap);
}

size_t lumen_protocol_encode_device_info_report(uint8_t seq, uint16_t firmware_version,
                                                const uint8_t hw_id[6], uint8_t caps,
                                                uint8_t *out, size_t out_cap)
{
    if (hw_id == NULL) {
        return 0;
    }
    /* 0..1 version | 2..7 hw_id | 8 max_leds | 9 max_strips | 10 max_parts |
     * 11 max_part_segs | 12 max_steps | 13 max_scenes | 14 caps（§7.4）。 */
    uint8_t payload[15];
    payload[0] = (uint8_t)(firmware_version & 0xFF);
    payload[1] = (uint8_t)(firmware_version >> 8);
    memcpy(&payload[2], hw_id, 6);
    payload[8] = LUMEN_MAX_LEDS;
    payload[9] = LUMEN_MAX_STRIPS;
    payload[10] = LUMEN_MAX_PARTS;
    payload[11] = LUMEN_MAX_PART_SEGS;
    payload[12] = LUMEN_MAX_STEPS;
    payload[13] = LUMEN_MAX_SCENES;
    payload[14] = caps;
    return lumen_protocol_encode(LUMEN_CMD_DEVICE_INFO_REPORT, seq, payload, sizeof(payload), out,
                                 out_cap);
}

size_t lumen_protocol_encode_layout_report(uint8_t seq, uint8_t strip_id, uint8_t part_id,
                                           uint8_t name_len, const uint8_t name[LUMEN_NAME_BYTES],
                                           uint8_t seg_count, uint8_t phase, const uint8_t seg[][2],
                                           uint8_t *out, size_t out_cap)
{
    if (name_len > LUMEN_NAME_BYTES || seg_count > LUMEN_MAX_PART_SEGS ||
        phase > LUMEN_PHASE_MAX) {
        return 0;
    }
    /*
     * 固定 45 字节（docs/protocol-v5.md §7.2）：
     *   strip | part | name_len | name[24] | seg_count | phase | 8 × (start, end)
     * 未用的段写 0/0。
     */
    uint8_t payload[LUMEN_LAYOUT_REPORT_BYTES];
    memset(payload, 0, sizeof(payload));
    payload[0] = strip_id;
    payload[1] = part_id;
    payload[2] = name_len;
    if (name != NULL && name_len > 0) {
        memcpy(&payload[3], name, name_len);
    }
    payload[27] = seg_count;
    payload[28] = phase;
    for (uint8_t i = 0; i < seg_count; ++i) {
        /* seg 为 NULL 时保持 0/0（调用方只能在 seg_count 为 0 时省略它）。 */
        if (seg != NULL) {
            payload[29 + i * 2] = seg[i][0];
            payload[29 + i * 2 + 1] = seg[i][1];
        }
    }
    return lumen_protocol_encode(LUMEN_CMD_LAYOUT_REPORT, seq, payload, sizeof(payload), out,
                                 out_cap);
}

size_t lumen_protocol_encode_layout_list_end(uint8_t seq, uint8_t strip_id, uint8_t part_mask,
                                             uint8_t *out, size_t out_cap)
{
    uint8_t payload[2] = {strip_id, part_mask};
    return lumen_protocol_encode(LUMEN_CMD_LAYOUT_LIST_END, seq, payload, sizeof(payload), out,
                                 out_cap);
}

size_t lumen_protocol_encode_scene_part_report(uint8_t seq, uint8_t scene_id, uint8_t strip_id,
                                               uint8_t part_id, uint8_t step_count, uint8_t loop,
                                               uint8_t on, uint8_t *out, size_t out_cap)
{
    uint8_t payload[6] = {scene_id, strip_id, part_id, step_count, loop, on};
    return lumen_protocol_encode(LUMEN_CMD_SCENE_PART_REPORT, seq, payload, sizeof(payload), out,
                                 out_cap);
}

size_t lumen_protocol_encode_scene_step_report(uint8_t seq, uint8_t scene_id, uint8_t strip_id,
                                               uint8_t part_id, uint8_t step_index,
                                               uint16_t duration_ms, const uint8_t layer0[9],
                                               const uint8_t layer1[9], uint8_t *out,
                                               size_t out_cap)
{
    if (layer0 == NULL) {
        return 0;
    }
    /* 与 SceneStep 同构（§7.4）：scene | strip | part | step | duration(2) | l0(9) | l1(9)。 */
    uint8_t payload[LUMEN_SCENE_STEP_BYTES];
    payload[0] = scene_id;
    payload[1] = strip_id;
    payload[2] = part_id;
    payload[3] = step_index;
    payload[4] = (uint8_t)(duration_ms & 0xFF);
    payload[5] = (uint8_t)(duration_ms >> 8);
    memcpy(&payload[6], layer0, 9);
    if (layer1 != NULL) {
        memcpy(&payload[15], layer1, 9);
    } else {
        /* 空层：type = 0xFF，参数 7 字节全 0、level 0（§7.1）。 */
        payload[15] = LUMEN_NO_EFFECT;
        memset(&payload[16], 0, 8);
    }
    return lumen_protocol_encode(LUMEN_CMD_SCENE_STEP_REPORT, seq, payload, sizeof(payload), out,
                                 out_cap);
}

size_t lumen_protocol_encode_scene_list_end(uint8_t seq, uint8_t scene_id, uint8_t name_len,
                                            const uint8_t name[LUMEN_NAME_BYTES], uint8_t *out,
                                            size_t out_cap)
{
    if (name_len > LUMEN_NAME_BYTES) {
        return 0;
    }
    uint8_t payload[LUMEN_SCENE_NAME_BYTES];
    memset(payload, 0, sizeof(payload));
    payload[0] = scene_id;
    payload[1] = name_len;
    if (name != NULL && name_len > 0) {
        memcpy(&payload[2], name, name_len);
    }
    return lumen_protocol_encode(LUMEN_CMD_SCENE_LIST_END, seq, payload, sizeof(payload), out,
                                 out_cap);
}
