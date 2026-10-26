/** Apply the bridge only to an initialized checkout at the pinned CEF revision. */
import { copyFile, access } from "node:fs/promises";
import filePath from "node:path";

const { join, resolve } = filePath;

const root = import.meta.dirname;

async function git(directory: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(error);
  }
  return output.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);

const chromium = args.find((value) => !value.startsWith("--"));

if (!chromium || args.some((value) => value.startsWith("--") && value !== "--check")) {
  throw new Error("Usage: bun run src/engine/cef/apply.ts /path/to/chromium/src [--check]");
}

const source = resolve(chromium);

const cef = join(source, "cef");

const revision = await git(cef, "rev-parse", "HEAD");

if (!revision.startsWith("14c5a08")) {
  throw new Error(`Expected CEF revision 14c5a08; received ${revision}`);
}

const patches = [
  [source, join(root, "chromium.patch")],
  [cef, join(root, "cef.patch")],
];

const names = [
  "install_bridge.h",
  "install_bridge.cc",
  "install_bridge_capi.h",
  "extension_management.cc",
  "extension_management_capi.h",
];

for (const [directory, patch] of patches) {
  await git(directory, "apply", "--check", patch);
}

for (const name of names) {
  if (await exists(join(cef, "libcef/browser", `remote_browser_${name}`))) {
    throw new Error(`Refusing to replace existing source: ${name}`);
  }
  if (!(await exists(join(root, name)))) {
    throw new Error(`Missing bridge source: ${name}`);
  }
}

if (args.includes("--check")) {
  console.log("The native integration patches apply to this checkout.");
} else {
  for (const [directory, patch] of patches) {
    await git(directory, "apply", patch);
  }
  for (const name of names) {
    await copyFile(join(root, name), join(cef, "libcef/browser", `remote_browser_${name}`));
  }
  console.log("Native installation bridge applied. Regenerate and build CEF before packaging.");
}
