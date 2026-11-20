@echo off
setlocal enabledelayedexpansion
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
rem -- RSI_NO_BROWSER=1：由桌面薄壳调用时跳过自动开浏览器（WebView 自己加载页面） --

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

rem ============================================================
rem P0 性能：release 预编译启动（不再每次 cargo run 调试编译）
rem   诊断：cargo run 默认 debug profile，每次启动都做增量编译/链接；
rem         实测源码变更时全量重编 25s、agent-loop 变动 2s，期间 cargo/rustc
rem         多线程吃满 CPU → 风扇狂转。改为「代码没变就直接跑 release exe」。
rem   变更检测：只对代码文件（.rs/.py/.toml/Cargo.lock）取最新 mtime，
rem           **排除** session.index.json 等运行时数据（它们每次运行都会写，
rem           若纳入会导致每次启动都误判「代码变了」）。
rem ============================================================
set "HOST_EXE=%REPO%\runtime\target\release\react-agent-host.exe"
set "STAMP=%REPO%\runtime\target\.rsi-release-stamp"
set "NEED_BUILD="
if not exist "%HOST_EXE%" (
  set "NEED_BUILD=1"
) else (
  rem -- 用 Python 比较代码最新 mtime 与 stamp（跨平台、无外部依赖） --
  for /f "delims=" %%R in ('python "%REPO%\scripts\release_stamp.py" check "%REPO%" "%STAMP%"') do set "STAMP_RC=%%R"
  if "!STAMP_RC!"=="1" set "NEED_BUILD=1"
)
if defined NEED_BUILD (
  echo [rsi] Building host ^(release^) - this happens only when code changes...
  cargo build --manifest-path "%REPO%\runtime\Cargo.toml" -p react-agent-host --release
  if errorlevel 1 (
    echo [rsi] cargo build failed.
    exit /b 1
  )
  python "%REPO%\scripts\release_stamp.py" stamp "%REPO%" "%STAMP%"
)

rem ============================================================
rem P0 生命周期：magpie 网关只由 run.cmd 管理自己启动的实例
rem   诊断：旧版 start /min magpie serve 无 PID 记录、无退出清理；
rem         反复运行会残留多个网关 + plugin-host（各 ~100MB），且无人回收。
rem   策略：网关已在跑 → 完全不碰（用户/别的实例拥有）；
rem         我们启动 → 记录 PID，host 退出后只 kill 这个 PID（含其子 bun）。
rem ============================================================
set "MAGPIE_PID="
set "NEED_MAGPIE="
if exist "%CONFIG_FILE%" (
  findstr /c:"127.0.0.1:3425" "%CONFIG_FILE%" >nul 2>nul
  if not errorlevel 1 set "NEED_MAGPIE=1"
)
if defined NEED_MAGPIE (
  python "%REPO%\scripts\magpie_check.py" --gateway-only --quiet
  if errorlevel 1 (
    rem -- 网关未运行：我们启动一个，并记录 PID --
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
    rem -- 用 WMI 反查我们刚启动的 magpie.exe serve 的 PID（start /min 不直接给 PID） --
    for /f "delims=" %%P in ('python "%REPO%\scripts\magpie_pid.py" find') do set "MAGPIE_PID=%%P"
    rem -- give the gateway a couple of seconds to bind 127.0.0.1:3425 --
    timeout /t 3 /nobreak >nul
  ) else (
    echo [rsi] Local magpie gateway already running; reusing it ^(not owned by run.cmd^).
  )
)

echo [rsi] Starting host ^(release=%REACT_FRONTEND%; workspace=%WORKSPACE_ROOT%^)
rem -- web frontend: open the browser only ONCE the host is actually serving --
rem 为什么不能固定等几秒就开（I-20261109-01「重启后 web 页面等半天」的真因）：
rem   现在 release exe 已无需编译，但 assemble 仍需 ~3.1s（bash 沙箱探测 + provider
rem   ping + 技能预热）才 bind 端口。固定等待依然不可靠 —— 改成轮询探测。
set "ADDR=%WEB_ADDR%"
if not defined ADDR set "ADDR=127.0.0.1:8710"
if /i "%REACT_FRONTEND%"=="web" if "%~1"=="" if not "%RSI_NO_BROWSER%"=="1" (
  echo [rsi] Web UI: http://%ADDR% - waiting for the host to be ready...
  echo [rsi] 浏览器会在服务真正就绪后自动打开；Ctrl+C 可随时停止。
  start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\wait-host-ready.ps1" -Url "http://%ADDR%/" -TimeoutSecs 180
)
"%HOST_EXE%" %*

set "EXIT_CODE=%errorlevel%"

rem -- 只清理本 run.cmd 启动的 magpie（含其 bun 子进程），不碰用户已有实例 --
if defined MAGPIE_PID (
  echo [rsi] Stopping magpie gateway ^(PID !MAGPIE_PID!^) started by this run...
  python "%REPO%\scripts\magpie_pid.py" stop !MAGPIE_PID!
)

if not "%EXIT_CODE%"=="0" (
  echo [rsi] Startup failed: exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
