# Native browser host

A Rust host with an embedded dashboard and a separate Chromium engine executable. Each
profile runs in its own engine process with off-screen tab surfaces, persistent cookies
and storage. Optional bundled native extensions provide MCP automation and browser login.
CEF runtime files are prepared beside the engine executable.

There is a native Rust API and an MCP adapter. The engine uses Chromiumoxide's Rust
transport and CDP types through an ephemeral loopback DevTools endpoint. A private
adapter binds each engine-owned tab to its actual target and one stable session;
opening or closing another tab does not rebuild existing sessions. CEF's embedder
interface supplies target identity without injecting markers into pages. Browser
lifecycle, native input, leases and human takeover remain owned by the engine.
The adapter does not use Chromiumoxide's browser launcher, target rediscovery or
tab creation. No additional browser process or JavaScript runtime is required.

## Build and run

Use Rust 1.88 or newer and Bun 1.3 or newer. From the repository root,
prepare the pinned extension-enabled Linux x86-64 CEF runtime and build the engine:

```sh
bun install
bun run build
bun run build:engine --release
```

The build command downloads the already compiled 293 MB runtime, verifies its checksum,
and caches it outside the checkout. Cargo copies runtime files beside the executable
and uses an `$ORIGIN` run path. See the root README for cache configuration and platform
requirements. Other platforms require an explicit compatible `CEF_PATH`.

The host and the engine are separate executables. Build the host and give it a catalog
naming the engine it should start:

```sh
cargo build --release --manifest-path src/host/Cargo.toml
```

```json
{
  "defaultProfileId": "work",
  "engineBinary": "/path/to/remote-browser-cef-engine",
  "profiles": [
    { "id": "work", "name": "Work", "dataDirectory": "/path/to/private-browser-data/work" }
  ]
}
```

```sh
./remote-browser-native --profiles-config /path/to/profiles.json --dashboard-port 0
```

`--dashboard-port 0` chooses an available loopback port, printed on standard error.
A fresh dashboard has no login and runs independently of stdin until SIGTERM or Ctrl-C.
It rejects foreign browser origins; local programs may use its API without credentials
unless the Access extension is enabled. Native-extension and key-management mutations
always require the exact dashboard Origin.

Install **MCP** and **Access** independently from **Settings → Extensions**. Their Settings
sections appear only while installed. MCP contains agent connection settings and API keys;
Access adds a username/password login for people opening the dashboard. Both are bundled
with the host and install without a download. Chrome extensions remain scoped to the
selected browser profile, while these native modules apply to the whole host instance.

With `--mcp-stdio`, the dashboard shares the stdio client's lifetime: EOF or SIGTERM
closes the engines and saves persistent data. Without a dashboard, stdio MCP is the default.

An MCP client configuration can launch the host directly:

```json
{
  "mcpServers": {
    "native-browser": {
      "command": "/path/to/remote-browser-native",
      "args": ["--profiles-config", "/path/to/profiles.json", "--dashboard-port", "0", "--mcp-stdio"]
    }
  }
}
```

Standard output carries MCP messages only. The host speaks a private stdio protocol to
each engine process. The dashboard listens on
loopback, rejects foreign browser origins, and limits request bodies. It is not a public hosting interface. Catalog
files are written atomically with mode `0600`, and profile directories use mode `0700` on
Unix. Catalog and engine locks prevent simultaneous writers. Profile data contains
authentication material; protect it like browser user data.

## Profiles and tabs

Choose or create a profile in the dashboard, then sign in through its rendered
page. Cookies and website storage belong to that profile. Tabs within one profile
share its accounts; use separate profiles for three different accounts on the
same service. Persistent cookies and local storage survive a graceful restart.
Session cookies follow the engine's lifecycle; not every website login will survive a
restart. Password vault storage and credential autofill are not implemented.
The catalog persists names and session-check policies, not open tabs or task leases.

Agents discover permitted profiles with `browser_profiles({"action":"list"})`.
Creating a profile requires owner/stdio access. Choose the account with `profileId`
when listing tabs or reserving one; omission selects the configured default.

Reserve a tab for each task. Omit `tabId` to create and reserve one atomically,
or pass an existing tab ID from the selected profile:

