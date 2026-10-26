import { PAGE, FRAME } from "./fixtures/pointer-capture-smoke.js";
import { cli } from "./harness.js";
import { pointerFixture, assert, wait } from "./pointer-fixture.js";

export async function run(binary: string) {
  await pointerFixture(binary, { "/": PAGE, "/frame": FRAME }, async ({ evaluate, click }) => {
    await wait(() => evaluate("return window.ready;"));
    for (const release of [false, true]) {
      await evaluate(
        `window.result=null;document.querySelector('iframe').contentWindow.reset(true,${release});return true;`,
      );
      await click(50, 60);
      const value = await wait(
        () => evaluate("return window.result;"),
        (result) => result?.trace.some((event: any) => event.type === "click") && !result.captured,
      );
      const { trace } = value;
      for (const type of ["pointerup", "mouseup", "click"]) {
        assert(
          trace.some((event: any) => event.type === type && event.target === "target"),
          JSON.stringify(trace),
        );
      }
      assert(trace.some((event: any) => event.type === "lostpointercapture"));
      assert(trace.every((event: any) => event.trusted));
      assert(!value.captured);
    }
    await evaluate(
      "window.result=null;document.querySelector('iframe').contentWindow.reset(false,false);return true;",
    );
    await click(50, 60);
    const { trace } = await wait(
      () => evaluate("return window.result;"),
      (value) => value?.trace.some((event: any) => event.type === "mouseup"),
    );
    assert(trace.some((event: any) => event.type === "pointerup" && event.target === "BODY"));
    assert(!trace.some((event: any) => event.type === "click" && event.target === "target"));
  });
  console.log("PASS: capture target survives movement and release during pointerup");
}

if (import.meta.main) {
  await cli(run);
}
