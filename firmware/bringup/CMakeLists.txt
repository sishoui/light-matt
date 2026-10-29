cmake_minimum_required(VERSION 3.16)

# 独立的 #4 灯带 bring-up 工程：只做点灯与电气观察，不含 BLE / 协议。
# 正式固件在 ../（firmware/CMakeLists.txt）。本工程不参与产品构建。
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(lumen_bringup)