```json
{
  "action":"reserve", "profileId":"<profile-id>",
  "agentName":"invoice-agent", "task":"check invoices"
}
```

The response includes `leaseId`, `tabId` and `profileId`. Treat the lease token as
opaque. Every subsequent page tool requires only `leaseId`; the server resolves
its profile and tab and verifies the acquiring client. For `browser_navigate`:

```json
{"leaseId":"<lease-id>", "url":"https://example.com"}
```

This applies to observations as well as mutations, including snapshots, screenshots,
console/network diagnostics, uploads and code mode. Page tools reject `tabId`,
`profileId` and `agentName` overrides. A token cannot be redirected to another tab.
Listing profiles/tabs and profile-level file management do not require a tab lease.

Reservations have no automatic expiry or renewal. They end when the acquiring client
releases or closes the tab, the user takes control, or the engine exits. Listings show
agent and task labels, never tokens. Agents may share an API key but use independent
tokens; names do not authenticate them. A copied token does not authorize a different
API key. The catalog supports at most 32 profiles. Tab listings bound titles and URLs
to 1024 Unicode characters each.

Use `browser_tabs({action:"release",leaseId})` to preserve the tab and release ownership.
Use `action:"close"` with the same token to close it; the last tab cannot be closed.
Both operations permanently invalidate the token. Open tabs and reservations are not
restored after engine restart.

Different embedded tabs accept concurrent calls. A slow navigation on one tab does
not hold the host's operation lock for another. Calls targeting one busy tab fail
and should be retried after the current action finishes. Tabs still share engine
resources and website state; this does not promise independent CPU execution or
atomic operations across tabs.

Agent actions preserve the dashboard's selected tab unless `browser_tabs` action
`select` is requested. A user can watch a reserved tab; interacting requires **Take
control**. Takeover waits for an in-flight native operation to finish, revokes its lease,
invalidates element references and blocks further agent calls, including observations.
**Return to agents** permits a fresh reservation; it does not reactivate old tokens.
Other tabs remain usable. MCP does not automatically reclaim a user-owned tab.

## Session health

The dashboard's **Session check** dialog saves a policy for the selected profile
and service origin. Configure authentication-cookie names and visible selectors
that identify a signed-in page or a login form. The dashboard checks the selected
page periodically. The agent can call `browser_session_health` with `leaseId`
and an explicit `policy`:

```json
{
  "origin":"https://example.com",
  "cookieNames":["session"],
  "authenticatedSelector":"[data-account-menu]",
  "loginSelector":"form[data-sign-in]",
  "warningSeconds":86400
}
```

States are `active`, `expiring`, `reauthRequired`, and `unknown`. Visible service
markers provide authentication evidence; configured cookie dates estimate credential
expiry. Cookie dates cannot guarantee server-side session validity or predict
revocation. Cookies without expiry have no known deadline. Conflicting markers
produce `unknown`. HTTP-only cookies contribute metadata, but cookie values are
never included in health responses. These checks do not inspect password expiry,
refresh-token validity, or credentials held outside the browser.

## Automation tools and limitations

The MCP catalog contains 29 tools:

| Tools | Purpose |
| --- | --- |
| `browser_profiles`, `browser_tabs`, `browser_status` | Discovery, reservation lifecycle and transport health |
| `browser_navigate`, `browser_navigate_back`, `browser_reload` | Native navigation and history |
| `browser_snapshot`, `browser_find` | Bounded main-document observations and literal-text snippets |
| `browser_click`, `browser_type`, `browser_press_key`, `browser_scroll` | Native pointer, editing, keyboard and wheel input |
| `browser_fill_form`, `browser_select_option` | Multiple text fields and enabled select values |
| `browser_hover`, `browser_drag` | Native pointer movement and drag gestures |
| `browser_wait_for`, `browser_handle_dialog` | Text conditions and JavaScript alert/confirm/prompt handling |
| `browser_evaluate`, `browser_run_code` | Page JavaScript and embedded orchestration |
| `browser_take_screenshot` | Viewport or bounded full-page PNG as an MCP image |
| `browser_console_messages`, `browser_network_requests`, `browser_diagnostics` | Bounded website diagnostics |
| `browser_files`, `browser_upload`, `browser_download` | Managed files and native inputs/downloads |
| `browser_session_health`, `browser_control` | Authentication evidence, clipboard and saved captures/media |

