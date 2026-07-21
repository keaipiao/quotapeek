[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$EngineRoot,

    [Parameter(Mandatory = $true)]
    [string]$NodePath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$WarningPreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"

$ManagedDescription = "Managed by Codex Quota: start Codex with the local quota panel"
$QuotaPeekManagedDescription = "Managed by QuotaPeek for Codex: start Codex with the local quota panel"
$SidebarManagedDescription = "Managed by codex-sidebar-quota: start Codex with the local quota panel"
$ManagedDescriptions = @($ManagedDescription, $QuotaPeekManagedDescription, $SidebarManagedDescription)
$LegacyDescription = "Start the official Codex client with the local quota panel"
$ShortcutNames = @("Codex + Quota.lnk", "QuotaPeek for Codex.lnk")
$backupRoot = $null

function Write-Result([object]$Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 8))
}

function Normalize-Path([string]$Value) {
    return [System.IO.Path]::GetFullPath($Value).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

function Get-SystemPowerShellPath {
    $windowsRoot = [string]$env:SystemRoot
    if ([string]::IsNullOrWhiteSpace($windowsRoot) -or $windowsRoot -notmatch '^[A-Za-z]:[\\/]') {
        $windowsRoot = "C:\Windows"
    }
    return Normalize-Path (Join-Path $windowsRoot "System32\WindowsPowerShell\v1.0\powershell.exe")
}

function Same-Path([string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    try {
        return [string]::Equals((Normalize-Path $Left), (Normalize-Path $Right), [System.StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Quote-ShortcutArgument([string]$Value) {
    if ($Value.Contains('"')) { throw "Shortcut paths must not contain quote characters." }
    return '"' + $Value + '"'
}

function Test-NewManagedShortcut([object]$Shortcut, [string]$ManagedEngines, [string]$PowerShellPath) {
    try {
        $working = Normalize-Path ([string]$Shortcut.WorkingDirectory)
        if (-not (Same-Path (Split-Path -Parent $working) $ManagedEngines)) { return $false }
        if (-not (Same-Path ([string]$Shortcut.TargetPath) $PowerShellPath)) { return $false }
        if ([string]$Shortcut.Description -notin $ManagedDescriptions) { return $false }
        $helper = Normalize-Path (Join-Path $working "windows\hidden-launch.ps1")
        $prefix = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File " +
            (Quote-ShortcutArgument $helper) + " -EngineRoot " + (Quote-ShortcutArgument $working) + " -NodePath `""
        $arguments = [string]$Shortcut.Arguments
        if (-not $arguments.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not $arguments.EndsWith('"')) { return $false }
        $node = $arguments.Substring($prefix.Length, $arguments.Length - $prefix.Length - 1)
        return [System.IO.Path]::IsPathRooted($node) -and [System.IO.Path]::GetFileName($node) -ieq "node.exe"
    } catch { return $false }
}

function Test-LegacyManagedShortcut([object]$Shortcut, [string]$ManagedEngines) {
    try {
        $working = Normalize-Path ([string]$Shortcut.WorkingDirectory)
        if (-not (Same-Path (Split-Path -Parent $working) $ManagedEngines)) { return $false }
        if ([System.IO.Path]::GetFileName([string]$Shortcut.TargetPath) -ine "node.exe") { return $false }
        if ([string]$Shortcut.Description -ne $LegacyDescription) { return $false }
        $entry = Normalize-Path (Join-Path $working "bin\codex-quota.mjs")
        return [string]$Shortcut.Arguments -eq ((Quote-ShortcutArgument $entry) + " start --installed")
    } catch { return $false }
}

function Test-ManagedShortcut([object]$Shortcut, [string]$ManagedEngines, [string]$PowerShellPath) {
    return (Test-NewManagedShortcut $Shortcut $ManagedEngines $PowerShellPath) -or
        (Test-LegacyManagedShortcut $Shortcut $ManagedEngines)
}

try {
    # Resolve these inputs to reject malformed invocations before touching any shortcut.
    $resolvedEngine = Normalize-Path $EngineRoot
    $resolvedNode = Normalize-Path $NodePath
    if ([System.IO.Path]::GetFileName($resolvedNode) -ine "node.exe") { throw "NodePath must resolve to node.exe." }

    $powerShellPath = Get-SystemPowerShellPath
    # Bind shortcut ownership to this product root. An uninstall running from
    # another LOCALAPPDATA must never remove a different installation's links.
    $managedEngines = Normalize-Path (Split-Path -Parent $resolvedEngine)
    $programs = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::StartMenu)) "Programs"
    $desktopPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
    $destinations = @()
    foreach ($shortcutName in $ShortcutNames) {
        $destinations += Join-Path $programs $shortcutName
        $destinations += Join-Path $desktopPath $shortcutName
    }

    $shell = New-Object -ComObject WScript.Shell
    $owned = @()
    $skipped = @()
    foreach ($destination in $destinations) {
        if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) { continue }
        $shortcut = $shell.CreateShortcut($destination)
        if (Test-ManagedShortcut $shortcut $managedEngines $powerShellPath) {
            $owned += $destination
        } else {
            $skipped += [pscustomobject]@{ path = $destination; reason = "ownership-mismatch" }
        }
    }

    # Backups make removal transactional if deleting a later owned shortcut fails.
    if ($owned.Count -gt 0) {
        $backupRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-quota-shortcuts-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $backupRoot | Out-Null
        for ($index = 0; $index -lt $owned.Count; $index++) {
            Copy-Item -LiteralPath $owned[$index] -Destination (Join-Path $backupRoot ($index.ToString() + ".lnk")) -Force
        }
    }

    $removed = @()
    try {
        foreach ($destination in $owned) {
            Remove-Item -LiteralPath $destination -Force
            $removed += $destination
        }
    } catch {
        for ($index = 0; $index -lt $owned.Count; $index++) {
            $backup = Join-Path $backupRoot ($index.ToString() + ".lnk")
            if (Test-Path -LiteralPath $backup -PathType Leaf) {
                Copy-Item -LiteralPath $backup -Destination $owned[$index] -Force
            }
        }
        throw
    }

    if ($null -ne $backupRoot) {
        # Removal is already committed; cleanup of its temporary rollback copy
        # is best-effort so a file-indexer race cannot report a false failure.
        try { Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction Stop } catch {}
        $backupRoot = $null
    }
    Write-Result ([pscustomobject]@{ ok = $true; removed = $removed; skipped = $skipped })
    exit 0
} catch {
    $caught = $_.Exception
    if ($null -ne $backupRoot -and (Test-Path -LiteralPath $backupRoot -PathType Container)) {
        Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Result ([pscustomobject]@{
        ok = $false
        error = [pscustomobject]@{ code = "E_SHORTCUT_REMOVE"; message = [string]$caught.Message }
    })
    exit 1
}
