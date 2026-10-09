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
chooses an available loopback port. Open the dashboard URL printed on standard
error, including its token fragment. Keep stdin open for MCP; EOF or SIGTERM closes
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
random bearer token, rejects foreign browser origins, and limits request bodies.
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
  "task":"check invoices", "ttlMs":300000
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

Different embedded tabs accept concurrent calls. A slow navigation on one tab does
not hold the host's operation lock for another. Calls targeting one busy tab fail
and should be retried after the current action finishes. Tabs still share Servo
resources and website state; this does not promise independent CPU execution or
atomic operations across tabs.

Agent targeting does not change the dashboard's selected tab. Users can watch a
reserved tab, but the engine rejects their navigation, keyboard, pointer, scroll,
and close actions on it. **Take control** waits for an in-flight operation to finish,
invalidates its reservation and element references, and blocks agents on that tab.
**Return to agents** makes it available for a new reservation. Other tabs remain
usable. Human handoff is a host operation, not an MCP tool. Leases coordinate
trusted clients sharing one host; they are not authenticated agent identities.

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
It supports basic clicking, typing, paste, named keys, and scrolling. Downloads,
file uploads, popup windows, browser permission prompts, clipboard integration,
IME composition, full-page captures, and asynchronous evaluation are not supported.

Transport cancellation, engine timeouts, crashes, and incomplete responses leave
completion uncertain. Affected tabs block further actions; connection failures
block the whole profile. Restart after inspecting the outcome. Mutations are not
automatically retried. A definitive element error allows fresh observation and
recovery. `--timeout-seconds` defaults to 15; engine actions have a 12-second
limit. Choosing a shorter transport deadline can leave actions uncertain sooner.

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
python3 ../tests/unified_smoke.py --engine-binary target/debug/remote-browser-servo-engine
```

Real-engine tests exercise native input, rendered PNGs, independent tab references,
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
