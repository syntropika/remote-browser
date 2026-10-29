/** A human can select, take over, close and restart tabs after an interrupted agent action. */
import { Browser, waitForDisplay } from "../tools/human-pointer.js";
import { assert, cli, reservePage, Runtime, temporary, wait } from "./harness.js";

async function press(browser: Browser, expression: string) {
  const [x, y] = await wait(() =>
    browser.evaluate(
      `(() => {const node=${expression};if(!node)return null;const r=node.getBoundingClientRect();return r.width>0?[r.x+r.width/2,r.y+r.height/2]:null})()`,
    ),
  );
  await browser.mouse("mouseMoved", x, y);
  await browser.mouse("mousePressed", x, y, 1);
  await browser.mouse("mouseReleased", x, y);
}

export async function run(engine: string, host: string, args: Record<string, any>) {
  assert(host && args.chrome, "--host-binary and --chrome are required");
  await temporary(async (root) => {
    const runtime = await Runtime.launch(host, engine, root);
    const browser = await Browser.launch(args.chrome);
    const quarantine = async (name: string) => {
      const reservation = await reservePage(runtime.client);
      await runtime.client.call("browser_evaluate", {
        leaseId: reservation.leaseId,
        function: `() => {document.title=${JSON.stringify(name)};return true}`,
      });
      await runtime.client.call(
        "browser_run_code",
        {
          leaseId: reservation.leaseId,
          timeoutMs: 50,
          code: "return await page.evaluate(async () => {await new Promise(resolve => setTimeout(resolve, 500));return true;});",
        },
        true,
      );
      await wait(
        async () =>
          (await runtime.dashboard.action("tabs")).find((tab: any) => tab.id === reservation.tabId)
            ?.uncertain,
      );
      return reservation;
    };
    try {
      const blocked = await quarantine("Blocked fixture");
      await browser.open(runtime.url);
      await wait(() => browser.evaluate(`document.querySelectorAll('[role=tab]').length===2`));
      await press(
        browser,
        `Array.from(document.querySelectorAll('[role=tab]')).find(node=>node.textContent==='Blocked fixture')`,
      );
      await wait(() =>
        browser.evaluate(
          `Array.from(document.querySelectorAll('[role=tab]')).find(node=>node.textContent==='Blocked fixture')?.getAttribute('aria-selected')==='true'`,
        ),
      );
      await wait(() =>
        browser.evaluate(
          `document.querySelector('button[aria-label="Ask for control"]')?.disabled===false`,
        ),
      );
      await press(browser, `document.querySelector('button[aria-label="Ask for control"]')`);
      await waitForDisplay(browser);
      const recovered = (await runtime.dashboard.action("tabs")).find(
        (tab: any) => tab.id === blocked.tabId,
      );
      assert.equal(recovered.uncertain, false);
      assert.equal(recovered.owner, "human");
      assert.equal(recovered.reservation, null);
      await runtime.client.call("browser_snapshot", { leaseId: blocked.leaseId }, true);
      const closing = await quarantine("Close blocked fixture");
      await press(
        browser,
        `Array.from(document.querySelectorAll('[role=tab]')).find(node=>node.textContent==='Close blocked fixture')`,
      );
      await press(
        browser,
        `document.querySelector('button[aria-label="Close Close blocked fixture"]')`,
      );
      await wait(
        async () =>
          !(await runtime.dashboard.action("tabs")).some((tab: any) => tab.id === closing.tabId),
      );
      await runtime.client.call("browser_snapshot", { leaseId: closing.leaseId }, true);
      const before = (await runtime.dashboard.action("tabs")).length;
      await press(browser, `document.querySelector('button[aria-label="More options"]')`);
      await press(
        browser,
        `Array.from(document.querySelectorAll('[role=menuitem]')).find(node=>node.textContent.includes('Restart browser session'))`,
      );
      await wait(() => browser.evaluate(`!!document.querySelector('[role=dialog]')`));
      assert.equal((await runtime.dashboard.action("tabs")).length, before);
      await press(
        browser,
        `Array.from(document.querySelectorAll('[role=dialog] button')).find(node=>node.textContent==='Cancel')`,
      );
      assert.equal((await runtime.dashboard.action("tabs")).length, before);
      await press(browser, `document.querySelector('button[aria-label="More options"]')`);
      await press(
        browser,
        `Array.from(document.querySelectorAll('[role=menuitem]')).find(node=>node.textContent.includes('Restart browser session'))`,
      );
      await press(
        browser,
        `Array.from(document.querySelectorAll('[role=dialog] button')).find(node=>node.textContent==='Restart browser')`,
      );
      await wait(async () => (await runtime.dashboard.action("tabs")).length === 1);
      await wait(() => browser.evaluate(`!document.querySelector('[role=dialog]')`));
      await waitForDisplay(browser);
      assert.equal((await runtime.client.call("browser_status", {})).uncertain, false);
      await browser.call("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobile = await quarantine("Mobile blocked fixture");
      await press(
        browser,
        `document.querySelector('button[aria-label^="Show "][aria-label$=" open tabs"]')`,
      );
      await press(
        browser,
        `document.querySelector('button[aria-label="Switch to Mobile blocked fixture"]')`,
      );
      await wait(() => browser.evaluate(`!document.querySelector('[role=dialog]')`));
      await press(browser, `document.querySelector('button[aria-label="More options"]')`);
      await press(
        browser,
        `Array.from(document.querySelectorAll('[role=menuitem]')).find(node=>node.textContent.includes('Ask for control'))`,
      );
      await wait(
        async () =>
          (await runtime.dashboard.action("tabs")).find((tab: any) => tab.id === mobile.tabId)
            ?.owner === "human",
      );
      await runtime.client.call("browser_snapshot", { leaseId: mobile.leaseId }, true);
    } finally {
      await browser.close();
      await runtime.stop();
    }
  });
  console.log(
    "PASS: desktop/mobile blocked-tab selection, human takeover, close and confirmed restart",
  );
}
if (import.meta.main) {
  await cli(run);
}
