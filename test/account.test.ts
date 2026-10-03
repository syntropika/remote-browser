import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AccountStore } from "../src/account.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-browser-account-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "account.json");
  return { directory, filename, store: new AccountStore(filename) };
}

test("the owner persists privately and usernames are normalized without changing passwords", async (t) => {
  const { store, filename } = await fixture(t);
  const password = "  a sufficiently long password  ";
  assert.equal(await store.configured(), false);
  await store.create({ username: "  Cérberus  ", password });
  assert.equal(await store.configured(), true);
  const recreated = new AccountStore(filename);
  assert.equal(await recreated.verify({ username: "CÉRBERUS", password }), true);
  assert.equal(await recreated.verify({ username: "Cérberus", password: password.trim() }), false);
  assert.equal(await recreated.verify({ username: "another-user", password }), false);
  assert.equal(
    await recreated.verify({
      username: "Cérberus",
      password: "wrong-password-value",
    }),
    false,
  );
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await readFile(filename, "utf-8")).includes(password), false);
});

test("competing setup requests can publish only one owner, including across store instances", async (t) => {
  const { store, filename } = await fixture(t);
  const other = new AccountStore(filename);
  const candidates = [
    { username: "first-owner", password: "first-owner-password" },
    { username: "second-owner", password: "second-owner-password" },
  ];
  const results = await Promise.allSettled([
    store.create(candidates[0]),
    other.create(candidates[1]),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.status, 409);
  const winner = results.findIndex((result) => result.status === "fulfilled");
  assert.equal(await store.verify(candidates[winner]), true);
  assert.equal(await other.verify(candidates[1 - winner]), false);
  await assert.rejects(store.create(candidates[1 - winner]), { status: 409 });
  assert.equal(await store.verify(candidates[winner]), true);
});

test("invalid setup input cannot initialize or overwrite an account", async (t) => {
  const { store } = await fixture(t);
  for (const input of [
    null,
    { username: "aa", password: "a sufficiently long password" },
    { username: "owner\u0000", password: "a sufficiently long password" },
    { username: "owner", password: "short" },
    { username: "owner", password: "x".repeat(257) },
  ]) {
    await assert.rejects(store.create(input), { status: 400 });
    assert.equal(await store.configured(), false);
  }
  assert.equal(
    await store.verify({
      username: "owner",
      password: "a sufficiently long password",
    }),
    false,
  );
});

test("corrupted account storage fails closed for status, setup, and sign-in", async (t) => {
  const { store, filename } = await fixture(t);
  for (const contents of ["{invalid", "{}", JSON.stringify({ version: 2 })]) {
    await writeFile(filename, contents, { mode: 0o600 });
    await assert.rejects(store.configured(), { status: 503 });
    await assert.rejects(
      store.create({ username: "new-owner", password: "replacement-password" }),
      { status: 503 },
    );
    await assert.rejects(
      store.verify({ username: "new-owner", password: "replacement-password" }),
      { status: 503 },
    );
    assert.equal(await readFile(filename, "utf-8"), contents);
  }
});

test("account storage cannot redirect credentials through a symbolic link", async (t) => {
  const { store, filename, directory } = await fixture(t);
  const target = path.join(directory, "unrelated-file");
  await writeFile(target, "preserve this file");
  await symlink(target, filename);
  await assert.rejects(store.configured(), { status: 503 });
  await assert.rejects(store.create({ username: "new-owner", password: "replacement-password" }), {
    status: 503,
  });
  assert.equal(await readFile(target, "utf-8"), "preserve this file");
});

test("password derivations have a concurrency bound instead of an unbounded work queue", async (t) => {
  const { store } = await fixture(t);
  const attempts = await Promise.allSettled(
    Array.from({ length: 3 }, async () =>
      store.verify({ username: "unknown", password: "invalid-password" }),
    ),
  );
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(attempts.find((result) => result.status === "rejected").reason.status, 429);
});
