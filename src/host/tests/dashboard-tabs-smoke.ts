/** Agent names appear on hover, with compact markers and matching tab borders. */
import { Browser } from "../tools/human-pointer.js";
import { assert, cli, Runtime, temporary, wait } from "./harness.js";

export async function run(engine: string, host: string, args: Record<string, any>) {
  assert(host && args.chrome, "--host-binary and --chrome are required");
  await temporary(async (root) => {
    const runtime = await Runtime.launch(host, engine, root);
    const browser = await Browser.launch(args.chrome);
    const name = "Agent with a long name for the tab tooltip";
    try {
      const page = await runtime.client.call("browser_tabs", {
        action: "reserve",
        agentName: name,
        task: "Verify agent tab presentation",
      });
      await runtime.client.call("browser_evaluate", {
        leaseId: page.leaseId,
        function: "() => {document.title='Agent tab fixture';return true}",
      });
      await browser.open(runtime.url);
      await wait(() => browser.evaluate("document.querySelectorAll('[role=tab]').length===2"));
      const [x, y] = await browser.evaluate(`(() => {
        const dot=document.querySelector('[role=tab] [role=img]');
        const r=dot.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];
      })()`);
      await browser.mouse("mouseMoved", 20, 120);
      await browser.mouse("mouseMoved", x, y);
      await wait(
        () => browser.evaluate("document.querySelector('[role=tooltip]')?.textContent"),
        (text) => text === name,
        2000,
      );
      await wait(() =>
        browser.evaluate(`(() => {
        const tooltip=document.querySelector('[role=tooltip]');
        if(!tooltip)return false;
        const style=getComputedStyle(tooltip),rect=tooltip.getBoundingClientRect();
        return Number(style.opacity)===1 && style.visibility==='visible' && rect.width>0 && rect.height>0;
      })()`),
      );
      const style = await browser.evaluate(`(() => {
        const dot=document.querySelector('[role=tab] [role=img]');
        const tab=dot.closest('[role=tab]').parentElement;
        const s=getComputedStyle(tab),r=dot.getBoundingClientRect();
        const tooltip=document.querySelector('[role=tooltip]'),t=tooltip.getBoundingClientRect();
        return {dot:getComputedStyle(dot).backgroundColor,width:r.width,height:r.height,
          colors:[s.borderLeftColor,s.borderRightColor,s.borderTopColor],
          widths:[s.borderLeftWidth,s.borderRightWidth,s.borderTopWidth],bottom:s.borderBottomWidth,
          tooltipColor:getComputedStyle(tooltip).backgroundColor,placement:tooltip.dataset.placement,
          tooltipLeft:t.left,markerLeft:r.left,tooltipTop:t.top,
          tabBottom:dot.closest('[role=tab]').getBoundingClientRect().bottom};
      })()`);
      assert.equal(style.width, 8);
      assert.equal(style.height, 8);
      assert.deepEqual(style.colors, [style.dot, style.dot, style.dot]);
      assert.deepEqual(style.widths, ["1px", "1px", "1px"]);
      assert.equal(style.bottom, "0px");
      assert.equal(style.tooltipColor, style.dot);
      assert.equal(style.placement, "bottom");
      assert(Math.abs(style.tooltipLeft - style.markerLeft) <= 1);
      assert(Math.abs(style.tooltipTop - style.tabBottom - 4) <= 1);
      await browser.mouse("mousePressed", x, y, 1);
      await browser.mouse("mouseReleased", x, y);
      await wait(() =>
        browser.evaluate(
          "document.querySelector('[role=tab][aria-selected=true] [role=img]')!==null",
        ),
      );
      assert.equal(
        await browser.evaluate(
          "document.querySelector('[role=tab][aria-selected=true]').textContent",
        ),
        "Agent tab fixture",
      );
      await runtime.dashboard.action("take", page.tabId);
      await wait(() =>
        browser.evaluate("document.querySelectorAll('[role=tab] [role=img]').length===0"),
      );
      await wait(() => browser.evaluate("document.querySelector('[role=tooltip]')===null"));
      await wait(
        () =>
          browser.evaluate(
            "getComputedStyle(document.querySelector('[role=tab][aria-selected=true]').parentElement).borderTopColor",
          ),
        (color) => color === "rgba(0, 0, 0, 0)",
      );
    } finally {
      await browser.close();
      await runtime.stop();
    }
  });
  console.log(
    "PASS: agent hover tooltip, matching top/side borders, compact dot and marker selection",
  );
}
if (import.meta.main) {
  await cli(run);
}
