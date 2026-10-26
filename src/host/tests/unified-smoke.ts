import { cli, assert, Runtime, serve, temporary, sleep, deadline } from "./harness.js";

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
        assert.equal((await client.request("tools/list", {})).tools.length, 17);
        assert((await dash.api("/api/profiles")).data.profiles.length);
        await dash.api("/api/profiles", undefined, 403, "https://foreign.example");
        const a = (await client.call("browser_tabs", { action: "open" })).tabId;
        const b = (await client.call("browser_tabs", { action: "open" })).tabId;
        const reserve = async (tabId: string) =>
          (
            await client.call("browser_tabs", {
              action: "reserve",
              tabId,
              agentName: "Test agent",
              task: "unified",
            })
          ).leaseId;
        const la = await reserve(a);
        const lb = await reserve(b);
        await client.call("browser_navigate", { tabId: b, leaseId: lb, url: server.origin });
        let done = false;
        const slow = client
          .call("browser_navigate", { tabId: a, leaseId: la, url: `${server.origin}/slow` })
          .finally(() => {
            done = true;
          });
        await deadline(started, 3000);
        assert.equal(
          (await client.call("browser_evaluate", { tabId: b, leaseId: lb, script: "return 42;" }))
            .value,
          42,
        );
        assert(!done);
        await slow;
        await dash.action("view", a);
        assert(await dash.action("screenshot", a));
        await dash.action("input", a, { kind: "key", key: "x" }, "default", 409);
        await dash.action("take", a);
        await client.call("browser_evaluate", { tabId: a, leaseId: la, script: "return 1;" }, true);
        await dash.action("navigate", a, { url: server.origin });
        await dash.action("return", a);
        assert.equal(
          (await client.call("browser_evaluate", { tabId: a, leaseId: la, script: "return 1;" }))
            .value,
          1,
        );
        const created = await client.call("browser_profiles", {
          action: "create",
          name: "Account two",
        });
        await dash.api("/api/profiles", { name: "Account three" });
        assert.equal((await dash.api("/api/profiles")).data.profiles.length, 3);
        let tab = (await client.call("browser_tabs", { action: "list", profileId: created.id }))
          .tabs[0].id;
        await client.call("browser_navigate", {
          profileId: created.id,
          tabId: tab,
          url: server.origin,
        });
        await client.call("browser_evaluate", {
          profileId: created.id,
          tabId: tab,
          script: "document.cookie='persisted=two; Max-Age=3600; Path=/';return true;",
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
              profileId: created.id,
              tabId: tab,
              policy,
            })
          ).state,
          "reauthRequired",
        );
        await runtime.stop();
        runtime = await Runtime.launch(host, engine, root);
        assert(
          (await runtime.client.call("browser_profiles", { action: "list" })).profiles.length >= 3,
        );
        assert.deepEqual(
          (await runtime.dashboard.api("/api/policies", { profileId: created.id })).data.policies,
          [policy],
        );
        tab = (await runtime.client.call("browser_tabs", { action: "list", profileId: created.id }))
          .tabs[0].id;
        await runtime.client.call("browser_navigate", {
          profileId: created.id,
          tabId: tab,
          url: server.origin,
        });
        assert(
          (
            await runtime.client.call("browser_evaluate", {
              profileId: created.id,
              tabId: tab,
              script: "return document.cookie;",
            })
          ).value.includes("persisted=two"),
        );
        const main = (await runtime.client.call("browser_tabs", { action: "list" })).tabs[0].id;
        await runtime.client.call("browser_navigate", { tabId: main, url: server.origin });
        assert(
          !(
            await runtime.client.call("browser_evaluate", {
              tabId: main,
              script: "return document.cookie;",
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
