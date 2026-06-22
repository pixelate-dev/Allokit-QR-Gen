# First-time Fly.io setup for Allokit (run from project root).
# Requires: flyctl installed and logged in (https://fly.io/docs/flyctl/install/)
#
# Usage:
#   .\scripts\fly-init.ps1
#   .\scripts\fly-init.ps1 -AppName my-allokit-demo -Region ord
#
# Optional demo API key (mutating requests require X-API-Key in the UI):
#   fly secrets set ALLOKIT_API_KEY="your-secret" -a allokit-demo
#
# Optional CORS lock-down (same-origin deploy does not need this):
#   fly secrets set ALLOKIT_CORS_ORIGINS="https://allokit-demo.fly.dev" -a allokit-demo

param(
    [string]$AppName = "allokit-demo",
    [string]$Region = "iad"
)

$ErrorActionPreference = "Stop"

Write-Host "Creating Fly app '$AppName' in region '$Region' (skip if it already exists)..."
fly apps create $AppName --org personal 2>$null

Write-Host "Updating fly.toml app name..."
$toml = Get-Content fly.toml
$toml = $toml -replace '^app = .*', "app = `"$AppName`""
$toml = $toml -replace '^primary_region = .*', "primary_region = `"$Region`""
$toml | Set-Content fly.toml

Write-Host "Creating persistent volume 'allokit_data' (1 GB)..."
fly volumes create allokit_data --size 1 --region $Region -a $AppName -y

Write-Host "Deploying..."
fly deploy -a $AppName

Write-Host ""
Write-Host "Done. Open: https://$AppName.fly.dev/pages/generate.html"
Write-Host "To set a demo API key: fly secrets set ALLOKIT_API_KEY=`"your-secret`" -a $AppName"
