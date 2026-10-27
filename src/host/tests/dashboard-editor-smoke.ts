/** A touch on a remote search field opens a local editor and sends trusted native input. */
import { writeFile } from "node:fs/promises";
import filePath from "node:path";

import { Browser, mapper, waitForDisplay } from "../tools/human-pointer.js";
import { assert, cli, Runtime, serve, temporary, wait } from "./harness.js";

export async function run(engine: string, host: string, args: Record<string, any>) {
  assert(host && args.chrome, "--host-binary and --chrome are required");
  let value = "";
  let trusted = false;
  let submitted = false;
  const server = serve(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/input") {
      const event = await request.json();
      ({ value, trusted } = event);
      return new Response("ok");
    }
    if (url.pathname === "/search") {
      submitted = url.searchParams.get("q") === "Remote browser café 😀";
      return new Response("<h1>Search received</h1>", { headers: { "Content-Type": "text/html" } });
    }
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:white}textarea{position:absolute;left:24px;top:84px;width:330px;height:48px;box-sizing:border-box;font:18px sans-serif}</style><form action="/search"><textarea name="q" aria-label="Search" enterkeyhint="search" oninput="fetch(\'/input\',{method:\'POST\',body:JSON.stringify({value:this.value,trusted:event.isTrusted})})" onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.form.requestSubmit()}"></textarea></form>',
      { headers: { "Content-Type": "text/html" } },
    );
  });
  try {
    await temporary(async (root) => {
      const wrapper = filePath.join(root, "graphics-engine");
      await writeFile(
        wrapper,
        `#!/bin/sh\nexec '${filePath.resolve(engine).replaceAll("'", "'\\''")}' --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader "$@"\n`,
        { mode: 0o700 },
      );
      const runtime = await Runtime.launch(host, wrapper, root);
      const browser = await Browser.launch(args.chrome);
      try {
        const tab = (await runtime.dashboard.action("tabs"))[0].id;
        await runtime.dashboard.action("navigate", tab, { url: server.origin });
        await browser.open(runtime.url);
        await browser.call("Emulation.setDeviceMetricsOverride", {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true,
        });
        await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true });
        const display = await waitForDisplay(browser);
        await wait(
          () => browser.evaluate(`!!document.querySelector('[data-page-editor]')`),
          Boolean,
          5000,
        );
        const point = mapper(display)(170, 105);
        await browser.call("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: point[0], y: point[1] }],
        });
        await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await wait(
          () => browser.evaluate(`document.activeElement?.matches('[data-page-editor]')`),
          Boolean,
          5000,
        );
        assert.equal(
          await browser.evaluate(`!!document.querySelector('form[aria-label="Type in the page"]')`),
          false,
          "The fixed typing bar is replaced by the field editor",
        );
        await browser.call("Input.imeSetComposition", {
          text: "Remote",
          selectionStart: 6,
          selectionEnd: 6,
        });
        assert.equal(value, "", "An unfinished device composition stays in the local editor");
        await browser.call("Input.insertText", { text: "Remote browser café 😀" });
        await wait(
          () => value,
          (text) => text === "Remote browser café 😀",
        );
        assert(
          trusted,
          "The site receives trusted browser input rather than a scripted value setter",
        );
        const output = process.env.REMOTE_BROWSER_EDITOR_SCREENSHOTS;
        if (output) {
          await Bun.write(
            `${output}/mobile.png`,
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
        });
        await browser.call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await wait(() => submitted);
        await browser.call("Emulation.clearDeviceMetricsOverride");
        await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
        await waitForDisplay(browser);
        assert.equal(
          await browser.evaluate(`!!document.querySelector('[data-page-editor]')`),
          false,
          "Desktop keeps native page interaction",
        );
        if (output) {
          await Bun.write(
            `${output}/desktop.png`,
            Buffer.from(
              (await browser.call("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
        }
      } finally {
        await browser.close();
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
  }
  console.log(
    "PASS: one-tap field editor, trusted Unicode input and search submission without a bottom bar",
  );
}
if (import.meta.main) {
  await cli(run);
}
