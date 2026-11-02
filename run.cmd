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
rem -- web frontend: open browser after 4s; skip in one-shot mode --
set "ADDR=%WEB_ADDR%"
if not defined ADDR set "ADDR=127.0.0.1:8710"
if /i "%REACT_FRONTEND%"=="web" if "%~1"=="" (
  echo [rsi] Web UI: http://%ADDR% - browser opens in a few seconds; Ctrl+C to stop
  start "" cmd /c "timeout /t 4 /nobreak >nul & start http://%ADDR%"
)
cargo run --manifest-path "%REPO%\runtime\Cargo.toml" -p react-agent-host %*

set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" (
  echo [rsi] Startup failed: exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
