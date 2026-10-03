import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { BrowserService, navigationUrl } from "../src/browser.js";

async function fixture(
  t,
  { timeoutMs = 1000, maxInflight = 16, intercept = () => false } = {},
) {
  const state = {
    targets: [
      {
        targetId: "tab-1",
        type: "page",
        title: "First",
        url: "https://example.org/",
      },
    ],
    activeId: "tab-1",
    messages: [],
    nextTab: 1,
  };
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/test`,
      }),
    );
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) =>
    socket.on("message", (data) => {
      const message = JSON.parse(data);
      state.messages.push(message);
      const reply = (result = {}) =>
        socket.send(JSON.stringify({ id: message.id, result }));
      if (intercept(message, reply, socket)) return;
      const { method, params } = message;
      if (method === "Target.getTargets") reply({ targetInfos: state.targets });
      else if (method === "Target.attachToTarget")
        reply({ sessionId: params.targetId });
      else if (method === "Runtime.evaluate")
        reply({
          result: {
            value: {
              visible: message.sessionId === state.activeId,
              focused: message.sessionId === state.activeId,
            },
          },
        });
      else if (method === "Target.createTarget") {
        const targetId = `tab-${++state.nextTab}`;
        state.targets.push({
          targetId,
          type: "page",
          title: "New tab",
          url: params.url,
        });
        state.activeId = targetId;
        reply({ targetId });
      } else if (method === "Target.closeTarget") {
        state.targets = state.targets.filter(
          (target) => target.targetId !== params.targetId,
        );
        reply({ success: true });
      } else if (method === "Target.activateTarget") {
        state.activeId = params.targetId;
        reply();
      } else if (method === "Page.navigate") {
        state.targets.find(
          (target) => target.targetId === message.sessionId,
        ).url = params.url;
        reply({ frameId: "frame-1" });
      } else if (method === "Page.getNavigationHistory")
        reply({ currentIndex: 1, entries: [{ id: 4 }, { id: 5 }, { id: 6 }] });
      else reply();
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const service = new BrowserService({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    timeoutMs,
    maxInflight,
  });
  t.after(async () => {
    service.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { state, service };
}

test("address input accepts web URLs and searches while excluding executable and local schemes", () => {
  assert.equal(navigationUrl("example.org/path"), "https://example.org/path");
  assert.equal(navigationUrl("localhost:8080"), "https://localhost:8080/");
  assert.equal(navigationUrl("http://router.local"), "http://router.local/");
  assert.equal(
    navigationUrl(" two words "),
    "https://www.google.com/search?q=two%20words",
  );
  assert.equal(navigationUrl("about:blank"), "about:blank");
  for (const input of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///etc/passwd",
    "chrome://settings",
    "",
    null,
  ]) {
    assert.throws(
      () => navigationUrl(input),
      (error) => error.status === 400,
    );
  }
});

test("tab listing excludes non-page targets and follows a tab selected through the remote display", async (t) => {
  const { state, service } = await fixture(t);
  state.targets.push({
    targetId: "worker-1",
    type: "service_worker",
    url: "https://example.org/worker.js",
  });
  state.targets.push({
    targetId: "tab-2",
    type: "page",
    title: "Second",
    url: "https://example.net/",
  });
  assert.equal((await service.listTabs()).activeId, "tab-1");
  state.activeId = "tab-2";
  const result = await service.listTabs();
  assert.equal(result.activeId, "tab-2");
  assert.equal(result.tabs.length, 2);
  assert.ok(result.tabs.every((tab) => tab.id.startsWith("tab-")));
});

test("closing the final tab creates a replacement before closing it", async (t) => {
  const { state, service } = await fixture(t);
  const result = await service.action({ action: "close", tabId: "tab-1" });
  const mutations = state.messages.filter((message) =>
    ["Target.createTarget", "Target.closeTarget"].includes(message.method),
  );
  assert.deepEqual(
    mutations.map((message) => message.method),
    ["Target.createTarget", "Target.closeTarget"],
  );
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0].url, "about:blank");
  assert.equal(result.activeId, result.tabs[0].id);
});

test("navigation follows a newly focused window instead of the previously selected visible tab", async (t) => {
  const { state, service } = await fixture(t, {
    intercept: (message, reply) => {
      if (message.method !== "Runtime.evaluate") return false;
      reply({
        result: {
          value: { visible: true, focused: message.sessionId === "tab-2" },
        },
      });
      return true;
    },
  });
  state.targets.push({
    targetId: "tab-2",
    type: "page",
    title: "Second window",
    url: "https://example.net/",
  });
  service.activeId = "tab-1";
  await service.action({ action: "navigate", url: "https://example.com/" });
  assert.equal(
    state.messages.find((message) => message.method === "Page.navigate")
      .sessionId,
    "tab-2",
  );
  assert.equal((await service.listTabs()).activeId, "tab-2");
});

test("navigation targets only known pages and history actions use real history entries", async (t) => {
  const { state, service } = await fixture(t);
  await assert.rejects(
    service.action({ action: "reload", tabId: "unknown" }),
    (error) => error.status === 409,
  );
  const result = await service.action({
    action: "navigate",
    tabId: "tab-1",
    url: "example.com",
  });
  assert.equal(result.tabs[0].url, "https://example.com/");
  await service.action({ action: "back", tabId: "tab-1" });
  await service.action({ action: "forward", tabId: "tab-1" });
  assert.deepEqual(
    state.messages
      .filter((message) => message.method === "Page.navigateToHistoryEntry")
      .map((message) => message.params.entryId),
    [4, 6],
  );
});

test("authorization is rechecked immediately before a mutation after asynchronous CDP reads", async (t) => {
  const { state, service } = await fixture(t);
  await assert.rejects(
    service.action(
      { action: "navigate", tabId: "tab-1", url: "https://example.net/" },
      {
        beforeMutation: () => {
          throw new Error("The session ended.");
        },
      },
    ),
    /session ended/,
  );
  assert.equal(
    state.messages.some((message) => message.method === "Page.navigate"),
    false,
  );
});

test("missing mutation completion is distinguished from an ordinary protocol rejection", async (t) => {
  const timeout = await fixture(t, {
    timeoutMs: 100,
    intercept: (message) => message.method === "Page.navigate",
  });
  await assert.rejects(
    timeout.service.action({
      action: "navigate",
      tabId: "tab-1",
      url: "https://example.net/",
    }),
    (error) => error.status === 504 && error.unknownCompletion,
  );
  const rejected = await fixture(t, {
    intercept: (message, reply, socket) => {
      if (message.method !== "Page.navigate") return false;
      socket.send(
        JSON.stringify({
          id: message.id,
          error: { code: -32602, message: "Rejected" },
        }),
      );
      return true;
    },
  });
  await assert.rejects(
    rejected.service.action({
      action: "navigate",
      tabId: "tab-1",
      url: "https://example.net/",
    }),
    (error) => error.status === 502 && !error.unknownCompletion,
  );
});

test("read-only failures are bounded without claiming an unknown browser mutation", async (t) => {
  const { service } = await fixture(t, {
    timeoutMs: 100,
    intercept: (message) => message.method === "Target.getTargets",
  });
  await assert.rejects(
    service.listTabs(),
    (error) => error.status === 504 && !error.unknownCompletion,
  );
});
