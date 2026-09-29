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
      The team saves into one SharePoint folder, synced to each PC by
      OneDrive. The app asks this server where that folder is synced
      (/api/team-folder reads OneDrive's own list of synced locations) and
      links it automatically, so every estimate lands in SharePoint without
      anyone typing a path. Until it is synced - or if the user chooses their
      own folder - estimates go to .\data next to the app. The choice is kept
      in config.json next to the app, or forced with -DataRoot. Each record is
      its own file, so two people saving at the same time never overwrite
      each other.

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
    [switch] $NoBrowser,
    # Where updates come from. Only ever changed for testing the updater.
    [string] $UpdateNotesUrl = 'https://raw.githubusercontent.com/AhmedWalid4499/FTE-Calculator-/main/assets/release-notes.js',
    [string] $UpdateZipUrl   = 'https://codeload.github.com/AhmedWalid4499/FTE-Calculator-/zip/refs/heads/main'
)

$ErrorActionPreference = 'Stop'
# Version 2.0 catches uninitialised variables AND throws on a reference to a
# property an object does not have. JSON payloads may legitimately omit
# optional fields, so optional values are always read through Get-Prop.
Set-StrictMode -Version 2.0

# At script scope the -DataRoot parameter and $script:DataRoot (the folder in
# use, which Settings can change) are the same variable - keep what was asked.
$ForcedDataRoot = $DataRoot

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

# ------------------------------------------------------------ versions ----

# assets\release-notes.js is the single source of the version: the JSON
# between its /*JSON*/ and /*END*/ markers.
function Get-ReleaseInfo {
    param([string]$Text)
    $a = $Text.IndexOf('/*JSON*/'); $b = $Text.IndexOf('/*END*/')
    if ($a -lt 0 -or $b -le $a) { throw 'the release notes could not be read' }
    $info = $Text.Substring($a + 8, $b - $a - 8) | ConvertFrom-Json
    if (-not (Get-Prop $info 'version')) { throw 'the release notes name no version' }
    return $info
}

# -1, 0 or 1, comparing "2.10.0" with "2.9.1" part by part as numbers.
function Compare-Version {
    param([string]$A, [string]$B)
    $pa = ([string]$A).Split('.'); $pb = ([string]$B).Split('.')
    $n = [Math]::Max($pa.Count, $pb.Count)
    for ($i = 0; $i -lt $n; $i++) {
        $x = 0; $y = 0
        if ($i -lt $pa.Count) { [void][int]::TryParse($pa[$i], [ref]$x) }
        if ($i -lt $pb.Count) { [void][int]::TryParse($pb[$i], [ref]$y) }
        if ($x -ne $y) { if ($x -gt $y) { return 1 } else { return -1 } }
    }
    return 0
}

$script:ReleaseInfo = Get-ReleaseInfo ([System.IO.File]::ReadAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\release-notes.js'), $Utf8))
$script:AppVersion = [string]$script:ReleaseInfo.version
$script:FolderMinVersion = [string](Get-Prop $script:ReleaseInfo 'folderMinVersion')
if (-not $script:FolderMinVersion) { $script:FolderMinVersion = $script:AppVersion }

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
$script:IgnoredFiles = @{}  # full path -> stamp, for JSON files that are not estimates
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
    $script:IgnoredFiles = @{}
    # index.json was a cache that earlier versions wrote into the app's own
    # data folder. It is no longer used (the list is built live from the
    # files). Only ever tidied there: a folder the user picks may hold an
    # unrelated index.json that is not ours to delete.
    if (Test-IsDefaultRoot $full) {
        $legacy = Join-Path $full 'index.json'
        if (Test-Path -LiteralPath $legacy) { Remove-Item -LiteralPath $legacy -Force -ErrorAction SilentlyContinue }
    }
    Update-FolderMarker $full
}

# --------------------------------------------------------- folder marker ----

# fte-folder.json in a data folder records the oldest app version allowed to
# write there. A newer release that changes how the folder is organised
# raises it, and every copy of the app older than that refuses to save
# instead of writing in the old layout. It is only ever raised, never lowered.
$script:MarkerName = 'fte-folder.json'

# @{ state = 'absent' | 'ok' | 'unreadable'; minVersion }. A marker that is
# there but cannot be read (half-synced, hand-edited) is treated as "unknown"
# and fails closed: nothing is saved and it is never overwritten.
function Get-FolderMarker {
    param([string]$Root)
    $f = Join-Path $Root $script:MarkerName
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return @{ state = 'absent'; minVersion = '' } }
    try {
        $m = [System.IO.File]::ReadAllText($f, $Utf8) | ConvertFrom-Json
        $v = [string](Get-Prop $m 'minVersion')
        if (-not $v) { throw 'no minVersion' }
        return @{ state = 'ok'; minVersion = $v }
    } catch { return @{ state = 'unreadable'; minVersion = '' } }
}

# Only a published copy raises the marker. A developer's git working copy
# runs versions nobody else can install yet; raising the shared folder's
# minimum from there would lock the whole team out of saving.
function Update-FolderMarker {
    param([string]$Root)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    if ((Get-InstallMode) -eq 'git') { return }
    $m = Get-FolderMarker $Root
    if ($m.state -eq 'unreadable') { return }
    if ($m.minVersion -and (Compare-Version $m.minVersion $script:FolderMinVersion) -ge 0) { return }
    $marker = [ordered]@{
        app        = 'DPM FTE Calculator'
        about      = 'The oldest version of the app allowed to save into this folder. Older copies must be updated first.'
        layout     = 'project folders'
        minVersion = $script:FolderMinVersion
        writtenBy  = $script:AppVersion
        updatedAt  = (Get-Date).ToString('o')
    }
    try { Write-TextFile -Path (Join-Path $Root $script:MarkerName) -Content ($marker | ConvertTo-Json) }
    catch { Write-Log "could not write $($script:MarkerName): $($_.Exception.Message)" 'DarkYellow' }
}

