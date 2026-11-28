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

rem ============================================================
rem staged runtime update: apply runtime-env.zip BEFORE anything here starts python/node.
rem   the zip is put there by `python scripts\update_check.py stage-env` (run from the host when
rem   it notices a changed runtime fingerprint); python.exe/node.exe cannot be replaced while the
rem   running host still has them open, so the swap waits for this moment. Failure is a warning
rem   only -- a broken runtime patch must never keep the app from starting.
rem ============================================================
if exist "%REPO%\.rsi\update-staging\runtime-env.zip" (
  echo [rsi] Applying staged runtime update...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\apply-env-update.ps1" -Repo "%REPO%"
  if errorlevel 1 echo [rsi] runtime update deferred to next start.
)

rem ============================================================
rem bundled runtime (one-click install): runtime-env/ ships portable Python + Node, so the
rem user needs neither installed and neither pip nor npm at run time.
rem   runtime-env/python/python.exe   CPython 3.11 (embeddable) + grpcio/protobuf/httpx
rem   runtime-env/node/node.exe       Node 22 (single exe; no npm/npx)
rem PATH is prepended for THIS process only (never the global PATH). It also makes the
rem `where node` / `where cargo` probes below and every `python ...` call resolve to the
rem bundled copies, so a machine with no Python/Node at all still runs.
rem The bundled python does have grpc/httpx, so it does NOT recreate the shadowing problem
rem described further down (that note is about tools\sau\.venv).
rem ============================================================
set "BUNDLED_ENV="
if exist "%REPO%\runtime-env\python\python.exe" if exist "%REPO%\runtime-env\node\node.exe" (
  set "BUNDLED_ENV=1"
  set "PATH=%REPO%\runtime-env\python;%REPO%\runtime-env\node;%PATH%"
)

rem -- content publishing: add the sau venv to THIS process PATH only --
rem -- do not touch the global PATH (pip/python collisions); both host /api/publish/config and scripts/publish.py rely on sau on PATH --
where node >nul 2>nul
if errorlevel 1 (
  echo [rsi] node not found. Install Node.js 22.6 or newer and retry.
  exit /b 1
)

rem -- bundled runtime: node_modules for the TS kernel SDK ships in the package and the
rem -- bundled python already has grpc/httpx/protobuf, so neither npm nor pip runs at all.
rem -- (On a source tree BUNDLED_ENV is unset and both steps behave exactly as before.)
if not defined BUNDLED_ENV (
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
)

python -c "import grpc, httpx" >nul 2>nul
if errorlevel 1 (
  if defined BUNDLED_ENV (
    echo [rsi] bundled python is missing grpcio/httpx; the package is corrupt.
    exit /b 1
  )
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
rem runtime/ is the single source of truth (do NOT auto-pull from react-agent).
rem   Reports upstream drift only; nothing is written at startup. To pull on
rem   purpose: python scripts\sync_runtime.py --force (then re-applies patches).
rem ============================================================
python "%REPO%\scripts\sync_runtime.py"

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
rem -- no-cargo mode: zip users run the shipped release exe as-is (stamp check would force a build)
rem -- also when runtime/Cargo.toml is absent: the zip ships prebuilt binaries without the Rust
rem    sources, so a cargo build there can only fail -- treat it as no-cargo regardless of PATH
set "NO_CARGO="
where cargo >nul 2>nul
if errorlevel 1 set "NO_CARGO=1"
if not exist "%REPO%\runtime\Cargo.toml" set "NO_CARGO=1"
if defined NO_CARGO (
  if exist "%HOST_EXE%" (
    set "NEED_BUILD="
    goto :no_cargo
  ) else (
    echo [rsi] prebuilt host missing: %HOST_EXE%
    echo [rsi] Download the prebuilt zip from https://github.com/zh2673-git/rsi-agent/releases and retry.
    exit /b 1
  )
)
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
:no_cargo

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
    rem -- gateway not running: start one WITHOUT a console window and record its PID --
    rem -- start /b reuses the (hidden) parent console -> no flashing window on startup.
    rem -- PID lookup still works: WMI sees the same `magpie.exe serve` command line.
    rem -- packaged copy first: setup.exe ships the CLI at <INSTDIR>\bin\magpie.exe, so a clean
    rem -- machine with no magpie.exe installed still gets a one-click gateway.
    if exist "%REPO%\bin\magpie.exe" (
      echo [rsi] Starting local gateway in background ...
      start "" /b "%REPO%\bin\magpie.exe" serve
    ) else if exist "%USERPROFILE%\.local\bin\magpie.exe" (
      echo [rsi] Starting local gateway in background ...
      start "" /b "%USERPROFILE%\.local\bin\magpie.exe" serve
    ) else (
      where magpie >nul 2>nul
      if not errorlevel 1 (
        echo [rsi] Starting local gateway in background ...
        start "" /b magpie serve
      ) else (
        echo [rsi] gateway CLI not found; start it manually: magpie serve
      )
    )
    rem -- WMI lookup of the magpie.exe serve PID we just started (start /b gives no PID) --
    for /f "delims=" %%P in ('python "%REPO%\scripts\magpie_pid.py" find') do set "MAGPIE_PID=%%P"
    rem -- give the gateway a couple of seconds to bind 127.0.0.1:3425 --
    timeout /t 3 /nobreak >nul
  ) else (
    echo [rsi] Local gateway already running; reusing it ^(not owned by run.cmd^).
  )
)

rem -- IM gateway supervisor: auto start/reload IM adapters from saved config. --
rem -- Runs inside this cmd tree so desktop-shell exit (taskkill /T) cleans it up. --
rem -- Single-instance pidfile makes repeated run.cmd calls idempotent. --
if exist "%REPO%\im-gateway\supervise.py" (
  start "" /b python "%REPO%\im-gateway\supervise.py" run
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

set "HOST_EXIT=%errorlevel%"

rem -- stop IM gateway supervisor (sends stop request; it stops all platform gateways) --
if exist "%REPO%\im-gateway\supervise.py" (
  python "%REPO%\im-gateway\supervise.py" stop >nul 2>nul
)
set "EXIT_CODE=%HOST_EXIT%"

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
