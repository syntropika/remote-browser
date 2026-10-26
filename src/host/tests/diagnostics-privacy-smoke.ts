import filePath from "node:path";

import { PAGE, FRAME, CANARY } from "./fixtures/diagnostics-privacy-smoke.js";
import { cli, assert, Engine, serve, temporary, wait, sleep } from "./harness.js";

const { join } = filePath;

export async function run(binary: string) {
  const server = serve(
    (request) =>
      new Response(new URL(request.url).pathname === "/frame" ? FRAME : PAGE, {
        headers: { "Content-Type": "text/html" },
      }),
  );
  const previous = { ...process.env };
  try {
    Object.assign(process.env, {
      REMOTE_BROWSER_NATIVE_DIAGNOSTICS: "1",
      REMOTE_BROWSER_NATIVE_DIAGNOSTICS_STALE_CHECK: "1",
      REMOTE_BROWSER_NATIVE_DIAGNOSTICS_HOSTS: "127.0.0.1=fixture",
    });
    await temporary(async (root) => {
      const engine = new Engine(binary, join(root, "profile"));
      try {
        const tab = (await engine.call("tabs"))[0].id;
        await engine.call("navigate", tab, { url: server.origin });
        await wait(() => engine.call("evaluate", tab, { script: "return window.ready===true;" }));
        await engine.call("take", tab, {}, { human: true });
        await engine.call("input", tab, { kind: "click", x: 50, y: 40 }, { human: true });
        await sleep(10_000);
      } finally {
        await engine.stop();
      }
      const lines = engine.logs.filter((line) => line.startsWith("[REMOTE_BROWSER_NATIVE_DIAG] "));
      assert(!lines.some((line) => line.toLowerCase().includes(CANARY)));
      const records = lines.map((line) => JSON.parse(line.slice(line.indexOf(" ") + 1)));
      const has = (kind: string, fields: Record<string, unknown> = {}) =>
        records.some(
          (r) =>
            r.kind === kind && Object.entries(fields).every(([key, value]) => r[key] === value),
        );
      const expected = {
        property: has("css_rejected", {
          error: "property",
          name: "unknown",
          reason: "unknown_property",
        }),
        value: has("css_rejected", { error: "property", name: "width", reason: "invalid_value" }),
        feature: records.some((r) => r.kind === "css_rejected" && r.features?.includes("unknown")),
        rule:
          has("css_rejected", { name: "unknown", error: "unsupported_rule" }) ||
          has("css_rejected", { name: "unknown", error: "invalid_rule" }),
        cssom: has("css_rejected", { source: "cssom", name: "width", reason: "invalid_value" }),
        pointer: has("pointer_down", { target: "other" }) && has("click", { target: "other" }),
        uncaught: records.some((r) => r.kind === "uncaught_error" && r.count >= 4),
        dom: has("dom_exception"),
        history: has("history_state_rejected", { targetScheme: "other" }),
        http: records.some((r) => r.kind === "http" && r.method === "other" && !("key" in r)),
        stale: records.some((r) => r.kind === "stale_check" && r.elements > 0),
      };
      assert.deepEqual(
        Object.entries(expected).filter(([, present]) => !present),
        [],
        JSON.stringify(records),
      );
    });
  } finally {
    for (const key of [
      "REMOTE_BROWSER_NATIVE_DIAGNOSTICS",
      "REMOTE_BROWSER_NATIVE_DIAGNOSTICS_STALE_CHECK",
      "REMOTE_BROWSER_NATIVE_DIAGNOSTICS_HOSTS",
    ]) {
      if (previous[key] === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = previous[key];
      }
    }
    await server.stop();
  }
  console.log("PASS: opt-in native diagnostics use fixed vocabulary without page-controlled text");
}

if (import.meta.main) {
  await cli(run);
}
