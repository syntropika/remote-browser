import { FRAME } from "./fixtures/human-pointer-smoke.js";
import { cli } from "./harness.js";
import { pointerFixture, assert, sleep, wait } from "./pointer-fixture.js";

export function page(origin: string) {
  return `<!doctype html><style>body{margin:0}iframe{position:absolute;left:200px;top:100px;width:300px;height:200px;border:0}</style><script>window.frame={ready:false,state:null};window.topMoves=0;window.topLeft=false;addEventListener('pointermove',e=>{if(e.isTrusted)topMoves++});document.documentElement.addEventListener('mouseleave',e=>{topLeft=e.isTrusted});onmessage=e=>{if(e.data.ready)frame.ready=true;if(e.data.state)frame.state=e.data.state};</script><iframe src="${origin.replace("127.0.0.1", "localhost")}/frame"></iframe>`;
}

export async function run(binary: string) {
  await pointerFixture(
    binary,
    { "/": page, "/frame": FRAME },
    async ({ engine, tab, human, evaluate }) => {
      await wait(() => evaluate("return window.frame.ready;"));
      await engine.call("take", tab, {}, { human: true });
      for (let step = 0; step < 9; step++) {
        await human("move", 100 + step * 22.5, 60 + step * 12.5);
        await sleep(30);
      }
      await human("down", 280, 160);
      await sleep(150);
      await human("up", 281, 160);
      await human("move", 600, 500);
      await human("leave");
      for (const [kind, x] of [
        ["move", -1],
        ["down", 2000],
      ] as const) {
        await human(kind, x, 10, true);
      }
      await engine.call("return", tab, {}, { human: true });
      const result = await wait(
        () => evaluate("return {state:window.frame.state,topMoves,topLeft};"),
        (value) => value.state?.left && value.topLeft,
      );
      const { state } = result;
      assert(result.topMoves >= 3 && state.movesBeforeDown >= 3 && state.boxHover);
      assert(state.up - state.down >= 100);
      assert.equal(state.click, true);
      assert.equal(state.checked, true);
    },
  );
  console.log("PASS: actual human motion, hover, press duration, release and leave across sites");
}

if (import.meta.main) {
  await cli(run);
}
