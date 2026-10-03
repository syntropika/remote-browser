# Hosting and persistence

## Requirements

Requirements: Docker Engine with Compose, an x86-64 or ARM64 Linux container environment, and support for Chromium's user-namespace sandbox. Only x86-64 is currently tested. On macOS or Windows, Docker Desktop supplies the Linux environment.

Follow the [quick start](../README.md#quick-start) to build and start the container. Copy [`.env.example`](../.env.example) to `.env` before starting if you need different settings.

## Configuration

If `.env` sets `BROWSER_PORT`, use that port in both the dashboard and MCP URLs instead of 8080.

Set `BROWSER_TIMEZONE` in `.env` to your actual IANA time zone, such as `Europe/Lisbon`, then recreate the container. It defaults to UTC and applies to Chromium and the gateway. The desktop uses its real Linux browser identity and includes Latin, CJK, and emoji fonts; it does not spoof another operating system or guarantee acceptance by a site's login checks.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BROWSER_BIND_ADDRESS` | `127.0.0.1` | Host address used to publish port 8080 |
| `BROWSER_PORT` | `8080` | Published dashboard and MCP port |
| `BROWSER_DATA_PATH` | `browser-data` | Named volume or host directory mounted at `/data` |
| `BROWSER_TIMEZONE` | `UTC` | Browser and gateway time zone |
| `SCREEN_WIDTH` | `1280` | Virtual display width |
| `SCREEN_HEIGHT` | `800` | Virtual display height |
| `PUBLIC_ORIGIN` | Unset | Exact external origin when using a reverse proxy |

## Remote access

Compose publishes only `127.0.0.1:8080` by default. For a private remote server, an SSH tunnel can carry both the dashboard and MCP:

```sh
ssh -N -L 8080:127.0.0.1:8080 your-server
```

Then use the same localhost URLs as above. For an HTTPS reverse proxy, set `PUBLIC_ORIGIN` to the exact public origin, preserve the host, forward WebSocket upgrades, and disable buffering for the MCP stream. The gateway issues secure cookies when `PUBLIC_ORIGIN` starts with `https://`. Chromium's CDP and both raw VNC endpoints remain internal to the container.

Username/password access also works on private-LAN HTTP origins such as `http://browser.local`. HTTP does not encrypt passwords or session cookies in transit. Use a trusted LAN, an SSH tunnel, or HTTPS when transport encryption is needed.

Copy `.env.example` to `.env` to configure the host port and screen dimensions. Set `PUBLIC_ORIGIN` only when using a reverse proxy; a different origin is intentionally rejected.

## Persistence and updates

`browser-data` holds `/data/profile`, browser configuration, `/data/account.json`, `/data/api-keys.json`, saved `/data/artifacts`, and the original `/data/access-token`. The volume stays in place during updates:

```sh
docker compose build --pull --no-cache
docker compose up -d
```

`--no-cache` reruns the Debian package installation so Chromium security updates are picked up even when the base image has not changed. `--pull` also checks for an updated base image.

The runtime closes Chromium gracefully before exiting so it can flush the profile. One runtime may own the volume at a time. A volume lock prevents accidental simultaneous use, including during manual recreation.

Cookie-based login state can survive restart, but websites may expire or revoke sessions. This project does not implement a password vault. It adds no encryption-at-rest layer to the profile volume; protect the volume and its backups as sensitive account data. Stop the container before making a consistent backup. Do not remove the volume when you want to retain your sessions.

For publishing versioned images, see [Docker Hub releases](releases.md).

## Recovering a blocked browser

If a browser operation loses its upstream response, the gateway cannot prove that it stopped. It blocks subsequent automation and human input until the container is restarted. The dashboard displays this condition rather than silently granting control.

```sh
docker compose logs --tail=100 browser
docker compose restart browser
```
