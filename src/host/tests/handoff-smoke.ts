import { assert, cli, reservePage, Runtime, temporary } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  await temporary(async (root) => {
    const runtime = await Runtime.launch(host, engine, root);
    const { client, dashboard } = runtime;
    try {
      const { tabId, leaseId } = await reservePage(client);
      await client.call("browser_evaluate", { leaseId, function: "() => window.counter = 0" });
      await dashboard.action("take", tabId);
      await dashboard.action("handoff_status");
      await client.call(
        "browser_tabs",
        { action: "reserve", tabId, agentName: "Other", task: "cannot reclaim human control" },
        true,
      );
      await client.call("browser_evaluate", { leaseId, function: "() => ++window.counter" }, true);
      assert.equal((await dashboard.action("handoff_status")).requests.length, 0);
      await dashboard.action("return", tabId);
      await client.call("browser_snapshot", { leaseId }, true);
      const resumed = await reservePage(client, tabId);
      assert.equal(
        (
          await client.call("browser_evaluate", {
            leaseId: resumed.leaseId,
            function: "() => window.counter",
          })
        ).value,
        0,
      );
      await client.call("browser_evaluate", {
        leaseId: resumed.leaseId,
        function: "() => ++window.counter",
      });
      await client.call("browser_tabs", { action: "release", leaseId: resumed.leaseId });
    } finally {
      await runtime.stop();
    }
  });
  console.log("PASS: user takeover revokes the lease without scheduling automatic resumption");
}
if (import.meta.main) {
  await cli(run);
}