# Why this request may not change data, or $null when it may. The page must be
# the same version as this host (an open tab from before an update would
# otherwise save the old way), and the folder must not need a newer app.
function Get-WriteRefusal {
    param([hashtable]$Headers)
    $stale = Get-StaleLauncherMessage
    if ($stale) { return $stale }
    $pageVersion = Get-HeaderText $Headers 'x-fte-version'
    if (-not $pageVersion -or (Compare-Version $pageVersion $script:AppVersion) -ne 0) {
        return "This page is from a different version of the app than the launcher ($script:AppVersion). Reload the page and try again."
    }
    $m = Get-FolderMarker $script:DataRoot
    if ($m.state -eq 'unreadable') {
        return "The data folder's $($script:MarkerName) cannot be read (still syncing?), so nothing is saved for now. Try again in a moment; if it persists, fix or delete that file."
    }
    if ($m.minVersion -and (Compare-Version $m.minVersion $script:AppVersion) -gt 0) {
        return "This data folder needs version $($m.minVersion) or later of the app - this copy is $script:AppVersion. Update it from the Dashboard, then try again."
    }
    return $null
}

# The version in assets\release-notes.js right now. It differs from the one
# this launcher started with when the app's files changed underneath it -
# a second launcher installed an update, OneDrive synced a newer copy in, or
# the developer pulled. Pages then load the new files while this process is
# still the old one; the only cure is restarting the launcher.
$script:DiskVersionStamp = ''
$script:DiskVersion = $script:AppVersion
function Get-DiskVersion {
    $f = Join-Path $AppRoot 'assets\release-notes.js'
    try {
        $stamp = [string](Get-Item -LiteralPath $f).LastWriteTimeUtc.Ticks
        if ($stamp -ne $script:DiskVersionStamp) {
            $script:DiskVersion = [string](Get-ReleaseInfo ([System.IO.File]::ReadAllText($f, $Utf8))).version
            $script:DiskVersionStamp = $stamp
        }
    } catch { }
    return $script:DiskVersion
}

function Get-StaleLauncherMessage {
    $disk = Get-DiskVersion
    if ($disk -eq $script:AppVersion) { return $null }
    return "The app's files are version $disk but this launcher window is still running $script:AppVersion. Close the launcher window and start 'Start FTE Calculator.cmd' again."
}

function Test-WriteAllowed {
    param([System.IO.Stream]$Stream, [hashtable]$Headers)
    $why = Get-WriteRefusal $Headers
    if (-not $why) { return $true }
    Write-Log "refused a write: $why" 'DarkYellow'
    Send-Error $Stream 426 'Upgrade Required' $why
    return $false
}

# --------------------------------------------------------------- updates ----

$script:UpdateInfo = $null         # the last check, returned by /api/update/*
$script:RestartRequested = $false  # set by an install; the main loop restarts

# Downloads go through curl.exe, which ships with Windows 10 and 11. On some
# corporate networks Windows PowerShell's own .NET requests to GitHub simply
# time out while curl gets through in a fraction of a second, so .NET is only
# the fallback, for when curl is missing or cannot connect at all.
$script:Curl = Join-Path $env:SystemRoot 'System32\curl.exe'

