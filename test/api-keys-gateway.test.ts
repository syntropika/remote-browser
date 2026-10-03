import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { asyncHandler } from "../src/async-boundary.js";
import { createGateway } from "../src/server.js";

const token = "synthetic-api-key-gateway-token-".repeat(2);
const rpc = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "browser_click" },
};
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, options = {}) {
  const directory =
    options.directory || (await mkdtemp(path.join(tmpdir(), "remote-browser-keys-gateway-")));
  const gateway = createGateway({
    token,
    accountFile: path.join(directory, "account.json"),
    probe: async () => true,
    ...options,
  });
  const base = await listen(gateway.server);
  const session = gateway.auth.createSession();
  const cookie = gateway.auth.cookie(session).split(";")[0];
  const post = async (route, body, headers = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: base,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const list = async () => fetch(`${base}/api/keys`, { headers: { Cookie: cookie } });
  const create = async (name = "Fixture agent") => {
    const response = await post("/api/keys", { name });
    assert.equal(response.status, 201);
    return response.json();
  };
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
    if (!options.directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    ...gateway,
    directory,
    base,
    session,
    cookie,
    post,
    list,
    create,
    close,
  };
}
function delayedRequest(base, route, headers) {
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = http.request(
    base + route,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
    },
    (res) => {
      res.resume();
      resolveResponse(res.statusCode);
    },
  );
  // oxlint-disable-next-line typescript/no-deprecated -- ClientRequest errors use Node’s native EventEmitter interface.
  request.on("error", rejectResponse);
  request.write("{");
  return { request, response };
}

test("only a dashboard session can manage keys and mutation requests require same-origin JSON", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/api/keys`)).status, 401);
  for (const route of ["/api/keys", "/api/keys/revoke"]) {
    assert.equal(
      (
        await fetch(f.base + route, {
          method: "POST",
          headers: {
            Origin: f.base,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await f.post(route, {}, { Origin: "http://evil.invalid" })).status, 403);
    assert.equal(
      (
        await fetch(f.base + route, {
          method: "POST",
          headers: { Cookie: f.cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await fetch(`${f.base}/api/keys`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    403,
  );
  assert.equal((await f.post("/api/keys", { name: "" })).status, 400);
  assert.equal((await f.post("/api/keys", { name: "x".repeat(65) })).status, 400);
  assert.equal((await f.post("/api/keys", { name: "Line\nbreak" })).status, 400);
  assert.equal((await f.post("/api/keys", { name: "x".repeat(5000) })).status, 400);
  assert.equal((await f.post("/api/keys/revoke", { id: "missing" })).status, 404);
  const { key, secret } = await f.create();
  assert.equal((await f.post("/api/keys", {}, { Authorization: `Bearer ${secret}` })).status, 403);
  assert.equal(
    (await f.post("/api/control/take", {}, { Authorization: `Bearer ${secret}` })).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${f.base}/api/status`, {
        headers: { Authorization: `Bearer ${secret}` },
      })
    ).status,
    200,
  );
  const response = await f.list();
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!body.includes(secret));
  assert.ok(!body.includes("hash"));
  assert.equal(JSON.parse(body).keys.find((entry) => entry.id === key.id).name, key.name);
  const persisted = await readFile(path.join(f.directory, "api-keys.json"), "utf-8");
  assert.ok(!persisted.includes(secret));
});

test("all MCP verbs use managed credentials and revocation survives gateway recreation", async (t) => {
  const methods = [];
  const upstreamServer = http.createServer(
    asyncHandler(async (req: http.IncomingMessage, res: http.ServerResponse) => {
      for await (const _chunk of req) {
        /* Drain the request. */
      }
      methods.push(req.method);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }),
  );
  const upstream = await listen(upstreamServer);
  t.after(() => {
    upstreamServer.closeAllConnections();
    upstreamServer.close();
  });
  const first = await fixture(t, { upstream });
  const { key, secret } = await first.create();
  const other = await first.create("Another agent");
  const call = async (f, method, credential) =>
    fetch(`${f.base}/mcp`, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: JSON.stringify(rpc) } : {}),
    });
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await call(first, method, secret);
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.deepEqual(methods, ["GET", "POST", "DELETE"]);
  assert.equal((await first.post("/api/keys/revoke", { id: key.id })).status, 200);
  const legacy = (await (await first.list()).json()).keys.find((entry) => entry.legacy);
  assert.equal((await first.post("/api/keys/revoke", { id: legacy.id })).status, 200);
  for (const method of ["GET", "POST", "DELETE"]) {
    assert.equal((await call(first, method, secret)).status, 401);
    assert.equal((await call(first, method, token)).status, 401);
  }
  const active = await call(first, "POST", other.secret);
  assert.equal(active.status, 200);
  await active.text();
  await first.close();
  const second = await fixture(t, { directory: first.directory, upstream });
  assert.equal((await call(second, "POST", secret)).status, 401);
  assert.equal((await call(second, "POST", token)).status, 401);
  const survived = await call(second, "POST", other.secret);
  assert.equal(survived.status, 200);
  await survived.text();
});

