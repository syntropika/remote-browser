import { PAGE } from "./fixtures/pointer-fidelity-smoke.js";
import { cli } from "./harness.js";
import { pointerFixture, assert, sleep } from "./pointer-fixture.js";

export async function run(binary: string) {
  await pointerFixture(binary, { "/": PAGE }, async ({ engine, tab, human, evaluate }) => {
    await sleep(1500);
    await engine.call("take", tab, {}, { human: true });
    for (const [kind, x, y] of [
      ["move", 100, 70],
      ["move", 110, 78],
      ["down", 110, 78],
      ["up", 110, 78],
    ] as const) {
      await human(kind, x, y);
      await sleep(100);
    }
    await sleep(400);
    await engine.call("return", tab, {}, { human: true });
    const events = await evaluate("return measure();");
    const of = (type: string) => events.filter((event: any) => event.type === type);
    for (const name of ["pointermove", "pointerdown", "pointerup", "click"]) {
      assert(of(name).length);
    }
    assert(events.every((event: any) => event.isTrusted));
    assert.equal(of("pointermove")[0].offsetX, 58);
    assert.equal(of("pointermove")[0].offsetY, 8);
    for (const name of ["pointerdown", "pointerup", "click"]) {
      for (const event of of(name)) {
        assert.equal(event.offsetX, 68);
        assert.equal(event.offsetY, 16);
        assert.equal(event.movementX, 0);
        assert.equal(event.movementY, 0);
      }
    }
    assert(of("pointermove").some((event: any) => event.movementX === 10 && event.movementY === 8));
    for (const name of ["pointerdown", "pointerup"]) {
      for (const event of of(name)) {
        assert.equal(event.detail, 0);
        assert.equal(event.coalesced, 0);
      }
    }
    assert(of("click").every((event: any) => event.detail === 1));
    assert(of("pointermove").every((event: any) => event.coalesced === 1));
  });
  console.log("PASS: native offsets, motion deltas, click counts and coalesced events");
}

if (import.meta.main) {
  await cli(run);
}
