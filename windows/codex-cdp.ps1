[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("inspect", "launch", "verify-owner")]
    [string]$Action,

    [ValidateRange(1, 65535)]
    [int]$Port = 1
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$WarningPreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"

function Write-Log {
    param([string]$Message)
    [Console]::Error.WriteLine("codex-quota-cdp: " + $Message)
}

function Write-JsonResult {
    param([object]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 10))
}

function Throw-CodedError {
    param(
        [string]$Code,
        [string]$Message,
        [object]$Details = $null
    )
    $exception = New-Object System.Exception($Message)
    $exception.Data["Code"] = $Code
    if ($null -ne $Details) {
        $exception.Data["DetailsJson"] = ($Details | ConvertTo-Json -Compress -Depth 8)
    }
    throw $exception
}

function Resolve-FullPath {
    param([string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

function Test-SamePath {
    param([string]$Left, [string]$Right)
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    return [string]::Equals((Resolve-FullPath $Left), (Resolve-FullPath $Right), [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-CodexStorePackage {
    $packages = @(Get-AppxPackage -Name "OpenAI.Codex" -PackageTypeFilter Main -ErrorAction SilentlyContinue)
    if ($packages.Count -eq 0) {
        Throw-CodedError "E_NO_STORE_PACKAGE" "The Microsoft Store OpenAI.Codex package is not registered for this user."
    }

    $eligible = @($packages | Where-Object {
        ([string]$_.SignatureKind -eq "Store") -and (-not [bool]$_.IsDevelopmentMode)
    } | Sort-Object -Property Version -Descending)
    if ($eligible.Count -eq 0) {
        Throw-CodedError "E_UNTRUSTED_STORE_PACKAGE" "OpenAI.Codex is present, but it is not a non-development Microsoft Store package."
    }

    $package = $eligible[0]
    $installRoot = Resolve-FullPath ([string]$package.InstallLocation)
    $manifest = Get-AppxPackageManifest -Package $package
    $applications = @($manifest.Package.Applications.Application)
    $matches = @()
    foreach ($application in $applications) {
        $relativeExecutable = [string]$application.Executable
        if ([string]::IsNullOrWhiteSpace($relativeExecutable)) { continue }
        $relativeExecutable = $relativeExecutable.Replace("/", "\")
        $candidate = Resolve-FullPath (Join-Path $installRoot $relativeExecutable)
        $requiredSuffix = [System.IO.Path]::Combine("app", "ChatGPT.exe")
        $insideRoot = $candidate.StartsWith($installRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
        if ($insideRoot -and $candidate.EndsWith($requiredSuffix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $matches += [pscustomobject]@{
                applicationId = [string]$application.Id
                executablePath = $candidate
                relativeExecutable = $relativeExecutable
            }
        }
    }
    if ($matches.Count -ne 1) {
        Throw-CodedError "E_CODEX_RUNTIME_UNAVAILABLE" "Expected exactly one manifest application backed by app\ChatGPT.exe." @{
            matchCount = $matches.Count
            packageFullName = [string]$package.PackageFullName
        }
    }

    $match = $matches[0]
    if ([string]::IsNullOrWhiteSpace($match.applicationId)) {
        Throw-CodedError "E_CODEX_RUNTIME_UNAVAILABLE" "The Codex manifest application has no application Id."
    }

    return [pscustomobject]@{
        name = [string]$package.Name
        version = [string]$package.Version
        packageFullName = [string]$package.PackageFullName
        packageFamilyName = [string]$package.PackageFamilyName
        publisherId = [string]$package.PublisherId
        signatureKind = [string]$package.SignatureKind
        isDevelopmentMode = [bool]$package.IsDevelopmentMode
        installLocation = $installRoot
        applicationId = $match.applicationId
        appUserModelId = ([string]$package.PackageFamilyName + "!" + $match.applicationId)
        executablePath = $match.executablePath
    }
}

function Get-ProcessPath {
    param([int]$ProcessId)
    try {
        $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction Stop
        if ($null -ne $process -and -not [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
            return [string]$process.ExecutablePath
        }
    } catch { }
    try {
        return [string](Get-Process -Id $ProcessId -ErrorAction Stop).Path
    } catch {
        return $null
    }
}

function Get-ProcessStartedAt {
    param([int]$ProcessId)
    try {
        return (Get-Process -Id $ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o")
    } catch {
        return $null
    }
}

function Get-ExactCodexProcesses {
    param([object]$Package)
    $result = @()
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue)
    foreach ($candidate in $candidates) {
        $path = [string]$candidate.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($path)) { $path = Get-ProcessPath ([int]$candidate.ProcessId) }
        if (Test-SamePath $path $Package.executablePath) {
            $result += [pscustomobject]@{
                pid = [int]$candidate.ProcessId
                executablePath = (Resolve-FullPath $path)
                startedAt = Get-ProcessStartedAt ([int]$candidate.ProcessId)
            }
        }
    }
    return @($result | Sort-Object -Property pid -Unique)
}

function Get-LoopbackListener {
    param([int]$ListenerPort)
    $connections = @()
    try {
        $connections = @(Get-NetTCPConnection -State Listen -LocalPort $ListenerPort -ErrorAction Stop)
    } catch {
        # A missing listener is reported by some Windows builds as a terminating error.
        $connections = @()
    }
    $loopback = @($connections | Where-Object { [string]$_.LocalAddress -eq "127.0.0.1" })
    if ($loopback.Count -eq 0) { return $null }
    $ownerIds = @($loopback | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($ownerIds.Count -ne 1) {
        Throw-CodedError "E_CDP_OWNER_MISMATCH" "The requested loopback port has multiple listener owners." @{
            port = $ListenerPort
            ownerPids = $ownerIds
        }
    }
    return [pscustomobject]@{
        localAddress = "127.0.0.1"
        port = $ListenerPort
        pid = [int]$ownerIds[0]
    }
}

function Confirm-ListenerOwner {
    param([object]$Package, [int]$ListenerPort)
    $listener = Get-LoopbackListener $ListenerPort
    if ($null -eq $listener) {
        Throw-CodedError "E_CDP_NOT_LISTENING" "No 127.0.0.1 CDP listener exists on the requested port." @{ port = $ListenerPort }
    }
    $ownerPath = Get-ProcessPath $listener.pid
    if (-not (Test-SamePath $ownerPath $Package.executablePath)) {
        Throw-CodedError "E_CDP_OWNER_MISMATCH" "The CDP port is not owned by the verified Store Codex executable." @{
            port = $ListenerPort
            ownerPid = $listener.pid
            ownerPath = $ownerPath
            expectedPath = $Package.executablePath
        }
    }
    return [pscustomobject]@{
        pid = $listener.pid
        executablePath = (Resolve-FullPath $ownerPath)
        startedAt = Get-ProcessStartedAt $listener.pid
        localAddress = $listener.localAddress
        port = $ListenerPort
        packageFullName = $Package.packageFullName
        packageFamilyName = $Package.packageFamilyName
    }
}

function Ensure-ActivationType {
    if ("CodexQuota.NativeActivation" -as [type]) { return }
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace CodexQuota {
    [Flags]
    public enum ActivateOptions : uint {
        None = 0
    }

    [ComImport]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IApplicationActivationManager {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            ActivateOptions options,
            out uint processId);

        [PreserveSig]
        int ActivateForFile(IntPtr appUserModelId, IntPtr itemArray, IntPtr verb, out uint processId);

        [PreserveSig]
        int ActivateForProtocol(IntPtr appUserModelId, IntPtr itemArray, out uint processId);
    }

    public static class NativeActivation {
        public static uint Activate(string appUserModelId, string arguments) {
            Type type = Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"), true);
            object instance = Activator.CreateInstance(type);
            try {
                var manager = (IApplicationActivationManager)instance;
                uint processId;
                int result = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.None, out processId);
                if (result < 0) Marshal.ThrowExceptionForHR(result);
                return processId;
            } finally {
                if (instance != null && Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance);
            }
        }
    }
}
"@
}

try {
    $package = Get-CodexStorePackage

    if ($Action -eq "inspect") {
        $processes = @(Get-ExactCodexProcesses $package)
        Write-JsonResult ([pscustomobject]@{
            ok = $true
            action = "inspect"
            package = $package
            running = ($processes.Count -gt 0)
            processes = $processes
        })
        exit 0
    }

    if ($Action -eq "verify-owner") {
        $owner = Confirm-ListenerOwner $package $Port
        Write-JsonResult ([pscustomobject]@{
            ok = $true
            action = "verify-owner"
            package = $package
            owner = $owner
        })
        exit 0
    }

    $running = @(Get-ExactCodexProcesses $package)
    if ($running.Count -gt 0) {
        $listener = Get-LoopbackListener $Port
        if ($null -eq $listener) {
            Throw-CodedError "E_RUNNING_WITHOUT_CDP" "Codex is already running without the requested verified CDP endpoint. It was not stopped." @{
                requestedPort = $Port
                pids = @($running | Select-Object -ExpandProperty pid)
            }
        }
        $owner = Confirm-ListenerOwner $package $Port
        Write-JsonResult ([pscustomobject]@{
            ok = $true
            action = "launch"
            started = $false
            package = $package
            owner = $owner
            port = $Port
        })
        exit 0
    }

    Ensure-ActivationType
    $arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=" + $Port
    Write-Log ("Activating verified Store package " + $package.packageFullName + " with loopback CDP.")
    $activationPid = [CodexQuota.NativeActivation]::Activate($package.appUserModelId, $arguments)
    Write-JsonResult ([pscustomobject]@{
        ok = $true
        action = "launch"
        started = $true
        activationPid = [int]$activationPid
        package = $package
        port = $Port
    })
    exit 0
} catch {
    $caughtException = $_.Exception
    $code = "E_WINDOWS_HELPER"
    if ($caughtException.Data.Contains("Code")) { $code = [string]$caughtException.Data["Code"] }
    $details = $null
    if ($caughtException.Data.Contains("DetailsJson")) {
        try { $details = ConvertFrom-Json ([string]$caughtException.Data["DetailsJson"]) } catch { $details = $null }
    }
    Write-JsonResult ([pscustomobject]@{
        ok = $false
        error = [pscustomobject]@{
            code = $code
            message = [string]$caughtException.Message
            details = $details
        }
    })
    exit 1
}
