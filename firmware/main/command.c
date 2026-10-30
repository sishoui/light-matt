#include "command.h"

#include <stddef.h>

#include "effects.h"

bool lumen_command_is_known(uint8_t command)
{
    /*
     * 只包含「已实现」的命令（docs/protocol.md §6.1）。0x03 / 0x04 在 v2 退役，
     * 0x13-0x1A 由 #32 加入；两者现在都落到 default → 0x02 未知命令，
     * 小程序能明确看到「该命令需要升级固件」。
     */
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
    case LUMEN_CMD_QUERY_STATE:
    case LUMEN_CMD_SET_LED_COUNT:
    case LUMEN_CMD_SELF_TEST:
    case LUMEN_CMD_SET_SEGMENT:
    case LUMEN_CMD_CLEAR_SEGMENT:
    case LUMEN_CMD_QUERY_STRIP:
        return true;
    default:
        return false;
    }
}

uint8_t lumen_command_payload_len(uint8_t command)
{
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
        return 1;
    case LUMEN_CMD_QUERY_STATE:
    case LUMEN_CMD_SELF_TEST:
        return 0;
    case LUMEN_CMD_SET_LED_COUNT:
        /* v2：strip_id + count 小端（docs/protocol.md §6）。 */
        return 3;
    case LUMEN_CMD_CLEAR_SEGMENT:
        return 2;
    case LUMEN_CMD_QUERY_STRIP:
        return 1;
    case LUMEN_CMD_SET_SEGMENT:
        /* 变长（8 或 12）：期望长度取决于 type，用 lumen_command_payload_len_ok 判定。
         * 这里返回 0 表示「不是固定长度」，调用方不能拿它做等值比较。 */
        return 0;
    default:
        return 0;
    }
}

bool lumen_command_payload_len_ok(const lumen_frame_t *frame)
{
    if (frame == NULL) {
        return false;
    }
    if (frame->command == LUMEN_CMD_SET_SEGMENT) {
        /*
         * §11.3 第 3 步 + 21-design §8 的注解：先读 type 再定长。
         * 载荷连 type 都读不到（< 5）时是 BadLength；type 已知但长度不符也是
         * BadLength；type 未知时长度无从判定，放行给第 4 步回 InvalidParam。
         */
        if (frame->payload_len < 5) {
            return false;
        }
        uint8_t param_len = lumen_effect_param_len(frame->payload[4]);
        if (param_len == 0) {
            /* 未知 type：第 4 步会拒绝，这里不做长度判定。 */
            return true;
        }
        return frame->payload_len == (uint8_t)(5 + param_len);
    }
    return frame->payload_len == lumen_command_payload_len(frame->command);
}

/*
 * SetPower 0x01：载荷 1 字节，只接受 0 / 1。
 * 与当前 power 相同时不 commit（避免无意义的刷新与 NVS 写入），ACK 仍为 0x00。
 */
static void dispatch_set_power(const lumen_frame_t *frame, const lumen_state_t *current,
                               lumen_command_outcome_t *outcome)
{
    if (frame->payload_len != 1) {
        outcome->result_code = LUMEN_RESULT_BAD_LENGTH;
        return;
    }
    uint8_t power = frame->payload[0];
    if (power > 1) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    if (current->power != power) {
        outcome->next.power = power;
        outcome->state_changed = true;
    }
}

/*
 * SetBrightness 0x02：载荷 1 字节 0-255，按 §11.4 钳位到构建期上限。
 *
 * 关键语义：
 *  - 越界不拒绝：钳位后照常回 0x00（协议 §6 的 SetBrightness 没有错误码）。
 *  - 只写 brightness，绝不动 power：亮度 0 是合法状态，视觉等于关灯，
 *    但设备状态里 power 仍为 1；关灯也保留亮度（§7）。
 *  - 钳位后的值与当前值相同则不 commit（避免无意义的渲染与 NVS 写入）。
 */
static void dispatch_set_brightness(const lumen_frame_t *frame,
                                    const lumen_state_t *current, uint8_t max_brightness,
                                    lumen_command_outcome_t *outcome)
{
    uint8_t requested = frame->payload[0];
    uint8_t effective = lumen_state_clamp_brightness(requested, max_brightness);

    outcome->result_code = LUMEN_RESULT_OK;
    if (current->brightness != effective) {
        outcome->next.brightness = effective;
        outcome->state_changed = true;
    }
}

