<#
.SYNOPSIS
    Migrates VS Code extension data from publisher 'mthalman' to 'devdocket'
    after the DevDocket Marketplace publisher rename (commit 0fdf1b1).

.DESCRIPTION
    VS Code keys per-extension storage by extension ID (publisher.name). When
    the publisher changed from 'mthalman' to 'devdocket', the new install sees
    an empty store. This script copies the old rows in state.vscdb and any
    legacy JSON files in globalStorage\<id>\ to the new IDs.

    Mapping:
        mthalman.devdocket                  -> devdocket.devdocket
        mthalman.devdocket-github           -> devdocket.devdocket-github
        mthalman.devdocket-ado              -> devdocket.devdocket-ado
        mthalman.devdocket-ai-reviewer      -> devdocket.devdocket-ai-reviewer
        mthalman.devdocket-start-git-work   -> devdocket.devdocket-start-git-work

    The script:
      1. Verifies VS Code is closed (the SQLite DB is locked while it runs).
      2. Installs the PSSQLite module (CurrentUser) if missing.
      3. Backs up state.vscdb (and *-wal / *-shm sidecars) with a timestamp.
      4. INSERTs a copy of each old row under the new key.
      5. Copies globalStorage\<old-id>\ contents into globalStorage\<new-id>\.

    Settings (settings.json), VS Code authentication sessions, and workspace
    storage are NOT touched — the first two carry over automatically; the
    third isn't used by DevDocket.

.PARAMETER Insiders
    Migrate only VS Code Insiders. Without this switch, the script auto-
    detects Stable and Insiders and migrates whichever exist.

.PARAMETER DryRun
    Show what would happen without modifying anything.

