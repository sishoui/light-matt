@echo off
setlocal
set "MSYSTEM="
set "PATH=C:\Espressif\tools\idf-python\3.11.2;C:\Espressif\tools\idf-git\2.44.0\cmd;%PATH%"
set "IDF_TOOLS_PATH=C:\Espressif"
call "C:\Users\13092\esp\v5.4\esp-idf\export.bat" >nul
if errorlevel 1 exit /b %errorlevel%
idf.py %*
