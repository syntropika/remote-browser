import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { asyncHandler } from "../src/async-boundary.js";
import { createGateway } from "../src/server.js";

const token = "synthetic-code-mode-token-".repeat(3);
const call = (name, args = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});
const execution = () => call("browser_execute", { code: "return await page.title();" });
const completion = (value = "Fixture", fields = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  result: {
    content: [
      {
        type: "text",
        text: `### Result\n${JSON.stringify({ __remoteBrowserCodeMode: 1, ok: true, value, images: [], durationMs: 1, ...fields })}\n### Ran Playwright code\nPRIVATE_SCRIPT`,
      },
    ],
  },
});
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, handler, options = {}) {
  const upstreamServer = http.createServer(
    asyncHandler(async (req: http.IncomingMessage, res: http.ServerResponse) => {
      try {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString();
        await handler(req, res, body ? JSON.parse(body) : null);
      } catch (cause) {
        res.destroy(cause);
      }
    }),
  );
  const upstream = await listen(upstreamServer);
  const directory = await mkdtemp(path.join(tmpdir(), "remote-browser-code-mode-"));
  const gateway = createGateway({
    token,
    accountFile: path.join(directory, "account.json"),
    probe: async () => true,
    upstream,
    ...options,
  });
  const base = await listen(gateway.server);
  const session = gateway.auth.createSession();
  const cookie = gateway.auth.cookie(session).split(";")[0];
  const rpc = async (message, extra = {}) =>
    fetch(`${base}/mcp`, {
      ...extra,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "mcp-session-id": "fixture-session",
        "mcp-protocol-version": "2025-11-25",
        ...extra.headers,
      },
      body: JSON.stringify(message),
    });
  const post = async (route, body = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: base,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  t.after(async () => {
    gateway.server.closeAllConnections();
    upstreamServer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => {
        gateway.server.close(resolve);
      }),
      new Promise((resolve) => {
        upstreamServer.close(resolve);
      }),
    ]);
    await rm(directory, { recursive: true, force: true });
  });
  return { ...gateway, rpc, post, session, cookie, base };
}
function json(res, value, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "mcp-session-id": "fixture-session",
  });
  res.end(JSON.stringify(value));
}

test("docs work during human control and execution requires a connected handoff dashboard", async (t) => {
  const seen = [];
  const f = await fixture(t, async (req, res, message) => {
    seen.push(message);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["mcp-session-id"], "fixture-session");
    assert.equal(req.headers["mcp-protocol-version"], "2025-11-25");
    json(res, { jsonrpc: "2.0", id: message.id, result: {} });
  });
  assert.equal((await f.post("/api/control/take")).status, 200);
  const docs = await f.rpc(call("browser_docs", { topic: "interaction" }));
  assert.equal(docs.headers.get("mcp-session-id"), "fixture-session");
  assert.match((await docs.json()).result.content[0].text, /getByRole/u);
  assert.deepEqual(seen, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  assert.match((await (await f.rpc(execution())).json()).error.message, /Human control/u);
  assert.equal(seen.length, 1);
  assert.equal(
    (
      await f.rpc(call("browser_docs"), {
        headers: { Authorization: "Bearer incorrect" },
      })
    ).status,
    401,
  );
});

