import filePath from "node:path";

import { cli, assert, Runtime, Http, INIT, temporary, privateFile } from "./harness.js";

const { join } = filePath;
export { Http } from "./harness.js";
export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  await temporary(async (root) => {
    const secret = "synthetic-http-integration-secret-only";
    const token = join(root, "token");
    await privateFile(token, secret);
    const runtime = await Runtime.launch(host, engine, join(root, "browser"), {
      args: ["--mcp-http-token-file", token],
    });
    try {
      const http = new Http(runtime.url, secret);
      const { client } = runtime;
      await http.request("initialize", INIT, 401, { authorized: false });
      await http.request("initialize", INIT, 403, { origin: "https://foreign.example" });
      assert((await http.request("initialize", INIT)).result);
      assert.equal((await http.request("tools/list", {})).result.tools.length, 29);
      const tab = await runtime.dashboard.action("open", null, {}, "default");
      assert(
        (
          await http.call("browser_tabs", {
            action: "list",
          })
        ).tabs.some((t: any) => t.id === tab),
      );
      const lease = (
        await http.call("browser_tabs", {
          action: "reserve",
          tabId: tab,
          agentName: "Test agent",
          task: "shared HTTP lease",
        })
      ).leaseId;
      for (const args of [{ function: "() => 42" }, { leaseId: lease, function: "() => 42" }]) {
        await client.call("browser_evaluate", args, true);
      }
      assert.equal(
        (
          await http.call("browser_evaluate", {
            leaseId: lease,
            function: "() => {\nreturn 84;\n}",
          })
        ).value,
        84,
      );
      await runtime.dashboard.action("take", tab);
      await http.call(
        "browser_evaluate",
        {
          leaseId: lease,
          function: "() => {\nreturn 42;\n}",
        },
        true,
      );
      assert.equal(
        (
          await http.call("browser_profiles", {
            action: "list",
          })
        ).profiles[0].id,
        "default",
      );
    } finally {
      await runtime.stop();
    }
    assert(!runtime.logs.join("\n").includes(secret));
  });
  console.log(
    "PASS: authenticated HTTP MCP shares stdio profiles/leases and respects human takeover",
  );
}
if (import.meta.main) {
  await cli(run);
}
