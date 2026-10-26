import { PAGE } from "./fixtures/webgl-smoke.js";
import { cli } from "./harness.js";
import { pointerFixture, assert } from "./pointer-fixture.js";

export async function run(binary: string) {
  await pointerFixture(binary, { "/": PAGE }, async ({ evaluate }) => {
    const result = await evaluate("return window.result;");
    assert(result.available && result.context && result.done, JSON.stringify(result));
    assert.equal(result.error, 0);
    assert.equal(result.pixel.length, 4);
    for (const [index, expected] of [32, 64, 128, 255].entries()) {
      assert(Math.abs(result.pixel[index] - expected) <= 1);
    }
  });
  console.log("PASS: WebGL compiles, renders and reads expected pixels");
}

if (import.meta.main) {
  await cli(run);
}
