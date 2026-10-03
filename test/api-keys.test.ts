import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ApiKeyStore } from "../src/api-keys.js";

const legacyToken = "synthetic-legacy-key-".repeat(3);
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "remote-browser-api-keys-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "api-keys.json");
  return {
    directory,
    filename,
    store: new ApiKeyStore(filename, { legacyToken, ...options }),
  };
}

test("migration preserves the legacy key once and never restores an empty revoked store", async (t) => {
  const { store, filename } = await fixture(t);
  const [initial] = await store.list();
  assert.equal(initial.name, "Initial key");
  assert.equal(initial.legacy, true);
  assert.equal(initial.prefix, "legacy");
  assert.equal(initial.lastUsedAt, null);
  assert.deepEqual(await store.authenticate(legacyToken), {
    type: "bearer",
    id: initial.id,
  });
  await store.revoke(initial.id);
  const recreated = new ApiKeyStore(filename, { legacyToken });
  assert.deepEqual(await recreated.list(), []);
  assert.equal(await recreated.authenticate(legacyToken), null);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf-8")).keys, []);
});

test("creation exposes a secret once, persists only its digest, and records usage privately", async (t) => {
  let now = Date.parse("2026-10-02T10:00:00.000Z");
  const { store, filename } = await fixture(t, { now: () => now });
  const { key, secret } = await store.create("  Laptop agent  ");
  assert.equal(key.name, "Laptop agent");
  assert.equal(key.lastUsedAt, null);
  assert.match(secret, /^rb_[A-Za-z0-9_-]{43}$/u);
  assert.equal(key.prefix, secret.slice(0, 11));
  assert.equal(Buffer.from(secret.slice(3), "base64url").length, 32);
  const file = await readFile(filename, "utf-8");
  const hash = createHash("sha256").update(secret).digest("hex");
  assert.ok(file.includes(hash));
  assert.ok(!file.includes(secret));
  assert.ok(!file.includes(legacyToken));
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const list = JSON.stringify(await store.list());
  assert.ok(!list.includes(secret));
  assert.ok(!list.includes(hash));
  assert.ok(!list.includes("hash"));
  now += 1000;
  assert.deepEqual(await store.authenticate(secret), {
    type: "bearer",
    id: key.id,
  });
  assert.equal(
    (await store.list()).find((entry) => entry.id === key.id).lastUsedAt,
    new Date(now).toISOString(),
  );
  const recreated = new ApiKeyStore(filename, { legacyToken });
  assert.deepEqual(await recreated.authenticate(secret), {
    type: "bearer",
    id: key.id,
  });
});

test("independent keys and concurrent mutations preserve each other", async (t) => {
  const { store } = await fixture(t);
  const created = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => store.create(`Agent ${index}`)),
  );
  assert.equal((await store.list()).length, 9);
  await Promise.all(created.slice(0, 4).map(async ({ key }) => store.revoke(key.id)));
  assert.equal((await store.list()).length, 5);
  for (let index = 0; index < created.length; index++) {
    const result = await store.authenticate(created[index].secret);
    assert.equal(Boolean(result), index >= 4);
  }
});

test("invalid names and unknown keys do not change the registry", async (t) => {
  const { store } = await fixture(t);
  for (const name of [null, "", "   ", "x".repeat(65), "tab\tkey", "\nkey", "key\u200B"]) {
    await assert.rejects(store.create(name), { status: 400 });
  }
  await assert.rejects(store.revoke("unknown"), { status: 404 });
  assert.equal((await store.list()).length, 1);
});

test("corrupt, public, and symlinked registries fail closed without replacing their contents", async (t) => {
  for (const kind of ["corrupt", "public", "symlink"]) {
    const { directory, filename } = await fixture(t);
    const target = path.join(directory, "target.json");
    const text = kind === "corrupt" ? "broken" : '{"version":1,"keys":[]}';
    if (kind === "symlink") {
      await writeFile(target, text, { mode: 0o600 });
      await symlink(target, filename);
    } else {
      await writeFile(filename, text, {
        mode: kind === "public" ? 0o644 : 0o600,
      });
    }
    const store = new ApiKeyStore(filename, { legacyToken });
    await assert.rejects(store.authenticate(legacyToken), { status: 503 });
    await assert.rejects(store.list(), { status: 503 });
    assert.equal(await readFile(filename, "utf-8"), text);
  }
});

test("authorization is checked again before publishing a queued mutation", async (t) => {
  const { store } = await fixture(t);
  await store.initialize();
  let checks = 0;
  const { ApiKeyError } = await import("../src/api-keys.js");
  await assert.rejects(
    store.create("Expired session", {
      beforeMutation: () => {
        if (++checks > 1) {
          throw new ApiKeyError(401, "Session expired.");
        }
      },
    }),
    { status: 401 },
  );
  assert.equal((await store.list()).length, 1);
});