Every page tool requires `leaseId`. Element tools take `target`: a fresh snapshot
reference, a unique CSS selector, or an exact `{role,name}` locator in the main document.
Navigation, a new snapshot, evaluation and ownership changes invalidate references for
that tab. Other tabs keep their references. Detached targets fail instead of targeting
replacement elements. Clicks check visibility, enabled state, coverage and a short
stability interval; they do not provide all Playwright actionability/retry guarantees.
Input values are omitted from snapshots; page text and images may still contain sensitive
data. Treat website output as untrusted data.

`browser_type` replaces text; `submit:true` presses Enter and `slowly:true` sends
individual key events. `browser_fill_form` fills up to 32 `{target,value}` text fields
sequentially. `browser_select_option` takes `values` and emits input/change events.
`browser_wait_for` accepts `text`, `textGone`, and `timeoutMs` (1–30000, default
5000). Every poll rechecks the lease without creating a new snapshot. Wait failure does
not release the tab or replay the preceding action.

`browser_evaluate` accepts a JavaScript `function` string, for example
`"() => document.title"`, optionally returning a promise. Function and JSON result are
limited to 32 KiB. `browser_take_screenshot` accepts `fullPage:true` for at most 32
million pixels, with neither side above 16384 pixels.

### Embedded code mode

`browser_run_code` accepts `leaseId`, `code` and optional `timeoutMs`:

```json
{
  "leaseId":"<lease-id>",
  "code":"await page.goto('https://example.com'); await page.getByRole('textbox', {name:'Search'}).fill('Laptop'); await page.locator('#search').press('Enter'); await page.waitForText('Results'); return await page.snapshot();"
}
```

QuickJS is compiled into the Rust host. Runtime operation needs no Node or Bun process.
The injected `page` exposes `goto`, `goBack`, `reload`, `snapshot`, `find`,
`locator`, `getByRole`, `click`, `fill`, `fillForm`, `selectOption`, `hover`,
`drag`, `press`, `scroll(x,y)`, `waitForText`, `waitFor`, `handleDialog`,
`evaluate`, `screenshot`, `consoleMessages`, `networkRequests`, `upload` and
`download`. Locators support `click`, `fill`, `type`, `press`, `hover` and
`selectOption`. These helpers are authored in TypeScript and bundled with
`bun run build:code-mode`; the generated JavaScript is checked in for standalone Cargo builds.

Code supports async/await, functions, loops and conditions. Each page operation invokes
exactly the same typed implementation as its individual MCP counterpart and rechecks the
client and reservation. The code context exposes no OS, filesystem, process, module loader
or direct network bindings. Page evaluation still runs with the website's permissions.
This is a Playwright-style helper interface, not the Playwright JavaScript package.

Each invocation has a fresh context; local variables do not persist between calls, while
the lease and browser state do. Limits are 64 KiB of code, 64 MiB of JavaScript heap,
1 MiB stack, 100 page operations, four concurrent code calls, a 1–60 second deadline
(default 30 seconds), and a 32 KiB JSON result. Return a JSON-compatible value. Code-mode
screenshots return base64; use the individual screenshot tool for MCP image output.
Operations execute sequentially within a call. Earlier operations are not rolled back
when a later step fails. Cancellation of a pending native mutation preserves the existing
unknown-completion guard. User takeover revokes future steps even if code catches errors.

`browser_diagnostics` accepts `kind: "console" | "network"`, an optional `after`
sequence cursor, and `limit` from 1 to 100 (default 50). Use the returned `next`
cursor for another page. Each tab retains 128 combined events; `truncated` reports
evicted history and `latest` reports the most recent sequence. Console text and
network metadata are bounded; network headers, cookies and response bodies are
omitted. These are website diagnostics, separate from the redacted host operation
logs below. Reading them does not change ownership or repeat a request. History
is in memory and is discarded when its tab or engine closes.

