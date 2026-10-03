import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";

import { asyncHandler } from "../src/async-boundary.js";
import { createGateway } from "../src/server.js";

const token = "test-only-access-token-".repeat(3);
const credentials = {
  username: "test-owner",
  password: "fixture-only-password-123!",
};
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, options = {}) {
  const { configured = true, accountFile: existingAccountFile, ...gatewayOptions } = options;
  const directory = existingAccountFile
    ? null
    : await mkdtemp(path.join(tmpdir(), "remote-browser-gateway-"));
  const accountFile = existingAccountFile || path.join(directory, "account.json");
  const gateway = createGateway({
    token,
    accountFile,
    probe: async () => true,
    ...gatewayOptions,
  });
  const base = await listen(gateway.server);
  const close = async () => {
    gateway.server.closeAllConnections();
    if (gateway.server.listening) {
      await new Promise((resolve) => {
        gateway.server.close(resolve);
      });
    }
  };
  t.after(async () => {
    await close();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const post = async (url, body, cookie, extra = {}) =>
    fetch(base + url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: base,
        ...(cookie ? { Cookie: cookie } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    });
  const login = async () => {
    const response = await post("/api/login", credentials);
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  if (configured) {
    const setup = await post("/api/auth/setup", credentials);
    assert.equal(setup.status, 201);
  }
  return { ...gateway, base, post, login, accountFile, close };
}

test("first visit creates the only dashboard account and an authenticated session", async (t) => {
  const f = await fixture(t, { configured: false });
  const status = async (cookie) =>
    (
      await fetch(`${f.base}/api/auth/status`, {
        headers: cookie ? { Cookie: cookie } : {},
      })
    ).json();
  assert.deepEqual(await status(), { configured: false, authenticated: false });
  assert.equal(
    (
      await f.post("/api/auth/setup", credentials, null, {
        Origin: "http://evil.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${f.base}/api/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      })
    ).status,
    403,
  );
  assert.deepEqual(await status(), { configured: false, authenticated: false });

  const setup = await f.post("/api/auth/setup", credentials);
  assert.equal(setup.status, 201);
  assert.deepEqual(await setup.json(), { authenticated: true });
  const cookieHeader = setup.headers.get("set-cookie");
  assert.match(cookieHeader, /HttpOnly/u);
  assert.match(cookieHeader, /SameSite=Strict/u);
  const cookie = cookieHeader.split(";")[0];
  assert.deepEqual(await status(cookie), {
    configured: true,
    authenticated: true,
  });
  assert.deepEqual(await status(), { configured: true, authenticated: false });
  assert.equal((await fetch(`${f.base}/api/status`, { headers: { Cookie: cookie } })).status, 200);

  const replacement = {
    username: "replacement-owner",
    password: "another-test-password-123!",
  };
  assert.equal((await f.post("/api/auth/setup", replacement)).status, 409);
  assert.equal((await f.post("/api/auth/setup", replacement, cookie)).status, 409);
  assert.equal((await f.post("/api/login", replacement)).status, 401);
  await f.login();
});

test("dashboard credentials survive gateway recreation while old sessions expire", async (t) => {
  const first = await fixture(t);
  const oldCookie = await first.login();
  await first.close();
  const second = await fixture(t, {
    configured: false,
    accountFile: first.accountFile,
  });
  const status = await fetch(`${second.base}/api/auth/status`, {
    headers: { Cookie: oldCookie },
  });
  assert.deepEqual(await status.json(), {
    configured: true,
    authenticated: false,
  });
  assert.equal(
    (
      await fetch(`${second.base}/api/status`, {
        headers: { Cookie: oldCookie },
      })
    ).status,
    401,
  );
  assert.equal((await second.post("/api/auth/setup", credentials)).status, 409);
  const newCookie = await second.login();
  assert.notEqual(newCookie, oldCookie);
  assert.equal(
    (
      await fetch(`${second.base}/api/status`, {
        headers: { Cookie: newCookie },
      })
    ).status,
    200,
  );
});

test("authentication, CSRF and separate MCP credentials are enforced", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/api/status`)).status, 401);
  assert.equal(
    (
      await f.post("/api/login", credentials, null, {
        Origin: "http://evil.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.post("/api/login", {
        ...credentials,
        password: "incorrect-test-password",
      })
    ).status,
    401,
  );
  assert.equal(
    (await f.post("/api/login", { ...credentials, username: "unknown-owner" })).status,
    401,
  );
  assert.equal((await f.post("/api/login", { token })).status, 401);
  const cookie = await f.login();
  assert.equal((await fetch(`${f.base}/api/status`, { headers: { Cookie: cookie } })).status, 200);
  assert.deepEqual(
    await (
      await fetch(`${f.base}/api/auth/status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json(),
    { configured: true, authenticated: false },
  );
  assert.equal(
    (await f.post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, cookie)).status,
    403,
  );
  assert.equal(
    (
      await f.post("/api/control/take", {}, cookie, {
        Origin: "https://evil.invalid",
      })
    ).status,
    403,
  );
  assert.equal((await f.post("/api/logout", {}, cookie)).status, 200);
  assert.equal((await fetch(`${f.base}/api/status`, { headers: { Cookie: cookie } })).status, 401);
});

test("disconnecting a caller does not hand over a still-running operation", async (t) => {
  let release;
  let started;
  const hasStarted = new Promise((resolve) => {
    started = resolve;
  });
  const upstreamServer = http.createServer(
    asyncHandler(async (req: http.IncomingMessage, res: http.ServerResponse) => {
      for await (const _chunk of req) {
        /* Drain the request. */
      }
      started();
      await new Promise((resolve) => {
        release = resolve;
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    }),
  );
  const upstream = await listen(upstreamServer);
  t.after(() => {
    upstreamServer.closeAllConnections();
    upstreamServer.close();
  });
  const f = await fixture(t, { upstream });
  const cookie = await f.login();
  const abort = new AbortController();
  const request = fetch(`${f.base}/mcp`, {
    method: "POST",
    signal: abort.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_click" },
    }),
  }).catch(() => null);
  await hasStarted;
  abort.abort();
  await request;
  const taking = await f.post("/api/control/take", {}, cookie);
  assert.equal(taking.status, 202);
  assert.equal((await taking.json()).mode, "pending");
  const rejected = await f.post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call" }, null, {
    Authorization: `Bearer ${token}`,
  });
  assert.match((await rejected.json()).error.message, /Human control/u);
  assert.equal(f.control.active, 1);
  release();
  for (let i = 0; i < 100 && f.control.active; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.equal(f.control.active, 0);
  assert.equal(f.control.status().mode, "human");
});

test("lost upstream completion blocks subsequent automation and takeover", async (t) => {
  const upstreamServer = http.createServer((req, _res) => req.socket.destroy());
  const upstream = await listen(upstreamServer);
  t.after(() => upstreamServer.close());
  const f = await fixture(t, { upstream });
  const cookie = await f.login();
  const response = await f.post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call" }, null, {
    Authorization: `Bearer ${token}`,
  });
  assert.equal(response.status, 502);
  assert.equal(f.control.status().ready, false);
  assert.equal((await f.post("/api/control/take", {}, cookie)).status, 503);
});

