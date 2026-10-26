# Native browser host

A Rust host with an embedded dashboard and a separate Chromium engine executable. Each
profile runs in its own engine process with off-screen tab surfaces, persistent cookies
and storage. Optional bundled native extensions provide MCP automation and browser login.
It runs without Docker, Playwright or a separately installed browser.

There is a native Rust API and an MCP adapter. The engine reaches Chromium's DevTools
protocol in process, through the embedder interface, and opens no debugging port.

## Build and run

Use Rust 1.88 or newer, Bun 1.3, and Python 3.12 or newer. From the repository root,
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
each engine process; neither opens a WebDriver listener. The dashboard listens on
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

Agents discover profiles with `browser_profiles({"action":"list"})`. They can
create one with `{"action":"create","name":"Account two"}`. Pass `profileId`
on operations to choose the account; omission selects the configured default,
independently of the profile currently displayed to the user.

Open and reserve a tab for each task. For example, call `browser_tabs` with:

```json
{"action":"open","profileId":"<profile-id>"}
```

```json
{
  "action":"reserve", "profileId":"<profile-id>", "tabId":"<tab-id>",
  "agentName":"invoice-agent", "task":"check invoices", "ttlMs":300000
}
```

Pass the returned token to every operation on the reserved tab:

```json
{
  "profileId":"<profile-id>", "tabId":"<tab-id>",
  "leaseId":"<lease-id>", "url":"https://example.com"
}
```

The last object is for `browser_navigate`. Use `browser_tabs` actions `renew` and
`release` with the same profile, tab, and token. Leases last one second to five
minutes. Expired, released, and superseded tokens fail. Listings show task names
and expiry, never lease tokens. Only API-created tabs can be closed. There are at
most 32 profiles and 32 tabs per embedded profile.
Tab listings limit page titles to 4 KiB and URLs to 16 KiB on UTF-8 boundaries.
The full page URL remains inside the engine; only display metadata is shortened.
These limits keep all 32 rows below the transport budget even with JSON escaping.

Different embedded tabs accept concurrent calls. A slow navigation on one tab does
not hold the host's operation lock for another. Calls targeting one busy tab fail
and should be retried after the current action finishes. Tabs still share engine
resources and website state; this does not promise independent CPU execution or
atomic operations across tabs.

Agent targeting does not change the dashboard's selected tab. Users can watch a
reserved tab, but the engine rejects their navigation, keyboard, pointer, scroll,
and close actions on it. **Take control** waits for an in-flight operation to finish,
preserves its reservation, invalidates element references, and blocks agents on that tab.
**Return to agents** lets the original key continue with a valid lease. Other tabs remain
usable. The dashboard acknowledges cancellable five-second agent handoffs. Leases are
bound to the authenticated API key; agents sharing a key reserve with their own `agentName` and independent lease token.

## Session health

The dashboard's **Session check** dialog saves a policy for the selected profile
and service origin. Configure authentication-cookie names and visible selectors
that identify a signed-in page or a login form. The dashboard checks the selected
page periodically. The agent can call `browser_session_health` with `profileId`,
`tabId`, optional `leaseId`, and an explicit `policy`:

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

| Tool | Purpose |
| --- | --- |
| `browser_profiles` | List or create account profiles |
| `browser_status` | Read ownership and uncertain completion state |
| `browser_tabs` | List, open, select, close, reserve, renew, or release tabs |
| `browser_navigate` | Navigate to HTTP(S) or `about:blank` |
| `browser_snapshot` | Read bounded visible text and interactive element references |
| `browser_click` | Click a native referenced element |
| `browser_fill` | Clear a field and type through native input |
| `browser_press` | Send a supported named key to an element |
| `browser_scroll` | Scroll by CSS pixels |
| `browser_evaluate` | Execute synchronous JavaScript and return bounded JSON |
| `browser_screenshot` | Return a rendered viewport PNG as an MCP image |
| `browser_session_health` | Assess configured service evidence and cookie metadata |

Always pass an explicit `tabId`. Take a snapshot before using its `reference`
strings. Navigation, a new snapshot, evaluation, and ownership changes invalidate
references for the affected tab. Other tabs keep their own references. Native
stale-element errors prevent accidental interaction with replacement elements.
Input values are omitted from snapshots; page text and screenshots can still
contain sensitive information. Treat page content as untrusted data.

