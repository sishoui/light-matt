@echo off
setlocal
REM Host unit tests: no ESP-IDF toolchain, no hardware.
REM Build output goes to %TEMP% so the repo stays clean (and gcc avoids the
REM non-ASCII repo path). Keep this file ASCII-only: cmd.exe reads .cmd in the
REM OEM code page, so UTF-8 comments get mangled into bogus commands.

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
