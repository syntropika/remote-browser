/** Independent optional MCP and browser-login acceptance with the real engine. */
import { readFile, stat } from "node:fs/promises";
import filePath from "node:path";

import { assert, Browser, Http, INIT, Runtime, cli, temporary } from "./harness.js";

const { join } = filePath;

const login = { username: "test-owner", password: "synthetic-browser-login-only" };

export async function run(engine: string, host: string) {
  assert(host, "Pass --host-binary or REMOTE_BROWSER_HOST_BINARY");
  await temporary(async (root) => {
    let runtime = await Runtime.launch(host, engine, root, { stdio: false });
    let key: any;
    let secret = "";
    try {
      const owner = runtime.dashboard;
      const entries = (await owner.api("/api/extensions/native")).data.extensions;
      assert.deepEqual(entries.map((item: any) => item.id).toSorted(), ["access", "mcp"]);
      assert(entries.every((item: any) => !item.installed));
      assert(!(await Bun.file(join(root, "api-keys.json")).exists()));
      await owner.api("/api/keys", undefined, 409);
      for (const origin of [false, "https://foreign.example"]) {
        await owner.api("/api/extensions/native", { id: "mcp", action: "install" }, 403, origin);
      }
      await owner.change("missing", "install", 409);
      await new Http(runtime.url, "absent").request("initialize", INIT, 503);
      assert((await owner.api("/api/profiles")).data.profiles.length);
      assert((await owner.change("mcp", "install")).enabled);
      key = (await owner.api("/api/keys", { name: "Test agent" }, 201)).data;
      ({ secret } = key);
      const agent = new Http(runtime.url, secret);
      await agent.request("initialize", INIT);
      assert(
        (await agent.request("tools/list", {})).result.tools.some(
          (tool: any) => tool.name === "browser_navigate",
        ),
      );
      const tab = (await agent.call("browser_tabs", { action: "open" })).tabId;
      const lease = (
        await agent.call("browser_tabs", {
          action: "reserve",
          tabId: tab,
          agentName: "Test agent",
          task: "native extension acceptance",
        })
      ).leaseId;
      assert.equal(
        (await agent.call("browser_evaluate", { tabId: tab, leaseId: lease, script: "return 42;" }))
          .value,
        42,
      );
      const access = await owner.change("access", "install");
      assert(access.installed && !access.enabled);
      await owner.change("access", "enable", 409);
      const configured = await owner.api("/api/extensions/access/configure", login);
      assert(configured.data.enabled && configured.data.configured);
      assert(
        configured.headers.get("set-cookie").includes("HttpOnly") &&
          configured.headers.get("set-cookie").includes("SameSite=Strict"),
      );
      const stored = await readFile(join(root, "access-extension.json"), "utf-8");
      assert(!stored.includes(login.password) && stored.includes("$argon2id$"));
      assert.equal((await stat(join(root, "access-extension.json"))).mode & 0o077, 0);
      const visitor = new Browser(runtime.url);
      assert((await visitor.api("/api/access/status")).data.required);
      for (const path of ["/api/profiles", "/api/extensions/native", "/api/keys"]) {
        await visitor.api(path, undefined, 401);
      }
      for (const origin of [false, "https://foreign.example"]) {
        await visitor.api("/api/access/login", login, 403, origin);
      }
      await visitor.api("/api/access/login", { ...login, password: "incorrect" }, 401);
      await visitor.api("/api/access/login", login);
      assert((await visitor.api("/api/profiles")).data.profiles.length);
      await visitor.api("/api/access/logout", {});
      await visitor.api("/api/profiles", undefined, 401);
      assert((await agent.call("browser_profiles", { action: "list" })).profiles.length);
      await owner.change("mcp", "disable");
      await agent.request("tools/list", {}, 503);
      assert(
        (await owner.api("/api/profiles")).data.profiles.length &&
          (await owner.api("/api/access/status")).data.required &&
          (await owner.api("/api/keys")).data.keys.length,
      );
    } finally {
      await runtime.stop();
    }
    assert(
      !runtime.logs.join("\n").includes(secret) &&
        !runtime.logs.join("\n").includes(login.password),
    );
    runtime = await Runtime.launch(host, engine, root, { stdio: false });
    try {
      const owner = runtime.dashboard;
      await owner.api("/api/profiles", undefined, 401);
      await owner.api("/api/access/login", login);
      const states = (await owner.api("/api/extensions/native")).data.extensions;
      assert(
        states.find((item: any) => item.id === "access").enabled &&
          !states.find((item: any) => item.id === "mcp").enabled,
      );
      await owner.change("mcp", "enable");
      const agent = new Http(runtime.url, secret);
      await agent.request("initialize", INIT);
      await owner.api("/api/keys/revoke", { id: key.key.id });
      await agent.request("tools/list", {}, 401);
      await owner.change("access", "disable");
      assert((await new Browser(runtime.url).api("/api/profiles")).data.profiles.length);
      await owner.change("mcp", "uninstall", 400);
      assert(!(await owner.change("mcp", "uninstall", 200, { confirmed: true })).installed);
      await owner.api("/api/keys", undefined, 409);
      await agent.request("tools/list", {}, 503);
      await owner.change("mcp", "install");
      await agent.request("initialize", INIT, 401);
      await owner.change("access", "uninstall", 200, { confirmed: true });
      assert(!(await owner.api("/api/access/status")).data.required);
      assert(!(await owner.change("access", "install")).enabled);
      assert(await owner.action("tabs"));
    } finally {
      await runtime.stop();
    }
  });
  console.log(
    "PASS: independent native modules, real MCP automation, browser login, private hashes/cookies, restart persistence, confirmed uninstall and retained revocations",
  );
}

if (import.meta.main) {
  await cli(run);
}
