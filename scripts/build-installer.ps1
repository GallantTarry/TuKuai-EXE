<#
.SYNOPSIS
    Safely extracts an uploaded application archive, normalizes metadata and license encoding,
    generates a hardened Inno Setup (.iss) script, and compiles a Windows x64 installer.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,

    [Parameter(Mandatory = $true)]
    [string]$WorkDir,

    [Parameter(Mandatory = $true)]
    [string]$OutputDir,

    [Parameter(Mandatory = $true)]
    [string]$MetadataJsonPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Register legacy encodings (e.g., GB18030/GBK) for PowerShell 7 / .NET Core compatibility.
try {
    [System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)
} catch {
    # Windows PowerShell 5.1 (.NET Framework) already provides these encodings natively.
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-SafeText {
    param(
        [string]$Value,
        [string]$FieldName,
        [int]$MaxLength = 80,
        [switch]$AllowEmpty
    )

    $trimmed = if ($null -eq $Value) { '' } else { $Value.Trim() }
    if (-not $AllowEmpty -and [string]::IsNullOrWhiteSpace($trimmed)) {
        throw "Field '$FieldName' must not be empty."
    }
    if ($trimmed.Length -gt $MaxLength) {
        throw "Field '$FieldName' exceeds max length ($MaxLength)."
    }
    if ($trimmed -match '[\r\n\x00-\x1F"`;\[\]\\/{}$%]') {
        throw "Field '$FieldName' contains forbidden control or INI characters."
    }
    return $trimmed
}

function New-DeterministicGuid {
    param([string]$Seed)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Seed))
    } finally {
        $sha.Dispose()
    }

    $guidBytes = New-Object byte[] 16
    [Array]::Copy($bytes, 0, $guidBytes, 0, 16)
    # Stamp RFC 4122 version 4/5-style variant bits for stable AppId formatting.
    $guidBytes[6] = ($guidBytes[6] -band 0x0F) -bor 0x50
    $guidBytes[8] = ($guidBytes[8] -band 0x3F) -bor 0x80
    return ([Guid]::new($guidBytes)).ToString('D').ToUpperInvariant()
}

function Expand-ArchiveSafely {
    param(
        [string]$ZipPath,
        [string]$DestinationDir,
        [long]$MaxTotalExtractedBytes = 3221225472 # 3 GiB zip-bomb guard for 14 GB runner SSD
    )

    if (-not (Test-Path -LiteralPath $ZipPath)) {
        throw "Archive not found: $ZipPath"
    }

    New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null
    $destFull = [System.IO.Path]::GetFullPath($DestinationDir)
    $destPrefix = $destFull.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar

    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        [long]$accumulatedBytes = 0
        foreach ($entry in $zip.Entries) {
            $normalizedRelative = $entry.FullName -replace '/', '\'
            if ([string]::IsNullOrWhiteSpace($normalizedRelative)) { continue }

            $targetPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($destFull, $normalizedRelative))
            if (-not $targetPath.StartsWith($destPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Blocked path traversal entry in archive: $($entry.FullName)"
            }

            if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) {
                New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
                continue
            }

            $accumulatedBytes += $entry.Length
            if ($accumulatedBytes -gt $MaxTotalExtractedBytes) {
                throw "Extracted content exceeds maximum allowed size (3 GiB)."
            }

            $parentDir = [System.IO.Path]::GetDirectoryName($targetPath)
            if (-not (Test-Path -LiteralPath $parentDir)) {
                New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
            }

            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $true)
        }
    } finally {
        $zip.Dispose()
    }
}

function Convert-LicenseToUtf16LeBom {
    param(
        [string]$SourcePath,
        [string]$TargetPath
    )

    $rawBytes = [System.IO.File]::ReadAllBytes($SourcePath)
    if ($rawBytes.Length -eq 0) {
        [System.IO.File]::WriteAllText($TargetPath, '', [System.Text.Encoding]::Unicode)
        return
    }

    $decodedText = $null
    if ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
        $decodedText = [System.Text.Encoding]::UTF8.GetString($rawBytes, 3, $rawBytes.Length - 3)
    } elseif ($rawBytes.Length -ge 2 -and $rawBytes[0] -eq 0xFF -and $rawBytes[1] -eq 0xFE) {
        $decodedText = [System.Text.Encoding]::Unicode.GetString($rawBytes, 2, $rawBytes.Length - 2)
    } elseif ($rawBytes.Length -ge 2 -and $rawBytes[0] -eq 0xFE -and $rawBytes[1] -eq 0xFF) {
        $decodedText = [System.Text.Encoding]::BigEndianUnicode.GetString($rawBytes, 2, $rawBytes.Length - 2)
    } else {
        $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
        try {
            $decodedText = $strictUtf8.GetString($rawBytes)
        } catch {
            # Fallback to GB18030 for ANSI/GBK license files produced on Chinese Windows.
            $gbEncoding = [System.Text.Encoding]::GetEncoding(54936)
            $decodedText = $gbEncoding.GetString($rawBytes)
        }
    }

    # Normalize line endings to CRLF for Windows RichEdit rendering in Inno Setup.
    $normalizedText = ($decodedText -replace "`r`n", "`n" -replace "`r", "`n") -replace "`n", "`r`n"
    [System.IO.File]::WriteAllText($TargetPath, $normalizedText, [System.Text.Encoding]::Unicode)
}

function Find-IsccPath {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'ISCC.exe (Inno Setup 6) was not found on this runner.'
}

