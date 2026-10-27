/** Package and publish only the standalone client; CEF and host binaries are never included. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const platforms = [
  { runner: "ubuntu-22.04", target: "x86_64-unknown-linux-musl", name: "linux-x64" },
  { runner: "ubuntu-24.04-arm", target: "aarch64-unknown-linux-musl", name: "linux-arm64" },
  { runner: "macos-15-intel", target: "x86_64-apple-darwin", name: "macos-x64" },
  { runner: "macos-15", target: "aarch64-apple-darwin", name: "macos-arm64" },
  { runner: "windows-2022", target: "x86_64-pc-windows-msvc", name: "windows-x64" },
] as const;

export function releaseTag(commit: string): string {
  if (!/^[a-f\d]{40}$/u.test(commit)) {
    throw new Error("Release requires a full source commit");
  }
  return `mcp-${commit}`;
}

export function assetName(name: string): string {
  if (!platforms.some((platform) => platform.name === name)) {
    throw new Error("Unknown client platform");
  }
  return `remote-browser-${name}${name.startsWith("windows-") ? ".exe" : ""}`;
}

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
      throw new TypeError("Unexpected client file chunk");
    }
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function command(args: string[]) {
  const process = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  if ((await process.exited) !== 0) {
    throw new Error(`Release operation failed: ${args[0]}`);
  }
}

async function main() {
  const [operation, platformName] = process.argv.slice(2);
  const directory = "dist/local-mcp";
  if (operation === "package") {
    const platform = platforms.find((item) => item.name === platformName);
    if (!platform) {
      throw new Error("Select a supported client platform");
    }
    const binary = `remote-browser${platform.name.startsWith("windows-") ? ".exe" : ""}`;
    await mkdir(directory, { recursive: true });
    const destination = path.join(directory, assetName(platform.name));
    await copyFile(`src/local-mcp/target/${platform.target}/release/${binary}`, destination);
    if (!platform.name.startsWith("windows-")) {
      await chmod(destination, 0o755);
    }
    const probe = Bun.spawn([path.resolve(destination), "--version"], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const version = (await new Response(probe.stdout).text()).trim();
    const revision = process.env.REMOTE_BROWSER_BUILD_REVISION || "development";
    if ((await probe.exited) !== 0 || !version.endsWith(`+${revision}`)) {
      throw new Error("The packaged client must run and identify its source revision");
    }
    console.log(version);
  } else if (operation === "publish") {
    const commit = process.env.GITHUB_SHA || "";
    const repository = process.env.GITHUB_REPOSITORY || "";
    if (process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== "refs/heads/main") {
      throw new Error("Only a main-branch push may publish client releases");
    }
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
      throw new Error("Invalid release repository");
    }
    const tag = releaseTag(commit);
    const assets = platforms.map(({ name }) => assetName(name));
    const actual = (await readdir(directory)).toSorted();
    if (JSON.stringify(actual) !== JSON.stringify([...assets].toSorted())) {
      throw new Error("The complete client platform matrix is required before publication");
    }
    const hashes: Record<string, string> = {};
    for (const asset of assets) {
      hashes[asset] = await digest(path.join(directory, asset));
    }
    await writeFile(
      path.join(directory, "SHA256SUMS"),
      assets.map((asset) => `${hashes[asset]}  ${asset}\n`).join(""),
    );
    await writeFile(
      path.join(directory, "mcp-release.json"),
      `${JSON.stringify({ version: tag, sourceCommit: commit, networkProtocol: 1, assets: hashes }, null, 2)}\n`,
    );
    for (const installer of ["install-mcp.sh", "install-mcp.ps1"]) {
      await copyFile(`scripts/${installer}`, path.join(directory, installer));
    }
    const notes = path.join(directory, "release-notes.md");
    await writeFile(
      notes,
      `Standalone local MCP and TCP network connector for Remote Browser.\n\nSource: ${commit}. No CEF, Rust toolchain, Node.js or Bun is required on the client. Configure the Remote Browser server URL and API key, then expose local destinations explicitly with browser_network.\n\nDownload the executable for your operating system and architecture. SHA256SUMS and mcp-release.json identify the exact build. Installers support a pinned REMOTE_BROWSER_MCP_VERSION. These clients require a server with network-session support.\n`,
    );
    const exists = Bun.spawn(
      ["gh", "release", "view", tag, "--repo", repository, "--json", "isDraft"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const existing = await new Response(exists.stdout).text();
    const found = (await exists.exited) === 0;
    const release: unknown = found ? JSON.parse(existing) : { isDraft: true };
    if (
      !release ||
      typeof release !== "object" ||
      !("isDraft" in release) ||
      typeof release.isDraft !== "boolean"
    ) {
      throw new Error("Invalid existing release metadata");
    }
    if (found && !release.isDraft) {
      console.log(`Release ${tag} already exists; published assets are never replaced.`);
      return;
    }
    if (!found) {
      await command([
        "gh",
        "release",
        "create",
        tag,
        "--repo",
        repository,
        "--target",
        commit,
        "--title",
        `Remote Browser MCP ${commit.slice(0, 12)}`,
        "--notes-file",
        notes,
        "--latest=false",
        "--draft",
      ]);
    }
    await command([
      "gh",
      "release",
      "upload",
      tag,
      "--repo",
      repository,
      "--clobber",
      ...[...assets, "SHA256SUMS", "mcp-release.json", "install-mcp.sh", "install-mcp.ps1"].map(
        (file) => path.join(directory, file),
      ),
    ]);
    await command([
      "gh",
      "release",
      "edit",
      tag,
      "--repo",
      repository,
      "--draft=false",
      "--latest=false",
    ]);
  } else {
    throw new Error("Use package <platform> or publish");
  }
}

if (import.meta.main) {
  await main();
}
