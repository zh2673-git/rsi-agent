@echo off
setlocal
cd /d "%~dp0"
set "REPO=%CD%"

rem -- rsi-agent standalone runtime environment --
set "SKILLS_DIR=%REPO%\skills"
set "WORKSPACE_ROOT=%REPO%"
set "RSI_LEDGER_DIR=%REPO%\ledger"
set "AGENT_KERNEL_REPO=%REPO%\runtime\kernel"
set "PLUGINS_DIR=%REPO%\runtime\plugins"
set "CONFIG_FILE=%REPO%\config.json"
if not defined REACT_FRONTEND set "REACT_FRONTEND=web"

rem -- 内容分发（I-20261108-07/08）：把 sau 装成的 venv 加进**本进程** PATH --
rem 只加 venv 的 Scripts 目录，不改用户全局 PATH：那里还有 pip/python 等同名命令，
rem 加进全局会干扰其他项目。host 的 /api/publish/config 靠 PATH 上的 sau 判定就绪，
rem scripts/publish.py 同样靠 shutil.which("sau") —— 一处注入，两处同时生效。
if exist "%REPO%\tools\sau\.venv\Scripts\sau.exe" set "PATH=%REPO%\tools\sau\.venv\Scripts;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo [rsi] node not found. Install Node.js 22.6 or newer and retry.
  exit /b 1
)

if not exist "%AGENT_KERNEL_REPO%\bindings\typescript\node_modules" (
  echo [rsi] First run: installing TypeScript kernel dependencies...
  pushd "%AGENT_KERNEL_REPO%\bindings\typescript"
  call npm install
  if errorlevel 1 (
    popd
    echo [rsi] npm install failed.
    exit /b 1
  )
  popd
)

python -c "import grpc, httpx" >nul 2>nul
if errorlevel 1 (
  echo [rsi] Installing Python dependencies grpcio httpx...
  python -m pip install grpcio httpx
  if errorlevel 1 (
    echo [rsi] pip install failed.
    exit /b 1
  )
)

set "NEED_MAGPIE="
if exist "%CONFIG_FILE%" (
  findstr /c:"127.0.0.1:3425" "%CONFIG_FILE%" >nul 2>nul
  if not errorlevel 1 set "NEED_MAGPIE=1"
)
if defined NEED_MAGPIE (
  python "%REPO%\scripts\magpie_check.py" --gateway-only --quiet
  if errorlevel 1 (
    rem -- one-click local gateway: prefer %USERPROFILE%\.local\bin\magpie.exe, then PATH --
    if exist "%USERPROFILE%\.local\bin\magpie.exe" (
      echo [rsi] Starting local magpie gateway in a minimized window ...
      start "magpie serve" /min "%USERPROFILE%\.local\bin\magpie.exe" serve
    ) else (
      where magpie >nul 2>nul
      if not errorlevel 1 (
        echo [rsi] Starting local magpie gateway in a minimized window ...
        start "magpie serve" /min magpie serve
      ) else (
        echo [rsi] magpie CLI not found; start it manually: magpie serve
      )
    )
    rem -- give the gateway a couple of seconds to bind 127.0.0.1:3425 --
    timeout /t 3 /nobreak >nul
  )
)

echo [rsi] Starting host (frontend=%REACT_FRONTEND%; workspace=%WORKSPACE_ROOT%)
rem -- web frontend: open the browser only ONCE the host is actually serving --
rem 为什么不能固定等几秒就开（I-20261109-01「重启后 web 页面等半天」的真因）：
rem   cargo run 在下面这行**先编译再启动**。实测：源码有改动时全量重编 25s、只动
rem   agent-loop 也要 2s，之后 assemble 还要 3.1s（bash 沙箱探测 + provider ping +
rem   技能预热）才 bind 端口。旧写法 `timeout /t 4 & start http://...` 在编译没完时
rem   就把浏览器打开了 —— 用户看到的是「连不上/白屏」，等多久取决于编译，于是成了
rem   「等半天」。改成轮询探测：端口真起来（GET / 返回任何响应）才开浏览器。
set "ADDR=%WEB_ADDR%"
if not defined ADDR set "ADDR=127.0.0.1:8710"
if /i "%REACT_FRONTEND%"=="web" if "%~1"=="" (
  echo [rsi] Web UI: http://%ADDR% - waiting for the host to be ready (compiling on first run can take ~30s)...
  echo [rsi] 浏览器会在服务真正就绪后自动打开；Ctrl+C 可随时停止。
  start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\wait-host-ready.ps1" -Url "http://%ADDR%/" -TimeoutSecs 180
)
cargo run --manifest-path "%REPO%\runtime\Cargo.toml" -p react-agent-host %*

set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" (
  echo [rsi] Startup failed: exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
