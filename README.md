# Remote Browser

A self-hosted, persistent Chromium browser shared by a human and an MCP agent. The custom image starts from a general Debian/Node base and installs its own browser and remote desktop components.

- Chromium runs visibly on a virtual Linux desktop.
- A web dashboard streams that desktop through noVNC.
- A two-tool code-mode MCP exposes native Playwright and CDP on the same browser and profile.
- Human takeover waits for the current MCP operation to finish. An agent execution can request control through a cancellable five-second dashboard prompt.
- The browser profile, dashboard account and MCP API keys survive container replacement in a named volume.

## Start locally

Requirements: Docker Engine with Compose, an x86-64 or ARM64 Linux container environment, and support for Chromium's user-namespace sandbox. Only x86-64 is currently tested. On macOS or Windows, Docker Desktop supplies the Linux environment.

```sh
docker compose up --build -d
docker compose ps
```

Open <http://localhost:8080>. On first access, choose a username and a password of at least 12 characters. Creating the account closes first-time registration. Later visits use that username and password; no dashboard token is needed.

Setup includes **Generate password**, which creates a random 24-character password in your browser and fills both password fields. Save it in your password manager before continuing. The form also provides native password-manager hints, but automatic suggestions and saving depend on the browser and password-manager settings.

The account is stored in `/data/account.json` with a salted scrypt password hash, not the password itself. Dashboard sessions use an eight-hour HttpOnly, SameSite cookie; passwords are not stored in local storage. Complete initial setup from a trusted device before giving others access to the service.

If `.env` sets `BROWSER_PORT`, use that port in both the dashboard and MCP URLs instead of 8080.

Set `BROWSER_TIMEZONE` in `.env` to your actual IANA time zone, such as `Europe/Lisbon`, then recreate the container. It defaults to UTC and applies to Chromium and the gateway. The desktop uses its real Linux browser identity and includes Latin, CJK, and emoji fonts; it does not spoof another operating system or guarantee acceptance by a site's login checks.

Use **Take control** to sign in to a website, then **Return to agent**. The observation connection is enforced as read-only by a separate VNC server. Human ownership expires after 90 seconds without renewal; the dashboard renews it while connected. If another tool is already running, human takeover enters a pending state and waits for completion.

When an agent calls **browser_execute** during human control, the connected control owner's dashboard immediately shows a five-second popup. **Cancel · Keep control** or Escape cancels that execution and keeps the human lease. New agent prompts are suppressed for 30 seconds after cancellation, or until control is returned. Without cancellation, the same MCP call continues automatically: the server revokes interactive VNC input, waits for any current native action to finish, then reserves control for that agent operation. Other agent calls cannot run concurrently. A disconnected or revoked requesting client cancels a pending handoff. The control owner's dashboard must be connected to receive the prompt; losing its notification connection cancels the pending request. Documentation and discovery do not request control.

## Desktop and mobile controls

On desktop, the remote display fills the window. One floating bottom dock contains back, forward, reload, the address field, tabs, **Take control** or **Return to agent**, and **More options**. Tabs and More options open upward above the dock. The display fits automatically; desktop uses your physical keyboard directly and has no Zoom or Keyboard buttons. On phones, the address, history, tabs, zoom and control ownership actions sit in the top toolbar. Zoom and ownership use plain icons with 44px touch targets and accessible labels. A native keyboard input with an adjacent **Enter** action stays visible at the bottom. **More options** contains the Files gallery, API key management, clipboard, reconnect and sign-out actions, plus ownership and connection text on both layouts.

After taking control, tap the address field to use the device's native keyboard. Enter a web address or search query; searches use Google, and addresses without a scheme default to HTTPS. The tab list can open, switch and close tabs in the same persistent Chromium session. Back, forward and reload also act on that session. Closing the final tab creates a blank replacement so the browser remains running.

To type into a page on desktop, take control, click its field in the remote display, and type on your physical keyboard. On mobile, take control and tap the remote field first, then tap the local input at the bottom. Focusing that input activates the bridge only while the interactive connection has human control. The mobile input stays visible but disabled while observing, and the layout never focuses it automatically. **Enter** sits beside the input, and a dismiss action appears on focus. Use the native keyboard to delete text.

