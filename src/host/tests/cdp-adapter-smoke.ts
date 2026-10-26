import { assert, cli, reference, Runtime, serve, temporary, wait } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  const server = serve((request) => {
    if (new URL(request.url).pathname === "/probe") {
      return new Response("ok", { headers: { "X-Fixture-Secret": "not-in-diagnostics" } });
    }
    return new Response(
      '<!doctype html><label for="name">Name</label><input id="name"><button id="run">Run</button><output id="result"></output><script>document.querySelector("#run").onclick=async()=>{console.log("adapter-click");await fetch("/probe");document.querySelector("#result").textContent="done"}</script>',
      { headers: { "Content-Type": "text/html" } },
    );
  });
  try {
    await temporary(async (root) => {
      const runtime = await Runtime.launch(host, engine, root);
      const { client } = runtime;
      try {
        const original = (await client.call("browser_tabs", { action: "list" })).tabs[0].id;
        const tab = (await client.call("browser_tabs", { action: "open" })).tabId;
        const lease = (
          await client.call("browser_tabs", {
            action: "reserve",
            tabId: tab,
            agentName: "Adapter test",
            task: "stable CDP session",
          })
        ).leaseId;
        const args = { tabId: tab, leaseId: lease };
        await client.call("browser_navigate", { ...args, url: server.origin });
        const snapshot = await client.call("browser_snapshot", args);
        const another = (await client.call("browser_tabs", { action: "open" })).tabId;
        await client.call("browser_navigate", { tabId: another, url: `${server.origin}/other` });
        await client.call("browser_evaluate", {
          tabId: another,
          script: 'console.log("other-tab");return true;',
        });
        await client.call("browser_fill", {
          ...args,
          reference: reference(snapshot, "Name"),
          text: "stable",
        });
        await client.call("browser_click", { ...args, reference: reference(snapshot, "Run") });
        await wait(
          async () =>
            (
              await client.call("browser_evaluate", {
                ...args,
                script: 'return document.querySelector("#result").textContent;',
              })
            ).value,
          (value) => value === "done",
        );
        const consolePage = await wait(
          () => client.call("browser_diagnostics", { ...args, kind: "console", limit: 1 }),
          (value) => value.entries.some((entry: any) => entry.text === "adapter-click"),
        );
        assert(!JSON.stringify(consolePage).includes("other-tab"));
        const network = await wait(
          () => client.call("browser_diagnostics", { ...args, kind: "network" }),
          (value) =>
            value.entries.some(
              (entry: any) => entry.url?.endsWith("/probe") && entry.status === 200,
            ),
        );
        assert(!JSON.stringify(network).includes("not-in-diagnostics"));
        const next = await client.call("browser_diagnostics", {
          ...args,
          kind: "console",
          after: consolePage.next,
        });
        assert.equal(next.entries.length, 0);
        await client.call("browser_evaluate", { tabId: tab, script: "return 42;" }, true);
        await client.call("browser_diagnostics", { ...args, kind: "invalid" }, true);
        await runtime.dashboard.action("take", tab);
        await client.call(
          "browser_fill",
          { ...args, reference: reference(snapshot, "Name"), text: "denied" },
          true,
        );
        assert(
          (await client.call("browser_diagnostics", { ...args, kind: "console" })).entries.length >
            0,
        );
        await client.call("browser_tabs", { action: "close", tabId: another });
        const { tabs } = await client.call("browser_tabs", { action: "list" });
        assert.equal(tabs.find((value: any) => value.active).id, original);
        assert(!(await client.call("browser_status", {})).uncertain);
      } finally {
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
  }
  console.log(
    "PASS: stable CDP sessions, isolated diagnostics, native tab lifecycle and ownership",
  );
}

if (import.meta.main) {
  await cli(run);
}
