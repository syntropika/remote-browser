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

Rust 1.88 or newer and Bun 1.3. The first engine build downloads the CEF binary
distribution — roughly a gigabyte — and copies its runtime files beside the executable.

```sh
bun install
bun run build                                   # the dashboard bundle the host embeds
cargo build --release --manifest-path src/engine/Cargo.toml
cargo build --release --manifest-path src/host/Cargo.toml
./src/host/target/release/remote-browser-native \
  --engine-binary src/engine/target/release/remote-browser-cef-engine
```

The host prints the dashboard's address. Open it and the browser is yours: no account, no
sign-in and no token. It listens on this machine only and refuses a request from any other
origin, so a web page cannot drive it — but anything else running on your machine can, which
is the trade for opening it with a click.

[src/host/README.md](src/host/README.md) documents the engine protocol, the MCP tools,
the HTTP endpoints, the profile catalog and the smoke tests.

## Connect an agent

The host speaks MCP over stdio, and over HTTP at `/mcp` on the dashboard port with an API
key. A key is for agents: the dashboard itself has no sign-in, only its address. Create keys in **Settings → API keys**, where a key either reaches every session or exactly
one. An agent that releases a tab closes it, so your own tabs stay as you left them. The agent-facing contract is described in
[skills/remote-browser/SKILL.md](skills/remote-browser/SKILL.md).

## Extensions (experimental)

The dashboard includes an Extensions toolbar shortcut and a Settings section for each
session: list installed extensions, enable or disable them, open their options, or
remove them after confirmation. Management requires the custom native API and reports
when it is unavailable in older browser builds.

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
