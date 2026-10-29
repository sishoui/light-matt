# 01：开发环境就绪

**类型**：`wayfinder:task`（HITL — 需要你在本机执行安装）

## Question

能不能在这台机器上 `idf.py build` 一个 ESP-IDF 工程并烧进板子，同时微信开发者工具能用测试号真机预览一个小程序？

这个不解决，后面所有固件票都卡死。所以它必须先跑通，而且要把「环境问题」和「代码问题」彻底分开——装完就验证，不要等到写业务代码时才发现工具链缺失。

### 现状（已检测）

| 组件 | 状态 |
|---|---|
| ESP-IDF v5.4 源码 | ✅ `C:\Users\13092\esp\v5.4\esp-idf`，106 个 component 齐全 |
| ESP-IDF 工具链 | ❌ `C:\Espressif\tools` 下只有 `idf-git` 和 `idf-python`，**没有 riscv32-esp-elf** |
| `idf.py` 可用性 | ❌ `IDF_PATH` 未设置，环境未 export |
| Node / npm | ✅ v24.14.0 / 11.11.0 |
| Python | ✅ 3.12.10 |
| 微信开发者工具 | ✅ `C:\Program Files (x86)\Tencent\微信web开发者工具` |
| git | ✅ 2.53.0 |

### 要跑通的验证

1. 在 ESP-IDF 目录执行 `install.bat esp32c3`（或 `install.ps1`），装完 riscv32-esp-elf 工具链
2. `export.bat` 后 `idf.py --version` 有输出且 `IDF_PATH` 正确
3. 编译官方 `examples/get-started/hello_world` 并 `idf.py -p <COM> flash monitor`，串口看到输出
4. 微信开发者工具新建一个测试号项目，真机预览能打开空页面

## Blocked by

无（可以立刻开始）

## 状态

`ready-for-agent` — 本票我能驱动大部分（安装命令、环境脚本、验证清单），但**第 3、4 步需要你在本机操作**并把结果回传。

## 交付

- 一份 `docs/dev-environment.md`：安装步骤、环境变量怎么进每个新终端、串口驱动注意事项、常用命令速查
- 环境验证结论（通过 / 哪一步卡住 / 错误原文）

## 验收

- [ ] `idf.py --version` 在新终端可用，无需手动 export
- [ ] hello_world 编译 + 烧录 + 串口有输出
- [ ] 微信开发者工具真机预览可用
- [ ] `docs/dev-environment.md` 写完，别人照做能复现
