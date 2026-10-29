@echo off
setlocal
REM The repo path contains non-ASCII characters, which stalls ESP-IDF under
REM ccache/CMake filesystem conversion. Sync the firmware sources to an ASCII
REM temp dir and build there; the repo stays the source of truth.
REM Keep this file ASCII-only: cmd.exe reads .cmd in the OEM code page.
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
