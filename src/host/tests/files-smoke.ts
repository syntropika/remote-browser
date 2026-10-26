import { readFile } from "node:fs/promises";
import filePath from "node:path";

import { cli, assert, Runtime, temporary, serve, wait } from "./harness.js";

const { join } = filePath;
const payload = Buffer.from([
  108, 111, 99, 97, 108, 32, 102, 105, 108, 101, 32, 119, 111, 114, 107, 115, 112, 97, 99, 101, 0,
  255, 10,
]);
export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  const handler = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      return Response.json({
        received: Buffer.from(await request.arrayBuffer()).includes(payload),
      });
    }
    if (
      path === "/private" &&
      !request.headers.get("cookie")?.includes("workspace_session=valid")
    ) {
      return new Response(null, { status: 401 });
    }
    const data =
      path === "/large"
        ? Buffer.alloc(20 * 1024 * 1024 + 1, 120)
        : ["/private", "/no-cors"].includes(path)
          ? payload
          : '<!doctype html><title>Files test</title><input id="file" type="file" multiple><input id="text"><button id="upload">Submit file</button><pre id="result"></pre><script>document.getElementById("upload").onclick=async()=>{const body=new FormData();body.append("file",document.getElementById("file").files[0]);const response=await fetch("/upload",{method:"POST",body});document.getElementById("result").textContent=await response.text();};</script>';
    return new Response(data, {
      headers: {
        "Content-Type": typeof data === "string" ? "text/html" : "application/octet-stream",
        "Set-Cookie": "workspace_session=valid; HttpOnly; SameSite=Lax",
      },
    });
  };
  const server = serve(handler);
  const other = serve(handler);
  try {
    await temporary(async (root) => {
      const env = { ...process.env, REMOTE_BROWSER_FILES_ROOT: join(root, "shared") };
      let runtime = await Runtime.launch(host, engine, join(root, "browser"), { env });
      try {
        const c = runtime.client;
        const d = runtime.dashboard;
        const files = (action: string, args: any = {}) =>
          c.call("browser_files", {
            action,
            ...args,
          });
        const tab = await runtime.dashboard.action("open", null, {}, "default");
        const lease = (
          await c.call("browser_tabs", {
            action: "reserve",
            tabId: tab,
            agentName: "Test agent",
            task: "files smoke",
          })
        ).leaseId;
        const target = { leaseId: lease };
        const evaluate = async (script: string) =>
          (
            await c.call("browser_evaluate", {
              ...target,
              function: `() => {\n${script}\n}`,
            })
          ).value;
        await c.call("browser_navigate", {
          ...target,
          url: server.origin,
        });
        assert.equal((await files("list")).root, join(root, "shared/default"));
        const staged = await files("stage", {
          name: "test.bin",
          offset: 0,
          data: payload.toString("base64"),
        });
        assert.deepEqual(await readFile(staged.path), payload);
        await c.call(
          "browser_files",
          {
            action: "stage",
            name: "test.bin",
            offset: 0,
            data: "eA==",
          },
          true,
        );
        let snapshot = await c.call("browser_snapshot", target);
        const textRef = snapshot.elements.find(
          (e: any) => e.tag === "input" && e.type !== "file",
        ).reference;
        await c.call(
          "browser_upload",
          {
            ...target,
            target: textRef,
            fileIds: ["uploads/test.bin"],
          },
          true,
        );
        assert.equal(await evaluate("return document.getElementById('text').value;"), "");
        snapshot = await c.call("browser_snapshot", target);
        const { reference } = snapshot.elements.find((e: any) => e.type === "file");
        await c.call(
          "browser_upload",
          {
            tabId: tab,
            target: reference,
            fileIds: ["uploads/test.bin"],
          },
          true,
        );
        await c.call("browser_upload", {
          ...target,
          target: reference,
          fileIds: ["uploads/test.bin"],
        });
        assert.deepEqual(
          await evaluate(
            "return {name:document.getElementById('file').files[0].name,size:document.getElementById('file').files[0].size};",
          ),
          { name: "test.bin", size: payload.length },
        );
        await evaluate("document.getElementById('upload').click();return true;");
        assert(
          JSON.parse(
            await wait(() => evaluate("return document.getElementById('result').textContent;")),
          ).received,
        );
        const download = async (url: string, name: string, error = false) =>
          c.call(
            "browser_download",
            {
              ...target,
              url,
              name,
            },
            error,
          );
        const downloaded = await download("/private", "private.bin");
        assert.deepEqual(await readFile(downloaded.path), payload);
        assert.deepEqual(
          Buffer.from(
            (await files("read", { fileId: "downloads/private.bin", offset: 0 })).data,
            "base64",
          ),
          payload,
        );
        const blob = await evaluate("return URL.createObjectURL(new Blob(['blob download']));");
        const blobFile = await download(blob, "blob.txt");
        assert.equal(await readFile(blobFile.path, "utf-8"), "blob download");
        await files("delete", { fileId: "downloads/blob.txt" });
        const chunk = Buffer.alloc(32_768, 97);
        await files("stage", { name: "chunks.bin", offset: 0, data: chunk.toString("base64") });
        await files("stage", {
          name: "chunks.bin",
          offset: chunk.length,
          data: payload.toString("base64"),
        });
        assert.deepEqual(
          Buffer.from(
            (await files("read", { fileId: "uploads/chunks.bin", offset: chunk.length })).data,
            "base64",
          ),
          payload,
        );
        await files("delete", { fileId: "uploads/chunks.bin" });
        for (const [url, name] of [
          ["/private", "private.bin"],
          ["/large", "large.bin"],
          [`${other.origin}/no-cors`, "cors.bin"],
        ]) {
          await download(url, name, true);
        }
        await c.call(
          "browser_files",
          {
            action: "delete",
            fileId: "uploads/../../outside",
          },
          true,
        );
        const profile = (
          await c.call("browser_profiles", {
            action: "create",
            name: "Other account",
          })
        ).id;
        assert.deepEqual((await files("list", { profileId: profile })).files, []);
        await c.call(
          "browser_files",
          {
            action: "delete",
            profileId: profile,
            fileId: "uploads/test.bin",
          },
          true,
        );
        await c.call("browser_snapshot", target);
        await d.action("take", tab);
        await d.action("input", tab, { kind: "click", x: 20, y: 15 });
        assert(
          (
            await wait(
              () => files("list"),
              (value) => value.pickers.length,
            )
          ).pickers.length,
        );
        await c.call(
          "browser_files",
          {
            action: "choose",
            ...target,
            fileIds: ["uploads/test.bin"],
          },
          true,
        );
        await d.action("choose_files", tab, { fileIds: ["uploads/test.bin"] });
        assert.equal((await files("list")).pickers.length, 0);
        for (const fileId of ["uploads/test.bin", "downloads/private.bin"]) {
          await files("delete", { fileId });
        }
        assert.deepEqual((await files("list")).files, []);
        assert(
          !(await Bun.file(staged.path).exists()) && !(await Bun.file(downloaded.path).exists()),
        );
        assert(!(await c.call("browser_status", {})).uncertain);
      } finally {
        await runtime.stop();
      }
      const logs = runtime.logs.join("\n");
      for (const privateText of [
        join(root, "shared"),
        "uploads/test.bin",
        payload.toString("base64"),
      ]) {
        assert(!logs.includes(privateText));
      }
      runtime = await Runtime.launch(host, engine, join(root, "browser"), { env });
      try {
        assert.deepEqual(
          (
            await runtime.client.call("browser_files", {
              action: "list",
            })
          ).files,
          [],
        );
      } finally {
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
    await other.stop();
  }
  console.log(
    "PASS: workspace isolation, native upload/submission, authenticated downloads, limits/CORS, picker, reads and cleanup",
  );
}
if (import.meta.main) {
  await cli(run);
}
