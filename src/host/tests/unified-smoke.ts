import { reservePage, cli, assert, Runtime, serve, temporary, sleep, deadline } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const base = serve();
  const server = serve(async (request) => {
    if (new URL(request.url).pathname === "/slow") {
      began();
      await sleep(2000);
    }
    return fetch(base.origin + new URL(request.url).pathname);
  });
  try {
    await temporary(async (root) => {
      let runtime = await Runtime.launch(host, engine, root);
      try {
        const { client } = runtime;
        const dash = runtime.dashboard;
        assert.equal((await client.request("tools/list", {})).tools.length, 29);
        assert((await dash.api("/api/profiles")).data.profiles.length);
        await dash.api("/api/profiles", undefined, 403, "https://foreign.example");
        const a = await runtime.dashboard.action("open", null, {}, "default");
        const b = await runtime.dashboard.action("open", null, {}, "default");
        const reserve = async (tabId: string) =>
          (
            await client.call("browser_tabs", {
              action: "reserve",
              tabId,
              agentName: "Test agent",
              task: "unified",
            })
          ).leaseId;
        let la = await reserve(a);
        const lb = await reserve(b);
        await client.call("browser_navigate", {
          leaseId: lb,
          url: server.origin,
        });
        let done = false;
        const slow = client
          .call("browser_navigate", {
            leaseId: la,
            url: `${server.origin}/slow`,
          })
          .finally(() => {
            done = true;
          });
        await deadline(started, 3000);
        assert.equal(
          (
            await client.call("browser_evaluate", {
              leaseId: lb,
              function: "() => {\nreturn 42;\n}",
            })
          ).value,
          42,
        );
        assert(!done);
        await slow;
        await dash.action("view", a);
        assert(await dash.action("screenshot", a));
        await dash.action("input", a, { kind: "key", key: "x" }, "default", 409);
        await dash.action("take", a);
        await client.call(
          "browser_evaluate",
          {
            leaseId: la,
            function: "() => {\nreturn 1;\n}",
          },
          true,
        );
        await dash.action("navigate", a, { url: server.origin });
        await dash.action("return", a);
        await client.call("browser_snapshot", { leaseId: la }, true);
        la = await reserve(a);
        assert.equal(
          (
            await client.call("browser_evaluate", {
              leaseId: la,
              function: "() => {\nreturn 1;\n}",
            })
          ).value,
          1,
        );
        const created = await client.call("browser_profiles", {
          action: "create",
          name: "Account two",
        });
        await dash.api("/api/profiles", { name: "Account three" });
        assert.equal((await dash.api("/api/profiles")).data.profiles.length, 3);
        let tab = (
          await client.call("browser_tabs", {
            action: "list",
            profileId: created.id,
          })
        ).tabs[0].id;
        let profileLease = (await reservePage(client, tab, created.id)).leaseId;
        await client.call("browser_navigate", {
          leaseId: profileLease,
          url: server.origin,
        });
        await client.call("browser_evaluate", {
          leaseId: profileLease,
          function:
            "() => {\ndocument.cookie='persisted=two; Max-Age=3600; Path=/';return true;\n}",
        });
        const policy = {
          origin: server.origin,
          cookieNames: ["persisted"],
          authenticatedSelector: null,
          loginSelector: "#login",
          warningSeconds: 3600,
        };
        await dash.api("/api/policies", { profileId: created.id, policy });
        assert.equal(
          (
            await client.call("browser_session_health", {
              leaseId: profileLease,
              policy,
            })
          ).state,
          "reauthRequired",
        );
        await runtime.stop();
        runtime = await Runtime.launch(host, engine, root);
        assert(
          (
            await runtime.client.call("browser_profiles", {
              action: "list",
            })
          ).profiles.length >= 3,
        );
        assert.deepEqual(
          (await runtime.dashboard.api("/api/policies", { profileId: created.id })).data.policies,
          [policy],
        );
        tab = (
          await runtime.client.call("browser_tabs", {
            action: "list",
            profileId: created.id,
          })
        ).tabs[0].id;
        profileLease = (await reservePage(runtime.client, tab, created.id)).leaseId;
        await runtime.client.call("browser_navigate", {
          leaseId: profileLease,
          url: server.origin,
        });
        assert(
          (
            await runtime.client.call("browser_evaluate", {
              leaseId: profileLease,
              function: "() => {\nreturn document.cookie;\n}",
            })
          ).value.includes("persisted=two"),
        );
        const main = (
          await runtime.client.call("browser_tabs", {
            action: "list",
          })
        ).tabs[0].id;
        const mainLease = (await reservePage(runtime.client, main)).leaseId;
        await runtime.client.call("browser_navigate", {
          leaseId: mainLease,
          url: server.origin,
        });
        assert(
          !(
            await runtime.client.call("browser_evaluate", {
              leaseId: mainLease,
              function: "() => {\nreturn document.cookie;\n}",
            })
          ).value.includes("persisted=two"),
        );
      } finally {
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
    await base.stop();
  }
  console.log(
    "PASS: unified MCP/dashboard, concurrent profiles, takeover and persistent catalog/policies/cookies",
  );
}
if (import.meta.main) {
  await cli(run);
}
