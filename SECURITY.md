# Security

Remote Browser shares persistent website sessions between a person and trusted agents.
The Rust host owns the dashboard, MCP access, profile catalog and files. Each profile runs
in a separate CEF engine process. Agent keys authorize browser operations within their
configured profile scope; page JavaScript can read and change the signed-in session.
Use trusted clients and treat profiles, API key registries, captures and backups as
private account data.

The host listeners bind to loopback and validate Host and Origin. Access provides an
optional dashboard login. HTTP MCP requires an active key; stdio MCP uses the launching
process's authority. Access cookies do not authorize MCP. Use an authenticated SSH tunnel for access from
another machine and keep host state readable only by the operating-system account that
runs the browser.

The CEF engine currently starts with its OS sandbox disabled. Separate engine processes
are a failure boundary, not a security boundary against hostile websites. Use a dedicated
operating-system account or an external isolation boundary appropriate to your deployment.
Keep the host and the pinned CEF runtime updated together, and verify runtime checksums.
The engine uses an ephemeral loopback DevTools listener for its native Chromiumoxide
adapter. It is not forwarded through the dashboard or exposed as a public MCP tool.
Direct local CDP access bypasses API keys, tab leases and human takeover, so other
processes on the same machine are part of the trusted execution environment. Do not
publish or proxy that listener to untrusted clients.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/syntropika/remote-browser/security/advisories/new)
when available. Otherwise, open an issue requesting a private reporting channel without
including exploit details or sensitive data. Do not include credentials, browser profiles
or other users' account information in a public issue.

Include the affected source commit and CEF runtime release, expected behavior,
reproduction steps using synthetic data and the observed impact. There is no fixed
response-time guarantee. Fixes target the current source and supported runtime versions.
