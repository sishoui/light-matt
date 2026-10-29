@echo off
setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=COM6"
set "DST=%TEMP%\lumen-firmware"

if not exist "%DST%\build\lumen.bin" (
  echo [flash-firmware] run scripts\build-firmware.cmd first
  exit /b 1
)

call "%~dp0idf.cmd" -C "%DST%" -p %PORT% flash
