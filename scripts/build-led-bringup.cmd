@echo off
setlocal
REM Build the standalone #4 LED bring-up project (no BLE, no protocol).
REM Syncs firmware/bringup to an ASCII temp dir because the repo path is
REM non-ASCII. Keep this file ASCII-only: cmd.exe reads .cmd in the OEM code page.
set "SRC=%~dp0..\firmware\bringup"
set "DST=%TEMP%\lumen-bringup"

if not exist "%DST%" mkdir "%DST%"
robocopy "%SRC%" "%DST%" /MIR /XD build /XF sdkconfig >nul
if %errorlevel% GEQ 8 (
  echo [build-led-bringup] copy failed: %SRC% -^> %DST%
  exit /b 1
)

if not exist "%DST%\sdkconfig" (
  call "%~dp0idf.cmd" --no-ccache -C "%DST%" set-target esp32c3
  if errorlevel 1 exit /b 1
)

call "%~dp0idf.cmd" --no-ccache -C "%DST%" build
