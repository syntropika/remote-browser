import filePath from "node:path";

import { WELCOME } from "./fixtures/embedded-smoke.js";
import { PAGE } from "./fixtures/smoke.js";
import {
  cli,
  assert,
  closeEngine,
  Engine,
  serve,
  temporary,
  reference,
  deadline,
  sleep,
} from "./harness.js";

const { join } = filePath;

export async function run(binary: string) {
  let began!: () => void;
  let started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const server = serve(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/slow") {
      began();
      await sleep(2000);
    }
    return new Response(["/welcome", "/short"].includes(path) ? WELCOME : PAGE, {
      headers: {
        "Content-Type": "text/html",
        ...(path === "/short"
          ? { "Set-Cookie": "auth_marker=synthetic; HttpOnly; Max-Age=60; Path=/" }
          : {}),
      },
    });
  });
  try {
    await temporary(async (root) => {
      const engines: Engine[] = [];
      const start = (name: string) => {
        const value = new Engine(binary, join(root, name));
        engines.push(value);
        return value;
      };
      try {
        const first = start("profile-a");
        const second = start("profile-b");
        const rootTab = (await first.call("tabs")).find((tab: any) => tab.active).id;
        const a = await first.call("open");
        const b = await first.call("open");
        const leaseA = (await first.call("reserve", a, { agentName: "Agent a", task: "agent a" }))
          .leaseId;
        const leaseB = (await first.call("reserve", b, { agentName: "Agent b", task: "agent b" }))
          .leaseId;
        const oa = { lease: leaseA };
        const ob = { lease: leaseB };
        await first.call("navigate", a, { url: server.origin }, oa);
        await first.call("navigate", b, { url: server.origin }, ob);
        const pageA = await first.call("snapshot", a, {}, oa);
        const pageB = await first.call("snapshot", b, {}, ob);
        await first.call(
          "fill",
          a,
          { reference: reference(pageA, "Email"), text: "a@example.test" },
          oa,
        );
        await first.call(
          "fill",
          b,
          { reference: reference(pageB, "Email"), text: "b@example.test" },
          ob,
        );
        await first.call(
          "click",
          a,
          { reference: reference(pageB, "Sign in") },
          { ...oa, error: true },
        );
        assert.equal(
          await first.call(
            "evaluate",
            a,
            { script: "return document.querySelector('#email').value;" },
            oa,
          ),
          "a@example.test",
        );
        assert.equal(
          await first.call(
            "evaluate",
            b,
            { script: "return document.querySelector('#email').value;" },
            ob,
          ),
          "b@example.test",
        );
        const listing = await first.call("tabs");
        assert.equal(listing.find((t: any) => t.active).id, rootTab);
        assert(!JSON.stringify(listing).includes(leaseA));
        await first.call("input", a, { kind: "key", key: "x" }, { human: true, error: true });
        await first.call(
          "navigate",
          a,
          { url: `${server.origin}/welcome` },
          { human: true, error: true },
        );
        await first.call("view", a, {}, { human: true });
        assert(
          Buffer.from(await first.call("screenshot", a, {}, { human: true }), "base64")
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        );
        started = new Promise<void>((resolve) => {
          began = resolve;
        });
        let slowDone = false;
        const slow = first.call("navigate", a, { url: `${server.origin}/slow` }, oa).finally(() => {
          slowDone = true;
        });
        await deadline(started, 3000);
        const observation = first.call("screenshot", a, {}, { human: true });
        assert((await first.call("tabs")).find((t: any) => t.id === a).busy);
        assert.equal(await first.call("evaluate", b, { script: "return 42;" }, ob), 42);
        assert(!slowDone);
        await first.call("evaluate", a, { script: "return 1;" }, { ...oa, error: true });
        const take = first.call("take", a, {}, { human: true });
        await Promise.all([slow, observation, take]);
        await first.call("navigate", a, { url: server.origin }, { ...oa, error: true });
        await first.call("navigate", a, { url: server.origin }, { human: true });
        await first.call("return", a, {}, { human: true });
        await first.call("reserve", a, { task: "resumed" }, { error: true });
        await first.call("renew", a, {}, oa);
        await first.call("navigate", a, { url: `${server.origin}/short` }, oa);
        const health = await first.call(
          "health",
          a,
          {
            origin: server.origin,
            cookieNames: ["auth_marker"],
            authenticatedSelector: "[data-authenticated]",
            loginSelector: "#login",
            warningSeconds: 3600,
          },
          oa,
        );
        assert(health.state === "expiring" && health.secondsRemaining <= 60);
        assert(!JSON.stringify(health).includes("synthetic"));
        assert.equal(
          await first.call("evaluate", a, { script: "return document.cookie;" }, oa),
          "",
        );
        await first.call(
          "evaluate",
          a,
          {
            script:
              "document.cookie='persistent=account-a; Max-Age=3600; Path=/';localStorage.setItem('account','a');return true;",
          },
          oa,
        );
        const other = (await second.call("tabs")).find((t: any) => t.active).id;
        await second.call("navigate", other, { url: server.origin });
        assert(
          !(await second.call("evaluate", other, { script: "return document.cookie;" })).includes(
            "persistent=",
          ),
        );
        assert.equal(
          await second.call("evaluate", other, {
            script: "return localStorage.getItem('account');",
          }),
          null,
        );
        await first.call("close", b, {}, ob);
        assert.equal((await first.call("tabs")).length, 2);
        await first.stop();
        const restarted = start("profile-a");
        const tab = (await restarted.call("tabs")).find((t: any) => t.active).id;
        await restarted.call("navigate", tab, { url: server.origin });
        assert(
          (await restarted.call("evaluate", tab, { script: "return document.cookie;" })).includes(
            "persistent=account-a",
          ),
        );
        assert.equal(
          await restarted.call("evaluate", tab, {
            script: "return localStorage.getItem('account');",
          }),
          "a",
        );
      } finally {
        for (const engine of engines) {
          if (engine.process.exitCode === null && engine.process.signalCode === null) {
            await closeEngine(engine);
          }
        }
      }
    });
  } finally {
    await server.stop();
  }
  console.log(
    "PASS: independent views/references, input, concurrency, takeover, profile isolation and restart persistence",
  );
}

if (import.meta.main) {
  await cli(run);
}
