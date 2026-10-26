import { writeFile } from "node:fs/promises";
import filePath from "node:path";

import { Browser, mapper, waitForDisplay } from "../tools/human-pointer.js";
import { FRAME } from "./fixtures/human-pointer-smoke.js";
/** Real Chrome dashboard pointer regression; --chrome is required. */
import { cli, assert, Runtime, serve, temporary, wait, sleep } from "./harness.js";
import { page } from "./human-pointer-smoke.js";

export async function run(engine: string, host: string, args: Record<string, any>) {
  assert(host && args.chrome, "--host-binary and --chrome are required");
  const server = serve(
    (request, origin) =>
      new Response(new URL(request.url).pathname === "/frame" ? FRAME : page(origin), {
        headers: { "Content-Type": "text/html" },
      }),
  );
  try {
    await temporary(async (root) => {
      const graphicsEngine = filePath.join(root, "graphics-engine");
      const executable = filePath.resolve(engine).replaceAll("'", "'\\''");
      await writeFile(
        graphicsEngine,
        `#!/bin/sh\nexec '${executable}' --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader "$@"\n`,
        { mode: 0o700 },
      );
      const runtime = await Runtime.launch(host, graphicsEngine, root);
      let browser: Browser | undefined;
      try {
        const c = runtime.client;
        const tab = (await c.call("browser_tabs", { action: "list" })).tabs[0].id;
        await c.call("browser_navigate", { tabId: tab, url: server.origin });
        const read = async () =>
          (
            await c.call("browser_evaluate", {
              tabId: tab,
              script: "return {frame:window.frame,topMoves,topLeft};",
            })
          ).value;
        await wait(read, (v) => v.frame.ready);
        browser = await Browser.launch(args.chrome);
        await browser.open(runtime.url);
        const rect = await waitForDisplay(browser);
        const toScreen = mapper(rect);
        for (let step = 0; step < 9; step++) {
          await browser.mouse("mouseMoved", ...toScreen(100 + step * 22.5, 60 + step * 12.5));
          await sleep(40);
        }
        await browser.mouse("mousePressed", ...toScreen(280, 160), 1);
        await sleep(200);
        await browser.mouse("mouseReleased", ...toScreen(281, 160));
        await browser.mouse("mouseMoved", ...toScreen(600, 500));
        await sleep(100);
        const outside = await browser.evaluate(
          "(()=>{const r=document.querySelector('canvas[aria-label=\"Browser page\"]').getBoundingClientRect();return [[r.left-8,r.top+8],[r.right+8,r.top+8],[r.left+8,r.top-8],[r.left+8,r.bottom+8]].find(([x,y])=>x>=0&&y>=0&&x<innerWidth&&y<innerHeight)})()",
        );
        assert(outside);
        await browser.mouse("mouseMoved", outside[0], outside[1]);
        const result = await wait(read, (v) => v.frame.state?.left && v.topLeft);
        const { state } = result.frame;
        assert(result.topMoves >= 3 && state.movesBeforeDown >= 3 && state.boxHover);
        assert(state.up - state.down >= 100 && state.click && state.checked);
      } finally {
        if (browser) {
          await browser.close();
        }
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
  }
  console.log("PASS: real dashboard pointer forwards motion/hover/duration/leave across sites");
}

if (import.meta.main) {
  await cli(run);
}
