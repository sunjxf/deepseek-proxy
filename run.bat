@echo off
setlocal
chcp 65001 >nul

rem ============================================================
rem  DeepSeek Proxy launcher
rem  Usage:
rem    run.bat              start in background
rem    run.bat --fg         run in foreground (debug)
rem    run.bat --debug      start in background with debug log
rem ============================================================

cd /d "%~dp0"

set "ROOT=%~dp0"
set "PID_FILE=%ROOT%logs\proxy.pid"
set "OUT_LOG=%ROOT%logs\console.log"

rem ---------- arg parsing ----------
set "FOREGROUND=0"
set "LOGLEVEL=info"
for %%A in (%*) do (
  if /i "%%~A"=="--fg"    set "FOREGROUND=1"
  if /i "%%~A"=="--debug" set "LOGLEVEL=debug"
)

rem ---------- environment check ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js and add it to PATH.
  pause
  exit /b 1
)

if not exist "%ROOT%node_modules" (
  echo [INFO] node_modules missing, running npm install ...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

if not exist "%ROOT%logs" mkdir "%ROOT%logs"

rem ---------- prevent double start ----------
if exist "%PID_FILE%" (
  set /p OLD_PID=<"%PID_FILE%"
  call :IS_RUNNING !OLD_PID!
  if "!RUNNING!"=="1" (
    echo [INFO] already running, PID=!OLD_PID!. Run stop.bat first to restart.
    exit /b 0
  )
  del /f /q "%PID_FILE%" >nul 2>nul
)

set "LOG_LEVEL=%LOGLEVEL%"

rem ---------- foreground mode ----------
if "%FOREGROUND%"=="1" (
  echo [INFO] foreground start, LOG_LEVEL=%LOG_LEVEL%
  node src\index.js
  exit /b %errorlevel%
)

rem ---------- background mode ----------
echo [INFO] starting in background, LOG_LEVEL=%LOG_LEVEL%

rem Launch via PowerShell Start-Process (no window), redirect stdout/stderr to files
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Start-Process -FilePath 'node' -ArgumentList 'src\index.js' -WorkingDirectory '%ROOT%' -WindowStyle Hidden -PassThru -RedirectStandardOutput '%OUT_LOG%' -RedirectStandardError '%OUT_LOG%.err'; $p.Id" > "%PID_FILE%.tmp" 2>nul

set /p NEW_PID=<"%PID_FILE%.tmp"
del /f /q "%PID_FILE%.tmp" >nul 2>nul

if not defined NEW_PID (
  echo [ERROR] start failed, check %OUT_LOG%.err
  exit /b 1
)

echo %NEW_PID%> "%PID_FILE%"

rem wait a moment, confirm the process is still alive
ping -n 3 127.0.0.1 >nul
tasklist /FI "PID eq %NEW_PID%" 2>nul | find /i "node.exe" >nul
if errorlevel 1 (
  echo [ERROR] process exited, recent output:
  if exist "%OUT_LOG%.err" type "%OUT_LOG%.err"
  if exist "%OUT_LOG%" type "%OUT_LOG%"
  del /f /q "%PID_FILE%" >nul 2>nul
  exit /b 1
)

echo.
echo [OK] server is running in background
echo   PID        : %NEW_PID%
echo   console log: %OUT_LOG%
echo   app log    : %ROOT%logs\app.log
echo   stop with  : stop.bat
echo.

rem read port from config and print access URL
node -e "const c=require('fs').readFileSync('config.json','utf8');const j=JSON.parse(c);console.log('   admin page : http://'+(j.host||'127.0.0.1')+':'+(j.port||3000)+'/admin')" 2>nul

exit /b 0

rem ---------- sub: check whether PID is a live node process ----------
:IS_RUNNING
set "RUNNING=0"
for /f "tokens=1,2" %%X in ('tasklist /FI "PID eq %1" /NH 2^>nul') do (
  if /i "%%X"=="node.exe" set "RUNNING=1"
)
goto :eof
