#include "chunk_reasm.h"

#include <string.h>

void lumen_reasm_init(lumen_reasm_t *reasm)
{
    if (reasm == NULL) {
        return;
    }
    memset(reasm, 0, sizeof(*reasm));
    reasm->have_header = false;
}

bool lumen_reasm_reset(lumen_reasm_t *reasm)
{
    if (reasm == NULL) {
        return false;
    }
    /*
     * 只按 active 判断「是否丢弃了半截数据」：COMPLETE 之后 active 已经是 false，
     * 但 len / data 仍然有效（调用方要读），所以不能拿 len != 0 当依据。
     * first_header 也不清：OVERFLOW 之后调用方仍要拿它回 ACK，下一次 FIRST 覆盖。
     */
    bool had = reasm->active;
    reasm->len = 0;
    reasm->active = false;
    reasm->last_index = 0;
    reasm->last_ms = 0;
    return had;
}

/* 1000ms 从上一个分片起算；正好 1000ms 已算超时。无符号减法，回绕安全。 */
static bool is_expired(const lumen_reasm_t *reasm, uint32_t now_ms)
{
    return reasm->active && (uint32_t)(now_ms - reasm->last_ms) >= LUMEN_REASM_TIMEOUT_MS;
}

lumen_reasm_status_t lumen_reasm_feed(lumen_reasm_t *reasm, uint8_t ctrl, const uint8_t *data,
                                      size_t len, uint32_t now_ms)
{
    if (reasm == NULL) {
        return LUMEN_REASM_IGNORED;
    }
    if (len > 0 && data == NULL) {
        return LUMEN_REASM_IGNORED;
    }

    /*
     * 超时的旧缓冲在下一个分片到达时就地丢弃。渲染任务的 1s 兜底只是
     * 「没人再来」时的清理；这里先判一次，避免把新分片接在早已过期的数据后面。
     */
    if (is_expired(reasm, now_ms)) {
        lumen_reasm_reset(reasm);
    }

    bool first = (ctrl & LUMEN_CHUNK_FIRST) != 0;
    bool last = (ctrl & LUMEN_CHUNK_LAST) != 0;

    if (first) {
        /* 规则 1：latest-wins。旧缓冲（若有）直接丢弃，不回报错误。 */
        reasm->len = 0;
        reasm->active = true;
        reasm->have_header = false;
    } else if (!reasm->active) {
        /* 没有 FIRST 的尾巴分片：无从拼起，静默丢弃（不发 ACK）。 */
        return LUMEN_REASM_IGNORED;
    }

    reasm->last_index = (uint8_t)(ctrl & LUMEN_CHUNK_INDEX_MASK);
    reasm->last_ms = now_ms;

    /* 规则 2：累计超过 240 → 丢弃缓冲，调用方回 BadLength。 */
    if (len > 0) {
        if ((size_t)reasm->len + len > LUMEN_REASM_CAPACITY) {
            lumen_reasm_reset(reasm);
            return LUMEN_REASM_OVERFLOW;
        }
        memcpy(&reasm->data[reasm->len], data, len);
        reasm->len = (uint16_t)(reasm->len + len);
        /* 首片里的前 4 字节是唯一可靠的 header，溢出后仍要能回 ACK。 */
        if (!reasm->have_header && reasm->len >= sizeof(reasm->first_header)) {
            memcpy(reasm->first_header, reasm->data, sizeof(reasm->first_header));
            reasm->have_header = true;
        }
    }

    if (!last) {
        return LUMEN_REASM_PENDING;
    }

    /*
     * 规则 3：完成。约定「len 有效时 active 已为 false」，调用方读完 data 后
     * 不需要再清；下一次 FIRST 会重新开始。
     */
    reasm->active = false;
    if (reasm->len == 0) {
        /* LAST 单独到达（空帧）：没有可解析的内容，按溢出同类处理会让上层
         * 回 BadLength；但空逻辑帧本身也不合法（最短 8 字节），交给解码器的
         * SILENT 更准确，所以这里回 IGNORED。 */
        return LUMEN_REASM_IGNORED;
    }
    return LUMEN_REASM_COMPLETE;
}

bool lumen_reasm_expire(lumen_reasm_t *reasm, uint32_t now_ms)
{
    if (reasm == NULL || !reasm->active) {
        return false;
    }
    if (!is_expired(reasm, now_ms)) {
        return false;
    }
    /* 规则 4：超时丢弃，不回 ACK（seq 可能已不可靠）。 */
    lumen_reasm_reset(reasm);
    return true;
}

uint8_t lumen_reasm_chunk_count(size_t frame_len, uint8_t capacity)
{
    if (capacity == 0 || frame_len == 0) {
        return 0;
    }
    size_t count = (frame_len + capacity - 1) / capacity;
    return count > 0xFF ? 0xFF : (uint8_t)count;
}

size_t lumen_reasm_build_chunk(const uint8_t *frame, size_t frame_len, uint8_t capacity,
                               uint8_t index, uint8_t *out, size_t out_cap)
{
    if (frame == NULL || out == NULL || capacity == 0) {
        return 0;
    }
    size_t offset = (size_t)index * capacity;
    if (offset >= frame_len) {
        return 0;
    }
    size_t slice = frame_len - offset;
    if (slice > capacity) {
        slice = capacity;
    }

    uint8_t ctrl = (uint8_t)(index & LUMEN_CHUNK_INDEX_MASK);
    if (index == 0) {
        ctrl |= LUMEN_CHUNK_FIRST;
    }
    if (offset + slice == frame_len) {
        ctrl |= LUMEN_CHUNK_LAST;
    }
    if (out_cap < slice + 1) {
        return 0;
    }
    out[0] = ctrl;
    memcpy(&out[1], &frame[offset], slice);
    return slice + 1;
}
