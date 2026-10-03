import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ArtifactService } from "../src/artifacts.js";
import { createGateway } from "../src/server.js";

const token = "synthetic-artifact-gateway-token-".repeat(2);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KfQAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "remote-browser-artifact-gateway-"),
  );
  const artifactService = new ArtifactService({
    directory: path.join(directory, "artifacts"),
    socketPath: path.join(directory, "artifacts.sock"),
  });
  const gateway = createGateway({
    token,
    artifactService,
    accountFile: path.join(directory, "account.json"),
    probe: async () => true,
  });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const session = gateway.auth.createSession();
  const cookie = gateway.auth.cookie(session).split(";")[0];
  const headers = { Cookie: cookie };
  const bearer = { Authorization: `Bearer ${token}` };
  const post = (route, body = {}, extra = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: {
        ...headers,
        Origin: base,
        "Content-Type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
    });
  const saved = await artifactService.save({
    name: 'Screenshot "one" Ω',
    base64: png.toString("base64"),
    mimeType: "image/png",
  });
  t.after(async () => {
    gateway.server.closeAllConnections();
    if (gateway.server.listening)
      await new Promise((resolve) => gateway.server.close(resolve));
    await artifactService.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ...gateway,
    artifactService,
    base,
    session,
    cookie,
    headers,
    bearer,
    post,
    saved,
  };
}

test("file listing and downloads require authentication and work for dashboard sessions or API keys", async (t) => {
  const f = await fixture(t);
  for (const route of ["/api/artifacts", f.saved.url])
    assert.equal((await fetch(f.base + route)).status, 401);
  for (const headers of [f.headers, f.bearer]) {
    const response = await fetch(f.base + "/api/artifacts", { headers });
    assert.equal(response.status, 200);
    const listing = await response.json();
    assert.deepEqual(listing.files, [f.saved]);
    assert.equal(listing.recording, null);
    const downloaded = await fetch(f.base + f.saved.url, { headers });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "image/png");
    assert.equal(downloaded.headers.get("content-length"), String(png.length));
    assert.equal(downloaded.headers.get("cache-control"), "no-store");
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      downloaded.headers.get("content-disposition"),
      /attachment;.*filename\*=UTF-8''Screenshot%20%22one%22%20%CE%A9.png/,
    );
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  }
  assert.equal(
    (
      await fetch(f.base + "/api/artifacts/unknown/download", {
        headers: f.headers,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(f.base + "/api/artifacts/%2Fetc%2Fpasswd/download", {
        headers: f.headers,
      })
    ).status,
    405,
  );
});

test("human upload requires same-origin session and generic previews cannot execute active content", async (t) => {
  const f = await fixture(t);
  const upload = (headers = {}) =>
    fetch(f.base + "/api/artifacts/upload", {
      method: "POST",
      headers: {
        ...f.headers,
        Origin: f.base,
        "Content-Type": "application/octet-stream",
        "X-File-Name": "page.html",
        ...headers,
      },
      body: '<script>document.body.textContent="unsafe"</script>',
    });
  assert.equal((await upload(f.bearer)).status, 403);
  assert.equal((await upload({ Origin: "http://other.invalid" })).status, 403);
  const created = await upload();
  assert.equal(created.status, 201);
  const file = await created.json();
  assert.equal(file.kind, "upload");
  const preview = await fetch(
    f.base + file.url.replace("/download", "/preview"),
    { headers: f.headers },
  );
  assert.equal(preview.headers.get("content-type"), "application/octet-stream");
  assert.match(preview.headers.get("content-disposition"), /^attachment;/);
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
});

test("gallery previews remain authenticated and support single byte ranges and HEAD for media playback", async (t) => {
  const f = await fixture(t);
  const id = "a".repeat(32);
  const video = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.alloc(256, 7),
  ]);
  const metadata = {
    id,
    name: "Walkthrough.mp4",
    mimeType: "video/mp4",
    size: video.length,
    createdAt: new Date(0).toISOString(),
  };
  await writeFile(path.join(f.artifactService.directory, `${id}.bin`), video, {
    mode: 0o600,
  });
  await writeFile(
    path.join(f.artifactService.directory, `${id}.json`),
    JSON.stringify(metadata),
    { mode: 0o600 },
  );
  const preview = `${f.base}/api/artifacts/${id}/preview`;
  const anonymous = await fetch(preview, { headers: { Range: "bytes=0-7" } });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("content-range"), null);
  for (const headers of [f.headers, f.bearer]) {
    const complete = await fetch(preview, { headers });
    assert.equal(complete.status, 200);
    assert.equal(complete.headers.get("content-type"), "video/mp4");
    assert.equal(complete.headers.get("accept-ranges"), "bytes");
    assert.match(complete.headers.get("content-disposition"), /^inline;/);
    assert.deepEqual(Buffer.from(await complete.arrayBuffer()), video);
    for (const [range, start, end] of [
      ["bytes=0-7", 0, 7],
      ["bytes=10-", 10, video.length - 1],
      ["bytes=-12", video.length - 12, video.length - 1],
      ["bytes=0-9999", 0, video.length - 1],
    ]) {
      const response = await fetch(preview, {
        headers: { ...headers, Range: range },
      });
      assert.equal(response.status, 206);
      assert.equal(
        response.headers.get("content-range"),
        `bytes ${start}-${end}/${video.length}`,
      );
      assert.equal(
        response.headers.get("content-length"),
        String(end - start + 1),
      );
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        video.subarray(start, end + 1),
      );
    }
    const head = await fetch(preview, {
      method: "HEAD",
      headers: { ...headers, Range: "bytes=0-7" },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(video.length));
    assert.equal(await head.text(), "");
  }
  for (const range of [
    "bytes=9999-",
    "bytes=5-1",
    "bytes=-0",
    "bytes=-",
    "bytes=0-2,8-12",
    "bytes=9007199254740999-",
    "items=0-1",
  ]) {
    const response = await fetch(preview, {
      headers: { ...f.headers, Range: range },
    });
    assert.equal(response.status, 416, range);
    assert.equal(
      response.headers.get("content-range"),
      `bytes */${video.length}`,
    );
  }
  const image = await fetch(
    f.base + f.saved.url.replace("/download", "/preview"),
    { headers: f.headers },
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.match(image.headers.get("content-disposition"), /^inline;/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
});

