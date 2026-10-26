import filePath from "node:path";

import {
  EXTENSION,
  PAYLOAD,
  pending,
  status,
  setTheme,
  storedTheme,
} from "./extension-install-smoke.js";
import { cli, assert, Engine, serve, temporary, wait } from "./harness.js";

const { join } = filePath;

async function inventory(engine: Engine) {
  const value = await engine.call("extensions");
  assert.equal(value.available, true, "This CEF build lacks the native management bridge");
  return value.extensions;
}

const entry = async (engine: Engine) =>
  (await inventory(engine)).find((e: any) => e.id === EXTENSION);

export async function run(binary: string) {
  const server = serve(() => Response.json(PAYLOAD));
  try {
    await temporary(async (root) => {
      const engines: Engine[] = [];
      const start = async (name = "profile") => {
        const e = new Engine(binary, join(root, name));
        engines.push(e);
        await inventory(e);
        return e;
      };
      const formatted = async (e: Engine, expected: boolean) => {
        const tab = await e.call("open");
        await e.call("navigate", tab, { url: `${server.origin}/state.json` }, { human: true });
        await wait(
          () =>
            e.call("evaluate", tab, {
              script: "return !!document.getElementById('jsonFormatterParsed');",
            }),
          (v) => v === expected,
        );
        await e.call("close", tab, {}, { human: true });
      };
      try {
        let engine = await start();
        assert.deepEqual(await inventory(engine), []);
        const tab = (await engine.call("tabs"))[0].id;
        const request = await pending(engine, tab);
        await engine.call(
          "extension_install_decide",
          tab,
          { id: request.id, allow: true },
          { human: true },
        );
        await wait(
          () => status(engine, tab),
          (v) => v === "enabled",
          60_000,
        );
        const value = await wait(() => entry(engine));
        assert(
          value.name === "JSON Formatter" &&
            value.version &&
            value.enabled &&
            value.mayDisable &&
            value.mayRemove &&
            value.hasOptions,
        );
        for (const [op, args] of [
          ["extension_set_enabled", { id: EXTENSION, enabled: false }],
          ["extension_remove", { id: EXTENSION, confirmed: true }],
          ["extension_options", { id: EXTENSION }],
        ] as const) {
          assert((await engine.call(op, null, args, { error: true })).includes("require"));
        }
        for (const [op, args] of [
          ["extension_set_enabled", { id: EXTENSION, enabled: "false" }],
          ["extension_remove", { id: EXTENSION }],
          ["extension_remove", { id: EXTENSION, confirmed: "true" }],
          ["extension_remove", { id: "a".repeat(32), confirmed: true }],
        ] as const) {
          await engine.call(op, null, args, { human: true, error: true });
        }
        const other = await start("other-profile");
        assert.deepEqual(await inventory(other), []);
        await other.call(
          "extension_set_enabled",
          null,
          { id: EXTENSION, enabled: false },
          { human: true, error: true },
        );
        await other.call(
          "extension_remove",
          null,
          { id: EXTENSION, confirmed: true },
          { human: true, error: true },
        );
        await other.stop();
        assert((await entry(engine)).enabled);
        let optionsTab = await engine.call(
          "extension_options",
          null,
          { id: EXTENSION },
          { human: true },
        );
        assert.equal(
          await engine.call("evaluate", optionsTab, { script: "return chrome.runtime.id;" }),
          EXTENSION,
        );
        await setTheme(engine, optionsTab, "force_dark");
        await engine.call("close", optionsTab, {}, { human: true });
        await formatted(engine, true);
        await engine.call(
          "extension_set_enabled",
          null,
          { id: EXTENSION, enabled: false },
          { human: true },
        );
        assert(!(await entry(engine)).enabled && (await entry(engine)).mayEnable);
        await engine.call(
          "extension_options",
          null,
          { id: EXTENSION },
          { human: true, error: true },
        );
        await formatted(engine, false);
        await engine.stop();
        engine = await start();
        await wait(
          () => entry(engine),
          (v) => v?.enabled === false,
        );
        await engine.call(
          "extension_set_enabled",
          null,
          { id: EXTENSION, enabled: true },
          { human: true },
        );
        assert((await entry(engine)).enabled);
        optionsTab = await engine.call(
          "extension_options",
          null,
          { id: EXTENSION },
          { human: true },
        );
        assert.equal(await storedTheme(engine, optionsTab), "force_dark");
        await engine.call("close", optionsTab, {}, { human: true });
        await formatted(engine, true);
        await engine.call(
          "extension_remove",
          null,
          { id: EXTENSION, confirmed: true },
          { human: true },
        );
        assert.equal(await entry(engine), undefined);
        await formatted(engine, false);
        await engine.stop();
        engine = await start();
        assert.deepEqual(await inventory(engine), []);
      } finally {
        for (const e of engines) {
          if (e.process.exitCode === null && e.process.signalCode === null) {
            await e.stop();
          }
        }
      }
    });
  } finally {
    await server.stop();
  }
  console.log(
    "PASS: Store inventory, policy/permission guards, options, isolation, persisted disabling and removal",
  );
}

if (import.meta.main) {
  await cli(run);
}
