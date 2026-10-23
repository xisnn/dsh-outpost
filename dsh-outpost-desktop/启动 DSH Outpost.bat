@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM  DSH Outpost 启动器
REM
REM  为什么用这个而不是直接双击 exe：
REM
REM  1. 清掉 ELECTRON_RUN_AS_NODE
REM     有这个变量时 Electron 会以「纯 Node 模式」启动，
REM     程序在第一行就崩溃 —— 症状是「一闪就没，什么都没有」。
REM
REM  2. 能显示错误信息
REM     直接双击 exe 时没有控制台，崩溃信息完全看不到。
REM     这个脚本在 cmd 窗口里跑，能看到输出。
REM ============================================================

set "HERE=%~dp0"
set "EXE="
set "WORKDIR="

if exist "%HERE%win-unpacked\DSH Outpost.exe" (
    set "EXE=%HERE%win-unpacked\DSH Outpost.exe"
    set "WORKDIR=%HERE%win-unpacked"
) else if exist "%HERE%DSH Outpost.exe" (
    set "EXE=%HERE%DSH Outpost.exe"
    set "WORKDIR=%HERE%"
)

if not defined EXE (
    echo [X] 找不到 DSH Outpost.exe
    echo.
    echo 请确认解压后的目录里有 win-unpacked\ 子目录，
    echo 里面应该有 DSH Outpost.exe
    echo.
    pause
    exit /b 1
)

echo 启动: %EXE%
echo.

REM 关键：清掉会让 Electron 变成纯 Node 的变量
if defined ELECTRON_RUN_AS_NODE (
    echo [提示] 检测到 ELECTRON_RUN_AS_NODE=%ELECTRON_RUN_AS_NODE%
    echo        这个变量会让 Electron 以纯 Node 模式启动并崩溃。
    echo        已临时清掉（不影响系统设置）。
    echo.
)
set "ELECTRON_RUN_AS_NODE="

REM 检查是否已有实例卡住
tasklist /FI "IMAGENAME eq DSH Outpost.exe" 2>nul | find /I "DSH Outpost.exe" >nul
if %errorlevel% equ 0 (
    echo [提示] 已有实例在运行。如果看不到窗口，可能卡住了。
    echo        正在结束旧进程...
    taskkill /F /IM "DSH Outpost.exe" >nul 2>&1
    timeout /t 1 /nobreak >nul
    echo.
)

cd /d "%WORKDIR%"

REM 前台启动，这样能看到输出
start "" /B "%EXE%"

REM 等 3 秒看进程有没有活下来
timeout /t 3 /nobreak >nul

tasklist /FI "IMAGENAME eq DSH Outpost.exe" 2>nul | find /I "DSH Outpost.exe" >nul
if %errorlevel% equ 0 (
    echo [OK] 程序已启动。
    echo.
    echo   如果看不到窗口，检查：
    echo     - 任务栏右下角通知区有没有图标（点 ^ 展开）
    echo     - 是不是双屏，窗口跑到另一个屏幕了
    echo     - 双击托盘图标唤起面板
    echo.
    timeout /t 5 /nobreak >nul
) else (
    echo [X] 程序启动后立刻退出了。
    echo.
    echo   崩溃日志（如果写入了）：
    echo     %LOCALAPPDATA%\dsh-pocket\logs\desktop-crash.log
    if exist "%LOCALAPPDATA%\dsh-pocket\logs\desktop-crash.log" (
        echo.
        echo   --- 日志内容 ---
        type "%LOCALAPPDATA%\dsh-pocket\logs\desktop-crash.log"
        echo   --- 结束 ---
    ) else (
        echo     ^(文件不存在 —— 说明失败发生在更早期^)
    )
    echo.
    pause
)
