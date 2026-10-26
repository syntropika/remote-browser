import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import filePath from "node:path";

import { cli, assert, Http, INIT, Runtime, temporary, privateFile } from "./harness.js";

const { join } = filePath;
export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  await temporary(async (root) => {
    const seed = "synthetic-existing-integration-secret";
    const registry = join(root, "browser/api-keys.json");
    const token = join(root, "seed");
    await privateFile(token, seed);
    await privateFile(
      registry,
      JSON.stringify({
        version: 1,
        keys: [
          {
            id: "ab".repeat(16),
            name: "Existing integration",
            prefix: "legacy",
            legacy: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: null,
            hash: createHash("sha256").update(seed).digest("hex"),
          },
        ],
      }),
    );
    const start = () =>
      Runtime.launch(host, engine, join(root, "browser"), {
        args: ["--mcp-http-token-file", token],
      });
    let runtime = await start();
    let secret = "";
    try {
      const owner = runtime.dashboard;
      assert.equal((await owner.api("/api/keys")).data.keys[0].id, "ab".repeat(16));
      await owner.api("/api/keys", { name: "No origin" }, 403, false);
      await owner.api("/api/keys", { name: "Wrong origin" }, 403, "https://foreign.example");
      await owner.api("/api/keys", { name: "bad\u200Bname" }, 400);
      const created = (await owner.api("/api/keys", { name: " Work laptop " }, 201)).data;
      ({ secret } = created);
      const { id } = created.key;
      assert.equal(created.key.name, "Work laptop");
      const active = new Http(runtime.url, secret);
      await active.request("initialize", INIT);
      assert.equal((await active.request("tools/list", {})).result.tools.length, 29);
      const profile = (await owner.api("/api/profiles", { name: "Restricted profile" })).data.id;
      const limited = (
        await owner.api("/api/keys", { name: "Restricted key", profileIds: [profile] }, 201)
      ).data;
      const scoped = new Http(runtime.url, limited.secret);
      await scoped.request("initialize", INIT);
      assert.deepEqual(
        (
          await scoped.call("browser_profiles", {
            action: "list",
          })
        ).profiles.map((p: any) => p.id),
        [profile],
      );
      await scoped.call(
        "browser_tabs",
        {
          action: "list",
          profileId: "default",
        },
        true,
      );
      await scoped.call(
        "browser_profiles",
        {
          action: "create",
          name: "Denied",
        },
        true,
      );
      await owner.api("/api/login/key", { secret: limited.secret }, 401);
      const tab = await runtime.dashboard.action("open", null, {}, profile);
      const lease = (
        await scoped.call("browser_tabs", {
          action: "reserve",
          profileId: profile,
          tabId: tab,
          agentName: "Agent one",
          task: "limited client",
        })
      ).leaseId;
      const args = { leaseId: lease };
      await active.call(
        "browser_evaluate",
        {
          ...args,
          function: "() => {\nreturn 42;\n}",
        },
        true,
      );
      for (const action of ["close", "release"]) {
        await active.call(
          "browser_tabs",
          {
            ...args,
            action,
          },
          true,
        );
      }
      assert.equal(
        (
          await scoped.call("browser_evaluate", {
            ...args,
            function: "() => {\nreturn 42;\n}",
          })
        ).value,
        42,
      );
      const second = await runtime.dashboard.action("open", null, {}, profile);
      const lease2 = (
        await scoped.call("browser_tabs", {
          action: "reserve",
          profileId: profile,
          tabId: second,
          agentName: "Agent two",
          task: "second task",
        })
      ).leaseId;
      await scoped.call(
        "browser_evaluate",
        {
          ...args,
          tabId: second,
          function: "() => {\nreturn 9;\n}",
        },
        true,
      );
      assert.equal(
        (
          await scoped.call("browser_evaluate", {
            ...args,
            leaseId: lease2,
            function: "() => {\nreturn 9;\n}",
          })
        ).value,
        9,
      );
      const { tabs } = await scoped.call("browser_tabs", {
        action: "list",
        profileId: profile,
      });
      assert.equal(tabs.find((t: any) => t.id === tab).reservation.agentName, "Agent one");
      assert.equal(tabs.find((t: any) => t.id === second).reservation.agentName, "Agent two");
      await scoped.call(
        "browser_tabs",
        {
          profileId: profile,
          tabId: tab,
          action: "reserve",
          agentName: "Agent two",
          task: "conflict",
        },
        true,
      );
      await owner.api("/api/keys/permissions", { id: limited.key.id, profileIds: ["default"] });
      await scoped.call(
        "browser_tabs",
        {
          action: "list",
          profileId: profile,
        },
        true,
      );
      for (const profileIds of [[], ["default", profile], ["missing"]]) {
        await owner.api("/api/keys/permissions", { id: limited.key.id, profileIds }, 400);
      }
      await owner.api("/api/keys", { name: "Two sessions", profileIds: ["default", profile] }, 400);
      await owner.api("/api/keys/revoke", { id: limited.key.id });
      await scoped.request("tools/list", {}, 401);
      const listing = (await owner.api("/api/keys")).data;
      assert(
        !JSON.stringify(listing).includes(secret) && !JSON.stringify(listing).includes("hash"),
      );
      assert(listing.keys.find((k: any) => k.id === id).lastUsedAt);
      assert(!(await readFile(registry, "utf-8")).includes(secret));
      await owner.api("/api/keys/revoke", { id });
      await active.request("tools/list", {}, 401);
      await owner.api("/api/keys/revoke", { id: "ab".repeat(16) });
      await new Http(runtime.url, seed).request("tools/list", {}, 401);
      assert.deepEqual((await owner.api("/api/keys")).data.keys, []);
    } finally {
      await runtime.stop();
    }
    assert(!runtime.logs.join("\n").includes(seed) && !runtime.logs.join("\n").includes(secret));
    runtime = await start();
    try {
      assert.deepEqual((await runtime.dashboard.api("/api/keys")).data.keys, []);
      for (const value of [seed, secret]) {
        await new Http(runtime.url, value).request("initialize", INIT, 401);
      }
      await writeFile(registry, "{}");
      await new Http(runtime.url, seed).request("initialize", INIT, 503);
      await runtime.dashboard.api("/api/keys", undefined, 503);
    } finally {
      await runtime.stop();
    }
  });
  console.log(
    "PASS: compatible registry, origin guards, one-time scoped keys, lease identity, revocation/restart and fail-closed corruption",
  );
}
if (import.meta.main) {
  await cli(run);
}
