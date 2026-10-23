@echo off
setlocal
chcp 65001 >nul

rem ============================================================
rem  DeepSeek Proxy 停止脚本（强杀）
rem  用法：stop.bat
rem ============================================================

cd /d "%~dp0"
set "ROOT=%~dp0"
set "PID_FILE=%ROOT%logs\proxy.pid"

if not exist "%PID_FILE%" (
  echo [提示] 未找到 PID 文件，尝试按端口兜底查找...
  goto FALLBACK
)

set /p PID=<"%PID_FILE%"

call :IS_RUNNING %PID%
if "%RUNNING%"=="0" (
  echo [提示] PID %PID% 不是运行中的 node 进程，清理 PID 文件。
  del /f /q "%PID_FILE%" >nul 2>nul
  exit /b 0
)

echo [信息] 正在结束 PID=%PID% ...
taskkill /PID %PID% /T /F >nul 2>nul

ping -n 2 127.0.0.1 >nul

call :IS_RUNNING %PID%
if "%RUNNING%"=="1" (
  echo [错误] 无法结束 PID=%PID%
  exit /b 1
)

del /f /q "%PID_FILE%" >nul 2>nul
echo [成功] 服务已停止。
exit /b 0

:FALLBACK
rem 没 PID 文件时，用命令行特征匹配（只在唯一命中时才杀）
set "FOUND="
for /f "tokens=2" %%P in ('wmic process where "name='node.exe'" get ProcessId^,CommandLine /format:list 2^>nul ^| findstr /i "server.js"') do set "FOUND=%%P"
if not defined FOUND (
  echo [提示] 没有找到运行中的代理服务。
  exit /b 0
)
echo [信息] 找到 node 进程 PID=%FOUND%，正在结束...
taskkill /PID %FOUND% /T /F >nul 2>nul
echo [成功] 已结束。
exit /b 0

:IS_RUNNING
set "RUNNING=0"
for /f "tokens=1,2" %%X in ('tasklist /FI "PID eq %1" /NH 2^>nul') do (
  if /i "%%X"=="node.exe" set "RUNNING=1"
)
goto :eof