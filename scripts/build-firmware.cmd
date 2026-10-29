@echo off
setlocal
REM 仓库路径含中文，ESP-IDF 在中文路径下会被 ccache/CMake 的文件系统转换卡住。
REM 这里把固件源码同步到纯 ASCII 的临时目录再构建；源码仍以仓库为准。
set "SRC=%~dp0..\firmware"
set "DST=%TEMP%\lumen-firmware"

if not exist "%DST%" mkdir "%DST%"
robocopy "%SRC%" "%DST%" /MIR /XD build /XF sdkconfig >nul
if %errorlevel% GEQ 8 (
  echo [build-firmware] copy failed: %SRC% -^> %DST%
  exit /b 1
)

if not exist "%DST%\sdkconfig" (
  call "%~dp0idf.cmd" --no-ccache -C "%DST%" set-target esp32c3
  if errorlevel 1 exit /b 1
)

call "%~dp0idf.cmd" --no-ccache -C "%DST%" build
