# iniciar-defensa.ps1
# Levanta ScanOrder completo para la demo: MySQL (XAMPP) + backend + frontend estatico + tunel Cloudflare.
# Requiere: XAMPP instalado en C:\xampp, venv creado en backend\venv.
#
# Uso: clic derecho -> "Ejecutar con PowerShell", o desde una terminal:
#   powershell -ExecutionPolicy Bypass -File iniciar-defensa.ps1
#
# Abre 3 ventanas de PowerShell nuevas, una por servicio, para poder ver los logs de cada uno
# y cerrarlas de forma independiente si hace falta.

$root = $PSScriptRoot
$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"

# --- MySQL (XAMPP) ---
$mysqlListo = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
if ($mysqlListo) {
    Write-Host "MySQL ya esta corriendo." -ForegroundColor Green
} else {
    Write-Host "Iniciando MySQL (XAMPP)..." -ForegroundColor Cyan
    Start-Process "C:\xampp\mysql_start.bat"

    $intentos = 0
    do {
        Start-Sleep -Seconds 2
        $intentos++
        $mysqlListo = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
    } while (-not $mysqlListo -and $intentos -lt 15)

    if ($mysqlListo) {
        Write-Host "MySQL listo." -ForegroundColor Green
    } else {
        Write-Host "MySQL no respondio en 30s. Abri el Panel de XAMPP y fijate que error tira." -ForegroundColor Red
        Read-Host "Presiona Enter para salir"
        exit 1
    }
}

Write-Host "Iniciando backend (puerto 8000)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; .\venv\Scripts\Activate.ps1; uvicorn app.main:app --port 8000"
Start-Sleep -Seconds 3

Write-Host "Iniciando frontend estatico (puerto 5500)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; python -m http.server 5500"
Start-Sleep -Seconds 2

Write-Host "Iniciando tunel Cloudflare..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "& '$cloudflared' tunnel run scanorder"
Start-Sleep -Seconds 5

Write-Host ""
Write-Host "Listo. Verificar:" -ForegroundColor Green
Write-Host "  Admin (local):  http://localhost:5500/frontend/login.html"
Write-Host "  Menu (publico): https://menu.scanorder.tech/frontend/cliente/menu.html"
Write-Host "  API  (publico): https://api.scanorder.tech/health"
Write-Host ""
Write-Host "Para cortar todo: cerra las 3 ventanas que se abrieron." -ForegroundColor Yellow
