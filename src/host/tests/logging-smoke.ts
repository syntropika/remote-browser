import {
  cli,
  assert,
  Runtime,
  Rpc,
  Mcp,
  INIT,
  serve,
  temporary,
  reference,
  wait,
} from "./harness.js";

const secret = "synthetic-log-secret-do-not-record";

const records = (lines: string[]) =>
  lines
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((event) => event.schemaVersion === 1);

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  const server = serve();
  try {
    await temporary(async (root) => {
      const runtime = await Runtime.launch(host, engine, root, {
        env: { ...process.env, REMOTE_BROWSER_LOG_LEVEL: "debug" },
      });
      const trace = async (id: string, components: string[]) =>
        wait(
          () => records(runtime.logs).filter((event) => event.traceId === id),
          (events) =>
            components.every((component) =>
              events.some(
                (event) => event.component === component && event.event === "operation_finished",
              ),
            ),
        );
      try {
        const c = runtime.client;
        const tab = (await c.call("browser_tabs", { action: "list" })).tabs[0].id;
        const result = await c.request("tools/call", {
          name: "browser_navigate",
          arguments: { tabId: tab, url: `${server.origin}/?credential=${secret}` },
        });
        assert.match(result._meta.traceId, /^[\da-f-]{36}$/u);
        const events = await trace(result._meta.traceId, ["mcp", "native", "engine"]);
        const finished = events.filter((e) => e.event === "operation_finished");
        assert(finished.every((e) => e.outcome === "ok" && e.elapsedMs >= 0));
        const peers = finished.filter((e) => ["native", "engine"].includes(e.component));
        for (const key of ["requestId", "profileKey", "tabKey"]) {
          assert.equal(peers[0][key], peers[1][key]);
        }
        const snapshot = await c.call("browser_snapshot", { tabId: tab });
        await c.call("browser_fill", {
          tabId: tab,
          reference: reference(snapshot, "Email"),
          text: secret,
        });
        await c.call("browser_evaluate", {
          tabId: tab,
          script: `document.title='${secret}';document.cookie='credential=${secret}';return true;`,
        });
        const lease = (
          await c.call("browser_tabs", {
            action: "reserve",
            tabId: tab,
            agentName: "Test agent",
            task: secret,
          })
        ).leaseId;
        const response = await runtime.dashboard.api(
          "/api/action",
          { profileId: "default", op: "navigate", tabId: tab, args: { url: server.origin } },
          409,
        );
        const rejected = await trace(response.headers.get("x-request-id"), [
          "dashboard",
          "native",
          "engine",
        ]);
        assert.equal(
          rejected.find((e) => e.component === "dashboard" && e.event === "operation_finished")
            .httpStatus,
          409,
        );
        await runtime.stop();
        const text = JSON.stringify(records(runtime.logs));
        for (const value of [secret, lease, server.origin, tab]) {
          assert(!text.includes(value));
        }
      } finally {
        await runtime.stop();
      }
    });
    await temporary(async (root) => {
      const runtime = await Runtime.launch(host, engine, root, {
        env: { ...process.env, REMOTE_BROWSER_LOG_LEVEL: "info" },
      });
      try {
        await runtime.client.call("browser_tabs", { action: "list" });
      } finally {
        await runtime.stop();
      }
      assert(!records(runtime.logs).some((e) => e.level === "debug"));
    });
    await temporary(async (root) => {
      const rpc = new Rpc(
        [host, "--profile-root", root, "--engine-binary", engine],
        { ...process.env, REMOTE_BROWSER_LOG_LEVEL: "debug" },
        false,
      );
      const client = new Mcp(rpc);
      try {
        await client.request("initialize", INIT);
        rpc.process.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        );
        for (let i = 0; i < 1500; i++) {
          assert((await client.call("browser_tabs", { action: "list" })).tabs.length);
        }
        rpc.drain();
        assert((await client.call("browser_tabs", { action: "list" })).tabs.length);
        await rpc.exit();
        await wait(
          () => records(rpc.logs),
          (events) => events.some((event) => event.droppedEvents > 0),
        );
      } finally {
        if (rpc.process.exitCode === null) {
          rpc.process.kill("SIGKILL");
        }
      }
    });
  } finally {
    await server.stop();
  }
  console.log(
    "PASS: correlated private diagnostics, log levels and 1500 operations with stderr backpressure",
  );
}

if (import.meta.main) {
  await cli(run);
}