The mobile input forwards text, pasted text and composed characters through the interactive VNC connection. It clears committed text immediately and is wiped when control ends or the connection is lost. Dismissing the keyboard leaves the mobile input visible. The streamed display is a canvas, so tapping a remote field alone cannot identify that field to iOS or automatically open its keyboard.

For clipboard transfers, take control and open **More options → Clipboard**. Select text in the remote browser, then choose **Copy from browser** and **Copy to device**. To paste, focus the remote field first, paste into the panel's text area using your device's native paste action, then choose **Paste in browser**. Unicode text, including emoji, uses the desktop clipboard directly; transfers are limited to 64 KiB. The panel clears when closed or when control or the connection ends. Clipboard contents are not stored by the gateway. Copying to the device has an HTTP-compatible fallback; if the device blocks it, the text remains selected for its native Copy action. Images and files are not supported by this text bridge.

In the fitted mobile view, swipe with one finger to scroll the page and tap to click. **Zoom** switches to actual-size viewing: drag with one finger to pan the display, or use two fingers to scroll the page. Use **Fit** to return to the fitted view. Switching to the desktop layout also restores the fitted view. Native navigation, tabs, scrolling, and keyboard input require the human control lease. An unfinished native browser operation keeps MCP input blocked even if its owner releases control before the operation completes.

## Connect an MCP client

The MCP endpoint is `http://localhost:8080/mcp`, using Streamable HTTP. Configure the client with:

- URL: `http://localhost:8080/mcp`
- HTTP header: `Authorization: Bearer <API_KEY>`

Sign in to the dashboard, open **More options → API keys**, and create a named key for each client. Copy the key immediately: its full value is shown only once and cleared when you leave settings. The page also provides your deployment's MCP URL, creation dates, last-use timestamps, and individual revocation. Key management does not require taking browser control.

Revocation rejects new requests and disconnects that key's active responses. An already-running browser action may finish; the control guard remains held until its result is known. Other keys keep working. API keys cannot sign in to the dashboard or manage keys.

New keys contain 256 random bits. Only SHA-256 hashes and display metadata are persisted in the private, mode-0600 `/data/api-keys.json` registry. On the first migration, the existing `/data/access-token` is imported as **Initial key** to preserve existing clients. It can be revoked like any other key. The runtime retains the old token file for compatibility, but it is not a fallback credential and is not imported again after a restart. Keep the registry when replacing containers or restoring backups.

Supply the key through the client's secret or environment-variable mechanism. Do not commit it in project configuration. The MCP client must support custom authorization headers. `GET`, `POST`, and `DELETE` MCP requests all require bearer authentication.

The Playwright server connects through CDP to Chromium's existing browser context. It does not create a separate login session for each agent. The gateway serializes browser operations; this is a single-user, single-profile service, not a pool of isolated agent sessions.

## Agent code mode

The public MCP catalog contains only `browser_docs` and `browser_execute`.
`browser_docs({topic: "overview"})` explains the API; topics include `navigation`, `interaction`,
`cdp`, `screenshots`, `files`, and `recording`. `browser_execute({code})` runs a
JavaScript async body with `page`, `context`, `browser`, `image`, `files`, and `recording`.
This is interactive browser automation; it requires no test files or test runner.

For example, pass this as `code`:

```js
await page.goto('https://example.com');
return await browser.snapshot();
```

Use native Playwright locators such as `page.getByRole('button', {name: 'Sign in'})`
and `page.getByLabel('Email').fill(...)`. `page` follows the visible focused tab
at the start of each call. `context.pages()` lists tabs; `context.newPage()` opens
one, and `page.bringToFront()` selects one. Always await browser operations before
returning. Results contain compact JSON and any images explicitly emitted through
`image()`, without an automatic page snapshot or a copy of the submitted code.

