@echo off
setlocal

REM ============================================================
REM  DSH Outpost launcher
REM
REM  Why use this instead of double-clicking the exe:
REM
REM  1. Clears ELECTRON_RUN_AS_NODE
REM     When that variable is set, Electron starts in "pure Node"
REM     mode: require('electron') returns a path string instead of
REM     the API object, so the app crashes on its very first line.
REM     Symptom: window flashes, nothing appears, no log.
REM
REM  2. Shows errors
REM     Double-clicking the exe gives no console, so crash output
REM     is invisible. This script runs in a cmd window.
REM
REM  NOTE: keep this file pure ASCII. cmd.exe parses .bat files
REM  using the system ANSI codepage (GBK on Chinese Windows), so
REM  UTF-8 Chinese text becomes garbage and breaks the syntax.
REM ============================================================

set "HERE=%~dp0"
set "EXE="
set "WORKDIR="

if exist "%HERE%win-unpacked\DSH Outpost.exe" (
    set "EXE=%HERE%win-unpacked\DSH Outpost.exe"
    set "WORKDIR=%HERE%win-unpacked"
)
if not defined EXE (
    if exist "%HERE%DSH Outpost.exe" (
        set "EXE=%HERE%DSH Outpost.exe"
        set "WORKDIR=%HERE%"
    )
)

if not defined EXE (
    echo [X] Cannot find "DSH Outpost.exe"
    echo.
    echo Expected layout after extracting the zip:
    echo     win-unpacked\DSH Outpost.exe
    echo.
    pause
    exit /b 1
)

echo Launching:
echo     %EXE%
echo.

if defined ELECTRON_RUN_AS_NODE (
    echo [WARN] ELECTRON_RUN_AS_NODE=%ELECTRON_RUN_AS_NODE%
    echo        This variable makes Electron run in pure Node mode
    echo        and crash immediately. Clearing it for this session.
    echo.
)
set "ELECTRON_RUN_AS_NODE="

tasklist /FI "IMAGENAME eq DSH Outpost.exe" 2>nul | find /I "DSH Outpost.exe" >nul
if not errorlevel 1 (
    echo [WARN] An instance is already running.
    echo        If you cannot see its window, it may be stuck.
    echo        Killing it and starting fresh...
    taskkill /F /IM "DSH Outpost.exe" >nul 2>&1
    timeout /t 1 /nobreak >nul
    echo.
)

cd /d "%WORKDIR%"
start "" "%EXE%"

timeout /t 4 /nobreak >nul

tasklist /FI "IMAGENAME eq DSH Outpost.exe" 2>nul | find /I "DSH Outpost.exe" >nul
if not errorlevel 1 (
    echo [OK] Process is running.
    echo.
    echo   If you still cannot see a window:
    echo     - Check the notification area bottom-right, click ^ to expand
    echo     - Maybe it opened on a second monitor
    echo     - Left-click the tray icon to show the panel
    echo.
    timeout /t 6 /nobreak >nul
    exit /b 0
)

echo [X] Process started and exited immediately.
echo.
echo Crash log location:
echo     %LOCALAPPDATA%\dsh-pocket\logs\desktop-crash.log
echo.

if exist "%LOCALAPPDATA%\dsh-pocket\logs\desktop-crash.log" (
    echo --- log content ---
    type "%LOCALAPPDATA%\dsh-pocket\logs\desktop-crash.log"
    echo --- end ---
) else (
    if exist "%TEMP%\dsh-outpost-crash.log" (
        echo --- fallback log ---
        type "%TEMP%\dsh-outpost-crash.log"
        echo --- end ---
    ) else (
        echo No log file found. Failure happened before any logging code ran.
        echo Try: run diagnose.bat and send the output.
    )
)

echo.
pause
exit /b 1
