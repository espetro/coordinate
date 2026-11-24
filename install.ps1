# install.ps1 - install coordinate on Windows
#
#   irm https://raw.githubusercontent.com/espetro/coordinate/main/install.ps1 | iex
#   .\install.ps1 -Version v0.1.1 -Prefix "$env:LOCALAPPDATA\coordinate\bin"
#
# Installs the windows-x64 binary from GitHub Releases, verifies its sha256,
# and puts it in a bin directory on PATH.

[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$Prefix = "$env:LOCALAPPDATA\coordinate\bin"
)

$ErrorActionPreference = "Stop"

$Repo = "espetro/coordinate"
$Target = "windows-x64.exe"

if (-not $Version) {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
  $Version = $rel.tag_name
}
if (-not $Version) { throw "could not resolve latest release; pass -Version vX.Y.Z" }

$Num = $Version.TrimStart("v")
$Name = "coordinate-$Num-$Target"
$Base = "https://github.com/$Repo/releases/download/$Version"

$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "coordinate-install-$([guid]::NewGuid())")
try {
  $bin = Join-Path $tmp $Name
  $sum = "$bin.sha256"
  Invoke-WebRequest -Uri "$Base/$Name" -OutFile $bin
  Invoke-WebRequest -Uri "$Base/$Name.sha256" -OutFile $sum

  $want = (Get-Content $sum).Split(" ")[0].Trim().ToLower()
  $got = (Get-FileHash -Algorithm SHA256 $bin).Hash.ToLower()
  if ($want -ne $got) { throw "sha256 mismatch: wanted $want got $got" }

  New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
  Copy-Item -Force $bin (Join-Path $Prefix "coordinate.exe")

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$Prefix*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$Prefix", "User")
    Write-Host "added $Prefix to user PATH (open a new terminal to pick it up)"
  }
  Write-Host "installed: $Prefix\coordinate.exe ($Version)"
  & (Join-Path $Prefix "coordinate.exe") --help | Select-Object -First 2
} finally {
  Remove-Item -Recurse -Force $tmp
}