The `browser` helpers provide compact accessibility observations (`snapshot`),
bounded rendered text (`read`), native element references (`ref`), stable tab IDs
(`tabs.list/use/open/close`), and annotated viewport screenshots (`screenshot`).
Refresh observations after navigation; references to replaced elements fail
instead of selecting a new element. Helpers close only tabs they created.
Task labels support cleanup and do not isolate clients. Native Playwright and
CDP remain available for iframes and other advanced interactions.

The server does not add connection-time instructions. It exposes
its live reference through `resources/list` and `resources/read` at
`remote-browser://docs/<topic>`. `browser_docs` provides the same content for
clients that do not expose resources. The optional skill in
`skills/remote-browser/SKILL.md` teaches the shared-browser workflow; install its
folder in the client's skill directory. A skill is not required to use the MCP.

Playwright and CDP are complementary. For Chromium-specific capabilities, use
Playwright's native CDP session in the same call:

```js
const cdp = await context.newCDPSession(page);
try {
  return await cdp.send('Page.getLayoutMetrics');
} finally {
  await cdp.detach();
}
```

There is no additional public CDP port. The MCP API key and human-control guard
apply to code-mode execution. Reference requests remain available while a human
has control. Existing flat tool names remain accepted temporarily for cached
clients but are no longer advertised; refresh the client's tool catalog.

### Screenshots and recordings

Return an image to the agent and save a downloadable copy:

```js
const bytes = await page.screenshot({type: 'png', fullPage: true});
image(bytes);
return await files.saveScreenshot(bytes, {name: 'Page capture'});
```

Record the visible browser across several calls:

```js
return await recording.start({name: 'Browser walkthrough', maxSeconds: 60});
```

Interact normally in subsequent calls, then finish with:

```js
return await recording.stop();
```

The result is a downloadable H.264 MP4 without audio. Recording includes the
whole visible Chromium window and continues during human takeover. A visible
recording indicator opens **More options → Files**, where the owner can stop it.
The gallery previews screenshots, plays videos with native controls, and offers
download and confirmed deletion. Opening a screenshot shows its full size.

The gallery also stores browser downloads and human uploads, up to 20 MiB each.
Use **Upload file** to supply a document to an agent. It is stored locally until
the agent attaches it as part of the requested task:

```js
return await files.download(page, async () => {
  await page.getByRole('link', {name:'Download report'}).click();
});
```

```js
const upload = (await files.list()).files.find(file => file.kind === 'upload');
if (!upload) throw new Error('Upload the requested document in Files first.');
return await files.uploadTo(page.locator('input[type=file]'), {id:upload.id});
```

Generic files are served as authenticated attachments, never active inline
content. Uploads and downloads share the gallery quota and confirmed deletion.
`files.list()` returns saved metadata and recording status; `recording.status()`
returns the active recording, if any.

Files persist privately in `/data/artifacts`. Preview and download URLs require
a dashboard session or an API key; links are not public. Saved files have a 1 GiB
combined quota, screenshots are limited to 8 MiB, and a recording is limited to
256 MiB. Recordings default to 60 seconds, allow at most 300 seconds, and save
automatically at the duration limit. The dashboard can delete saved files to
free space. Only one recording runs at a time.

Each execution accepts up to 32,768 characters of code and returns up to 32 KiB of JSON plus
two PNG/JPEG images totaling at most 6 MiB. Save larger screenshots and download
them instead of emitting them inline. Execution has a 120-second gateway deadline;
an unknown completion blocks further browser input until restart.

Code mode runs trusted JavaScript on the server through Playwright's unsafe
execution facility. It is not a JavaScript sandbox. Give API keys only to agents
you trust with this container and its signed-in browser session.

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

## Runtime design

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

Each API key grants powerful access to the browser and its authenticated accounts. Use trusted agents. This application is not a sandbox for hostile MCP clients. The control lease coordinates tool calls, but it cannot stop JavaScript that a page or a previous tool deliberately scheduled to run later. Clipboard input passes through the remote desktop; hardware security keys and local passkeys are not forwarded automatically.

## Development

Application code lives in `src/` (gateway, MCP adapter and browser services), `ui/` (dashboard), and `scripts/runtime.ts` (container supervisor). These are TypeScript modules. The application uses strict TypeScript checking; the synthetic integration fixture has a separate compiler configuration for its dynamic protocol probes. Unit fixtures run through `tsx` with Node's test runner.

