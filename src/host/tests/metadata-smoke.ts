import { assert, cli, Runtime, temporary, serve, wait } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  const server = serve();
  try {
    await temporary(async (root) => {
      const runtime = await Runtime.launch(host, engine, root);
      const { client } = runtime;
      try {
        const tab = (await client.call("browser_tabs", { action: "list" })).tabs[0].id;
        await client.call("browser_navigate", { tabId: tab, url: server.origin });
        const item = async () =>
          (await client.call("browser_tabs", { action: "list" })).tabs.find(
            (value: any) => value.id === tab,
          );
        await client.call("browser_evaluate", {
          tabId: tab,
          script: "document.title='metadata-'+ 'x'.repeat(9*1024*1024);return true;",
        });
        const first = await wait(item, (value) => value.title?.startsWith("metadata-"));
        assert(Buffer.byteLength(first.title) <= 4096);
        await client.call("browser_evaluate", {
          tabId: tab,
          script:
            "document.title='unicode-'+ '💡\"'.repeat(2048);location.hash='u'.repeat(128*1024);return true;",
        });
        const second = await wait(
          item,
          (value) => value.title?.startsWith("unicode-") && value.url?.includes("#"),
        );
        assert(Buffer.byteLength(second.title) <= 4096 && Buffer.byteLength(second.url) <= 16_384);
        assert.equal(
          (await client.call("browser_evaluate", { tabId: tab, script: "return 42;" })).value,
          42,
        );
        assert(!(await client.call("browser_status", {})).uncertain);
        assert(await runtime.dashboard.action("tabs"));
      } finally {
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
  }
  console.log("PASS: bounded UTF-8 titles/URLs preserve transport and subsequent automation");
}

if (import.meta.main) {
  await cli(run);
}
