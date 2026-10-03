import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { captureDownload } from "../src/browser-download.js";

function fixture() {
  const session = new EventEmitter();
  const commands = [];
  let directory;
  session.send = async (method, args) => {
    commands.push({ method, args });
    if (args?.downloadPath) directory = args.downloadPath;
    return {};
  };
  session.detach = async () => {
    session.detached = true;
  };
  const context = {
    newCDPSession: async () => ({
      send: async () => ({ frameTree: { frame: { id: "main" } } }),
      detach: async () => {},
    }),
    browser: () => ({ newBrowserCDPSession: async () => session }),
  };
  return {
    page: { context: () => context },
    session,
    commands,
    directory: () => directory,
  };
}

test("download helper captures exact bytes, restores native settings and removes temporary files", async () => {
  const f = fixture();
  const guid = "12345678-1234-1234-1234-123456789abc";
  const expected = Buffer.from("%PDF-download");
  const result = await captureDownload(
    f.page,
    async () => {
      await writeFile(path.join(f.directory(), guid), expected, {
        mode: 0o600,
      });
      f.session.emit("Browser.downloadWillBegin", {
        guid,
        frameId: "main",
        suggestedFilename: "report.pdf",
      });
      f.session.emit("Browser.downloadProgress", {
        guid,
        state: "completed",
        receivedBytes: expected.length,
        totalBytes: expected.length,
      });
    },
    {},
    async (bytes, name) => {
      assert.deepEqual(bytes, expected);
      return { name };
    },
  );
  assert.equal(result.name, "report.pdf");
  assert.equal(f.session.detached, true);
  assert.equal(f.commands.at(-1).args.behavior, "default");
  await assert.rejects(stat(f.directory()), { code: "ENOENT" });
});

test("oversized or failed download triggers never save data and always restore browser settings", async () => {
  for (const fail of ["oversized", "trigger"]) {
    const f = fixture();
    const guid = "12345678-1234-1234-1234-123456789abc";
    await assert.rejects(
      captureDownload(
        f.page,
        async () => {
          f.session.emit("Browser.downloadWillBegin", {
            guid,
            frameId: "main",
            suggestedFilename: "report.pdf",
          });
          if (fail === "trigger") throw new Error("Trigger failed");
          f.session.emit("Browser.downloadProgress", {
            guid,
            state: "inProgress",
            receivedBytes: 20 * 1024 * 1024 + 1,
            totalBytes: 0,
          });
        },
        {},
        () => {
          throw new Error("must not save");
        },
      ),
      fail === "trigger" ? /Trigger failed/ : /20 MiB/,
    );
    assert.ok(
      f.commands.some((command) => command.method === "Browser.cancelDownload"),
    );
    assert.equal(f.commands.at(-1).args.behavior, "default");
    assert.equal(f.session.detached, true);
    await assert.rejects(stat(f.directory()), { code: "ENOENT" });
  }
});
