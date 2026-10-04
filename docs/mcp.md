# MCP and agent automation

## Connect a client

The MCP endpoint is `http://localhost:8080/mcp`, using Streamable HTTP. Configure the client with:

- URL: `http://localhost:8080/mcp`
- HTTP header: `Authorization: Bearer <API_KEY>`

Sign in to the dashboard, open **More options → API keys**, and create a named key for each client. Copy the key immediately: its full value is shown only once and cleared when you leave settings. The page also provides your deployment's MCP URL, creation dates, last-use timestamps, and individual revocation. Key management does not require taking browser control.

Revocation rejects new requests and disconnects that key's active responses. An already-running browser action may finish; the control guard remains held until its result is known. Other keys keep working. API keys cannot sign in to the dashboard or manage keys.

New keys contain 256 random bits. Only SHA-256 hashes and display metadata are persisted in the private, mode-0600 `/data/api-keys.json` registry. On the first migration, the existing `/data/access-token` is imported as **Initial key** to preserve existing clients. It can be revoked like any other key. The runtime retains the old token file for compatibility, but it is not a fallback credential and is not imported again after a restart. Keep the registry when replacing containers or restoring backups.

Supply the key through the client's secret or environment-variable mechanism. Do not commit it in project configuration. The MCP client must support custom authorization headers. `GET`, `POST`, and `DELETE` MCP requests all require bearer authentication.

The Playwright server connects through CDP to Chromium's existing browser context. It does not create a separate login session for each agent. The gateway serializes browser operations; this is a single-user, single-profile service, not a pool of isolated agent sessions.

## Code mode

The public MCP catalog contains `browser_docs`, `browser_tabs`, and `browser_execute`.
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
at the start of each call unless an explicit `tabId` binds it to a specific tab without bringing that tab to the front. `context.pages()` lists tabs; `context.newPage()` opens
one, and `page.bringToFront()` selects one. Always await browser operations before
returning. Results contain compact JSON and any images explicitly emitted through
`image()`, without an automatic page snapshot or a copy of the submitted code.

The `browser` helpers provide compact accessibility observations (`snapshot`),
bounded rendered text (`read`), native element references (`ref`), stable tab IDs
(`tabs.list/get/use/open/close/reserve/renew/release`), and annotated viewport screenshots (`screenshot`).
Refresh observations after navigation; references to replaced elements fail
instead of selecting a new element. Helpers close only tabs they created.
Task labels support cleanup and do not isolate clients. Native Playwright and
CDP remain available for iframes and other advanced interactions.

## Coordinating agents across calls

Use `browser_tabs({action: "list"})` to discover stable IDs and reservation status,
including when the visible tab belongs to another task. Reserve a task tab:

```js
browser_tabs({action: "reserve", tabId: "TARGET_ID", task: "Research"})
// Returns {tabId, leaseId, task, ttlMs, expiresAt}.
```

Send both coordinates with every subsequent execution:

```js
browser_execute({
  tabId: "TARGET_ID",
  leaseId: "RESERVATION_TOKEN",
  code: "return await browser.snapshot();",
})
```

The native `page` binding and helpers without a `tabId` now target that tab, even
in the background. A missing or closed ID fails without switching to another tab.
A reserved tab rejects execution or helper access from another task, including a
task using the same API key without the reservation token. Tokens also require the
API key that acquired the reservation; listing tabs never discloses tokens.

Reservations last five minutes by default. Set `ttlMs` between 1000 and 300000
when reserving or renewing. Renew before expiry with
`browser_tabs({action: "renew", tabId, leaseId})`; release in task cleanup with
`browser_tabs({action: "release", tabId, leaseId})`. Code errors retain the lease.
Expired or released tokens fail and require a new reservation. Reservations span
MCP sessions but are cleared when the automation service restarts. Human control
still takes precedence and can change or close reserved tabs.

The same operations are available in code through `browser.tabs.reserve(id,
{task, ttlMs})`, `browser.tabs.renew(id, {ttlMs})`, and `browser.tabs.release(id)`.
Omit `id` for the bound page. `browser.tabs.get(id)` retrieves a native Page
without changing visibility; `browser.tabs.use(id)` intentionally brings it to the front.

The global operation guard remains in place: concurrent calls receive a busy
error and must retry. Reservations prevent interleaving on the same tab between
calls; they do not introduce parallel execution or an automatic waiting queue.
They coordinate trusted agents through the bound page and helpers. Native
Playwright/CDP can bypass them, and tabs still share cookies, storage, accounts,
and browser settings. A reservation is not a security boundary.

The server does not add connection-time instructions. It exposes
its live reference through `resources/list` and `resources/read` at
`remote-browser://docs/<topic>`. `browser_docs` provides the same content for
clients that do not expose resources. The optional skill in
[`skills/remote-browser/SKILL.md`](../skills/remote-browser/SKILL.md) teaches the shared-browser workflow; install its
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
