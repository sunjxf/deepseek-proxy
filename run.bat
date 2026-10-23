@echo off
setlocal
chcp 65001 >nul

rem ============================================================
rem  DeepSeek Proxy 后台启动脚本
rem  用法：
rem    run.bat              后台启动
rem    run.bat --fg         前台启动（调试用）
rem    run.bat --debug      后台启动并开启 debug 日志
rem ============================================================

cd /d "%~dp0"

set "ROOT=%~dp0"
set "PID_FILE=%ROOT%logs\proxy.pid"
set "OUT_LOG=%ROOT%logs\console.log"

rem ---------- 参数解析 ----------
set "FOREGROUND=0"
set "LOGLEVEL=info"
for %%A in (%*) do (
  if /i "%%~A"=="--fg"    set "FOREGROUND=1"
  if /i "%%~A"=="--debug" set "LOGLEVEL=debug"
)

rem ---------- 环境检查 ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 并加入 PATH。
  pause
  exit /b 1
)

if not exist "%ROOT%node_modules" (
  echo [提示] 未找到 node_modules，正在执行 npm install ...
  call npm install
  if errorlevel 1 (
    echo [错误] npm install 失败。
    pause
    exit /b 1
  )
)

if not exist "%ROOT%logs" mkdir "%ROOT%logs"

rem ---------- 防止重复启动 ----------
if exist "%PID_FILE%" (
  set /p OLD_PID=<"%PID_FILE%"
  call :IS_RUNNING !OLD_PID!
  if "!RUNNING!"=="1" (
    echo [提示] 服务已在运行，PID=!OLD_PID!。如需重启请先执行 stop.bat。
    exit /b 0
  )
  del /f /q "%PID_FILE%" >nul 2>nul
)

set "LOG_LEVEL=%LOGLEVEL%"

rem ---------- 前台模式 ----------
if "%FOREGROUND%"=="1" (
  echo [信息] 前台启动，LOG_LEVEL=%LOG_LEVEL%
  node server.js
  exit /b %errorlevel%
)

rem ---------- 后台模式 ----------
echo [信息] 后台启动中，LOG_LEVEL=%LOG_LEVEL%

rem 用 PowerShell 的 Start-Process 无窗口启动，并把 stdout/stderr 重定向到文件
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%ROOT%' -WindowStyle Hidden -PassThru -RedirectStandardOutput '%OUT_LOG%' -RedirectStandardError '%OUT_LOG%.err'; $p.Id" > "%PID_FILE%.tmp" 2>nul

set /p NEW_PID=<"%PID_FILE%.tmp"
del /f /q "%PID_FILE%.tmp" >nul 2>nul

if not defined NEW_PID (
  echo [错误] 启动失败，请检查 %OUT_LOG%.err
  exit /b 1
)

echo %NEW_PID%> "%PID_FILE%"

rem 稍等，确认进程还活着
ping -n 3 127.0.0.1 >nul
tasklist /FI "PID eq %NEW_PID%" 2>nul | find /i "node.exe" >nul
if errorlevel 1 (
  echo [错误] 进程已退出，最近输出：
  if exist "%OUT_LOG%.err" type "%OUT_LOG%.err"
  if exist "%OUT_LOG%" type "%OUT_LOG%"
  del /f /q "%PID_FILE%" >nul 2>nul
  exit /b 1
)

echo.
echo [成功] 服务已在后台运行
echo   PID      : %NEW_PID%
echo   控制台日志: %OUT_LOG%
echo   应用日志  : %ROOT%logs\app.log
echo   停止服务  : stop.bat
echo.

rem 从配置里读一下端口，拼出访问地址提示
node -e "const c=require('fs').readFileSync('config.json','utf8');const j=JSON.parse(c);console.log('   配置页面  : http://'+(j.host||'127.0.0.1')+':'+(j.port||3000)+'/admin')" 2>nul

exit /b 0

rem ---------- 子过程：判断 PID 是否为存活的 node 进程 ----------
:IS_RUNNING
set "RUNNING=0"
for /f "tokens=1,2" %%X in ('tasklist /FI "PID eq %1" /NH 2^>nul') do (
  if /i "%%X"=="node.exe" set "RUNNING=1"
)
goto :eof