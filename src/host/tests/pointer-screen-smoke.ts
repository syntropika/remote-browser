import { PAGE, FRAME, NESTED } from "./fixtures/pointer-screen-smoke.js";
import { cli } from "./harness.js";
import { pointerFixture, assert, wait } from "./pointer-fixture.js";

export async function run(binary: string) {
  await pointerFixture(
    binary,
    { "/": PAGE, "/frame": FRAME, "/nested": NESTED },
    async ({ evaluate, click }) => {
      await wait(() => evaluate("return window.ready;"));
      for (const [index, [x, y, cx, cy]] of [
        [50, 60, 34, 36],
        [50, 60, 34, 36],
        [266, 174, 20, 20],
      ].entries()) {
        await evaluate("window.trace=[];return true;");
        await click(x, y);
        const trace = await evaluate("return window.trace;");
        assert(trace.some((event: any) => event.type === "click"));
        if (index === 1) {
          assert(trace.some((event: any) => event.type === "dblclick"));
        }
        for (const event of trace) {
          assert(event.trusted);
          assert.deepEqual([event.x, event.y], [cx, cy]);
          assert.deepEqual([event.sx, event.sy], [x, y]);
        }
      }
      assert.deepEqual(
        await evaluate(
          "const e=new MouseEvent('click',{screenX:17,screenY:29,clientX:3,clientY:4});return [e.screenX,e.screenY,e.clientX,e.clientY,e.isTrusted];",
        ),
        [17, 29, 3, 4, false],
      );
    },
  );
  console.log("PASS: screen/client coordinates across nested transformed scrolled frames");
}

if (import.meta.main) {
  await cli(run);
}
