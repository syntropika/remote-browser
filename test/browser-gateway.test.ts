import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGateway } from "../src/server.js";
import { BrowserError } from "../src/browser.js";

const token = "browser-gateway-test-token-".repeat(3);
const state = {
  tabs: [{ id: "tab-1", title: "Fixture", url: "https://example.org/" }],
  activeId: "tab-1",
};

async function fixture(t, options = {}) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "remote-browser-native-gateway-"),
  );
  const actions = [];
  const browserService = {
    listTabs: async () => state,
    action: async (input, { beforeMutation }) => {
      beforeMutation();
      actions.push(input);
      return state;
    },
  };
  const gateway = createGateway({
    token,
    accountFile: path.join(directory, "account.json"),
    probe: async () => true,
    browserService,
    ...options,
  });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const session = gateway.auth.createSession();
  const cookie = gateway.auth.cookie(session).split(";")[0];
  const get = (route, headers = { Cookie: cookie }) =>
    fetch(base + route, { headers });
  const post = (route, body = {}, headers = {}) =>
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
  t.after(async () => {
    gateway.server.closeAllConnections();
    await new Promise((resolve) => gateway.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { ...gateway, actions, base, session, cookie, get, post };
}

test("native browser APIs use dashboard sessions and mutations require same-origin human control", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get("/api/browser/tabs", {})).status, 401);
  assert.equal(
    (await f.get("/api/browser/tabs", { Authorization: `Bearer ${token}` }))
      .status,
    403,
  );
  assert.deepEqual(await (await f.get("/api/browser/tabs")).json(), state);
  const input = {
    action: "navigate",
    tabId: "tab-1",
    url: "https://example.org/",
  };
  assert.equal((await f.post("/api/browser/action", input)).status, 409);
  f.control.take(f.session);
  assert.equal(
    (
      await f.post("/api/browser/action", input, {
        Origin: "http://evil.invalid",
      })
    ).status,
    403,
  );
  const missingOrigin = await fetch(`${f.base}/api/browser/action`, {
    method: "POST",
    headers: { Cookie: f.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(
    (
      await f.post("/api/browser/action", input, {
        Authorization: `Bearer ${token}`,
      })
    ).status,
    403,
  );
  const other = f.auth.createSession();
  assert.equal(
    (
      await f.post("/api/browser/action", input, {
        Cookie: f.auth.cookie(other).split(";")[0],
      })
    ).status,
    409,
  );
  assert.equal((await f.post("/api/browser/action", input)).status, 200);
  assert.deepEqual(f.actions, [input]);
});

test("native input is denied while the browser service is unavailable", async (t) => {
  const f = await fixture(t, { probe: async () => false });
  f.control.take(f.session);
  assert.equal((await f.get("/api/browser/tabs")).status, 503);
  assert.equal(
    (await f.post("/api/browser/action", { action: "reload" })).status,
    503,
  );
  assert.equal(f.actions.length, 0);
});

test("native mutations and MCP cannot overlap, even when control is released during a native action", async (t) => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, {
    browserService: {
      listTabs: async () => state,
      action: async (input, { beforeMutation }) => {
        beforeMutation();
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
        return state;
      },
    },
  });
  f.control.take(f.session);
  const action = f.post("/api/browser/action", { action: "reload" });
  await startedPromise;
  assert.equal(f.control.canControl(f.session), true);
  assert.equal(
    (await f.post("/api/browser/action", { action: "reload" })).status,
    409,
  );
  assert.equal((await f.post("/api/control/release")).status, 200);
  const agent = await f.post(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_navigate" },
    },
    { Authorization: `Bearer ${token}` },
  );
  assert.match((await agent.json()).error.message, /Another browser operation/);
  assert.equal(f.control.active, 1);
  release();
  assert.equal((await action).status, 200);
  assert.equal(f.control.active, 0);
  f.control.begin()();
});

test("logging out during a native operation prevents the later CDP mutation", async (t) => {
  let continueRead;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  let mutated = false;
  const f = await fixture(t, {
    browserService: {
      action: async (input, { beforeMutation }) => {
        started();
        await new Promise((resolve) => {
          continueRead = resolve;
        });
        beforeMutation();
        mutated = true;
        return state;
      },
    },
  });
  f.control.take(f.session);
  const action = f.post("/api/browser/action", { action: "reload" });
  await startedPromise;
  assert.equal((await f.post("/api/logout")).status, 200);
  continueRead();
  assert.equal((await action).status, 401);
  assert.equal(mutated, false);
  assert.equal(f.control.active, 0);
  assert.equal(f.control.fault, null);
});

test("uncertain native completion fails closed for both agent and human access", async (t) => {
  const f = await fixture(t, {
    browserService: {
      action: async () => {
        throw new BrowserError(
          "The browser took too long to respond.",
          504,
          true,
        );
      },
    },
  });
  f.control.take(f.session);
  assert.equal(
    (await f.post("/api/browser/action", { action: "reload" })).status,
    504,
  );
  assert.equal(f.control.status(f.session).ready, false);
  assert.equal(f.control.canControl(f.session), false);
  f.control.release(f.session);
  assert.throws(() => f.control.begin(), /Restart/);
});
