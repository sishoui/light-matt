#include "state_blob.h"

#include <string.h>

#include "protocol.h"

static const uint8_t s_blob_magic[4] = {'L', 'M', 'E', 'N'};

#define BLOB_OFF_VERSION 4
#define BLOB_OFF_POWER 6
#define BLOB_OFF_BRIGHTNESS 7
#define BLOB_OFF_STRIP_COUNT 8
#define BLOB_OFF_STRIP_POWER_MASK 9
#define BLOB_OFF_ACTIVE_SCENE 10
#define BLOB_OFF_RESERVED 11
#define BLOB_OFF_LED_COUNT 16

size_t lumen_state_blob_encode(const lumen_persist_t *state,
                               uint8_t out[LUMEN_STATE_BLOB_SIZE])
{
    if (state == NULL || out == NULL) {
        return 0;
    }
    memset(out, 0, LUMEN_STATE_BLOB_SIZE);
    memcpy(&out[0], s_blob_magic, sizeof(s_blob_magic));
    out[BLOB_OFF_VERSION] = (uint8_t)(LUMEN_STATE_BLOB_VERSION & 0xFF);
    out[BLOB_OFF_VERSION + 1] = (uint8_t)(LUMEN_STATE_BLOB_VERSION >> 8);

    const lumen_state_t *s = &state->state;
    out[BLOB_OFF_POWER] = s->power;
    out[BLOB_OFF_BRIGHTNESS] = s->brightness;
    out[BLOB_OFF_STRIP_COUNT] = s->strip_count;
    out[BLOB_OFF_STRIP_POWER_MASK] = s->strip_power_mask;
    out[BLOB_OFF_ACTIVE_SCENE] = s->active_scene;
    /* 11..15 保留字节已由 memset 清零（§10.2 要求为 0）。 */

    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        uint16_t n = s->led_count[i];
        out[BLOB_OFF_LED_COUNT + i * 2] = (uint8_t)(n & 0xFF);
        out[BLOB_OFF_LED_COUNT + i * 2 + 1] = (uint8_t)(n >> 8);
    }
    return LUMEN_STATE_BLOB_SIZE;
}

bool lumen_state_blob_decode(const uint8_t *blob, size_t len, lumen_persist_t *out)
{
    if (blob == NULL || out == NULL || len != LUMEN_STATE_BLOB_SIZE) {
        return false;
    }
    if (memcmp(&blob[0], s_blob_magic, sizeof(s_blob_magic)) != 0) {
        return false;
    }
    uint16_t version =
        (uint16_t)blob[BLOB_OFF_VERSION] | ((uint16_t)blob[BLOB_OFF_VERSION + 1] << 8);
    if (version != LUMEN_STATE_BLOB_VERSION) {
        /*
         * 任何别的版本（含 v4 的 5）整体拒绝：v4 的 blob 是「状态 + 段表」
         * 1440 字节，布局与含义都不同，绝不能「尽量解析」——错位的段表会写出
         * 越界区间。调用方因此回落到协议默认值（一次干净的重置，不是半套状态），
         * 这也正是「刷机后设备配置回到默认值」的实现来源。
         */
        return false;
    }

    uint8_t power = blob[BLOB_OFF_POWER];
    uint8_t strip_count = blob[BLOB_OFF_STRIP_COUNT];
    uint8_t active_scene = blob[BLOB_OFF_ACTIVE_SCENE];
    if (power > 1 || strip_count < 1 || strip_count > LUMEN_MAX_STRIPS ||
        active_scene >= LUMEN_MAX_SCENES) {
        return false;
    }
    /* 保留字节按契约必须为 0；非 0 说明 blob 来自别的格式。 */
    for (uint8_t i = BLOB_OFF_RESERVED; i < BLOB_OFF_LED_COUNT; ++i) {
        if (blob[i] != 0) {
            return false;
        }
    }

    lumen_persist_t decoded;
    memset(&decoded, 0, sizeof(decoded));
    decoded.state.power = power;
    decoded.state.brightness = blob[BLOB_OFF_BRIGHTNESS];
    decoded.state.strip_count = strip_count;
    decoded.state.strip_power_mask = blob[BLOB_OFF_STRIP_POWER_MASK];
    decoded.state.active_scene = active_scene;
    /*
     * layout_valid 不持久化在 state 键里：它由布局键的加载结果决定
     * （有布局 blob 就是 1）。这里先置 0，加载完布局后由引擎置位。
     */
    decoded.state.layout_valid = 0;
    /* part_count 来自布局键，不在 State blob 里；先全 0。 */
    for (uint8_t i = 0; i < LUMEN_MAX_STRIPS; ++i) {
        uint16_t n = (uint16_t)blob[BLOB_OFF_LED_COUNT + i * 2] |
                     ((uint16_t)blob[BLOB_OFF_LED_COUNT + i * 2 + 1] << 8);
        if (i < strip_count) {
            if (n < 1 || n > LUMEN_MAX_LEDS) {
                return false;
            }
        } else if (n != 0) {
            /* 未配置的槽位必须是 0（§7.3「未用的槽位为 0」）。 */
            return false;
        }
        decoded.state.led_count[i] = n;
    }

    *out = decoded; /* 全部通过才写：绝不半套加载 */
    return true;
}
