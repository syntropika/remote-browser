/** Website dialogs through the real dashboard, including polling and keyboard dismissal. */
import { writeFile } from "node:fs/promises";
import filePath from "node:path";

import { Browser, mapper, waitForDisplay } from "../tools/human-pointer.js";
import { assert, cli, Runtime, serve, sleep, temporary, wait } from "./harness.js";

export async function run(engine: string, host: string, args: Record<string, any>) {
  assert(host && args.chrome, "--host-binary and --chrome are required");
  const results: unknown[] = [];
  const server = serve(async (request) => {
    if (new URL(request.url).pathname === "/result") {
      results.push(await request.json());
      return new Response("ok");
    }
    return new Response(
      `<!doctype html><style>button{position:absolute;left:20px;top:20px;width:200px;height:60px}</style><button onclick="const result=prompt('Enter a response for this website.','Initial value');fetch('/result',{method:'POST',body:JSON.stringify(result)})">Prompt</button>`,
      { headers: { "Content-Type": "text/html" } },
    );
  });
  try {
    await temporary(async (root) => {
      const graphicsEngine = filePath.join(root, "graphics-engine");
      await writeFile(
        graphicsEngine,
        `#!/bin/sh\nexec '${filePath.resolve(engine).replaceAll("'", "'\\''")}' --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader "$@"\n`,
        { mode: 0o700 },
      );
      const runtime = await Runtime.launch(host, graphicsEngine, root);
      const browser = await Browser.launch(args.chrome);
      try {
        const tab = (await runtime.dashboard.action("tabs"))[0].id;
        await runtime.dashboard.action("navigate", tab, { url: server.origin });
        await browser.open(runtime.url);
        const display = await waitForDisplay(browser);
        const point = mapper(display)(100, 50);
        await browser.mouse("mousePressed", ...point, 1);
        await browser.mouse("mouseReleased", ...point);
        const pending = () =>
          browser.evaluate("document.querySelector('[role=dialog] input')?.value");
        await wait(pending, (value) => value === "Initial value");
        await browser.call("Input.insertText", { text: "Typed response" });
        const typed = await pending();
        assert(typed.includes("Typed response"));
        await sleep(1300);
        assert.equal(
          await pending(),
          typed,
          "Tab polling must preserve the user's prompt response",
        );
        if (process.env.REMOTE_BROWSER_DIALOG_SCREENSHOTS) {
          const output = process.env.REMOTE_BROWSER_DIALOG_SCREENSHOTS;
          await Bun.write(
            `${output}/dialog-desktop.png`,
            Buffer.from(
              (await browser.call("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
          await browser.call("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 1,
            mobile: true,
          });
          await sleep(300);
          await Bun.write(
            `${output}/dialog-mobile.png`,
            Buffer.from(
              (await browser.call("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
        }
        await browser.call("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          text: "\r",
          unmodifiedText: "\r",
        });
        await browser.call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await wait(
          () => ({ results, count: results.length }),
          (state) => state.count === 1,
        );
        assert.equal(results[0], typed);
        await wait(() => browser.evaluate("document.querySelector('[role=dialog]') === null"));
        await browser.evaluate(
          `fetch("/api/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({profileId:"default",op:"input",tabId:${JSON.stringify(tab)},args:{kind:"click",x:100,y:50,displayId:document.querySelector("[data-display-id]").dataset.displayId}})}).then(r=>{if(!r.ok)throw Error("Input failed");return r.json()})`,
        );
        await wait(pending, (value) => value === "Initial value");
        await browser.call("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await browser.call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await wait(
          () => ({ results, count: results.length }),
          (state) => state.count === 2,
        );
        assert.equal(results[1], null);
        await wait(() => browser.evaluate("document.querySelector('[role=dialog]') === null"));
      } finally {
        await browser.close();
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
  }
  console.log(
    "PASS: dashboard prompt accepts typed text across polling, submits with Enter and dismisses with Escape",
  );
}
if (import.meta.main) {
  await cli(run);
}
