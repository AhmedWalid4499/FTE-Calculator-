<#
    DPM FTE Calculator - local application host
    ------------------------------------------------------------------
    Serves the application on http://127.0.0.1:<port> and exposes a small
    JSON API so calculations can be written straight to disk as .json files.

    Why a raw TcpListener instead of System.Net.HttpListener:
      HttpListener URL prefixes can require a netsh URL ACL reservation
      (i.e. an administrator). Binding a TCP socket to the loopback
      address never does. This script therefore needs no elevation and
      installs nothing.

    Security posture:
      * Binds to 127.0.0.1 only - never reachable from the network.
      * Static reads are confined to the application folder.
      * Writes are confined to .\data.
      * Any path containing traversal segments is rejected.
#>

[CmdletBinding()]
param(
    [int]    $Port     = 0,       # 0 = probe PortStart..PortEnd for a free port
    [int]    $PortStart = 8080,
    [int]    $PortEnd   = 8090,
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'
# Version 2.0 deliberately, not Latest: it still catches uninitialised variables,
# but does not throw when a JSON payload simply omits an optional property -
# which lets `if (-not $rec.id)` behave as a plain presence check.
Set-StrictMode -Version 2.0

# ---------------------------------------------------------------- paths ----
$AppRoot  = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $AppRoot 'data'
$RecDir   = Join-Path $DataRoot 'records'
$ProjDir  = Join-Path $DataRoot 'projects'
$IndexFile= Join-Path $DataRoot 'index.json'

foreach ($d in @($DataRoot, $RecDir, $ProjDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

$Utf8 = New-Object System.Text.UTF8Encoding($false)

$MimeMap = @{
    '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8'
    '.js'  ='text/javascript; charset=utf-8'
    '.css' ='text/css; charset=utf-8'
    '.json'='application/json; charset=utf-8'
    '.svg' ='image/svg+xml'; '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'
    '.gif' ='image/gif';     '.ico'='image/x-icon'
    '.woff'='font/woff';     '.woff2'='font/woff2'; '.ttf'='font/ttf'
    '.txt' ='text/plain; charset=utf-8'; '.md'='text/plain; charset=utf-8'
    '.map' ='application/json; charset=utf-8'
}

# ------------------------------------------------------------- helpers ----

function Write-Log {
    param([string]$Message, [string]$Colour = 'DarkGray')
    Write-Host ("  {0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message) -ForegroundColor $Colour
}

# Set-Content -Encoding UTF8 prepends a byte order mark on Windows PowerShell,
# and a leading BOM makes JSON.parse() throw in the browser. Always write
# through the BOM-less encoder instead.
function Write-TextFile {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8)
}

# Reject anything that could escape the intended directory.
function Test-SafeRelativePath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if ($Path -match '\.\.')                 { return $false }
    if ($Path -match '[:*?"<>|]')            { return $false }
    return $true
}

# Confine a resolved path to a required parent directory.
function Test-WithinRoot {
    param([string]$FullPath, [string]$Root)
    try {
        $f = [System.IO.Path]::GetFullPath($FullPath)
        $r = [System.IO.Path]::GetFullPath($Root)
        if (-not $r.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
            $r += [System.IO.Path]::DirectorySeparatorChar
        }
        return $f.StartsWith($r, [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

# Strip characters that are illegal in Windows file names.
function ConvertTo-SafeFileName {
    param([string]$Name)
    $clean = ($Name -replace '[^A-Za-z0-9 \-_\.]', '_').Trim()
    if ($clean.Length -gt 120) { $clean = $clean.Substring(0, 120) }
    if ([string]::IsNullOrWhiteSpace($clean)) { $clean = 'untitled' }
    return $clean
}

function Send-Response {
    param(
        [System.IO.Stream] $Stream,
        [int]              $Status      = 200,
        [string]           $StatusText  = 'OK',
        [string]           $ContentType = 'text/plain; charset=utf-8',
        [byte[]]           $Body        = $null,
        [hashtable]        $ExtraHeaders = $null
    )
    if ($null -eq $Body) { $Body = New-Object byte[] 0 }

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendFormat("HTTP/1.1 {0} {1}`r`n", $Status, $StatusText)
    [void]$sb.AppendFormat("Content-Type: {0}`r`n", $ContentType)
    [void]$sb.AppendFormat("Content-Length: {0}`r`n", $Body.Length)
    [void]$sb.Append("Cache-Control: no-store`r`n")
    [void]$sb.Append("X-Content-Type-Options: nosniff`r`n")
    [void]$sb.Append("Connection: close`r`n")
    if ($ExtraHeaders) {
        foreach ($k in $ExtraHeaders.Keys) { [void]$sb.AppendFormat("{0}: {1}`r`n", $k, $ExtraHeaders[$k]) }
    }
    [void]$sb.Append("`r`n")

    $head = $Utf8.GetBytes($sb.ToString())
    $Stream.Write($head, 0, $head.Length)
    if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}

function Send-Json {
    param([System.IO.Stream]$Stream, [int]$Status = 200, [string]$StatusText = 'OK', $Object)
    $json = if ($Object -is [string]) { $Object } else { $Object | ConvertTo-Json -Depth 60 -Compress }
    Send-Response -Stream $Stream -Status $Status -StatusText $StatusText `
                  -ContentType 'application/json; charset=utf-8' -Body $Utf8.GetBytes($json)
}

function Send-Error {
    param([System.IO.Stream]$Stream, [int]$Status, [string]$StatusText, [string]$Message)
    Send-Json -Stream $Stream -Status $Status -StatusText $StatusText -Object @{ ok = $false; error = $Message }
}

# Read request head byte-by-byte so we never consume part of the body.
function Read-RequestHead {
    param([System.IO.Stream]$Stream)
    $buf  = New-Object System.Collections.Generic.List[byte]
    $prev = 0, 0, 0, 0
    while ($true) {
        $b = $Stream.ReadByte()
        if ($b -lt 0) { break }
        $buf.Add([byte]$b)
        $prev = @($prev[1], $prev[2], $prev[3], $b)
        if ($prev[0] -eq 13 -and $prev[1] -eq 10 -and $prev[2] -eq 13 -and $prev[3] -eq 10) { break }
        if ($buf.Count -gt 65536) { break }   # header flood guard
    }
    if ($buf.Count -eq 0) { return $null }
    return $Utf8.GetString($buf.ToArray())
}

function Read-RequestBody {
    param([System.IO.Stream]$Stream, [int]$Length)
    if ($Length -le 0) { return '' }
    $buf  = New-Object byte[] $Length
    $read = 0
    while ($read -lt $Length) {
        $n = $Stream.Read($buf, $read, $Length - $read)
        if ($n -le 0) { break }
        $read += $n
    }
    return $Utf8.GetString($buf, 0, $read)
}

# ------------------------------------------------------- record storage ----

# index.json is a compact summary of every record so the UI can render the
# list without opening dozens of files.
function Update-RecordIndex {
    $entries = @()
    Get-ChildItem -Path $RecDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | ForEach-Object {
            try {
                $r = Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
                $entries += [ordered]@{
                    id           = $r.id
                    savedAt      = $r.savedAt
                    type         = $r.type
                    projectCode  = $r.projectCode
                    projectName  = $r.projectName
                    status       = $r.status
                    totalMd      = $r.results.totalMd
                    fte          = $r.results.fte
                    headcount    = $r.results.headcount
                    totalSites   = $r.inputs.totalSites
                    months       = $r.inputs.months
                    file         = "data/records/$($_.Name)"
                }
            } catch {
                Write-Log "skipping unreadable record $($_.Name)" 'DarkYellow'
            }
        }
    $payload = [ordered]@{
        generatedAt = (Get-Date).ToString('o')
        count       = $entries.Count
        records     = $entries
    }
    Write-TextFile -Path $IndexFile -Content ($payload | ConvertTo-Json -Depth 12)
    return $payload
}

# ------------------------------------------------------------ routing -----

function Invoke-ApiRoute {
    param(
        [System.IO.Stream]$Stream,
        [string]$Method,
        [string]$Path,      # already url-decoded, starts with /api
        [string]$Body
    )

    # --- health -----------------------------------------------------------
    if ($Path -eq '/api/health') {
        Send-Json -Stream $Stream -Object ([ordered]@{
            ok       = $true
            app      = 'DPM FTE Calculator'
            version  = '2.0.0'
            dataRoot = $DataRoot
            time     = (Get-Date).ToString('o')
        })
        return
    }

    # --- open an Outlook draft (never sends) ------------------------------
    # Opens a compose window with the result table for the user to review and
    # send themselves. Uses Outlook COM, so it only works on this Windows
    # machine with Outlook installed; the browser falls back to mailto if this
    # returns ok:false. It deliberately calls Display(), never Send().
    if ($Path -eq '/api/email') {
        if ($Method -ne 'POST') { Send-Error $Stream 405 'Method Not Allowed' 'POST only'; return }
        $req = $Body | ConvertFrom-Json
        try {
            $outlook = New-Object -ComObject Outlook.Application
            $mail = $outlook.CreateItem(0)   # olMailItem
            if ($req.to) { $mail.To = [string]$req.to }
            if ($req.cc) { $mail.CC = [string]$req.cc }
            $mail.Subject  = [string]$req.subject
            $mail.HTMLBody = [string]$req.htmlBody
            $mail.Display($false)            # review-and-send; do NOT auto-send
            Write-Log "opened Outlook draft: $($req.subject)" 'Green'
            Send-Json -Stream $Stream -Object @{ ok = $true }
        } catch {
            Write-Log "Outlook draft failed: $($_.Exception.Message)" 'DarkYellow'
            Send-Json -Stream $Stream -Object @{ ok = $false; error = $_.Exception.Message }
        }
        return
    }

    # --- records collection ----------------------------------------------
    if ($Path -eq '/api/records') {
        switch ($Method) {
            'GET' {
                if (-not (Test-Path $IndexFile)) { [void](Update-RecordIndex) }
                $raw = Get-Content $IndexFile -Raw -Encoding UTF8
                Send-Json -Stream $Stream -Object $raw
                return
            }
            'POST' {
                $rec = $Body | ConvertFrom-Json
                if (-not $rec.id) { Send-Error $Stream 400 'Bad Request' 'record.id is required'; return }
                $name = (ConvertTo-SafeFileName $rec.id) + '.json'
                $dest = Join-Path $RecDir $name
                if (-not (Test-WithinRoot $dest $RecDir)) { Send-Error $Stream 400 'Bad Request' 'invalid id'; return }
                Write-TextFile -Path $dest -Content $Body
                [void](Update-RecordIndex)
                Write-Log "saved record $($rec.id)  ($($rec.type), $([math]::Round([double]$rec.results.totalMd,2)) MD)" 'Green'
                Send-Json -Stream $Stream -Status 201 -StatusText 'Created' -Object @{
                    ok = $true; id = $rec.id; file = "data/records/$name"
                }
                return
            }
        }
    }

    # --- single record ----------------------------------------------------
    if ($Path -match '^/api/records/(.+)$') {
        $id   = $Matches[1]
        $name = (ConvertTo-SafeFileName $id) + '.json'
        $dest = Join-Path $RecDir $name
        if (-not (Test-WithinRoot $dest $RecDir)) { Send-Error $Stream 400 'Bad Request' 'invalid id'; return }
        switch ($Method) {
            'GET' {
                if (-not (Test-Path $dest)) { Send-Error $Stream 404 'Not Found' 'no such record'; return }
                Send-Json -Stream $Stream -Object (Get-Content $dest -Raw -Encoding UTF8)
                return
            }
            'DELETE' {
                if (Test-Path $dest) { Remove-Item $dest -Force }
                [void](Update-RecordIndex)
                Write-Log "deleted record $id" 'DarkYellow'
                Send-Json -Stream $Stream -Object @{ ok = $true; id = $id }
                return
            }
        }
    }

    # --- projects collection ---------------------------------------------
    if ($Path -eq '/api/projects') {
        switch ($Method) {
            'GET' {
                $items = @()
                Get-ChildItem -Path $ProjDir -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
                    try { $items += (Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json) }
                    catch { Write-Log "skipping unreadable project $($_.Name)" 'DarkYellow' }
                }
                Send-Json -Stream $Stream -Object @{ ok = $true; count = $items.Count; projects = $items }
                return
            }
            'POST' {
                $proj = $Body | ConvertFrom-Json
                if (-not $proj.name) { Send-Error $Stream 400 'Bad Request' 'project.name is required'; return }
                $name = (ConvertTo-SafeFileName $proj.name) + '.json'
                $dest = Join-Path $ProjDir $name
                if (-not (Test-WithinRoot $dest $ProjDir)) { Send-Error $Stream 400 'Bad Request' 'invalid name'; return }
                Write-TextFile -Path $dest -Content $Body
                Write-Log "saved project '$($proj.name)'" 'Green'
                Send-Json -Stream $Stream -Status 201 -StatusText 'Created' -Object @{ ok = $true; name = $proj.name }
                return
            }
        }
    }

    # --- single project ---------------------------------------------------
    if ($Path -match '^/api/projects/(.+)$') {
        $pname = $Matches[1]
        $name  = (ConvertTo-SafeFileName $pname) + '.json'
        $dest  = Join-Path $ProjDir $name
        if (-not (Test-WithinRoot $dest $ProjDir)) { Send-Error $Stream 400 'Bad Request' 'invalid name'; return }
        switch ($Method) {
            'GET' {
                if (-not (Test-Path $dest)) { Send-Error $Stream 404 'Not Found' 'no such project'; return }
                Send-Json -Stream $Stream -Object (Get-Content $dest -Raw -Encoding UTF8)
                return
            }
            'DELETE' {
                if (Test-Path $dest) { Remove-Item $dest -Force }
                Write-Log "deleted project '$pname'" 'DarkYellow'
                Send-Json -Stream $Stream -Object @{ ok = $true; name = $pname }
                return
            }
        }
    }

    Send-Error $Stream 404 'Not Found' "no route for $Method $Path"
}

function Invoke-StaticRoute {
    param([System.IO.Stream]$Stream, [string]$Method, [string]$Path)

    if ($Method -ne 'GET' -and $Method -ne 'HEAD') {
        Send-Error $Stream 405 'Method Not Allowed' 'only GET/HEAD for static files'; return
    }

    $rel = $Path.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }
    if (-not (Test-SafeRelativePath $rel)) { Send-Error $Stream 400 'Bad Request' 'illegal path'; return }

    $full = Join-Path $AppRoot ($rel -replace '/', '\')
    if (-not (Test-WithinRoot $full $AppRoot)) { Send-Error $Stream 403 'Forbidden' 'outside application root'; return }
    if (-not (Test-Path $full -PathType Leaf))  { Send-Error $Stream 404 'Not Found' "not found: $rel"; return }

    $ext  = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
    $mime = if ($MimeMap.ContainsKey($ext)) { $MimeMap[$ext] } else { 'application/octet-stream' }
    $bytes = if ($Method -eq 'HEAD') { New-Object byte[] 0 } else { [System.IO.File]::ReadAllBytes($full) }
    Send-Response -Stream $Stream -ContentType $mime -Body $bytes
}

# -------------------------------------------------------------- listen ----

function Start-Listener {
    param([int]$From, [int]$To, [int]$Fixed)

    $candidates = if ($Fixed -gt 0) { @($Fixed) } else { $From..$To }
    foreach ($p in $candidates) {
        try {
            $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
            $l.Start()
            return @{ Listener = $l; Port = $p }
        } catch {
            continue
        }
    }
    throw "No free port in range $From-$To. Close whatever is using them, or pass -Port <n>."
}

$started  = Start-Listener -From $PortStart -To $PortEnd -Fixed $Port
$listener = $started.Listener
$bound    = $started.Port
$url      = "http://127.0.0.1:$bound/"

[void](Update-RecordIndex)

Write-Host ''
Write-Host '  ================================================================' -ForegroundColor Cyan
Write-Host '   DPM FTE Calculator' -ForegroundColor White
Write-Host '  ================================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "   Open in browser :  $url" -ForegroundColor Yellow
Write-Host "   Data folder     :  $DataRoot" -ForegroundColor Gray
Write-Host ''
Write-Host '   Every calculation is written to data\records as a .json file.' -ForegroundColor DarkGray
Write-Host '   Leave this window open while you work. Press Ctrl+C to stop.' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  ----------------------------------------------------------------' -ForegroundColor DarkGray

if (-not $NoBrowser) { Start-Process $url | Out-Null }

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        $stream = $null
        try {
            $client.ReceiveTimeout = 15000
            $client.SendTimeout    = 15000
            $stream = $client.GetStream()

            $head = Read-RequestHead -Stream $stream
            if ([string]::IsNullOrWhiteSpace($head)) { continue }

            $lines   = $head -split "`r`n"
            $request = $lines[0] -split ' '
            if ($request.Count -lt 2) { Send-Error $stream 400 'Bad Request' 'malformed request line'; continue }

            $method = $request[0].ToUpperInvariant()
            $target = $request[1]

            $headers = @{}
            for ($i = 1; $i -lt $lines.Count; $i++) {
                $ln = $lines[$i]
                if ([string]::IsNullOrWhiteSpace($ln)) { continue }
                $idx = $ln.IndexOf(':')
                if ($idx -gt 0) {
                    $headers[$ln.Substring(0, $idx).Trim().ToLowerInvariant()] = $ln.Substring($idx + 1).Trim()
                }
            }

            $contentLength = 0
            if ($headers.ContainsKey('content-length')) {
                [void][int]::TryParse($headers['content-length'], [ref]$contentLength)
            }
            $body = Read-RequestBody -Stream $stream -Length $contentLength

            $path = ($target -split '\?')[0]
            $path = [System.Uri]::UnescapeDataString($path)

            try {
                if ($path.StartsWith('/api')) {
                    Invoke-ApiRoute -Stream $stream -Method $method -Path $path -Body $body
                } else {
                    Invoke-StaticRoute -Stream $stream -Method $method -Path $path
                }
            } catch {
                Write-Log "500 on $method $path : $($_.Exception.Message)" 'Red'
                try { Send-Error $stream 500 'Internal Server Error' $_.Exception.Message } catch {}
            }
        } catch {
            # A dropped or half-open connection must never take the server down.
        } finally {
            if ($stream) { try { $stream.Close() } catch {} }
            try { $client.Close() } catch {}
        }
    }
} finally {
    try { $listener.Stop() } catch {}
    Write-Host ''
    Write-Host '  Server stopped.' -ForegroundColor Yellow
}
