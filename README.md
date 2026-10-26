# Remote Browser

A browser you and your agents share. Chromium runs off-screen on your own machine; you watch
it and take over from a local dashboard, and an agent drives the same tabs and signed-in
accounts over MCP.

- Watch the live page, take control to browse or sign in, then hand the tab back.
- Keep each session's cookies and sign-ins in its own profile, across restarts.
- Let an agent read compact page snapshots and click, type, scroll and upload.
- Save screenshots, record the session, and manage uploads and downloads per session.
- Copy and paste between your machine and the page.
- Give every MCP client its own API key, scoped to the sessions it may use.

## How it runs

Two executables. The **host** serves the dashboard, speaks MCP over stdio and HTTP, and keeps
the API keys, sessions and reservations. The **engine** owns one session's profile
and paints it. The host starts an engine per session, so a crash never takes the dashboard
with it.

## Build and run

Rust 1.88 or newer, Bun 1.3, and Python 3.12 or newer. On Linux x86-64, the engine
build command downloads the pinned extension-enabled CEF release (293 MB), verifies
its SHA-256, and caches a flat runtime outside the checkout. Cargo copies its runtime
files beside the executable. Chromium is already compiled.

```sh
bun install
bun run build                                   # the dashboard bundle the host embeds
bun run build:engine --release
cargo build --release --manifest-path src/host/Cargo.toml
./src/host/target/release/remote-browser-native \
  --engine-binary src/engine/target/release/remote-browser-cef-engine \
  --profile-root /path/to/private-browser-data --dashboard-port 8081
```

The runtime version, source revision, download URL and checksums are pinned in
[`src/engine/cef/runtime.json`](src/engine/cef/runtime.json). `bun run prepare:cef`
prepares the runtime without compiling Rust and prints its `CEF_PATH`. The cache is
`$XDG_CACHE_HOME/remote-browser/cef` (default `~/.cache/remote-browser/cef`); later
builds reuse it without downloading. A checksum failure stops preparation.

Set `CEF_PATH` explicitly to use another existing flat CEF distribution with its
`archive.json`. Other platforms and cross builds require an explicit matching runtime.
Direct Cargo builds retain the CEF crate's default behavior, which downloads stock CEF
when `CEF_PATH` is absent; use `build:engine` for the extension-enabled Linux build.

The host prints the dashboard's address. A fresh dashboard opens without a login. Install
the optional **Access** native extension in **Settings → Extensions**, then configure its
username and password in **Settings → Access** to require sign-in. The listener is loopback
only and rejects foreign browser origins. Without Access, local programs can use the
dashboard API; protect the browser data directory as private user data.

[src/host/README.md](src/host/README.md) documents the engine protocol, the MCP tools,
the HTTP endpoints, the profile catalog and the smoke tests.

## Connect an agent

Install **MCP** in **Settings → Extensions**, then open **Settings → MCP** to create a
client API key and copy the `/mcp` endpoint on the dashboard port. Each key reaches every
session or a selected session. Disabling or uninstalling MCP rejects new agent operations
while the dashboard stays usable. Access controls the browser login independently; its
cookies never authorize MCP.

For stdio clients, use `--mcp-stdio` alongside `--dashboard-port`, or launch without a
dashboard. Explicit MCP launch options install the module on first startup. Existing key
registries migrate automatically; later restarts respect the saved module state.
An agent that releases a tab closes it, so your own tabs stay as you left them. The
agent-facing contract is described in [skills/remote-browser/SKILL.md](skills/remote-browser/SKILL.md).

## Extensions

The dashboard includes an Extensions toolbar shortcut. Its Settings page lists optional
native modules for the whole browser and Chrome extensions for the selected session.
Chrome extensions can be enabled or disabled, opened for configuration, or removed after
confirmation. Chrome extension management requires the custom native API and reports
when it is unavailable in older browser builds. Native module settings appear only after
installation. Both modules are bundled with the host; installing them requires no download.
Uninstalling preserves their saved configuration, including revoked API keys, for later
reinstallation. Access must be explicitly enabled again after reinstalling.

The native store-installation bridge requires a custom CEF build. Its
[source integration and build instructions](src/engine/cef/README.md) route installation
permissions to the dashboard while retaining Chromium's signed-package installer.
The standard precompiled CEF distribution does not include this bridge, and its native
Add to Chrome dialog is unsupported in windowless mode. Run the real-store acceptance
suite against the custom distribution before treating this integration as ready.

## Checks

```sh
bun run check   # formatting, TypeScript, lint rules and the host's tests
```

The Python smoke tests under `src/host/tests/` drive both executables end to end; see the
host's README for how to run them.
