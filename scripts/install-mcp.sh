#!/bin/sh
# Install a precompiled local MCP client from GitHub Releases; no language runtime is needed.
set -eu
repository=${REMOTE_BROWSER_MCP_REPOSITORY:-syntropika/remote-browser}
version=${REMOTE_BROWSER_MCP_VERSION:-}
destination=${REMOTE_BROWSER_MCP_INSTALL_DIR:-"$HOME/.local/bin"}
case "$repository" in *[!a-zA-Z0-9_./-]*|../*|*..*) echo 'Invalid release repository' >&2; exit 1;; esac
case "$(uname -s)" in Linux) system=linux;; Darwin) system=macos;; *) echo 'Use install-mcp.ps1 on Windows' >&2; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) architecture=x64;; aarch64|arm64) architecture=arm64;; *) echo 'Unsupported client architecture' >&2; exit 1;; esac
if [ -z "$version" ]; then
  version=$(curl --fail --silent --show-error --location --connect-timeout 10 --max-time 30 "https://api.github.com/repos/$repository/releases?per_page=100" | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"mcp-[a-f0-9]{40}"' | head -n 1 | sed -E 's/.*"(mcp-[a-f0-9]{40})"/\1/')
fi
if ! printf '%s\n' "$version" | grep -Eq '^mcp-[a-f0-9]{40}$'; then echo 'No published MCP client release found; specify REMOTE_BROWSER_MCP_VERSION' >&2; exit 1; fi
asset=remote-browser-$system-$architecture
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
base=https://github.com/$repository/releases/download/$version
curl --fail --silent --show-error --location --connect-timeout 10 --max-time 120 "$base/$asset" -o "$stage/$asset"
curl --fail --silent --show-error --location --connect-timeout 10 --max-time 30 "$base/SHA256SUMS" -o "$stage/SHA256SUMS"
expected=$(awk -v asset="$asset" '$2 == asset {print $1}' "$stage/SHA256SUMS")
if ! printf '%s\n' "$expected" | grep -Eq '^[a-f0-9]{64}$'; then echo 'Missing or invalid client checksum' >&2; exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$stage/$asset" | awk '{print $1}'); else actual=$(shasum -a 256 "$stage/$asset" | awk '{print $1}'); fi
if [ "$actual" != "$expected" ]; then echo 'Client checksum mismatch; nothing installed' >&2; exit 1; fi
mkdir -p "$destination"
# Stage beside the destination so replacement is atomic, including across filesystems.
install -m 755 "$stage/$asset" "$destination/.remote-browser-$$"
mv -f "$destination/.remote-browser-$$" "$destination/remote-browser"
printf 'Installed %s to %s/remote-browser\n' "$version" "$destination" >&2
