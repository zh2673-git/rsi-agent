@echo off
setlocal
cd /d "%~dp0"
set /p RSI_REL_VER=Version to release (e.g. 0.1.27): 
if "%RSI_REL_VER%"=="" (
  echo [FAIL] no version given
  pause
  exit /b 1
)
python scripts\release.py --version %RSI_REL_VER%
echo.
echo exit=%ERRORLEVEL%
pause
