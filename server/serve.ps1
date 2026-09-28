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

    Data folder:
      Defaults to .\data next to the app. Point it at a SharePoint / Teams
      folder synced through OneDrive and the whole team reads and writes the
      same estimates - that is what the Team capacity plan is built on. Set it
      from Settings in the app (stored in config.json next to the app) or with
      -DataRoot. Each record is its own file, so two people saving at the same
      time never overwrite each other.

    Security posture:
      * Binds to 127.0.0.1 only - never reachable from the network.
      * Every request must carry a Host header naming this server, which
        defeats DNS-rebinding attacks from other websites.
      * Every state-changing request must come from this app's own origin, so
        a website you happen to visit cannot write records, change the data
        folder or open Outlook drafts through this server.
      * Static reads are confined to the application folder; writes are
        confined to the configured data folder; traversal is rejected.
#>

[CmdletBinding()]
param(
    [int]    $Port      = 0,      # 0 = probe PortStart..PortEnd for a free port
    [int]    $PortStart = 8080,
    [int]    $PortEnd   = 8090,
    [string] $DataRoot  = '',     # overrides config.json; blank = config or default
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'
# Version 2.0 catches uninitialised variables AND throws on a reference to a
# property an object does not have. JSON payloads may legitimately omit
# optional fields, so optional values are always read through Get-Prop.
Set-StrictMode -Version 2.0

# ---------------------------------------------------------------- paths ----
$AppRoot         = Split-Path -Parent $PSScriptRoot
$DefaultDataRoot = Join-Path $AppRoot 'data'
$ConfigFile      = Join-Path $AppRoot 'config.json'

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

# Read an optional property without tripping strict mode.
function Get-Prop {
    param($Obj, [string]$Name)
    if ($null -eq $Obj) { return $null }
    $p = $Obj.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
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

# ---------------------------------------------------------- data folder ----

# The data folder can change while the server runs (Settings -> shared
# folder), so everything that touches it reads these script-scope values.
$script:DataRoot = $null
$script:RecDir   = $null
$script:ProjDir  = $null
$script:RecordCache = @{}   # full path -> @{ Stamp; Text; Ticks; Summary }
$script:SkippedFiles = 0    # record files that could not be read on the last scan

function Test-IsDefaultRoot {
    param([string]$Root)
    return ([System.IO.Path]::GetFullPath($Root) -eq [System.IO.Path]::GetFullPath($DefaultDataRoot))
}

function Set-DataRoot {
    param([string]$Root)
    $full = [System.IO.Path]::GetFullPath($Root)
    foreach ($d in @($full, (Join-Path $full 'records'), (Join-Path $full 'projects'))) {
        if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
    $script:DataRoot = $full
    $script:RecDir   = Join-Path $full 'records'
    $script:ProjDir  = Join-Path $full 'projects'
    $script:RecordCache = @{}
    # index.json was a cache that earlier versions wrote into the app's own
    # data folder. It is no longer used (the list is built live from the
    # files). Only ever tidied there: a folder the user picks may hold an
    # unrelated index.json that is not ours to delete.
    if (Test-IsDefaultRoot $full) {
        $legacy = Join-Path $full 'index.json'
        if (Test-Path -LiteralPath $legacy) { Remove-Item -LiteralPath $legacy -Force -ErrorAction SilentlyContinue }
    }
}

function Read-Config {
    if (-not (Test-Path -LiteralPath $ConfigFile)) { return $null }
    try { return (Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json) }
    catch { Write-Log "config.json is unreadable and was ignored" 'DarkYellow'; return $null }
}

function Save-ConfigDataRoot {
    param([string]$Root)   # '' = default
    if ([string]::IsNullOrWhiteSpace($Root)) {
        if (Test-Path -LiteralPath $ConfigFile) { Remove-Item -LiteralPath $ConfigFile -Force }
        return
    }
    Write-TextFile -Path $ConfigFile -Content (@{ dataRoot = $Root } | ConvertTo-Json)
}

# ------------------------------------------------------- record storage ----

# The record list is built live from the files - there is no index file to go
# stale or to conflict when a folder is shared. Each file is parsed once and
# cached against its timestamp and size, so re-listing a folder of hundreds
# of estimates only re-reads the ones that changed.
function Update-RecordCache {
    $seen = @{}
    $skipped = 0
    $files = @(Get-ChildItem -LiteralPath $script:RecDir -Filter '*.json' -File -ErrorAction SilentlyContinue)
    foreach ($f in $files) {
        $path  = $f.FullName
        $stamp = "$($f.LastWriteTimeUtc.Ticks)-$($f.Length)"
        $seen[$path] = $true
        $entry = $script:RecordCache[$path]
        if ($entry -and $entry.Stamp -eq $stamp) { continue }
        try {
            $raw = [System.IO.File]::ReadAllText($path, $Utf8).Trim()
            $r   = $raw | ConvertFrom-Json
            $id  = Get-Prop $r 'id'
            if (-not $id) { throw 'no id' }
            $res = Get-Prop $r 'results'
            $inp = Get-Prop $r 'inputs'
            $script:RecordCache[$path] = @{
                Stamp   = $stamp
                Ticks   = $f.LastWriteTimeUtc.Ticks
                # The file text as a JSON string literal. PowerShell's parser
                # accepts things the browser's JSON.parse rejects (a raw line
                # break inside a string, for one), so a hand-edited file must
                # not be spliced into the response as-is: one bad file would
                # make the whole list unreadable. The browser parses each one
                # separately and skips any it cannot read.
                Text    = (ConvertTo-Json -InputObject $raw -Compress)
                Summary = [ordered]@{
                    id          = $id
                    savedAt     = Get-Prop $r 'savedAt'
                    type        = Get-Prop $r 'type'
                    projectCode = Get-Prop $r 'projectCode'
                    projectName = Get-Prop $r 'projectName'
                    status      = Get-Prop $r 'status'
                    totalMd     = Get-Prop $res 'totalMd'
                    fte         = Get-Prop $res 'fte'
                    headcount   = Get-Prop $res 'headcount'
                    totalSites  = Get-Prop $inp 'totalSites'
                    months      = Get-Prop $inp 'months'
                    file        = "records/$($f.Name)"
                }
            }
        } catch {
            $script:RecordCache.Remove($path)
            $skipped++
            Write-Log "skipping unreadable record $($f.Name)" 'DarkYellow'
        }
    }
    foreach ($k in @($script:RecordCache.Keys)) {
        if (-not $seen.ContainsKey($k)) { $script:RecordCache.Remove($k) }
    }
    $script:SkippedFiles = $skipped
}

# One entry per record id. OneDrive keeps both sides of an edit conflict as
# "<id>-<PC name>.json", so the same id can sit in two files; the newest wins.
function Get-UniqueRecordEntries {
    Update-RecordCache
    $byId = @{}
    foreach ($e in $script:RecordCache.Values) {
        $id  = [string]$e.Summary.id
        $cur = $byId[$id]
        if (-not $cur) { $byId[$id] = $e; continue }
        $a = [string]$e.Summary.savedAt; $b = [string]$cur.Summary.savedAt
        if (($a -gt $b) -or (($a -eq $b) -and ($e.Ticks -gt $cur.Ticks))) { $byId[$id] = $e }
    }
    return @($byId.Values)
}

function Get-RecordSummaries {
    $list = @(Get-UniqueRecordEntries | ForEach-Object { $_.Summary })
    return @($list | Sort-Object { [string]$_.savedAt } -Descending)
}

# ---------------------------------------------------------------- guard -----

# Blocks the two ways another website could reach this server through the
# user's own browser: DNS rebinding (wrong Host) and cross-site requests
# (wrong Origin). Non-browser clients send no Origin and are unaffected.
function Test-RequestAllowed {
    param([string]$Method, [hashtable]$Headers)
    $allowedHosts   = @("127.0.0.1:$script:Bound", "localhost:$script:Bound")
    $allowedOrigins = @("http://127.0.0.1:$script:Bound", "http://localhost:$script:Bound")

    $hostHeader = $Headers['host']
    if (-not $hostHeader -or ($allowedHosts -notcontains $hostHeader.ToLowerInvariant())) {
        return 'unexpected Host header'
    }
    if ($Method -ne 'GET' -and $Method -ne 'HEAD') {
        $origin = $Headers['origin']
        if ($origin -and ($allowedOrigins -notcontains $origin.ToLowerInvariant())) {
            return 'cross-origin request refused'
        }
        $site = $Headers['sec-fetch-site']
        if ($site -and $site -eq 'cross-site') { return 'cross-site request refused' }
    }
    return $null
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
            ok              = $true
            app             = 'DPM FTE Calculator'
            version         = '2.1.0'
            dataRoot        = $script:DataRoot
            defaultDataRoot = $DefaultDataRoot
            isDefaultRoot   = (Test-IsDefaultRoot $script:DataRoot)
            time            = (Get-Date).ToString('o')
        })
        return
    }

    # --- data folder configuration ----------------------------------------
    if ($Path -eq '/api/config') {
        if ($Method -eq 'GET') {
            Send-Json -Stream $Stream -Object ([ordered]@{
                ok = $true; dataRoot = $script:DataRoot; defaultDataRoot = $DefaultDataRoot
            })
            return
        }
        if ($Method -eq 'POST') {
            $req     = $Body | ConvertFrom-Json
            $reset   = [bool](Get-Prop $req 'reset')
            $target  = [string](Get-Prop $req 'dataRoot')
            $copy    = [bool](Get-Prop $req 'copyExisting')
            $oldRec  = $script:RecDir
            $oldProj = $script:ProjDir
            $oldWasDefault = Test-IsDefaultRoot $script:DataRoot
            if ($reset -or [string]::IsNullOrWhiteSpace($target)) {
                Set-DataRoot $DefaultDataRoot
                Save-ConfigDataRoot ''
                Write-Log "data folder reset to default: $script:DataRoot" 'Cyan'
            } else {
                $target = $target.Trim().Trim('"')
                if (-not [System.IO.Path]::IsPathRooted($target)) {
                    Send-Error $Stream 400 'Bad Request' 'Use a full folder path, for example C:\Users\you\Orange\DPM Team - Documents\FTE Data.'; return
                }
                if ($target -match '[*?"<>|]') { Send-Error $Stream 400 'Bad Request' 'That path contains characters Windows does not allow in folder names.'; return }
                if (-not (Test-Path -LiteralPath $target -PathType Container)) {
                    Send-Error $Stream 400 'Bad Request' 'That folder does not exist. Create it first (or sync the SharePoint folder), then try again.'; return
                }
                Set-DataRoot $target
                Save-ConfigDataRoot $script:DataRoot
                Write-Log "data folder changed to: $script:DataRoot" 'Cyan'
            }

            # Optionally bring the estimates from the previous folder along, so
            # someone joining a shared folder does not arrive empty-handed.
            # Only from the app's own (private) folder: coming from another
            # shared folder, most of its files are colleagues' and are not
            # this person's to copy - the browser publishes their own instead.
            # Existing files are never overwritten, and one file that cannot
            # be copied (read-only library, offline placeholder) is counted
            # rather than aborting the switch half-way.
            $copiedRec = 0; $copiedProj = 0; $copyFailed = 0
            if ($copy -and $oldWasDefault -and $oldRec -and ($oldRec -ne $script:RecDir)) {
                foreach ($pair in @(@($oldRec, $script:RecDir, 'rec'), @($oldProj, $script:ProjDir, 'proj'))) {
                    foreach ($src in @(Get-ChildItem -LiteralPath $pair[0] -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
                        $dest = Join-Path $pair[1] $src.Name
                        if (Test-Path -LiteralPath $dest) { continue }
                        try {
                            Copy-Item -LiteralPath $src.FullName -Destination $dest -ErrorAction Stop
                            if ($pair[2] -eq 'rec') { $copiedRec++ } else { $copiedProj++ }
                        } catch {
                            $copyFailed++
                            Write-Log "could not copy $($src.Name): $($_.Exception.Message)" 'DarkYellow'
                        }
                    }
                }
                Write-Log "copied $copiedRec record(s) and $copiedProj project(s) into the new folder" 'Cyan'
            }

            Send-Json -Stream $Stream -Object ([ordered]@{
                ok = $true; dataRoot = $script:DataRoot
                isDefaultRoot = (Test-IsDefaultRoot $script:DataRoot)
                copiedRecords = $copiedRec; copiedProjects = $copiedProj; copyFailed = $copyFailed
                copySkipped = [bool]($copy -and -not $oldWasDefault)
            })
            return
        }
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
            $to = [string](Get-Prop $req 'to'); $cc = [string](Get-Prop $req 'cc')
            if ($to) { $mail.To = $to }
            if ($cc) { $mail.CC = $cc }
            $mail.Subject  = [string](Get-Prop $req 'subject')
            $mail.HTMLBody = [string](Get-Prop $req 'htmlBody')
            $mail.Display($false)            # review-and-send; do NOT auto-send
            Write-Log "opened Outlook draft: $($mail.Subject)" 'Green'
            Send-Json -Stream $Stream -Object @{ ok = $true }
        } catch {
            Write-Log "Outlook draft failed: $($_.Exception.Message)" 'DarkYellow'
            Send-Json -Stream $Stream -Object @{ ok = $false; error = $_.Exception.Message }
        }
        return
    }

    # --- every record in full (team view / sync) --------------------------
    # Matched before the single-record route, which would otherwise read
    # "all" as a record id. Each record travels as its file text (a JSON
    # string) for the browser to parse one by one - see Update-RecordCache.
    if ($Path -eq '/api/records/all') {
        if ($Method -ne 'GET') { Send-Error $Stream 405 'Method Not Allowed' 'GET only'; return }
        $texts = @(Get-UniqueRecordEntries | ForEach-Object { $_.Text })
        $json = '{"ok":true,"format":"text","count":' + $texts.Count + ',"skipped":' + $script:SkippedFiles +
                ',"dataRoot":' + (ConvertTo-Json -InputObject $script:DataRoot -Compress) +
                ',"records":[' + ($texts -join ',') + ']}'
        Send-Json -Stream $Stream -Object $json
        return
    }

    # --- records collection ----------------------------------------------
    if ($Path -eq '/api/records') {
        switch ($Method) {
            'GET' {
                $list = @(Get-RecordSummaries)
                Send-Json -Stream $Stream -Object ([ordered]@{
                    ok = $true; generatedAt = (Get-Date).ToString('o'); count = $list.Count
                    dataRoot = $script:DataRoot; records = $list
                })
                return
            }
            'POST' {
                $rec = $Body | ConvertFrom-Json
                $id  = [string](Get-Prop $rec 'id')
                if (-not $id) { Send-Error $Stream 400 'Bad Request' 'record.id is required'; return }
                $name = (ConvertTo-SafeFileName $id) + '.json'
                $dest = Join-Path $script:RecDir $name
                if (-not (Test-WithinRoot $dest $script:RecDir)) { Send-Error $Stream 400 'Bad Request' 'invalid id'; return }
                Write-TextFile -Path $dest -Content $Body
                $md = Get-Prop (Get-Prop $rec 'results') 'totalMd'
                Write-Log "saved record $id  ($(Get-Prop $rec 'type'), $md MD)" 'Green'
                Send-Json -Stream $Stream -Status 201 -StatusText 'Created' -Object ([ordered]@{
                    ok = $true; id = $id
                    file = (Split-Path -Leaf $script:DataRoot) + "/records/$name"
                    path = $dest
                })
                return
            }
        }
    }

    # --- single record ----------------------------------------------------
    if ($Path -match '^/api/records/(.+)$') {
        $id   = $Matches[1]
        $name = (ConvertTo-SafeFileName $id) + '.json'
        $dest = Join-Path $script:RecDir $name
        if (-not (Test-WithinRoot $dest $script:RecDir)) { Send-Error $Stream 400 'Bad Request' 'invalid id'; return }
        switch ($Method) {
            'GET' {
                if (-not (Test-Path -LiteralPath $dest)) { Send-Error $Stream 404 'Not Found' 'no such record'; return }
                Send-Json -Stream $Stream -Object ([System.IO.File]::ReadAllText($dest, $Utf8))
                return
            }
            'DELETE' {
                if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
                # Conflict copies of the same estimate would otherwise bring it back.
                Update-RecordCache
                foreach ($k in @($script:RecordCache.Keys)) {
                    if ([string]$script:RecordCache[$k].Summary.id -eq $id -and (Test-WithinRoot $k $script:RecDir)) {
                        Remove-Item -LiteralPath $k -Force -ErrorAction SilentlyContinue
                    }
                }
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
                Get-ChildItem -LiteralPath $script:ProjDir -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
                    $fn = $_.Name
                    try { $items += (Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json) }
                    catch { Write-Log "skipping unreadable project $fn" 'DarkYellow' }
                }
                Send-Json -Stream $Stream -Object @{ ok = $true; count = $items.Count; projects = $items }
                return
            }
            'POST' {
                $proj  = $Body | ConvertFrom-Json
                $pname = [string](Get-Prop $proj 'name')
                if (-not $pname) { Send-Error $Stream 400 'Bad Request' 'project.name is required'; return }
                $name = (ConvertTo-SafeFileName $pname) + '.json'
                $dest = Join-Path $script:ProjDir $name
                if (-not (Test-WithinRoot $dest $script:ProjDir)) { Send-Error $Stream 400 'Bad Request' 'invalid name'; return }
                Write-TextFile -Path $dest -Content $Body
                Write-Log "saved project '$pname'" 'Green'
                Send-Json -Stream $Stream -Status 201 -StatusText 'Created' -Object @{ ok = $true; name = $pname }
                return
            }
        }
    }

    # --- single project ---------------------------------------------------
    if ($Path -match '^/api/projects/(.+)$') {
        $pname = $Matches[1]
        $name  = (ConvertTo-SafeFileName $pname) + '.json'
        $dest  = Join-Path $script:ProjDir $name
        if (-not (Test-WithinRoot $dest $script:ProjDir)) { Send-Error $Stream 400 'Bad Request' 'invalid name'; return }
        switch ($Method) {
            'GET' {
                if (-not (Test-Path -LiteralPath $dest)) { Send-Error $Stream 404 'Not Found' 'no such project'; return }
                Send-Json -Stream $Stream -Object ([System.IO.File]::ReadAllText($dest, $Utf8))
                return
            }
            'DELETE' {
                if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
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
    # The app folder may contain config.json and the default data folder;
    # neither is part of the web app, so neither is served as a static file.
    if ($rel -ieq 'config.json' -or $rel -like 'data/*' -or $rel -like 'data\*') {
        Send-Error $Stream 404 'Not Found' "not found: $rel"; return
    }

    $full = Join-Path $AppRoot ($rel -replace '/', '\')
    if (-not (Test-WithinRoot $full $AppRoot)) { Send-Error $Stream 403 'Forbidden' 'outside application root'; return }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf))  { Send-Error $Stream 404 'Not Found' "not found: $rel"; return }

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

# Resolve the data folder: -DataRoot, else config.json, else .\data. A
# configured folder that has gone missing (e.g. OneDrive not signed in) falls
# back to the default rather than refusing to start.
$chosenRoot = $DefaultDataRoot
$cfg = Read-Config
$cfgRoot = [string](Get-Prop $cfg 'dataRoot')
if (-not [string]::IsNullOrWhiteSpace($DataRoot)) { $chosenRoot = $DataRoot }
elseif (-not [string]::IsNullOrWhiteSpace($cfgRoot)) {
    if (Test-Path -LiteralPath $cfgRoot -PathType Container) { $chosenRoot = $cfgRoot }
    else { Write-Log "configured data folder not found, using the default: $cfgRoot" 'DarkYellow' }
}
Set-DataRoot $chosenRoot

$started  = Start-Listener -From $PortStart -To $PortEnd -Fixed $Port
$listener = $started.Listener
$script:Bound = $started.Port
$url      = "http://127.0.0.1:$script:Bound/"

Update-RecordCache

Write-Host ''
Write-Host '  ================================================================' -ForegroundColor Cyan
Write-Host '   DPM FTE Calculator' -ForegroundColor White
Write-Host '  ================================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "   Open in browser :  $url" -ForegroundColor Yellow
Write-Host "   Data folder     :  $script:DataRoot" -ForegroundColor Gray
Write-Host ''
Write-Host '   Every calculation is written to the data folder as a .json file.' -ForegroundColor DarkGray
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

            $refusal = Test-RequestAllowed -Method $method -Headers $headers
            if ($refusal) {
                Write-Log "refused $method $path : $refusal" 'Red'
                Send-Error $stream 403 'Forbidden' $refusal
                continue
            }

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