bool lumen_command_changes_state(uint8_t command)
{
    /* 协议 §11.2 第 5 条列出的改变状态命令；QueryState / SelfTest / QueryStrip 不在其中。
     * v2 的 0x03 / 0x04 已退役，不再属于这一类别。 */
    switch (command) {
    case LUMEN_CMD_SET_POWER:
    case LUMEN_CMD_SET_BRIGHTNESS:
    case LUMEN_CMD_SET_LED_COUNT:
    case LUMEN_CMD_SET_SEGMENT:
    case LUMEN_CMD_CLEAR_SEGMENT:
        return true;
    default:
        return false;
    }
}

/*
 * SetLedCount 0x06：v2 载荷 3 字节 strip_id, count_lo, count_hi，合法数量 1-64（§6）。
 *
 * 关键语义（§11.3）：
 *  - 这里只校验并标记「需要重建」。数量必须在渲染任务重建 led_strip 成功后
 *    才写入共享状态，ACK 也要等重建结果——所以本 reducer 不改 next、
 *    state_changed 保持 false，由 led_engine 在重建完成时提交 / 回滚。
 *  - strip_id 必须先落在 0 ≤ strip_id < strip_count 内（#29 之后多条灯带各自
 *    独立设置灯珠数）。先校验 strip_id 再校验数量，保证「这条命令到底改
 *    哪条灯带」先被确认。
 *  - 越界（0、>64、小端读出的 65535 等）→ 0x01，不请求重建、不改状态。
 */
