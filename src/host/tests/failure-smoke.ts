import { reservePage, cli, assert, Runtime, serve, temporary, wait } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = serve(async (request) => {
    if (new URL(request.url).pathname === "/pending") {
      await pending;
    }
    return new Response(
      "<!doctype html><title>Stable fixture</title><p>Native timeout fixture</p>",
      { headers: { "Content-Type": "text/html" } },
    );
  });
  try {
    await temporary(async (root) => {
      const runtime = await Runtime.launch(host, engine, root);
      try {
        const { client } = runtime;
        const healthy = (
          await client.call("browser_tabs", {
            action: "list",
          })
        ).tabs[0].id;
        const healthyLease = (await reservePage(client, healthy)).leaseId;
        await client.call("browser_navigate", {
          leaseId: healthyLease,
          url: server.origin,
        });
        const failed = await runtime.dashboard.action("open", null, {}, "default");
        const failedLease = (await reservePage(client, failed)).leaseId;
        const result = await client.call(
          "browser_navigate",
          {
            leaseId: failedLease,
            url: `${server.origin}/pending`,
          },
          true,
        );
        assert.equal(
          result.content[0].text,
          "Browser completion is unknown. Restart the MCP server before further actions",
        );
        const { tabs } = await client.call("browser_tabs", {
          action: "list",
        });
        assert(
          tabs.find((t: any) => t.id === failed).uncertain &&
            !tabs.find((t: any) => t.id === healthy).uncertain,
        );
        assert.equal(
          (
            await client.call("browser_evaluate", {
              leaseId: healthyLease,
              function: "() => {\nreturn 42;\n}",
            })
          ).value,
          42,
        );
        const records = () =>
          runtime.logs
            .filter((line) => line.startsWith("{"))
            .map((line) => JSON.parse(line))
            .filter((e) => e.schemaVersion === 1);
        const event = await wait(() => records().find((e) => e.reason === "operation_timeout"));
        assert(event.operation === "navigate" && event.tabKey.startsWith("t-"));
        assert.equal(event.traceId, result._meta.traceId);
        assert(records().every((e) => e.timestamp && e.level));
        assert(!JSON.stringify(records()).includes(server.origin));
      } finally {
        release();
        await runtime.stop();
      }
    });
  } finally {
    release();
    await server.stop();
  }
  console.log(
    "PASS: completion unknown is isolated to the timed-out tab with redacted correlated diagnostics",
  );
}
if (import.meta.main) {
  await cli(run);
}
