import { test } from "bun:test";
import { writeFile } from "node:fs/promises";
import filePath from "node:path";

import { assert, Browser, Engine, Rpc, temporary } from "../src/host/tests/harness.js";

const { join } = filePath;
const child = `import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(r.op==='shutdown'){console.log(JSON.stringify({id:r.id,value:true}));break;}
 if(r.op==='invalid'){console.log('invalid json');continue;}
 if(r.op==='error'){console.log(JSON.stringify({id:r.id,error:'expected refusal'}));continue;}
 setTimeout(()=>console.log(JSON.stringify({id:r.id,value:r.args})),r.op==='slow'?30:0);
}`;

test("native IPC preserves falsy values, errors and concurrent response identity", async () => {
  await temporary(async (root) => {
    const binary = join(root, "fixture");
    await writeFile(binary, `#!${process.execPath}\n${child}`, { mode: 0o700 });
    const engine = new Engine(binary, join(root, "profile"));
    try {
      assert.equal(await engine.call("value", null, false), false);
      assert.equal(await engine.call("value", null, 0), 0);
      assert.equal(await engine.call("value", null, null), null);
      assert.equal(await engine.call("error", null, {}, { error: true }), "expected refusal");
      const slow = engine.call("slow", null, { response: "slow" });
      const fast = engine.call("fast", null, { response: "fast" });
      assert.deepEqual(await fast, { response: "fast" });
      assert.deepEqual(await slow, { response: "slow" });
    } finally {
      await engine.stop();
    }
  });
});

test("invalid stdout fails the pending operation without leaking a child", async () => {
  await temporary(async (root) => {
    const binary = join(root, "fixture.ts");
    await writeFile(binary, child);
    const rpc = new Rpc([process.execPath, binary]);
    try {
      await assert.rejects(rpc.send({ op: "invalid" }), /Invalid stdout/u);
    } finally {
      await rpc.exit();
    }
  });
});

test("dashboard HTTP fixture preserves status, exact Origin and login cookies", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      if (request.method === "POST") {
        assert.equal(request.headers.get("origin"), server.url.origin);
        return Response.json(
          { saved: true },
          { headers: { "set-cookie": "fixture=synthetic; HttpOnly; SameSite=Strict" } },
        );
      }
      return Response.json({ cookie: request.headers.get("cookie") }, { status: 409 });
    },
  });
  try {
    const browser = new Browser(server.url.origin);
    assert((await browser.api("/login", {})).data.saved);
    assert.equal((await browser.api("/state", undefined, 409)).data.cookie, "fixture=synthetic");
  } finally {
    await server.stop(true);
  }
});
