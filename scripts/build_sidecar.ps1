$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

Write-Host "==> Détection du target Rust..."
$rustInfo = rustc -Vv
$target = ($rustInfo | Select-String '^host:\s+(.*)$').Matches[0].Groups[1].Value.Trim()
if (-not $target) {
  throw "Impossible de détecter le target triple Rust."
}
Write-Host "Target détecté :" $target

$ApiPath = "backend\api.py"

if (-not (Test-Path $ApiPath)) {
  throw "api.py introuvable : $ApiPath"
}

Write-Host "==> Installation / mise à jour de PyInstaller..."
python -m pip install -U pyinstaller

Write-Host "==> Build du backend Python..."
python -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --name media-indexer-api `
  --paths backend `
  --hidden-import uvicorn.logging `
  --hidden-import uvicorn.loops.auto `
  --hidden-import uvicorn.protocols.http.auto `
  --hidden-import uvicorn.protocols.websockets.auto `
  --hidden-import uvicorn.lifespan.on `
  --hidden-import watchdog.observers.winapi `
  --collect-all openpyxl `
  $ApiPath

if ($LASTEXITCODE -ne 0) {
  throw "PyInstaller a échoué."
}

Write-Host "==> Copie du sidecar dans src-tauri\binaries ..."
New-Item -ItemType Directory -Force "src-tauri\binaries" | Out-Null
Copy-Item "dist\media-indexer-api.exe" "src-tauri\binaries\media-indexer-api-$target.exe" -Force

Write-Host ""
Write-Host "OK : sidecar prêt ici : src-tauri\binaries\media-indexer-api-$target.exe"
Write-Host "Ensuite lance : npm run build"