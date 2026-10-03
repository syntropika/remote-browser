import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGateway } from "../src/server.js";
import { validateClipboardText } from "../src/clipboard.js";

const token = "clipboard-gateway-test-token-".repeat(3);
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "remote-browser-clipboard-"),
  );
  let text = "Synthetic clipboard";
  const gateway = createGateway({
    token,
    accountFile: path.join(directory, "account.json"),
    probe: async () => true,
    clipboardService: {
      read: async () => text,
      write: async (value, { beforeMutation }) => {
        validateClipboardText(value);
        beforeMutation();
        text = value;
      },
    },
    ...overrides,
  });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const session = gateway.auth.createSession();
  const cookie = gateway.auth.cookie(session).split(";")[0];
  const get = (headers = {}) =>
    fetch(`${base}/api/clipboard`, { headers: { Cookie: cookie, ...headers } });
  const post = (body, headers = {}, route = "/api/clipboard") =>
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
  return { ...gateway, session, cookie, base, get, post, text: () => text };
}

test("clipboard access requires its dashboard control owner and same-origin writes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get({ Cookie: "" })).status, 401);
  assert.equal((await f.get({ Authorization: `Bearer ${token}` })).status, 403);
  assert.equal(
    (await f.post({ text: "blocked" }, { Authorization: `Bearer ${token}` }))
      .status,
    403,
  );
  assert.equal((await f.get()).status, 409);
  assert.equal((await f.post({ text: "blocked" })).status, 409);
  f.control.take(f.session);
  const other = f.auth.cookie(f.auth.createSession()).split(";")[0];
  assert.equal((await f.get({ Cookie: other })).status, 409);
  assert.equal(
    (await f.post({ text: "blocked" }, { Cookie: other })).status,
    409,
  );
  assert.equal(
    (await f.post({ text: "blocked" }, { Origin: "http://evil.invalid" }))
      .status,
    403,
  );
  assert.equal((await f.post({ text: "blocked" }, { Origin: "" })).status, 403);
  const text = "café 😀 日本語 العربية\nSecond line";
  assert.equal((await f.post({ text })).status, 200);
  const read = await f.get();
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.deepEqual(await read.json(), { text });
  for (const value of [null, 12, "text\0more"])
    assert.equal((await f.post({ text: value })).status, 400);
  assert.equal((await f.post({ text: "😀".repeat(16385) })).status, 413);
  assert.equal(f.text(), text);
});

test("clipboard transfer is unavailable when the desktop is unavailable", async (t) => {
  const f = await fixture(t, { probe: async () => false });
  f.control.take(f.session);
  assert.equal((await f.get()).status, 503);
  assert.equal((await f.post({ text: "blocked" })).status, 503);
});

test("pending clipboard writes keep MCP blocked after releasing human control", async (t) => {
  let resume, started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, {
    clipboardService: {
      write: async (_text, { beforeMutation }) => {
        beforeMutation();
        started();
        await new Promise((resolve) => {
          resume = resolve;
        });
      },
    },
  });
  f.control.take(f.session);
  const pending = f.post({ text: "fixture" });
  await entered;
  assert.equal((await f.post({ text: "overlap" })).status, 409);
  f.control.release(f.session);
  assert.throws(() => f.control.begin(), /Another browser operation/);
  resume();
  assert.equal((await pending).status, 200);
  assert.equal(f.control.active, 0);
  f.control.begin()();
});

test("a clipboard read is not returned after its session or lease ends", async (t) => {
  for (const change of ["logout", "release"]) {
    let resume, started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const f = await fixture(t, {
      clipboardService: {
        read: async () => {
          started();
          await new Promise((resolve) => {
            resume = resolve;
          });
          return "private fixture";
        },
      },
    });
    f.control.take(f.session);
    const pending = f.get();
    await entered;
    if (change === "logout") await f.post({}, {}, "/api/logout");
    else f.control.release(f.session);
    resume();
    const response = await pending;
    assert.equal(response.status, change === "logout" ? 401 : 409);
    assert.ok(!(await response.text()).includes("private fixture"));
  }
});

test("clipboard mutation rechecks authorization after asynchronous preparation", async (t) => {
  let resume, started;
  let mutated = false;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, {
    clipboardService: {
      write: async (_text, { beforeMutation }) => {
        started();
        await new Promise((resolve) => {
          resume = resolve;
        });
        beforeMutation();
        mutated = true;
      },
    },
  });
  f.control.take(f.session);
  const pending = f.post({ text: "fixture" });
  await entered;
  await f.post({}, {}, "/api/logout");
  resume();
  assert.equal((await pending).status, 401);
  assert.equal(mutated, false);
  assert.equal(f.control.active, 0);
});