Snapshots cover the main document with basic HTML and ARIA labels; they are not a
complete accessibility tree and do not traverse iframe or shadow-root contents.
The React dashboard paints engine frames onto a canvas and resizes the engine surface to
match the available display. It sends CSS viewport dimensions, screen dimensions, pixel
density, and whether the primary input is touch without hover. Each tab keeps independent
metrics; a new tab initially inherits the selected tab's size. Mobile mode enables Chromium's
mobile viewport and touch capabilities. User agents and client hints remain native to the
profile across display changes. Sites choosing variants exclusively from the user agent
may therefore retain their desktop variant.

One dashboard screen controls each tab's size and input. Other screens show the same image,
scaled without cropping, until the person chooses **Ask for control**. Taking control also
revokes any agent reservation. Viewing an agent's tab cannot resize it or release its lease.
Hidden screens stop requesting frames and retain their controller identity; leaving the tab
or closing the dashboard releases display control. Abandoned visible viewers expire after
15 seconds, independently of agent reservations, which never expire automatically.
The internal dashboard action API attaches a per-page `displayId` to human operations.
The `display` action reports presence (`visible`) or departure (`leave`); once a controller
exists, other display IDs and anonymous human mutations are refused until explicit takeover.

Live rendering caps density at two and targets at most two million backing pixels, with
a minimum density of one. Explicit native metrics remain bounded by a factor of four and
32 million pixels. Viewers requesting the same painted rectangle share its PNG encoding.
Frame metadata separates backing pixels from CSS coordinates so input still lands correctly
on high-density displays. The engine disables the
`AutomationControlled` Blink feature by default while retaining its private CDP connection.
Frame sequence numbers allow unchanged replies and partial
PNG updates. Mouse, keyboard, wheel and touch input use the host action API. Touch devices
have a page keyboard field. The dashboard opens onto its page unless the optional Access
extension requires sign-in.
Mouse and pen input uses an ordered action queue, and leaving the display ends hover.
Moves queued behind a slower action collapse into the latest position. Only the pointer
that started a press can move or release it until that gesture ends. When the dashboard can no
longer observe the release (lost pointer capture, pointer cancellation, window blur or a
hidden page), it sends the `cancel` input kind instead of a release. The engine forwards
CEF's capture-loss notification, but full mouse cancellation remains incomplete:
`pointercancel`, `lostpointercapture` and button-state cleanup are not guaranteed, including
when an agent reserves a tab during a human press. Touch keeps tap and swipe handling.
Agent clicks use native pointer movement and a single press/release. The `human-pointer-smoke.ts`
regression checks the engine input. `dashboard-pointer-smoke.ts` drives the current React
dashboard with a Chrome or Chromium executable passed as `--chrome`, using accessible
display readiness and the canvas's actual surface dimensions.
It supports basic clicking, typing, paste, named keys, scrolling, and explicit
downloads and uploads through the managed file workspace, automatic download capture,
profile clipboard integration, PNG capture and MP4 recording. Popup windows, browser
permission prompts and IME composition are not supported.

Transport cancellation, engine timeouts, crashes, and incomplete responses leave
completion uncertain. Affected tabs block further actions; connection failures
block the whole profile. Restart after inspecting the outcome. Mutations are not
automatically retried. A definitive element error allows fresh observation and
recovery. `--timeout-seconds` defaults to 15; engine actions have a 12-second
limit and individual CDP requests have a 10-second deadline. Choosing a shorter
transport deadline can leave actions uncertain sooner.
A tab timeout can require recovery while the engine process and other tabs remain
usable; it does not by itself mean the MCP server crashed.
The stdio reader rejects frames over 8 MiB while reading, including frames with
no newline, rather than first allocating an unbounded response.

## Diagnostic logs

Diagnostics use versioned JSON Lines on standard error. Standard output remains
reserved for MCP or native IPC. Set `--log-level debug` or `REMOTE_BROWSER_LOG_LEVEL=debug`
to include observation operations; `info` is the default, with `warn` and `error`
available for quieter output. The configured level propagates to engine workers.

Each operation records a start, completion, monotonic elapsed milliseconds, and a
fixed outcome category. The normal level includes navigation and ownership changes,
lifecycle events, failures, and operations taking at least one second. Frequent
listings, evaluation, screenshots, and input appear at `debug`. Fault events
distinguish engine deadlines, transport deadlines, cancelled requests, closed script
channels, crashed tabs, invalid replies, and oversized responses.

