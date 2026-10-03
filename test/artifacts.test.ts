import test from "node:test";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ArtifactService } from "../src/artifacts.js";
import { createArtifactClient } from "../src/artifacts-client.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KfQAAAAASUVORK5CYII=",
  "base64",
);
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(256),
]);
const screenshot = (name) => ({
  name,
  base64: png.toString("base64"),
  mimeType: "image/png",
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "remote-browser-artifacts-"),
  );
  const directory = path.join(root, "files");
  const socketPath = path.join(root, "ipc", "artifacts.sock");
  const service = new ArtifactService({
    directory,
    socketPath,
    publicOrigin: "http://browser.local",
    ...options,
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, socketPath, service };
}

function recorder({ startup = "ready", automatic = false } = {}) {
  const processes = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.stdio = [null, null, child.stderr, new PassThrough()];
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      setImmediate(() => child.emit("close", signal === "SIGINT" ? 255 : null));
      return true;
    };
    processes.push({ child, command, args, options });
    setImmediate(() => {
      if (startup === "failure") {
        child.emit("close", 1);
        return;
      }
      if (startup === "missing") return;
      writeSync(options.stdio[4], mp4);
      child.stdio[3].write("frame=1\nfps=15.0\nprogress=continue\n");
      if (automatic) setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
  return { processes, spawnProcess };
}

test("constructor is lazy; screenshots survive service replacement with private data and metadata", async (t) => {
  const { service, directory, socketPath } = await fixture(t);
  await assert.rejects(stat(directory), { code: "ENOENT" });
  const saved = await service.save(screenshot("Account page"));
  assert.match(saved.id, /^[a-f0-9]{32}$/);
  assert.equal(saved.name, "Account page.png");
  assert.equal(
    saved.url,
    `http://browser.local/api/artifacts/${saved.id}/download`,
  );
  assert.equal(saved.size, png.length);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const name of await readdir(directory))
    assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600);
  const replacement = new ArtifactService({
    directory,
    socketPath,
    publicOrigin: "http://browser.local",
  });
  t.after(() => replacement.close());
  assert.deepEqual(await replacement.list(), {
    files: [saved],
    recording: null,
  });
  const opened = await replacement.openFile(saved.id);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), png);
});

test("only bounded screenshot bytes and safe display names can be registered", async (t) => {
  const { service } = await fixture(t);
  for (const value of [
    { ...screenshot(), mimeType: "text/html" },
    {
      ...screenshot(),
      base64: Buffer.from("<script>alert(1)</script>").toString("base64"),
    },
    { ...screenshot(), base64: `${png.toString("base64")}!` },
    {
      ...screenshot(),
      base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"),
    },
    screenshot("../../account.json"),
    screenshot("secret\r\nContent-Type: text/html"),
    screenshot("a".repeat(121)),
  ])
    await assert.rejects(service.save(value), (error) => error.status === 400);
  assert.deepEqual((await service.list()).files, []);
});

