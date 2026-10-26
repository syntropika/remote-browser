import { cli, assert, Runtime, temporary, wait, sleep } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  await temporary(async (root) => {
    const runtime = await Runtime.launch(host, engine, root);
    try {
      const { client } = runtime;
      const dash = runtime.dashboard;
      const tab = (await client.call("browser_tabs", { action: "open" })).tabId;
      const lease = (
        await client.call("browser_tabs", {
          action: "reserve",
          tabId: tab,
          agentName: "Test agent",
          task: "handoff test",
        })
      ).leaseId;
      const args = {
        tabId: tab,
        leaseId: lease,
        script: "window.handoffCounter=(window.handoffCounter||0)+1;return window.handoffCounter;",
      };
      const prompt = () =>
        wait(async () =>
          (await dash.action("handoff_status")).requests.find((item: any) => item.tabId === tab),
        );
      await dash.action("take", tab);
      await dash.action("handoff_status");
      const cancelled = client.call("browser_evaluate", args, true);
      let request = await prompt();
      await dash.action("handoff_ack", tab, { id: request.id });
      await dash.action("handoff_cancel", tab, { id: request.id });
      await cancelled;
      await dash.action("return", tab);
      assert.equal(
        (
          await client.call("browser_evaluate", {
            ...args,
            script: "return window.handoffCounter||0;",
          })
        ).value,
        0,
      );
      await dash.action("take", tab);
      await dash.action("handoff_status");
      const accepted = client.call("browser_evaluate", args);
      request = await prompt();
      const start = performance.now();
      for (let i = 0; i < 12; i++) {
        if (!(await dash.action("handoff_status")).requests.length) {
          break;
        }
        await dash.action("handoff_ack", tab, { id: request.id });
        await sleep(500);
        if (!(await dash.action("handoff_status")).requests.length) {
          break;
        }
      }
      assert(performance.now() - start >= 4500);
      assert.equal((await accepted).value, 1);
      assert((await dash.action("tabs")).some((t: any) => t.id === tab && t.owner === "agent"));
      await client.call("browser_tabs", { action: "release", tabId: tab, leaseId: lease });
    } finally {
      await runtime.stop();
    }
  });
  console.log(
    "PASS: canceled handoff executes zero actions; acknowledged handoff executes exactly once",
  );
}

if (import.meta.main) {
  await cli(run);
}