test("revocation blocks a previously authorized MCP POST still waiting for its body", async (t) => {
  let dispatched = false;
  const upstreamServer = http.createServer((req, res) => {
    dispatched = true;
    res.end("{}");
  });
  const upstream = await listen(upstreamServer);
  t.after(() => {
    upstreamServer.closeAllConnections();
    upstreamServer.close();
  });
  const f = await fixture(t, { upstream });
  const { key, secret } = await f.create();
  let identified;
  const identifiedPromise = new Promise((resolve) => {
    identified = resolve;
  });
  const authenticate = f.apiKeys.authenticate.bind(f.apiKeys);
  f.apiKeys.authenticate = async (value) => {
    const identity = await authenticate(value);
    identified();
    return identity;
  };
  const slow = delayedRequest(f.base, "/mcp", {
    Authorization: `Bearer ${secret}`,
  });
  await identifiedPromise;
  assert.equal((await f.post("/api/keys/revoke", { id: key.id })).status, 200);
  slow.request.end(JSON.stringify(rpc).slice(1));
  assert.equal(await slow.response, 401);
  assert.equal(dispatched, false);
  assert.equal(f.control.active, 0);
});

test("session expiry while reading a management body cannot issue a key", async (t) => {
  const f = await fixture(t);
  await f.apiKeys.initialize();
  const slow = delayedRequest(f.base, "/api/keys", {
    Cookie: f.cookie,
    Origin: f.base,
  });
  f.auth.sessions.delete(f.session);
  slow.request.end('"name":"Expired"}');
  assert.equal(await slow.response, 401);
  assert.equal((await f.apiKeys.list()).length, 1);
});

test("revoking a key terminates its active MCP GET notification stream", async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const upstreamServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: test\ndata: {}\n\n");
    res.on("close", upstreamClosed);
  });
  const upstream = await listen(upstreamServer);
  t.after(() => {
    upstreamServer.closeAllConnections();
    upstreamServer.close();
  });
  const f = await fixture(t, { upstream });
  const { key, secret } = await f.create();
  const response = await fetch(`${f.base}/mcp`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();
  const read = reader.read().then(
    () => false,
    () => true,
  );
  assert.equal((await f.post("/api/keys/revoke", { id: key.id })).status, 200);
  assert.equal(await read, true);
  await closed;
  assert.equal(f.control.active, 0);
  assert.equal(f.control.fault, null);
});

test("revocation disconnects an active mutation but preserves its control guard until completion", async (t) => {
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
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    }),
  );
  const upstream = await listen(upstreamServer);
  t.after(() => {
    release?.();
    upstreamServer.closeAllConnections();
    upstreamServer.close();
  });
  const f = await fixture(t, { upstream });
  const { key, secret } = await f.create();
  const pending = fetch(`${f.base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(rpc),
  }).then(
    () => false,
    () => true,
  );
  await hasStarted;
  assert.equal((await f.post("/api/keys/revoke", { id: key.id })).status, 200);
  assert.equal(await pending, true);
  assert.equal(f.control.active, 1);
  assert.equal((await f.post("/api/control/take", {})).status, 202);
  assert.equal(f.control.canControl(f.session), false);
  release();
  for (let attempt = 0; attempt < 100 && f.control.active; attempt++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.equal(f.control.active, 0);
  assert.equal(f.control.fault, null);
  assert.equal(f.control.canControl(f.session), true);
});
