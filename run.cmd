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
rem -- RSI_NO_BROWSER=1: skip auto browser when called by the desktop shell (WebView loads the page itself) --

rem -- content publishing: add the sau venv to THIS process PATH only --
rem -- do not touch the global PATH (pip/python collisions); both host /api/publish/config and scripts/publish.py rely on sau on PATH --
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

rem -- NOTE: do NOT prepend tools\sau\.venv\Scripts to PATH here. It also brings a
rem -- python.exe without grpc/httpx, which shadows the system python for host plugins
rem -- (ModuleNotFoundError: grpc). Publish features should put sau on PATH explicitly. --

rem ============================================================
rem P0 perf: release-first startup (no debug cargo run on every start)
rem   diagnosis: cargo run defaults to debug profile, incremental compile/link every start;
rem     measured ~25s full rebuild on source change, 2s on agent-loop change, cargo/rustc
rem     threads saturate CPU -> fan spins. Now: run release exe directly when code unchanged.
rem   change detection: only code files (.rs/.py/.toml/Cargo.lock) mtime,
rem     exclude runtime data like session.index.json (written every run -> false rebuild).
rem ============================================================
set "HOST_EXE=%REPO%\runtime\target\release\react-agent-host.exe"
set "STAMP=%REPO%\runtime\target\.rsi-release-stamp"
set "NEED_BUILD="
if not exist "%HOST_EXE%" (
  set "NEED_BUILD=1"
) else (
  rem -- compare latest code mtime with stamp via Python (portable, no extra deps) --
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
rem P0 lifecycle: gateway is managed only for instances started by run.cmd
rem   diagnosis: old "start /min magpie serve" left no PID and no cleanup;
rem     repeated runs left stale gateways + plugin-host (each ~100MB) with no owner.
rem   strategy: gateway already running -> never touch it (owned by user/other instance);
rem     we start it -> record PID, kill only that PID (and its bun children) on host exit.
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
    rem -- gateway not running: start one and record its PID --
    if exist "%USERPROFILE%\.local\bin\magpie.exe" (
      echo [rsi] Starting local gateway in a minimized window ...
      start "magpie serve" /min "%USERPROFILE%\.local\bin\magpie.exe" serve
    ) else (
      where magpie >nul 2>nul
      if not errorlevel 1 (
        echo [rsi] Starting local gateway in a minimized window ...
        start "magpie serve" /min magpie serve
      ) else (
        echo [rsi] gateway CLI not found; start it manually: magpie serve
      )
    )
    rem -- WMI lookup of the magpie.exe serve PID we just started (start /min gives no PID) --
    for /f "delims=" %%P in ('python "%REPO%\scripts\magpie_pid.py" find') do set "MAGPIE_PID=%%P"
    rem -- give the gateway a couple of seconds to bind 127.0.0.1:3425 --
    timeout /t 3 /nobreak >nul
  ) else (
    echo [rsi] Local gateway already running; reusing it ^(not owned by run.cmd^).
  )
)

echo [rsi] Starting host ^(release=%REACT_FRONTEND%; workspace=%WORKSPACE_ROOT%^)
rem -- web frontend: open the browser only ONCE the host is actually serving --
rem -- no fixed sleep (I-20261109-01 "web page hangs after restart"): release exe needs no compile,
rem   but assemble still takes ~3.1s (bash sandbox probe + provider ping + skill warmup) to bind.
rem   Fixed wait is unreliable -> poll instead.
set "ADDR=%WEB_ADDR%"
if not defined ADDR set "ADDR=127.0.0.1:8710"
if /i "%REACT_FRONTEND%"=="web" if "%~1"=="" if not "%RSI_NO_BROWSER%"=="1" (
  echo [rsi] Web UI: http://%ADDR% - waiting for the host to be ready...
  echo [rsi] Browser opens once the service is ready; Ctrl+C to stop anytime.
  start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\wait-host-ready.ps1" -Url "http://%ADDR%/" -TimeoutSecs 180
)
"%HOST_EXE%" %*

set "EXIT_CODE=%errorlevel%"

rem -- clean up ONLY the gateway started by this run.cmd (incl. bun children), never touch user instances --
if defined MAGPIE_PID (
  echo [rsi] Stopping gateway ^(PID !MAGPIE_PID!^) started by this run...
  python "%REPO%\scripts\magpie_pid.py" stop !MAGPIE_PID!
)

if not "%EXIT_CODE%"=="0" (
  echo [rsi] Startup failed: exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
