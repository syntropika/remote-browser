# Experimental native Servo browser

A Rust executable with an embedded Servo 0.7.0 engine, stdio MCP automation,
persistent account profiles, and a local dashboard showing actual rendered pages.
It runs without Docker, Chromium, Playwright, or a separately downloaded Servo
browser. Each profile starts a child process of the same executable; each tab has
its own Servo `WebView` and software rendering surface. The existing Chromium
application remains available independently.

This is a working prototype, not a Chromium compatibility replacement. Its
integration tests use a local synthetic login website. Compatibility with X,
complex OAuth flows, passkeys, CAPTCHA, video, and particular production websites
has not been verified. Servo's web compatibility determines which sites work.
There is a native Rust API and an MCP adapter; CDP compatibility is not implemented.

The embedded build includes Servo's WebGL 1 implementation for canvas graphics.
The WebGL regression verifies native shader compilation, rendering and pixel readback.

## Build and run the embedded executable

Use Rust 1.88 or newer and the native build prerequisites for
[Servo 0.7.0](https://github.com/servo/servo/tree/v0.7.0). The first build downloads
Servo and its dependencies, including SpiderMonkey. Linux x86-64 has been tested;
other platforms have not been verified by this prototype. Software rendering still
requires the platform's graphics libraries. The dependency lock file preserves
upstream prerelease crypto dependency versions and should be retained.

Run Cargo from the engine directory so its compiler configuration is applied:

```sh
cd native/servo/engine
cargo build --locked
./target/debug/remote-browser-servo-engine \
  --profile-root /path/to/private-browser-data --dashboard-port 0
```

This single executable contains both the host and the engine worker. It creates a
default profile and saves the catalog under the chosen root. `--dashboard-port 0`
chooses an available loopback port. Open the dashboard origin to sign in with a username and password. On first run,
create the owner account. The private token fragment printed on standard error
remains available for trusted local integrations; it is not required for human login. Keep stdin open for MCP; EOF or SIGTERM closes
the engines and saves persistent data. The dashboard is tied to the MCP lifetime.
An MCP client configuration can launch it directly:

```json
{
  "mcpServers": {
    "servo-browser": {
      "command": "/path/to/remote-browser-servo-engine",
      "args": [
        "--profile-root", "/path/to/private-browser-data",
        "--dashboard-port", "0"
      ]
    }
  }
}
```

Standard output carries MCP messages only. The engine uses private stdio IPC;
it opens no WebDriver or CDP listener. The dashboard listens on loopback, requires a
an owner session cookie or private integration bearer, rejects foreign browser
origins, and limits request bodies.
It is not a public hosting interface. Catalog files are written atomically with
mode `0600`, and embedded profile directories use mode `0700` on Unix. Catalog and
engine locks prevent simultaneous writers. Profile data contains authentication
material; protect it like browser user data.

## Profiles and tabs

Choose or create a profile in the dashboard, then sign in through its rendered
page. Cookies and website storage belong to that profile. Tabs within one profile
share its accounts; use separate profiles for three different accounts on the
same service. Persistent cookies and local storage survive a graceful restart.
Session cookies follow Servo's lifecycle; not every website login will survive a
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
and should be retried after the current action finishes. Tabs still share Servo
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
The owner sign-in screen uses the same visual system and accepts username/password
authentication, including compatible owner records from the Chromium service.
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
reserved for MCP or native IPC. Set `--log-level debug` or `SERVO_LOG_LEVEL=debug`
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

The public Rust `Automation` interface supports `embedded(binary, directory,
timeout)` and `connect(webdriver_url, timeout)`. Cloned embedded handles retain
per-tab targeting. `Profiles` manages discovery and lazy process startup;
`human_action` is the host's restricted input interface. MCP is an adapter over
these APIs, not another browser session.

## External WebDriver backend

The smaller `native/servo` Cargo package can also automate an externally managed
Servo WebDriver process. Build it with:

```sh
cargo build --locked --manifest-path native/servo/Cargo.toml
```

**Servo 0.7.0 binds its unauthenticated WebDriver listener to `0.0.0.0`.** Restrict
inbound access with network isolation or a firewall before using account sessions.
A loopback URL in the client does not restrict that listener. See the
[upstream implementation](https://github.com/servo/servo/blob/v0.7.0/components/webdriver_server/lib.rs).
After isolation is prepared, start an external browser with a dedicated profile:

```sh
/path/to/servoshell --webdriver=7002 --config-dir=/path/to/profile about:blank
/path/to/remote-browser-servo --webdriver-url http://127.0.0.1:7002
```

WebDriver operations are serialized per profile and switch the visible window's
target. Its task reservations do not block direct native mouse or keyboard input.
The embedded dashboard's per-tab human gate requires the embedded backend.
The host deletes its WebDriver session on exit and leaves the external browser
running. `SERVO_WEBDRIVER_URL` can supply the endpoint.

For advanced setups, `--profiles-config /path/to/profiles.json` loads a catalog
with `defaultProfileId`, optional `engineBinary` and `dataRoot`, and `profiles`.
Each entry has `id`, `name`, `services`, and exactly one of `dataDirectory` or
`webdriverUrl`. Use absolute paths. Every embedded profile needs a distinct
directory; every external profile needs a distinct loopback port.

## Verification

From the repository root, verify the host library:

```sh
cargo fmt --manifest-path native/servo/Cargo.toml -- --check
cargo test --locked --manifest-path native/servo/Cargo.toml
cargo clippy --locked --manifest-path native/servo/Cargo.toml --all-targets -- -D warnings
```

From `native/servo/engine`, build and verify the embedded package:

```sh
cargo fmt -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
python3 ../tests/embedded_smoke.py --engine-binary target/debug/remote-browser-servo-engine
python3 ../tests/surface_smoke.py --engine-binary target/debug/remote-browser-servo-engine
python3 ../tests/webgl_smoke.py --engine-binary target/debug/remote-browser-servo-engine
python3 ../tests/worker_messages_smoke.py --engine-binary target/debug/remote-browser-servo-engine
python3 ../tests/pointer_events_smoke.py --engine-binary target/debug/remote-browser-servo-engine
python3 ../tests/unified_smoke.py --engine-binary target/debug/remote-browser-servo-engine
python3 ../tests/metadata_smoke.py --engine-binary target/debug/remote-browser-servo-engine
python3 ../tests/failure_smoke.py --engine-binary target/debug/remote-browser-servo-engine
python3 ../tests/logging_smoke.py --engine-binary target/debug/remote-browser-servo-engine
```

Real-engine tests exercise native input, rendered PNGs, WebGL shader rendering,
virtual screen geometry, live captures during frame loading, independent tab references,
background selection, concurrent actions, reservation enforcement, human takeover,
profile isolation, HTTP-only credential metadata, cookies and local storage across
restart, MCP negotiation, dashboard authorization, and persistent catalogs/policies.
`unified_smoke.py --hold-ui` pauses for manual dashboard inspection. The optional
external-backend smoke test is:

```sh
python3 native/servo/tests/smoke.py \
  --mcp-binary native/servo/target/debug/remote-browser-servo \
  --servo-binary /path/to/servoshell
```

It isolates Servo's listener for its disposable local fixture and also checks EOF
and SIGTERM cleanup. These fixtures verify the adapter, not production-site
compatibility.

## Local downloads and uploads

Each embedded profile has a private file workspace with flat `downloads` and
`uploads` folders. The default is `<profile-data-directory>/files`. Set
`--files-root /path/to/browser-files` (or `SERVO_FILES_ROOT`) to put workspaces at
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
  workspace listing. Selection uses Servo's native file input implementation and
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
This prototype does not automatically capture every download click,
`Content-Disposition` navigation, POST export, or popup download. Site-generated
links may require page-specific workflows. Workspaces are a managed API boundary,
not a filesystem sandbox against another process running as the same OS user.

Verify the feature with the actual embedded executable:

```sh
python3 native/servo/tests/files_smoke.py --engine-binary /path/to/remote-browser-servo-engine
```

## Dashboard owner account

The dashboard restores the original username/password flow independently of website
logins inside profiles. The first visit creates one owner account; later visits
sign in with that account. The default record is `dashboard-account.json` beside
the profiles catalog. Set `--dashboard-account /path/to/account.json` (or
`SERVO_DASHBOARD_ACCOUNT`) to use a different protected file. The schema is compatible
with the original application's version-1 scrypt record (N=32768, r=8, p=1,
64-byte hash), so an existing `account.json` can be reused without resetting the
password or exporting plaintext credentials. Keep the original file as a backup.

Passwords use scrypt with a random salt and are never stored as plaintext or
logged. Authentication creates an HttpOnly, SameSite=Strict session cookie lasting
at most eight hours. Sign out revokes it; restarting the process requires another
sign-in but preserves the account, profiles, website sessions and files. Sessions
are bounded to 32, authentication attempts to 30 per minute, and concurrent password
derivations to two. Use `--dashboard-secure-cookie` behind HTTPS. Cookie-authenticated
mutations and owner setup/login/logout require the expected Origin header. A reverse
proxy must preserve cookies and Set-Cookie responses while validating the external
origin before any origin rewrite. Forwarding authentication headers alone is insufficient.

The stdio MCP interface does not depend on a dashboard login. The private bearer
continues to support trusted integration clients; the human login form does not
ask for it. Username and password belong to the dashboard owner, not to a website
account or a particular browser profile.

```sh
python3 native/servo/tests/account_smoke.py --engine-binary /path/to/remote-browser-servo-engine
```

## Shared HTTP MCP adapter

To connect an MCP gateway to the same live profiles as the dashboard and stdio
client, enable the optional loopback Streamable HTTP listener:

```sh
./remote-browser-servo-engine --profile-root /path/to/private-browser-data \
  --dashboard-port 8081 --mcp-http-port 8083 \
  --mcp-http-token-file /path/to/private-mcp-bearer
```

An optional token file must contain a 32–256 character bearer and be private to its
owner on Unix. It seeds an **Initial key** only when no registry exists. HTTP requests require `Authorization: Bearer <value>`; dashboard login
cookies do not authorize MCP. The endpoint is `/mcp`, uses stateless JSON responses,
validates Host and Origin, and limits request bodies to 64 KiB. The service calls
the same automation handler and profile registry as stdio, so reservations and
human takeover are shared across both transports. Keep stdin open for the host
lifetime. A reverse proxy must forward Accept, authorization and MCP protocol
headers to the correct loopback listener and preserve response headers. Configure
its external origin/peer policy explicitly. Existing gateways can retain their
upstream bearer by putting that same secret in the protected token file on initial
setup, or by reusing a compatible registry that already contains its hash.


## API key management

Sign in with the owner account, then open **More options → API keys**. The restored
settings panel provides the MCP endpoint, named key creation, one-time secret
display and copy, creation and last-use dates, and confirmed revocation. Leaving
settings clears the displayed secret. The panel uses the same component and
stylesheet as the original dashboard; run `npm run build:servo-ui` after changing
that component to regenerate the committed JavaScript bundle before a Rust build.

The panel displays `/mcp` on the dashboard origin, assuming a reverse proxy that
exposes both listeners there. A direct separate-port launch must instead configure
the MCP client with the `--mcp-http-port` listener, such as `http://127.0.0.1:8083/mcp`
in the example above. The dashboard listener does not proxy MCP itself.

Only the owner session cookie can list, create or revoke keys. Automation bearers
cannot manage keys or sign in. Mutations require the exact dashboard Origin. New
keys have 256 random bits; only SHA-256 hashes and display metadata are stored in
the private version-1 `api-keys.json` registry beside the owner account. Configure
`--api-keys-file` or `SERVO_API_KEYS_FILE` to change this path. The schema accepts
the original application's registry, so existing named keys can be retained. Use
one registry owner process and retain the original as a backup during migration.

Every HTTP MCP request checks the registry, including requests with an existing
MCP session. Revocation rejects subsequent requests immediately; an action already
accepted may finish. Other keys continue working. A revoked initial key is never
reimported on restart, and a malformed registry fails closed. Last-use metadata
writes are limited to once per minute per key; the displayed timestamp can lag
within that interval. Up to 100 active keys are supported. The HTTP listener does
not need a seed token when the owner manages keys through the dashboard.

```sh
python3 native/servo/tests/keys_smoke.py --engine-binary /path/to/remote-browser-servo-engine
```

## Native workflow parity

The dashboard retains username/password owner login and adds API key login. Key sessions use HttpOnly cookies and are revalidated on each request. The owner can assign all profiles (including future profiles) or a specific nonempty profile selection to each key, and edit that selection later. Existing keys retain all-profile access. Restricted keys cannot create profiles or administer keys. MCP and dashboard operations enforce the same profile permissions. Tab reservations are bound to the acquiring key; agents may share one key and reserve with their own `agentName` and independent `leaseId`.

`browser_control` provides native back/forward, real reload, profile clipboard operations (8192 UTF-8 bytes), saved PNG captures and MP4 recording. Recordings require FFmpeg on the runtime host, follow the profile's visible tab, omit audio and run for at most 300 seconds. Captures and recordings appear alongside downloads/uploads in Files, with preview, download and deletion controls. Managed files remain bounded to 64 MiB.

Attachment navigations, download links, blob/data links and POST attachment responses are captured automatically, up to 20 MiB. A pinned `servo-net` fork observes the original network response stream, preserving the original POST body and cookie handling without replay. The fork's provenance and limited changes are documented in `engine/vendor/README.md`. This restores targeted download workflows; it does not establish compatibility with every website.

Human takeover blocks agent actions while preserving the reservation. When the dashboard is connected, a rejected agent action can request an acknowledged five-second handoff that the user can cancel. A cancelled action remains unexecuted. Operations with unknown completion are never retried by this handoff mechanism.

No CDP or Playwright adapter is included. The updated `skills/remote-browser/SKILL.md` documents the individual native MCP tools and their ownership, permission and file contracts.
