@echo off
setlocal
REM Host unit tests: no ESP-IDF toolchain, no hardware.
REM Build output goes to %TEMP% so the repo stays clean (and gcc avoids the
REM non-ASCII repo path). Keep this file ASCII-only: cmd.exe reads .cmd in the
REM OEM code page, so UTF-8 comments get mangled into bogus commands.

set "MAIN=%~dp0..\main"
set "OUT=%TEMP%\lumen-host-tests"
set "VECTORS=%~dp0..\..\docs\protocol-testvectors.json"
if not exist "%OUT%" mkdir "%OUT%"

gcc -std=c11 -Wall -Wextra -Werror -I"%MAIN%" ^
    "%~dp0test_skeleton.c" ^
    "%MAIN%\protocol.c" ^
    "%MAIN%\command.c" ^
    "%MAIN%\effects.c" ^
    "%MAIN%\segment_store.c" ^
    "%MAIN%\script_store.c" ^
    "%MAIN%\strip_planar.c" ^
    "%MAIN%\state.c" ^
    "%MAIN%\gamma.c" ^
    "%MAIN%\selftest.c" ^
    "%MAIN%\led_count_job.c" ^
    "%MAIN%\save_scheduler.c" ^
    "%MAIN%\state_blob.c" ^
    -lm -o "%OUT%\lumen_host_tests.exe"
if errorlevel 1 exit /b 1

REM The vectors file is shared by both ends; fail loudly if it is missing.
if not exist "%VECTORS%" (
  echo [run-tests] vectors file not found: %VECTORS%
  exit /b 1
)

"%OUT%\lumen_host_tests.exe" "%VECTORS%"
