[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("prepare", "finalize", "audit")]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$AssetsDirectory,

    [Parameter(Mandatory = $true)]
    [string]$Tag,

    [Parameter(Mandatory = $true)]
    [string]$Repository,

    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
    } finally {
        $algorithm.Dispose()
    }
}

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or $Tag -ne "v$Version") {
    throw "Release tag and stable version do not match"
}

$resolvedAssets = (Resolve-Path -LiteralPath $AssetsDirectory -ErrorAction Stop).Path
$archiveName = "elonmark-codex-quota-$Version.tgz"
$checksumName = "$archiveName.sha256"
$expectedNames = @($archiveName, $checksumName)
$localAssets = @(Get-ChildItem -LiteralPath $resolvedAssets -File | Sort-Object Name)
$localNames = @($localAssets | ForEach-Object { $_.Name })
if ($localAssets.Count -ne 2 -or (Compare-Object $localNames $expectedNames)) {
    throw "Release assets must contain exactly $archiveName and $checksumName"
}

$archive = Get-Item -LiteralPath (Join-Path $resolvedAssets $archiveName) -ErrorAction Stop
$checksum = Get-Item -LiteralPath (Join-Path $resolvedAssets $checksumName) -ErrorAction Stop
$checksumFields = @((Get-Content -LiteralPath $checksum.FullName -Raw) -split '\s+' | Where-Object { $_ })
if ($checksumFields.Count -ne 2 -or $checksumFields[1] -ne $archiveName) {
    throw "Checksum asset has an unexpected format or filename"
}
$expectedHash = $checksumFields[0].ToLowerInvariant()
$actualHash = Get-Sha256 $archive.FullName
if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or $actualHash -ne $expectedHash) {
    throw "Release archive SHA-256 mismatch"
}

function Read-Release {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $json = & gh release view $Tag --repo $Repository --json assets,isDraft,isImmutable,isPrerelease,name,tagName 2>$null
        $ghExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($ghExitCode -ne 0) { return $null }
    return $json | ConvertFrom-Json
}

function Assert-ReleaseMetadata([object]$Release) {
    if ($Release.tagName -ne $Tag) { throw "GitHub Release tag metadata differs" }
    if ($Release.name -ne "Codex Quota $Version") { throw "GitHub Release title differs" }
    if ($Release.isPrerelease -eq $true) { throw "Stable GitHub Release cannot be a prerelease" }
}

function Compare-ReleaseAssets([object]$Release, [bool]$AllowMissing) {
    $remoteNames = @($Release.assets | ForEach-Object { [string]$_.name })
    $unexpected = @($remoteNames | Where-Object { $expectedNames -notcontains $_ })
    if ($unexpected.Count -gt 0) {
        throw "GitHub Release contains unexpected assets: $($unexpected -join ', ')"
    }
    $missing = @($localAssets | Where-Object { $remoteNames -notcontains $_.Name })
    if (-not $AllowMissing -and $missing.Count -gt 0) {
        throw "GitHub Release is missing expected assets: $($missing.Name -join ', ')"
    }
    return $missing
}

