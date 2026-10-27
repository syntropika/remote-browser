/** Real stdio clients use isolated CEF network contexts without selecting the user's tab. */
import filePath from "node:path";

import { verifyTlsNetwork } from "./fixtures/tls-network.js";
import {
  cli,
  assert,
  Runtime,
  Rpc,
  Mcp,
  Http,
  INIT,
  temporary,
  wait,
  withEngine,
} from "./harness.js";

const { join } = filePath;

export async function run(engine: string, host: string, options: Record<string, any>) {
  const binary = options["local-mcp-binary"];
  assert(typeof binary === "string");
  assert(host && binary, "Pass --host-binary and --local-mcp-binary");
  await withEngine(engine, async (native) => {
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const reserveNative = (id: string) =>
      native.call("reserve", null, {
        agentName: "Context cleanup verifier",
        task: "Native lifetime",
        networkSession: { id, proxy: "127.0.0.1:9" },
      });
    const first = await reserveNative(firstId);
    const second = await reserveNative(secondId);
    const observe = (retired: string[]) => native.call("network_sessions", null, { retired });
    assert.deepEqual(new Set(await observe([firstId, secondId])), new Set([firstId, secondId]));
    await native.call("close", first.tabId, {}, { lease: first.leaseId });
    assert(
      (await observe([])).includes(firstId),
      "An active network session keeps its context after closing a page",
    );
    await wait(
      () => observe([firstId]),
      (ids) => !ids.includes(firstId),
    );
    assert(
      (await observe([secondId])).includes(secondId),
      "A retired proxy remains pinned while its browser exists",
    );
    await native.call("close", second.tabId, {}, { lease: second.leaseId });
    await wait(
      () => observe([secondId]),
      (ids) => ids.length === 0,
    );
  });
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("api-ok", { headers: { "access-control-allow-origin": "*" } }),
  });
  const frontend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/socket" && server.upgrade(request)) {
        return undefined;
      }
      if (url.pathname === "/events") {
        return new Response("data: events-ok\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname === "/probe") {
        return new Response("still-online");
      }
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Local network fixture</title><button id="run" onclick="window.clicked=true">Run test</button><script>
      window.probe={origin:location.origin};fetch('http://127.0.0.1:${backend.port}/api').then(r=>r.text()).then(value=>probe.api=value);
      const socket=new WebSocket('ws://'+location.host+'/socket');socket.onopen=()=>socket.send('hmr');socket.onmessage=event=>probe.ws=event.data;
      const stream=new EventSource('/events');stream.onmessage=event=>{probe.events=event.data;stream.close();};
      </script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
    websocket: {
      message(socket, message) {
        socket.send(`echo:${String(message)}`);
      },
    },
  });
  const origin = `http://localhost:${frontend.port}`;
  const clients: Rpc[] = [];
  try {
    await temporary(async (root) => {
      await verifyTlsNetwork(binary, root);
      const runtime = await Runtime.launch(host, engine, join(root, "server"));
      try {
        const original = (await runtime.client.call("browser_tabs", { action: "list" })).tabs.find(
          (t: any) => t.active,
        ).id;
        await runtime.dashboard.action("resize", original, {
          width: 390,
          height: 700,
          mobile: true,
          deviceScaleFactor: 1,
        });
        const keyA = (await runtime.dashboard.api("/api/keys", { name: "Local agent A" }, 201))
          .data;
        const keyB = (await runtime.dashboard.api("/api/keys", { name: "Local agent B" }, 201))
          .data;
        const connect = async (secret: string) => {
          const rpc = new Rpc([binary, "mcp", "--connect", runtime.url], {
            ...process.env,
            REMOTE_BROWSER_API_KEY: secret,
          });
          clients.push(rpc);
          const mcp = new Mcp(rpc);
          await mcp.request("initialize", INIT);
          rpc.process.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
          );
          return { rpc, mcp };
        };
        const a = await connect(keyA.secret);
        const b = await connect(keyB.secret);
        const catalog = (await a.mcp.request("tools/list", {})).tools;
        assert.equal(catalog.length, 30);
        assert.equal(catalog.filter((t: any) => t.name === "browser_network").length, 1);
        assert.deepEqual((await a.mcp.call("browser_network", { action: "list" })).sessions, []);
        const open = async (client: Mcp) =>
          client.call("browser_network", {
            action: "open",
            exposeNetwork: `localhost:${frontend.port},127.0.0.1:${backend.port}`,
          });
        let netA = await open(a.mcp);
        const netB = await open(b.mcp);
        await b.mcp.call(
          "browser_tabs",
          {
            action: "reserve",
            networkSessionId: netA.networkSessionId,
            agentName: "B",
            task: "Denied cross-client session",
          },
          true,
        );
        const reserve = (mcp: Mcp, networkSessionId: string) =>
          mcp.call("browser_tabs", {
            action: "reserve",
            networkSessionId,
            agentName: "Network test",
            task: "Background local frontend",
          });
        const foreignClose = await fetch(
          `${runtime.url}/network/sessions/${netA.networkSessionId}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${keyB.secret}` } },
        );
        assert.equal(foreignClose.status, 400);
        const anonymous = await fetch(`${runtime.url}/network/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ exposeNetwork: "<loopback>" }),
        });
        assert.equal(anonymous.status, 401);
        let tabA = await reserve(a.mcp, netA.networkSessionId);
        const tabB = await reserve(b.mcp, netB.networkSessionId);
        assert.equal(
          (await a.mcp.call("browser_tabs", { action: "list" })).tabs.find((t: any) => t.active).id,
          original,
        );
        const evaluate = async (mcp: Pick<Mcp, "call">, leaseId: string, fn: string) =>
          (await mcp.call("browser_evaluate", { leaseId, function: fn })).value;
        for (const [client, tab] of [
          [a, tabA],
          [b, tabB],
        ] as const) {
          await client.mcp.call("browser_navigate", { leaseId: tab.leaseId, url: origin });
          const result = await wait(
            () => evaluate(client.mcp, tab.leaseId, "() => window.probe"),
            (v) => v?.api === "api-ok" && v?.ws === "echo:hmr" && v?.events === "events-ok",
          );
          assert.equal(result.origin, origin);
          assert.equal(await evaluate(client.mcp, tab.leaseId, "() => innerWidth"), 1024);
        }
        await evaluate(a.mcp, tabA.leaseId, '() => {document.cookie="session=alpha";return true}');
        assert.equal(await evaluate(b.mcp, tabB.leaseId, "() => document.cookie"), "");
        await evaluate(b.mcp, tabB.leaseId, '() => {document.cookie="session=beta";return true}');
        assert.equal(await evaluate(a.mcp, tabA.leaseId, "() => document.cookie"), "session=alpha");
        const sibling = await reserve(a.mcp, netA.networkSessionId);
        await a.mcp.call("browser_navigate", { leaseId: sibling.leaseId, url: origin });
        assert.equal(
          await evaluate(a.mcp, sibling.leaseId, "() => document.cookie"),
          "session=alpha",
        );
        await a.mcp.call("browser_tabs", { action: "release", leaseId: sibling.leaseId });
        await b.mcp.call(
          "browser_tabs",
          {
            action: "reserve",
            tabId: sibling.tabId,
            agentName: "Other client",
            task: "Cannot take a released network page",
          },
          true,
        );
        const siblingAgain = await a.mcp.call("browser_tabs", {
          action: "reserve",
          tabId: sibling.tabId,
          agentName: "Original client",
          task: "Close the owned network page",
        });
        await a.mcp.call("browser_tabs", { action: "close", leaseId: siblingAgain.leaseId });
        await a.mcp.call(
          "browser_tabs",
          {
            action: "reserve",
            tabId: original,
            networkSessionId: netA.networkSessionId,
            agentName: "A",
            task: "Cannot reroute an existing tab",
          },
          true,
        );
        const snapshot = await a.mcp.call("browser_snapshot", { leaseId: tabA.leaseId });
        const button = snapshot.elements.find((e: any) => e.name === "Run test");
        assert(button);
        await a.mcp.call("browser_click", { leaseId: tabA.leaseId, target: button.reference });
        assert.equal(await evaluate(a.mcp, tabA.leaseId, "() => window.clicked"), true);
        await a.mcp.call("browser_tabs", { action: "select", leaseId: tabA.leaseId });
        assert.equal(
          (await a.mcp.call("browser_tabs", { action: "list" })).tabs.find((t: any) => t.active).id,
          tabA.tabId,
        );
        await runtime.dashboard.action("view", original);
        await runtime.dashboard.action("navigate", original, { url: origin });
        const normal = await a.mcp.call("browser_tabs", {
          action: "reserve",
          tabId: original,
          agentName: "Normal page verifier",
          task: "Unchanged context",
        });
        assert.equal(await evaluate(a.mcp, normal.leaseId, "() => document.cookie"), "");
        await a.mcp.call("browser_tabs", { action: "release", leaseId: normal.leaseId });
        await a.mcp.call("browser_network", {
          action: "close",
          networkSessionId: netA.networkSessionId,
        });
        const failedFetch =
          'async () => {try {await fetch("/probe",{cache:"no-store"});return false}catch{return true}}';
        await wait(
          () => evaluate(a.mcp, tabA.leaseId, failedFetch),
          (value) => value === true,
        );
        assert.equal(
          await evaluate(
            b.mcp,
            tabB.leaseId,
            'async () => (await fetch("/probe",{cache:"no-store"})).text()',
          ),
          "still-online",
          "Closing A must not disconnect B's context",
        );
        await a.mcp.call("browser_tabs", { action: "close", leaseId: tabA.leaseId });
        netA = await open(a.mcp);
        tabA = await reserve(a.mcp, netA.networkSessionId);
        await a.mcp.call("browser_navigate", { leaseId: tabA.leaseId, url: origin });
        assert.equal(await evaluate(a.mcp, tabA.leaseId, "() => document.cookie"), "");
        await runtime.dashboard.api("/api/keys/revoke", { id: keyB.key.id });
        await wait(
          async () =>
            (await b.mcp.call("browser_network", { action: "list" })).sessions[0].connected,
          (v) => v === false,
          12_000,
        );
        assert.equal(
          await evaluate(
            a.mcp,
            tabA.leaseId,
            'async () => (await fetch("/probe",{cache:"no-store"})).text()',
          ),
          "still-online",
          "Revoking B must not disconnect A's context",
        );
        // EOF closes the local tunnel while its remote leases remain owned by the same client.
        await a.rpc.exit();
        clients.splice(clients.indexOf(a.rpc), 1);
        const remoteA = new Http(runtime.url, keyA.secret);
        await remoteA.request("initialize", INIT);
        await wait(
          async () =>
            (
              await remoteA.call("browser_evaluate", {
                leaseId: tabA.leaseId,
                function:
                  'async () => {try {await fetch("/probe",{cache:"no-store"});return false}catch{return true}}',
              })
            ).value,
          (v) => v === true,
          12_000,
        );
        assert.equal(
          (await fetch(`${origin}/probe`)).status,
          200,
          "The origin remains online; disconnect must not fall back to server localhost",
        );
        assert(
          (await remoteA.call("browser_tabs", { action: "list" })).tabs.some(
            (t: any) => t.id === tabA.tabId && t.reservation && !t.uncertain,
          ),
        );
        await runtime.dashboard.action("reload", original);
        const normalAgain = await remoteA.call("browser_tabs", {
          action: "reserve",
          tabId: original,
          agentName: "Normal page verifier",
          task: "Network unaffected after disconnect",
        });
        assert.equal(
          await evaluate(remoteA, normalAgain.leaseId, "() => document.title"),
          "Local network fixture",
        );
        await remoteA.call("browser_tabs", { action: "release", leaseId: normalAgain.leaseId });
        const restricted = (
          await runtime.dashboard.api("/api/profiles", { name: "Restricted tests" })
        ).data.id;
        const scoped = (
          await runtime.dashboard.api(
            "/api/keys",
            { name: "Scoped local key", profileIds: [restricted] },
            201,
          )
        ).data;
        const c = await connect(scoped.secret);
        await c.mcp.call(
          "browser_network",
          { action: "open", profileId: "default", exposeNetwork: "<loopback>" },
          true,
        );
        await c.mcp.call("browser_network", {
          action: "open",
          profileId: restricted,
          exposeNetwork: "<loopback>",
        });
        await runtime.dashboard.change("mcp", "disable");
        await wait(
          async () =>
            (await c.mcp.call("browser_network", { action: "list" })).sessions[0].connected,
          (value) => value === false,
          12_000,
        );
        await runtime.dashboard.change("mcp", "enable");
        for (const rpc of clients) {
          await rpc.exit();
        }
        clients.length = 0;
        assert(!runtime.logs.join("\n").includes(keyA.secret));
        assert(!runtime.logs.join("\n").includes(keyB.secret));
      } finally {
        for (const rpc of clients) {
          await rpc.exit();
        }
        clients.length = 0;
        await runtime.stop();
      }
    });
  } finally {
    await Promise.all([frontend.stop(true), backend.stop(true)]);
  }
  console.log(
    "PASS: local stdio MCP, background pages, isolated session cookies, HTTP/API/WS/SSE, ownership, scope, revocation and fail-closed disconnect",
  );
}
if (import.meta.main) {
  await cli(run);
}
