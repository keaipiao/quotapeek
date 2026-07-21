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

$launcherLog = Join-Path $env:LOCALAPPDATA "CodexQuota\logs\launcher-error.log"

function Write-LauncherError([string]$Message) {
    try {
        $parent = Split-Path -Parent $launcherLog
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        $safe = ([string]$Message).Replace("`r", " ").Replace("`n", " ")
        $localPaths = @(
            [pscustomobject]@{ Value = [string]$env:LOCALAPPDATA; Marker = "%LOCALAPPDATA%" },
            [pscustomobject]@{ Value = [string]$env:USERPROFILE; Marker = "%USERPROFILE%" }
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Value) } | Sort-Object { $_.Value.Length } -Descending
        foreach ($item in $localPaths) {
            $safe = [regex]::Replace(
                $safe,
                [regex]::Escape($item.Value),
                $item.Marker,
                [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
            )
        }
        Set-Content -LiteralPath $launcherLog -Encoding UTF8 -Value ((Get-Date).ToUniversalTime().ToString("o") + " " + $safe)
    } catch { }
}

try {
    $resolvedEngine = (Resolve-Path -LiteralPath $EngineRoot -ErrorAction Stop).Path
    $resolvedNode = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
    if ([System.IO.Path]::GetFileName($resolvedNode) -ine "node.exe") {
        throw "NodePath must resolve to node.exe."
    }
    $entryPoint = Join-Path $resolvedEngine "bin\codex-quota.mjs"
    if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        throw "The installed quota-panel entry point is missing."
    }

    & $resolvedNode $entryPoint start --installed
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-LauncherError ("start exited with code " + $exitCode + "; run codex-q doctor --live for details")
    } elseif (Test-Path -LiteralPath $launcherLog -PathType Leaf) {
        Remove-Item -LiteralPath $launcherLog -Force -ErrorAction SilentlyContinue
    }
    exit $exitCode
} catch {
    Write-LauncherError ([string]$_.Exception.Message)
    exit 1
}
