# 开发环境

目标：在这台 Windows 机器上能 `idf.py build/flash` ESP-IDF v5.4 工程，并能用微信开发者工具真机预览小程序。

> **当前 IDF 版本：v5.4.4**（2026-10-30 从 v5.4.0 升级，见 `docs/agents/issue-tracker.md` 与 GitHub #26）。
> 升级原因：多引脚 TDM 方案依赖 `rmt_tx_switch_gpio()`，它**只在 v5.4.2 及以后存在**。
> 升级后已验证 `rmt_tx_switch_gpio` 链接进 `lumen.elf`（符号 `T`，地址 `0x420412c8`）。

## 组件位置

| 组件 | 位置 / 版本 |
|---|---|
| ESP-IDF | `C:\Users\13092\esp\v5.4\esp-idf`（**v5.4.4**，detached HEAD 在 tag 上） |
| IDF 工具 | `C:\Espressif\tools`（`IDF_TOOLS_PATH=C:\Espressif`） |
| IDF Python | `C:\Espressif\tools\idf-python\3.11.2` |
| IDF Git | `C:\Espressif\tools\idf-git\2.44.0` |
| riscv32-esp-elf | `esp-14.2.0_20260121`（v5.4.4 要求，旧的 `20241119` 不够） |
| riscv32-esp-elf-gdb | `16.3_20250913` |
| ccache / openocd | `4.12.1` / `v0.12.0-esp32-20260304` |
| 系统 Python | 3.12.10 |
| Node / npm | v24.14.0 / 11.11.0 |
| 微信开发者工具 | `C:\Program Files (x86)\Tencent\微信web开发者工具` |

## v5.4.0 → v5.4.4 升级记录（2026-10-30）

实际踩到的两个坑，重装环境时会重现：

**坑 1：Python 新增依赖 `tree_sitter` / `tree_sitter_c`。** v5.4.4 的构建工具新引入这两个包，缺了会让 `export.bat` 报
`Error while checking requirement 'tree_sitter'` 后直接退出。补装：

```bat
C:\Espressif\python_env\idf5.4_py3.11_env\Scripts\python.exe -m pip install ^
  "tree-sitter" "tree-sitter-c>=0.21.4" --only-binary tree-sitter-c ^
  -c C:\Espressif\espidf.constraints.v5.4.txt
```

**坑 2：工具链版本整体换代。** v5.4.4 要求 riscv32-esp-elf `esp-14.2.0_20260121`（原 `20241119`）、
gdb `16.3_20250913`、ccache `4.12.1`、openocd `v0.12.0-esp32-20260304`。旧版会让 `export.bat` 报
`tool riscv32-esp-elf has no installed versions`。补装：

```bat
cd /d C:\Users\13092\esp\v5.4\esp-idf
set "MSYSTEM="
set "IDF_TOOLS_PATH=C:\Espressif"
C:\Espressif\python_env\idf5.4_py3.11_env\Scripts\python.exe tools\idf_tools.py install ^
  riscv32-esp-elf riscv32-esp-elf-gdb ccache openocd-esp32
```

**升级后的回归结果（全部通过）**：固件 host 测试 1426 项、小程序 vitest 159 个用例、`tsc --noEmit` 干净、
`build-firmware.cmd` 构建成功且分区余量 **66%**（升级前 62%，变小是因为新 GCC 的代码生成差异，不是退步）。

**回滚方式**：`git -C C:\Users\13092\esp\v5.4\esp-idf checkout v5.4`（原 HEAD 为 `67c1de1eeb`），
然后重跑 `idf_tools.py install` 装回旧工具链。子模块需 `git submodule update --init --recursive`。

## 首次安装（可复现）

`install.bat` 必须在 **cmd.exe** 里运行，且不能带 `MSYSTEM`（Git Bash 会设置它，脚本会直接拒绝）。用批处理包装：

```bat
@echo off
set "MSYSTEM="
set "PATH=C:\Espressif\tools\idf-python\3.11.2;C:\Espressif\tools\idf-git\2.44.0\cmd;%PATH%"
set "IDF_TOOLS_PATH=C:\Espressif"
cd /d C:\Users\13092\esp\v5.4\esp-idf

call install.bat esp32c3
python tools\idf_tools.py install cmake ninja idf-exe
```

`install.bat` 会装 riscv32-esp-elf / gdb / cmake / ninja / idf-exe / ccache / openocd 等，并创建 Python 环境。下载走 GitHub，国内网络可能较慢；失败就重跑同一条命令，已下载的包会复用。

## 每个新终端

`export.bat` 只对 cmd.exe 生效。**建议 IDF 命令都在 cmd.exe 里跑**：

```bat
C:\Users\13092\esp\v5.4\esp-idf\export.bat
idf.py --version
```

PowerShell：

```powershell
. C:\Users\13092\esp\v5.4\esp-idf\export.ps1
idf.py --version
```

Git Bash 里不要直接 `source export.sh`；用包装脚本或 `cmd.exe //c`：

```bash
cmd.exe //c "call C:\Users\13092\esp\v5.4\esp-idf\export.bat && idf.py --version"
```

仓库根目录提供 `scripts/idf.cmd`，Git Bash 里可以这样用：

```bash
cmd.exe //c "scripts\idf.cmd --version"
cmd.exe //c "scripts\idf.cmd -C firmware build"
```

