<#
    Regenerates the user guide PDF from build\guide\guide.html.

    The guide is a plain HTML file (build\guide\guide.html) with its
    screenshots in build\guide\img\. This script renders it to
    DPM-FTE-Calculator-Guide.pdf at the repository root using headless
    Microsoft Edge - no extra tools to install.

    To refresh the screenshots after a UI change, recapture them into
    build\guide\img\ (same file names), then run this script.

    Usage:  powershell -ExecutionPolicy Bypass -File build\Make-Guide.ps1
#>

[CmdletBinding()]
param(
    [string] $OutputName = 'DPM-FTE-Calculator-Guide.pdf'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$AppRoot = Split-Path -Parent $PSScriptRoot
$guide   = Join-Path $AppRoot 'build\guide\guide.html'
$outPath = Join-Path $AppRoot $OutputName

if (-not (Test-Path -LiteralPath $guide)) { throw "Missing guide source: $guide" }

$edgeCandidates = @(
    (Join-Path $env:ProgramFiles        'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge was not found. Install Edge, or print build\guide\guide.html to PDF by hand.' }

$profile = Join-Path $env:TEMP ('fte-guide-' + [guid]::NewGuid().ToString('N'))
$uri     = ([Uri]$guide).AbsoluteUri
if (Test-Path -LiteralPath $outPath) { Remove-Item -LiteralPath $outPath -Force }

Write-Host ''
Write-Host '  Rendering the user guide to PDF...' -ForegroundColor Cyan
& $edge --headless=new --disable-gpu --no-first-run --no-default-browser-check `
        --user-data-dir="$profile" --print-to-pdf-no-header --print-to-pdf="$outPath" $uri 2>$null
Start-Sleep -Seconds 2
Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $outPath)) { throw 'Edge did not produce a PDF. Try printing the HTML to PDF by hand.' }
$sizeKb = [math]::Round((Get-Item $outPath).Length / 1KB)
Write-Host "  Done: $OutputName  ($sizeKb KB)" -ForegroundColor Green
Write-Host ''
