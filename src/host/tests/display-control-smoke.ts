/** Display ownership must isolate viewers, tab geometry and persistent agent leases. */
import { assert, cli, withEngine } from "./harness.js";

export async function run(binary: string) {
  await withEngine(binary, async (engine) => {
    const tab = (await engine.call("tabs"))[0].id;
    const human = { human: true };
    const desktop = { displayId: "desktop" };
    const phone = { displayId: "phone" };
    assert.equal(
      (await engine.call("display", tab, { ...desktop, visible: true }, human)).controller,
      true,
    );
    await engine.call(
      "resize",
      tab,
      { ...desktop, width: 1280, height: 800, deviceScaleFactor: 1 },
      human,
    );
    const script =
      "return {width:innerWidth,ratio:devicePixelRatio,agent:navigator.userAgent,mobile:(navigator.userAgentData?.mobile ?? false)};";
    const before = await engine.call("evaluate", tab, { ...desktop, script }, human);
    assert.equal(
      (await engine.call("display", tab, { ...phone, visible: true }, human)).controller,
      false,
    );
    assert.match(
      await engine.call(
        "resize",
        tab,
        { ...phone, width: 390, height: 720, mobile: true },
        { ...human, error: true },
      ),
      /Take control/u,
    );
    for (const args of [phone, {}]) {
      assert.match(
        await engine.call(
          "input",
          tab,
          { ...args, kind: "click", x: 20, y: 20 },
          { ...human, error: true },
        ),
        /Another screen/u,
      );
    }
    assert.equal(
      (await engine.call("screenshot", tab, { ...phone, since: 0 }, human)).viewWidth,
      1280,
    );
    const other = await engine.call("open", null, {}, human);
    await engine.call(
      "resize",
      other,
      { ...phone, width: 390, height: 720, mobile: true, deviceScaleFactor: 2 },
      human,
    );
    assert.deepEqual(
      await engine.call("evaluate", tab, { ...desktop, script }, human),
      before,
      "Another tab cannot change this tab's viewport or browser identity",
    );
    await engine.call("take", tab, phone, human);
    await engine.call("resize", tab, { ...phone, width: 390, height: 720, mobile: true }, human);
    const after = await engine.call("evaluate", tab, { ...phone, script }, human);
    assert.equal(after.agent, before.agent);
    assert.equal(after.mobile, before.mobile);
    assert.match(
      await engine.call(
        "input",
        tab,
        { ...desktop, kind: "move", x: 20, y: 20 },
        { ...human, error: true },
      ),
      /Another screen/u,
    );
    await engine.call("display", tab, { ...desktop, visible: false }, human);
    assert.equal(
      (await engine.call("tabs")).find((entry: any) => entry.id === tab).displayController,
      "phone",
    );

    const lease = await engine.call("reserve", other, {
      task: "Verify display isolation",
      agentName: "Verifier",
    });
    await engine.call("display", other, { ...phone, visible: true }, human);
    assert.match(
      await engine.call("resize", other, { ...phone, width: 800 }, { ...human, error: true }),
      /Take control/u,
    );
    await engine.call("display", other, { ...phone, visible: false }, human);
    assert.equal(
      await engine.call("evaluate", other, { script: "return 42;" }, { lease: lease.leaseId }),
      42,
      "Viewer departure must not release an agent lease",
    );
    await engine.call("take", other, phone, human);
    assert.match(
      await engine.call(
        "evaluate",
        other,
        { script: "return 42;" },
        { lease: lease.leaseId, error: true },
      ),
      /reservation|lease|humanControl/iu,
    );
  });
  console.log(
    "PASS: per-tab viewers, explicit takeover, stable identity and agent lease isolation",
  );
}
if (import.meta.main) {
  await cli(run);
}