One `traceId` follows a request through MCP or the dashboard, native transport, and
the engine. MCP results expose it in `_meta.traceId`; dashboard responses include
`X-Request-Id`, including validation and authorization failures. Native request IDs
identify the matching worker operation. UTC timestamps, process IDs, worker startup
events, and opaque profile/tab keys let a collector group concurrent operations.
Keys are diagnostic hashes, not credentials or authenticated agent identities.

Records contain fixed operation/error names, never raw errors, page URLs or titles,
JavaScript, typed text, request arguments, cookies, profile names, or lease tokens.
The initial dashboard access URL is a private startup message, not a diagnostic
record; a supervisor should intercept it separately rather than retain it in logs.
Treat any unrelated upstream stderr output as untrusted rather than forwarding it
into a diagnostic archive.

A bounded queue decouples log writes from browser operations. When the sink is
blocked, logs can be dropped instead of blocking automation; the next drained
record reports `droppedEvents`. Shutdown makes a bounded attempt to flush. Use a
supervisor to collect stderr into protected files with bounded rotation or a system
journal. For a collected JSONL file, filter a reported trace without loading page data:

```sh
jq --arg trace 'your-trace-id' 'select(.traceId == $trace)' /path/to/private/browser.jsonl
```

The public Rust `Automation` interface starts an engine with `embedded(binary, directory,
timeout)`. Cloned handles retain per-tab targeting. `Profiles` manages discovery and lazy process startup;
`human_action` is the host's restricted input interface. MCP is an adapter over
these APIs, not another browser session.

## Verification

From the repository root, verify the host:

```sh
cargo fmt --manifest-path src/host/Cargo.toml -- --check
cargo test --manifest-path src/host/Cargo.toml
cargo clippy --manifest-path src/host/Cargo.toml --all-targets -- -D warnings
```

From `src/engine`, verify the engine:

```sh
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
cargo build
```

The integration suites are TypeScript programs executed by Bun. Supply both binaries
explicitly so host and engine arguments cannot be confused:

```sh
bun run test:integration \
  --host-binary src/host/target/release/remote-browser-native \
  --engine-binary src/engine/target/release/remote-browser-cef-engine
```

Use `--suite native-extensions,shutdown` to select suites, or `--list` to see them.
`REMOTE_BROWSER_HOST_BINARY` and `REMOTE_BROWSER_ENGINE_BINARY` provide defaults.
Every suite runs sequentially with disposable profiles and bounded waits. The runner
reports all failures and exits nonzero if any selected suite fails; missing binaries or
required capabilities are errors. GPU and media suites require the matching
runtime capabilities; media tests also require FFmpeg and ffprobe.
Direct-engine synthetic fixtures explicitly select ANGLE/SwiftShader and opt into software
WebGL so graphics and frame input do not depend on a desktop GPU. These flags apply only to
the disposable test processes; production launch settings are unchanged. Pointer fixtures
wait for their posted event traces before checking event order and coordinates. The logging
suite uses a real FIFO to exercise stderr backpressure without Bun buffering it in memory.

Real Chrome Web Store installation is opt-in with `--real-store`; add `--verify-expiry`
to check the three-minute permission timeout. `--protocol-only --suite extension-install`
checks only IPC guards and explicitly reports that no installation was tested.
`--chrome /path/to/chrome` adds the dashboard-pointer suite against the built React UI
using a private DevTools pipe.

Individual suites also run directly:

```sh
bun run src/host/tests/native-extensions-smoke.ts \
  --host-binary /path/to/remote-browser-native \
  --engine-binary /path/to/remote-browser-cef-engine
```

They cover lease-only routing, embedded code loops and limits, native input, frames, tab concurrency and references, reservations, takeover,
profile isolation, persistent cookies/catalog/policies, files, logs, optional modules and
extension state. These assertions verify this host/runtime, not arbitrary website compatibility.

## Local downloads and uploads

