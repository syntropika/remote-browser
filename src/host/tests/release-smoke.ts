import { assert, cli, Runtime, temporary } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  await temporary(async (root) => {
    const runtime = await Runtime.launch(host, engine, root);
    const { client } = runtime;
    const tabs = async () =>
      (await client.call("browser_tabs", { action: "list" })).tabs.map((tab: any) => tab.id);
    const reserve = async (tabId: string) =>
      (
        await client.call("browser_tabs", {
          action: "reserve",
          tabId,
          agentName: "Release smoke",
          task: "release",
        })
      ).leaseId;
    try {
      const start = await tabs();
      const opened = (await client.call("browser_tabs", { action: "open" })).tabId;
      assert((await tabs()).includes(opened));
      await client.call("browser_tabs", {
        action: "release",
        tabId: opened,
        leaseId: await reserve(opened),
      });
      assert.deepEqual(await tabs(), start);
      const alone = start[0];
      await client.call("browser_tabs", {
        action: "release",
        tabId: alone,
        leaseId: await reserve(alone),
      });
      assert.deepEqual(await tabs(), [alone]);
      const held = (await client.call("browser_tabs", { action: "open" })).tabId;
      const lease = await reserve(held);
      await runtime.dashboard.action("take", held);
      await client.call("browser_tabs", { action: "release", tabId: held, leaseId: lease });
      assert((await tabs()).includes(held));
    } finally {
      await runtime.stop();
    }
  });
  console.log("PASS: release closes agent tabs, preserves the last tab and human-owned tabs");
}

if (import.meta.main) {
  await cli(run);
}
