import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { attempt, run, SerialOperations, withFile } from "../src/effects.js";
import { AccountError } from "../src/account.js";

test("the Promise boundary preserves tagged domain errors and their HTTP status", async () => {
  const error = new AccountError(409, "Already configured.");
  await assert.rejects(
    run(Effect.fail(error)),
    (caught) => caught === error && caught.status === 409,
  );
});

test("scoped file handles close after a failing operation", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "remote-browser-effect-"),
  );
  let handle;
  try {
    const filename = path.join(directory, "sample");
    await writeFile(filename, "sample");
    await assert.rejects(
      run(
        withFile(filename, "r", undefined, (file) => {
          handle = file;
          return Effect.fail(new Error("Expected failure"));
        }),
      ),
      /Expected failure/,
    );
    await assert.rejects(handle.stat(), /closed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serialized effects hold the permit through cleanup and recover after failure", async () => {
  const queue = new SerialOperations();
  const order: string[] = [];
  let release;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.execute(
    attempt(() => pending).pipe(
      Effect.flatMap(() => Effect.fail(new Error("Expected failure"))),
      Effect.ensuring(
        Effect.sync(() => {
          order.push("cleanup");
        }),
      ),
    ),
  );
  const rejected = assert.rejects(first, /Expected failure/);
  const second = queue.execute(
    Effect.sync(() => {
      order.push("next");
      return 42;
    }),
  );
  assert.deepEqual(order, []);
  release();
  await rejected;
  assert.equal(await second, 42);
  assert.deepEqual(order, ["cleanup", "next"]);
  await queue.drain();
});
