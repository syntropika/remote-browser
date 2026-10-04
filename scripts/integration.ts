import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";

import { chromium } from "playwright";
import { WebSocket } from "ws";

// Run inside a dedicated test container; this navigates its persistent browser.

const phase = process.argv[2] || "seed";
if (phase === "--help") {
  console.log("Run inside a dedicated container: node dist/scripts/integration.js seed | verify");
  console.log("seed tests MCP, UI, VNC and writes synthetic persistent state.");
  console.log("Recreate the container without deleting its volume, then run verify.");
  process.exit(0);
}
assert.ok(["seed", "verify"].includes(phase), "Expected seed or verify.");
const base = "http://127.0.0.1:8080";
const origin = process.env.PUBLIC_ORIGIN || base;
const uiBase = process.env.BROWSER_TEST_UI_URL || origin;
const token = (
  await readFile(process.env.BROWSER_TOKEN_FILE || "/data/access-token", "utf-8")
).trim();
const accountState = await (await fetch(`${base}/api/auth/status`)).json();
let testAccount;
if (accountState.configured) {
  try {
    testAccount = JSON.parse(await readFile("/data/.integration-account.json", "utf-8"));
  } catch {
    throw new Error(
      "Integration tests require a dedicated test deployment. An existing user account will not be changed.",
    );
  }
} else {
  assert.equal(phase, "seed", "The account must survive container replacement.");
  testAccount = {
    username: "integration-test",
    password: randomBytes(32).toString("base64url"),
  };
  await writeFile("/data/.integration-account.json", JSON.stringify(testAccount), { mode: 0o600 });
}
const fixtureUrl = "http://127.0.0.1:18765";
const fixturePageUrl = `${fixtureUrl}/?run=${randomBytes(8).toString("hex")}`;
const fixture = http.createServer((req, res) => {
  if (req.url === "/download") {
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="synthetic-report.pdf"',
    });
    res.end("%PDF-synthetic report\n");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html lang="en"><title>Remote Browser Test</title>
    <style>body{font:20px system-ui;margin:40px;min-height:2400px;background:#f2f5f9;color:#152339}input{display:block;padding:12px;font-size:20px;margin-top:10px}</style>
    <p hidden>Hidden fixture text</p><h1>Remote Browser Test</h1><p>Synthetic account fixture. No real credentials.</p>
    <label>Human input<input id="human" autofocus autocomplete="off"></label>
    <label>Attach document<input id="attachment" type="file"></label><a href="/download" download>Download report</a>\n    <button id="apply" onclick="document.querySelector('#state').textContent=document.querySelector('#human').value">Apply</button><p id="state"></p><script>document.querySelector('#state').textContent=localStorage.getItem('remote-browser-test')||'No saved session yet';</script></html>`);
});
fixture.listen(18_765, "127.0.0.1");
await once(fixture, "listening");
let sessionId;
let nextId = 0;
let uiBrowser;
let remote;
let uiCookie;
let uiPage;

async function rpc(method: string, params?: unknown) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++nextId,
      method,
      ...(params ? { params } : {}),
    }),
  });
  if (response.headers.get("mcp-session-id")) {
    sessionId = response.headers.get("mcp-session-id");
  }
  const text = await response.text();
  assert.ok(response.ok, `MCP HTTP ${response.status}: ${text.slice(0, 200)}`);
  const messages = response.headers.get("content-type")?.includes("event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(text)];
  const result = messages.find((message) => message.id === nextId);
  assert.ok(result, "Missing MCP response.");
  return result;
}

function keyClient(secret) {
  let keySessionId;
  let keyRequestId = 0;
  return async (method: string, params?: unknown) => {
    const id = ++keyRequestId;
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(keySessionId ? { "Mcp-Session-Id": keySessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params ? { params } : {}),
      }),
    });
    if (response.headers.get("mcp-session-id")) {
      keySessionId = response.headers.get("mcp-session-id");
    }
    assert.equal(
      response.status,
      200,
      "An active managed key must authenticate a real MCP request.",
    );
    const text = await response.text();
    const messages = response.headers.get("content-type")?.includes("event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)))
      : [JSON.parse(text)];
    const result = messages.find((message) => message.id === id);
    assert.ok(result?.result && !result.error, "The managed-key MCP request must succeed.");
    return result.result;
  };
}

async function initializeKey(client) {
  await client("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "remote-browser-managed-key-test", version: "1.0" },
  });
  const result = await client("tools/list");
  assert.deepEqual(result.tools.map((item) => item.name).toSorted(), [
    "browser_docs",
    "browser_execute",
    "browser_tabs",
  ]);
}

async function openKeys(dashboard) {
  await dashboard.locator("#more-menu summary").click();
  await dashboard.locator("#api-keys-button").click();
  await dashboard.locator("#api-keys-panel").waitFor({ state: "visible" });
  await dashboard.locator("#api-keys-list .api-key-row").first().waitFor({ state: "visible" });
}

async function createKey(dashboard, name) {
  await dashboard.locator("#api-key-name").fill(name);
  const created = dashboard.waitForResponse(
    (response) => response.url().endsWith("/api/keys") && response.request().method() === "POST",
  );
  await dashboard.locator("#api-key-create").click();
  const response = await created;
  assert.equal(response.status(), 201);
  const { key, secret } = await response.json();
  assert.ok(
    typeof secret === "string" && secret.length >= 32,
    "A newly issued key must have a secret.",
  );
  await dashboard.locator("#api-key-created").waitFor({ state: "visible" });
  assert.ok(
    (await dashboard.locator("#api-key-secret").inputValue()) === secret,
    "The one-time key display must match the issued credential.",
  );
  assert.equal(
    await dashboard.locator("#api-key-secret").evaluate((input) => input.readOnly),
    true,
  );
  await dashboard.locator(`.api-key-row[data-key-id="${key.id}"]`).waitFor({ state: "visible" });
  return { key, secret };
}

async function closeKeys(dashboard) {
  await dashboard.locator("#api-keys-close").click();
  await dashboard.locator("#api-keys-panel").waitFor({ state: "hidden" });
  assert.ok(
    (await dashboard.locator("#api-key-secret").inputValue()) === "",
    "Closing API key settings must clear the issued credential from the DOM.",
  );
}

async function revokeKey(dashboard, key) {
  const row = dashboard.locator(`.api-key-row[data-key-id="${key.id}"]`);
  await row.getByRole("button", { name: `Revoke ${key.name}`, exact: true }).click();
  const revoked = dashboard.waitForResponse((response) =>
    response.url().endsWith("/api/keys/revoke"),
  );
  await row.getByRole("button", { name: "Revoke key", exact: true }).click();
  assert.equal((await revoked).status(), 200);
  await row.waitFor({ state: "detached" });
}

async function tool(name, args) {
  const response = await rpc("tools/call", { name, arguments: args });
  assert.ok(!response.error, JSON.stringify(response.error));
  assert.ok(!response.result.isError, JSON.stringify(response.result));
  return response.result;
}

async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Cookie: uiCookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `API ${path} returned ${response.status}`);
  return response.json();
}

async function rawVnc(mode) {
  const ws = new WebSocket(`${base.replace("http:", "ws:")}/vnc?mode=${mode}`, {
    headers: { Cookie: uiCookie, Origin: origin },
  });
  let buffer = Buffer.alloc(0);
  let waiter;
  ws.on("message", (data) => {
    // SAFETY: This dedicated fixture reads native browser DOM controls and binary WebSocket frames created by its own test setup.
    buffer = Buffer.concat([buffer, data as Buffer]);
    waiter?.();
  });
  const read = async (size) => {
    while (buffer.length < size) {
      // oxlint-disable-next-line no-loop-func -- Reads are sequential; the waiter belongs to this active read until it settles.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiter = null;
          reject(new Error("VNC handshake timed out."));
        }, 5000);
        waiter = () => {
          waiter = null;
          clearTimeout(timeout);
          resolve();
        };
      });
    }
    const value = buffer.subarray(0, size);
    buffer = buffer.subarray(size);
    return value;
  };
  await once(ws, "open");
  await read(12);
  ws.send(Buffer.from("RFB 003.008\n"));
  const count = (await read(1))[0];
  assert.ok(
    (await read(count)).includes(1),
    "Expected private VNC no-auth transport behind gateway.",
  );
  ws.send(Buffer.from([1]));
  assert.equal((await read(4)).readUInt32BE(0), 0);
  ws.send(Buffer.from([1]));
  const serverInit = await read(24);
  await read(serverInit.readUInt32BE(20));
  const key = (keysym) => {
    for (const down of [1, 0]) {
      const event = Buffer.alloc(8);
      event[0] = 4;
      event[1] = down;
      event.writeUInt32BE(keysym, 4);
      ws.send(event);
    }
  };
  return {
    ws,
    key,
    type(text) {
      for (const character of text) {
        key(character.codePointAt(0));
      }
    },
  };
}

try {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/mcp`)).status, 401);
  const initialized = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "remote-browser-integration", version: "1.0" },
  });
  assert.ok(initialized.result);
  assert.equal(initialized.result.instructions, undefined);
  assert.ok(initialized.result.capabilities.resources);
  const resources = await rpc("resources/list");
  assert.ok(
    resources.result.resources.some(
      (resource) => resource.uri === "remote-browser://docs/workflow",
    ),
  );
  const resource = await rpc("resources/read", {
    uri: "remote-browser://docs/workflow",
  });
  assert.match(resource.result.contents[0].text, /Observe/u);
  const tools = await rpc("tools/list");
  assert.deepEqual(tools.result.tools.map((item) => item.name).toSorted(), [
    "browser_docs",
    "browser_execute",
    "browser_tabs",
  ]);
  await tool("browser_docs", { topic: "overview" });
  await tool("browser_execute", {
    code: `await page.goto(${JSON.stringify(fixturePageUrl)}); return {url: page.url()};`,
  });
  // Match MCP's attachment policy so inspection does not emulate focus in every tab.
  remote = await chromium.connectOverCDP("http://127.0.0.1:9222", {
    noDefaults: true,
  });
  const page = remote
    .contexts()[0]
    .pages()
    .find((item) => item.url() === fixturePageUrl);
  assert.ok(page, "MCP must operate the persistent browser context.");

  // A restored profile can leave a different tab visible after MCP navigation.
  if (phase === "seed") {
    await page.bringToFront();
  }

  const observed = (await tool("browser_execute", { code: "return await browser.snapshot();" }))
    .structuredContent.value;
  assert.match(observed.text, /\[textbox\] "Human input"/u);
  const rendered = (
    await tool("browser_execute", {
      code: "return await browser.read({maxChars:32});",
    })
  ).structuredContent.value;
  assert.equal(rendered.text.length, 32);
  assert.equal(rendered.truncated, true);
  assert.doesNotMatch(rendered.text, /Hidden fixture/u);
  const inputRef = /^@(?<capture1>e\d+) \[textbox\] "Human input"/mu.exec(observed.text)[1];
  await tool("browser_execute", {
    code: `await (await browser.ref(${JSON.stringify(inputRef)})).fill('Reference interaction');`,
  });
  assert.equal(await page.locator("#human").inputValue(), "Reference interaction");
  const annotated = await tool("browser_execute", {
    code: "image(await browser.screenshot({annotate:true,type:'png'})); return await browser.snapshot({delta:true});",
  });
  assert.ok(annotated.content.some((block) => block.type === "image"));
  assert.equal(
    await page.evaluate(() =>
      Object.keys(window).some((key) => key.startsWith("__remoteBrowserRef_")),
    ),
    false,
  );
  assert.equal(
    await page.locator("div[aria-hidden=true]").count(),
    0,
    "Annotation overlays must be removed.",
  );
  const delta = (
    await tool("browser_execute", {
      code: "return await browser.snapshot({delta:true});",
    })
  ).structuredContent.value;
  assert.equal(delta.text, "(unchanged)");
  const scoped = (
    await tool("browser_execute", {
      code: "return await browser.snapshot({scope:'label',interactive:false});",
    })
  ).structuredContent.value;
  assert.match(scoped.text, /Human input/u);
  assert.ok(!scoped.text.includes("Apply"));
  const replacement = await tool("browser_execute", {
    code: `
    const observation = await browser.snapshot();
    const ref = /^@(e\\d+) \\[button\\] "Apply"/m.exec(observation.text)[1];
    await page.locator('#apply').evaluate(button=>button.replaceWith(button.cloneNode(true)));
    try { await browser.ref(ref); return {stale:false}; } catch { return {stale:true}; }
  `,
  });
  assert.equal(replacement.structuredContent.value.stale, true);
  const tabs = (await tool("browser_execute", { code: "return await browser.tabs.list();" }))
    .structuredContent.value;
  const originalTab = tabs.find((tab) => tab.url === fixturePageUrl);
  const owned = (
    await tool("browser_execute", {
      code: `return await browser.tabs.open({url:${JSON.stringify(fixtureUrl)},task:'Synthetic agent task'});`,
    })
  ).structuredContent.value;
  const listed = (await tool("browser_execute", { code: "return await browser.tabs.list();" }))
    .structuredContent.value;
  assert.equal(listed.find((tab) => tab.id === originalTab.id).url, fixturePageUrl);
  assert.equal(listed.find((tab) => tab.id === owned.id).owned, true);
  const otherAgent = keyClient(token);
  await initializeKey(otherAgent);
  const reservation = (
    await tool("browser_tabs", {
      action: "reserve",
      tabId: originalTab.id,
      task: "Synthetic reserved task",
    })
  ).structuredContent.value;
  const reservationTarget = { tabId: originalTab.id, leaseId: reservation.leaseId };
  const background = await tool("browser_execute", {
    ...reservationTarget,
    code: "return page.url();",
  });
  assert.equal(background.structuredContent.value, fixturePageUrl);
  const activeAfter = (await tool("browser_tabs", { action: "list" })).structuredContent.value;
  assert.equal(activeAfter.find((tab) => tab.active).id, owned.id);
  for (const args of [
    { tabId: originalTab.id, code: "return page.url();" },
    { ...reservationTarget, leaseId: "another-task", code: "return page.url();" },
  ]) {
    const blocked = await otherAgent("tools/call", { name: "browser_execute", arguments: args });
    assert.equal(blocked.isError, true);
    assert.match(blocked.structuredContent.error.message, /reserved/u);
  }
  await tool("browser_execute", { ...reservationTarget, code: "await page.bringToFront();" });
  const discovery = await otherAgent("tools/call", {
    name: "browser_tabs",
    arguments: { action: "list" },
  });
  assert.equal(discovery.structuredContent.ok, true);
  assert.equal(
    discovery.structuredContent.value.find((tab) => tab.id === originalTab.id).reservation.task,
    "Synthetic reserved task",
  );
  assert.ok(!JSON.stringify(discovery).includes(reservation.leaseId));
  const renewed = await tool("browser_tabs", { action: "renew", ...reservationTarget });
  assert.equal(renewed.structuredContent.value.leaseId, reservation.leaseId);
  await tool("browser_tabs", { action: "release", ...reservationTarget });
  const stale = await rpc("tools/call", {
    name: "browser_execute",
    arguments: { ...reservationTarget, code: "return page.url();" },
  });
  assert.equal(stale.result.isError, true);
  const released = await otherAgent("tools/call", {
    name: "browser_execute",
    arguments: { tabId: originalTab.id, code: "return page.url();" },
  });
  assert.equal(released.structuredContent.ok, true);
  const shortLease = (
    await tool("browser_tabs", {
      action: "reserve",
      tabId: originalTab.id,
      ttlMs: 1000,
    })
  ).structuredContent.value;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 1100);
  });
  const expired = await rpc("tools/call", {
    name: "browser_execute",
    arguments: { tabId: originalTab.id, leaseId: shortLease.leaseId, code: "return 1;" },
  });
  assert.equal(expired.result.isError, true);
  console.log(
    "PASS: background tab targeting, reservations across MCP clients, owner checks, discovery, renewal, release and expiry.",
  );
  const protectedTab = await tool("browser_execute", {
    code: `try {await browser.tabs.close(${JSON.stringify(originalTab.id)});return false;}catch{return true;}`,
  });
  assert.equal(protectedTab.structuredContent.value, true);
  await tool("browser_execute", {
    code: `await browser.tabs.close(${JSON.stringify(owned.id)}); await browser.tabs.use(${JSON.stringify(originalTab.id)});`,
  });
  const savedDownload = (
    await tool("browser_execute", {
      code: "return await files.download(page,async()=>{await page.getByRole('link',{name:'Download report'}).click();});",
    })
  ).structuredContent.value;
  assert.equal(savedDownload.kind, "download");
  assert.equal(savedDownload.name, "synthetic-report.pdf");
  const report = await fetch(base + new URL(savedDownload.url, base).pathname, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(await report.text(), "%PDF-synthetic report\n");
  console.log(
    "PASS: MCP resources, compact snapshots, native refs, stale detection, annotations, deltas, stable task tabs and downloads.",
  );

  const interaction = await tool("browser_execute", {
    code: `
    await page.getByLabel('Human input').fill('code-mode interaction');
    await page.getByRole('button', {name: 'Apply', exact: true}).click();
    return {text: await page.locator('#state').textContent(), url: page.url()};
  `,
  });
  assert.equal(interaction.structuredContent.value.text, "code-mode interaction");
  assert.ok(
    !interaction.content.some(
      (item) => item.type === "text" && item.text.includes("Ran Playwright code"),
    ),
  );
  const capture = await tool("browser_execute", {
    code: `
    const bytes = await page.screenshot({type: 'png'});
    image(bytes);
    return await files.saveScreenshot(bytes, {name: 'Browser capture'});
  `,
  });
  const picture = capture.content.find((item) => item.type === "image");
  assert.equal(picture?.mimeType, "image/png");
  assert.ok(Buffer.from(picture.data, "base64").subarray(1, 4).equals(Buffer.from("PNG")));
  const savedCapture = capture.structuredContent.value;
  const downloadPath = `/api/artifacts/${savedCapture.id}/download`;
  assert.equal((await fetch(base + downloadPath)).status, 401);
  const downloaded = await fetch(base + downloadPath, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(downloaded.status, 200);
  assert.ok(
    Buffer.from(await downloaded.arrayBuffer()).equals(Buffer.from(picture.data, "base64")),
  );
  const cdp = await tool("browser_execute", {
    code: `
    const session = await context.newCDPSession(page);
    try {return await session.send('Page.getLayoutMetrics');}
    finally {await session.detach();}
  `,
  });
  assert.ok(cdp.structuredContent.value.cssLayoutViewport.clientWidth > 0);
  const tabUrl = `${fixtureUrl}/?code-tab-check`;
  await tool("browser_execute", {
    code: `const tab = await context.newPage(); await tab.goto(${JSON.stringify(tabUrl)}); await tab.bringToFront();`,
  });
  const currentTab = await tool("browser_execute", {
    code: "return page.url();",
  });
  assert.equal(
    currentTab.structuredContent.value,
    tabUrl,
    "Code mode must follow a tab opened by a prior code call.",
  );
  await tool("browser_execute", { code: "await page.close();" });
  await page.bringToFront();
  const failed = await rpc("tools/call", {
    name: "browser_execute",
    arguments: { code: "throw new Error('Synthetic code failure');" },
  });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.structuredContent.error.message, /Synthetic code failure/u);
  await tool("browser_execute", {
    code: "await page.getByLabel('Human input').fill(''); return page.url();",
  });
  console.log(
    "PASS: code mode interacts through Playwright and CDP, emits images, downloads authenticated screenshots and recovers after code errors.",
  );

  if (phase === "seed") {
    await tool("browser_execute", {
      code: "return await recording.start({name:'Browser walkthrough',maxSeconds:15});",
    });
    await tool("browser_execute", {
      code: "await page.getByLabel('Human input').fill('recorded action'); await page.waitForTimeout(1200);",
    });
    const recorded = await tool("browser_execute", {
      code: "return await recording.stop();",
    });
    assert.equal(recorded.structuredContent.value.mimeType, "video/mp4");
    const video = await fetch(
      `${base}/api/artifacts/${recorded.structuredContent.value.id}/download`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(video.status, 200);
    assert.ok(
      Buffer.from(await video.arrayBuffer())
        .subarray(4, 8)
        .equals(Buffer.from("ftyp")),
    );
    await writeFile(
      "/data/.integration-artifacts.json",
      JSON.stringify({
        screenshotId: savedCapture.id,
        videoId: recorded.structuredContent.value.id,
      }),
      { mode: 0o600 },
    );
    await tool("browser_execute", {
      code: "await page.getByLabel('Human input').fill('');",
    });
    console.log("PASS: code mode records the visible browser and downloads a finalized MP4.");
  }

  if (phase === "verify") {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(testAccount),
    });
    assert.equal(login.status, 200, "Dashboard credentials must survive container replacement.");
    uiCookie = login.headers.get("set-cookie")?.split(";")[0];
    const savedKey = JSON.parse(await readFile("/data/.integration-api-key.json", "utf-8"));
    const restoredKeys = (await api("/api/keys")).keys;
    const savedFiles = JSON.parse(await readFile("/data/.integration-artifacts.json", "utf-8"));
    const restoredFiles = await api("/api/artifacts");
    assert.ok(restoredFiles.files.some((file) => file.id === savedFiles.screenshotId));
    assert.ok(restoredFiles.files.some((file) => file.id === savedFiles.videoId));
    const shutdownRecording = JSON.parse(
      await readFile("/data/.integration-shutdown-recording.json", "utf-8"),
    );
    assert.ok(
      restoredFiles.files.some((file) => file.id === shutdownRecording.id),
      "Graceful replacement must finalize the active recording.",
    );
    assert.ok(
      restoredKeys.some((key) => key.id === savedKey.id),
      "Issued keys must survive container replacement.",
    );
    assert.ok(
      !restoredKeys.some((key) => key.id === savedKey.revokedId),
      "Revoked keys must stay revoked after restart.",
    );
    await initializeKey(keyClient(savedKey.secret));
    await api("/api/logout", {});
    const marker = (await readFile("/data/.integration-marker", "utf-8")).trim();
    assert.equal(await page.evaluate(() => localStorage.getItem("remote-browser-test")), marker);
    const cookie = (await remote.contexts()[0].cookies(fixtureUrl)).find(
      (item) => item.name === "remote-browser-test",
    );
    assert.equal(cookie?.value, marker);
    console.log(
      "PASS: dashboard account, issued and revoked API keys, browser cookies and localStorage survived container replacement.",
    );
  } else {
    uiBrowser = await chromium.launch({
      executablePath: "/usr/bin/chromium",
      chromiumSandbox: true,
      headless: true,
      env: { ...process.env, HOME: "/home/node" },
      args: process.env.BROWSER_TEST_HOST_MAP
        ? [`--host-resolver-rules=${process.env.BROWSER_TEST_HOST_MAP}`]
        : [],
    });
    const context = await uiBrowser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const ui = await context.newPage();
    uiPage = ui;
    const errors = [];
    ui.on("pageerror", (error) => errors.push(error.message));
    await ui.goto(uiBase);
    await ui.locator("#username").fill(testAccount.username);
    if (!accountState.configured) {
      assert.equal(await ui.locator("#password").getAttribute("autocomplete"), "new-password");
      await ui.locator("#generate-password").click();
      const generated = await ui.locator("#password").inputValue();
      assert.match(generated, /^[A-Za-z0-9_-]{24}$/u);
      assert.equal(await ui.locator("#confirm-password").inputValue(), generated);
      assert.equal(await ui.locator("#generated-password-note").isVisible(), true);
      await ui.locator("#generate-password").click();
      assert.notEqual(await ui.locator("#password").inputValue(), generated);
      console.log("PASS: password generation fills both setup fields over HTTP.");
    }
    await ui.locator("#password").fill(testAccount.password);
    if (!accountState.configured) {
      await ui.locator("#confirm-password").fill(testAccount.password);
      if (process.env.SCREENSHOT_DIR) {
        await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
        await ui.screenshot({
          path: `${process.env.SCREENSHOT_DIR}/onboarding.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    await ui.locator("#login-submit").click();
    await ui.locator("#workspace").waitFor({ state: "visible" });
    await ui.waitForFunction(
      () => document.querySelector<HTMLElement>("#connection-label").textContent === "Connected",
    );
    const removedKeyboardButtons = "#keyboard-tab, #keyboard-escape, #keyboard-backspace";
    assert.equal(
      await ui.locator(removedKeyboardButtons).count(),
      0,
      "Auxiliary keyboard buttons must be removed from the desktop interface.",
    );
    uiCookie = (await context.cookies(uiBase))
      .filter((item) => item.name === "remote_browser_session")
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
    assert.ok(uiCookie);
    await ui.locator("#more-menu summary").click();
    await ui.locator("#files-button").click();
    await ui.locator("#files-upload-input").setInputFiles({
      name: "Synthetic upload.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-human-upload\n"),
    });
    await ui.locator("#files-upload-status").waitFor({ state: "visible" });
    const uploads = await api("/api/artifacts");
    const uploaded = uploads.files.find(
      (file) => file.kind === "upload" && file.name === "Synthetic upload.pdf",
    );
    assert.ok(uploaded);
    await tool("browser_execute", {
      code: `return await files.uploadTo(page.locator('#attachment'),{id:${JSON.stringify(uploaded.id)}});`,
    });
    assert.deepEqual(
      await page.locator("#attachment").evaluate((input) => ({
        name: input.files[0].name,
        type: input.files[0].type,
        size: input.files[0].size,
      })),
      { name: "Synthetic upload.pdf", type: "application/pdf", size: 18 },
    );
    await ui.locator("#files-close").click();
    console.log(
      "PASS: human gallery upload attaches to the visible browser with original bytes and MIME type.",
    );

    assert.equal(await ui.locator("#password").inputValue(), "");
    assert.equal(await ui.locator("#confirm-password").inputValue(), "");
    assert.equal(await ui.evaluate(() => localStorage.length), 0);
    assert.equal((await (await fetch(`${base}/api/auth/status`)).json()).configured, true);
    assert.equal(
      (
        await fetch(`${base}/api/auth/setup`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify(testAccount),
        })
      ).status,
      409,
      "First-time setup must close after account creation.",
    );
    console.log(
      "PASS: account setup/sign-in, closed registration and real noVNC observation connected.",
    );

    assert.equal((await api("/api/status")).mode, "agent");
    await openKeys(ui);
    assert.equal(await ui.locator("#mcp-endpoint").inputValue(), `${new URL(uiBase).origin}/mcp`);
    const issued = await createKey(ui, "Work laptop");
    const managedClient = keyClient(issued.secret);
    await initializeKey(managedClient);
    const keyBoundLease = (
      await tool("browser_tabs", {
        action: "reserve",
        tabId: originalTab.id,
        task: "Cross-key reservation",
      })
    ).structuredContent.value;
    const wrongKey = await managedClient("tools/call", {
      name: "browser_execute",
      arguments: {
        tabId: originalTab.id,
        leaseId: keyBoundLease.leaseId,
        code: "return page.url();",
      },
    });
    assert.equal(wrongKey.isError, true);
    assert.match(wrongKey.structuredContent.error.message, /reserved/u);
    await tool("browser_tabs", {
      action: "release",
      tabId: originalTab.id,
      leaseId: keyBoundLease.leaseId,
    });
    console.log("PASS: reservation tokens cannot authorize another API key.");
    const deniedRequests: [string, unknown?][] = [
      ["/api/keys"],
      ["/api/keys", { name: "Not allowed" }],
      ["/api/keys/revoke", { id: issued.key.id }],
    ];
    for (const [path, body] of deniedRequests) {
      const denied = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${issued.secret}`,
          Origin: origin,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(
        denied.status,
        403,
        "MCP credentials must not authorize dashboard key management.",
      );
    }
    const refreshed = ui.waitForResponse(
      (response) => response.url().endsWith("/api/keys") && response.request().method() === "GET",
    );
    await ui.locator("#api-keys-refresh").click();
    const refreshedKeys = (await (await refreshed).json()).keys;
    assert.ok(
      refreshedKeys.find((key) => key.id === issued.key.id)?.lastUsedAt,
      "Successful MCP authentication must record when the key was last used.",
    );
    const issuedRow = ui.locator(`.api-key-row[data-key-id="${issued.key.id}"]`);
    await ui.waitForFunction((id) => {
      const row = document.querySelector<HTMLElement>(`.api-key-row[data-key-id="${id}"]`);
      return row && !/never/iu.test(row.textContent);
    }, issued.key.id);
    assert.ok(
      !JSON.stringify(refreshedKeys).includes(issued.secret),
      "Key listings must never return a secret.",
    );
    await closeKeys(ui);
    await openKeys(ui);
    assert.equal(
      await ui.locator("#api-key-created").isVisible(),
      false,
      "Reopening settings must not expose a previously issued credential.",
    );
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      await ui.screenshot({
        path: `${process.env.SCREENSHOT_DIR}/api-keys-desktop.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    await issuedRow.getByRole("button", { name: "Revoke Work laptop", exact: true }).click();
    await issuedRow.getByRole("button", { name: "Cancel", exact: true }).click();
    await managedClient("ping");
    await revokeKey(ui, issued.key);
    for (const method of ["GET", "POST", "DELETE"]) {
      const rejected = await fetch(`${base}/mcp`, {
        method,
        headers: {
          Authorization: `Bearer ${issued.secret}`,
          "Content-Type": "application/json",
        },
        ...(method === "POST"
          ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }
          : {}),
      });
      assert.equal(rejected.status, 401, `A revoked key must fail MCP ${method} authentication.`);
    }
    await closeKeys(ui);
    const persistentKey = await api("/api/keys", { name: "Restart check" });
    await writeFile(
      "/data/.integration-api-key.json",
      JSON.stringify({
        id: persistentKey.key.id,
        secret: persistentKey.secret,
        revokedId: issued.key.id,
      }),
      { mode: 0o600 },
    );
    assert.equal(
      await ui.evaluate(() => localStorage.length),
      0,
      "API keys must not be persisted in browser localStorage.",
    );
    assert.equal(
      (await api("/api/status")).mode,
      "agent",
      "Managing API keys must not take control of the remote browser.",
    );
    console.log(
      "PASS: dashboard issues, uses, lists and revokes MCP keys without taking browser control or exposing saved secrets.",
    );

    await tool("browser_execute", {
      code: "return await recording.start({name:'Gallery recording',maxSeconds:60});",
    });
    await ui.locator("#recording-indicator").waitFor({ state: "visible" });
    await ui.locator("#recording-indicator").click();
    await ui.locator("#files-list img").first().waitFor({ state: "visible" });
    await ui.waitForFunction(() =>
      [...document.querySelectorAll<HTMLImageElement>("#files-list img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    );
    await ui.waitForFunction(
      () => document.querySelector<HTMLVideoElement>("#files-list video")?.readyState >= 1,
    );
    assert.equal(await ui.locator(".browser-shell").evaluate((element) => element.inert), true);
    const galleryVideo = ui.locator("#files-list video").first();
    await galleryVideo.evaluate(async (video) => {
      await video.play();
    });
    await ui.waitForFunction(
      () => document.querySelector<HTMLVideoElement>("#files-list video").currentTime > 0,
    );
    await galleryVideo.evaluate((video) => video.pause());
    if (process.env.SCREENSHOT_DIR) {
      await ui.screenshot({
        path: `${process.env.SCREENSHOT_DIR}/files-desktop.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    const savedRecording = ui.waitForResponse((response) =>
      response.url().endsWith("/api/recording/stop"),
    );
    await ui.locator("#recording-stop").click();
    const stopped = await (await savedRecording).json();
    await ui.locator("#active-recording").waitFor({ state: "hidden" });
    const row = ui.locator(`.file-row[data-file-id="${savedCapture.id}"]`);
    const downloadEvent = ui.waitForEvent("download");
    await row.getByRole("link", { name: `Download ${savedCapture.name}`, exact: true }).click();
    assert.equal((await downloadEvent).suggestedFilename(), savedCapture.name);
    const disposable = ui.locator(`.file-row[data-file-id="${stopped.file.id}"]`);
    await disposable
      .getByRole("button", { name: `Delete ${stopped.file.name}`, exact: true })
      .click();
    await disposable.getByRole("button", { name: "Cancel", exact: true }).click();
    await disposable
      .getByRole("button", { name: `Delete ${stopped.file.name}`, exact: true })
      .click();
    await disposable.getByRole("button", { name: "Delete file", exact: true }).click();
    await disposable.waitFor({ state: "detached" });
    await ui.locator("#files-close").click();
    assert.equal(await ui.locator(".browser-shell").evaluate((element) => element.inert), false);
    console.log(
      "PASS: gallery previews images and plays video, downloads files, stops recording and confirms deletion.",
    );

    await page.locator("#human").focus();
    const observer = await rawVnc("view");
    observer.type("blocked");
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    assert.equal(
      await page.locator("#human").inputValue(),
      "",
      "Observation must reject raw keyboard input.",
    );
    observer.ws.close();
    console.log("PASS: the VNC observation server rejects input even without the UI guard.");

    await ui.locator("#take-button").click();
    await ui.waitForFunction(
      () => document.querySelector<HTMLElement>("#mode-title").textContent === "You have control",
    );
    await ui.waitForFunction(
      () => document.querySelector<HTMLElement>("#connection-label").textContent === "Connected",
    );
    assert.equal((await api("/api/status")).mode, "human");
    await tool("browser_docs", { topic: "screenshots" });
    const pendingHandoff = rpc("tools/call", {
      name: "browser_execute",
      arguments: { code: 'return "must not execute";' },
    });
    await ui.locator("#agent-handoff").waitFor({ state: "visible" });
    assert.equal(await ui.evaluate(() => document.activeElement.id), "agent-handoff-cancel");
    if (process.env.SCREENSHOT_DIR) {
      await ui.screenshot({
        path: `${process.env.SCREENSHOT_DIR}/handoff-desktop.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    await ui.keyboard.press("Escape");
    assert.match((await pendingHandoff).error.message, /cancelled/u);
    assert.equal((await api("/api/status")).mode, "human");
    await ui.locator("#agent-handoff").waitFor({ state: "hidden" });
    assert.equal(await ui.locator("#agent-handoff").isVisible(), false);
    const blocked = await rpc("tools/call", {
      name: "browser_execute",
      arguments: { code: 'return "must not execute";' },
    });
    assert.match(blocked.error.message, /30 seconds/u);
    console.log(
      "PASS: a real MCP call opens the focused handoff popup; Escape cancels and suppresses repeat prompts.",
    );
    const controller = await rawVnc("control");
    // Dismiss native address-bar suggestions before clicking the page.
    controller.key(0xff_1b);
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    // CDP focus does not move native keyboard focus out of Chromium's address bar.
    // Click the real remote input through noVNC, including browser chrome offsets.
    const box = await page.locator("#human").boundingBox();
    const geometry = await page.evaluate(() => ({
      x: screenX + (outerWidth - innerWidth) / 2,
      y: screenY + outerHeight - innerHeight,
      width: screen.width,
      height: screen.height,
    }));
    const canvas = await ui.locator("#browser-display canvas").boundingBox();
    await ui.mouse.click(
      canvas.x + ((geometry.x + box.x + box.width / 2) * canvas.width) / geometry.width,
      canvas.y + ((geometry.y + box.y + box.height / 2) * canvas.height) / geometry.height,
    );
    controller.type("rfb-");
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#human").value === "rfb-",
      null,
      {
        timeout: 5000,
      },
    );
    // Focusing the local canvas does not send a remote click or disturb the input.
    await ui.locator("#browser-display canvas").focus();
    await ui.keyboard.type("human-entry");
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#human").value === "rfb-human-entry",
      null,
      { timeout: 5000 },
    );
    const maliciousObserver = await rawVnc("view");
    maliciousObserver.type("blocked");
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    assert.equal(await page.locator("#human").inputValue(), "rfb-human-entry");
    maliciousObserver.ws.close();
    console.log("PASS: human keyboard input reaches the same browser while MCP is blocked.");

    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(uiBase).origin,
    });
    await ui.evaluate(() => navigator.clipboard.writeText("Keyboard clipboard paste"));
    await ui.locator("#browser-display canvas").focus();
    await ui.keyboard.press("Control+a");
    await ui.keyboard.press("Control+v");
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#human").value === "Keyboard clipboard paste",
    );
    await ui.evaluate(() => navigator.clipboard.writeText("Previous local clipboard"));
    await ui.keyboard.press("Control+a");
    await ui.keyboard.press("Control+c");
    await ui.waitForFunction(
      async () => (await navigator.clipboard.readText()) === "Keyboard clipboard paste",
    );
    assert.equal(await ui.locator("#clipboard-panel").isVisible(), false);
    await ui.locator("#address-input").fill("Local dashboard text");
    await ui.locator("#address-input").press("Control+a");
    await ui.locator("#address-input").press("Control+c");
    await ui.waitForFunction(
      async () => (await navigator.clipboard.readText()) === "Local dashboard text",
    );
    assert.equal(await page.locator("#human").inputValue(), "Keyboard clipboard paste");
    await ui.locator("#browser-display canvas").focus();
    await ui.keyboard.press("Meta+a");
    await ui.keyboard.press("Meta+c");
    await ui.waitForFunction(
      async () => (await navigator.clipboard.readText()) === "Keyboard clipboard paste",
    );
    console.log(
      "PASS: Ctrl+C/Ctrl+V transfer the device clipboard, Command maps to remote Control, and local fields keep native shortcuts.",
    );

    const clipboardText = "café 😀 日本語 العربية";
    const openClipboard = async (dashboard) => {
      await dashboard.locator("#more-menu summary").click();
      await dashboard.locator("#clipboard-button").click();
      await dashboard.locator("#clipboard-panel").waitFor({ state: "visible" });
    };
    await ui.locator("#browser-display canvas").focus();
    await ui.keyboard.press("Control+a");
    await openClipboard(ui);
    await ui.locator("#clipboard-text").fill(clipboardText);
    await ui.locator("#clipboard-send").click();
    await page.waitForFunction(
      (text) => document.querySelector<HTMLInputElement>("#human").value === text,
      clipboardText,
    );
    assert.equal(await ui.locator("#clipboard-text").inputValue(), "");
    await ui.keyboard.press("Control+a");
    await openClipboard(ui);
    await ui.locator("#clipboard-read").click();
    await ui.waitForFunction(
      (text) => document.querySelector<HTMLInputElement>("#clipboard-text").value === text,
      clipboardText,
    );
    // Exercise the HTTP clipboard fallback without the secure-context API.
    await ui.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        configurable: true,
      }),
    );
    await ui.locator("#clipboard-copy").click();
    assert.equal(await ui.locator("#clipboard-status").innerText(), "Copied to your device.");
    if (process.env.SCREENSHOT_DIR) {
      await ui.screenshot({
        path: `${process.env.SCREENSHOT_DIR}/clipboard-desktop.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    await ui.locator("#clipboard-close").click();
    assert.equal(await ui.locator("#clipboard-text").inputValue(), "");
    console.log(
      "PASS: native desktop copy and paste preserve Unicode, and device copy uses the HTTP fallback.",
    );

    await ui.locator("#more-menu summary").click();
    await ui.keyboard.press("Escape");
    assert.equal(await ui.locator("#more-menu").evaluate((menu) => menu.open), false);
    await ui.locator("#tabs-button").click();
    await ui.locator('.tab-select[aria-current="page"]').focus();
    // SAFETY: This dedicated fixture reads native browser DOM controls and binary WebSocket frames created by its own test setup.
    const focusedTab = await ui.evaluate(
      () => (document.activeElement as HTMLElement).dataset.tabId,
    );
    await ui.waitForResponse((response) => response.url().endsWith("/api/browser/tabs"));
    // SAFETY: This dedicated fixture reads native browser DOM controls and binary WebSocket frames created by its own test setup.
    assert.equal(
      await ui.evaluate(() => (document.activeElement as HTMLElement).dataset.tabId),
      focusedTab,
    );
    await ui.keyboard.press("Escape");
    assert.equal(await ui.evaluate(() => document.activeElement.id), "tabs-button");
    assert.equal(await ui.locator("#tabs-panel").isVisible(), false);
    console.log("PASS: menu dismissal and tab focus survive live polling.");

    const screenshotDir = process.env.SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await ui.screenshot({
        path: `${screenshotDir}/dashboard.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    const assertDesktopDock = async (dashboard, viewport) => {
      await dashboard.waitForFunction(
        () => {
          const localCanvas = document
            .querySelector<HTMLElement>("#browser-display canvas")
            ?.getBoundingClientRect();
          const shell = document
            .querySelector<HTMLElement>(".browser-shell")
            .getBoundingClientRect();
          return (
            document.querySelector<HTMLElement>(".control-bar .toolbar") &&
            localCanvas?.width > 0 &&
            localCanvas.height > 0 &&
            localCanvas.left >= shell.left - 1 &&
            localCanvas.right <= shell.right + 1 &&
            localCanvas.top >= shell.top - 1 &&
            localCanvas.bottom <= shell.bottom + 1 &&
            document.querySelector<HTMLElement>("#zoom-button").getAttribute("aria-pressed") ===
              "false"
          );
        },
        null,
        { timeout: 5000 },
      );
      const bounds = await dashboard.evaluate(() => {
        const rect = (selector) => {
          const { top, left, width, height, right, bottom } = document
            .querySelector<HTMLElement>(selector)
            .getBoundingClientRect();
          return { top, left, width, height, right, bottom };
        };
        return {
          workspace: rect("#workspace"),
          toolbar: rect(".toolbar"),
          dock: rect(".control-bar"),
          shell: rect(".browser-shell"),
          canvas: rect("#browser-display canvas"),
          controls: [".history-actions", ".address-form", "#tabs-button", ".toolbar-actions"].map(
            rect,
          ),
        };
      });
      const state = `${viewport.width}x${viewport.height}`;
      const within = (inner, outer) =>
        inner.left >= outer.left - 1 &&
        inner.right <= outer.right + 1 &&
        inner.top >= outer.top - 1 &&
        inner.bottom <= outer.bottom + 1;
      for (const edge of ["top", "left", "right", "bottom"]) {
        assert.ok(
          Math.abs(bounds.shell[edge] - bounds.workspace[edge]) <= 1,
          `The remote display must use the complete workspace, without a top navigation row (${state}, ${edge}).`,
        );
      }
      assert.equal(await dashboard.locator(".toolbar").count(), 1);
      assert.equal(
        await dashboard.locator(".control-bar .toolbar").count(),
        1,
        "Desktop navigation and session controls must share one bottom dock.",
      );
      assert.ok(
        bounds.dock.top > bounds.workspace.top + bounds.workspace.height / 2,
        `The desktop controls must be near the bottom of the display (${state}).`,
      );
      assert.ok(
        within(bounds.dock, bounds.workspace),
        `The desktop dock must fit inside the viewport (${state}).`,
      );
      assert.ok(
        within(bounds.toolbar, bounds.dock) &&
          bounds.controls.every((control) => within(control, bounds.dock)),
        `Navigation, address, tabs and session controls must fit inside the same dock (${state}).`,
      );
      assert.ok(
        within(bounds.canvas, bounds.shell),
        `Fit mode must keep the entire streamed browser visible (${state}).`,
      );
      assert.equal(await dashboard.locator("#zoom-button").isVisible(), false);
      assert.equal(await dashboard.locator("#keyboard-button").isVisible(), false);
      assert.equal(await dashboard.locator("#mobile-keyboard-input").isVisible(), false);
      assert.equal(
        await dashboard.evaluate(() => {
          const localCanvas = document
            .querySelector<HTMLElement>("#browser-display canvas")
            .getBoundingClientRect();
          return Boolean(
            document
              .elementFromPoint(localCanvas.left + localCanvas.width / 2, localCanvas.top + 4)
              ?.closest("#browser-display"),
          );
        }),
        true,
        `Desktop controls must leave Chromium's tabs and address bar unobstructed (${state}).`,
      );
      assert.equal(
        await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );

      const assertPopupAbove = async (selector, trigger) => {
        const popup = await dashboard.evaluate(
          ({ selector: localSelector, trigger: localTrigger }) => {
            const element = document.querySelector<HTMLElement>(localSelector);
            const { top, left, right, bottom, width, height } = element.getBoundingClientRect();
            const points = [
              [left + width / 2, top + 8],
              [left + width / 2, bottom - 8],
              [left + 8, top + height / 2],
              [right - 8, top + height / 2],
            ];
            return {
              top,
              left,
              right,
              bottom,
              triggerTop: document.querySelector<HTMLElement>(localTrigger).getBoundingClientRect()
                .top,
              reachable: points.every(([x, y]) =>
                element.contains(document.elementFromPoint(x, y)),
              ),
            };
          },
          { selector, trigger },
        );
        assert.ok(
          within(popup, bounds.workspace),
          `The ${selector} popup must stay inside the viewport (${state}).`,
        );
        assert.ok(
          popup.bottom <= popup.triggerTop + 1,
          `The ${selector} popup must open above the bottom dock (${state}).`,
        );
        assert.equal(
          popup.reachable,
          true,
          `The ${selector} popup must not be clipped by the dock (${state}).`,
        );
      };
      await dashboard.locator("#tabs-button").click();
      await assertPopupAbove("#tabs-panel", "#tabs-button");
      await dashboard.locator("#tabs-close").click();
      await dashboard.locator("#more-menu summary").click();
      await assertPopupAbove(".more-options", "#more-menu summary");
      assert.equal(
        await dashboard.locator("#session-summary #connection-status").isVisible(),
        true,
      );
      assert.equal(
        await dashboard.locator("#session-summary #mode-title").innerText(),
        "You have control",
      );
      await dashboard.locator("#more-menu summary").click();
    };
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 1916, height: 937 },
    ]) {
      await ui.setViewportSize(viewport);
      await assertDesktopDock(ui, viewport);
      if (screenshotDir && viewport.width === 1916) {
        await ui.screenshot({
          path: `${screenshotDir}/desktop-wide.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    await ui.setViewportSize({ width: 1440, height: 1000 });
    console.log(
      "PASS: desktop navigation shares one bottom dock, with the full browser visible and unclipped upward popups.",
    );

    const nativeState = await api("/api/browser/tabs");
    const localOriginalTab = nativeState.tabs.find((tab) => tab.url === fixturePageUrl);
    assert.ok(localOriginalTab, "The native tab list must expose the existing remote browser tab.");
    const mobileContext = await uiBrowser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await mobileContext.addCookies(await context.cookies(uiBase));
    const mobile = await mobileContext.newPage();
    uiPage = mobile;
    mobile.on("pageerror", (error) => errors.push(error.message));
    await mobile.goto(uiBase);
    await mobile.waitForFunction(
      () => document.querySelector<HTMLElement>("#connection-label").textContent === "Connected",
    );
    const mobileInput = mobile.locator("#mobile-keyboard-input");
    const sessionButtonIds = ["zoom-button", "take-button", "release-button"];
    const sessionButtons = await mobile.evaluateHandle(
      (ids) => ids.map((id) => document.querySelector(`#${id}`)),
      sessionButtonIds,
    );
    const assertSessionPlacement = async (mobileLayout) => {
      await mobile.waitForFunction(
        ({ ids, inline }) =>
          ids.every((id) =>
            document
              .querySelector(`#${id}`)
              .parentElement.matches(inline ? "#mobile-session-actions" : ".control-actions"),
          ),
        { ids: sessionButtonIds, inline: mobileLayout },
      );
      assert.equal(
        await sessionButtons.evaluate(
          (buttons, inline) =>
            buttons.every(
              (button) =>
                button === document.getElementById(button.id) &&
                button.parentElement.matches(
                  inline ? "#mobile-session-actions" : ".control-actions",
                ),
            ),
          mobileLayout,
        ),
        true,
        "The same session controls must move between the mobile toolbar and desktop dock.",
      );
      for (const id of sessionButtonIds) {
        assert.equal(
          await mobile.locator(`#${id}`).count(),
          1,
          "Session controls must keep unique IDs.",
        );
        assert.ok(
          (await mobile.locator(`#${id}`).getAttribute("aria-label"))?.trim(),
          "Icon controls need an accessible name.",
        );
        if (mobileLayout && (await mobile.locator(`#${id}`).isVisible())) {
          assert.equal(
            (await mobile.locator(`#${id}`).innerText()).trim(),
            "",
            "Mobile session controls must display only icons.",
          );
        }
      }
    };
    await assertSessionPlacement(true);
    assert.equal(await mobile.locator("#keyboard-button").isVisible(), false);
    assert.equal(await mobileInput.isVisible(), true);
    assert.equal(await mobileInput.isEnabled(), true);
    assert.equal(
      await mobileInput.evaluate((input) => input.matches(":placeholder-shown")),
      true,
      "The resting mobile input must show its placeholder, without a hidden keyboard sentinel.",
    );
    assert.notEqual(
      await mobile.evaluate(() => document.activeElement.id),
      "mobile-keyboard-input",
    );
    assert.equal(await mobile.locator("#keyboard-enter").isVisible(), true);
    assert.equal(
      await mobile.locator(removedKeyboardButtons).count(),
      0,
      "Auxiliary keyboard buttons must be removed from the mobile interface.",
    );
    if (screenshotDir) {
      await mobile.screenshot({
        path: `${screenshotDir}/mobile-ready.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    await mobile.locator("#more-menu summary").tap();
    assert.equal(await mobile.locator("#session-summary #connection-status").isVisible(), true);
    assert.equal(
      await mobile.locator("#session-summary #mode-title").innerText(),
      "You have control",
    );
    if (screenshotDir) {
      await mobile.screenshot({
        path: `${screenshotDir}/mobile-menu.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    await mobile.locator("#more-menu summary").tap();
    await mobile.locator("#address-input").tap();
    assert.equal(await mobile.evaluate(() => document.activeElement.id), "address-input");
    await mobile.locator("#address-input").fill(`${fixtureUrl}/?mobile=1`);
    await mobile.locator("#address-input").press("Enter");
    await page.waitForURL(`${fixtureUrl}/?mobile=1`);
    await mobile.locator("#address-go").waitFor({ state: "visible" });
    await mobile.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#back-button").disabled,
    );
    await mobile.locator("#back-button").tap();
    await page.waitForURL(fixturePageUrl, { waitUntil: "commit" });
    await mobile.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#forward-button").disabled,
    );
    await mobile.locator("#forward-button").tap();
    await page.waitForURL(`${fixtureUrl}/?mobile=1`, { waitUntil: "commit" });
    await mobile.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#reload-button").disabled,
    );
    await mobile.locator("#reload-button").tap();
    await mobile.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#address-go").disabled,
    );

    await mobile.locator("#tabs-button").tap();
    await mobile.locator("#new-tab-button").tap();
    await mobile.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#address-go").disabled,
    );
    assert.equal(await mobile.evaluate(() => document.activeElement.id), "address-input");
    await mobile.locator("#address-input").fill(`${fixtureUrl}/?new=1`);
    await mobile.locator("#address-input").press("Enter");
    await mobile.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#address-go").disabled,
    );
    const withNewTab = await api("/api/browser/tabs");
    const createdTab = withNewTab.tabs.find((tab) => tab.url.includes("?new=1"));
    assert.ok(createdTab);
    assert.equal(withNewTab.tabs.length, nativeState.tabs.length + 1);
    await mobile.locator("#tabs-button").tap();
    if (screenshotDir) {
      await mobile.screenshot({
        path: `${screenshotDir}/mobile-tabs.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    await mobile.locator(`.tab-select[data-tab-id="${localOriginalTab.id}"]`).tap();
    await mobile.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#address-go").disabled,
    );
    await mobile.locator("#tabs-button").tap();
    await mobile
      .locator(".tab-item")
      .filter({
        has: mobile.locator(`.tab-select[data-tab-id="${createdTab.id}"]`),
      })
      .locator(".tab-close")
      .tap();
    await mobile.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#new-tab-button").disabled,
    );
    await mobile.locator("#tabs-close").tap();
    assert.equal((await api("/api/browser/tabs")).tabs.length, nativeState.tabs.length);
    console.log(
      "PASS: native mobile address, history, reload and tab controls operate the shared browser.",
    );

    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    const scrollCanvas = await mobile.locator("#browser-display canvas").boundingBox();
    const remoteViewportHeight = await page.evaluate(() => innerHeight);
    const scrollX = scrollCanvas.x + scrollCanvas.width * 0.75;
    const scrollBottom =
      scrollCanvas.y +
      ((geometry.y + remoteViewportHeight * 0.8) * scrollCanvas.height) / geometry.height;
    const scrollTop =
      scrollCanvas.y +
      ((geometry.y + remoteViewportHeight * 0.25) * scrollCanvas.height) / geometry.height;
    const scrollTouch = await mobileContext.newCDPSession(mobile);
    const swipeRemotePage = async (fromY, toY) => {
      await scrollTouch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: scrollX, y: fromY }],
      });
      for (let step = 1; step <= 8; step++) {
        await scrollTouch.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: scrollX, y: fromY + ((toY - fromY) * step) / 8 }],
        });
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      await scrollTouch.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    };
    try {
      await swipeRemotePage(scrollBottom, scrollTop);
      await page.waitForFunction(() => window.scrollY > 0, null, {
        timeout: 5000,
      });
      const scrolledDown = await page.evaluate(() => window.scrollY);
      await swipeRemotePage(scrollTop, scrollBottom);
      await page.waitForFunction((previous) => window.scrollY < previous, scrolledDown, {
        timeout: 5000,
      });
    } finally {
      await scrollTouch.detach();
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
    }
    assert.equal(
      await page.evaluate(() => window.scrollY),
      0,
      "Restore the fixture before testing remote input taps.",
    );
    console.log("PASS: one-finger mobile swipes scroll the remote page in both directions.");

    await mobileInput.tap();
    assert.equal(await mobile.evaluate(() => document.activeElement.id), "mobile-keyboard-input");
    await mobile.locator("#keyboard-close").tap();
    const mobileBox = await page.locator("#human").boundingBox();
    const mobileCanvas = await mobile.locator("#browser-display canvas").boundingBox();
    await mobile.touchscreen.tap(
      mobileCanvas.x +
        ((geometry.x + mobileBox.x + mobileBox.width / 2) * mobileCanvas.width) / geometry.width,
      mobileCanvas.y +
        ((geometry.y + mobileBox.y + mobileBox.height / 2) * mobileCanvas.height) / geometry.height,
    );
    await mobileInput.tap();
    await mobileInput.fill("mobile café");
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#human").value === "mobile café",
    );
    await mobileInput.press("Backspace");
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#human").value === "mobile caf",
    );
    await mobileInput.fill("e");
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#human").value === "mobile cafe",
    );
    await page.locator("#human").evaluate((input) => {
      input.dataset.enterPressed = "false";
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          input.dataset.enterPressed = "true";
        }
      });
    });
    await mobile.locator("#keyboard-enter").tap();
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#human").dataset.enterPressed === "true",
    );
    await openClipboard(mobile);
    await mobile.locator("#clipboard-text").fill(" 😀 日本語");
    await mobile.locator("#clipboard-send").tap();
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#human").value === "mobile cafe 😀 日本語",
    );
    // The mobile Copy action supplies Ctrl+C without requiring a physical keyboard.
    await page.locator("#human").evaluate((input) => input.select());
    await openClipboard(mobile);
    await mobile.locator("#clipboard-read").tap();
    await mobile.waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>("#clipboard-text").value ===
        "mobile cafe 😀 日本語",
    );
    for (const width of [390, 320]) {
      await mobile.setViewportSize({ width, height: 844 });
      assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      for (const id of ["clipboard-read", "clipboard-copy", "clipboard-send", "clipboard-close"]) {
        const bounds = await mobile.locator(`#${id}`).boundingBox();
        assert.ok(
          bounds && bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width,
        );
      }
      if (screenshotDir) {
        await mobile.screenshot({
          path: `${screenshotDir}/clipboard-mobile-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.locator("#clipboard-close").tap();
    assert.equal(await mobile.locator("#clipboard-text").inputValue(), "");
    console.log(
      "PASS: mobile clipboard copy and paste preserve Unicode with 44px controls at 390px and 320px.",
    );
    await mobileInput.tap();
    if (screenshotDir) {
      await mobile.screenshot({
        path: `${screenshotDir}/mobile-keyboard.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    await mobile.locator("#keyboard-close").tap();
    assert.equal(
      await mobileInput.isVisible(),
      true,
      "Dismissing the native keyboard must preserve the mobile input.",
    );
    assert.notEqual(
      await mobile.evaluate(() => document.activeElement.id),
      "mobile-keyboard-input",
    );
    assert.equal(await mobileInput.evaluate((input) => input.matches(":placeholder-shown")), true);
    await mobile.locator("#zoom-button").tap();
    assert.equal(await mobile.locator("#zoom-button").getAttribute("aria-pressed"), "true");
    const topPixels = async () =>
      mobile
        .locator("#browser-display canvas")
        .evaluate((localCanvas) =>
          localCanvas.getContext("2d").getImageData(0, 0, localCanvas.width, 40).data.toString(),
        );
    const beforePan = await topPixels();
    const zoomCanvas = await mobile.locator("#browser-display canvas").boundingBox();
    const touch = await mobileContext.newCDPSession(mobile);
    const startX = zoomCanvas.x + zoomCanvas.width * 0.8;
    const touchY = zoomCanvas.y + Math.min(zoomCanvas.height * 0.6, 250);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: startX, y: touchY }],
    });
    for (let step = 1; step <= 6; step++) {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: startX - step * 25, y: touchY }],
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    assert.ok(
      (await topPixels()) !== beforePan,
      "A touch drag must pan the actual-size remote display.",
    );
    const zoomScrollX = zoomCanvas.x + zoomCanvas.width / 2;
    const zoomScrollBottom = zoomCanvas.y + Math.min(zoomCanvas.height * 0.8, 480);
    const zoomScrollTop = Math.max(zoomCanvas.y + 160, zoomScrollBottom - 180);
    const twoFingerSwipe = async (fromY, toY) => {
      const points = (y) => [
        { id: 1, x: zoomScrollX - 25, y },
        { id: 2, x: zoomScrollX + 25, y },
      ];
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: points(fromY),
      });
      for (let step = 1; step <= 8; step++) {
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: points(fromY + ((toY - fromY) * step) / 8),
        });
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    };
    try {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await twoFingerSwipe(zoomScrollBottom, zoomScrollTop);
      await page.waitForFunction(() => window.scrollY > 0, null, {
        timeout: 5000,
      });
      const zoomScrolledDown = await page.evaluate(() => window.scrollY);
      await twoFingerSwipe(zoomScrollTop, zoomScrollBottom);
      await page.waitForFunction((previous) => window.scrollY < previous, zoomScrolledDown, {
        timeout: 5000,
      });
    } finally {
      await touch.detach();
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
    }
    console.log("PASS: Zoom keeps one-finger panning and two-finger remote page scrolling.");
    await mobile.locator("#zoom-button").tap();
    assert.equal(await mobile.locator("#zoom-button").getAttribute("aria-pressed"), "false");
    for (const viewport of [
      { width: 320, height: 740 },
      { width: 844, height: 390 },
      { width: 768, height: 1024 },
    ]) {
      await mobile.setViewportSize(viewport);
      assert.equal(
        await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      if (viewport.width === 768) {
        await assertDesktopDock(mobile, viewport);
        for (const selector of [
          "#back-button",
          "#forward-button",
          "#reload-button",
          "#tabs-button",
          "#more-menu summary",
        ]) {
          const target = await mobile.locator(selector).boundingBox();
          assert.ok(
            target.width >= 44 && target.height >= 44,
            "The narrow desktop layout must retain usable touch targets.",
          );
        }
      }
      if (screenshotDir) {
        await mobile.screenshot({
          path: `${screenshotDir}/mobile-${viewport.width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await assertSessionPlacement(true);
    await mobile.locator("#zoom-button").tap();
    assert.equal(await mobile.locator("#zoom-button").getAttribute("aria-pressed"), "true");
    await mobile.setViewportSize({ width: 1440, height: 1000 });
    await assertSessionPlacement(false);
    await mobile.waitForFunction(
      () =>
        document.querySelector<HTMLElement>("#zoom-button").getAttribute("aria-pressed") ===
        "false",
    );
    assert.equal(await mobile.locator("#zoom-button").isVisible(), false);
    assert.equal(await mobile.locator("#keyboard-button").isVisible(), false);
    assert.equal(
      await mobileInput.isVisible(),
      false,
      "Desktop uses the native keyboard directly on the browser.",
    );
    await mobile.setViewportSize({ width: 390, height: 844 });
    await assertSessionPlacement(true);
    assert.equal(
      await mobile.locator("#zoom-button").getAttribute("aria-pressed"),
      "false",
      "Returning to mobile must preserve Fit mode after desktop resets mobile Zoom.",
    );
    assert.equal(await mobileInput.isVisible(), true);
    assert.equal(await mobileInput.evaluate((input) => input.matches(":placeholder-shown")), true);
    assert.notEqual(
      await mobile.evaluate(() => document.activeElement.id),
      "mobile-keyboard-input",
    );
    await sessionButtons.dispose();
    console.log(
      "PASS: direct mobile typing, native Backspace, Enter and zoom panning work; responsive layouts preserve session controls without overflow.",
    );

    const closed = once(controller.ws, "close");
    await mobile.locator("#mobile-session-actions #release-button").tap();
    assert.equal((await closed)[0], 1008);
    await ui.waitForFunction(
      () => document.querySelector<HTMLElement>("#mode-title").textContent === "Agent control",
    );
    await mobile.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#mobile-keyboard-input").disabled,
    );
    assert.equal(
      await mobileInput.isVisible(),
      true,
      "The mobile dock remains available while the agent has control.",
    );
    assert.equal(await mobileInput.inputValue(), "");
    assert.equal(await mobileInput.evaluate((input) => input.matches(":placeholder-shown")), true);
    await mobile.locator("#mobile-session-actions #take-button").tap();
    await mobile.waitForFunction(
      () => !document.querySelector<HTMLInputElement>("#mobile-keyboard-input").disabled,
    );
    assert.notEqual(
      await mobile.evaluate(() => document.activeElement.id),
      "mobile-keyboard-input",
      "Gaining control must not open the native keyboard without a direct input tap.",
    );
    assert.equal(await mobileInput.evaluate((input) => input.matches(":placeholder-shown")), true);
    await mobileInput.tap();
    assert.equal(await mobile.evaluate(() => document.activeElement.id), "mobile-keyboard-input");
    await mobile.locator("#mobile-session-actions #release-button").tap();
    await mobile.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#mobile-keyboard-input").disabled,
    );
    assert.equal(await mobileInput.isVisible(), true);
    assert.equal(await mobileInput.inputValue(), "");
    assert.notEqual(
      await mobile.evaluate(() => document.activeElement.id),
      "mobile-keyboard-input",
    );
    console.log(
      "PASS: mobile toolbar take/release keeps the dock visible and waits for an explicit tap before opening the keyboard.",
    );
    await openKeys(mobile);
    const mobileKey = await createKey(mobile, "Phone agent");
    await closeKeys(mobile);
    await openKeys(mobile);
    assert.equal(await mobile.locator("#api-key-created").isVisible(), false);
    for (const width of [390, 320]) {
      await mobile.setViewportSize({ width, height: 844 });
      assert.equal(
        await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        "API key settings must not overflow a narrow mobile viewport.",
      );
      for (const selector of ["#api-keys-close", "#api-keys-refresh", "#api-key-create"]) {
        const button = await mobile.locator(selector).boundingBox();
        assert.ok(
          button.width >= 44 && button.height >= 44,
          "API key actions need usable mobile touch targets.",
        );
      }
      if (screenshotDir) {
        await mobile.screenshot({
          path: `${screenshotDir}/api-keys-mobile-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await revokeKey(mobile, mobileKey.key);
    await closeKeys(mobile);
    assert.equal((await api("/api/status")).mode, "agent");
    console.log(
      "PASS: mobile key creation, one-time secret clearing and revocation work in narrow viewports.",
    );
    await mobile.locator("#more-menu summary").click();
    await mobile.locator("#files-button").click();
    await mobile.locator("#files-list img").first().waitFor({ state: "visible" });
    const uploadBox = await mobile.locator("#files-upload-button").boundingBox();
    assert.ok(uploadBox.height >= 44);
    const chooser = mobile.waitForEvent("filechooser");
    await mobile.locator("#files-upload-button").tap();
    await (
      await chooser
    ).setFiles({
      name: "Mobile upload.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Synthetic mobile upload"),
    });
    await mobile.locator("#files-upload-status").waitFor({ state: "visible" });
    const mobileUpload = (await api("/api/artifacts")).files.find(
      (file) => file.kind === "upload" && file.name === "Mobile upload.txt",
    );
    assert.ok(mobileUpload);
    await tool("browser_execute", {
      code: `return await files.uploadTo(page.locator('#attachment'),{id:${JSON.stringify(mobileUpload.id)}});`,
    });
    assert.equal(
      await page.locator("#attachment").evaluate((input) => input.files[0].type),
      "text/plain",
    );
    for (const width of [390, 320]) {
      await mobile.setViewportSize({ width, height: 844 });
      assert.equal(
        await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      if (screenshotDir) {
        await mobile.screenshot({
          path: `${screenshotDir}/files-mobile-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    const mobileUploadRow = mobile.locator(`.file-row[data-file-id="${mobileUpload.id}"]`);
    await mobileUploadRow
      .getByRole("button", { name: "Delete Mobile upload.txt", exact: true })
      .tap();
    await mobileUploadRow.getByRole("button", { name: "Delete file", exact: true }).tap();
    await mobileUploadRow.waitFor({ state: "detached" });
    console.log(
      "PASS: mobile file chooser uploads, agent attachment, touch targets and confirmed document deletion.",
    );
    await mobile.locator("#files-close").click();
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.locator("#take-button").tap();
    await mobile.waitForFunction(
      () => document.querySelector<HTMLElement>("#mode-title").textContent === "You have control",
    );
    await mobile.waitForFunction(
      () => document.querySelector<HTMLElement>("#connection-label").textContent === "Connected",
    );
    const mobileCancelled = rpc("tools/call", {
      name: "browser_execute",
      arguments: { code: 'return "must not execute";' },
    });
    await mobile.locator("#agent-handoff").waitFor({ state: "visible" });
    await mobile.locator("#agent-handoff-cancel").tap();
    assert.match((await mobileCancelled).error.message, /cancelled/u);
    assert.equal((await api("/api/status")).mode, "human");
    await mobile.locator("#release-button").tap();
    await mobile.waitForFunction(
      () => document.querySelector<HTMLElement>("#mode-title").textContent === "Agent control",
    );
    await mobile.locator("#take-button").tap();
    await mobile.waitForFunction(
      () => document.querySelector<HTMLElement>("#mode-title").textContent === "You have control",
    );
    await mobile.waitForFunction(
      () => document.querySelector<HTMLElement>("#connection-label").textContent === "Connected",
    );
    const handoffController = await rawVnc("control");
    const handoffStart = Date.now();
    const automatic = tool("browser_execute", {
      code: "await page.getByLabel('Human input').fill('automatic-agent-handoff'); return await page.getByLabel('Human input').inputValue();",
    });
    await mobile.locator("#agent-handoff").waitFor({ state: "visible" });
    assert.ok((await api("/api/status")).ownsControl);
    assert.notEqual(await page.locator("#human").inputValue(), "automatic-agent-handoff");
    for (const width of [390, 320]) {
      await mobile.setViewportSize({ width, height: 844 });
      const button = await mobile.locator("#agent-handoff-cancel").boundingBox();
      assert.ok(button.height >= 44 && button.x >= 0 && button.x + button.width <= width);
      if (screenshotDir) {
        await mobile.screenshot({
          path: `${screenshotDir}/handoff-mobile-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    assert.equal((await automatic).structuredContent.value, "automatic-agent-handoff");
    assert.ok(
      Date.now() - handoffStart >= 5000,
      "Automatic handoff must wait the full five seconds.",
    );
    await mobile.locator("#agent-handoff").waitFor({ state: "hidden" });
    await mobile.waitForFunction(
      () => document.querySelector<HTMLElement>("#mode-title").textContent === "Agent control",
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    assert.equal(handoffController.ws.readyState, WebSocket.CLOSED);
    assert.equal((await api("/api/status")).mode, "agent");
    console.log(
      "PASS: the same MCP call waits five seconds, revokes interactive VNC, executes and closes mobile handoff popups.",
    );
    await mobileContext.close();
    uiPage = ui;
    await tool("browser_execute", {
      code: "return await page.locator('body').ariaSnapshot();",
    });
    await tool("browser_execute", {
      code: "await page.getByLabel('Human input').fill('agent-resumed'); return await page.getByLabel('Human input').inputValue();",
    });
    assert.equal(await page.locator("#human").inputValue(), "agent-resumed");
    console.log("PASS: release revokes the interactive VNC connection and restores MCP.");

    const marker = `test-${Date.now()}`;
    await tool("browser_execute", {
      code: `await page.evaluate((marker) => { localStorage.setItem('remote-browser-test', marker); document.cookie = 'remote-browser-test=' + marker + '; Max-Age=86400; Path=/; SameSite=Lax'; }, ${JSON.stringify(marker)});`,
    });
    await writeFile("/data/.integration-marker", marker, { mode: 0o600 });
    assert.equal(await page.evaluate(() => localStorage.getItem("remote-browser-test")), marker);
    await ui.locator("#more-menu summary").click();
    await ui.locator("#logout-button").click();
    await ui.locator("#login-screen").waitFor({ state: "visible" });
    assert.equal(await ui.locator("#password").getAttribute("autocomplete"), "current-password");
    assert.equal(await ui.locator("#generate-password").isVisible(), false);
    await ui.locator("#username").fill(testAccount.username);
    await ui.locator("#password").fill(testAccount.password);
    await ui.locator("#login-submit").click();
    await ui.locator("#workspace").waitFor({ state: "visible" });
    await ui.waitForFunction(
      () => document.querySelector<HTMLElement>("#connection-label").textContent === "Connected",
    );
    await ui.locator("#more-menu summary").click();
    await ui.locator("#logout-button").click();
    await ui.locator("#login-screen").waitFor({ state: "visible" });
    console.log("PASS: the configured account signs in again after logout.");
    assert.deepEqual(errors, [], "Dashboard must have no uncaught JavaScript errors.");
    const shutdownRecording = await tool("browser_execute", {
      code: "return await recording.start({name:'Container replacement',maxSeconds:300});",
    });
    await writeFile(
      "/data/.integration-shutdown-recording.json",
      JSON.stringify(shutdownRecording.structuredContent.value),
      { mode: 0o600 },
    );
    console.log("PASS: synthetic persistence state saved. Recreate the container and run verify.");
  }
} catch (cause) {
  if (uiPage && process.env.SCREENSHOT_DIR) {
    await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
    await uiPage
      .screenshot({
        path: `${process.env.SCREENSHOT_DIR}/failure.png`,
        fullPage: true,
        animations: "disabled",
        mask: [uiPage.locator("#api-key-secret")],
      })
      .catch((): void => undefined);
  }
  throw cause;
} finally {
  if (uiCookie) {
    await fetch(`${base}/api/control/release`, {
      method: "POST",
      headers: { Cookie: uiCookie, Origin: origin },
      body: "{}",
    }).catch((): void => undefined);
  }
  await uiBrowser?.close();
  await remote?.close();
  fixture.closeAllConnections();
  fixture.close();
}
