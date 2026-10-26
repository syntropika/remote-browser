import { readFile } from "node:fs/promises";

import { cli, withEngine, serve, assert, deadline, wait } from "./harness.js";

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
      '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{background:#204080}</style><title>Live viewport</title>',
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
      await engine.call(
        "resize",
        tab,
        {
          width: 390,
          height: 720,
          screenWidth: 390,
          screenHeight: 844,
          deviceScaleFactor: 3,
          mobile: true,
        },
        { human: true },
      );
      const phone = await engine.call("evaluate", tab, {
        script:
          "return {width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,ratio:devicePixelRatio,webdriver:navigator.webdriver,mobile:navigator.userAgentData.mobile,touch:navigator.maxTouchPoints > 0};",
      });
      assert.deepEqual(phone, {
        width: 390,
        height: 720,
        screenWidth: 390,
        screenHeight: 844,
        ratio: 3,
        webdriver: false,
        mobile: false,
        touch: true,
      });
      const phoneFrame = await wait(
        () => engine.call("screenshot", tab, { since: 0 }, { human: true }),
        (frame) => frame.surfaceWidth === 1170 && frame.surfaceHeight === 2160,
      );
      const phonePng = Buffer.from(phoneFrame.image, "base64");
      assert.deepEqual([phonePng.readUInt32BE(16), phonePng.readUInt32BE(20)], [1170, 2160]);
      assert.deepEqual([phoneFrame.viewWidth, phoneFrame.viewHeight], [390, 720]);
      assert.deepEqual([phoneFrame.surfaceWidth, phoneFrame.surfaceHeight], [1170, 2160]);
      await engine.call("evaluate", tab, {
        script: "document.body.style.height='10000px'; return true;",
      });
      const oversized = await engine.call(
        "agent_screenshot",
        tab,
        {},
        { human: true, error: true },
      );
      assert.match(oversized, /Full-page capture exceeds/u);
      await engine.call("evaluate", tab, { script: "document.body.style.height=''; return true;" });
      const opened = await engine.call("open", null, {}, { human: true });
      await engine.call("navigate", opened, { url: server.origin });
      assert.equal(
        await engine.call("evaluate", opened, {
          script:
            "return !navigator.userAgent.includes('Mobile') && !navigator.userAgentData.mobile && devicePixelRatio === 3;",
        }),
        true,
      );
      await engine.call(
        "resize",
        tab,
        {
          width: 844,
          height: 292,
          screenWidth: 844,
          screenHeight: 390,
          deviceScaleFactor: 3,
          mobile: true,
        },
        { human: true },
      );
      assert.deepEqual(
        await engine.call("evaluate", tab, {
          script:
            "return {width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,angle:screen.orientation.angle,mobile:navigator.userAgentData.mobile};",
        }),
        { width: 844, height: 292, screenWidth: 844, screenHeight: 390, angle: 90, mobile: false },
      );
      await engine.call(
        "resize",
        tab,
        {
          width: 1280,
          height: 800,
          screenWidth: 1440,
          screenHeight: 900,
          deviceScaleFactor: 1,
          mobile: false,
        },
        { human: true },
      );
      for (const target of [tab]) {
        const desktop = await engine.call("evaluate", target, {
          script:
            "return {width:innerWidth,screenWidth:screen.width,ratio:devicePixelRatio,mobile:navigator.userAgentData.mobile,touch:navigator.maxTouchPoints};",
        });
        assert.deepEqual(desktop, {
          width: 1280,
          screenWidth: 1440,
          ratio: 1,
          mobile: false,
          touch: 0,
        });
      }
      assert.deepEqual(
        await engine.call("evaluate", opened, {
          script:
            "return {width:innerWidth,ratio:devicePixelRatio,touch:navigator.maxTouchPoints>0};",
        }),
        { width: 390, ratio: 3, touch: true },
        "A resize must leave other tabs unchanged",
      );
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
