import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import filePath from "node:path";

import { assetName, platforms, releaseTag } from "./release-local-mcp.js";

const { join, resolve } = filePath;
const commit = "a".repeat(40);

test("client releases identify immutable source and cover the complete executable matrix", () => {
  expect(releaseTag(commit)).toBe(`mcp-${commit}`);
  expect(() => releaseTag("main")).toThrow();
  expect(platforms.map(({ name }) => assetName(name))).toEqual([
    "remote-browser-linux-x64",
    "remote-browser-linux-arm64",
    "remote-browser-macos-x64",
    "remote-browser-macos-arm64",
    "remote-browser-windows-x64.exe",
  ]);
  expect(() => assetName("cef-linux-x64")).toThrow();
});

test("client publication is restricted to main pushes and client build inputs", async () => {
  const source = await readFile(resolve(".github/workflows/local-mcp-release.yml"), "utf-8");
  const object = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected a workflow mapping");
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = item;
    }
    return result;
  };
  const workflow = object(Bun.YAML.parse(source));
  const push = object(object(workflow.on).push);
  const jobs = object(workflow.jobs);
  const publish = object(jobs.publish);
  const matrix = object(object(object(jobs.build).strategy).matrix);
  expect(push.branches).toEqual(["main"]);
  expect(push.paths).toContain("src/local-mcp/**");
  expect(push.paths).toContain("src/network/**");
  expect(push.paths).not.toContain("ui/**");
  expect(publish.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(publish.needs).toBe("build");
  expect(matrix.include).toEqual([...platforms]);
  const child = Bun.spawn([process.execPath, "scripts/release-local-mcp.ts", "publish"], {
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/1/merge",
      GITHUB_SHA: commit,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).not.toBe(0);
  expect(errors).toContain("Only a main-branch push");
  expect(output).not.toContain("Release");
});

test.skipIf(process.platform === "win32")(
  "installer selects MCP assets, verifies bytes and preserves the installed binary on checksum failure",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-browser-installer-"));
    try {
      const tools = join(root, "tools");
      const destination = join(root, "installed");
      await mkdir(tools);
      const bytes = "synthetic precompiled executable";
      const hash = createHash("sha256").update(bytes).digest("hex");
      await writeFile(join(root, "asset"), bytes);
      await writeFile(join(root, "SHA256SUMS"), `${hash}  remote-browser-linux-x64\n`);
      await writeFile(
        join(tools, "uname"),
        '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n',
      );
      await chmod(join(tools, "uname"), 0o755);
      await writeFile(
        join(tools, "curl"),
        `#!${process.execPath}\nconst args=process.argv.slice(2);const out=args.indexOf('-o');if(out<0){console.log(JSON.stringify([{tag_name:'cef-154.0.34-rb.1'},{tag_name:'mcp-${commit}'}]));}else{const name=args[out-1].endsWith('/SHA256SUMS')?'SHA256SUMS':'asset';await Bun.write(args[out+1],await Bun.file(${JSON.stringify(root)}+'/'+name).bytes());}\n`,
      );
      await chmod(join(tools, "curl"), 0o755);
      const install = async () => {
        const child = Bun.spawn(["sh", "scripts/install-mcp.sh"], {
          env: {
            ...process.env,
            PATH: `${tools}:${process.env.PATH}`,
            REMOTE_BROWSER_MCP_VERSION: "",
            REMOTE_BROWSER_MCP_INSTALL_DIR: destination,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [output, errors, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { output, errors, code };
      };
      expect((await install()).code).toBe(0);
      expect(await readFile(join(destination, "remote-browser"), "utf-8")).toBe(bytes);
      await writeFile(join(root, "asset"), "corrupt download");
      const failed = await install();
      expect(failed.code).not.toBe(0);
      expect(failed.errors).toContain("checksum mismatch");
      expect(failed.output).toBe("");
      expect(await readFile(join(destination, "remote-browser"), "utf-8")).toBe(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
