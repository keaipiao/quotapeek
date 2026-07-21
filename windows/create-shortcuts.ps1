[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$EngineRoot,

    [Parameter(Mandatory = $true)]
    [string]$NodePath,

    [switch]$Desktop
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$WarningPreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"

$ManagedDescription = "Managed by codex-sidebar-quota: start Codex with the local quota panel"
$LegacyDescription = "Start the official Codex client with the local quota panel"
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

function Is-UnderPath([string]$Child, [string]$Parent) {
    try {
        $childPath = Normalize-Path $Child
        $parentPath = Normalize-Path $Parent
        return $childPath.StartsWith($parentPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Quote-ShortcutArgument([string]$Value) {
    if ($Value.Contains('"')) { throw "Shortcut paths must not contain quote characters." }
    return '"' + $Value + '"'
}

function Build-Arguments([string]$WorkingDirectory, [string]$RuntimeNode) {
    $launchHelper = Normalize-Path (Join-Path $WorkingDirectory "windows\hidden-launch.ps1")
    return "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File " +
        (Quote-ShortcutArgument $launchHelper) + " -EngineRoot " + (Quote-ShortcutArgument (Normalize-Path $WorkingDirectory)) +
        " -NodePath " + (Quote-ShortcutArgument (Normalize-Path $RuntimeNode))
}

function Test-NewManagedShortcut([object]$Shortcut, [string]$ManagedEngines, [string]$PowerShellPath) {
    try {
        $working = Normalize-Path ([string]$Shortcut.WorkingDirectory)
        if (-not (Is-UnderPath $working $ManagedEngines)) { return $false }
        if (-not (Same-Path ([string]$Shortcut.TargetPath) $PowerShellPath)) { return $false }
        if ([string]$Shortcut.Description -ne $ManagedDescription) { return $false }

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
        if (-not (Is-UnderPath $working $ManagedEngines)) { return $false }
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

function Throw-ShortcutError([string]$Code, [string]$Message, [object]$Details = $null) {
    $exception = New-Object System.Exception($Message)
    $exception.Data["Code"] = $Code
    if ($null -ne $Details) { $exception.Data["Details"] = ($Details | ConvertTo-Json -Compress -Depth 5) }
    throw $exception
}

try {
    $resolvedEngine = Normalize-Path ((Resolve-Path -LiteralPath $EngineRoot -ErrorAction Stop).Path)
    $resolvedNode = Normalize-Path ((Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path)
    $entryPoint = Normalize-Path (Join-Path $resolvedEngine "bin\codex-quota.mjs")
    $launchHelper = Normalize-Path (Join-Path $resolvedEngine "windows\hidden-launch.ps1")
    if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        Throw-ShortcutError "E_ENTRY_POINT" "The installed quota-panel entry point was not found." @{ path = $entryPoint }
    }
    if (-not (Test-Path -LiteralPath $launchHelper -PathType Leaf)) {
        Throw-ShortcutError "E_LAUNCH_HELPER" "The hidden-launch helper was not found." @{ path = $launchHelper }
    }
    if ([System.IO.Path]::GetFileName($resolvedNode) -ine "node.exe") {
        Throw-ShortcutError "E_NODE_PATH" "NodePath must resolve to node.exe."
    }

    $powerShellPath = Get-SystemPowerShellPath
    if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) {
        Throw-ShortcutError "E_POWERSHELL" "Windows PowerShell was not found at its system path."
    }
    $arguments = Build-Arguments $resolvedEngine $resolvedNode
    # Derive ownership from the installation being operated on. Do not use the
    # process-wide LocalApplicationData folder: tests, portable profiles, and
    # explicit LOCALAPPDATA overrides may legitimately point elsewhere.
    $managedEngines = Normalize-Path (Split-Path -Parent $resolvedEngine)
    $programs = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::StartMenu)) "Programs"
    $destinations = @((Join-Path $programs "Codex + Quota.lnk"))
    if ($Desktop) {
        $destinations += Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)) "Codex + Quota.lnk"
    }

    $shell = New-Object -ComObject WScript.Shell
    $plans = @()
    foreach ($destination in $destinations) {
        $parent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        $existed = Test-Path -LiteralPath $destination -PathType Leaf
        if ($existed) {
            $existing = $shell.CreateShortcut($destination)
            $isCurrent = (Same-Path ([string]$existing.TargetPath) $powerShellPath) -and
                ([string]$existing.Arguments -eq $arguments) -and
                (Same-Path ([string]$existing.WorkingDirectory) $resolvedEngine) -and
                ([string]$existing.Description -eq $ManagedDescription)
            if (-not $isCurrent -and -not (Test-ManagedShortcut $existing $managedEngines $powerShellPath)) {
                Throw-ShortcutError "E_SHORTCUT_CONFLICT" "A same-name shortcut exists but is not owned by QuotaPeek for Codex." @{ path = $destination }
            }
        }
        $plans += [pscustomobject]@{ destination = $destination; existed = $existed; backup = $null }
    }

    if (($plans | Where-Object { $_.existed }).Count -gt 0) {
        $backupRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-sidebar-quota-create-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $backupRoot | Out-Null
        for ($index = 0; $index -lt $plans.Count; $index++) {
            if (-not $plans[$index].existed) { continue }
            $backup = Join-Path $backupRoot ($index.ToString() + ".lnk")
            Copy-Item -LiteralPath $plans[$index].destination -Destination $backup -Force
            $plans[$index].backup = $backup
        }
    }

    $created = @()
    try {
        foreach ($plan in $plans) {
            $shortcut = $shell.CreateShortcut($plan.destination)
            $shortcut.TargetPath = $powerShellPath
            $shortcut.Arguments = $arguments
            $shortcut.WorkingDirectory = $resolvedEngine
            $shortcut.Description = $ManagedDescription
            $shortcut.WindowStyle = 7
            $shortcut.Save()
            $created += $plan.destination
        }
    } catch {
        foreach ($plan in $plans) {
            if ($plan.existed -and $null -ne $plan.backup -and (Test-Path -LiteralPath $plan.backup -PathType Leaf)) {
                Copy-Item -LiteralPath $plan.backup -Destination $plan.destination -Force
            } elseif (-not $plan.existed -and (Test-Path -LiteralPath $plan.destination -PathType Leaf)) {
                Remove-Item -LiteralPath $plan.destination -Force -ErrorAction SilentlyContinue
            }
        }
        throw
    }

    if ($null -ne $backupRoot) { Remove-Item -LiteralPath $backupRoot -Recurse -Force; $backupRoot = $null }

    Write-Result ([pscustomobject]@{
        ok = $true
        created = $created
        targetPath = $powerShellPath
        arguments = $arguments
        workingDirectory = $resolvedEngine
        hidden = $true
    })
    exit 0
} catch {
    $caught = $_.Exception
    if ($null -ne $backupRoot -and (Test-Path -LiteralPath $backupRoot -PathType Container)) {
        Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    $code = "E_SHORTCUT_CREATE"
    if ($caught.Data.Contains("Code")) { $code = [string]$caught.Data["Code"] }
    $details = $null
    if ($caught.Data.Contains("Details")) {
        try { $details = ConvertFrom-Json ([string]$caught.Data["Details"]) } catch { $details = $null }
    }
    Write-Result ([pscustomobject]@{
        ok = $false
        error = [pscustomobject]@{ code = $code; message = [string]$caught.Message; details = $details }
    })
    exit 1
}
