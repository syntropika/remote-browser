import { readFile } from "node:fs/promises";

import { cli, withEngine, serve, assert, deadline } from "./harness.js";

export async function run(binary: string) {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const server = serve(async (request) => {
    if (new URL(request.url).pathname === "/pending") {
      started();
      await pending;
    }
    return new Response(
      "<!doctype html><style>body{background:#204080}</style><title>Live viewport</title>",
      { headers: { "Content-Type": "text/html" } },
    );
  });
  try {
    await withEngine(binary, async (engine) => {
      const tab = (await engine.call("tabs"))[0].id;
      await engine.call("navigate", tab, { url: server.origin });
      const geometry = await engine.call("evaluate", tab, {
        script:
          "return {width:screen.width,height:screen.height,availableWidth:screen.availWidth,availableHeight:screen.availHeight,outerWidth,outerHeight,innerWidth,innerHeight,ratio:devicePixelRatio};",
      });
      for (const key of ["width", "height"]) {
        assert(geometry[key] > 0);
        for (const name of ["available", "outer", "inner"]) {
          assert.equal(geometry[key], geometry[name + key[0].toUpperCase() + key.slice(1)]);
        }
      }
      await engine.call("evaluate", tab, {
        script:
          "const frame=document.createElement('iframe');frame.src='/pending';document.body.appendChild(frame);return true;",
      });
      await deadline(began, 3000);
      const begin = performance.now();
      const png = Buffer.from(await engine.call("screenshot", tab, {}, { human: true }), "base64");
      assert(performance.now() - begin < 3000);
      assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.deepEqual(
        [png.readUInt32BE(16), png.readUInt32BE(20)],
        [geometry.width * geometry.ratio, geometry.height * geometry.ratio],
      );
      const saved = await engine.call(
        "save_screenshot",
        tab,
        { name: "Loading.png" },
        { human: true },
      );
      assert.equal(saved.id, "captures/Loading.png");
      assert.deepEqual((await readFile(saved.path)).subarray(0, 8), png.subarray(0, 8));
      assert(!(await engine.call("status")).uncertain);
      assert.equal(await engine.call("evaluate", tab, { script: "return 42;" }), 42);
      release();
    });
  } finally {
    release();
    await server.stop();
  }
  console.log("PASS: screen geometry and live/saved captures while iframe loads");
}

if (import.meta.main) {
  await cli(run);
}
