# 等待 host 就绪后打开浏览器（run.cmd 调用）。
#
# 为什么不写在 run.cmd 里内联：cmd 会吃掉 `$u`/`$r` 这类 PowerShell 变量名
# （连同引号一起吞掉变量字母，实测 `$u` → 空、`$r` → `ll`），内联必定炸。
# 单独成文件后，cmd 只负责传两个参数，转义面归零。
#
# 参数：-Url http://127.0.0.1:8710/  -TimeoutSecs 180
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$TimeoutSecs = 180,
    [switch]$NoOpen
)

$limit = (Get-Date).AddSeconds($TimeoutSecs)
while ((Get-Date) -lt $limit) {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -ge 200) {
            Write-Host "[rsi] host ready ($($r.StatusCode)) -> opening $Url"
            if (-not $NoOpen) { Start-Process $Url }
            exit 0
        }
    } catch { }
    Start-Sleep -Milliseconds 500
}
Write-Host "[rsi] host did not become ready within ${TimeoutSecs}s; open $Url manually."
exit 7