# 1. Load and validate build metadata
$meta = Get-Content -LiteralPath $MetadataJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$appName = Assert-SafeText -Value $meta.appName -FieldName 'appName' -MaxLength 80
$appPublisher = Assert-SafeText -Value $meta.appPublisher -FieldName 'appPublisher' -MaxLength 80 -AllowEmpty
if ([string]::IsNullOrWhiteSpace($appPublisher)) { $appPublisher = 'TuKuai Studio User' }

$appVersion = ([string]$meta.appVersion).Trim()
if ($appVersion -notmatch '^[0-9]+(\.[0-9]+){1,3}$') {
    throw "Invalid appVersion format: '$appVersion'. Expected numeric version like 1.0.0."
}

$mainExeRel = (([string]$meta.mainExe).Trim() -replace '/', '\').TrimStart('\')
if ([string]::IsNullOrWhiteSpace($mainExeRel) -or $mainExeRel -match '(^|\\)\.\.(\\|$)' -or $mainExeRel -notmatch '\.exe$') {
    throw "Invalid mainExe path: '$mainExeRel'."
}
if ($mainExeRel -match '[\r\n"`;\[\]{}$%]') {
    throw "mainExe contains forbidden characters."
}

# 2. Extract archive safely, then delete archive immediately to save runner SSD space
$extractDir = Join-Path $WorkDir 'extracted'
Expand-ArchiveSafely -ZipPath $ArchivePath -DestinationDir $extractDir
Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue

$appRoot = Join-Path $extractDir 'app'
if (-not (Test-Path -LiteralPath $appRoot)) {
    throw "Extracted archive does not contain an 'app' directory."
}

$appRootFull = [System.IO.Path]::GetFullPath($appRoot).TrimEnd('\') + '\'
$mainExeFull = [System.IO.Path]::GetFullPath((Join-Path $appRoot $mainExeRel))
if (-not $mainExeFull.StartsWith($appRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "mainExe escapes app root: $mainExeRel"
}
if (-not (Test-Path -LiteralPath $mainExeFull -PathType Leaf)) {
    throw "Selected main executable does not exist in uploaded folder: $mainExeRel"
}

# 3. Locate and normalize license.txt if present
$licenseLine = ''
$licenseCandidate = Join-Path $extractDir 'license\license.txt'
if (-not (Test-Path -LiteralPath $licenseCandidate -PathType Leaf)) {
    $rootLicense = Get-ChildItem -LiteralPath $appRoot -File | Where-Object { $_.Name -ieq 'license.txt' } | Select-Object -First 1
    if ($rootLicense) {
        $licenseCandidate = $rootLicense.FullName
    } else {
        $licenseCandidate = $null
    }
}

if ($licenseCandidate -and (Test-Path -LiteralPath $licenseCandidate -PathType Leaf)) {
    $normalizedLicense = Join-Path $WorkDir 'license_utf16.txt'
    Convert-LicenseToUtf16LeBom -SourcePath $licenseCandidate -TargetPath $normalizedLicense
    $licenseLine = "LicenseFile=$normalizedLicense"
}

# 4. Compute safe filenames, AppId, and generate hardened .iss script
$slug = ($appName -replace '[^A-Za-z0-9_-]', '-').Trim('-')
if ([string]::IsNullOrWhiteSpace($slug)) { $slug = 'App' }
if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40) }

$outputBaseFilename = "TuKuai-Setup-$slug-x64"
$appIdGuid = New-DeterministicGuid -Seed "$appPublisher|$appName"

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$issPath = Join-Path $WorkDir 'installer.iss'

# Support optional Simplified Chinese language pack if installed in Inno Setup Languages.
$isccExe = Find-IsccPath
$innoRoot = Split-Path -Parent $isccExe
$chineseIsl = Join-Path $innoRoot 'Languages\ChineseSimplified.isl'
$languagesSection = @"
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
"@
if (Test-Path -LiteralPath $chineseIsl) {
    $languagesSection = @"
[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"
"@
}

$issContent = @"
; Auto-generated by TuKuai-EXE (https://github.com/GallantTarry/TuKuai-EXE)
#define MyAppName "$appName"
#define MyAppVersion "$appVersion"
#define MyAppPublisher "$appPublisher"
#define MyAppExeName "$mainExeRel"

[Setup]
AppId={{$appIdGuid}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
$licenseLine
OutputDir=$OutputDir
OutputBaseFilename=$outputBaseFilename
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
WizardStyle=modern
Compression=lzma2/normal
SolidCompression=yes
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#MyAppExeName}

$languagesSection

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "$appRoot\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
"@

[System.IO.File]::WriteAllText($issPath, $issContent, [System.Text.UTF8Encoding]::new($true))

Write-Host "Compiling installer with ISCC.exe for '$appName' v$appVersion..."
& $isccExe $issPath
if ($LASTEXITCODE -ne 0) {
    throw "ISCC.exe failed with exit code $LASTEXITCODE"
}

$expectedExe = Join-Path $OutputDir "$outputBaseFilename.exe"
if (-not (Test-Path -LiteralPath $expectedExe -PathType Leaf)) {
    throw "Expected installer executable was not created: $expectedExe"
}

Write-Host "Built installer successfully: $expectedExe"
if ($env:GITHUB_OUTPUT) {
    "exe_name=$outputBaseFilename.exe" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
    "exe_path=$expectedExe" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
}
