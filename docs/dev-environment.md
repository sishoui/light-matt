# 开发环境

目标：在这台 Windows 机器上能 `idf.py build/flash` ESP-IDF 工程，并能用微信开发者工具真机预览小程序。

> **ESP-IDF 基线：v6.1**（最新稳定版，2026-10-31 定）。
> **本项目不做版本兼容。** MVP 只是试验，不为任何旧版本维护降级路径或条件编译。
> 换机器时按本文装到 v6.1；版本不符就装到一致，不要「凑合能跑」。
>
> 选 v6.1 而非 v5.x 的原因：多引脚 TDM 方案依赖 `rmt_tx_switch_gpio()`。
> 该 API 从 v5.4.2 起才有，v6.1 已确认存在且可链接（见下「验证」）。

## 组件位置

| 组件 | 位置 / 版本 |
|---|---|
| ESP-IDF | `C:\Users\13092\esp\esp-idf\esp-idf`（**v6.1**，detached HEAD 在 tag 上） |
| IDF 工具 | `C:\Espressif\tools`（`IDF_TOOLS_PATH=C:\Espressif`） |
| IDF Python 环境 | `C:\Espressif\python_env\idf6.1_py3.11_env` |
| Python 基础解释器 | `C:\Espressif\tools\idf-python\3.11.2` |
| IDF Git | `C:\Espressif\tools\idf-git\2.44.0` |
| riscv32-esp-elf | `esp-15.2.0_20251204` |
| riscv32-esp-elf-gdb | `17.1_20260402` |
| cmake / ninja | `4.0.3` / `1.12.1` |
| ccache / openocd | `4.12.1` / `v0.12.0-esp32-20260703` |
| esp-clangd | `esp-21.1.3_20260408` |
| 系统 Python | 3.12.10 |
| Node / npm | v24.14.0 / 11.11.0 |
| 微信开发者工具 | `C:\Program Files (x86)\Tencent\微信web开发者工具` |

> **目录名与版本无关**：路径是 `C:\Users\13092\esp\esp-idf\esp-idf`，不随版本变化。
> 升级 IDF 只需在同一个目录里 `git checkout <新 tag>`，`scripts\idf.cmd` 无需改动。
> `export.bat` 从脚本自身位置推断 `IDF_PATH`，所以这个路径对 IDF 本身也不敏感。
>
> **改名记录（2026-10-31）**：原路径是 `C:\Users\13092\esp\v5.4\esp-idf`，目录名带着版本号，
> 升级后名实不符。已改名为 `esp\esp-idf`，一次性根治。踩到两个坑：
>
> 1. **`C:\Espressif\idf-env.json` 里也记着旧路径**（`idfInstalled` 的键与 `path` 字段）。
>    不改会导致 export 报「工具未安装」。备份在 `C:\Espressif\idf-env.json.bak`。
> 2. **改名后 export 开始严格检查全部工具链**（xtensa-esp-elf / xtensa-gdb / esp32ulp-elf / dfu-util），
>    之前只装了 riscv 那套。用不带 `--targets` 的 `idf_tools.py install` 一次性补齐。
>
> 同时受影响的三个同级项目（`lumen-app`、`lumen-fw`）的 `scripts\idf.cmd` 已一并改路径。

## 验证安装是否完整

```bat
C:\Users\13092\esp\esp-idf\esp-idf\export.bat
idf.py --version
```

应输出 `ESP-IDF v6.1`。然后跑一次完整构建：

```bat
scripts\build-firmware.cmd
```

**判定通过的最低标准**：构建成功，且 `lumen.elf` 里有 `rmt_tx_switch_gpio` 符号（TDM 的前提）：

```bat
C:\Espressif\tools\riscv32-esp-elf\esp-15.2.0_20251204\riscv32-esp-elf\bin\riscv32-esp-elf-nm.exe ^
  %TEMP%\lumen-firmware\build\lumen.elf | findstr rmt_tx_switch_gpio
```

应看到类似 `4204f876 T rmt_tx_switch_gpio`（`T` = 已定义，位于代码段）。

## 首次安装（可复现）

`install.bat` 必须在 **cmd.exe** 里运行，且不能带 `MSYSTEM`（Git Bash 会设置它，脚本会直接拒绝）。

```bat
@echo off
set "MSYSTEM="
set "PATH=C:\Espressif\tools\idf-python\3.11.2;C:\Espressif\tools\idf-git\2.44.0\cmd;%PATH%"
set "IDF_TOOLS_PATH=C:\Espressif"
cd /d C:\Users\13092\esp\esp-idf\esp-idf

call install.bat esp32c3
```

若已有旧版环境，v6.1 需要**独立补装**两样东西（两者缺一都会让 `export.bat` 直接退出）：

**1. 全部目标工具链**（v6.1 的 export 会检查 xtensa/gdb/dfu-util/clangd 等，即使只编 C3）：

```bat
set "MSYSTEM="
set "IDF_TOOLS_PATH=C:\Espressif"
C:\Espressif\python_env\idf6.1_py3.11_env\Scripts\python.exe tools\idf_tools.py install --targets=esp32c3
```

**2. Python 环境**（v6.1 用 `idf6.1_py3.11_env`，与旧版 `idf5.4_py3.11_env` 并存）：

```bat
C:\Espressif\python_env\idf5.4_py3.11_env\Scripts\python.exe tools\idf_tools.py install-python-env
```

这条命令会用已有的 Python 解释器创建 v6.1 的新 venv，并装上 esptool 5.6、esp-idf-kconfig、tree_sitter 等依赖。

## v6.1 的两个坑（重装时会重现）

**坑 1：`esp-clangd` 的 PATH 冲突。** 若系统 PATH 里有另一版本的 esp-clangd，export 会警告并拒绝使用。它不影响构建，但若坚持用系统那份，需加 `--prefer-system`。正常情况忽略即可。

**坑 2：配置项 `default 0` 弃用提示。** 构建时会出现一批来自 IDF 自身 Kconfig 的 NOTE：

```
BT_NIMBLE_MESH_PROVISIONER: 'default 0' is not a valid bool value
Deprecation notice: hex literal '0' without '0x' prefix detected
```

**这些是 ESP-IDF 自身 Kconfig 的问题，不是本仓库的**，不影响构建结果。不要为此改我们的 `Kconfig.projbuild`。

## 每个新终端

`export.bat` 只对 cmd.exe 生效。**建议 IDF 命令都在 cmd.exe 里跑**：

```bat
C:\Users\13092\esp\esp-idf\esp-idf\export.bat
idf.py --version
```

仓库里的 `scripts\idf.cmd` 已封装好（清 `MSYSTEM`、设 `IDF_TOOLS_PATH`、调用 `export.bat`），日常用包装脚本即可。

Git Bash 里不要直接 `source export.sh`；用包装脚本或 `cmd.exe //c`。

## 验证基线（改代码后必须保持）

```bat
cmd.exe //c "firmware\test\run-tests.cmd"   REM 1426 项
cd miniprogram && npx vitest run            REM 159 个用例
cd miniprogram && npx tsc --noEmit          REM 必须干净
scripts\build-firmware.cmd                  REM 分区余量 67%
```

**v6.1 下四条全部通过，且固件源码无需任何改动**（2026-10-31 实测）。