Snapshots cover the main document with basic HTML and ARIA labels; they are not a
complete accessibility tree and do not traverse iframe or shadow-root contents.
The dashboard displays a fixed 1024×768 viewport through periodic PNG captures.
Its shell reuses the existing Remote Browser dark stylesheet and rounded controls:
the page fits the available display, with a floating desktop dock and upward-opening
profile and tab panels. Mobile places navigation above the page and a native keyboard
input below it. Mobile zoom switches between fit and actual size; one-finger swipes
scroll the fitted page or pan the actual-size display, and two fingers scroll the
actual-size page. Session status and check settings are available in More options.
The dashboard opens onto its page unless the optional Access extension requires sign-in.
Mouse and pen input reaches the page as performed: pointer movement, hover, presses and
releases keep their order and timing, and leaving the display ends hover. Moves queued behind
a slower action collapse into the latest position. A press belongs to the pointer, tab and
profile that started it: its movement and release go there even if the selected tab or profile
changes meanwhile, and other pointers are ignored until it ends. When the dashboard can no
longer observe the release (lost pointer capture, pointer cancellation, window blur or a
hidden page), it sends the `cancel` input kind instead of a release. The engine then cancels
the press natively: the page receives `pointercancel` and `lostpointercapture` rather than
`pointerup`, `mouseup` and `click`, and its button, `:active` and capture state are cleared.
The engine also cancels a human press when an agent reserves the tab, because the human
release would then be rejected. Touch keeps tap and swipe handling. Agent clicks remain
single native clicks; no movement is synthesized for them. The `human_pointer_smoke.py` and
`pointer_cancel_smoke.py` regressions check the engine input. `dashboard_pointer_seam_smoke.py`
runs the dashboard's pointer handlers in Node, and `dashboard_pointer_smoke.py` drives the
dashboard with a Chrome or Chromium executable passed as `--chrome`.
It supports basic clicking, typing, paste, named keys, scrolling, and explicit
downloads and uploads through the managed file workspace, automatic download capture,
profile clipboard integration, PNG capture and MP4 recording. Popup windows, browser
permission prompts, IME composition, full-page captures and asynchronous evaluation
are not supported.

Transport cancellation, engine timeouts, crashes, and incomplete responses leave
completion uncertain. Affected tabs block further actions; connection failures
block the whole profile. Restart after inspecting the outcome. Mutations are not
automatically retried. A definitive element error allows fresh observation and
recovery. `--timeout-seconds` defaults to 15; engine actions have a 12-second
limit. Choosing a shorter transport deadline can leave actions uncertain sooner.
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

The real-engine suites under `src/host/tests` drive built executables and take their
paths. A suite that speaks the engine's protocol takes the engine:

```sh
python3 src/host/tests/embedded_smoke.py \
  --engine-binary src/engine/target/release/remote-browser-cef-engine
```

A suite that goes through MCP or the dashboard takes the host, and the host is told which
engine to run for its profile:

```sh
REMOTE_BROWSER_ENGINE_BINARY=src/engine/target/release/remote-browser-cef-engine \
  python3 src/host/tests/files_smoke.py \
  --engine-binary src/host/target/release/remote-browser-native
```

They cover native input, rendered frames, independent tab references, background
selection, concurrent actions, reservation enforcement, human takeover, profile isolation,
cookies and local storage across restart, MCP negotiation, dashboard authorization, and
persistent catalogs and policies. They verify this host and its engine, not compatibility
with any particular production website.

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
- `browser_upload`: use a fresh file input `reference` and `fileIds` from the
  workspace listing. Selection uses the engine's native file input implementation and
  fires its normal input/change events. It does not submit the form.
- `browser_download`: use `tabId`, `url`, and a plain `name` to save a response to
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
REMOTE_BROWSER_ENGINE_BINARY=/path/to/remote-browser-cef-engine \
  python3 src/host/tests/files_smoke.py --engine-binary /path/to/remote-browser-native
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
python3 src/host/tests/native_extensions_smoke.py \
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

`browser_control` provides native back/forward, real reload, profile clipboard operations (8192 UTF-8 bytes), saved PNG captures and MP4 recording. Recordings require FFmpeg on the runtime host, follow the profile's visible tab, omit audio and run for at most 300 seconds. Captures and recordings appear alongside downloads/uploads in Files, with preview, download and deletion controls. Managed files remain bounded to 64 MiB.

Attachment navigations, download links, blob/data links and POST attachment responses are captured automatically, up to 20 MiB. This restores targeted download workflows; it does not establish compatibility with every website.

Human takeover blocks agent actions while preserving the reservation. When the dashboard is connected, a rejected agent action can request an acknowledged five-second handoff that the user can cancel. A cancelled action remains unexecuted. Operations with unknown completion are never retried by this handoff mechanism.

No CDP or Playwright adapter is included. The updated `skills/remote-browser/SKILL.md` documents the individual native MCP tools and their ownership, permission and file contracts.

