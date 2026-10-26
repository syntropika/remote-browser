/** Opt-in real Store acceptance in disposable profiles; no missing-bridge skips. */
import filePath from "node:path";
import { isDeepStrictEqual } from "node:util";

import { cli, assert, Engine, serve, temporary, wait } from "./harness.js";
import type { Wire } from "./harness.js";

const { join } = filePath;

export const EXTENSION = "bcjindcccaagfpapjjmafapmmgkkhgoa";

export const PAYLOAD = { source: "extension-install-test", nested: { value: 42 } };

const storeUrl = `https://chromewebstore.google.com/detail/json-formatter/${EXTENSION}?hl=en`;

async function snapshot(engine: Engine, tab: string): Promise<Wire> {
  try {
    return await engine.call("snapshot", tab);
  } catch (cause) {
    if (String(cause).includes("Cannot find context") || String(cause).includes("Uncaught")) {
      return {};
    }
    throw cause;
  }
}

export async function pending(engine: Engine, tab: string) {
  await engine.call("navigate", tab, { url: storeUrl }, { human: true });
  let value = await wait(
    () => snapshot(engine, tab),
    (v) => Boolean(v.elements?.length),
  );
  if (value.title === "Before you continue") {
    const reject = value.elements.find((e: Wire) => e.name === "Reject all");
    assert(reject);
    await engine.call("click", tab, { reference: reject.reference }, { human: true });
  }
  value = await wait(
    () => snapshot(engine, tab),
    (v) => v.elements?.some((e: Wire) => e.name === "Add to Chrome" && !e.disabled),
  );
  const button = value.elements.find((e: Wire) => e.name === "Add to Chrome");
  await engine.call("click", tab, { reference: button.reference }, { human: true });
  const requests = await wait(
    async () => (await engine.call("extension_installs")).requests,
    (r: Wire) => r.some((item: Wire) => item.tabId === tab),
  );
  const request = requests.find((item: Wire) => item.tabId === tab);
  assert.equal(request.extensionId, EXTENSION);
  assert.equal(request.origin, "https://chromewebstore.google.com");
  assert(request.name && request.version);
  return request;
}

export async function status(engine: Engine, tab: string) {
  const reply = await engine.call("cdp", tab, {
    method: "Runtime.evaluate",
    params: {
      expression: `new Promise(resolve=>chrome.webstorePrivate.getExtensionStatus('${EXTENSION}',resolve))`,
      awaitPromise: true,
      returnByValue: true,
    },
  });
  return reply.result.value;
}

export async function options(engine: Engine, tab: string) {
  await engine.call("cdp", tab, {
    method: "Page.navigate",
    params: { url: `chrome-extension://${EXTENSION}/options/options.html` },
  });
  return wait(
    () =>
      engine.call("evaluate", tab, {
        script:
          "return {id:chrome.runtime?.id,checked:document.querySelector('input[name=theme]:checked')?.value};",
      }),
    (v) => v.id === EXTENSION && Boolean(v.checked),
  );
}

export async function storedTheme(engine: Engine, tab: string) {
  const reply = await engine.call("cdp", tab, {
    method: "Runtime.evaluate",
    params: {
      expression: "chrome.storage.local.get('themeOverride')",
      awaitPromise: true,
      returnByValue: true,
    },
  });
  return reply.result.value?.themeOverride;
}

export async function setTheme(engine: Engine, tab: string, value: string) {
  const point = await engine.call("evaluate", tab, {
    script: `const r=document.querySelector('input[value='+${JSON.stringify(value)}+']').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};`,
  });
  await engine.call("input", tab, { kind: "click", ...point }, { human: true });
  await wait(
    () => storedTheme(engine, tab),
    (actual) => actual === value,
  );
}

