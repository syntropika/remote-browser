import filePath from "node:path";

import { cli, assert, Browser, Runtime, temporary } from "./harness.js";

const { join } = filePath;

export { Browser } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  await temporary(async (root) => {
    let runtime = await Runtime.launch(host, engine, root);
    let secret = "";
    try {
      const origin = runtime.url;
      assert(!origin.includes("#"));
      assert((await (await fetch(origin)).text()).includes('src="app.js"'));
      const bundle = await (await fetch(`${origin}/app.js`)).text();
      assert.equal(bundle.split("Authorization").length - 1, 1);
      assert(bundle.includes("Authorization: Bearer <API_KEY>"));
      for (const path of ["/api/login", "/api/auth", "/api/logout"]) {
        assert(!bundle.includes(path));
      }
      const browser = new Browser(origin);
      assert.equal((await browser.api("/api/access/status")).data.required, false);
      assert((await browser.api("/api/profiles")).data.profiles.length);
      await browser.action("files");
      ({ secret } = (
        await browser.api("/api/keys", { name: "Access smoke", profileIds: ["default"] }, 201)
      ).data);
      assert((await browser.api("/api/keys")).data.keys.length);
      await browser.api(
        "/api/action",
        { profileId: "default", op: "files", args: {} },
        403,
        "https://foreign.example",
      );
      await browser.api("/api/keys", { name: "From a page" }, 403, "https://foreign.example");
      await browser.api("/api/action", { profileId: "default", op: "files", args: {} }, 200, false);
      await browser.api(
        "/api/keys",
        { name: "Two sessions", profileIds: ["default", "default"] },
        400,
      );
      const every = (await browser.api("/api/keys", { name: "Every session" }, 201)).data;
      assert.equal(every.key.profileIds, null);
      await browser.api("/api/keys/permissions", { id: every.key.id, profileIds: ["default"] });
      await browser.api("/api/keys/permissions", { id: every.key.id, profileIds: null });
    } finally {
      await runtime.stop();
    }
    assert(!runtime.logs.join("\n").includes(secret));
    assert(!(await Bun.file(join(root, "dashboard-account.json")).exists()));
    runtime = await Runtime.launch(host, engine, root);
    try {
      assert((await runtime.dashboard.api("/api/profiles")).data.profiles.length);
      assert.equal((await runtime.dashboard.api("/api/keys")).data.keys.length, 2);
    } finally {
      await runtime.stop();
    }
  });
  console.log(
    "PASS: open local dashboard, foreign-origin rejection, no account and persistent MCP keys",
  );
}

if (import.meta.main) {
  await cli(run);
}