Each embedded profile has a private file workspace with flat `downloads` and
`uploads` folders. The default is `<profile-data-directory>/files`. Set
`--files-root /path/to/browser-files` (or `REMOTE_BROWSER_FILES_ROOT`) to put workspaces at
`<files-root>/<profile-id>` instead; a profiles catalog can also set `filesRoot`.
The folders belong to the machine running the engine, including when you view the
dashboard remotely. Files persist across restart. Unix folders use mode `0700`
and files created by the application use `0600`.

Open **More options → Files** to add files from your device, see their sizes, save
copies to your device, or delete them with confirmation. Opening a native page
file chooser presents this same list; select files and choose **Use selected
files**, or close to cancel. Reserved tabs require human takeover first.
The local path is shown so a local agent can also copy regular files directly into
these folders. The managed APIs accept file IDs such as `uploads/invoice.pdf`,
never arbitrary paths, directories, or symbolic links.

MCP exposes three embedded-only tools:

- `browser_files`: `list`, `read`, `stage`, `delete`, `choose`, or `cancel`.
  `stage` accepts a plain `name`, a byte `offset`, and base64 `data` of up to
  32 KiB per call. Offset zero creates a new file without overwriting; later
  offsets must match its current size. `read` returns up to 32 KiB and the next
  byte offset. `delete` permanently removes a single file and reclaims its space.
- `browser_upload`: use `leaseId`, a file input `target`, and `fileIds` from the
  workspace listing. Selection uses the engine's native file input implementation and
  fires its normal input/change events. It does not submit the form.
- `browser_download`: use `leaseId`, `url`, and a plain `name` to save a response to
  `downloads`. The request runs in the target page with that profile's cookies;
  HTTP-only cookies are preserved without copying their values into the host.
  Relative HTTP(S) links and page blob URLs are supported. Browser CORS still
  applies to cross-origin fetches.

Uploads are limited to 16 files of 64 MiB each; each folder holds at most 200
managed files. Downloads are limited to 20 MiB with a nine-second fetch deadline.
Existing files are never overwritten. Interrupted staging may leave a partial
file, which can be listed and deleted or resumed from its byte offset. Deleting a
file selected for upload may prevent the site from reading it; finish the upload
before cleanup. Names, paths, URLs and contents are omitted from structured logs.
Download/upload/chooser operations honor the target tab's reservation and human
ownership; file management is scoped to the profile independently of tab leases.

Downloads are explicit through the tool or **Save a download link** in Files.
Automatic capture does not cover every download click,
`Content-Disposition` navigation, POST export, or popup download. Site-generated
links may require page-specific workflows. Workspaces are a managed API boundary,
not a filesystem sandbox against another process running as the same OS user.

Verify the feature with the actual embedded executable:

```sh
bun run src/host/tests/files-smoke.ts \
  --host-binary /path/to/remote-browser-native \
  --engine-binary /path/to/remote-browser-cef-engine
```

## Native extensions and browser login

A fresh dashboard starts with MCP and Access uninstalled and creates no API key registry.
On first startup, explicit MCP options (`--mcp-stdio`, `--mcp-http-port`, or a seed token)
and an existing API key registry install MCP for compatibility. Later startups preserve
its installed/enabled state even when those arguments remain present. Disabling or
uninstalling MCP rejects HTTP requests with 503 and blocks stdio tool operations. An
accepted operation may finish; browser tabs remain usable.

The private `native-extensions.json` and `access-extension.json` records live beside the
profile catalog. Writes are atomic, files use mode `0600`, and malformed records prevent
startup rather than silently disabling login. Uninstalling retains configuration and key
revocations for reinstall. Access reinstalls disabled and requires explicit enablement.

Install Access, then set a username and a password of at least 12 characters in
**Settings → Access**. Saving enables login and signs out other browser sessions.
Passwords are stored as salted Argon2id hashes. Login creates a random HttpOnly,
SameSite=Strict cookie valid for at most 12 hours. Sign out revokes it; process restart
requires another login while retaining the account, website sessions and files. Sessions
are bounded to 128; five failed logins trigger a one-minute cooldown. Access protects
dashboard APIs only. MCP uses its own API keys and never accepts browser cookies.
The listener remains loopback HTTP; this is not a public hosting interface.

Native module management endpoints:

| Endpoint | Contract |
| --- | --- |
| `GET /api/extensions/native` | List bundled modules and their installed/enabled state |
| `POST /api/extensions/native` | `{id, action}`; IDs `mcp`/`access`, actions `install`/`enable`/`disable`/`uninstall`; uninstall also requires `confirmed: true` |
| `POST /api/extensions/access/configure` | `{username, password}`; Access must be installed; enables login and issues a session |
| `GET /api/access/status` | Whether login is required and this cookie is authenticated |
| `POST /api/access/login` | `{username, password}`; issues a browser session |
| `POST /api/access/logout` | Revokes this browser session |

Login status and login are public; other dashboard APIs require a valid Access session
when login is enabled. Mutations above require the exact dashboard Origin. Module
uninstallation removes its Settings section, without deleting profile data.

## Shared HTTP MCP adapter and API keys

After installing MCP, **Settings → MCP** provides the endpoint, named key creation,
one-time secret display/copy, session permissions, usage dates and confirmed revocation.
Leaving Settings clears the displayed secret. Run `bun run build` after UI changes to
regenerate the embedded dashboard assets before building Rust.

`/mcp` is served directly on the dashboard port. A separate loopback listener is optional:

```sh
./remote-browser-native --profiles-config /path/to/profiles.json \
  --dashboard-port 8081 --mcp-http-port 8083 \
  --mcp-http-token-file /path/to/private-mcp-bearer
```

Both listeners share profiles, keys, reservations and human takeover. A disabled module
can leave the listener bound, but rejects MCP operations. The optional seed file contains
a private 32–256 character bearer and creates an **Initial key** only when no registry
exists. Requests require `Authorization: Bearer <value>`, validate Host and Origin, and
have a 64 KiB body limit. Browser login cookies do not authorize MCP.

Key management requires an Access session when browser login is enabled, and always
requires the exact Origin for mutations. Automation bearers cannot administer keys or
sign in. Keys contain 256 random bits; only SHA-256 hashes and display metadata are
stored in `api-keys.json` beside the catalog. Override the path with `--api-keys-file` or
`REMOTE_BROWSER_API_KEYS_FILE`. Compatible existing registries retain their named keys;
use one owner process per registry and keep a backup during migration.

Every HTTP MCP request revalidates its key. Revocation rejects subsequent requests;
a previously accepted operation may finish. Revoked seed keys are not reimported on
restart, malformed registries fail closed, and last-use writes occur at most once per
minute per key. Up to 100 active keys are supported. A seed token is unnecessary when
keys are managed through Settings.

Verify both independent modules against the actual engine:

```sh
bun run src/host/tests/native-extensions-smoke.ts \
  --host-binary /path/to/remote-browser-native \
  --engine-binary /path/to/remote-browser-cef-engine
```

The test checks a fresh browser without keys, installation, real authenticated automation,
login protection and cookies, independent disable/re-enable, persisted state across
restart, confirmed uninstall, and revocation retention after reinstall.

## Native workflow parity

The Access native extension provides optional browser login. The separate MCP extension
owns API keys and agent session permissions. Restricted agent keys cannot create profiles
or administer keys. Tab reservations are bound to the acquiring key; agents may share one
key and reserve with their own `agentName` and independent `leaseId`.

`browser_control` provides native back/forward, real reload, profile clipboard operations (8192 UTF-8 bytes), saved PNG captures and MP4 recording. Recordings require FFmpeg on the runtime host, omit audio and run for at most 300 seconds. Agent recordings stay on their reserved tab and stop when its lease is revoked; dashboard recordings follow the visible tab. Captures and recordings appear alongside downloads/uploads in Files, with preview, download and deletion controls. Managed files remain bounded to 64 MiB.

Attachment navigations, download links, blob/data links and POST attachment responses are captured automatically, up to 20 MiB. This restores targeted download workflows; it does not establish compatibility with every website.

Human takeover revokes the reservation and blocks both reads and actions through that token. Returning control permits a fresh reservation. MCP never automatically resumes a revoked lease or retries an operation with unknown completion.

`skills/remote-browser/SKILL.md` documents the individual MCP tools and their ownership, permission and file contracts.