export async function run(binary: string, _host: string, args: Record<string, Wire> = {}) {
  const server = serve(() => Response.json(PAYLOAD));
  try {
    await temporary(async (root) => {
      const engines: Engine[] = [];
      const start = async (name = "profile") => {
        const engine = new Engine(binary, join(root, name));
        engines.push(engine);
        const { available } = await engine.call("extension_installs");
        assert.equal(typeof available, "boolean");
        assert(
          available || args["protocol-only"],
          "This CEF build lacks the native installation bridge",
        );
        return engine;
      };
      const empty = (e: Engine) =>
        wait(
          () => e.call("extension_installs"),
          (value) => value.requests.length === 0,
        );
      try {
        let engine = await start();
        let tab = (await engine.call("tabs"))[0].id;
        if (args["protocol-only"]) {
          assert.deepEqual((await engine.call("extension_installs")).requests, []);
          const decision = { id: "nonexistent-request", allow: true };
          assert(
            (
              await engine.call("extension_install_decide", tab, decision, { error: true })
            ).includes("require the dashboard"),
          );
          assert(
            (
              await engine.call(
                "extension_install_decide",
                tab,
                { id: decision.id },
                { human: true, error: true },
              )
            ).includes("explicit installation decision"),
          );
          await engine.call("extension_install_decide", tab, decision, {
            human: true,
            error: true,
          });
          assert.equal(await engine.call("evaluate", tab, { script: "return 42;" }), 42);
          return;
        }
        const wrong = await engine.call("open");
        let request = await pending(engine, tab);
        let decision = { id: request.id, allow: true };
        await engine.call("extension_install_decide", wrong, decision, {
          human: true,
          error: true,
        });
        await engine.call("extension_install_decide", tab, decision, { error: true });
        await engine.call(
          "extension_install_decide",
          tab,
          { id: request.id, allow: "true" },
          { human: true, error: true },
        );
        assert.equal((await engine.call("extension_installs")).requests[0].id, request.id);
        const other = await start("other-profile");
        assert.deepEqual((await other.call("extension_installs")).requests, []);
        await other.call("extension_install_decide", (await other.call("tabs"))[0].id, decision, {
          human: true,
          error: true,
        });
        await other.stop();
        await engine.call(
          "extension_install_decide",
          tab,
          { id: request.id, allow: false },
          { human: true },
        );
        await empty(engine);
        assert.equal(await wait(() => status(engine, tab)), "installable");
        await engine.call("extension_install_decide", tab, decision, { human: true, error: true });
        await pending(engine, tab);
        await engine.call("navigate", tab, { url: "about:blank" }, { human: true });
        await empty(engine);
        const closing = await engine.call("open");
        await pending(engine, closing);
        await engine.call("close", closing, {}, { human: true });
        await empty(engine);
        if (args["verify-expiry"]) {
          request = await pending(engine, tab);
          console.log("Checking native three-minute expiry");
          await wait(
            async () => (await engine.call("extension_installs")).requests,
            (v) => !v.length,
            195_000,
          );
          await engine.call(
            "extension_install_decide",
            tab,
            { id: request.id, allow: true },
            { human: true, error: true },
          );
        }
        request = await pending(engine, tab);
        decision = { id: request.id, allow: true };
        await engine.call("extension_install_decide", tab, decision, { human: true });
        await engine.call("extension_install_decide", tab, decision, { human: true, error: true });
        await empty(engine);
        await wait(
          () => status(engine, tab),
          (v) => v === "enabled",
          60_000,
        );
        await options(engine, tab);
        await setTheme(engine, tab, "force_light");
        await engine.stop();
        for (const [expected, color] of [
          ["force_light", "rgb(255, 255, 255)"],
          ["force_dark", "rgb(26, 26, 26)"],
        ]) {
          engine = await start();
          tab = (await engine.call("tabs"))[0].id;
          assert.equal((await options(engine, tab)).checked, expected);
          assert.equal(await storedTheme(engine, tab), expected);
          await engine.call(
            "navigate",
            tab,
            { url: `${server.origin}/state.json` },
            { human: true },
          );
          const currentEngine = engine;
          const currentTab = tab;
          await wait(
            () =>
              currentEngine.call("evaluate", currentTab, {
                script:
                  "return {parsed:!!document.getElementById('jsonFormatterParsed'),json:window.json,background:getComputedStyle(document.body).backgroundColor};",
              }),
            (v) => v.parsed && isDeepStrictEqual(v.json, PAYLOAD) && v.background === color,
          );
          if (expected === "force_light") {
            await options(engine, tab);
            await setTheme(engine, tab, "force_dark");
          }
          await engine.stop();
        }
      } finally {
        for (const engine of engines) {
          if (engine.process.exitCode === null && engine.process.signalCode === null) {
            await engine.stop();
          }
        }
      }
    });
  } finally {
    await server.stop();
  }
  console.log(
    args["protocol-only"]
      ? "PASS: installation protocol guards only; no Store installation tested"
      : "PASS: signed Store install/refusal, permission guards and actual extension state after two restarts",
  );
}

if (import.meta.main) {
  await cli(run);
}
