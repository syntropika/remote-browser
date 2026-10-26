import { constants, openSync, closeSync, readSync } from "node:fs";
import filePath from "node:path";

import {
  reservePage,
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
const { join } = filePath;
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
        const tab = (
          await c.call("browser_tabs", {
            action: "list",
          })
        ).tabs[0].id;
        const lease = (await reservePage(c, tab)).leaseId;
        const result = await c.request("tools/call", {
          name: "browser_navigate",
          arguments: { leaseId: lease, url: `${server.origin}/?credential=${secret}` },
        });
        assert.match(result._meta.traceId, /^[\da-f-]{36}$/u);
        const events = await trace(result._meta.traceId, ["mcp", "native", "engine"]);
        const finished = events.filter((e) => e.event === "operation_finished");
        assert(finished.every((e) => e.outcome === "ok" && e.elapsedMs >= 0));
        const peers = finished.filter((e) => ["native", "engine"].includes(e.component));
        for (const key of ["requestId", "profileKey", "tabKey"]) {
          assert.equal(peers[0][key], peers[1][key]);
        }
        const snapshot = await c.call("browser_snapshot", {
          leaseId: lease,
        });
        await c.call("browser_type", {
          leaseId: lease,
          target: reference(snapshot, "Email"),
          text: secret,
        });
        await c.call("browser_evaluate", {
          leaseId: lease,
          function:
            "() => {\n" +
            `document.title='${secret}';document.cookie='credential=${secret}';return true;` +
            "\n}",
        });
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
        await runtime.client.call("browser_tabs", {
          action: "list",
        });
      } finally {
        await runtime.stop();
      }
      assert(!records(runtime.logs).some((e) => e.level === "debug"));
    });
    await temporary(async (root) => {
      // A real FIFO keeps Bun's eager child-pipe buffering out of the backpressure test.
      const fifo = join(root, "stderr.fifo");
      assert.equal(Bun.spawnSync(["mkfifo", fifo]).exitCode, 0);
      const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      const writer = openSync(fifo, constants.O_WRONLY);
      const rpc = new Rpc(
        [host, "--profile-root", root, "--engine-binary", engine],
        { ...process.env, REMOTE_BROWSER_LOG_LEVEL: "debug" },
        false,
        writer,
      );
      closeSync(writer);
      let draining: ReturnType<typeof setInterval> | undefined;
      let buffered = "";
      const drain = () => {
        const bytes = Buffer.alloc(65_536);
        for (;;) {
          let count: number;
          try {
            count = readSync(reader, bytes);
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "EAGAIN") {
              break;
            }
            throw cause;
          }
          if (count === 0) {
            break;
          }
          buffered += bytes.toString("utf-8", 0, count);
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          rpc.logs.push(...lines);
        }
      };
      const client = new Mcp(rpc);
      try {
        await client.request("initialize", INIT);
        rpc.process.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        );
        for (let i = 0; i < 1500; i++) {
          assert(
            (
              await client.call("browser_tabs", {
                action: "list",
              })
            ).tabs.length,
          );
        }
        draining = setInterval(drain, 10);
        drain();
        assert(
          (
            await client.call("browser_tabs", {
              action: "list",
            })
          ).tabs.length,
        );
        await rpc.exit();
        await wait(() => records(rpc.logs).find((event) => event.droppedEvents > 0));
      } finally {
        if (rpc.process.exitCode === null) {
          rpc.process.kill("SIGKILL");
        }
        clearInterval(draining);
        closeSync(reader);
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
