@echo off
setlocal
REM Host 单元测试：不需要 ESP-IDF 工具链，也不连硬件。
REM 产物写到 %TEMP%，避免污染仓库（仓库路径含中文，也避免 gcc 输出文件落在中文路径下）。

set "MAIN=%~dp0..\main"
set "OUT=%TEMP%\lumen-host-tests"
if not exist "%OUT%" mkdir "%OUT%"

gcc -std=c11 -Wall -Wextra -Werror -I"%MAIN%" ^
    "%~dp0test_skeleton.c" ^
    "%MAIN%\protocol.c" ^
    "%MAIN%\state.c" ^
    "%MAIN%\gamma.c" ^
    -lm -o "%OUT%\lumen_host_tests.exe"
if errorlevel 1 exit /b 1

"%OUT%\lumen_host_tests.exe"
