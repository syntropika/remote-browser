/** Two devices viewing one tab share its frames and explicitly transfer rendering control. */
import { writeFile } from "node:fs/promises";
import filePath from "node:path";

import { Browser, waitForDisplay } from "../tools/human-pointer.js";
import { assert, cli, Runtime, serve, sleep, temporary, wait } from "./harness.js";

async function press(browser: Browser, expression: string) {
  let previous: number[] | null = null;
  const point = await wait(async () => {
    const current = await browser.evaluate(
      `(() => {const node=${expression};if(!node)return null;const r=node.getBoundingClientRect();return r.width>0?[r.x+r.width/2,r.y+r.height/2]:null})()`,
    );
    const before = previous;
    const stable =
      current &&
      before &&
      current.every((value: number, index: number) => Math.abs(value - before[index]) < 0.5);
    previous = current;
    return stable ? current : null;
  });
  await browser.mouse("mousePressed", point[0], point[1], 1);
  await browser.mouse("mouseReleased", point[0], point[1]);
}

export async function run(engine: string, host: string, args: Record<string, any>) {
  assert(host && args.chrome, "--host-binary and --chrome are required");
  const server = serve(
    () =>
      new Response(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#204080;color:white;font:24px system-ui}</style><h1>Shared display</h1><button>Example action</button>',
        { headers: { "Content-Type": "text/html" } },
      ),
  );
  try {
    await temporary(async (root) => {
      const wrapper = filePath.join(root, "graphics-engine");
      await writeFile(
        wrapper,
        `#!/bin/sh\nexec '${filePath.resolve(engine).replaceAll("'", "'\\''")}' --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader "$@"\n`,
        { mode: 0o700 },
      );
      const runtime = await Runtime.launch(host, wrapper, root);
      const desktop = await Browser.launch(args.chrome);
      const phone = await Browser.launch(args.chrome);
      try {
        const tab = (await runtime.dashboard.action("tabs"))[0].id;
        await runtime.dashboard.action("navigate", tab, { url: server.origin });
        await desktop.open(runtime.url);
        const initial = await waitForDisplay(desktop);
        await wait(() =>
          desktop.evaluate(`!document.querySelector('[aria-label="Page address"]').disabled`),
        );
        await phone.open(runtime.url);
        await phone.call("Emulation.setDeviceMetricsOverride", {
          width: 390,
          height: 844,
          screenWidth: 390,
          screenHeight: 844,
          deviceScaleFactor: 3,
          mobile: true,
        });
        await phone.call("Emulation.setTouchEmulationEnabled", { enabled: true });
        await wait(() =>
          phone.evaluate(
            `document.querySelector('[aria-label="Browser display"]')?.getAttribute('aria-busy') === 'false'`,
          ),
        );
        await sleep(300);
        const frame = await runtime.dashboard.action("screenshot", tab, { since: 0 });
        assert.equal(
          frame.viewWidth,
          initial.width,
          "Opening the phone must not resize the desktop's tab",
        );
        const follower = await phone.evaluate(
          `(() => {const r=document.querySelector('canvas').getBoundingClientRect();return {width:r.width,height:r.height,disabled:document.querySelector('[aria-label="Page address"]').disabled,available:innerWidth}})()`,
        );
        assert(follower.disabled);
        assert(follower.width <= follower.available);
        assert(
          Math.abs(follower.width / follower.height - frame.viewWidth / frame.viewHeight) < 0.01,
          "Spectator scaling preserves the whole image's aspect ratio",
        );
        await press(phone, `document.querySelector('[aria-label="More options"]')`);
        await wait(() =>
          phone.evaluate(
            '!!document.querySelector("[role=menuitem][id$=take-control]") || Array.from(document.querySelectorAll("[role=menuitem]")).some(n=>n.textContent.includes("Ask for control"))',
          ),
        );
        await press(
          phone,
          'Array.from(document.querySelectorAll("[role=menuitem]")).find(n=>n.textContent.includes("Ask for control"))',
        );
        const mobile = await waitForDisplay(phone);
        assert.equal(mobile.width, 390);
        await wait(() =>
          desktop.evaluate(`document.querySelector('[aria-label="Page address"]').disabled`),
        );
        const mobileFrame = await runtime.dashboard.action("screenshot", tab, { since: 0 });
        assert.equal(mobileFrame.viewWidth, 390);
        assert.equal(
          mobileFrame.surfaceWidth,
          780,
          "Live density is capped at two instead of rendering nine times as many pixels",
        );
        await phone.evaluate(
          'window.frameRequests=0;const original=window.fetch;window.fetch=(...args)=>{if(args[1]?.body&&JSON.parse(args[1].body).op==="screenshot")window.frameRequests++;return original(...args)};Object.defineProperty(document,"hidden",{configurable:true,get:()=>true});document.dispatchEvent(new Event("visibilitychange"));',
        );
        await sleep(400);
        const requests = await phone.evaluate("window.frameRequests");
        await sleep(700);
        assert.equal(
          await phone.evaluate("window.frameRequests"),
          requests,
          "Hidden viewers stop requesting frames",
        );
        await phone.evaluate(
          'Object.defineProperty(document,"hidden",{configurable:true,get:()=>false});document.dispatchEvent(new Event("visibilitychange"));',
        );
        await wait(() => phone.evaluate("window.frameRequests > 0"));
        if (process.env.REMOTE_BROWSER_VIEWER_SCREENSHOTS) {
          for (const [name, browser] of [
            ["desktop", desktop],
            ["mobile", phone],
          ] as const) {
            await Bun.write(
              `${process.env.REMOTE_BROWSER_VIEWER_SCREENSHOTS}/${name}.png`,
              Buffer.from(
                (await browser.call("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
          }
        }
      } finally {
        await phone.close();
        await desktop.close();
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
  }
  console.log(
    "PASS: real desktop/phone viewers, takeover, image scaling and hidden stream suspension",
  );
}
if (import.meta.main) {
  await cli(run);
}
