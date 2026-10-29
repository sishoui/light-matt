@echo off
setlocal
REM Flash the #4 LED bring-up firmware built by scripts\build-led-bringup.cmd.
set "PORT=%~1"
if "%PORT%"=="" set "PORT=COM6"
set "DST=%TEMP%\lumen-bringup"

if not exist "%DST%\build\lumen_bringup.bin" (
  echo [flash-led-bringup] run scripts\build-led-bringup.cmd first
  exit /b 1
)

call "%~dp0idf.cmd" -C "%DST%" -p %PORT% flash