test("only a same-origin dashboard session can stop a recording or delete a file", async (t) => {
  const f = await fixture(t);
  let stopped = 0;
  f.artifactService.stopRecording = async () => {
    stopped++;
    return f.saved;
  };
  for (const route of ["/api/recording/stop", "/api/artifacts/delete"]) {
    assert.equal(
      (await fetch(f.base + route, { method: "POST", body: "{}" })).status,
      401,
    );
    assert.equal(
      (await f.post(route, { id: f.saved.id }, f.bearer)).status,
      403,
    );
    assert.equal(
      (
        await f.post(
          route,
          { id: f.saved.id },
          { Origin: "http://other.invalid" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(f.base + route, {
          method: "POST",
          headers: f.headers,
          body: "{}",
        })
      ).status,
      403,
    );
  }
  assert.equal(stopped, 0);
  assert.equal((await f.artifactService.list()).files.length, 1);
  assert.equal(f.control.status().mode, "agent");
  const response = await f.post("/api/recording/stop");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { file: f.saved });
  assert.equal(stopped, 1);
  const deleted = await f.post("/api/artifacts/delete", { id: f.saved.id });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true });
  assert.equal(
    (await fetch(f.base + f.saved.url, { headers: f.headers })).status,
    404,
  );
});

test("expired sessions cannot receive a file listing completed after an asynchronous read", async (t) => {
  const f = await fixture(t);
  const listing = await f.artifactService.list();
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.artifactService.list = async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return listing;
  };
  const pending = fetch(f.base + "/api/artifacts", { headers: f.headers });
  await started;
  f.auth.sessions.delete(f.session);
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes(f.saved.id));
});

test("a revoked API key cannot receive a download opened after revocation", async (t) => {
  const f = await fixture(t);
  const key = await f.apiKeys.create("Download client");
  const openFile = f.artifactService.openFile.bind(f.artifactService);
  let release;
  let entered;
  let stream;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.artifactService.openFile = async (id) => {
    const file = await openFile(id);
    stream = file.stream;
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return file;
  };
  const pending = fetch(f.base + f.saved.url, {
    headers: { Authorization: `Bearer ${key.secret}` },
  });
  await started;
  await f.apiKeys.revoke(key.key.id);
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal(stream.destroyed, true);
  assert.ok(!(await response.text()).includes(png.toString("base64")));
});

test("session expiry during a management body cannot stop recording or delete files", async (t) => {
  const f = await fixture(t);
  let stopped = false;
  f.artifactService.stopRecording = async () => {
    stopped = true;
    return f.saved;
  };
  for (const route of ["/api/recording/stop", "/api/artifacts/delete"]) {
    const session = f.auth.createSession();
    const cookie = f.auth.cookie(session).split(";")[0];
    let identified;
    const identifiedPromise = new Promise((resolve) => {
      identified = resolve;
    });
    const identify = f.auth.identifySession.bind(f.auth);
    f.auth.identifySession = (req) => {
      const identity = identify(req);
      identified();
      return identity;
    };
    const response = new Promise((resolve, reject) => {
      const request = http.request(
        f.base + route,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: f.base,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      request.on("error", reject);
      request.write("{");
      identifiedPromise.then(() => {
        f.auth.sessions.delete(session);
        request.end(`"id":"${f.saved.id}"}`);
      });
    });
    assert.equal(await response, 401);
    f.auth.identifySession = identify;
  }
  assert.equal(stopped, false);
  assert.equal((await f.artifactService.list()).files.length, 1);
});

test("logout during a queued file deletion prevents the later filesystem mutation", async (t) => {
  const f = await fixture(t);
  const readMetadata = f.artifactService.readMetadata.bind(f.artifactService);
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.artifactService.readMetadata = async (id) => {
    const metadata = await readMetadata(id);
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return metadata;
  };
  const pending = f.post("/api/artifacts/delete", { id: f.saved.id });
  await started;
  f.auth.sessions.delete(f.session);
  release();
  assert.equal((await pending).status, 401);
  f.artifactService.readMetadata = readMetadata;
  assert.equal((await f.artifactService.list()).files.length, 1);
});

test("status includes recording state without giving API keys dashboard mutation privileges", async (t) => {
  const f = await fixture(t);
  const recording = {
    id: "recording-fixture",
    name: "Walkthrough.mp4",
    startedAt: new Date(0).toISOString(),
    maxSeconds: 60,
    state: "recording",
  };
  f.artifactService.status = () => recording;
  for (const headers of [f.headers, f.bearer]) {
    const response = await fetch(f.base + "/api/status", { headers });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).recording, recording);
  }
});
