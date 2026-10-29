/** Device paste shortcuts preserve focus, input order and the original tab. */
import { Browser, mapper, waitForDisplay } from "../tools/human-pointer.js";
import { assert, cli, Runtime, serve, temporary, wait } from "./harness.js";

async function key(browser: Browser, name: string, code: string, number: number, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"]) {
    await browser.call("Input.dispatchKeyEvent", {
      type,
      key: name,
      code,
      windowsVirtualKeyCode: number,
      modifiers,
    });
  }
}

async function click(browser: Browser, target: string) {
  const [x, y] = await browser.evaluate(`(() => {
    const r=(${target}).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];
  })()`);
  await browser.mouse("mouseMoved", x, y);
  await browser.mouse("mousePressed", x, y, 1);
  await browser.mouse("mouseReleased", x, y);
}

export async function run(engine: string, host: string, args: Record<string, any>) {
  assert(host && args.chrome, "--host-binary and --chrome are required");
  const values: Record<string, string> = {};
  const server = serve(async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/input/")) {
      values[path.slice(7)] = await request.text();
      return new Response("ok");
    }
    return new Response(
      `<!doctype html><meta charset="utf-8"><style>body{margin:0}input,textarea,[contenteditable]{position:absolute;left:40px;width:400px;height:60px}input{top:40px}textarea{top:160px}[contenteditable]{top:280px;border:1px solid}</style>
      <input aria-label="Sample input" oninput="fetch('/input/single',{method:'POST',body:this.value})">
      <textarea aria-label="Multiline input" oninput="fetch('/input/multi',{method:'POST',body:this.value})"></textarea>
      <div contenteditable="true" aria-label="Rich editor" oninput="fetch('/input/rich',{method:'POST',body:this.textContent})"></div>`,
      { headers: { "Content-Type": "text/html" } },
    );
  });
  try {
    await temporary(async (root) => {
      const runtime = await Runtime.launch(host, engine, root);
      const browser = await Browser.launch(args.chrome);
      try {
        const tab = (await runtime.dashboard.action("tabs"))[0].id;
        await runtime.dashboard.action("navigate", tab, { url: server.origin });
        await browser.open(runtime.url);
        await browser.call("Page.bringToFront");
        await browser.call("Browser.grantPermissions", {
          origin: runtime.url,
          permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
        });
        const point = mapper(await waitForDisplay(browser));
        await browser.evaluate(`(() => {
          window.setClipboard = navigator.clipboard.writeText.bind(navigator.clipboard);
          window.pasteEvents = 0;
          document.addEventListener('paste', () => window.pasteEvents++);
          window.clipboardCalls = [];
          const original = window.fetch;
          window.fetch = async (...args) => {
            if (args[0] === '/api/action' && args[1]?.body) {
              const request = JSON.parse(args[1].body);
              if (request.op.startsWith('clipboard_')) {
                window.clipboardCalls.push(request.op);
                if (request.op === 'clipboard_write') {
                  if (window.rejectClipboard) return new Response(JSON.stringify({error:'Synthetic clipboard rejection'}), {status:409});
                  if (window.holdClipboard) await new Promise(resolve => {window.releaseClipboard = resolve});
                }
              }
            }
            return original(...args);
          };
        })()`);
        const focus = async (y: number) => {
          await browser.mouse("mousePressed", ...point(150, y), 1);
          await browser.mouse("mouseReleased", ...point(150, y));
        };
        const clipboard = (text: string) =>
          browser.evaluate(`window.setClipboard(${JSON.stringify(text)})`);
        await focus(70);
        await clipboard("Pasted sample text");
        await key(browser, "v", "KeyV", 86, 2);
        await wait(
          () => values.single,
          (text) => text === "Pasted sample text",
        );
        assert.equal(await browser.evaluate("window.pasteEvents"), 1);

        // HTTP dashboards cannot use navigator.clipboard: the native event still works.
        await browser.evaluate("Object.defineProperty(navigator, 'clipboard', {value:undefined})");
        await clipboard("Line one\nCafé 😀");
        await focus(190);
        await key(browser, "v", "KeyV", 86, 2);
        await key(browser, "!", "Digit1", 49, 8);
        await wait(
          () => values.multi,
          (text) => text === "Line one\nCafé 😀!",
        );

        await clipboard("Rich paste");
        await focus(310);
        await key(browser, "Insert", "Insert", 45, 8);
        await wait(
          () => values.rich,
          (text) => text === "Rich paste",
        );
        assert.equal(await browser.evaluate("window.pasteEvents"), 3);
        assert.deepEqual(await browser.evaluate("window.clipboardCalls"), [
          "clipboard_write",
          "clipboard_paste",
          "clipboard_write",
          "clipboard_paste",
          "clipboard_write",
          "clipboard_paste",
        ]);

        await browser.evaluate("window.rejectClipboard=true;window.clipboardCalls=[]");
        await clipboard("Rejected text");
        await key(browser, "v", "KeyV", 86, 2);
        await wait(() =>
          browser.evaluate("document.body.textContent.includes('Synthetic clipboard rejection')"),
        );
        assert.equal(values.rich, "Rich paste");
        assert.deepEqual(await browser.evaluate("window.clipboardCalls"), ["clipboard_write"]);

        await browser.evaluate(
          "window.rejectClipboard=false;window.holdClipboard=true;window.clipboardCalls=[]",
        );
        await clipboard("Cancelled paste");
        await key(browser, "v", "KeyV", 86, 2);
        await wait(() => browser.evaluate("!!window.releaseClipboard"));
        await click(browser, "document.querySelector('button[aria-label=\"New tab\"]')");
        await wait(() =>
          browser.evaluate(
            "document.querySelector('[role=tab][aria-selected=true]')?.textContent==='New tab'",
          ),
        );
        await waitForDisplay(browser);
        // Returning to the same tab must not revive work queued before switching away.
        await click(
          browser,
          `Array.from(document.querySelectorAll('[role=tab]')).find(node=>node.title.includes(${JSON.stringify(server.origin)}))`,
        );
        await wait(() =>
          browser.evaluate(
            `document.querySelector('[role=tab][aria-selected=true]')?.title.includes(${JSON.stringify(server.origin)})`,
          ),
        );
        await waitForDisplay(browser);
        await browser.evaluate("window.releaseClipboard()");
        await focus(310);
        await key(browser, "End", "End", 35);
        await key(browser, "?", "Slash", 191, 8);
        await wait(
          () => values.rich,
          (text) => text === "Rich paste?",
        );
        assert.deepEqual(await browser.evaluate("window.clipboardCalls"), ["clipboard_write"]);
      } finally {
        await browser.close();
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
  }
  console.log(
    "PASS: native Ctrl+V/Shift+Insert, Unicode, ordered input, clipboard failure and tab-switch cancellation",
  );
}
if (import.meta.main) {
  await cli(run);
}
