$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo 'desktop\target\debug\rsi-agent-desktop.exe'
if (-not (Test-Path $exe)) {
    Write-Host '[rsi-agent] building desktop shell...'
    cargo build --manifest-path (Join-Path $repo 'desktop\Cargo.toml') --quiet
    if ($LASTEXITCODE -ne 0) { Write-Host '[rsi-agent] build failed.'; exit 1 }
}
Start-Process -FilePath $exe -WorkingDirectory (Join-Path $repo 'desktop')
