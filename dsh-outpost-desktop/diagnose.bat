@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  DSH Outpost diagnostic
REM
REM  Run this when the app does not start. Copy the output and
REM  send it back - everything needed to locate the problem is here.
REM
REM  NOTE: keep this file pure ASCII. cmd.exe parses .bat files
REM  using the system ANSI codepage (GBK on Chinese Windows), so
REM  UTF-8 Chinese text becomes garbage and breaks the syntax.
REM ============================================================

echo ==========================================
echo   DSH Outpost diagnostic
echo ==========================================
echo.

set "EXE=%~dp0win-unpacked\DSH Outpost.exe"
if not exist "%EXE%" set "EXE=%~dp0DSH Outpost.exe"
set "DIR=%~dp0win-unpacked"
if not exist "%DIR%\DSH Outpost.exe" set "DIR=%~dp0"

echo [1] Program location
echo     %EXE%
if exist "%EXE%" (
    echo     exists: YES
    for %%A in ("%EXE%") do echo     size:   %%~zA bytes
) else (
    echo     exists: NO  ^<== problem here
    echo.
    echo     Expected: win-unpacked\DSH Outpost.exe
    goto :finish
)
echo.

echo [2] Environment variables
if defined ELECTRON_RUN_AS_NODE (
    echo     ELECTRON_RUN_AS_NODE = %ELECTRON_RUN_AS_NODE%
    echo     ^<== THIS MAKES ELECTRON CRASH. Clearing for this run.
    set "ELECTRON_RUN_AS_NODE="
) else (
    echo     ELECTRON_RUN_AS_NODE : not set [OK]
)
if defined NODE_OPTIONS (
    echo     NODE_OPTIONS = %NODE_OPTIONS%
    echo     ^<== may interfere
) else (
    echo     NODE_OPTIONS : not set [OK]
)
echo     OS: %OS%
echo.

echo [3] File integrity
set "MISSING=0"
for %%F in (ffmpeg.dll icudtl.dat resources.pak snapshot_blob.bin v8_context_snapshot.bin libEGL.dll libGLESv2.dll) do (
    if exist "%DIR%\%%F" (
        echo     OK   %%F
    ) else (
        echo     MISSING  %%F
        set "MISSING=1"
    )
)
if exist "%DIR%\resources\app.asar" (
    echo     OK   resources\app.asar
) else (
    echo     MISSING  resources\app.asar
    set "MISSING=1"
)
if "!MISSING!"=="1" echo     ^<== files missing, re-extract the zip
echo.

echo [4] Running instances
tasklist /FI "IMAGENAME eq DSH Outpost.exe" 2>nul | find /I "DSH Outpost.exe" >nul
if not errorlevel 1 (
    echo     An instance IS running
    echo     ^<== if no window is visible it may be stuck
    echo     To kill it:  taskkill /F /IM "DSH Outpost.exe"
) else (
    echo     No instance running [OK]
)
echo.

echo [5] Launch test (waiting 8 seconds)
echo     Starting...
cd /d "%DIR%"
start "" "%EXE%"
timeout /t 8 /nobreak >nul

tasklist /FI "IMAGENAME eq DSH Outpost.exe" 2>nul | find /I "DSH Outpost.exe" >nul
if not errorlevel 1 (
    echo     Process ALIVE - launch succeeded
    echo.
    echo     If you cannot see a window, check:
    echo       - notification area bottom-right, click ^ to expand
    echo       - a second monitor
    echo       - double-click the tray icon
) else (
    echo     Process EXITED - launch FAILED
)
echo.

echo [6] Crash logs
set "FOUND=0"
if exist "%LOCALAPPDATA%\dsh-pocket\logs\desktop-crash.log" (
    echo     FOUND: %LOCALAPPDATA%\dsh-pocket\logs\desktop-crash.log
    echo     --- content ---
    type "%LOCALAPPDATA%\dsh-pocket\logs\desktop-crash.log"
    echo     --- end ---
    set "FOUND=1"
)
if exist "%TEMP%\dsh-outpost-crash.log" (
    echo     FOUND: %TEMP%\dsh-outpost-crash.log
    echo     --- content ---
    type "%TEMP%\dsh-outpost-crash.log"
    echo     --- end ---
    set "FOUND=1"
)
if exist "%DIR%\dsh-outpost-crash.log" (
    echo     FOUND: %DIR%\dsh-outpost-crash.log
    echo     --- content ---
    type "%DIR%\dsh-outpost-crash.log"
    echo     --- end ---
    set "FOUND=1"
)
if "!FOUND!"=="0" (
    echo     No log file found anywhere.
    echo     ^<== the app died before any logging code ran
)
echo.

echo ==========================================
echo   Done. Copy the output above and send it.
echo ==========================================

:finish
echo.
pause
