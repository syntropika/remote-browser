import { reservePage, assert, cli, reference, Runtime, serve, temporary, wait } from "./harness.js";

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
        const original = (
          await client.call("browser_tabs", {
            action: "list",
          })
        ).tabs[0].id;
        const tab = await runtime.dashboard.action("open", null, {}, "default");
        const lease = (
          await client.call("browser_tabs", {
            action: "reserve",
            tabId: tab,
            agentName: "Adapter test",
            task: "stable CDP session",
          })
        ).leaseId;
        const args = { leaseId: lease };
        await client.call("browser_navigate", {
          ...args,
          url: server.origin,
        });
        const snapshot = await client.call("browser_snapshot", args);
        const another = await runtime.dashboard.action("open", null, {}, "default");
        const otherLease = (await reservePage(client, another)).leaseId;
        await client.call("browser_navigate", {
          leaseId: otherLease,
          url: `${server.origin}/other`,
        });
        await client.call("browser_evaluate", {
          leaseId: otherLease,
          function: '() => {\nconsole.log("other-tab");return true;\n}',
        });
        await client.call("browser_type", {
          ...args,
          target: reference(snapshot, "Name"),
          text: "stable",
        });
        await client.call("browser_click", {
          ...args,
          target: reference(snapshot, "Run"),
        });
        await wait(
          async () =>
            (
              await client.call("browser_evaluate", {
                ...args,
                function: '() => {\nreturn document.querySelector("#result").textContent;\n}',
              })
            ).value,
          (value) => value === "done",
        );
        const consolePage = await wait(
          () =>
            client.call("browser_diagnostics", {
              ...args,
              kind: "console",
              limit: 1,
            }),
          (value) => value.entries.some((entry: any) => entry.text === "adapter-click"),
        );
        assert(!JSON.stringify(consolePage).includes("other-tab"));
        const network = await wait(
          () =>
            client.call("browser_diagnostics", {
              ...args,
              kind: "network",
            }),
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
        await client.call(
          "browser_evaluate",
          {
            tabId: tab,
            function: "() => {\nreturn 42;\n}",
          },
          true,
        );
        await client.call(
          "browser_diagnostics",
          {
            ...args,
            kind: "invalid",
          },
          true,
        );
        await runtime.dashboard.action("take", tab);
        await client.call(
          "browser_type",
          {
            ...args,
            target: reference(snapshot, "Name"),
            text: "denied",
          },
          true,
        );
        await client.call("browser_diagnostics", { ...args, kind: "console" }, true);
        await client.call("browser_tabs", {
          action: "close",
          leaseId: otherLease,
        });
        const { tabs } = await client.call("browser_tabs", {
          action: "list",
        });
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
