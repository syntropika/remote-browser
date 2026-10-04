# Architecture

Remote Browser runs one graphical Chromium session. The dashboard and MCP client share that session through the authenticated Node gateway, which coordinates browser ownership and file operations. Paths below are relative to the repository root.

## Runtime components

| Component | Purpose | Internal endpoint |
| --- | --- | --- |
| Chromium | Persistent graphical browser | CDP on `127.0.0.1:9222` |
| Xvfb and Openbox | Virtual display and window management | Local X socket |
| x11vnc, view-only | Enforced observation, with clipboard writes disabled | `127.0.0.1:5900` |
| x11vnc, interactive | Human keyboard and mouse access | `127.0.0.1:5901` |
| Playwright MCP | Code-mode runtime with native Playwright/CDP | `127.0.0.1:8931/mcp` |
| Node gateway | Authentication, control lease, gallery, dashboard, VNC bridge, code-mode adapter | Port `8080` |
| FFmpeg | Visible-display MP4 recording | Private artifact-service Unix socket |

The supervisor briefly initializes volume ownership as root, drops to uid 1000, and starts the services. Chromium runs with its sandbox enabled. Compose retains a tailored seccomp policy, drops unnecessary capabilities, sets `no-new-privileges`, and allocates 1 GiB of shared memory. A failed child terminates the runtime so Compose can restart the whole unit coherently.

The root init process retains `CHOWN`, `SETGID`, and `SETUID` for startup and `KILL` so it can forward shutdown signals to the supervisor after that supervisor changes user. The supervisor and browser services have no effective capabilities after switching to uid 1000. `/tmp` is a 512 MiB `tmpfs` with `nosuid` and `nodev`; temporary X11 locks and sockets disappear on container restart, while the profile remains in `/data`.

Each API key grants powerful access to the browser and its authenticated accounts. Use trusted agents. This application is not a sandbox for hostile MCP clients. The control lease coordinates tool calls. `src/tab-reservations.ts` coordinates tasks between calls using stable target IDs, authenticated key IDs, expiring tokens, and a registry shared across client context wrappers in the automation process. Explicit `tabId` binds execution without changing visibility. Reservations are cooperative and native Playwright/CDP can bypass them. The control lease cannot stop JavaScript that a page or a previous tool deliberately scheduled to run later. Clipboard input passes through the remote desktop; hardware security keys and local passkeys are not forwarded automatically.

## TypeScript and Effect

Application code lives in `src/` (gateway, MCP adapter and browser services), `ui/` (dashboard), and `scripts/runtime.ts` (container supervisor). These are TypeScript modules. The application uses strict TypeScript checking; the synthetic integration fixture has a separate compiler configuration for its dynamic protocol probes. Unit fixtures run through `tsx` with Node's test runner.

Effect 4 manages business workflows, typed domain failures, service dependencies, concurrency and resource lifetimes. `src/services.ts` provides gateway dependencies through `Context.Service` and `Layer`. `src/effects.ts` contains the native I/O adapters, the Promise boundary, scoped file handles, and serialized mutation permits. Account and key records are decoded with Effect Schema. Native HTTP/WebSocket streams, Playwright callbacks, subprocess events and DOM events remain integration boundaries; do not move browser operations into a visited page or release control merely because a client disconnected.

Run `npm run typecheck`, `npm test`, and `npm run build` before starting the gateway with `npm start`. Build output belongs in `dist/` and should not be edited. The multi-stage Docker build checks and compiles TypeScript, then copies only compiled code and static assets into the runtime image. The runtime has no TypeScript compiler or Python supervisor.

The Node supervisor drops privileges before acquiring a kernel `flock` on the profile volume. Its Effect finalizer closes recordings while Chromium and X remain alive, then asks Chromium to flush the persistent profile before terminating the remaining process groups.

## Interface specifications

- [Product behavior](product.md)
- [Design system](design.md)

See [CONTRIBUTING.md](../CONTRIBUTING.md) for local checks and container integration verification.

## Upstream components

- [Chromium](https://www.chromium.org/)
- [noVNC](https://github.com/novnc/noVNC)
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Playwright Docker guidance](https://playwright.dev/docs/docker)

Dependencies are pinned in `package-lock.json`. The modified seccomp policy and its attribution live in [`docker/`](../docker/THIRD_PARTY.md).
