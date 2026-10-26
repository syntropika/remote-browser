import { LABELS } from "./fixtures/label-activation-smoke.js";
import { cli } from "./harness.js";
import type { Wire } from "./harness.js";
import { pointerFixture, assert, sleep, wait } from "./pointer-fixture.js";

function native(log: Wire, point: Wire) {
  assert.deepEqual(
    log.map((e: Wire) => [e.type, e.target]),
    [
      ["click", "text"],
      ["focus", "box"],
      ["click", "box"],
      ["input", "box"],
      ["change", "box"],
    ],
  );
  const a = log[0];
  const b = log[2];
  assert(a.trusted && b.trusted && b.pointer);
  assert.equal(b.pointerType, "mouse");
  assert.equal(a.pointerType, b.pointerType);
  assert.equal(a.pointerId, b.pointerId);
  for (const key of ["clientX", "clientY", "detail"]) {
    assert.equal(a[key], b[key]);
  }
  assert.deepEqual([b.clientX, b.clientY], [Math.trunc(point.x), Math.trunc(point.y)]);
  assert(b.active === "box" && b.checked && log[3].trusted && log[4].trusted);
}

export async function run(binary: string) {
  await pointerFixture(
    binary,
    {
      "/": `<!doctype html>${LABELS}`,
      "/labels": `<!doctype html>${LABELS}`,
      "/framed": (origin) =>
        `<!doctype html><style>body{margin:0}iframe{position:absolute;left:40px;top:30px;width:500px;height:300px;border:0}</style><script>window.frameLog=[];window.frameReady=false;onmessage=e=>{if(e.data.ready)frameReady=true;if(e.data.log)frameLog=e.data.log};</script><iframe src="${origin.replace("127.0.0.1", "localhost")}/labels"></iframe>`,
    },
    async ({ engine, tab, evaluate, click, origin }) => {
      const press = async (point: Wire) => {
        await click(point.x, point.y);
        await sleep(300);
      };
      const point = await evaluate("return centre('text');");
      await press(point);
      native(await evaluate("return log;"), point);
      await evaluate("return reset();");
      let log = await evaluate("document.getElementById('lab').click();return log;");
      assert.deepEqual(
        log.map((e: Wire) => [e.type, e.target]),
        [
          ["click", "lab"],
          ["focus", "box"],
          ["click", "box"],
          ["input", "box"],
          ["change", "box"],
        ],
      );
      assert(!log[0].trusted && !log[2].trusted);
      assert.deepEqual(
        [log[2].clientX, log[2].clientY, log[2].detail, log[2].pointerId, log[2].pointerType],
        [0, 0, 0, -1, ""],
      );
      assert(log[2].active === "box" && log[2].checked);
      await evaluate("return reset();");
      await press(await evaluate("return centre('box');"));
      log = await evaluate("return log;");
      const clicks = log.filter((e: Wire) => e.type === "click");
      assert.equal(clicks.length, 1);
      assert(clicks[0].target === "box" && clicks[0].trusted && log.at(-1).checked);
      await evaluate("return reset();");
      await press(await evaluate("return centre('text2');"));
      assert.deepEqual(
        (await evaluate("return log;")).map((e: Wire) => [e.type, e.target]),
        [["click", "text2"]],
      );
      assert.equal(await evaluate("return document.activeElement.tagName;"), "BODY");
      await engine.call("navigate", tab, { url: `${origin}/framed` });
      await wait(() => evaluate("return window.frameReady;"));
      await press({ x: point.x + 40, y: point.y + 30 });
      native(await evaluate("return window.frameLog;"), point);
    },
  );
  console.log(
    "PASS: trusted native label forwarding/focus, untrusted script clicks, disabled/direct controls and cross-site labels",
  );
}

if (import.meta.main) {
  await cli(run);
}
