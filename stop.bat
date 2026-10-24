@echo off
setlocal
chcp 65001 >nul

rem ============================================================
rem  DeepSeek Proxy stopper (force kill)
rem  Usage: stop.bat
rem ============================================================

cd /d "%~dp0"
set "ROOT=%~dp0"
set "PID_FILE=%ROOT%logs\proxy.pid"

if not exist "%PID_FILE%" (
  echo [INFO] no PID file, falling back to port lookup...
  goto FALLBACK
)

set /p PID=<"%PID_FILE%"

call :IS_RUNNING %PID%
if "%RUNNING%"=="0" (
  echo [INFO] PID %PID% is not a running node process, removing PID file.
  del /f /q "%PID_FILE%" >nul 2>nul
  exit /b 0
)

echo [INFO] stopping PID=%PID% ...
taskkill /PID %PID% /T /F >nul 2>nul

ping -n 2 127.0.0.1 >nul

call :IS_RUNNING %PID%
if "%RUNNING%"=="1" (
  echo [ERROR] could not stop PID=%PID%
  exit /b 1
)

del /f /q "%PID_FILE%" >nul 2>nul
echo [OK] server stopped.
exit /b 0

:FALLBACK
rem no PID file: match by command line (kill only on unique hit)
set "FOUND="
for /f "tokens=2" %%P in ('wmic process where "name='node.exe'" get ProcessId^,CommandLine /format:list 2^>nul ^| findstr /i "src\\index.js"') do set "FOUND=%%P"
if not defined FOUND (
  echo [INFO] no running proxy service found.
  exit /b 0
)
echo [INFO] found node process PID=%FOUND%, stopping...
taskkill /PID %FOUND% /T /F >nul 2>nul
echo [OK] stopped.
exit /b 0

:IS_RUNNING
set "RUNNING=0"
for /f "tokens=1,2" %%X in ('tasklist /FI "PID eq %1" /NH 2^>nul') do (
  if /i "%%X"=="node.exe" set "RUNNING=1"
)
goto :eof