## 烧录与串口

1. 用 USB 线把 ESP32-C3 开发板接到电脑。
2. 确认端口出现：
   - 原生 USB Serial/JTAG：设备名 `USB 串行设备 (COMx)`，VID `303A`。
   - 板载 USB-UART 桥：`USB-SERIAL CH340 (COMx)` 或 `CP210x`。
   - 若端口没出现：装 CH340 / CP210x 驱动；原生 USB-JTAG 在 Windows 10+ 自带驱动。
3. 烧录并看日志：

```bat
idf.py -p COM6 flash monitor
```

- 退出 monitor：`Ctrl+]`。
- 串口默认 115200。
- 找不到端口时先 `idf.py -p COM6 monitor` 单独试；仍失败就换线/换 USB 口。

## led_strip 依赖

```bat
idf.py add-dependency espressif/led_strip
idf.py build
```

组件会从 Espressif Component Registry 拉取。第一次构建需要联网；之后走 `managed_components/` 缓存（已在 `.gitignore`）。

## 微信开发者工具

1. 打开微信开发者工具，导入 `miniprogram/` 目录。
2. `project.config.json` 里 `appid` 目前是 `touristappid`。**真机预览需要换成你的测试号 AppID**（测试号在公众平台申请，BLE 不依赖服务器域名）。
   > 注：当前开发者工具版本用 CLI `open --project` 打开 `touristappid` 会报 `code 10：不存在此 AppID`。真机预览必须先在 IDE 里导入项目并使用「测试号」，或填入测试号 AppID。
3. 模拟器只能模拟部分蓝牙接口；**完整 BLE 功能必须真机调试**。
4. 真机预览步骤：工具栏「预览」→ 手机微信扫码 → 打开小程序。
5. 平台差异：
   - Android 6.0+ 扫描需要定位权限与定位开关；8.0.16 之前无权限是静默扫不到。
   - iOS 需要 `scope.bluetooth` 授权，失败回调带 `state`（0 未知 / 1 重置中 / 2 不支持 / 3 未授权 / 4 未开启）。
   - iOS 不支持 `wx.setBLEMTU`；超长写入可能既无 success 也无 fail。

## 常用命令

| 目的 | 命令 |
|---|---|
| 查看 IDF 版本 | `idf.py --version` |
| 配置目标 | `idf.py set-target esp32c3` |
| 编译 | `idf.py build` |
| 构建固件（中文路径安全） | `scripts\build-firmware.cmd` |
| 烧录固件 | `scripts\flash-firmware.cmd COM6` |
| 烧录 + 监视 | `idf.py -p COMx flash monitor` |
| 只监视 | `idf.py -p COMx monitor` |
| 清理 | `idf.py fullclean` |
| 添加组件 | `idf.py add-dependency espressif/led_strip` |
| 查看串口 | `mode` / 设备管理器；或 `powershell -Command "Get-CimInstance Win32_SerialPort"` |
| 打开小程序项目 | `"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" open --project <path>` |

## 验证结果

- [x] 工具链安装完成（riscv32-esp-elf 14.2.0、gdb 14.2、cmake 3.30.2、ninja 1.12.1、idf-exe 1.0.3、ccache 4.10.2）
- [x] `idf.py --version` → `ESP-IDF v5.4`
- [x] hello_world 烧录 + 串口输出（COM6，`Hello world!`，ESP-IDF v5.4，chip rev v0.4）
- [ ] 真机预览打开页面（需要测试号 AppID 与手机扫码）

## 已知问题

- `idf.py add-dependency` 之后如果 `build` 报 `led_strip.h: No such file or directory`，跑一次 `idf.py reconfigure` 再 build，让组件管理器拉取依赖。
- **flash size 警告**：开发板实际是 4MB flash，但 hello_world 默认按 2MB 配置，启动会打印 `Detected size(4096k) larger than the size in the binary image header(2048k)`。实际固件工程按 C3FH4 配置 4MB：`CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y`。
- **中文路径**：仓库在 `...\Desktop\项目\...`，ESP-IDF 的 ccache/CMake 在中文路径下会报 `filesystem error: Cannot convert character sequence`，构建会卡住或失败（`--no-ccache` 也不够）。已落地的办法：用 `scripts\build-firmware.cmd`，它把 `firmware/` 同步到 `%TEMP%\lumen-firmware`（纯 ASCII）再构建；烧录用 `scripts\flash-firmware.cmd COM6`。或者把整个仓库移到纯 ASCII 路径。
- **devtools AppID**：`touristappid` 在当前版本会被 CLI 拒绝（`code 10：不存在此 AppID`）。真机预览前，在 IDE 里导入 `miniprogram/` 并使用「测试号」，或把测试号 AppID 填进 `project.config.json`。
- 当前没有检测到已连接的串口时，先接板子；本次识别到的是原生 USB 的 `USB 串行设备 (COM6)`（VID `303A`）。系统里还记录过 CH340 的 COM3/COM4、CH343 的 COM5，注意别烧错口。
- 系统 Python 是 3.12.10，但 IDF 工具链用自带的 3.11.2。`scripts/idf.cmd` 已把 IDF Python 放到 PATH 最前面；不要用系统 Python 直接跑 `idf_tools.py`。
