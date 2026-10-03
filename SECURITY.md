# Security

Remote Browser is a single-user browser session shared with trusted agents. MCP code execution is intentionally powerful and is not a sandbox for hostile clients. An API key grants access to the signed-in browser and its container. Use trusted MCP clients and keep browser debugging and raw VNC ports private.

Keep Chromium's sandbox enabled. Use loopback, an SSH tunnel or HTTPS for remote access. Protect persistent storage and backups as authenticated account data. Rebuild the image regularly to pick up Chromium and Debian security updates.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/syntropika/remote-browser/security/advisories/new) when it is enabled. If it is unavailable, open an issue asking the maintainers for a private reporting channel without including exploit details or sensitive data. Do not include credentials, browser profiles or other users' account information in a public issue.

Include the affected commit or image tag, expected behavior, reproduction steps using synthetic data and the observed impact. There is no fixed response-time guarantee. Fixes target the current source version; older image tags do not receive an independent maintenance commitment.
