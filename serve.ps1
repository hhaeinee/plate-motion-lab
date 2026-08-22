# =========================================================
#  Plate Motion Lab — 간단 로컬 서버
#  카메라는 file:// 에서 동작하지 않으므로 localhost 로 열어야 합니다.
#
#  사용법: 이 폴더에서 PowerShell로
#      powershell -ExecutionPolicy Bypass -File serve.ps1
#  종료:   Ctrl + C
# =========================================================

$port = 8000
$root = $PSScriptRoot

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.md'   = 'text/markdown; charset=utf-8'
  '.task' = 'application/octet-stream'
  '.wasm' = 'application/wasm'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try {
  $listener.Start()
} catch {
  Write-Host "포트 $port 를 열 수 없습니다. 다른 프로그램이 사용 중인지 확인하세요." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "  Plate Motion Lab 실행 중" -ForegroundColor Green
Write-Host "  http://localhost:$port/" -ForegroundColor Cyan
Write-Host "  (종료하려면 Ctrl + C)"
Write-Host ""

Start-Process "http://localhost:$port/"

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
  } catch {
    break
  }
  $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
  if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }
  $path = Join-Path $root $rel

  if (Test-Path $path -PathType Leaf) {
    $ext = [System.IO.Path]::GetExtension($path).ToLower()
    $type = $mime[$ext]
    if (-not $type) { $type = 'application/octet-stream' }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $ctx.Response.ContentType = $type
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $ctx.Response.StatusCode = 404
    $msg = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
    $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
  }
  $ctx.Response.OutputStream.Close()
}

$listener.Stop()
