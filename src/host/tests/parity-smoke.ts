import { readFile } from "node:fs/promises";

import { reservePage, cli, assert, Runtime, temporary, serve, sleep, wait } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  let ones = 0;
  let posts = 0;
  const server = serve(async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      assert.equal(path, "/export");
      posts++;
      assert((await request.text()).includes("single+original+POST"));
      assert(request.headers.get("cookie")?.includes("native_export=synthetic"));
      return new Response("export from the single original POST", {
        headers: {
          "Content-Type": "text/plain",
          "Content-Disposition": 'attachment; filename="post-export.txt"',
        },
      });
    }
    if (path.startsWith("/attachment")) {
      return new Response("automatic authenticated GET", {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="automatic.txt"',
        },
      });
    }
    if (path.startsWith("/plain")) {
      return new Response("download attribute response", {
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (path.startsWith("/one")) {
      ones++;
    }
    return new Response(
      `<!doctype html><title>${path.startsWith("/two") ? "Two" : "One"}</title><h1>Native feature fixture</h1><input id="notes"><a download="attribute.txt" href="/plain">Download attribute</a><form method="post" action="/export"><input name="payload" value="single original POST"><button>Export</button></form>`,
      {
        headers: {
          "Content-Type": "text/html",
          "Set-Cookie": "native_export=synthetic; HttpOnly; Path=/",
        },
      },
    );
  });
  try {
    await temporary(async (root) => {
      const runtime = await Runtime.launch(host, engine, root);
      try {
        const c = runtime.client;
        assert(
          (await c.request("tools/list", {})).tools.some((t: any) => t.name === "browser_control"),
        );
        const tab = await runtime.dashboard.action("open", null, {}, "default");
        const lease = (await reservePage(c, tab)).leaseId;
        const control = (action: string, args: any = {}) =>
          c.call("browser_control", {
            leaseId: lease,
            action,
            ...args,
          });
        const evaluate = async (script: string) =>
          (
            await c.call("browser_evaluate", {
              leaseId: lease,
              function: `() => {\n${script}\n}`,
            })
          ).value;
        const navigate = (path: string) =>
          c.call("browser_navigate", {
            leaseId: lease,
            url: server.origin + path,
          });
        const files = async () =>
          (
            await c.call("browser_files", {
              action: "list",
            })
          ).files;
        const saved = (suffix: string) =>
          wait(async () => (await files()).find((file: any) => file.id.endsWith(suffix)));
        await navigate("/one");
        await navigate("/two");
        await control("back");
        assert.equal(
          (
            await c.call("browser_snapshot", {
              leaseId: lease,
            })
          ).title,
          "One",
        );
        await control("forward");
        assert.equal(
          (
            await c.call("browser_snapshot", {
              leaseId: lease,
            })
          ).title,
          "Two",
        );
        await control("back");
        const before = ones;
        await control("reload");
        assert.equal(ones, before + 1);
        await control("clipboard_write", { text: "Native clipboard text" });
        assert.equal((await control("clipboard_read")).text, "Native clipboard text");
        await evaluate("document.getElementById('notes').focus();return true;");
        await control("clipboard_paste");
        assert.equal(
          await evaluate("return document.getElementById('notes').value;"),
          "Native clipboard text",
        );
        await evaluate("document.getElementById('notes').select();return true;");
        await control("clipboard_copy");
        assert.equal((await control("clipboard_read")).text, "Native clipboard text");
        const image = await control("save_screenshot", { name: "fixture.png" });
        const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        assert((await readFile(image.path)).subarray(0, 8).equals(png));
        const response = await fetch(
          `${runtime.url}/api/files/content?profileId=default&fileId=${encodeURIComponent(image.id)}`,
          { headers: { Range: "bytes=0-7" } },
        );
        assert.equal(response.status, 206);
        assert(Buffer.from(await response.arrayBuffer()).equals(png));
        await control("record_start", { name: "fixture.mp4", maxSeconds: 2 });
        await sleep(2500);
        const recording = await control("record_status");
        assert.equal(recording.file.id, "recordings/fixture.mp4");
        const probe = Bun.spawn(
          ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", recording.file.path],
          { stdout: "pipe", stderr: "pipe" },
        );
        const metadata = await new Response(probe.stdout).json();
        assert.equal(await probe.exited, 0);
        assert.equal(metadata.streams[0].codec_name, "h264");
        await navigate("/attachment");
        assert.equal(
          await readFile((await saved("automatic.txt")).path, "utf-8"),
          "automatic authenticated GET",
        );
        await navigate("/one");
        await evaluate("document.querySelector('a').click();return true;");
        assert.equal(
          await readFile((await saved("attribute.txt")).path, "utf-8"),
          "download attribute response",
        );
        await navigate("/one");
        await evaluate("document.querySelector('form').requestSubmit();return true;");
        assert.equal(
          await readFile((await saved("post-export.txt")).path, "utf-8"),
          "export from the single original POST",
        );
        assert.equal(posts, 1);
        await navigate("/one");
        await evaluate(
          "const a=document.createElement('a');a.download='blob.txt';a.href=URL.createObjectURL(new Blob(['blob download']));document.body.append(a);a.click();return true;",
        );
        assert.equal(await readFile((await saved("blob.txt")).path, "utf-8"), "blob download");
        for (const file of await files()) {
          await c.call("browser_files", {
            action: "delete",
            fileId: file.id,
          });
        }
        assert.deepEqual(await files(), []);
      } finally {
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
  }
  console.log(
    "PASS: history, clipboard, PNG ranges, playable MP4, automatic downloads and single POST export",
  );
}
if (import.meta.main) {
  await cli(run);
}
