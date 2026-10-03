import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import initializeCodeMode from "../src/playwright-code-mode.js";

const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex");
const JPEG = Buffer.from("ffd8ffe00000", "hex");

async function createPage() {
  const context = { pages: () => [page] };
  const page = {
    context: () => context,
    broughtToFront: false,
    async bringToFront() {
      this.broughtToFront = true;
    },
  };
  await initializeCodeMode({ page });
  return page;
}

test("the page hook is immutable, idempotent, and supplies the visible page and context", async () => {
  const page = await createPage();
  const helper = page.__remoteBrowserCodeMode;
  await initializeCodeMode({ page });
  assert.equal(page.__remoteBrowserCodeMode, helper);
  assert.equal(Object.isFrozen(helper), true);
  assert.throws(() => {
    page.__remoteBrowserCodeMode = {};
  }, TypeError);
  assert.throws(() => {
    delete page.__remoteBrowserCodeMode;
  }, TypeError);
  assert.equal(Object.keys(page).includes("__remoteBrowserCodeMode"), false);
  const result = await helper.run(page, async (bindings) => {
    assert.equal(bindings.page, page);
    assert.equal(bindings.context, page.context());
    assert.equal(page.broughtToFront, true);
    assert.deepEqual(Object.keys(bindings).sort(), [
      "browser",
      "context",
      "files",
      "image",
      "page",
      "recording",
    ]);
    return { title: "Example", pages: bindings.context.pages().length };
  });
  assert.equal(result.__remoteBrowserCodeMode, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { title: "Example", pages: 1 });
  assert.deepEqual(result.images, []);
  assert.equal(Number.isInteger(result.durationMs), true);
  assert.equal(result.durationMs >= 0, true);
  assert.equal("error" in result, false);
});

test("execution follows the visible focused tab after it changes outside MCP", async () => {
  const original = await createPage();
  const other = await createPage();
  let detached = 0;
  const context = {
    pages: () => [original, other],
    newCDPSession: async (page) => ({
      send: async () => ({
        result: { value: { visible: page === other, focused: page === other } },
      }),
      detach: async () => {
        detached++;
      },
    }),
  };
  original.context = other.context = () => context;
  const result = await original.__remoteBrowserCodeMode.run(
    original,
    async ({ page }) => {
      assert.equal(page, other);
      return "Visible tab";
    },
  );
  assert.equal(result.ok, true);
  assert.equal(other.broughtToFront, true);
  assert.equal(detached, 2);
});

test("a VM callback can return JSON values, undefined, and cross-realm typed image bytes", async () => {
  const page = await createPage();
  const callback = vm.runInNewContext(`async ({ image }) => {
    image(new Uint8Array([255, 216, 255, 224, 0, 0]));
    return { date: new Date('2026-01-01T00:00:00Z'), numbers: [1, 2] };
  }`);
  const result = await page.__remoteBrowserCodeMode.run(page, callback);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    date: "2026-01-01T00:00:00.000Z",
    numbers: [1, 2],
  });
  assert.deepEqual(result.images, [
    { mimeType: "image/jpeg", data: JPEG.toString("base64") },
  ]);
  const empty = await page.__remoteBrowserCodeMode.run(page, async () => {});
  assert.equal(empty.ok, true);
  assert.equal(empty.value, null);
  assert.deepEqual(empty.images, []);
});

test("errors have bounded details and a failed call does not poison the next call", async () => {
  const page = await createPage();
  const fail = vm.runInNewContext(`async () => {
    throw new TypeError('x'.repeat(8000));
  }`);
  const failure = await page.__remoteBrowserCodeMode.run(page, fail);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.name, "TypeError");
  assert.equal(Buffer.byteLength(failure.error.message), 4096);
  assert.equal("stack" in failure.error, false);
  assert.equal(failure.value, null);
  const success = await page.__remoteBrowserCodeMode.run(
    page,
    async () => "Recovered",
  );
  assert.equal(success.ok, true);
  assert.equal(success.value, "Recovered");
});

test("errors from page activation and non-function input return normal envelopes", async () => {
  const page = await createPage();
  const badCallback = await page.__remoteBrowserCodeMode.run(page, "code");
  assert.equal(badCallback.ok, false);
  assert.match(badCallback.error.message, /must be a function/);
  page.bringToFront = async () => {
    throw new Error("Page has been closed.");
  };
  let invoked = false;
  const result = await page.__remoteBrowserCodeMode.run(page, async () => {
    invoked = true;
  });
  assert.equal(result.ok, false);
  assert.equal(invoked, false);
  assert.equal(result.error.message, "Page has been closed.");
});