static void dispatch_set_led_count(const lumen_frame_t *frame, const lumen_state_t *current,
                                   lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    if (strip_id >= current->strip_count || strip_id >= LUMEN_MAX_STRIPS) {
        /* 不存在的灯带：拒绝而不是静默忽略，否则用户以为设成功但没反应。 */
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    uint16_t count = (uint16_t)(frame->payload[1] | ((uint16_t)frame->payload[2] << 8));
    if (count < 1 || count > LUMEN_MAX_LEDS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->led_count_rebuild = true;
    outcome->led_count = count;
    outcome->led_count_strip = strip_id;
}

/*
 * 从 SetSegment 载荷解析段配置。
 *
 * 载荷布局（docs/protocol.md §6）：
 *   0 strip_id | 1 seg_id | 2 start | 3 end | 4 type | 5.. params
 *
 * 静态参数（§2.1，3 字节）：5-6 hue 小端 | 7 sat。
 * 动画参数（§2.2-§2.4，7 字节）：5-6 hue | 7 sat | 8-9 period_ms 小端 | 10 p5 | 11 flags。
 *
 * 调用方已确认 payload_len 与 type 的期望长度一致（第 3 步），所以这里
 * 按 param_len 而不是按 payload_len 读取——未知 type 走不到这里。
 */
static void parse_segment_payload(const lumen_frame_t *frame, lumen_segment_t *seg)
{
    seg->active = true;
    seg->start = frame->payload[2];
    seg->end = frame->payload[3];
    seg->type = frame->payload[4];
    seg->hue = (uint16_t)(frame->payload[5] | ((uint16_t)frame->payload[6] << 8));
    seg->sat = frame->payload[7];
    seg->period_ms = 0;
    seg->p5 = 0;
    seg->flags = 0;
    seg->t0_ms = 0; /* 生效时刻由 led_engine 在真正写入时填 */

    if (lumen_effect_param_len(seg->type) > 3u) {
        /* 动画类共用 hue(2)+sat(1)+period(2)+p5(1)+flags(1) 的前缀布局。 */
        seg->period_ms = (uint16_t)(frame->payload[8] | ((uint16_t)frame->payload[9] << 8));
        seg->p5 = frame->payload[10];
        seg->flags = frame->payload[11];
    }
}

/*
 * 取某条灯带的灯珠数：优先用 #29 的 per-strip 表，没有表（单灯带 / host 单测）
 * 时退回 State 的 strip 0 值。越界/未初始化时按协议上限处理。
 */
uint16_t lumen_command_strip_count(const lumen_state_t *current, const uint16_t *strip_counts,
                                   uint8_t strip_id)
{
    if (current == NULL) {
        return 0;
    }
    uint16_t count = 0;
    if (strip_counts != NULL && strip_id < LUMEN_MAX_STRIPS) {
        count = strip_counts[strip_id];
    }
    if (count == 0) {
        count = current->led_count; /* 单灯带 / 未提供表：退回 strip 0 值 */
    }
    if (count == 0 || count > LUMEN_MAX_LEDS) {
        count = LUMEN_MAX_LEDS; /* 防御：状态未初始化时按协议上限 */
    }
    return count;
}

/*
 * SetSegment 0x10（#25 / #30 / #31）。
 *
 * 校验顺序严格按 docs/protocol.md §11.3：
 *   3 载荷长度（在 lumen_command_payload_len_ok / 上方完成，先读 type 再定长）
 *   4 type 已知
 *   5-9 strip 范围 / 区间 / 重叠 / flags / 周期 —— lumen_segment_store_validate
 *
 * 四种灯效全部已实现（#31 起彩虹 / 流光也可下发）。类型→载荷长度的映射来自
 * lumen_effect_param_len（静态 3、其余 7），flags 保留位与周期下限按类型
 * 分别判定（呼吸 bit3-7 / ≥334，彩虹·流光 bit1-7 / ≥200）——这些都集中在
 * segment_store 的第 8/9 步，命令层不再各写一份。
 *
 * 保留 implemented 检查：它现在是全真，但协议未来新增类型时旧固件会在这里
 * 明确回 UnknownCommand（而不是静默变黑），与 §6.1 同一原则（D7）。
 */
static void dispatch_set_segment(const lumen_frame_t *frame, const lumen_state_t *current,
                                 const lumen_segment_store_t *segments,
                                 const uint16_t *strip_counts,
                                 lumen_command_outcome_t *outcome)
{
    if (frame->payload_len < 5) {
        outcome->result_code = LUMEN_RESULT_BAD_LENGTH;
        return;
    }
    uint8_t type = frame->payload[4];
    if (!lumen_effect_type_known(type)) {
        /* 第 4 步：type 未知 → InvalidParam。 */
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (frame->payload_len != (uint8_t)(5 + lumen_effect_param_len(type))) {
        /* 第 3 步（type 已知后才能定长）：长度不符 → BadLength。 */
        outcome->result_code = LUMEN_RESULT_BAD_LENGTH;
        return;
    }
    if (!lumen_effect_type_implemented(type)) {
        /* 协议已知但本固件未实现：明确回 UnknownCommand，不假装成功。 */
        outcome->result_code = LUMEN_RESULT_UNKNOWN_COMMAND;
        return;
    }

    lumen_segment_t candidate;
    parse_segment_payload(frame, &candidate);

    /* 第 5-9 步。段配置快照为 NULL 时视为「没有任何活动段」，区间校验照常。 */
    static const lumen_segment_store_t k_empty_store;
    const lumen_segment_store_t *store = segments != NULL ? segments : &k_empty_store;

    uint8_t strip_id = frame->payload[0];
    uint8_t seg_id = frame->payload[1];
    if (seg_id >= LUMEN_MAX_SEGMENTS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    /*
     * 灯珠数必须按「这条灯带自己」的数字校验（#29）。current->led_count 只是
     * strip 0 的；拿它校验 strip 3 会放行真实越界（设成功但后半段不亮），
     * 或误拒合法段。
     */
    uint16_t led_count = lumen_command_strip_count(current, strip_counts, strip_id);

    uint8_t result = lumen_segment_store_validate(store, strip_id, current->strip_count, seg_id,
                                                  (uint8_t)led_count, &candidate);
    outcome->result_code = result;
    if (result != LUMEN_RESULT_OK) {
        return;
    }

    /* 校验通过：把写入意图交给调用方（段配置不在 lumen_state_t 里）。 */
    outcome->segment_op = true;
    outcome->segment_clear = false;
    outcome->segment_strip = strip_id;
    outcome->segment_id = seg_id;
    outcome->segment = candidate;
}

/*
 * ClearSegment 0x11（#25）：释放槽位，其灯珠归入未覆盖区（写 0）。
 * 幂等：清一个本来就不活动的槽位也回 0x00（命令是绝对值语义）。
 */
static void dispatch_clear_segment(const lumen_frame_t *frame, const lumen_state_t *current,
                                   lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    uint8_t seg_id = frame->payload[1];
    if (strip_id >= current->strip_count || strip_id >= LUMEN_MAX_STRIPS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    if (seg_id >= LUMEN_MAX_SEGMENTS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->segment_op = true;
    outcome->segment_clear = true;
    outcome->segment_strip = strip_id;
    outcome->segment_id = seg_id;
}

/*
 * QueryStrip 0x12（#25）：只做 strip 范围校验，真正的多帧回包由 ble_link
 * 在 ACK 之后发出（seg_count 条 SegmentReport + 1 条 SegmentListEnd，同 seq）。
 */
static void dispatch_query_strip(const lumen_frame_t *frame, const lumen_state_t *current,
                                 lumen_command_outcome_t *outcome)
{
    uint8_t strip_id = frame->payload[0];
    if (strip_id >= current->strip_count || strip_id >= LUMEN_MAX_STRIPS) {
        outcome->result_code = LUMEN_RESULT_INVALID_PARAM;
        return;
    }
    outcome->result_code = LUMEN_RESULT_OK;
    outcome->strip_query = true;
    outcome->query_strip_id = strip_id;
}

void lumen_command_dispatch(const lumen_frame_t *frame, const lumen_state_t *current,
                            const lumen_segment_store_t *segments,
                            const uint16_t *strip_counts, uint8_t max_brightness,
                            lumen_command_outcome_t *outcome)
{
    if (frame == NULL || current == NULL || outcome == NULL) {
        return;
    }

    /* 默认：状态不变、结果码未知、不碰自检，等具体分支覆盖。 */
    outcome->result_code = LUMEN_RESULT_UNKNOWN_COMMAND;
    outcome->state_changed = false;
    outcome->start_selftest = false;
    outcome->cancels_selftest = false;
    outcome->state_report = false;
    outcome->led_count_rebuild = false;
    outcome->led_count = current->led_count;
    outcome->led_count_strip = 0;
    outcome->segment_op = false;
    outcome->segment_clear = false;
    outcome->segment_strip = 0;
    outcome->segment_id = 0;
    outcome->segment = (lumen_segment_t){0};
    outcome->strip_query = false;
    outcome->query_strip_id = 0;
    outcome->next = *current;

    /*
     * §11.3 顺序：command (0x02) → payload 长度 (0x04) → payload 取值 (0x01)。
     * 先判命令字是否协议已知，再判该命令的载荷长度，最后才看取值。
     */
    if (!lumen_command_is_known(frame->command)) {
        return; /* 0x08-0xFF（含保留命令、app 写入 0x80）→ 0x02 */
    }

    if (!lumen_command_payload_len_ok(frame)) {
        outcome->result_code = LUMEN_RESULT_BAD_LENGTH;
        return;
    }

    switch (frame->command) {
    case LUMEN_CMD_SET_POWER:
        dispatch_set_power(frame, current, outcome);
        break;

    case LUMEN_CMD_SET_BRIGHTNESS:
        dispatch_set_brightness(frame, current, max_brightness, outcome);
        break;

    case LUMEN_CMD_SET_LED_COUNT:
        /*
         * #12 实现重建语义；这里**不能 return**——必须走到下面的统一收尾，
         * 否则 SetLedCount 不会置 cancels_selftest（§11.2 第 5 条要求灯珠
         * 数量变更同样立即取消自检）。
         */
        dispatch_set_led_count(frame, current, outcome);
        break;

    case LUMEN_CMD_SET_SEGMENT:
        dispatch_set_segment(frame, current, segments, strip_counts, outcome);
        break;

    case LUMEN_CMD_CLEAR_SEGMENT:
        dispatch_clear_segment(frame, current, outcome);
        break;

    case LUMEN_CMD_QUERY_STRIP:
        dispatch_query_strip(frame, current, outcome);
        break;

    case LUMEN_CMD_QUERY_STATE:
        /* §6.1：回 ACK 0x00，随后由调用方补一条 StateReport。
         * 查询不取消自检（§11.2 第 6 条），也不改共享状态。 */
        outcome->result_code = LUMEN_RESULT_OK;
        outcome->state_report = true;
        break;

    case LUMEN_CMD_SELF_TEST:
        /* §11.2 第 1 条：立即回 ACK 0x00；序列由调用方启动。
         * 自检不改共享状态（不写 NVS），因此 state_changed 保持 false。 */
        outcome->result_code = LUMEN_RESULT_OK;
        outcome->start_selftest = true;
        break;

    default:
        /* lumen_command_is_known 已过滤，走不到这里；防御性回 0x02。 */
        outcome->result_code = LUMEN_RESULT_UNKNOWN_COMMAND;
        break;
    }

    /*
     * 统一收尾（协议 §11.2 第 5 条）：只要命令属于「改变状态」的类别且已
     * 被接受，就要求调用方结束自检——即使 state_changed 为 false（值没变）。
     * 非法命令（0x01 / 0x02 / 0x04）不取消自检，因为新命令并未生效。
     */
    outcome->cancels_selftest =
        outcome->result_code == LUMEN_RESULT_OK && lumen_command_changes_state(frame->command);
}
