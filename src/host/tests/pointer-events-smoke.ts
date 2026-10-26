import { PAGE, FRAME } from "./fixtures/pointer-events-smoke.js";
import { cli } from "./harness.js";
import { pointerFixture, assert, wait } from "./pointer-fixture.js";

export async function run(binary: string) {
  await pointerFixture(binary, { "/": PAGE, "/frame": FRAME }, async ({ evaluate, click }) => {
    await wait(() => evaluate("return window.ready;"));
    const traceClick = async (x: number, y: number, terminal = "click") => {
      const before = await evaluate("return window.result?.trace.length ?? 0;");
      await click(x, y);
      return wait(
        () => evaluate("return window.result?.trace;"),
        (trace) => trace?.slice(before).some((event: any) => event.type === terminal),
      );
    };
    let trace = await traceClick(50, 60);
    const types = trace.filter((e: any) => e.target === "a").map((e: any) => e.type);
    assert(types.includes("pointerenter") && types.includes("mouseenter"));
    assert(types.indexOf("pointerenter") < types.indexOf("pointerdown"));
    assert.deepEqual(
      trace.filter((e: any) => e.type === "pointerenter").map((e: any) => e.target),
      ["parent", "a"],
    );
    const event = trace.find((e: any) => e.type === "click");
    assert(
      event.pointerClass &&
        event.mouseClass &&
        event.trusted &&
        event.active &&
        event.composed &&
        event.viewIsWindow,
    );
    assert.equal(event.pointerType, "mouse");
    assert.deepEqual(
      [
        event.button,
        event.buttons,
        event.detail,
        event.clientX,
        event.clientY,
        event.isPrimary,
        event.pressure,
      ],
      [0, 0, 1, 34, 36, false, 0],
    );
    assert.equal(event.pointerId, trace.find((e: any) => e.type === "pointerup").pointerId);
    trace = await traceClick(50, 60, "dblclick");
    const doubles = trace.filter((e: any) => e.type === "dblclick");
    assert.equal(doubles.length, 1);
    assert.equal(doubles[0].detail, 2);
    assert(doubles[0].mouseClass && !doubles[0].pointerClass);
    trace = await traceClick(250, 60);
    for (const type of ["pointerenter", "mouseenter"]) {
      assert.equal(trace.filter((e: any) => e.type === type && e.target === "parent").length, 1);
      assert(trace.some((e: any) => e.type === type && e.target === "b"));
    }
    for (const type of ["pointerleave", "mouseleave"]) {
      assert(trace.some((e: any) => e.type === type && e.target === "a"));
    }
    const point = await evaluate(
      "const r=document.querySelector('iframe').contentWindow.document.querySelector('#check').getBoundingClientRect();return {x:16+r.x+r.width/2,y:24+r.y+r.height/2};",
    );
    const checked =
      "return document.querySelector('iframe').contentWindow.document.querySelector('#check').checked;";
    await click(point.x, point.y);
    assert.equal(await evaluate(checked), true);
    await evaluate("document.querySelector('iframe').contentWindow.preventCheck=true;return true;");
    await click(point.x, point.y);
    assert.equal(await evaluate(checked), true);
    trace = await traceClick(700, 500, "mouseleave");
    for (const type of ["pointerleave", "mouseleave"]) {
      assert.equal(trace.filter((e: any) => e.type === type && e.target === "parent").length, 1);
    }
  });
  console.log(
    "PASS: native hover boundaries, trusted click interfaces, double clicks and canceled defaults",
  );
}

if (import.meta.main) {
  await cli(run);
}
