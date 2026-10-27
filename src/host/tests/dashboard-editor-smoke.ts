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
  let richValue = "";
  let richHTML = "";
  let passwordValue = "";
  let richTrusted = false;
  let remoteSelection = "";
  const server = serve(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/selection") {
      remoteSelection = await request.text();
      return new Response("ok");
    }
    if (url.pathname === "/rich-input") {
      const event = await request.json();
      richValue = event.value;
      richHTML = event.html;
      richTrusted = event.trusted;
      return new Response("ok");
    }
    if (url.pathname === "/password-input") {
      passwordValue = (await request.json()).value;
      return new Response("ok");
    }
    if (url.pathname === "/rich") {
      return new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>[contenteditable],input{position:absolute;left:24px;top:84px;width:330px;height:48px;box-sizing:border-box}input{top:170px}</style><div contenteditable="true" aria-label="Rich editor" oninput="fetch('/rich-input',{method:'POST',body:JSON.stringify({value:this.textContent,html:this.innerHTML,trusted:event.isTrusted})})"><strong>Rich</strong> <em>text</em></div><script>document.addEventListener("selectionchange",()=>fetch("/selection",{method:"POST",body:getSelection().toString()}))</script><input type="password" autocomplete="section-remote current-password" aria-label="Password" oninput="fetch('/password-input',{method:'POST',body:JSON.stringify({value:this.value})})">`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
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
        const displayId = await browser.evaluate(
          'document.querySelector("[data-display-id]").dataset.displayId',
        );
        await runtime.dashboard.action("navigate", tab, {
          url: `${server.origin}/rich`,
          displayId,
        });
        await waitForDisplay(browser);
        const tap = async (label: string) => {
          const location = await wait(() =>
            browser.evaluate(
              `(()=>{const e=[...document.querySelectorAll('[data-page-editor]')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});const r=e?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`,
            ),
          );
          await browser.call("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [location],
          });
          await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await wait(() =>
            browser.evaluate(
              `document.activeElement?.getAttribute('aria-label')===${JSON.stringify(label)}`,
            ),
          );
        };
        await tap("Rich editor");
        await browser.evaluate("document.activeElement.setSelectionRange(9,9)");
        await browser.call("Input.insertText", { text: " café 😀" });
        await wait(
          () => richValue,
          (v) => v === "Rich text café 😀",
        );
        assert(
          richTrusted &&
            richHTML.includes("<strong>Rich</strong>") &&
            richHTML.includes("<em>text"),
          "Native rich editing preserves formatting",
        );
        if (output) {
          await Bun.write(
            `${output}/rich-mobile.png`,
            Buffer.from(
              (await browser.call("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
        }
        await wait(
          () => browser.evaluate("document.activeElement.value"),
          (v) => v === "Rich text café 😀",
        );
        assert.deepEqual(
          await browser.evaluate(
            "(()=>{const s=getComputedStyle(document.activeElement);return {background:s.backgroundColor,text:s.color,caret:s.caretColor};})()",
          ),
          { background: "rgba(0, 0, 0, 0)", text: "rgba(0, 0, 0, 0)", caret: "rgba(0, 0, 0, 0)" },
        );
        await browser.evaluate("document.activeElement.setSelectionRange(0,4)");
        await wait(
          () => remoteSelection,
          (v) => v === "Rich",
        );
        const caretPoint = await browser.evaluate(
          "(()=>{const r=document.activeElement.getBoundingClientRect();return {x:r.x+2,y:r.y+8};})()",
        );
        await browser.call("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [caretPoint],
        });
        await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await browser.call("Input.insertText", { text: "X" });
        await wait(
          () => richValue,
          (v) => v === "X text café 😀",
        );
        await tap("Password");
        assert.equal(
          await browser.evaluate("document.activeElement.autocomplete"),
          "off",
          "Saved credentials are enabled only by an explicit request",
        );
        const key = await browser.evaluate(
          `(()=>{const r=document.querySelector('[aria-label="Use saved passwords"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
        );
        await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [key] });
        await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await wait(() =>
          browser.evaluate('document.activeElement.autocomplete==="current-password"'),
        );
        await browser.call("Input.insertText", { text: "test-only secret" });
        await wait(
          () => passwordValue,
          (v) => v === "test-only secret",
        );
        if (output) {
          await Bun.write(
            `${output}/password-mobile.png`,
            Buffer.from(
              (await browser.call("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
        }
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
    "PASS: transparent touch editors, native selection/replacement, Unicode/IME, rich text and explicit password options",
  );
}
if (import.meta.main) {
  await cli(run);
}
