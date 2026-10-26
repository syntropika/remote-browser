import { RECORDER } from "./fixtures/pointer-cancel-smoke.js";
import { cli } from "./harness.js";
import type { Wire } from "./harness.js";
import { pointerFixture, assert, sleep } from "./pointer-fixture.js";

const frame = `<!doctype html><style>html,body{margin:0;height:100%}button{display:block;width:100%;height:100%}</style><button id="control">Framed control</button><script>${RECORDER}setInterval(()=>parent.postMessage({frame:snapshot()},'*'),20);</script>`;

const page = (origin: string) =>
  `<!doctype html><style>html,body{margin:0;width:100vw;height:100vh}#control{position:absolute;left:50px;top:50px;width:200px;height:200px}iframe{position:absolute;left:400px;top:100px;width:300px;height:200px;border:0}</style><button id="control" data-capture="1">Local control</button><iframe src="${origin.replace("127.0.0.1", "localhost")}/frame"></iframe><script>${RECORDER}let frame=null;onmessage=e=>{if(e.data.frame)frame=e.data.frame};window.state=()=>({top:snapshot(),frame});</script>`;

export async function run(binary: string) {
  await pointerFixture(
    binary,
    { "/": page, "/frame": frame },
    async ({ engine, tab, human, origin }) => {
      const state = async (ready: (value: Wire) => boolean, lease?: string): Promise<Wire> => {
        const until = performance.now() + 5000;
        for (;;) {
          const value = await engine.call(
            "evaluate",
            tab,
            { script: "return window.state();" },
            { lease },
          );
          if (ready(value) || performance.now() > until) {
            return value;
          }
          await sleep(50);
        }
      };
      const press = async (x: number, y: number) => {
        await human("move", x, y);
        await human("down", x, y);
      };
      const phases = {
        async captured() {
          await press(100, 100);
          await sleep(100);
          await human("cancel");
          let s = (await state((v) => v.top.log.includes("pointerleave"))).top;
          assert.deepEqual(s.log, [
            "pointerdown:1",
            "pointercancel",
            "lostpointercapture",
            "pointerleave",
          ]);
          assert(!s.active && !s.captured);
          await press(110, 110);
          await human("up", 110, 110);
          s = (await state((v) => v.top.log.some((x: string) => x.startsWith("click")))).top;
          assert.equal(s.moveButtons, 0);
          assert.deepEqual(s.log.slice(4), [
            "pointerdown:1",
            "pointerup",
            "lostpointercapture",
            "mouseup",
            "click:1",
          ]);
          assert(!s.active && !s.captured);
        },
        async framed() {
          await press(550, 200);
          await human("move", 300, 400);
          await human("cancel");
          let s = await state((v) => v.frame?.log.includes("pointercancel"));
          assert.equal(s.frame.log[0], "pointerdown:1");
          assert.equal(s.frame.log.filter((v: string) => v === "pointercancel").length, 1);
          assert(
            !s.frame.log.some(
              (v: string) => ["pointerup", "mouseup"].includes(v) || v.startsWith("click"),
            ),
          );
          assert(!s.frame.active && !s.top.log.includes("pointercancel"));
          await press(560, 210);
          await human("up", 560, 210);
          s = await state((v) => v.frame.log.some((x: string) => x.startsWith("click")));
          assert.equal(s.frame.log.filter((x: string) => x === "pointerdown:1").length, 2);
          assert.deepEqual(s.frame.log.slice(-2), ["mouseup", "click:1"]);
          assert.equal(s.frame.log.filter((x: string) => x === "pointercancel").length, 1);
        },
        async reserved() {
          await press(100, 100);
          const lease = (await engine.call("reserve", tab, { task: "local fixture agent" }))
            .leaseId;
          await human("up", 100, 100, true);
          let s = (await state((v) => v.top.log.includes("lostpointercapture"), lease)).top;
          await engine.call("release", tab, {}, { lease });
          assert.deepEqual(s.log.slice(0, 3), [
            "pointerdown:1",
            "pointercancel",
            "lostpointercapture",
          ]);
          assert(
            !s.log.some(
              (v: string) => ["pointerup", "mouseup"].includes(v) || v.startsWith("click"),
            ),
          );
          assert(!s.active && !s.captured);
          await press(110, 110);
          await human("up", 110, 110);
          s = (await state((v) => v.top.log.some((x: string) => x.startsWith("click")))).top;
          assert.equal(s.log.filter((x: string) => x === "pointerdown:1").length, 2);
          assert.equal(s.log.at(-1), "click:1");
        },
        async idle() {
          await press(100, 100);
          await human("up", 100, 100);
          await human("cancel");
          const s = (await state((v) => v.top.log.includes("pointerleave"))).top;
          assert(!s.log.includes("pointercancel"));
          assert.equal(s.log.at(-1), "pointerleave");
          assert.equal(s.log.filter((x: string) => x === "click:1").length, 1);
        },
      };
      const errors: string[] = [];
      for (const [name, phase] of Object.entries(phases)) {
        await engine.call("navigate", tab, { url: origin });
        await state((v) => v.frame !== null);
        try {
          await phase();
          console.log(`PASS: ${name}`);
        } catch (cause) {
          errors.push(`${name}: ${String(cause)}`);
        }
      }
      assert.deepEqual(errors, []);
    },
  );
  console.log(
    "PASS: cancellation clears capture/button state without release/click, including cross-site and reserved presses",
  );
}

if (import.meta.main) {
  await cli(run);
}