.PARAMETER Force
    Overwrite existing rows / folders under the new ID. Without -Force, any
    new-ID row that already exists is skipped (so you don't clobber data
    you've already created on the new install).

.EXAMPLE
    # See what would happen
    .\Migrate-DevDocketPublisher.ps1 -DryRun

.EXAMPLE
    # Run for real (with VS Code closed)
    .\Migrate-DevDocketPublisher.ps1

.EXAMPLE
    # Re-run after you've already started using the new extension and want
    # the old data to win
    .\Migrate-DevDocketPublisher.ps1 -Force
#>

[CmdletBinding()]
param(
    [switch]$Insiders,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$IdMap = [ordered]@{
    'mthalman.devdocket'                = 'devdocket.devdocket'
    'mthalman.devdocket-github'         = 'devdocket.devdocket-github'
    'mthalman.devdocket-ado'            = 'devdocket.devdocket-ado'
    'mthalman.devdocket-ai-reviewer'    = 'devdocket.devdocket-ai-reviewer'
    'mthalman.devdocket-start-git-work' = 'devdocket.devdocket-start-git-work'
}

function Ensure-PSSQLite {
    if (Get-Module -ListAvailable -Name PSSQLite) {
        Import-Module PSSQLite
        return
    }
    Write-Host "Installing PSSQLite module (CurrentUser scope)..." -ForegroundColor Cyan
    # Trust PSGallery for this call only — no permanent change to repo policy.
    $orig = (Get-PSRepository -Name PSGallery).InstallationPolicy
    try {
        Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
        Install-Module -Name PSSQLite -Scope CurrentUser -Force -AllowClobber
    } finally {
        Set-PSRepository -Name PSGallery -InstallationPolicy $orig
    }
    Import-Module PSSQLite
}

function Get-VsCodeUserDir {
    param([switch]$Insiders)
    $folder = if ($Insiders) { 'Code - Insiders' } else { 'Code' }
    return (Join-Path $env:APPDATA "$folder\User")
}

function Test-VsCodeRunning {
    param([switch]$Insiders)
    $name = if ($Insiders) { 'Code - Insiders' } else { 'Code' }
    return [bool](Get-Process -Name $name -ErrorAction SilentlyContinue)
}

function Backup-File {
    param([string]$Path)
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak = "$Path.bak-$ts"
    Copy-Item -LiteralPath $Path -Destination $bak -Force
    return $bak
}

function Backup-StateDb {
    param([string]$DbPath)
    $created = @()
    $created += Backup-File -Path $DbPath
    foreach ($suffix in '-wal','-shm') {
        $sidecar = "$DbPath$suffix"
        if (Test-Path -LiteralPath $sidecar) {
            $created += Backup-File -Path $sidecar
        }
    }
    return $created
}

function Migrate-StateDb {
    param(
        [string]   $DbPath,
        [hashtable]$IdMap,
        [switch]   $DryRun,
        [switch]   $Force
    )

    $oldKeys = @($IdMap.Keys)
    $newKeys = @($IdMap.Values)

    $oldList = ($oldKeys | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ','
    $newList = ($newKeys | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ','

    $rows = @(Invoke-SqliteQuery -DataSource $DbPath -Query "SELECT key, value FROM ItemTable WHERE key IN ($oldList)")
    $existing = @(Invoke-SqliteQuery -DataSource $DbPath -Query "SELECT key FROM ItemTable WHERE key IN ($newList)")

    $existingSet = @{}
    foreach ($r in $existing) { $existingSet[$r.key] = $true }

    if ($rows.Count -eq 0) {
        Write-Host "  (no mthalman.* rows found in state.vscdb)" -ForegroundColor DarkGray
        return 0
    }

    $migrated = 0
    foreach ($row in $rows) {
        $oldKey = [string]$row.key
        $newKey = [string]$IdMap[$oldKey]
        $value  = $row.value  # byte[] (BLOB) or string

        $sizeBytes =
            if ($value -is [byte[]]) { $value.Length }
            elseif ($null -ne $value) { [System.Text.Encoding]::UTF8.GetByteCount([string]$value) }
            else { 0 }
        $sizeKb = [Math]::Max(1, [Math]::Ceiling($sizeBytes / 1024))

        if ($existingSet.ContainsKey($newKey) -and -not $Force) {
            Write-Host ("  SKIP   {0,-40} -> {1}  (target exists; use -Force to overwrite)" -f $oldKey, $newKey) -ForegroundColor Yellow
            continue
        }

        if ($DryRun) {
            Write-Host ("  WOULD  {0,-40} -> {1}  ({2} KB)" -f $oldKey, $newKey, $sizeKb) -ForegroundColor Cyan
            $migrated++
            continue
        }

        Invoke-SqliteQuery -DataSource $DbPath `
            -Query "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (@k, @v)" `
            -SqlParameters @{ k = $newKey; v = $value } | Out-Null
        Write-Host ("  COPY   {0,-40} -> {1}  ({2} KB)" -f $oldKey, $newKey, $sizeKb) -ForegroundColor Green
        $migrated++
    }

    return $migrated
}

function Migrate-GlobalStorageDirs {
    param(
        [string]   $GlobalStorageDir,
        [hashtable]$IdMap,
        [switch]   $DryRun,
        [switch]   $Force
    )

    $copied = 0
    foreach ($oldId in $IdMap.Keys) {
        $newId = $IdMap[$oldId]
        $oldDir = Join-Path $GlobalStorageDir $oldId
        $newDir = Join-Path $GlobalStorageDir $newId

        if (-not (Test-Path -LiteralPath $oldDir)) { continue }

        $children = @(Get-ChildItem -LiteralPath $oldDir -Force -ErrorAction SilentlyContinue)
        if ($children.Count -eq 0) { continue }

        $newExists = Test-Path -LiteralPath $newDir
        if ($newExists -and -not $Force) {
            Write-Host ("  SKIP   {0,-40} -> {1}\  (target exists; use -Force to merge)" -f "$oldId\", $newId) -ForegroundColor Yellow
            continue
        }

        if ($DryRun) {
            Write-Host ("  WOULD  {0,-40} -> {1}\  ({2} item(s))" -f "$oldId\", $newId, $children.Count) -ForegroundColor Cyan
            $copied++
            continue
        }

        if (-not $newExists) {
            New-Item -ItemType Directory -Force -Path $newDir | Out-Null
        }
        # Enumerate children explicitly: Copy-Item -LiteralPath does NOT expand
        # the '*' wildcard, and -Path can mis-handle paths containing literal
        # wildcard characters. Per-item LiteralPath copies are unambiguous.
        foreach ($child in $children) {
            Copy-Item -LiteralPath $child.FullName -Destination $newDir -Recurse -Force
        }
        Write-Host ("  COPY   {0,-40} -> {1}\  ({2} item(s))" -f "$oldId\", $newId, $children.Count) -ForegroundColor Green
        $copied++
    }
    return $copied
}

# --- Main ---

Write-Host ""
Write-Host "DevDocket publisher migration  (mthalman -> devdocket)" -ForegroundColor Magenta
if ($DryRun) { Write-Host "Mode: DRY RUN (no changes will be made)" -ForegroundColor Cyan }
if ($Force)  { Write-Host "Mode: FORCE (existing new-ID rows/folders will be overwritten)" -ForegroundColor Yellow }
Write-Host ""

$variants = @()
if ($Insiders) {
    $variants += [PSCustomObject]@{ Name = 'VS Code Insiders'; Insiders = $true }
} else {
    if (Test-Path (Get-VsCodeUserDir))           { $variants += [PSCustomObject]@{ Name = 'VS Code';          Insiders = $false } }
    if (Test-Path (Get-VsCodeUserDir -Insiders)) { $variants += [PSCustomObject]@{ Name = 'VS Code Insiders'; Insiders = $true  } }
}

if ($variants.Count -eq 0) {
    Write-Error "No VS Code installation found under `$env:APPDATA."
    exit 1
}

$totalRows    = 0
$totalFolders = 0

foreach ($v in $variants) {
    Write-Host "=== $($v.Name) ===" -ForegroundColor Magenta

    if (Test-VsCodeRunning -Insiders:$v.Insiders) {
        Write-Warning "$($v.Name) is currently running. Close ALL of its windows and re-run, then continue. Skipping."
        Write-Host ""
        continue
    }

    $userDir = Get-VsCodeUserDir -Insiders:$v.Insiders
    $globalStorageDir = Join-Path $userDir 'globalStorage'
    $dbPath = Join-Path $globalStorageDir 'state.vscdb'

    if (-not (Test-Path -LiteralPath $dbPath)) {
        Write-Warning "  state.vscdb not found at $dbPath - skipping."
        Write-Host ""
        continue
    }

    Ensure-PSSQLite

    Write-Host "  DB: $dbPath"

    if (-not $DryRun) {
        $backups = Backup-StateDb -DbPath $dbPath
        foreach ($b in $backups) {
            Write-Host "  Backed up -> $b" -ForegroundColor DarkGray
        }
    }

    Write-Host ""
    Write-Host "  globalState rows:"
    $migrated = Migrate-StateDb -DbPath $dbPath -IdMap $IdMap -DryRun:$DryRun -Force:$Force
    $totalRows += $migrated

    Write-Host ""
    Write-Host "  globalStorage folders (legacy JSON files):"
    $copied = Migrate-GlobalStorageDirs -GlobalStorageDir $globalStorageDir -IdMap $IdMap -DryRun:$DryRun -Force:$Force
    $totalFolders += $copied

    Write-Host ""
}

Write-Host ("Summary: {0} row(s), {1} folder(s) {2}." -f $totalRows, $totalFolders, ($(if ($DryRun) { 'would be migrated' } else { 'migrated' }))) -ForegroundColor Green

if (-not $DryRun -and $totalRows -gt 0) {
    Write-Host ""
    Write-Host "Launch VS Code and verify that your DevDocket work items, watches, and inbox state are present." -ForegroundColor Green
    Write-Host "If anything looks wrong, restore the .bak-* files next to state.vscdb to roll back." -ForegroundColor Yellow
}
