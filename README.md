# Remote Browser

A self-hosted browser for you and your AI agents. Watch a live Chromium session, take control to browse or sign in, then let an agent continue in the same tabs and signed-in accounts through MCP.

The browser runs in Docker. Your device opens the dashboard; the agent connects to its MCP endpoint. Both use the same persistent browser profile.

## What you can do

- Watch and control the browser from a desktop or phone.
- Keep website sessions across container restarts and updates.
- Let an agent navigate with Playwright, CDP and compact page snapshots.
- Save screenshots, record videos and manage uploads and downloads in a file gallery.
- Copy and paste text between your device and the remote browser.
- Create and revoke a separate API key for each MCP client.

## Quick start

Requires Docker Engine with Compose and a Linux container environment that supports Chromium's sandbox. Only x86-64 is currently tested; Docker Desktop supplies the Linux environment on macOS and Windows.

```sh
git clone https://github.com/syntropika/remote-browser.git
cd remote-browser
docker compose up --build -d --wait
```

Open <http://localhost:8080> and create your account with a username and a password of at least 12 characters. Choose **Take control** to browse or sign in to a website, then **Return to agent** when finished.

The browser profile, account, API keys and saved files live in the `browser-data` volume. Keep that volume when updating the container.

## Connect your agent

In the dashboard, open **More options → API keys**, create a named key and copy it into your MCP client's secret storage. Configure a Streamable HTTP connection:

| Setting | Value |
| --- | --- |
| URL | `http://localhost:8080/mcp` |
| Header | `Authorization: Bearer <API_KEY>` |

For a remote deployment, use its dashboard address instead of `localhost`. See [hosting](docs/hosting.md) for network access and configuration.

The MCP exposes two tools: `browser_docs` to discover the API and `browser_execute` to run browser actions. An agent can start with:

```js
return await browser.snapshot();
```

If you are using the browser, an agent control request shows a five-second prompt that you can cancel. Give API keys only to trusted agents: they can operate your signed-in accounts and run code in the container.

## Documentation

- [Using the dashboard](docs/usage.md) — account setup, control, mobile input and clipboard.
- [MCP and agent automation](docs/mcp.md) — tools, Playwright/CDP, captures and file transfers.
- [Hosting and persistence](docs/hosting.md) — configuration, remote access, updates and backups.
- [Architecture](docs/architecture.md) — runtime components, TypeScript and Effect.
- [Docker Hub releases](docs/releases.md) — publishing images from Git tags.
- [Contributing](CONTRIBUTING.md) — development checks, integration tests and commit conventions.
- [Security](SECURITY.md) — trust boundaries and vulnerability reporting.

## License

[Apache-2.0](LICENSE). Third-party components retain their own licenses; see [NOTICE](NOTICE) and [container dependency attribution](docker/THIRD_PARTY.md).