# @{ ok; code; message }. Exit codes 5, 6, 7, 28 and 35 mean curl could not
# connect (proxy, DNS, refused, timeout, TLS); anything else is an answer.
function Invoke-Curl {
    param([string]$Url, [string]$OutFile, [int]$TimeoutSec)
    if (-not (Test-Path -LiteralPath $script:Curl)) { return @{ ok = $false; code = -1; message = 'curl.exe is not available' } }
    $errFile = [System.IO.Path]::GetTempFileName()
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $script:Curl --silent --show-error --location --fail --max-time $TimeoutSec `
            --user-agent ('DPM-FTE-Calculator/' + $script:AppVersion) --output $OutFile --stderr $errFile $Url
        $code = $LASTEXITCODE
        if ($code -eq 0) { return @{ ok = $true; code = 0; message = '' } }
        return @{ ok = $false; code = $code; message = ([System.IO.File]::ReadAllText($errFile)).Trim() }
    } finally {
        $ErrorActionPreference = $old
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
}

function Test-CurlCouldNotConnect { param($Result) return ($Result.code -in @(-1, 5, 6, 7, 28, 35)) }

function New-DotNetRequest {
    param([string]$Url, [int]$TimeoutMs)
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
    $req = [System.Net.WebRequest]::Create($Url)
    $req.Timeout = $TimeoutMs
    if ($req -is [System.Net.HttpWebRequest]) {
        $req.UserAgent = 'DPM-FTE-Calculator/' + $script:AppVersion
        $req.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
        $req.Proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
    }
    return $req
}

function Get-RemoteText {
    param([string]$Url, [int]$TimeoutMs = 6000)
    $u = $Url
    if ($u -match '^https?://') {
        $u += $(if ($u.Contains('?')) { '&' } else { '?' }) + 't=' + [DateTime]::UtcNow.Ticks
        $tmp = [System.IO.Path]::GetTempFileName()
        try {
            $r = Invoke-Curl -Url $u -OutFile $tmp -TimeoutSec ([Math]::Max(3, [int]($TimeoutMs / 1000)))
            if ($r.ok) { return [System.IO.File]::ReadAllText($tmp, $Utf8) }
            if (-not (Test-CurlCouldNotConnect $r)) { throw $r.message }
        } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
    try {
        $resp = (New-DotNetRequest $u $TimeoutMs).GetResponse()
        try {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), $Utf8)
            return $reader.ReadToEnd()
        } finally { $resp.Close() }
    } catch { throw $_.Exception.GetBaseException().Message }
}

function Save-RemoteFile {
    param([string]$Url, [string]$Path, [int]$TimeoutMs = 120000)
    if ($Url -match '^https?://') {
        $r = Invoke-Curl -Url $Url -OutFile $Path -TimeoutSec ([int]($TimeoutMs / 1000))
        if ($r.ok) { return }
        if (-not (Test-CurlCouldNotConnect $r)) { throw "the download failed: $($r.message)" }
    }
    try {
        $resp = (New-DotNetRequest $Url $TimeoutMs).GetResponse()
        try {
            $in = $resp.GetResponseStream()
            $out = [System.IO.File]::Create($Path)
            try { $in.CopyTo($out) } finally { $out.Close() }
        } finally { $resp.Close() }
    } catch { throw "the download failed: $($_.Exception.GetBaseException().Message)" }
}

# How this copy of the app can be updated: 'git' for a git working folder
# (the developer's copy - updated with git pull, and only when clean), 'zip'
# for a downloaded copy (the new version is downloaded and copied over it).
function Get-InstallMode {
    if (Test-Path -LiteralPath (Join-Path $AppRoot '.git')) { return 'git' }
    return 'zip'
}

function Invoke-UpdateCheck {
    param([int]$TimeoutMs = 6000)
    $info = [ordered]@{
        current = $script:AppVersion; latest = $null; available = $false; releases = @()
        checkedAt = (Get-Date).ToString('o'); error = $null; installMode = (Get-InstallMode)
    }
    try {
        $remote = Get-ReleaseInfo (Get-RemoteText $UpdateNotesUrl $TimeoutMs)
        $info.latest = [string]$remote.version
        $info.available = ((Compare-Version $info.latest $script:AppVersion) -gt 0)
        $info.releases = @(@(Get-Prop $remote 'releases') | Where-Object { $_ -and (Compare-Version ([string]$_.version) $script:AppVersion) -gt 0 })
    } catch {
        $info.error = "Could not reach GitHub to check for updates ($($_.Exception.GetBaseException().Message))."
    }
    $script:UpdateInfo = $info
    return $info
}

# The last check, repeated when it is old: a launcher left open for days must
# still notice a release, and a failed check (offline at start) is retried
# soon rather than reported for the rest of the day.
function Get-UpdateInfo {
    $i = $script:UpdateInfo
    if ($i) {
        $age = ((Get-Date) - [DateTime]::Parse($i.checkedAt)).TotalMinutes
        if ($i.error) { if ($age -lt 2) { return $i } }
        elseif ($age -lt 15) { return $i }
    }
    return (Invoke-UpdateCheck)
}

# Copy the app's own files from one folder to another. Never the data, the
# per-PC setting, backups, git's folder or the generated single-file build.
$script:KeepOut = @('data', 'backup', 'config.json', '.git', 'DPM-FTE-Calculator-portable.html')
# The launcher's .cmd is still being read by cmd.exe while this runs, and
# cmd.exe continues from its old position in the file - replacing it now
# would run whatever lands there. It is staged next to it instead and
# swapped in by the new launcher (Install-StagedLauncher).
$script:LauncherCmd = 'Start FTE Calculator.cmd'
function Copy-AppFiles {
    param([string]$From, [string]$To, [switch]$Live)
    if (-not (Test-Path -LiteralPath $To)) { New-Item -ItemType Directory -Path $To -Force | Out-Null }
    foreach ($item in @(Get-ChildItem -LiteralPath $From -Force)) {
        if ($script:KeepOut -contains $item.Name) { continue }
        if ($Live -and $item.Name -eq $script:LauncherCmd) {
            $cur = Join-Path $To $item.Name
            $same = (Test-Path -LiteralPath $cur) -and ((Get-FileHash -LiteralPath $cur).Hash -eq (Get-FileHash -LiteralPath $item.FullName).Hash)
            if (-not $same) { Copy-Item -LiteralPath $item.FullName -Destination ($cur + '.new') -Force }
            continue
        }
        Copy-Item -LiteralPath $item.FullName -Destination $To -Recurse -Force
    }
}

# Put back what Copy-AppFiles replaced. Keeps going past an item that cannot
# be restored, and reports every one of them.
function Restore-AppFiles {
    param([string]$From, [string]$To)
    $failed = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $From -Force)) {
        if ($item.Name -eq $script:LauncherCmd) { continue }
        try { Copy-Item -LiteralPath $item.FullName -Destination $To -Recurse -Force }
        catch { $failed += $item.Name }
    }
    return $failed
}

function Install-StagedLauncher {
    $staged = Join-Path $AppRoot ($script:LauncherCmd + '.new')
    if (-not (Test-Path -LiteralPath $staged)) { return }
    # Copied over in place, never Move-Item -Force: that deletes the target
    # first, and if the move then fails (OneDrive still uploading the new
    # file) there is no launcher left to double-click. A staged copy that
    # cannot be removed yet is simply copied again at the next start.
    try {
        [System.IO.File]::Copy($staged, (Join-Path $AppRoot $script:LauncherCmd), $true)
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    } catch { Write-Log "could not replace '$($script:LauncherCmd)' yet: $($_.Exception.Message)" 'DarkYellow' }
}

function Install-FromZip {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('fte-update-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $zip = Join-Path $tmp 'update.zip'
        Write-Log 'downloading the update...' 'Cyan'
        Save-RemoteFile $UpdateZipUrl $zip
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $x = Join-Path $tmp 'x'
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $x)
        # GitHub's zip holds one top folder ("FTE-Calculator--main").
        $src = $x
        if (-not (Test-Path -LiteralPath (Join-Path $src 'index.html'))) {
            $top = @(Get-ChildItem -LiteralPath $x -Directory) | Select-Object -First 1
            if ($top) { $src = $top.FullName }
        }
        foreach ($need in @('index.html', 'server\serve.ps1', 'assets\release-notes.js', 'assets\app.js')) {
            if (-not (Test-Path -LiteralPath (Join-Path $src $need))) { throw "the download is incomplete ($need is missing)" }
        }
        $newInfo = Get-ReleaseInfo ([System.IO.File]::ReadAllText((Join-Path $src 'assets\release-notes.js'), $Utf8))
        $newVersion = [string]$newInfo.version
        if ((Compare-Version $newVersion $script:AppVersion) -le 0) { throw "the download is version $newVersion, which is not newer than $script:AppVersion" }

        # Keep the current files, so a failed copy can be put back - and so
        # the previous version is at hand if the new one misbehaves. The copy
        # is made under a temporary name and only replaces the older backup
        # once it is complete: a backup cut short never costs the last good one.
        $backupRoot = Join-Path $AppRoot 'backup'
        $backup = Join-Path $backupRoot ('version-' + $script:AppVersion)
        $fresh = $backup + '.new'
        if (Test-Path -LiteralPath $fresh) { Remove-Item -LiteralPath $fresh -Recurse -Force }
        Copy-AppFiles -From $AppRoot -To $fresh
        foreach ($old in @(Get-ChildItem -LiteralPath $backupRoot -Directory -Force)) {
            if ($old.FullName -ne $fresh) { Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction SilentlyContinue }
        }
        if (Test-Path -LiteralPath $backup) { throw "the older backup in '$backup' could not be replaced - close anything using it and try again" }
        Move-Item -LiteralPath $fresh -Destination $backup

        try { Copy-AppFiles -From $src -To $AppRoot -Live }
        catch {
            $why = $_.Exception.Message
            Write-Log "update failed, putting the previous version back: $why" 'Red'
            Remove-Item -LiteralPath (Join-Path $AppRoot ($script:LauncherCmd + '.new')) -Force -ErrorAction SilentlyContinue
            $failed = @(Restore-AppFiles -From $backup -To $AppRoot)
            if ($failed.Count) {
                throw "$why. Some files could not be put back ($($failed -join ', ')) - copy them from '$backup'."
            }
            throw
        }
        return $newVersion
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Install-FromGit {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { throw 'This copy is a git working folder, but git is not installed. Update it with git.' }
    # git writes progress to stderr; that is not an error here.
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $dirty = (& git -C $AppRoot status --porcelain 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "git could not read this folder: $dirty" }
        if ($dirty) { throw 'This copy has local changes that are not committed, so it was not updated. Commit or discard them, then update with git pull.' }
        $out = (& git -C $AppRoot pull --ff-only 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "git pull did not succeed: $out" }
    } finally { $ErrorActionPreference = $old }
    $now = [string](Get-ReleaseInfo ([System.IO.File]::ReadAllText((Join-Path $AppRoot 'assets\release-notes.js'), $Utf8))).version
    if ((Compare-Version $now $script:AppVersion) -le 0) {
        throw "git pull finished, but this folder is still version $now. Check which branch and remote it follows."
    }
    return $now
}

function Read-Config {
    if (-not (Test-Path -LiteralPath $ConfigFile)) { return $null }
    try { return (Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json) }
    catch { Write-Log "config.json is unreadable and was ignored" 'DarkYellow'; return $null }
}

# config.json: { dataRoot, localOnly }. localOnly records that this person
# chose the app's own folder over the SharePoint team folder, so the app does
# not keep linking it again on every start.
$script:LocalOnly = $false
$script:MissingRoot = ''   # configured folder that did not exist at start-up

function Save-Config {
    param([string]$Root, [bool]$LocalOnly = $false)   # Root '' = default folder
    $script:LocalOnly = $LocalOnly
    if ([string]::IsNullOrWhiteSpace($Root) -and -not $LocalOnly) {
        if (Test-Path -LiteralPath $ConfigFile) { Remove-Item -LiteralPath $ConfigFile -Force }
        return
    }
    $o = [ordered]@{}
    if (-not [string]::IsNullOrWhiteSpace($Root)) { $o.dataRoot = $Root }
    if ($LocalOnly) { $o.localOnly = $true }
    Write-TextFile -Path $ConfigFile -Content ($o | ConvertTo-Json)
}

# ------------------------------------------------- OneDrive / SharePoint ----

# The OneDrive accounts signed in on this PC (who the user is, and where each
# account's files are synced to). Read from the user's own registry hive; no
# network call, nothing to install.
function Get-OneDriveAccounts {
    $out = @()
    foreach ($k in @(Get-ChildItem 'HKCU:\Software\Microsoft\OneDrive\Accounts' -ErrorAction SilentlyContinue)) {
        $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
        $email  = [string](Get-Prop $p 'UserEmail')
        $folder = [string](Get-Prop $p 'UserFolder')
        if (-not $email -and -not $folder) { continue }
        $out += [pscustomobject]@{
            email    = $email
            name     = [string](Get-Prop $p 'UserName')
            folder   = $folder
            business = ([string](Get-Prop $p 'Business') -eq '1')
        }
    }
    return ,$out
}

function ConvertTo-FolderUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return '' }
    $u = [Uri]::UnescapeDataString($Url.Trim()).Replace('\', '/')
    if (-not $u.EndsWith('/')) { $u += '/' }
    return $u
}

# Where one OneDrive sync mount holds the folder at $Target (a SharePoint
# address ending in '/'), or $null. $Namespace is the mount's SharePoint
# address, $MountPoint its local folder.
#  - A whole library is mounted at its root: the folder sits at the same
#    relative path below the mount point.
#  - A shortcut ("Add shortcut to My files") is mounted at the shortcut itself
#    while its namespace is still the library root: the mount point IS the
#    folder, confirmed by its name matching the folder's last segment.
#  - A shortcut to a parent folder works the same way one level up: the mount
#    point stands in for that parent, so its name must match that parent.
function Resolve-MountedFolder {
    param([string]$Target, [string]$Namespace, [string]$MountPoint)
    if (-not $Target -or -not $Namespace -or -not $MountPoint) { return $null }
    if (-not $Target.StartsWith($Namespace, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $segs = @(($Target.Substring($Namespace.Length).TrimEnd('/')) -split '/' | Where-Object { $_ })
    if (-not $segs.Count) { return $MountPoint }
    $leaf = Split-Path -Leaf $MountPoint
    for ($s = 0; $s -lt $segs.Count; $s++) {
        if ($s -gt 0 -and -not ($leaf -ieq $segs[$s - 1])) { continue }
        $p = Join-Path $MountPoint ($segs[$s..($segs.Count - 1)] -join '\')
        if (Test-Path -LiteralPath $p -PathType Container) { return $p }
    }
    if ($leaf -ieq $segs[-1]) { return $MountPoint }
    return $null
}

# Where the SharePoint team folder is synced on this PC, most certain first.
#  1. OneDrive's sync engine lists every synced location with its SharePoint
#     address, so the exact folder is found however it is named locally -
#     whether it is the owner's own OneDrive or a library synced from Teams.
#  2. "Add shortcut to My files" puts a shared folder in the root of each
#     person's OneDrive under the folder's own name.
function Find-TeamFolder {
    param([string]$Name, [string]$WebPath)
    $found = New-Object System.Collections.ArrayList
    $seen  = @{}
    $target = ConvertTo-FolderUrl $WebPath
    $mounts = @()

    foreach ($k in @(Get-ChildItem 'HKCU:\Software\SyncEngines\Providers\OneDrive' -ErrorAction SilentlyContinue)) {
        $p  = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
        $mp = [string](Get-Prop $p 'MountPoint')
        if (-not $mp -or -not (Test-Path -LiteralPath $mp -PathType Container)) { continue }
        $mounts += $mp
        $ns = ConvertTo-FolderUrl ([string](Get-Prop $p 'UrlNamespace'))
        if (-not $target -or -not $ns) { continue }
        $path = Resolve-MountedFolder -Target $target -Namespace $ns -MountPoint $mp
        if ($path -and -not $seen.ContainsKey($path.ToLowerInvariant())) {
            $seen[$path.ToLowerInvariant()] = $true
            [void]$found.Add([ordered]@{ path = $path; how = 'sharepoint' })
        }
    }

    if ($Name) {
        $roots = @($env:OneDriveCommercial, $env:OneDrive) + @((Get-OneDriveAccounts) | ForEach-Object { $_.folder }) + $mounts
        $doneRoots = @{}
        foreach ($r in $roots) {
            if ([string]::IsNullOrWhiteSpace($r) -or $doneRoots.ContainsKey($r.ToLowerInvariant())) { continue }
            $doneRoots[$r.ToLowerInvariant()] = $true
            foreach ($d in @(Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue)) {
                if (-not $d.Name.Equals($Name, [StringComparison]::OrdinalIgnoreCase)) { continue }
                if ($seen.ContainsKey($d.FullName.ToLowerInvariant())) { continue }
                $seen[$d.FullName.ToLowerInvariant()] = $true
                [void]$found.Add([ordered]@{ path = $d.FullName; how = 'name' })
            }
        }
    }

    foreach ($c in $found) {
        $c.records = (Get-RecordFiles -Root $c.path).Count
    }
    return ,$found
}

# ------------------------------------------------------ project folders ----

# Layout of a data folder:
#   <Project name>\<record id>.json          one file per calculation
#   <Project name>\<Project name> - <who>.xlsx
#   projects\                                saved configurations
#   records\                                 where earlier versions kept every
#                                            estimate - still read, no longer written
# The browser names the project folder (one place decides it, so the launcher
# and the Chrome folder mode always agree); the host only checks that it is a
# single, safe folder name inside the data folder.
$script:AppFolders = @('records', 'projects')

function Test-SafeItemName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 150) { return $false }
    if ($Name -match '[\\/:*?"<>|]' -or $Name -match '[\x00-\x1f]') { return $false }
    if ($Name -match '^\s' -or $Name -match '[\. ]$' -or $Name -match '^\.+$') { return $false }
    if ($Name -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$') { return $false }
    return $true
}

function Test-ProjectFolderName {
    param([string]$Name)
    return (Test-SafeItemName $Name) -and ($script:AppFolders -notcontains $Name.ToLowerInvariant())
}

# Header values arrive percent-encoded so that names with accents survive.
function Get-HeaderText {
    param([hashtable]$Headers, [string]$Name)
    if (-not $Headers -or -not $Headers.ContainsKey($Name)) { return '' }
    try { return [Uri]::UnescapeDataString([string]$Headers[$Name]) } catch { return '' }
}

# Every estimate file in a data folder: the project folders plus the old
# records\ folder.
function Get-RecordFiles {
    param([string]$Root = $script:DataRoot)
    $list = @(Get-ChildItem -LiteralPath (Join-Path $Root 'records') -Filter '*.json' -File -ErrorAction SilentlyContinue)
    foreach ($d in @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue)) {
        if ($script:AppFolders -contains $d.Name.ToLowerInvariant()) { continue }
        $list += @(Get-ChildItem -LiteralPath $d.FullName -Filter '*.json' -File -ErrorAction SilentlyContinue)
    }
    return ,$list
}

# ------------------------------------------------------- record storage ----

# The record list is built live from the files - there is no index file to go
# stale or to conflict when a folder is shared. Each file is parsed once and
# cached against its timestamp and size, so re-listing a folder of hundreds
# of estimates only re-reads the ones that changed.
function Update-RecordCache {
    $seen = @{}
    $skipped = 0
    $files = Get-RecordFiles
    foreach ($f in $files) {
        $path  = $f.FullName
        $stamp = "$($f.LastWriteTimeUtc.Ticks)-$($f.Length)"
        $seen[$path] = $true
        $entry = $script:RecordCache[$path]
        if ($entry -and $entry.Stamp -eq $stamp) { continue }
        if ($script:IgnoredFiles[$path] -eq $stamp) { continue }
        try {
            $raw = [System.IO.File]::ReadAllText($path, $Utf8).Trim()
            $r   = $raw | ConvertFrom-Json
            $id  = Get-Prop $r 'id'
            $res = Get-Prop $r 'results'
            $inp = Get-Prop $r 'inputs'
            # Some other JSON someone dropped into a project folder: not an
            # estimate, not an error either - just not ours to list.
            if (-not $id -or -not $res) {
                $script:RecordCache.Remove($path)
                $script:IgnoredFiles[$path] = $stamp
                continue
            }
            $rel = $path.Substring($script:DataRoot.TrimEnd('\').Length + 1).Replace('\', '/')
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
                    file        = $rel
                }
            }
        } catch {
            $script:RecordCache.Remove($path)
            # Only a file that should have been an estimate - one named like
            # one, or in records\ - counts as unreadable. Someone else's broken
            # JSON in a project folder is simply not ours; counting it would
            # make every listing look incomplete and stop deletions syncing.
            if ($f.Name -match '^FTE-' -or $f.Directory.Name -ieq 'records') {
                $skipped++
                Write-Log "skipping unreadable record $($f.Name)" 'DarkYellow'
            } else {
                $script:IgnoredFiles[$path] = $stamp
            }
        }
    }
    foreach ($k in @($script:RecordCache.Keys)) {
        if (-not $seen.ContainsKey($k)) { $script:RecordCache.Remove($k) }
    }
    foreach ($k in @($script:IgnoredFiles.Keys)) {
        if (-not $seen.ContainsKey($k)) { $script:IgnoredFiles.Remove($k) }
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

# Newest cached copy of one estimate whose file still exists, or $null.
function Find-CachedRecordFile {
    param([string]$Id)
    $best = $null; $bestPath = $null
    foreach ($k in @($script:RecordCache.Keys)) {
        $e = $script:RecordCache[$k]
        if ([string]$e.Summary.id -ne $Id -or -not (Test-Path -LiteralPath $k)) { continue }
        if (-not $best -or [string]$e.Summary.savedAt -gt [string]$best.Summary.savedAt -or
            ([string]$e.Summary.savedAt -eq [string]$best.Summary.savedAt -and $e.Ticks -gt $best.Ticks)) {
            $best = $e; $bestPath = $k
        }
    }
    if ($best) { return $bestPath }
    return $null
}

# The data folder can disappear while the launcher runs - the OneDrive
# shortcut removed, sharing revoked. Writing then must fail (the browser keeps
# the estimate and retries) rather than quietly re-create the folder as a
# private, unsynced one at the same path.
function Test-DataRootPresent { return (Test-Path -LiteralPath $script:DataRoot -PathType Container) }

function Send-DataRootMissing {
    param([System.IO.Stream]$Stream)
    Write-Log "data folder is missing: $script:DataRoot" 'Red'
    Send-Error $Stream 503 'Service Unavailable' "The data folder is not available right now ($script:DataRoot). Is OneDrive running? The estimate is kept in the browser and written once the folder is back."
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
        [string]$Body,
        [hashtable]$Headers = @{}
    )

    # --- updates ------------------------------------------------------------
    # status: the last check (made at start-up); check: ask GitHub now;
    # install: download and install it, then restart on the same port.
    if ($Path -eq '/api/update/status') {
        Send-Json -Stream $Stream -Object (Get-UpdateInfo)
        return
    }
    if ($Path -eq '/api/update/check') {
        if ($Method -ne 'POST') { Send-Error $Stream 405 'Method Not Allowed' 'POST only'; return }
        Send-Json -Stream $Stream -Object (Invoke-UpdateCheck)
        return
    }
    if ($Path -eq '/api/update/install') {
        if ($Method -ne 'POST') { Send-Error $Stream 405 'Method Not Allowed' 'POST only'; return }
        # Files already newer than this process: installing again would back
        # up and overwrite the newer files with a mix. Restart first.
        $stale = Get-StaleLauncherMessage
        if ($stale) { Send-Error $Stream 409 'Conflict' $stale; return }
        $info = Invoke-UpdateCheck
        if ($info.error) { Send-Error $Stream 502 'Bad Gateway' $info.error; return }
        if (-not $info.available) { Send-Error $Stream 409 'Conflict' "You already have the latest version ($script:AppVersion)."; return }
        try {
            $mode = Get-InstallMode
            $installed = if ($mode -eq 'git') { Install-FromGit } else { Install-FromZip }
        } catch {
            Write-Log "update failed: $($_.Exception.Message)" 'Red'
            Send-Error $Stream 500 'Internal Server Error' ("The update could not be installed: " + $_.Exception.Message)
            return
        }
        Write-Log "updated from $script:AppVersion to $installed - restarting" 'Green'
        Send-Json -Stream $Stream -Object ([ordered]@{ ok = $true; from = $script:AppVersion; to = $installed; restarting = $true })
        $script:RestartRequested = $true
        return
    }

    # --- every workbook in the project folders (for Rebuild's tidy-up) -----
    if ($Path -eq '/api/project-files/list') {
        $items = @()
        foreach ($d in @(Get-ChildItem -LiteralPath $script:DataRoot -Directory -ErrorAction SilentlyContinue)) {
            if ($script:AppFolders -contains $d.Name.ToLowerInvariant()) { continue }
            foreach ($f in @(Get-ChildItem -LiteralPath $d.FullName -Filter '*.xlsx' -File -ErrorAction SilentlyContinue)) {
                $items += [ordered]@{ folder = $d.Name; name = $f.Name }
            }
        }
        Send-Json -Stream $Stream -Object ([ordered]@{ ok = $true; files = @($items) })
        return
    }

    # --- files of a project folder (the Excel workbook) --------------------
    # POST writes the file (body = base64), DELETE removes it and, when the
    # folder is left empty, the folder too. Folder and file name come in the
    # X-FTE-Folder / X-FTE-Name headers.
    if ($Path -eq '/api/project-files') {
        if (-not (Test-WriteAllowed $Stream $Headers)) { return }
        $folder = Get-HeaderText $Headers 'x-fte-folder'
        $name   = Get-HeaderText $Headers 'x-fte-name'
        if (-not (Test-ProjectFolderName $folder)) { Send-Error $Stream 400 'Bad Request' 'invalid project folder name'; return }
        if (-not (Test-SafeItemName $name) -or $name -notmatch '\.xlsx$') { Send-Error $Stream 400 'Bad Request' 'invalid file name'; return }
        $dir  = Join-Path $script:DataRoot $folder
        $dest = Join-Path $dir $name
        if (-not (Test-WithinRoot $dest $script:DataRoot)) { Send-Error $Stream 400 'Bad Request' 'invalid path'; return }
        $rel = (Split-Path -Leaf $script:DataRoot) + "/$folder/$name"

        if ($Method -eq 'POST') {
            try { $bytes = [Convert]::FromBase64String($Body.Trim()) }
            catch { Send-Error $Stream 400 'Bad Request' 'the file must be sent as base64'; return }
            if ($bytes.Length -lt 4 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B) {
                Send-Error $Stream 400 'Bad Request' 'that is not an Excel workbook'; return   # .xlsx is a zip: "PK"
            }
            if (-not (Test-DataRootPresent)) { Send-DataRootMissing $Stream; return }
            if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir | Out-Null }
            try { [System.IO.File]::WriteAllBytes($dest, $bytes) }
            catch [System.IO.IOException] {
                Send-Error $Stream 409 'Conflict' "'$name' is open in another program, so it could not be updated. Close it and it is rewritten next time."
                return
            }
            Write-Log "saved workbook $folder\$name" 'Green'
            Send-Json -Stream $Stream -Status 201 -StatusText 'Created' -Object ([ordered]@{ ok = $true; file = $rel })
            return
        }
        if ($Method -eq 'DELETE') {
            try { if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force } }
            catch { Send-Error $Stream 409 'Conflict' "'$name' is open in another program, so it could not be removed."; return }
            if ((Test-Path -LiteralPath $dir -PathType Container) -and -not @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue).Count) {
                Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
            }
            Write-Log "removed workbook $folder\$name" 'DarkYellow'
            Send-Json -Stream $Stream -Object ([ordered]@{ ok = $true; file = $rel })
            return
        }
        Send-Error $Stream 405 'Method Not Allowed' 'POST or DELETE'
        return
    }

    # --- health -----------------------------------------------------------
    if ($Path -eq '/api/health') {
        Send-Json -Stream $Stream -Object ([ordered]@{
            ok              = $true
            app             = 'DPM FTE Calculator'
            version         = $script:AppVersion
            folderNeeds     = (Get-FolderMarker $script:DataRoot).minVersion
            folderMarker    = (Get-FolderMarker $script:DataRoot).state
            diskVersion     = (Get-DiskVersion)
            staleLauncher   = [string](Get-StaleLauncherMessage)
            dataRoot        = $script:DataRoot
            defaultDataRoot = $DefaultDataRoot
            isDefaultRoot   = (Test-IsDefaultRoot $script:DataRoot)
            localOnly       = $script:LocalOnly
            missingRoot     = $script:MissingRoot
            time            = (Get-Date).ToString('o')
        })
        return
    }

    # --- who is using this PC (for "created by" on estimates) ---------------
    if ($Path -eq '/api/whoami') {
        # Every signed-in work account; the browser picks the one whose
        # OneDrive holds the data folder, since a PC can have more than one.
        $work = @((Get-OneDriveAccounts) | Where-Object { $_.business -and $_.email })
        Send-Json -Stream $Stream -Object ([ordered]@{
            ok          = $true
            accounts    = @($work | ForEach-Object { [ordered]@{ email = $_.email; name = $_.name; folder = $_.folder } })
            windowsUser = [string]$env:USERNAME
        })
        return
    }

    # --- find the SharePoint team folder synced on this PC -----------------
    if ($Path -eq '/api/team-folder') {
        if ($Method -ne 'POST') { Send-Error $Stream 405 'Method Not Allowed' 'POST only'; return }
        $req  = $Body | ConvertFrom-Json
        $name = [string](Get-Prop $req 'name')
        $web  = [string](Get-Prop $req 'webPath')
        if ($name -and ($name -match '[\\/:*?"<>|]' -or $name -match '^\.+$')) {
            Send-Error $Stream 400 'Bad Request' 'invalid folder name'; return
        }
        if ($web -and $web -notmatch '^https://[^/]+\.sharepoint\.com/') {
            Send-Error $Stream 400 'Bad Request' 'webPath must be a sharepoint.com address'; return
        }
        $found = Find-TeamFolder -Name $name -WebPath $web
        $current = $null
        foreach ($c in $found) {
            if ([System.IO.Path]::GetFullPath($c.path).TrimEnd('\') -ieq $script:DataRoot.TrimEnd('\')) { $current = $c.path }
        }
        Send-Json -Stream $Stream -Object ([ordered]@{
            ok = $true; candidates = @($found); linked = [bool]$current; dataRoot = $script:DataRoot
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
            $localOnly = [bool](Get-Prop $req 'localOnly')
            $oldRec  = $script:RecDir
            $oldProj = $script:ProjDir
            $oldWasDefault = Test-IsDefaultRoot $script:DataRoot
            $script:MissingRoot = ''   # a new choice replaces the one that went missing
            if ($reset -or [string]::IsNullOrWhiteSpace($target)) {
                Set-DataRoot $DefaultDataRoot
                Save-Config '' $localOnly
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
                Save-Config $script:DataRoot $false
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
                if (-not (Test-WriteAllowed $Stream $Headers)) { return }
                $rec = $Body | ConvertFrom-Json
                $id  = [string](Get-Prop $rec 'id')
                if (-not $id) { Send-Error $Stream 400 'Bad Request' 'record.id is required'; return }
                $name = (ConvertTo-SafeFileName $id) + '.json'
                # Into the project's own folder; the old records\ folder only
                # when an older page sends no folder.
                $folder = Get-HeaderText $Headers 'x-fte-folder'
                if ($folder -and -not (Test-ProjectFolderName $folder)) { Send-Error $Stream 400 'Bad Request' 'invalid project folder name'; return }
                $dir  = if ($folder) { Join-Path $script:DataRoot $folder } else { $script:RecDir }
                $dest = Join-Path $dir $name
                if (-not (Test-WithinRoot $dest $script:DataRoot)) { Send-Error $Stream 400 'Bad Request' 'invalid id'; return }
                if (-not (Test-DataRootPresent)) { Send-DataRootMissing $Stream; return }
                if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir | Out-Null }
                Write-TextFile -Path $dest -Content $Body
                # Superseded copies of this estimate: the one an earlier
                # version kept in records\, and OneDrive conflict copies
                # ("<id>-<PC>.json") beside it. Looked up by name in just those
                # two folders - rescanning every project folder on each save
                # would slow the launcher as the team folder grows.
                foreach ($d2 in @($dir, $script:RecDir)) {
                    foreach ($f2 in @(Get-ChildItem -LiteralPath $d2 -Filter ((ConvertTo-SafeFileName $id) + '*.json') -File -ErrorAction SilentlyContinue)) {
                        if ($f2.FullName -ieq $dest) { continue }
                        try { $other = [string](Get-Prop ([System.IO.File]::ReadAllText($f2.FullName, $Utf8) | ConvertFrom-Json) 'id') } catch { $other = '' }
                        if ($other -eq $id) { Remove-Item -LiteralPath $f2.FullName -Force -ErrorAction SilentlyContinue }
                    }
                }
                $md = Get-Prop (Get-Prop $rec 'results') 'totalMd'
                Write-Log "saved record $id  ($(Get-Prop $rec 'type'), $md MD)" 'Green'
                $sub = if ($folder) { $folder } else { 'records' }
                Send-Json -Stream $Stream -Status 201 -StatusText 'Created' -Object ([ordered]@{
                    ok = $true; id = $id
                    file = (Split-Path -Leaf $script:DataRoot) + "/$sub/$name"
                    folder = $sub
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
                # Found by id wherever it lives: its project folder, or the old
                # records\ folder. The cache is tried first (no folder scan);
                # only a miss, or a cached file that has since gone, rescans.
                $file = Find-CachedRecordFile $id
                if (-not $file) { Update-RecordCache; $file = Find-CachedRecordFile $id }
                if (-not $file) { Send-Error $Stream 404 'Not Found' 'no such record'; return }
                Send-Json -Stream $Stream -Object ([System.IO.File]::ReadAllText($file, $Utf8))
                return
            }
            'DELETE' {
                if (-not (Test-WriteAllowed $Stream $Headers)) { return }
                if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
                # Every copy of the estimate - in its project folder, the old
                # records\ folder, or an OneDrive conflict copy - or it comes back.
                Update-RecordCache
                foreach ($k in @($script:RecordCache.Keys)) {
                    if ([string]$script:RecordCache[$k].Summary.id -eq $id -and (Test-WithinRoot $k $script:DataRoot)) {
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
                if (-not (Test-WriteAllowed $Stream $Headers)) { return }
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
                if (-not (Test-WriteAllowed $Stream $Headers)) { return }
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
    # A fixed port is retried for a few seconds: after an update the previous
    # copy of the launcher may still be letting go of it.
    $tries = if ($Fixed -gt 0) { 10 } else { 1 }
    for ($t = 0; $t -lt $tries; $t++) {
        foreach ($p in $candidates) {
            try {
                $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
                $l.Start()
                return @{ Listener = $l; Port = $p }
            } catch {
                continue
            }
        }
        if ($t -lt $tries - 1) { Start-Sleep -Milliseconds 500 }
    }
    if ($Fixed -gt 0) { throw "Port $Fixed is in use. Close whatever is using it, or start without -Port." }
    throw "No free port in range $From-$To. Close whatever is using them, or pass -Port <n>."
}

# Resolve the data folder: -DataRoot, else config.json, else .\data. A
# configured folder that has gone missing (e.g. OneDrive not signed in) falls
# back to the default rather than refusing to start.
$chosenRoot = $DefaultDataRoot
$cfg = Read-Config
$cfgRoot = [string](Get-Prop $cfg 'dataRoot')
$script:LocalOnly = [bool](Get-Prop $cfg 'localOnly')
if (-not [string]::IsNullOrWhiteSpace($ForcedDataRoot)) { $chosenRoot = $ForcedDataRoot }
elseif (-not [string]::IsNullOrWhiteSpace($cfgRoot)) {
    if (Test-Path -LiteralPath $cfgRoot -PathType Container) { $chosenRoot = $cfgRoot }
    else {
        # Reported to the browser so this session's fallback is not mistaken
        # for "no folder chosen" - which would link the team folder and
        # overwrite the person's saved choice.
        $script:MissingRoot = $cfgRoot
        Write-Log "configured data folder not found, using the default for now: $cfgRoot" 'DarkYellow'
    }
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

# Is there a newer version? Asked once now (a few seconds at most, and never
# fatal when offline); the Dashboard shows the answer and can install it.
Write-Host "   Version         :  $script:AppVersion" -ForegroundColor Gray
$check = Invoke-UpdateCheck -TimeoutMs 4000
if ($check.available) {
    Write-Host "   Update          :  version $($check.latest) is available - see the Dashboard to install it." -ForegroundColor Green
} elseif ($check.error) {
    Write-Host '   Update          :  could not check (offline?) - the Dashboard can try again.' -ForegroundColor DarkGray
} else {
    Write-Host '   Update          :  this is the latest version.' -ForegroundColor DarkGray
}
Write-Host ''
Write-Host '  ----------------------------------------------------------------' -ForegroundColor DarkGray

try { $Host.UI.RawUI.WindowTitle = "DPM FTE Calculator $script:AppVersion" } catch {}

# An update staged a new launcher .cmd; the old one has finished by now.
Install-StagedLauncher

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
                    Invoke-ApiRoute -Stream $stream -Method $method -Path $path -Body $body -Headers $headers
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
        if ($script:RestartRequested) { break }
    }
} finally {
    try { $listener.Stop() } catch {}
    Write-Host ''
    Write-Host '  Server stopped.' -ForegroundColor Yellow
}

# After an update: start the new version of this script on the same port -
# the browser keeps each person's data per address, so the port must not
# change - and let this window close.
if ($script:RestartRequested) {
    Write-Host '  Starting the updated version...' -ForegroundColor Green
    $args2 = @('-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'serve.ps1'),
               '-Port', [string]$script:Bound, '-NoBrowser')
    if ($ForcedDataRoot) { $args2 += @('-DataRoot', $ForcedDataRoot) }
    if ($PSBoundParameters.ContainsKey('UpdateNotesUrl')) { $args2 += @('-UpdateNotesUrl', $UpdateNotesUrl) }
    if ($PSBoundParameters.ContainsKey('UpdateZipUrl')) { $args2 += @('-UpdateZipUrl', $UpdateZipUrl) }
    # Quoted for the command line. A backslash right before the closing quote
    # would escape it ("C:\My Data\" becomes C:\My Data" plus the rest), so
    # trailing backslashes are doubled.
    $quoted = $args2 | ForEach-Object {
        if ($_ -match '\s') { '"' + ($_ -replace '(\\+)$', '$1$1') + '"' } else { $_ }
    }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $quoted -WorkingDirectory $AppRoot | Out-Null
    exit 0
}
