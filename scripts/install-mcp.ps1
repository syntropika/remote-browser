# Install a precompiled local MCP client from GitHub Releases without a language toolchain.
$ErrorActionPreference = 'Stop'
$repository = if ($env:REMOTE_BROWSER_MCP_REPOSITORY) { $env:REMOTE_BROWSER_MCP_REPOSITORY } else { 'syntropika/remote-browser' }
if ($repository -notmatch '^[\w.-]+/[\w.-]+$') { throw 'Invalid release repository' }
$version = $env:REMOTE_BROWSER_MCP_VERSION
if (-not $version) {
    $releases = Invoke-RestMethod "https://api.github.com/repos/$repository/releases?per_page=100" -TimeoutSec 30
    $version = ($releases | Where-Object { -not $_.draft -and -not $_.prerelease -and $_.tag_name -match '^mcp-[a-f0-9]{40}$' } | Select-Object -First 1).tag_name
}
if ($version -notmatch '^mcp-[a-f0-9]{40}$') { throw 'No published MCP client release found; specify REMOTE_BROWSER_MCP_VERSION' }
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'The published Windows client currently requires x64' }
$destination = if ($env:REMOTE_BROWSER_MCP_INSTALL_DIR) { $env:REMOTE_BROWSER_MCP_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'RemoteBrowser/bin' }
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $asset = 'remote-browser-windows-x64.exe'
    $base = "https://github.com/$repository/releases/download/$version"
    Invoke-WebRequest "$base/$asset" -UseBasicParsing -TimeoutSec 120 -OutFile (Join-Path $stage $asset)
    Invoke-WebRequest "$base/SHA256SUMS" -UseBasicParsing -TimeoutSec 30 -OutFile (Join-Path $stage 'SHA256SUMS')
    $lines = @(Get-Content (Join-Path $stage 'SHA256SUMS') | Where-Object { $_ -match "^([a-f0-9]{64})  $([regex]::Escape($asset))$" })
    if ($lines.Count -ne 1) { throw 'Missing or invalid client checksum' }
    $expected = $lines[0].Substring(0, 64)
    $actual = (Get-FileHash (Join-Path $stage $asset) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw 'Client checksum mismatch; nothing installed' }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Move-Item (Join-Path $stage $asset) (Join-Path $destination 'remote-browser.exe') -Force
    [Console]::Error.WriteLine("Installed $version to $destination/remote-browser.exe")
} finally {
    Remove-Item $stage -Recurse -Force
}
