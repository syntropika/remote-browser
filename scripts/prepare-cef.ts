/** Prepare the pinned CEF runtime without compiling Chromium. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import filePath from "node:path";
import { isDeepStrictEqual } from "node:util";

import { list, extract } from "tar";

const { join, resolve } = filePath;

const root = resolve(import.meta.dirname, "..");

export type Asset = {
  url: string;
  sha256: string;
  librarySha256: string;
  sha1: string;
  fileName: string;
  archiveRoot: string;
};

const required = [
  "libcef.so",
  "resources.pak",
  "icudtl.dat",
  "locales/en-US.pak",
  "include/cef_api_versions.h",
  "CMakeLists.txt",
  "LICENSE.txt",
  "CREDITS.html",
];

export async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const block of createReadStream(path)) {
    if (typeof block !== "string" && !Buffer.isBuffer(block)) {
      throw new TypeError("Unexpected CEF file chunk");
    }
    hash.update(block);
  }
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function validate(runtime: string, asset: Asset): Promise<void> {
  for (const name of required) {
    if (!(await stat(join(runtime, name))).isFile()) {
      throw new Error(`Incomplete CEF runtime: ${name}`);
    }
  }
  if ((await digest(join(runtime, "libcef.so"))) !== asset.librarySha256) {
    throw new Error("Cached CEF library checksum mismatch; remove its cache directory and retry");
  }
  const metadata: unknown = JSON.parse(await readFile(join(runtime, "archive.json"), "utf-8"));
  if (!isDeepStrictEqual(metadata, { type: "minimal", name: asset.fileName, sha1: asset.sha1 })) {
    throw new Error("CEF archive metadata does not match the pinned release");
  }
}

/** flock releases its lock on stdin EOF, including when the parent exits unexpectedly. */
async function lock(path: string): Promise<() => Promise<void>> {
  const child = Bun.spawn(["flock", "-x", path, "sh", "-c", 'printf "locked\n"; cat >/dev/null'], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  if (first.done || !new TextDecoder().decode(first.value).includes("locked")) {
    throw new Error("Unable to lock the CEF cache");
  }
  reader.releaseLock();
  return async () => {
    await child.stdin.end();
    if ((await child.exited) !== 0) {
      throw new Error("CEF cache lock failed");
    }
  };
}

export async function prepare(asset: Asset, cache: string): Promise<string> {
  if (
    !/^[a-f\d]{64}$/u.test(asset.sha256) ||
    !/^[\w.+-]+$/u.test(asset.archiveRoot) ||
    [".", ".."].includes(asset.archiveRoot)
  ) {
    throw new Error("Invalid CEF asset metadata");
  }
  await mkdir(cache, { recursive: true });
  const unlock = await lock(join(cache, `${asset.sha256}.lock`));
  let stage: string | undefined;
  try {
    const destination = join(cache, asset.sha256);
    if (await exists(destination)) {
      await validate(destination, asset);
      return destination;
    }
    stage = await mkdtemp(join(cache, ".prepare-"));
    const archive = join(stage, "cef.tar.gz");
    console.error(`Downloading ${asset.fileName}…`);
    const response = await fetch(asset.url, {
      headers: { "User-Agent": "remote-browser-cef" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`CEF download failed: HTTP ${response.status}`);
    }
    await writeFile(archive, response.body);
    if ((await digest(archive)) !== asset.sha256) {
      throw new Error("CEF download checksum mismatch; nothing was installed");
    }
    // Validate every entry before extraction; links and special files are forbidden.
    let unsafe = false;
    await list({
      file: archive,
      strict: true,
      onReadEntry(entry) {
        const parts = entry.path.split("/");
        unsafe ||=
          entry.path.startsWith("/") ||
          parts.includes("..") ||
          parts[0] !== asset.archiveRoot ||
          !["File", "Directory"].includes(entry.type);
      },
    });
    if (unsafe) {
      throw new Error("CEF archive contains an unexpected path or file type");
    }
    const extracted = join(stage, "extracted");
    await mkdir(extracted);
    await extract({ file: archive, cwd: extracted, strict: true });
    const source = join(extracted, asset.archiveRoot);
    const runtime = join(stage, "runtime");
    await mkdir(runtime);
    for (const directory of ["Release", "Resources"]) {
      for (const child of await readdir(join(source, directory))) {
        await rename(join(source, directory, child), join(runtime, child));
      }
    }
    for (const name of [
      "cmake",
      "include",
      "libcef_dll",
      "CMakeLists.txt",
      "LICENSE.txt",
      "CREDITS.html",
    ]) {
      await rename(join(source, name), join(runtime, name));
    }
    await writeFile(
      join(runtime, "archive.json"),
      `${JSON.stringify({ type: "minimal", name: asset.fileName, sha1: asset.sha1 }, null, 2)}\n`,
    );
    await validate(runtime, asset);
    await rename(runtime, destination);
    return destination;
  } finally {
    if (stage) {
      await rm(stage, { recursive: true, force: true });
    }
    await unlock();
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const build = args.includes("--build");
  const cargo = args.filter((arg) => arg !== "--build");
  if (cargo.length && !build) {
    throw new Error("Cargo arguments require --build");
  }
  let runtime: string;
  if (process.env.CEF_PATH) {
    runtime = resolve(process.env.CEF_PATH.replace(/^~(?=\/)/u, homedir()));
    if (!(await exists(join(runtime, "archive.json")))) {
      throw new Error("CEF_PATH must point to an existing flat CEF runtime with archive.json");
    }
  } else {
    if (process.platform !== "linux" || process.arch !== "x64") {
      throw new Error(
        "The published custom CEF supports Linux x86-64; set CEF_PATH for another runtime",
      );
    }
    let target = process.env.CARGO_BUILD_TARGET || "x86_64-unknown-linux-gnu";
    for (let i = 0; i < cargo.length; i++) {
      if (cargo[i] === "--target") {
        target = cargo[i + 1];
      } else if (cargo[i].startsWith("--target=")) {
        target = cargo[i].slice(9);
      }
    }
    if (target !== "x86_64-unknown-linux-gnu") {
      throw new Error("Cross builds require an explicit matching CEF_PATH");
    }
    // SAFETY: the checked-in manifest supplies this fixed platform contract; prepare validates paths and hashes.
    const manifest = JSON.parse(
      await readFile(join(root, "src/engine/cef/runtime.json"), "utf-8"),
    ) as { schemaVersion: number; platforms: { "linux-x64": Asset } };
    if (manifest.schemaVersion !== 1) {
      throw new Error("Unsupported CEF runtime manifest version");
    }
    runtime = await prepare(
      manifest.platforms["linux-x64"],
      resolve(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "remote-browser/cef"),
    );
  }
  if (build) {
    return Bun.spawn(
      [
        "cargo",
        "build",
        "--locked",
        "--manifest-path",
        join(root, "src/engine/Cargo.toml"),
        ...cargo,
      ],
      {
        cwd: root,
        env: { ...process.env, CEF_PATH: runtime },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    ).exited;
  }
  console.log(runtime);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (cause) {
    console.error(`CEF preparation failed: ${String(cause)}`);
    process.exitCode = 1;
  }
}
