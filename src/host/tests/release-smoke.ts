import { assert, cli, reservePage, Runtime, temporary } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  await temporary(async (root) => {
    const runtime = await Runtime.launch(host, engine, root);
    const { client } = runtime;
    try {
      const { tabId, leaseId } = await reservePage(client);
      await client.call("browser_tabs", { action: "release", leaseId });
      const { tabs } = await client.call("browser_tabs", { action: "list" });
      assert(tabs.some((tab: any) => tab.id === tabId && !tab.reservation));
      await client.call("browser_snapshot", { leaseId }, true);
      const next = await reservePage(client, tabId);
      await client.call("browser_tabs", { action: "close", leaseId: next.leaseId });
      assert(
        !(await client.call("browser_tabs", { action: "list" })).tabs.some(
          (tab: any) => tab.id === tabId,
        ),
      );
      await client.call("browser_snapshot", { leaseId: next.leaseId }, true);
      const last = (await client.call("browser_tabs", { action: "list" })).tabs[0].id;
      const held = await reservePage(client, last);
      await client.call("browser_tabs", { action: "close", leaseId: held.leaseId }, true);
      await client.call("browser_tabs", { action: "release", leaseId: held.leaseId });
    } finally {
      await runtime.stop();
    }
  });
  console.log("PASS: release preserves tabs, close revokes leases, and the last tab stays open");
}
if (import.meta.main) {
  await cli(run);
}