test("logout revokes a takeover request still waiting for readiness", async (t) => {
  let releaseProbe;
  let probeStarted;
  const started = new Promise((resolve) => {
    probeStarted = resolve;
  });
  const f = await fixture(t, {
    probe: async () => {
      probeStarted();
      return new Promise((resolve) => {
        releaseProbe = resolve;
      });
    },
  });
  const cookie = await f.login();
  const takeover = f.post("/api/control/take", {}, cookie);
  await started;
  assert.equal((await f.post("/api/logout", {}, cookie)).status, 200);
  releaseProbe(true);
  assert.equal((await takeover).status, 401);
  assert.equal(f.control.owner, null);
});

test("interactive VNC requires the lease owner and is revoked on release", async (t) => {
  const tcp = net.createServer((socket) => {
    socket.write("RFB 003.008\n");
    socket.on("error", (): void => undefined);
  });
  await listen(tcp);
  t.after(() => tcp.close());
  const f = await fixture(t, {
    viewPort: tcp.address().port,
    controlPort: tcp.address().port,
  });
  const cookie = await f.login();
  const other = await f.login();
  const connect = (mode, session = cookie) =>
    new WebSocket(`${f.base.replace("http:", "ws:")}/vnc?mode=${mode}`, {
      headers: { Cookie: session, Origin: f.base },
    });
  const rejected = connect("control");
  await once(rejected, "error");
  assert.equal((await f.post("/api/control/take", {}, cookie)).status, 200);
  assert.equal((await f.post("/api/control/take", {}, other)).status, 409);
  const alien = connect("control", other);
  await once(alien, "error");
  const viewer = connect("control");
  await once(viewer, "open");
  const closed = once(viewer, "close");
  await f.post("/api/control/release", {}, cookie);
  const [code] = await closed;
  assert.equal(code, 1008);
});

test("signing in again replaces the session and revokes its active control socket", async (t) => {
  const tcp = net.createServer((socket) => {
    socket.write("RFB 003.008\n");
    socket.on("error", (): void => undefined);
  });
  await listen(tcp);
  t.after(() => tcp.close());
  const f = await fixture(t, {
    viewPort: tcp.address().port,
    controlPort: tcp.address().port,
  });
  const cookie = await f.login();
  assert.equal((await f.post("/api/control/take", {}, cookie)).status, 200);
  const viewer = new WebSocket(`${f.base.replace("http:", "ws:")}/vnc?mode=control`, {
    headers: { Cookie: cookie, Origin: f.base },
  });
  await once(viewer, "open");
  const closed = once(viewer, "close");
  const response = await f.post("/api/login", credentials, cookie);
  assert.equal(response.status, 200);
  const replacement = response.headers.get("set-cookie").split(";")[0];
  assert.notEqual(replacement, cookie);
  assert.equal((await closed)[0], 1008);
  assert.equal(f.control.owner, null);
  assert.equal((await fetch(`${f.base}/api/status`, { headers: { Cookie: cookie } })).status, 401);
  assert.equal(
    (await fetch(`${f.base}/api/status`, { headers: { Cookie: replacement } })).status,
    200,
  );
});
