/** Restarting one browser keeps persistent storage and isolates other profiles and leases. */
import { writeFile } from "node:fs/promises";
import filePath from "node:path";

import { assert, cli, reservePage, Runtime, serve, temporary, wait } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let loading = false;
  const server = serve(async (request) => {
    if (new URL(request.url).pathname === "/pending") {
      loading = true;
      await pending;
    }
    return new Response("<!doctype html><p>Persistent browser fixture</p>", {
      headers: { "Content-Type": "text/html" },
    });
  });
  try {
    await temporary(async (root) => {
      const catalog = filePath.join(root, "profiles.json");
      await writeFile(
        catalog,
        JSON.stringify({
          defaultProfileId: "main",
          engineBinary: filePath.resolve(engine),
          profiles: ["main", "other"].map((id) => ({
            id,
            name: id,
            dataDirectory: filePath.join(root, id),
          })),
        }),
      );
      const runtime = await new Runtime([
        host,
        "--profiles-config",
        catalog,
        "--dashboard-port",
        "0",
        "--mcp-stdio",
      ]).start();
      try {
        const first = await reservePage(runtime.client, undefined, "main");
        const other = await reservePage(runtime.client, undefined, "other");
        await runtime.client.call("browser_navigate", {
          leaseId: first.leaseId,
          url: server.origin,
        });
        await runtime.client.call("browser_evaluate", {
          leaseId: first.leaseId,
          function:
            "() => { localStorage.setItem('saved','retained'); document.cookie='saved=retained; Max-Age=3600; SameSite=Lax'; return true; }",
        });
        await runtime.client.call("browser_evaluate", {
          leaseId: other.leaseId,
          function: "() => window.kept = 42",
        });
        await runtime.dashboard.action("restart", null, {}, "main");
        const { tabs } = await runtime.client.call("browser_tabs", {
          action: "list",
          profileId: "main",
        });
        assert.equal(tabs.length, 1);
        assert.equal(tabs[0].url, "about:blank");
        assert.equal(tabs[0].uncertain, false);
        await runtime.client.call("browser_snapshot", { leaseId: first.leaseId }, true);
        assert.equal(
          (
            await runtime.client.call("browser_evaluate", {
              leaseId: other.leaseId,
              function: "() => window.kept",
            })
          ).value,
          42,
        );
        const fresh = await reservePage(runtime.client, tabs[0].id, "main");
        await runtime.client.call("browser_navigate", {
          leaseId: fresh.leaseId,
          url: server.origin,
        });
        const storage = (
          await runtime.client.call("browser_evaluate", {
            leaseId: fresh.leaseId,
            function: "() => ({local:localStorage.getItem('saved'),cookie:document.cookie})",
          })
        ).value;
        assert.equal(storage.local, "retained");
        assert(storage.cookie.includes("saved=retained"));
        const navigation = runtime.client.call(
          "browser_navigate",
          { leaseId: fresh.leaseId, url: `${server.origin}/pending` },
          true,
        );
        await wait(() => loading);
        await runtime.dashboard.action("restart", null, {}, "main");
        await navigation;
        await runtime.client.call("browser_snapshot", { leaseId: fresh.leaseId }, true);
        assert.equal(
          (
            await runtime.client.call("browser_evaluate", {
              leaseId: other.leaseId,
              function: "() => window.kept",
            })
          ).value,
          42,
        );
        const status = await runtime.client.call("browser_status", { profileId: "main" });
        assert.equal(status.uncertain, false);
        const engines = runtime.logs
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line))
          .filter((event) => event.event === "engine_started");
        const crashed = engines.at(-1)?.engineProcessId;
        assert.equal(typeof crashed, "number");
        process.kill(crashed, "SIGKILL");
        await wait(
          async () =>
            (await runtime.client.call("browser_status", { profileId: "main" })).uncertain,
        );
        await runtime.dashboard.action("restart", null, {}, "main");
        assert.equal(
          (await runtime.client.call("browser_status", { profileId: "main" })).uncertain,
          false,
        );
        assert.equal(
          (
            await runtime.client.call("browser_evaluate", {
              leaseId: other.leaseId,
              function: "() => window.kept",
            })
          ).value,
          42,
        );
      } finally {
        finish();
        await runtime.stop();
      }
    });
  } finally {
    finish();
    await server.stop();
  }
  console.log("PASS: session restart, persistent storage, revoked leases and profile isolation");
}
if (import.meta.main) {
  await cli(run);
}
