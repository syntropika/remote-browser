import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import filePath from "node:path";
import { gzipSync } from "node:zlib";

import { create, Header } from "tar";

import { prepare } from "./prepare-cef.js";
import type { Asset } from "./prepare-cef.js";

const { join } = filePath;

async function fixture(
  run: (
    asset: Asset,
    cache: string,
    state: { payload: Uint8Array; requests: number },
  ) => Promise<void>,
  unsafe = false,
) {
  const root = await mkdtemp(join(tmpdir(), "cef-prepare-test-"));
  const files = {
    "Release/libcef.so": "native fixture",
    "Resources/resources.pak": "resources",
    "Resources/icudtl.dat": "icu",
    "Resources/locales/en-US.pak": "locale",
    "include/cef_api_versions.h": "headers",
    "cmake/cef_variables.cmake": "cmake",
    "libcef_dll/wrapper.cc": "wrapper",
    "CMakeLists.txt": "cmake project",
    "LICENSE.txt": "license",
    "CREDITS.html": "credits",
  };
  const source = join(root, "cef_fixture");
  for (const [name, value] of Object.entries(files)) {
    await mkdir(join(source, name, ".."), { recursive: true });
    await writeFile(join(source, name), value);
  }
  await writeFile(join(root, "outside"), "unexpected");
  const archive = join(root, "fixture.tar.gz");
  await create(
    { file: archive, cwd: root, gzip: true },
    unsafe ? ["cef_fixture", "outside"] : ["cef_fixture"],
  );
  const state = { payload: new Uint8Array(await readFile(archive)), requests: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.requests++;
      return new Response(state.payload);
    },
  });
  const hash = (algorithm: string, value: Uint8Array | string) =>
    createHash(algorithm).update(value).digest("hex");
  const asset: Asset = {
    url: `${server.url}cef.tar.gz`,
    fileName: "cef_fixture.tar.gz",
    archiveRoot: "cef_fixture",
    sha256: hash("sha256", state.payload),
    sha1: hash("sha1", state.payload),
    librarySha256: hash("sha256", "native fixture"),
  };
  try {
    await run(asset, join(root, "cache"), state);
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

test("verified download, flat layout, offline cache reuse and damaged cache rejection", async () => {
  await fixture(async (asset, cache, state) => {
    const runtime = await prepare(asset, cache);
    expect(await readFile(join(runtime, "libcef.so"), "utf-8")).toBe("native fixture");
    expect(await Bun.file(join(runtime, "locales/en-US.pak")).exists()).toBe(true);
    expect(await Bun.file(join(runtime, "cmake/cef_variables.cmake")).exists()).toBe(true);
    state.payload = new TextEncoder().encode("unavailable");
    expect(await prepare(asset, cache)).toBe(runtime);
    expect(state.requests).toBe(1);
    await writeFile(join(runtime, "libcef.so"), "damaged");
    await assert.rejects(prepare(asset, cache), /checksum mismatch/u);
  });
});

test("bad download never becomes a runtime and cleans staging", async () => {
  await fixture(async (asset, cache, state) => {
    state.payload = new TextEncoder().encode("truncated");
    await assert.rejects(prepare(asset, cache), /download checksum mismatch/u);
    expect(
      (await readdir(cache)).filter(
        (name) => name.startsWith(".prepare-") || name === asset.sha256,
      ),
    ).toEqual([]);
  });
});

test("unexpected archive entry is rejected before extraction", async () => {
  await fixture(async (asset, cache) => {
    await assert.rejects(prepare(asset, cache), /unexpected path/u);
    expect((await readdir(cache)).filter((name) => name === asset.sha256)).toEqual([]);
  }, true);
});

test("concurrent callers share one verified download", async () => {
  await fixture(async (asset, cache, state) => {
    const [first, second] = await Promise.all([prepare(asset, cache), prepare(asset, cache)]);
    expect(first).toBe(second);
    expect(state.requests).toBe(1);
  });
});

test("explicit CEF_PATH forwards Cargo arguments and its exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "cef-build-cli-"));
  try {
    const runtime = join(root, "runtime");
    await mkdir(runtime);
    await writeFile(join(runtime, "archive.json"), "{}");
    const record = join(root, "cargo.json");
    const cargo = join(root, "cargo");
    await writeFile(
      cargo,
      `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(process.env.CARGO_RECORD,JSON.stringify({args:process.argv.slice(2),cef:process.env.CEF_PATH}));process.exit(17);`,
      { mode: 0o700 },
    );
    const child = Bun.spawn(
      [process.execPath, "run", "scripts/prepare-cef.ts", "--build", "--release"],
      {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          CEF_PATH: runtime,
          CARGO_RECORD: record,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(17);
    const saved: unknown = JSON.parse(await readFile(record, "utf-8"));
    assert.ok(saved && typeof saved === "object" && "args" in saved && "cef" in saved);
    assert.ok(Array.isArray(saved.args));
    assert.deepEqual(saved.args.slice(0, 3), ["build", "--locked", "--manifest-path"]);
    expect(saved.args.at(-1)).toBe("--release");
    expect(saved.cef).toBe(runtime);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const type of ["File", "SymbolicLink"] as const) {
  test(`rejects ${type === "File" ? "traversal" : "symbolic links"} before extraction`, async () => {
    await fixture(async (asset, cache, state) => {
      const block = Buffer.alloc(512);
      const content = type === "File" ? Buffer.from("x") : Buffer.alloc(0);
      new Header({
        path: type === "File" ? "cef_fixture/../../outside" : "cef_fixture/link",
        type,
        size: content.length,
        linkpath: type === "SymbolicLink" ? "../../outside" : "",
        mode: 0o644,
      }).encode(block);
      state.payload = gzipSync(
        Buffer.concat([block, content, Buffer.alloc(content.length ? 511 : 0), Buffer.alloc(1024)]),
      );
      asset.sha256 = createHash("sha256").update(state.payload).digest("hex");
      await assert.rejects(prepare(asset, cache), /unexpected path/u);
      expect(
        (await readdir(cache)).filter(
          (name) => name.startsWith(".prepare-") || name === asset.sha256,
        ),
      ).toEqual([]);
    });
  });
}
