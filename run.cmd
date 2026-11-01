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

echo [rsi] Starting host (frontend=%REACT_FRONTEND%; workspace=%WORKSPACE_ROOT%)
cargo run --manifest-path "%REPO%\runtime\Cargo.toml" -p react-agent-host %*

set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" (
  echo [rsi] Startup failed: exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