function Assert-ReleaseAssetHashes([object]$Release) {
    $remoteNames = @($Release.assets | ForEach-Object { [string]$_.name })
    $temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { [IO.Path]::GetTempPath() } else { $env:RUNNER_TEMP }
    $downloadRoot = Join-Path $temporaryRoot ("codex-quota-release-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $downloadRoot -ErrorAction Stop | Out-Null
    foreach ($localAsset in $localAssets) {
        if ($remoteNames -notcontains $localAsset.Name) { throw "GitHub Release asset is missing: $($localAsset.Name)" }
        & gh release download $Tag --repo $Repository --pattern $localAsset.Name --dir $downloadRoot
        if ($LASTEXITCODE -ne 0) { throw "Could not download GitHub Release asset $($localAsset.Name)" }
        $downloaded = Join-Path $downloadRoot $localAsset.Name
        $localHash = Get-Sha256 $localAsset.FullName
        $remoteHash = Get-Sha256 $downloaded
        if ($localHash -ne $remoteHash) { throw "Existing GitHub Release asset differs: $($localAsset.Name)" }
    }
}

$release = Read-Release
if ($null -eq $release) {
    if ($Mode -ne "prepare") { throw "Prepared GitHub Release does not exist" }
    $createArgs = @("release", "create", $Tag) + @($localAssets.FullName) + @(
        "--repo", $Repository,
        "--verify-tag",
        "--generate-notes",
        "--draft",
        "--title", "Codex Quota $Version"
    )
    & gh @createArgs
    if ($LASTEXITCODE -ne 0) { throw "GitHub draft Release creation failed" }
    $release = Read-Release
    if ($null -eq $release) { throw "Created GitHub draft Release could not be read back" }
}

Assert-ReleaseMetadata $release
if ($Mode -eq "prepare" -and $release.isDraft -ne $true -and $release.isImmutable -ne $true) {
    throw "Existing published GitHub Release is not immutable"
}
$missing = @(Compare-ReleaseAssets $release ($Mode -eq "prepare"))
if ($Mode -eq "prepare" -and $missing.Count -gt 0) {
    $uploadArgs = @("release", "upload", $Tag) + @($missing.FullName) + @("--repo", $Repository)
    & gh @uploadArgs
    if ($LASTEXITCODE -ne 0) { throw "GitHub Release asset upload failed" }
    $release = Read-Release
    if ($null -eq $release) { throw "GitHub Release could not be read after asset upload" }
    Assert-ReleaseMetadata $release
    [void](Compare-ReleaseAssets $release $false)
}
Assert-ReleaseAssetHashes $release

if ($Mode -eq "finalize") {
    if ($release.isDraft -eq $true) {
        $markLatest = $true
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $publishedJson = & gh release list --repo $Repository --exclude-drafts --exclude-pre-releases --limit 100 --json tagName,isLatest 2>$null
            $ghExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($ghExitCode -ne 0) { throw "Could not determine the current GitHub Latest release" }
        $parsedPublishedReleases = $publishedJson | ConvertFrom-Json
        $publishedReleases = @($parsedPublishedReleases | ForEach-Object { $_ })
        $latestReleases = @($publishedReleases | Where-Object { $_.isLatest -eq $true })
        if ($latestReleases.Count -gt 1) { throw "GitHub reported multiple Latest releases" }
        if ($latestReleases.Count -eq 0 -and $publishedReleases.Count -gt 0) {
            throw "Published GitHub Releases exist but none is marked Latest"
        }
        if ($latestReleases.Count -eq 1) {
            $latestTag = [string]$latestReleases[0].tagName
            if ($latestTag -notmatch '^v([0-9]+\.[0-9]+\.[0-9]+)$') {
                throw "Current GitHub Latest tag is not a stable version: $latestTag"
            }
            if ([version]$Matches[1] -gt [version]$Version) { $markLatest = $false }
        }
        if ($markLatest) {
            & gh release edit $Tag --repo $Repository --draft=false --latest
        } else {
            & gh release edit $Tag --repo $Repository --draft=false --latest=false
        }
        if ($LASTEXITCODE -ne 0) { throw "GitHub Release publication failed" }
    } else {
        Write-Host "GitHub Release is already published; leaving Latest unchanged."
    }
    $published = Read-Release
    if ($null -eq $published -or $published.isDraft -eq $true) {
        throw "GitHub Release is still a draft after publication"
    }
    Assert-ReleaseMetadata $published
    [void](Compare-ReleaseAssets $published $false)
    Assert-ReleaseAssetHashes $published
    if ($published.isImmutable -ne $true) {
        throw "Published GitHub Release is not immutable; enable immutable releases for the repository"
    }
}
