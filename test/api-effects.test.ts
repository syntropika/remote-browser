import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Effect } from "effect";
import { run } from "../src/effects.js";
import { ApiError, requestEffect } from "../ui/api.js";

test("API effects preserve authentication failures for the dashboard", async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session expired." }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as { port: number };
  await assert.rejects(
    run(requestEffect(`http://127.0.0.1:${address.port}`)),
    (error) =>
      error instanceof ApiError &&
      error.statusCode === 401 &&
      error.message === "Session expired.",
  );
});

test("interrupting an API body read aborts its underlying HTTP connection", async (t) => {
  let bodyStarted;
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  let closed;
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("{");
    res.once("close", closed);
    bodyStarted();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as { port: number };
  const controller = new AbortController();
  const execution = Effect.runPromiseExit(
    requestEffect(`http://127.0.0.1:${address.port}`),
    { signal: controller.signal },
  );
  await started;
  controller.abort();
  assert.equal((await execution)._tag, "Failure");
  await disconnected;
});
