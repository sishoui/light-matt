idf_component_register(
    SRCS
        "app_main.c"
        "ble_link.c"
        "led_engine.c"
        "state_store.c"
        "state.c"
        "gamma.c"
        "protocol.c"
    INCLUDE_DIRS "."
    REQUIRES
        bt
        nvs_flash
        esp_driver_rmt
        esp_hw_support
        freertos
        log
)