async function controlEvents(t, f) {
  const abort = new AbortController();
  const response = await fetch(`${f.base}/api/control/events`, {
    headers: { Cookie: f.cookie },
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  t.after(() => {
    abort.abort();
  });
  await reader.read();
  return { abort, reader };
}

async function pendingRequest(f) {
  const deadline = Date.now() + 3000;
  while (!f.control.agentRequest && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  assert.ok(f.control.agentRequest, "A connected dashboard must receive a pending request.");
  return f.control.agentRequest.id;
}

test("a connected dashboard receives a countdown and the same MCP execution continues after handoff", async (t) => {
  let executed = 0;
  const f = await fixture(
    t,
    async (req, res) => {
      executed++;
      json(res, completion("Automatic handoff"));
    },
    { agentTakeoverMs: 80 },
  );
  await f.post("/api/control/take");
  const events = await controlEvents(t, f);
  const pending = f.rpc(execution());
  await pendingRequest(f);
  assert.equal(f.control.canControl(f.session), true);
  assert.equal(executed, 0);
  const frame = new TextDecoder().decode((await events.reader.read()).value);
  assert.match(frame, /"agentRequest":\{"id"/u);
  assert.match(frame, /"canCancel":true/u);
  const result = await (await pending).json();
  assert.equal(result.result.structuredContent.value, "Automatic handoff");
  assert.equal(executed, 1);
  assert.equal(f.control.canControl(f.session), false);
  assert.equal(f.control.active, 0);
});

test("cancellation is owner-only, same-origin, and prevents execution and prompt retry loops", async (t) => {
  let executed = 0;
  const f = await fixture(t, async (req, res) => {
    executed++;
    json(res, completion());
  });
  await f.post("/api/control/take");
  await controlEvents(t, f);
  const pending = f.rpc(execution());
  const id = await pendingRequest(f);
  const route = `${f.base}/api/control/agent/cancel`;
  assert.equal(
    (
      await fetch(route, {
        method: "POST",
        headers: { Cookie: f.cookie, Origin: "http://evil.invalid" },
        body: JSON.stringify({ id }),
      })
    ).status,
    403,
  );
  const other = f.auth.cookie(f.auth.createSession()).split(";")[0];
  assert.equal(
    (
      await fetch(route, {
        method: "POST",
        headers: { Cookie: other, Origin: f.base },
        body: JSON.stringify({ id }),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetch(route, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Origin: f.base },
        body: JSON.stringify({ id }),
      })
    ).status,
    403,
  );
  assert.equal((await f.post("/api/control/agent/cancel", { id: "stale" })).status, 409);
  assert.equal((await f.post("/api/control/agent/cancel", { id })).status, 200);
  assert.match((await (await pending).json()).error.message, /cancelled/u);
  assert.match((await (await f.rpc(execution())).json()).error.message, /30 seconds/u);
  assert.equal(executed, 0);
  assert.equal(f.control.canControl(f.session), true);
});

test("revoking a waiting key and disconnecting the dashboard both cancel handoffs without browser calls", async (t) => {
  let executed = 0;
  const f = await fixture(t, async (req, res) => {
    executed++;
    json(res, completion());
  });
  await f.post("/api/control/take");
  const events = await controlEvents(t, f);
  const disconnected = f.rpc(execution());
  await pendingRequest(f);
  events.abort.abort();
  assert.match((await (await disconnected).json()).error.message, /dashboard connection was lost/u);
  assert.equal(f.control.canControl(f.session), true);
  await controlEvents(t, f);
  const pending = f.rpc(execution()).catch(() => null);
  await pendingRequest(f);
  const key = (await f.apiKeys.list())[0];
  await f.apiKeys.revoke(key.id);
  await pending;
  assert.equal(f.control.agentRequest, null);
  assert.equal(executed, 0);
  assert.equal(f.control.canControl(f.session), true);
});

test("discovery and invalid code never create handoff prompts", async (t) => {
  const f = await fixture(t, async (req, res) => {
    json(res, completion());
  });
  await f.post("/api/control/take");
  await controlEvents(t, f);
  await f.rpc(call("browser_docs"));
  const invalid = await (await f.rpc(call("browser_execute", { code: "return {" }))).json();
  assert.match(invalid.error.message, /Human control/u);
  assert.equal(f.control.agentRequest, null);
});

test("session and protocol errors are passed through instead of fabricating tool results", async (t) => {
  const error = {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32_000, message: "Unknown MCP session" },
  };
  const f = await fixture(t, async (req, res) => {
    json(res, error, 404);
  });
  for (const message of [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    call("browser_docs"),
    execution(),
  ]) {
    const response = await f.rpc(message);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), error);
  }
  assert.equal(f.control.fault, null);
});

test("chunked SSE returns images and metadata while preserving notification frames", async (t) => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  const notification =
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"data":"Progress"}}\n\n';
  const f = await fixture(t, async (req, res, message) => {
    assert.equal(message.params.name, "browser_run_code_unsafe");
    const source = `: keep-alive\n\n${notification}event: message\ndata: ${JSON.stringify(completion("Screenshot", { images: [{ mimeType: "image/png", data: png }] }))}\n\n`;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (let offset = 0; offset < source.length; offset += 7) {
      res.write(source.slice(offset, offset + 7));
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
    res.end();
  });
  const output = await (await f.rpc(execution())).text();
  assert.ok(output.startsWith(`: keep-alive\n\n${notification}`));
  const { result } = output
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .find((item) => item.id === 1);
  assert.equal(result.structuredContent.value, "Screenshot");
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].data, png);
  assert.equal(result.content[0].text.includes(png), false);
  assert.equal(output.includes("PRIVATE_SCRIPT"), false);
  assert.equal(f.control.fault, null);
});

test("disconnect and key revocation do not release an executing browser operation", async (t) => {
  let started;
  let release;
  const hasStarted = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, async (req, res) => {
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
    json(res, completion());
  });
  t.after(() => release?.());
  const keyResponse = await f.post("/api/keys", { name: "Disposable agent" });
  const { key, secret } = await keyResponse.json();
  const request = f.rpc(execution(), { headers: { Authorization: `Bearer ${secret}` } }).then(
    () => false,
    () => true,
  );
  await hasStarted;
  assert.equal((await f.post("/api/keys/revoke", { id: key.id })).status, 200);
  assert.equal(await request, true);
  assert.equal(f.control.active, 1);
  assert.equal((await f.post("/api/control/take")).status, 202);
  assert.equal(f.control.canControl(f.session), false);
  release();
  for (let i = 0; i < 100 && f.control.active; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.equal(f.control.active, 0);
  assert.equal(f.control.fault, null);
  assert.equal(f.control.canControl(f.session), true);
});

test("normal script errors complete the operation without poisoning the handoff", async (t) => {
  const f = await fixture(t, async (req, res) => {
    json(
      res,
      completion(null, {
        ok: false,
        error: { name: "Error", message: "Element not found" },
      }),
    );
  });
  const { result } = await (await f.rpc(execution())).json();
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.message, "Element not found");
  assert.equal(f.control.fault, null);
  assert.equal((await f.post("/api/control/take")).status, 200);
});

test("malformed execution responses and timeouts preserve an unknown-completion fault", async (t) => {
  await t.test("malformed JSON", async (localT) => {
    const f = await fixture(localT, async (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{broken");
    });
    assert.equal((await f.rpc(execution())).status, 502);
    assert.equal(f.control.status().ready, false);
    assert.equal((await f.post("/api/control/take")).status, 503);
  });
  await t.test("timeout", async (localT) => {
    const f = await fixture(localT, async (): void => undefined, { upstreamTimeoutMs: 25 });
    assert.equal((await f.rpc(execution())).status, 502);
    assert.equal(f.control.status().ready, false);
  });
  await t.test("upstream failure", async (localT) => {
    const f = await fixture(localT, async (req, res) => {
      json(res, { error: "Unavailable" }, 503);
    });
    assert.equal((await f.rpc(execution())).status, 503);
    assert.equal(f.control.status().ready, false);
  });
});
