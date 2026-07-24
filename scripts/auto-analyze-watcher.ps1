# Auto-analysis watcher for controlled submissions (review-assist pilot).
#
# Polls the LOCAL backend; for any new student submission (from the Mini Program
# OR the web — both land in the same queue) it auto-accepts the submission and
# runs the offline analysis (run-batch) so the two-layer review-assist is ready
# on the teacher console WITHOUT anyone hand-running run-batch.
#
# SAFETY (unchanged): this automates ONLY the machine-analysis step. The teacher
# review + release stays a manual human gate; nothing is auto-released to a
# student; the three student runtime switches stay false / fail-closed. This
# only calls existing public/local HTTP endpoints — it does not touch server
# source or any gate.
#
# Run it in its own window and keep it open (like the backend window):
#   powershell -ExecutionPolicy Bypass -File scripts\auto-analyze-watcher.ps1

$ErrorActionPreference = "Stop"
$Base = "http://127.0.0.1:3000"
$IntervalSeconds = 8
$RunBatchTimeoutSec = 300
$SeenPath = Join-Path $PSScriptRoot "..\data\experiments\western-strings-m3\auto-analyze-seen.json"

function Load-Seen {
  if (Test-Path $SeenPath) {
    try { return [System.Collections.Generic.HashSet[string]]([string[]](Get-Content $SeenPath -Raw | ConvertFrom-Json)) } catch { }
  }
  return [System.Collections.Generic.HashSet[string]]::new()
}
function Save-Seen($seen) {
  $dir = Split-Path $SeenPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  ($seen | ConvertTo-Json) | Out-File -FilePath $SeenPath -Encoding utf8
}
function Stamp { (Get-Date).ToString("HH:mm:ss") }

Write-Host "=== 自动分析守护已启动 ===" -ForegroundColor Green
Write-Host "后端: $Base   轮询: 每 ${IntervalSeconds}s" -ForegroundColor DarkGray
Write-Host "作用: 学生一提交(小程序/网页)-> 自动接受入批 + 自动跑分析 -> 待老师复核" -ForegroundColor DarkGray
Write-Host "不做: 不放行学生、不翻开关、不改后端源码。老师复核+放行仍手动。" -ForegroundColor DarkGray
Write-Host "停止: Ctrl+C。" -ForegroundColor DarkGray
Write-Host ""

$seen = Load-Seen

while ($true) {
  try {
    $list = Invoke-RestMethod -Uri "$Base/api/strings/controlled-submissions?limit=100" -TimeoutSec 15
    $toAccept = New-Object System.Collections.Generic.List[string]
    $toAnalyze = New-Object System.Collections.Generic.List[string]

    foreach ($s in $list.submissions) {
      $id = [string]$s.submissionId
      if ([string]::IsNullOrWhiteSpace($id)) { continue }
      if ($seen.Contains($id)) { continue }
      if ($s.status -eq "feedback_released") { [void]$seen.Add($id); continue }
      if ($s.latestAnalysis) { [void]$seen.Add($id); continue }   # 已分析过
      if ($s.status -eq "review_required") { $toAccept.Add($id) }
      $toAnalyze.Add($id)
    }

    foreach ($id in $toAccept) {
      $body = @{ submissionId = $id; action = "accepted_for_batch"; reviewerId = "auto-analyze-watcher"; comments = "auto-accepted for analysis" } | ConvertTo-Json -Compress
      try {
        Invoke-RestMethod -Method Post -Uri "$Base/api/strings/controlled-submissions/reviews" -Body $body -ContentType "application/json; charset=utf-8" -TimeoutSec 15 | Out-Null
        Write-Host "[$(Stamp)] 已接受入批: $id" -ForegroundColor Cyan
      } catch { Write-Host "[$(Stamp)] 接受失败 $id : $($_.Exception.Message)" -ForegroundColor Yellow }
    }

    if ($toAnalyze.Count -gt 0) {
      $idsJson = ($toAnalyze | ForEach-Object { '"' + $_ + '"' }) -join ","
      $batchBody = '{"limit":' + $toAnalyze.Count + ',"submissionIds":[' + $idsJson + ']}'
      Write-Host "[$(Stamp)] 跑分析 $($toAnalyze.Count) 条(Basic Pitch,可能 1-2 分钟/条)..." -ForegroundColor Cyan
      try {
        $res = Invoke-RestMethod -Method Post -Uri "$Base/api/strings/controlled-submissions/run-batch" -Body $batchBody -ContentType "application/json" -TimeoutSec $RunBatchTimeoutSec
        $b = $res.batch
        Write-Host "[$(Stamp)] 分析完成: itemCount=$($b.itemCount) offlineProduced=$($b.offlineAnalysisProducedCount) status=$($b.status)" -ForegroundColor Green
        Write-Host "[$(Stamp)] -> 打开复核台复核放行即可。" -ForegroundColor DarkGray
      } catch { Write-Host "[$(Stamp)] 分析调用失败: $($_.Exception.Message)" -ForegroundColor Yellow }
      foreach ($id in $toAnalyze) { [void]$seen.Add($id) }
      Save-Seen $seen
    }
  } catch {
    Write-Host "[$(Stamp)] 轮询出错(后端可能没起): $($_.Exception.Message)" -ForegroundColor Yellow
  }
  Start-Sleep -Seconds $IntervalSeconds
}
