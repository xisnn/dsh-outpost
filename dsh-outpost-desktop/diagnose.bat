@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  DSH Outpost 启动诊断
REM
REM  用途：程序双击没反应时，用这个脚本跑一遍，把结果发出来。
REM  它会检查环境、文件完整性、并尝试启动程序捕获错误。
REM ============================================================

set "EXE=%~dp0win-unpacked\DSH Outpost.exe"
if not exist "%EXE%" set "EXE=%~dp0DSH Outpost.exe"

echo ========================================
echo  DSH Outpost 诊断
echo ========================================
echo.

echo [1] 程序位置
echo     %EXE%
if exist "%EXE%" (
    echo     存在: 是
    for %%A in ("%EXE%") do echo     大小: %%~zA 字节
) else (
    echo     存在: 否  ^<-- 问题在这里
    echo.
    echo 没找到 exe。请确认解压后的目录结构：
    echo   win-unpacked\DSH Outpost.exe
    goto :end
)
echo.

echo [2] 环境变量
if defined ELECTRON_RUN_AS_NODE (
    echo     ELECTRON_RUN_AS_NODE = %ELECTRON_RUN_AS_NODE%   ^<-- 这个会让程序以纯 Node 模式启动并崩溃
    echo     修复：在系统环境变量里删除它，或用下面的 set 命令临时清掉
    set "ELECTRON_RUN_AS_NODE="
) else (
    echo     ELECTRON_RUN_AS_NODE 未设置  正常
)
if defined NODE_OPTIONS (
    echo     NODE_OPTIONS = %NODE_OPTIONS%   ^<-- 可能干扰
) else (
    echo     NODE_OPTIONS 未设置  正常
)
echo.

echo [3] 文件完整性
set "MISSING=0"
for %%F in (ffmpeg.dll icudtl.dat resources.pak snapshot_blob.bin v8_context_snapshot.bin) do (
    if exist "%~dp0win-unpacked\%%F" (
        echo     OK   %%F
    ) else (
        echo     MISS %%F
        set "MISSING=1"
    )
)
if exist "%~dp0win-unpacked\resources\app.asar" (
    echo     OK   resources\app.asar
) else (
    echo     MISS resources\app.asar
    set "MISSING=1"
)
if "!MISSING!"=="1" echo     ^<-- 文件缺失，重新解压
echo.

echo [4] 已运行的实例
tasklist /FI "IMAGENAME eq DSH Outpost.exe" 2>nul | find /I "DSH Outpost.exe" >nul
if !errorlevel! equ 0 (
    echo     有实例在跑   ^<-- 可能是卡住的僵尸进程
    tasklist /FI "IMAGENAME eq DSH Outpost.exe"
    echo.
    echo     如果看不到窗口，说明它卡住了。执行：
    echo        taskkill /F /IM "DSH Outpost.exe"
) else (
    echo     没有实例在跑  正常
)
echo.

echo [5] 启动测试（最多等 8 秒）
echo     正在启动...
start "" "%EXE%"
timeout /t 8 /nobreak >nul

tasklist /FI "IMAGENAME eq DSH Outpost.exe" 2>nul | find /I "DSH Outpost.exe" >nul
if !errorlevel! equ 0 (
    echo     进程存活  启动成功
    echo.
    echo     如果这时看不到窗口，检查：
    echo       - 任务栏通知区有没有图标（可能被折叠了，点 ^^ 展开）
    echo       - 是不是双屏，窗口跑到另一个屏幕了
) else (
    echo     进程已退出  启动失败
)
echo.

echo [6] 崩溃日志
set "LOG=%LOCALAPPDATA%\dsh-pocket\logs\desktop-crash.log"
if exist "%LOG%" (
    echo     位置: %LOG%
    for %%A in ("%LOG%") do echo     大小: %%~zA 字节
    echo.
    echo     --- 内容 ---
    type "%LOG%"
    echo     --- 结束 ---
) else (
    echo     不存在: %LOG%
    echo     ^<-- 说明程序没执行到写日志的代码（更早期的失败）
)
echo.

echo ========================================
echo  诊断完成，把上面的输出复制发出来
echo ========================================

:end
echo.
pause
