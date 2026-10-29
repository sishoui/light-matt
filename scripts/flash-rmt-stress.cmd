@echo off
setlocal
REM Flash the #7 stress firmware built by scripts\build-rmt-stress.cmd.
REM Usage: scripts\flash-rmt-stress.cmd [COM port, default COM6]
REM Note: COM6 is normally reserved for manual observation; pass the port the
REM board is actually on.
set "PORT=%~1"
if "%PORT%"=="" set "PORT=COM6"
set "DST=%TEMP%\lumen-rmt-stress-07"

if not exist "%DST%\build\lumen.bin" (
  echo [flash-rmt-stress] run scripts\build-rmt-stress.cmd first
  exit /b 1
)

call "%~dp0idf.cmd" -C "%DST%" -p %PORT% flash
