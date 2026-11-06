@echo off
setlocal
REM Host unit tests: no ESP-IDF toolchain, no hardware.
REM Build output goes to %TEMP% so the repo stays clean (and gcc avoids the
REM non-ASCII repo path). Keep this file ASCII-only: cmd.exe reads .cmd in the
REM OEM code page, so UTF-8 comments get mangled into bogus commands.

set "MAIN=%~dp0..\main"
set "OUT=%TEMP%\lumen-host-tests"
set "VECTORS=%~dp0..\..\docs\protocol-testvectors-v4.json"
set "VECTORS_V5=%~dp0..\..\docs\protocol-testvectors-v5.json"
if not exist "%OUT%" mkdir "%OUT%"

REM #49 note on the source list below:
REM   led_engine.c needs FreeRTOS semaphores, esp_timer and ESP-IDF headers, so it
REM   cannot be compiled for the host. The pure part that walks segment slots and
REM   reports the REAL slot id for SegmentReport (spec-v3 4.2 fix 3) was therefore
REM   split out into led_engine_slots.c, which is plain C and is listed below.
REM   firmware/test/test_skeleton.c::test_segment_real_slots() guards that behavior.
gcc -std=c11 -Wall -Wextra -Werror -I"%MAIN%" ^
    "%~dp0test_skeleton.c" ^
    "%MAIN%\protocol.c" ^
    "%MAIN%\chunk_reasm.c" ^
    "%MAIN%\command.c" ^
    "%MAIN%\effects.c" ^
    "%MAIN%\segment_store.c" ^
    "%MAIN%\script_store.c" ^
    "%MAIN%\script_scope.c" ^
    "%MAIN%\script_blob.c" ^
    "%MAIN%\strip_planar.c" ^
    "%MAIN%\strip_power.c" ^
    "%MAIN%\state.c" ^
    "%MAIN%\gamma.c" ^
    "%MAIN%\selftest.c" ^
    "%MAIN%\led_engine_slots.c" ^
    "%MAIN%\led_count_job.c" ^
    "%MAIN%\save_scheduler.c" ^
    "%MAIN%\state_blob.c" ^
    "%MAIN%\layout_store.c" ^
    "%MAIN%\scene_store.c" ^
    "%MAIN%\scene_compose.c" ^
    -lm -o "%OUT%\lumen_host_tests.exe"
if errorlevel 1 exit /b 1

REM The vectors file is shared by both ends; fail loudly if it is missing.
if not exist "%VECTORS%" (
  echo [run-tests] vectors file not found: %VECTORS%
  exit /b 1
)

"%OUT%\lumen_host_tests.exe" "%VECTORS%"
if errorlevel 1 exit /b 1

REM v4 contract self-check: validates docs/protocol-testvectors-v4.json against
REM docs/protocol-v4.md (frame widths, magic/version, chunk reassembly, result
REM codes, command coverage, per-layer level rules). Independent of the
REM generator, so it catches generator bugs such as a wrong field width.
REM No node means the v4 vector self-check did NOT run. Print a fixed-prefix tag
REM (scripts/test-run.mjs turns "SKIPPED:" into an unverified item in the report)
REM instead of a free-form note, so "not run" is visible rather than silent.
REM Exit code stays 0: it is not a failure, but it must be a record. ASCII only.
REM Parentheses are escaped: an unescaped ")" inside this ( ) block would close it
REM early and truncate the tag.
where node >nul 2>nul
if errorlevel 1 (
  echo SKIPPED: v4 vector self-check ^(node not found^)
  exit /b 0
)
node "%~dp0..\..\scripts\check-protocol-testvectors-v4.mjs"
if errorlevel 1 exit /b 1
exit /b 0