Effect 4 manages business workflows, typed domain failures, service dependencies, concurrency and resource lifetimes. `src/services.ts` provides gateway dependencies through `Context.Service` and `Layer`. `src/effects.ts` contains the native I/O adapters, the Promise boundary, scoped file handles, and serialized mutation permits. Account and key records are decoded with Effect Schema. Native HTTP/WebSocket streams, Playwright callbacks, subprocess events and DOM events remain integration boundaries; do not move browser operations into a visited page or release control merely because a client disconnected.

Run `npm run typecheck`, `npm test`, and `npm run build` before starting the gateway with `npm start`. Build output belongs in `dist/` and should not be edited. The multi-stage Docker build checks and compiles TypeScript, then copies only compiled code and static assets into the runtime image. The runtime has no TypeScript compiler or Python supervisor.

The Node supervisor drops privileges before acquiring a kernel `flock` on the profile volume. Its Effect finalizer closes recordings while Chromium and X remain alive, then asks Chromium to flush the persistent profile before terminating the remaining process groups.

## Docker Hub releases

The GitHub Actions workflow in `.github/workflows/docker-publish.yml` publishes `syntropika/remote-browser` to Docker Hub whenever a Git tag is pushed to GitHub. The workflow must be present in the tagged commit.

Configure the repository's Actions secret `DOCKER_TOKEN` with a Docker Hub access token for `syntropika` that has write access to `syntropika/remote-browser`. The token is used only by the registry login step; it is not passed to the Docker build.

The workflow installs the locked dependencies, checks TypeScript and runs the unit and gateway tests before building and publishing the production Dockerfile. The Dockerfile also checks and compiles TypeScript. Published images target `linux/amd64`. BuildKit uses the GitHub Actions cache, and published images carry source and revision labels.

Each image uses the Git tag, including a leading `v`. For example, pushing `v1.0.0` publishes `syntropika/remote-browser:v1.0.0`. Docker Metadata sanitizes characters that Docker tags do not allow. No `latest` or version aliases are published, so prereleases and older releases do not change a shared release tag.

Once the workflow is committed and pushed to the repository, publish a release with:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Pull the published image with:

```sh
docker pull syntropika/remote-browser:v1.0.0
```

Publishing an image does not automatically update a running container.

## Verification

Unit and gateway tests run on Node 24:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

The container integration test exercises a local fixture, real MCP, first-time account creation, password login, server-enforced observation, human typing, agent handoff, API key creation/authentication/revocation, native Playwright/CDP code mode, screenshot output, gallery preview/download/delete, MP4 recording, and persistent account/browser/key/file storage. It uses synthetic credentials only. Run it on a dedicated test deployment; it creates a test account and navigates the browser. It refuses to replace an existing user account:

```sh
docker compose exec --user node -T browser npm run test:integration
```

Container replacement must also be checked when changing the runtime or profile setup. The integration script has `seed` and `verify` phases for that purpose; see its command-line help.

```sh
docker compose exec --user node -T browser npm run test:integration -- seed
docker compose up -d --force-recreate --wait
docker compose exec --user node -T browser npm run test:integration -- verify
```

If a browser operation loses its upstream response, the gateway cannot prove that it stopped. It blocks subsequent automation and human input until the container is restarted. The dashboard displays this condition rather than silently granting control.

```sh
docker compose logs --tail=100 browser
docker compose restart browser
```

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull request guidance, and [SECURITY.md](SECURITY.md) for private vulnerability reporting. Remote Browser is licensed under [Apache-2.0](LICENSE). Third-party components retain their own licenses; see [NOTICE](NOTICE) and [container dependency attribution](docker/THIRD_PARTY.md).

## Upstream components

- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [noVNC](https://github.com/novnc/noVNC)
- [Chromium](https://www.chromium.org/)
- [Playwright Docker guidance](https://playwright.dev/docs/docker)

The npm dependencies are pinned in `package-lock.json`. Debian security packages are refreshed by the uncached update build above. The seccomp policy provenance and upstream license are in `docker/`.
