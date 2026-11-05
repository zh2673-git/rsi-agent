@echo off
REM 后台配音：Qwen3-TTS 每进程加载模型约 25s，7 镜一次 CLI 调用会超过前台超时窗口。
REM 写 logs/voice.out 与 logs/voice.done 供轮询。
REM
REM 关键：不要把 stdout 重定向到文件（`> voice.out`）。cmd 的 `>` 会让子进程继承
REM 一个不可用的 stdin，qwen3_tts_worker.py 读到 sys.stdin 为 None 直接退出，
REM 表现为「配音跑了几镜就莫名停了、日志只剩几个 ^C」。改用 -RedirectOutput 系列
REM 由 PowerShell 保留管道。
cd /d "%~dp0.."
set PROJ=%1
if "%PROJ%"=="" exit /b 1
del /q "projects\%PROJ%\logs\voice.done" 2>nul
powershell -NoProfile -Command "$d='%~dp0..'; Set-Location $d; & node .\node_modules\tsx\dist\cli.mjs scripts\voice-all.mjs '%PROJ%' 1> \"projects\%PROJ%\logs\voice.out\" 2>&1; \"EXIT=$LASTEXITCODE\" | Set-Content \"projects\%PROJ%\logs\voice.done\" -Encoding UTF8"
