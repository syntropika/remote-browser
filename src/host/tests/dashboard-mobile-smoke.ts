/** Mobile browser navigation uses a separate tab overview and contains long addresses. */
import { writeFile } from "node:fs/promises";
import filePath from "node:path";

import { Browser, waitForDisplay } from "../tools/human-pointer.js";
import { assert, cli, Runtime, serve, sleep, temporary, wait } from "./harness.js";

async function click(browser: Browser, label: string) {
  const box = await browser.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(button => (button.getAttribute('aria-label') || button.textContent.trim()) === ${JSON.stringify(label)} && button.getBoundingClientRect().width > 0);
    if (!button) return null;
    const r = button.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2];
  })()`);
  assert(box, `Visible button is missing: ${label}`);
  await browser.mouse("mousePressed", box[0], box[1], 1);
  await browser.mouse("mouseReleased", box[0], box[1]);
}

async function item(browser: Browser, label: string) {
  const point = await wait(() =>
    browser.evaluate(
      `(() => {const node=Array.from(document.querySelectorAll('[role=menuitem]')).find(node=>node.textContent.trim()===${JSON.stringify(label)});if(!node)return null;const r=node.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];})()`,
    ),
  );
  await browser.mouse("mousePressed", point[0], point[1], 1);
  await browser.mouse("mouseReleased", point[0], point[1]);
}

async function containedMenu(browser: Browser, label: string) {
  await wait(() =>
    browser.evaluate(
      `!!document.querySelector('[role=menu][aria-label=${JSON.stringify(label)}]')`,
    ),
  );
  await sleep(300);
  const state = await browser.evaluate(
    `(() => {const menus=Array.from(document.querySelectorAll('[role=menu]'));const r=menus[0].getBoundingClientRect();return {count:menus.length,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()`,
  );
  assert.equal(state.count, 1, "Submenus replace the current panel instead of opening a cascade");
  assert(
    state.left >= 0 && state.right <= state.width && state.top >= 0 && state.bottom <= state.height,
    `The menu remains inside the viewport: ${JSON.stringify(state)}`,
  );
}

export async function run(engine: string, host: string, args: Record<string, any>) {
  assert(host && args.chrome, "--host-binary and --chrome are required");
  const server = serve(
    () =>
      new Response(
        "<!doctype html><title>A page with a long address</title><h1>Mobile browser</h1>",
        { headers: { "Content-Type": "text/html" } },
      ),
  );
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
        await runtime.dashboard.action("navigate", tab, {
          url: `${server.origin}/${"long-address/".repeat(15)}`,
        });
        await browser.open(runtime.url);
        await waitForDisplay(browser);
        const output = process.env.REMOTE_BROWSER_MOBILE_SCREENSHOTS;
        for (const width of [320, 390]) {
          await browser.call("Emulation.setDeviceMetricsOverride", {
            width,
            height: 844,
            deviceScaleFactor: 1,
            mobile: true,
          });
          await sleep(250);
          const layout = await browser.evaluate(`(() => {
            const r = element => {const b=element.getBoundingClientRect();return {label:element.getAttribute('aria-label'),left:b.left,right:b.right,width:b.width,height:b.height};};
            return {viewport:innerWidth, document:document.documentElement.scrollWidth, toolbar:r(document.querySelector('[aria-label="Browser toolbar"]')), address:r(document.querySelector('[aria-label="Page address"]')), tabs:r(document.querySelector('[role=tablist]')), controls:Array.from(document.querySelectorAll('[aria-label="Browser toolbar"] button')).map(r).filter(b=>b.width>0)};
          })()`);
          assert.equal(
            layout.tabs.width,
            0,
            "The desktop strip must be absent during mobile navigation",
          );
          assert(
            layout.address.width >= 120,
            `The address needs usable space on a narrow screen: ${JSON.stringify(layout)}`,
          );
          assert(layout.toolbar.height <= 48, "Mobile navigation stays in one compact row");
          assert(
            layout.controls.every((box: any) => box.width >= 44 && box.height >= 44),
            `Mobile toolbar controls have touch targets of at least 44 pixels: ${JSON.stringify(layout.controls)}`,
          );
          assert(layout.document <= layout.viewport, "The toolbar must not overflow the viewport");
          assert(
            layout.controls.every((box: any) => box.left >= 0 && box.right <= layout.viewport),
            "Every visible toolbar control must fit inside the screen",
          );
          if (output) {
            await Bun.write(
              `${output}/browser-${width}.png`,
              Buffer.from(
                (await browser.call("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
          }
        }
        await click(browser, "More options");
        const menu = await wait(() =>
          browser.evaluate(
            "document.querySelector('[role=menu][aria-label=\"Browser menu\"]')?.textContent",
          ),
        );
        for (const label of [
          "Back",
          "Forward",
          "Reload page",
          "Sessions",
          "Ask for control",
          "Extensions",
        ]) {
          assert(menu.includes(label), `Mobile menu must retain ${label}`);
        }
        await containedMenu(browser, "Browser menu");
        await item(browser, "Sessions");
        await containedMenu(browser, "Choose a session");
        await item(browser, "Sessions");
        await containedMenu(browser, "Browser menu");
        await item(browser, "Capture");
        await containedMenu(browser, "Capture");
        if (output) {
          await Bun.write(
            `${output}/menu-mobile.png`,
            Buffer.from(
              (await browser.call("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
        }
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
        await wait(() => browser.evaluate("!document.querySelector('[role=menu]')"));
        await click(browser, "Show 1 open tabs");
        const overview = await wait(() =>
          browser.evaluate(
            "(() => {const d=document.querySelector('[role=dialog]');if(!d)return null;const r=d.getBoundingClientRect();return {title:d.textContent,left:r.left,top:r.top,width:r.width,height:r.height};})()",
          ),
        );
        await sleep(300);
        const full = await browser.evaluate(
          "(() => {const r=document.querySelector('[role=dialog]').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()",
        );
        assert(overview.title.includes("Open tabs"));
        assert(
          full.left <= 1 && full.top <= 1 && full.width >= 389 && full.height >= 843,
          `The tab overview occupies the whole mobile screen: ${JSON.stringify(full)}`,
        );
        if (output) {
          await Bun.write(
            `${output}/tabs-mobile.png`,
            Buffer.from(
              (await browser.call("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
        }
        await click(browser, "New tab");
        await wait(() =>
          browser.evaluate(
            "!document.querySelector('[role=dialog]') && !!document.querySelector('button[aria-label=\"Show 2 open tabs\"]')",
          ),
        );
        await click(browser, "Show 2 open tabs");
        await sleep(300);
        if (output) {
          await Bun.write(
            `${output}/tabs-mobile.png`,
            Buffer.from(
              (await browser.call("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
        }
        const first = await wait(() =>
          browser.evaluate(
            "(() => {const b=Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.includes('A page with a long address'));if(!b)return null;const r=b.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];})()",
          ),
        );
        await browser.mouse("mousePressed", first[0], first[1], 1);
        await browser.mouse("mouseReleased", first[0], first[1]);
        await wait(() =>
          browser.evaluate(
            "!document.querySelector('[role=dialog]') && document.querySelector('[aria-label=\"Page address\"]').value.includes('long-address')",
          ),
        );
        await click(browser, "Show 2 open tabs");
        await click(browser, "Close New tab");
        await wait(() =>
          browser.evaluate(
            "document.querySelectorAll('[role=dialog] button[aria-current=page]').length===1 && !document.querySelector('[role=dialog] button[aria-label=\"Close New tab\"]')",
          ),
        );
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
        await wait(() => browser.evaluate("!document.querySelector('[role=dialog]')"));
        await click(browser, "More options");
        await item(browser, "Settings");
        await wait(() =>
          browser.evaluate("!!document.querySelector('section[aria-label=Settings]')"),
        );
        await click(browser, "Extensions");
        await wait(() =>
          browser.evaluate(
            "document.querySelector('section[aria-label=Settings] h2')?.textContent === 'Extensions' && document.querySelector('section[aria-label=Settings]')?.textContent.includes('No Chrome extensions installed')",
          ),
        );
        const navigation = await browser.evaluate(
          "(() => {const b=document.querySelector('nav[aria-label=\"Settings sections\"] button[aria-label=Extensions]');const r=b.getBoundingClientRect();return {text:b.textContent,left:r.left,right:r.right,width:innerWidth};})()",
        );
        assert.equal(navigation.text, "Extensions");
        assert(
          navigation.left >= 0 && navigation.right <= navigation.width,
          "Extensions is visible and labeled in mobile settings",
        );
        if (output) {
          await Bun.write(
            `${output}/settings-mobile.png`,
            Buffer.from(
              (await browser.call("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
        }
        await click(browser, "Back to browser");
        await wait(() =>
          browser.evaluate("!document.querySelector('section[aria-label=Settings]')"),
        );
        await browser.call("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await waitForDisplay(browser);
        const address = await browser.evaluate(
          "(() => {const r=document.querySelector('form[aria-label=\"Open a website\"]').getBoundingClientRect();return {center:r.left+r.width/2,viewport:innerWidth/2};})()",
        );
        assert(
          Math.abs(address.center - address.viewport) < 1,
          "The desktop URL field is centered between equal side columns",
        );
        if (output) {
          await Bun.write(
            `${output}/browser-desktop.png`,
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
    "PASS: narrow toolbars contain long URLs; mobile tab overview opens, creates, selects and closes tabs",
  );
}
if (import.meta.main) {
  await cli(run);
}
