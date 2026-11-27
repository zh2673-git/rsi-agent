<#
apply-env-update.ps1 -- swap runtime-env/ *before* any python starts.

Why a separate script instead of doing it inside update_check.py: while the host is up, the
bundled python.exe and node.exe ARE running images (the host spawned the plugins), so they
cannot be replaced in place. update_check.py `stage-env` therefore only drops
runtime-env.zip into .rsi/update-staging/. run.cmd calls this script before it prepends
runtime-env\python to PATH, i.e. at the only moment nothing in this tree is running from
those binaries. On success the package is deleted so the swap happens exactly once.

The zip is flat-rooted ("runtime-env/..." and "runtime/kernel/bindings/typescript/node_modules/..."),
so it extracts straight over the install dir.

exit 0 = nothing staged, or applied. exit 1 = failed; the zip is kept for the next boot
(run.cmd treats a failure as a warning, never as a startup blocker).
#>
param(
  [string]$Repo = ""
)
$ErrorActionPreference = "Stop"

if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }
$staging = Join-Path $Repo ".rsi\update-staging"
$zip = Join-Path $staging "runtime-env.zip"
$metaFile = Join-Path $staging "env.json"

if (-not (Test-Path -LiteralPath $zip)) { exit 0 }

function Write-Info([string]$msg) { Write-Host "[rsi] $msg" }

# -- 1. integrity: env.json carries the sha256 computed at download time --
if (Test-Path -LiteralPath $metaFile) {
  try {
    $meta = Get-Content -LiteralPath $metaFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($meta.sha256) {
      $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
      if ($actual -ne ([string]$meta.sha256).ToLower()) {
        Write-Warning "runtime-env.zip sha256 mismatch; discarding it."
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $metaFile -Force -ErrorAction SilentlyContinue
        exit 1
      }
    }
  } catch {
    Write-Warning "cannot read env.json ($($_.Exception.Message)); extracting without verification."
  }
}

# -- 2. extract with per-entry tolerance: a locked file must not abort the whole swap --
Add-Type -AssemblyName System.IO.Compression.FileSystem
$failed = New-Object System.Collections.Generic.List[string]
$written = 0
try {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
} catch {
  Write-Warning "cannot open runtime-env.zip: $($_.Exception.Message)"
  exit 1
}
try {
  foreach ($e in $archive.Entries) {
    if ([string]::IsNullOrEmpty($e.Name)) { continue }   # directory entry
    $dest = Join-Path $Repo ($e.FullName -replace '/', '\')
    $dir = Split-Path -Parent $dest
    try {
      if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
      $written++
    } catch {
      $failed.Add($e.FullName)
    }
  }
} finally {
  $archive.Dispose()
}

if ($failed.Count -gt 0) {
  Write-Warning "$($failed.Count) runtime file(s) could not be replaced (still in use); retrying next start."
  foreach ($f in ($failed | Select-Object -First 5)) { Write-Host "         $f" }
  exit 1
}

# -- 3. record the new fingerprint so the next check() sees no pending runtime change --
#    NOTE: Windows PowerShell's `Set-Content -Encoding UTF8` writes a BOM, and python's
#    json.loads(..., encoding="utf-8") then dies on it -- write plain UTF-8 instead.
if (Test-Path -LiteralPath $metaFile) {
  try {
    $meta = Get-Content -LiteralPath $metaFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($meta.meta) {
      $json = $meta.meta | ConvertTo-Json -Depth 12
      $target = Join-Path $Repo "runtime-env\runtime.json"
      [System.IO.File]::WriteAllText($target, $json, (New-Object System.Text.UTF8Encoding($false)))
    }
  } catch {
    Write-Warning "could not refresh runtime-env\runtime.json: $($_.Exception.Message)"
  }
}

Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $metaFile -Force -ErrorAction SilentlyContinue
Write-Info "runtime updated ($written files)."
exit 0
