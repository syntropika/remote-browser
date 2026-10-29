/** Resolved layout characters survive AltGr/Option without turning shortcuts into text. */
import { assert, cli, reservePage, Runtime, serve, temporary } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  const server = serve(
    () =>
      new Response(
        '<!doctype html><meta charset="utf-8"><input id="field" aria-label="Sample input">',
        { headers: { "Content-Type": "text/html" } },
      ),
  );
  try {
    await temporary(async (root) => {
      const runtime = await Runtime.launch(host, engine, root);
      try {
        const cases = [
          { key: "@", expected: "@" },
          { key: "@", ctrl: true, alt: true, altGraph: true, expected: "@" },
          { key: "@", alt: true, expected: "@" },
          { key: "å", alt: true, expected: "å" },
          { key: "@", ctrl: true, expected: "" },
          { key: "a", alt: true, expected: "" },
          { key: "a", ctrl: true, expected: "" },
          { key: "ñ", expected: "ñ" },
        ];
        for (const { expected, ...keys } of cases) {
          const { tabId, leaseId } = await reservePage(runtime.client);
          await runtime.client.call("browser_navigate", { leaseId, url: server.origin });
          await runtime.client.call("browser_evaluate", {
            leaseId,
            function: "() => { document.querySelector('input').focus(); return true; }",
          });
          await runtime.client.call("browser_tabs", { action: "release", leaseId });
          await runtime.dashboard.action("input", tabId, { kind: "key", ...keys });
          const next = await reservePage(runtime.client, tabId);
          const { value } = await runtime.client.call("browser_evaluate", {
            leaseId: next.leaseId,
            function: "() => document.querySelector('input').value",
          });
          assert.equal(value, expected, `Resolved keyboard input ${JSON.stringify(keys)}`);
          await runtime.client.call("browser_tabs", { action: "close", leaseId: next.leaseId });
        }
      } finally {
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
  }
  console.log("PASS: layout characters, AltGr/Option symbols and non-text shortcuts");
}
if (import.meta.main) {
  await cli(run);
}
