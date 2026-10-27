# Local MCP client

The standalone `remote-browser` executable connects a local MCP host to a Remote Browser server. CEF stays on the server. The client needs no browser installation, Rust toolchain, Node.js, Bun, npm package or crates.io package.

The server must have the MCP native extension enabled and support network sessions. A reverse proxy must preserve Authorization and forward WebSocket upgrades on `/network/sessions/{id}/connect`; both MCP and network routes must reach the same server. Use a named API key from its MCP settings. Profile-scoped keys retain their existing restrictions.

## Install from GitHub

Download the matching executable and `SHA256SUMS` from a release whose tag starts with `mcp-`. Client releases are separate from the pinned CEF runtime release. Linux binaries are statically linked for x64 and arm64; macOS binaries cover Intel and Apple Silicon; Windows currently supports x64.

On Linux or macOS, the installer selects the architecture and verifies the release checksum before replacing the executable:

```sh
curl -fsSL https://raw.githubusercontent.com/syntropika/remote-browser/main/scripts/install-mcp.sh | sh
```

The default destination is `~/.local/bin/remote-browser`. Set `REMOTE_BROWSER_MCP_INSTALL_DIR` to choose another directory. Set `REMOTE_BROWSER_MCP_VERSION=mcp-<full-source-commit>` to pin a release. Without a pin, the installer finds the newest published MCP client release. Installation is explicit: starting the executable does not download updates.

On Windows, download and run `install-mcp.ps1` from the selected GitHub release. Its default destination is `%LOCALAPPDATA%/RemoteBrowser/bin/remote-browser.exe`; the same version and installation-directory variables apply.

No registry package is published. GitHub Actions checks/builds the complete platform matrix in a PR and publishes a client release only after a push to `main` changes the local client, shared network module, installers, release script or distribution workflow. Every release records the complete source commit and asset checksums. UI-only changes do not publish a client. Retrying a failed draft release resumes uploading; published assets are never overwritten.

## Configure the MCP host

Use the executable's absolute installed path if it is not on the MCP host's PATH:

```json
{
  "mcpServers": {
    "remote-browser": {
      "command": "/absolute/path/to/remote-browser",
      "args": ["mcp", "--connect", "https://browser.example.com"],
      "env": {
        "REMOTE_BROWSER_API_KEY": "<api-key>"
      }
    }
  }
}
```

`--connect` accepts the browser base URL or its `/mcp` endpoint, including a reverse-proxy path prefix. `REMOTE_BROWSER_SERVER` can supply the URL instead. `--api-key-file /path/to/key` replaces the credential environment variable. The local process speaks MCP over stdio; diagnostics use stderr. It forwards the server's tools and reservation rules without automatically replaying failed page actions.

The existing remote HTTP MCP remains available for clients that do not need local networking. The local adapter works as a normal MCP relay without exposing any local destination.

## Test a local frontend

Open an explicit network session, then create and reserve a test page:

```js
const network = await browser_network({
  action: "open",
  exposeNetwork: "localhost:3000,localhost:8080"
});
const page = await browser_tabs({
  action: "reserve",
  networkSessionId: network.networkSessionId,
  agentName: "Frontend tests",
  task: "Check the checkout flow"
});
await browser_navigate({ leaseId: page.leaseId, url: "http://localhost:3000" });
```

These are MCP tool calls; the pseudocode illustrates their sequence. All subsequent page operations use only `leaseId`, just like existing automation. `profileId` on network open selects an authorized profile; reserve can infer that profile from the session.

The page starts at a stable 1024 × 768 desktop viewport in the background without changing the selected dashboard tab. No dashboard or desktop window needs to be open. Use `browser_tabs({action: "select", leaseId})` to watch the same running test. The page still exists internally for rendering, JavaScript, screenshots and input.

Each network session uses an independent native request context. It has its own cookies, workers and network routing. Additional pages reserved with the same session ID share that session's cookies. Normal profile tabs keep their existing network and storage. Existing extension availability and cookies are not automatically imported into an isolated test context.

Exposure rules are comma-separated hostnames or IP literals with optional ports. `*` is a hostname wildcard, bracket IPv6 literals, and `<loopback>` matches localhost names and loopback addresses on any port. Matched destinations connect from the local MCP machine; unmatched destinations use the browser server's network. Original URLs, origins and ordinary CORS/TLS validation remain in effect. Local HTTPS certificates need to be trusted by the remote browser. This is TCP forwarding for HTTP(S), WebSocket and streaming; it does not expose UDP, QUIC or a complete VPN.

List or close sessions:

```js
await browser_network({ action: "list" });
await browser_tabs({ action: "close", leaseId: page.leaseId });
await browser_network({ action: "close", networkSessionId: network.networkSessionId });
```

Closing a tunnel or stopping the local MCP closes its streams. Matching requests fail rather than silently reaching the server's localhost. Tab reservations do not expire or release automatically: close/release them explicitly, or let the user take ownership. An API key revocation, scope change or disabled MCP extension closes active tunnels within the heartbeat interval. A different authenticated client cannot attach to the session or reserve its existing test pages. There are at most four sessions per client and 64 simultaneous proxied connections per session; buffers and connection deadlines are bounded.

## Development

```sh
bun run build:local-mcp --release
bun run test:network
bun run test:local-mcp
bun run lint:network
bun run lint:local-mcp
```

The real-engine integration also needs the built host and CEF engine:

```sh
bun run test:integration --suite local-mcp \
  --engine-binary /path/to/remote-browser-cef-engine \
  --host-binary /path/to/remote-browser-native \
  --local-mcp-binary /path/to/remote-browser
```

It covers stdio relay, background creation, HTTP/API/WebSocket/SSE, independent/shared session cookies, ownership, profile scope, key revocation, normal tabs and fail-closed connector shutdown. The transport unit tests exercise concurrent binary streams, half-close, destination rejection and oversized frames. Installer/release tests cover checksums, source identity and publication gates.
