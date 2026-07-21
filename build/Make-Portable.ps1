<#
    Builds a single self-contained HTML file for sharing.

    The normal app is a folder: index.html plus assets\, lib\ and server\.
    That is the right shape for daily use, but awkward to email. This script
    folds the stylesheet, the application code and both libraries into one
    .html file that a colleague can open by double-clicking.

    The portable build necessarily runs in browser-storage-only mode: a single
    file has no local host behind it, so it cannot write JSON into a data
    folder. It says so in its own header. Use the launcher for real work.

    Usage:  powershell -ExecutionPolicy Bypass -File build\Make-Portable.ps1
#>

[CmdletBinding()]
param(
    [string] $OutputName = 'DPM-FTE-Calculator-portable.html'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$AppRoot = Split-Path -Parent $PSScriptRoot
$Utf8    = New-Object System.Text.UTF8Encoding($false)

function Read-Asset {
    param([string]$RelativePath)
    $full = Join-Path $AppRoot $RelativePath
    if (-not (Test-Path $full)) { throw "Missing required file: $RelativePath" }
    return [System.IO.File]::ReadAllText($full)
}

# PowerShell's -replace treats the replacement as a pattern in which $1, $& and
# friends are substitution tokens. CSS and minified JS are full of $ characters,
# so every substitution here is done as a literal string operation instead.
function Replace-Once {
    param([string]$Haystack, [string]$Needle, [string]$Replacement)
    $i = $Haystack.IndexOf($Needle, [StringComparison]::Ordinal)
    if ($i -lt 0) { throw "Could not find placeholder in index.html: $Needle" }
    return $Haystack.Substring(0, $i) + $Replacement + $Haystack.Substring($i + $Needle.Length)
}

# A literal </script> inside inlined JavaScript would terminate the surrounding
# block. Splitting the token keeps the source semantically identical.
function Protect-ScriptContent {
    param([string]$Js)
    return $Js.Replace('</script', '<\/script')
}

Write-Host ''
Write-Host '  Building portable single-file build...' -ForegroundColor Cyan

$html = Read-Asset 'index.html'

# --- stylesheet ------------------------------------------------------------
$css  = Read-Asset 'assets\app.css'
$html = Replace-Once $html '<link rel="stylesheet" href="assets/app.css">' "<style>`n$css`n</style>"
Write-Host ("    inlined {0,-28} {1,9:N0} chars" -f 'assets\app.css', $css.Length) -ForegroundColor DarkGray

# --- scripts, in load order ------------------------------------------------
$scripts = @(
    'lib\chart.umd.min.js',
    'lib\xlsx.full.min.js',
    'assets\data.js',
    'assets\calc.js',
    'assets\db.js',
    'assets\ui.js',
    'assets\export.js',
    'assets\app.js'
)

foreach ($rel in $scripts) {
    $tag  = '<script src="' + ($rel -replace '\\', '/') + '"></script>'
    $code = Protect-ScriptContent (Read-Asset $rel)
    $html = Replace-Once $html $tag "<script>`n$code`n</script>"
    Write-Host ("    inlined {0,-28} {1,9:N0} chars" -f $rel, $code.Length) -ForegroundColor DarkGray
}

# --- banner explaining the reduced storage mode ----------------------------
$banner = @'
<div style="background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;padding:9px 16px;font-size:.8rem;text-align:center">
  <b>Portable build.</b> Calculations are saved inside this browser only &mdash; a single file cannot write JSON into a data folder.
  For the full version that saves to disk, use <b>Start FTE Calculator.cmd</b>.
</div>
'@
$html = Replace-Once $html '<div class="shell">' ($banner + "<div class=""shell"">")

$outPath = Join-Path $AppRoot $OutputName
[System.IO.File]::WriteAllText($outPath, $html, $Utf8)

$sizeMb = [math]::Round((Get-Item $outPath).Length / 1MB, 2)
Write-Host ''
Write-Host "  Done: $OutputName  ($sizeMb MB)" -ForegroundColor Green
Write-Host '  This one file can be emailed and opened by double-clicking.' -ForegroundColor DarkGray
Write-Host ''
