[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias("Pid")]
    [ValidateRange(1, 2147483647)]
    [int]$TargetPid
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$WarningPreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"

function Write-Result([object]$Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 5))
}

try {
    $record = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $TargetPid) -ErrorAction SilentlyContinue
    if ($null -eq $record) {
        Write-Result ([pscustomobject]@{
            ok = $false
            error = [pscustomobject]@{
                code = "E_PROCESS_NOT_FOUND"
                message = "The requested process does not exist."
                details = [pscustomobject]@{ pid = $TargetPid }
            }
        })
        exit 1
    }

    $startTime = $null
    try {
        $startTime = (Get-Process -Id $TargetPid -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o")
    } catch { }

    Write-Result ([pscustomobject]@{
        ok = $true
        pid = [int]$record.ProcessId
        startTime = $startTime
        executablePath = if ([string]::IsNullOrWhiteSpace([string]$record.ExecutablePath)) { $null } else { [System.IO.Path]::GetFullPath([string]$record.ExecutablePath) }
        commandLine = if ($null -eq $record.CommandLine) { $null } else { [string]$record.CommandLine }
    })
    exit 0
} catch {
    $caught = $_.Exception
    Write-Result ([pscustomobject]@{
        ok = $false
        error = [pscustomobject]@{
            code = "E_DAEMON_INFO"
            message = [string]$caught.Message
        }
    })
    exit 1
}