test("PNG and JPEG images are copied with detected MIME types and typed array boundaries", async () => {
  const page = await createPage();
  const bytes = Buffer.concat([Buffer.from([1, 2]), PNG, Buffer.from([3])]);
  const result = await page.__remoteBrowserCodeMode.run(
    page,
    async ({ image }) => {
      image(
        new Uint8Array(bytes.buffer, bytes.byteOffset + 2, PNG.length),
        "image/png",
      );
      image(JPEG);
      bytes.fill(0);
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.images, [
    { mimeType: "image/png", data: PNG.toString("base64") },
    { mimeType: "image/jpeg", data: JPEG.toString("base64") },
  ]);
});

test("invalid image inputs and mismatched MIME types are rejected", async () => {
  const page = await createPage();
  for (const [bytes, type, message] of [
    ["data:image/png;base64,abc", undefined, /Buffer or Uint8Array/],
    [new Uint16Array([1, 2]), undefined, /Buffer or Uint8Array/],
    [Buffer.from("not an image"), undefined, /PNG or JPEG/],
    [PNG, "image/jpeg", /MIME type must match/],
    [JPEG, "image/webp", /MIME type must match/],
  ]) {
    const result = await page.__remoteBrowserCodeMode.run(
      page,
      async ({ image }) => image(bytes, type),
    );
    assert.equal(result.ok, false);
    assert.match(result.error.message, message);
    assert.deepEqual(result.images, []);
  }
});

test("image limits apply to each call and include the cumulative raw byte size", async () => {
  const page = await createPage();
  const tooMany = await page.__remoteBrowserCodeMode.run(
    page,
    async ({ image }) => {
      image(PNG);
      image(JPEG);
      image(PNG);
    },
  );
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.images.length, 2);
  assert.match(tooMany.error.message, /at most 2 images/);

  const largeImage = Buffer.alloc(3 * 1024 * 1024 + 1);
  PNG.copy(largeImage);
  const tooLarge = await page.__remoteBrowserCodeMode.run(
    page,
    async ({ image }) => {
      image(largeImage);
      image(largeImage);
    },
  );
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.images.length, 1);
  assert.match(tooLarge.error.message, /6 MiB/);

  const next = await page.__remoteBrowserCodeMode.run(page, async ({ image }) =>
    image(PNG),
  );
  assert.equal(next.ok, true);
  assert.equal(next.images.length, 1);
});

test("returned values must serialize within 32 KiB and preserve no live references", async () => {
  const page = await createPage();
  const circular = {};
  circular.self = circular;
  for (const value of [
    circular,
    1n,
    () => {},
    Symbol("result"),
    "x".repeat(32768),
  ]) {
    const result = await page.__remoteBrowserCodeMode.run(
      page,
      async () => value,
    );
    assert.equal(result.ok, false);
    assert.equal(result.value, null);
  }
  const original = { text: "x".repeat(32757) };
  assert.equal(Buffer.byteLength(JSON.stringify(original)), 32768);
  const result = await page.__remoteBrowserCodeMode.run(
    page,
    async () => original,
  );
  assert.equal(result.ok, true);
  original.text = "Changed";
  assert.notEqual(result.value.text, original.text);
});

test("an escaped image helper cannot mutate an already completed result", async () => {
  const page = await createPage();
  let escapedImage;
  const result = await page.__remoteBrowserCodeMode.run(
    page,
    async ({ image }) => {
      escapedImage = image;
    },
  );
  assert.equal(result.ok, true);
  assert.throws(() => escapedImage(PNG), /already completed/);
  assert.deepEqual(result.images, []);
});

test("non-Error thrown values and hostile error accessors still return a bounded envelope", async () => {
  const page = await createPage();
  const message = "💡".repeat(3000);
  const failure = await page.__remoteBrowserCodeMode.run(page, async () => {
    throw message;
  });
  assert.equal(failure.ok, false);
  assert.equal(Buffer.byteLength(failure.error.message) <= 4096, true);
  assert.equal(failure.error.message.endsWith("\uFFFD"), false);
  const hostile = await page.__remoteBrowserCodeMode.run(page, async () => {
    throw {
      get name() {
        throw new Error("Accessor failed");
      },
    };
  });
  assert.equal(hostile.ok, false);
  assert.deepEqual(hostile.error, {
    name: "Error",
    message: "The browser code failed.",
  });
});