test("concurrent writes cannot exceed quota and failed registrations leave no downloadable files", async (t) => {
  const { service, directory } = await fixture(t, {
    maxTotalBytes: png.length,
    maxFiles: 1,
  });
  const results = await Promise.allSettled([
    service.save(screenshot("First")),
    service.save(screenshot("Second")),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.find((result) => result.status === "rejected").reason.status,
    507,
  );
  assert.equal((await service.list()).files.length, 1);
  assert.equal((await readdir(directory)).length, 2);
  await service.remove(
    results.find((result) => result.status === "fulfilled").value.id,
  );
  assert.equal((await service.list()).files.length, 0);
  await service.save(screenshot("Replacement"));
});

test("download IDs never resolve arbitrary paths and file symlinks cannot expose account data", async (t) => {
  const { service, root, directory } = await fixture(t);
  const saved = await service.save(screenshot("Page"));
  const secretPath = path.join(root, "account.json");
  await writeFile(secretPath, "synthetic account data", { mode: 0o600 });
  for (const id of [
    "../account.json",
    saved.name,
    `${saved.id}/../../account.json`,
    null,
  ]) {
    await assert.rejects(service.openFile(id), (error) => error.status === 404);
  }
  await unlink(path.join(directory, `${saved.id}.bin`));
  await symlink(secretPath, path.join(directory, `${saved.id}.bin`));
  await assert.rejects(
    service.openFile(saved.id),
    (error) => error.status === 404,
  );
  await assert.rejects(service.list(), (error) => error.status === 503);
  assert.equal(await readFile(secretPath, "utf8"), "synthetic account data");
});

test("directory and metadata symlinks fail closed; unregistered files are excluded", async (t) => {
  const { root, directory, service } = await fixture(t);
  const saved = await service.save(screenshot());
  await writeFile(path.join(directory, "unregistered.bin"), png, {
    mode: 0o600,
  });
  assert.equal((await service.list()).files.length, 1);
  const link = path.join(root, "link");
  await symlink(directory, link);
  const unsafe = new ArtifactService({ directory: link });
  t.after(() => unsafe.close());
  await assert.rejects(unsafe.list(), (error) => error.status === 503);
  const metadataPath = path.join(directory, `${saved.id}.json`);
  await unlink(metadataPath);
  await symlink(path.join(root, "outside"), metadataPath);
  await assert.rejects(
    service.openFile(saved.id),
    (error) => error.status === 503,
  );
});

test("one visible-display recording is reserved until graceful completion and saved as MP4", async (t) => {
  const fake = recorder();
  const { service, directory } = await fixture(t, {
    spawnProcess: fake.spawnProcess,
  });
  const started = await service.startRecording({
    name: "Walkthrough",
    maxSeconds: 30,
  });
  assert.equal(started.name, "Walkthrough.mp4");
  assert.equal(service.status().id, started.id);
  assert.equal(service.status().state, "recording");
  assert.deepEqual((await service.list()).files, []);
  await assert.rejects(
    service.startRecording(),
    (error) => error.status === 409,
  );
  assert.equal(fake.processes[0].command, "ffmpeg");
  assert.ok(fake.processes[0].args.includes("x11grab"));
  assert.ok(fake.processes[0].args.includes("/proc/self/fd/4"));
  assert.equal(
    (await stat(path.join(directory, `${started.id}.bin`))).mode & 0o777,
    0o600,
  );
  const saved = await service.stopRecording();
  assert.equal(saved.id, started.id);
  assert.equal(saved.mimeType, "video/mp4");
  assert.equal(saved.size, mp4.length);
  assert.equal(service.status(), null);
  assert.deepEqual(fake.processes[0].child.signals, ["SIGINT"]);
  assert.deepEqual((await service.list()).files, [saved]);
});

test("recording quota is reserved against concurrent screenshots and released on failure", async (t) => {
  const fake = recorder();
  const { service } = await fixture(t, {
    spawnProcess: fake.spawnProcess,
    maxVideoBytes: 1024,
    maxTotalBytes: 1024,
  });
  await service.startRecording();
  await assert.rejects(
    service.save(screenshot()),
    (error) => error.status === 507,
  );
  fake.processes[0].child.emit("close", 1);
  await service.queue;
  assert.equal(service.status(), null);
  assert.equal((await service.list()).files.length, 0);
  await service.save(screenshot());
});

test("automatic duration completion persists output and close finalizes an active recording", async (t) => {
  const automatic = recorder({ automatic: true });
  const { service } = await fixture(t, {
    spawnProcess: automatic.spawnProcess,
  });
  await service.startRecording({ maxSeconds: 1 });
  const done = service.recording?.done;
  await done;
  assert.equal(service.status(), null);
  assert.equal((await service.list()).files.length, 1);
  const fake = recorder();
  service.spawnProcess = fake.spawnProcess;
  await service.startRecording();
  await service.close();
  assert.equal(service.status(), null);
  assert.equal((await service.list()).files.length, 2);
  await assert.rejects(
    service.startRecording(),
    (error) => error.status === 503,
  );
});

test("failed startup and missing progress are bounded and remove partial files", async (t) => {
  for (const startup of ["failure", "missing"]) {
    const fake = recorder({ startup });
    const { service, directory } = await fixture(t, {
      spawnProcess: fake.spawnProcess,
      startupTimeoutMs: 20,
    });
    await assert.rejects(service.startRecording(), (error) =>
      [502, 504].includes(error.status),
    );
    await service.queue;
    assert.equal(service.status(), null);
    assert.deepEqual(await readdir(directory), []);
    if (startup === "missing")
      assert.deepEqual(fake.processes[0].child.signals, ["SIGKILL"]);
  }
});

test("private socket client saves native screenshot buffers and controls the same recording service", async (t) => {
  const fake = recorder();
  const { service, socketPath } = await fixture(t, {
    spawnProcess: fake.spawnProcess,
  });
  await service.listen();
  assert.equal((await lstat(socketPath)).mode & 0o777, 0o600);
  const client = createArtifactClient({ socketPath });
  const saved = await client.files.saveScreenshot(png, {
    name: "Visible page",
  });
  assert.equal((await client.files.list()).files[0].id, saved.id);
  await assert.rejects(client.files.saveScreenshot("filename.png"), /buffer/);
  await client.recording.start({ maxSeconds: 2 });
  assert.equal((await client.recording.status()).state, "recording");
  assert.equal((await client.recording.stop()).mimeType, "video/mp4");
  assert.equal(await client.recording.status(), null);
  await service.close();
  await assert.rejects(stat(socketPath), { code: "ENOENT" });
});

test("binary downloads and human uploads persist with exact filenames, safe limits, and socket transfer", async (t) => {
  const { service, socketPath, directory } = await fixture(t);
  await service.listen();
  const client = createArtifactClient({ socketPath });
  const bytes = Buffer.from("%PDF-synthetic document\n");
  const upload = await service.saveFile({
    name: "Report Ω.pdf",
    buffer: bytes,
    kind: "upload",
  });
  assert.equal(upload.name, "Report Ω.pdf");
  let attached;
  await client.files.uploadTo(
    {
      setInputFiles: async (file) => {
        attached = file;
      },
    },
    { id: upload.id },
  );
  assert.deepEqual(attached.buffer, bytes);
  assert.equal(attached.name, "Report Ω.pdf");
  let deleted = false;
  const download = await client.files.saveDownload({
    createReadStream: async () => Readable.from([bytes]),
    suggestedFilename: () => "report.pdf",
    delete: async () => {
      deleted = true;
    },
  });
  assert.equal(download.kind, "download");
  assert.equal(deleted, true);
  await assert.rejects(
    client.files.uploadTo(
      {
        setInputFiles: async () => {
          throw new Error("must not attach");
        },
      },
      { id: download.id },
    ),
    /uploaded by the human/,
  );
  for (const input of [
    { name: "../x", buffer: bytes },
    { name: "empty", buffer: Buffer.alloc(0) },
    { name: "huge", buffer: Buffer.alloc(20 * 1024 * 1024 + 1) },
  ])
    await assert.rejects(
      service.saveFile(input),
      (error) => error.status === 400,
    );
  const replacement = new ArtifactService({ directory, socketPath });
  assert.deepEqual(
    (await replacement.list()).files.map((file) => file.id).sort(),
    [upload.id, download.id].sort(),
  );
  await replacement.close();
});

test("upload authorization is rechecked before committing and canceled uploads leave no partial data", async (t) => {
  const { service, directory } = await fixture(t);
  let checks = 0;
  await assert.rejects(
    service.saveFile(
      {
        name: "Canceled.pdf",
        buffer: Buffer.from("synthetic"),
        kind: "upload",
      },
      {
        beforeMutation: () => {
          if (++checks === 2) throw new Error("Session expired");
        },
      },
    ),
    /Session expired/,
  );
  assert.equal(checks, 2);
  assert.deepEqual(await readdir(directory), []);
});
