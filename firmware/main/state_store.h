#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "state.h"

/*
 * state_store：NVS 持久化骨架。
 * 上电加载一次；状态变更后 500ms debounce 写一次。本票不接命令。
 */

esp_err_t lumen_state_store_init(void);

/* 读回上次保存的状态。没有历史、数据损坏或字段越界时返回 false。 */
bool lumen_state_store_load(lumen_state_t *out);

/* 线程安全：只记录最新快照并重置 debounce 计时，不在调用者上下文写 NVS。 */
void lumen_state_store_request_save(const lumen_state_t *state);
