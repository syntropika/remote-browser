/** Real-engine regressions for dashboard dialogs and scroll-stable drag coordinates. */
import { assert, cli, reservePage, Runtime, serve, temporary, wait } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  const failures: string[] = [];
  try {
    let opened = false;
    let resolved: unknown;
    const server = serve(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/opened") {
        opened = true;
        return new Response("ok");
      }
      if (path === "/resolved") {
        resolved = await request.json();
        return new Response("ok");
      }
      if (path === "/load") {
        return new Response(
          "<!doctype html><script>const answer=prompt('Prompt while loading','');fetch('/resolved',{method:'POST',body:JSON.stringify(answer)})</script>",
          { headers: { "Content-Type": "text/html" } },
        );
      }
      return new Response(
        `<!doctype html><button style="position:absolute;left:20px;top:20px;width:200px;height:60px" onclick="fetch('/opened',{method:'POST'});const value=prompt('Dashboard prompt','initial');fetch('/resolved',{method:'POST',body:JSON.stringify(value)})">Prompt</button>`,
        { headers: { "Content-Type": "text/html" } },
      );
    });
    try {
      await temporary(async (root) => {
        const runtime = await Runtime.launch(host, engine, root);
        try {
          const tabId = (await runtime.dashboard.action("tabs"))[0].id;
          await runtime.dashboard.action("take", tabId);
          await runtime.dashboard.action("navigate", tabId, { url: server.origin });
          await runtime.dashboard.action("input", tabId, { kind: "click", x: 100, y: 50 });
          await wait(() => opened);
          const tab = (await runtime.dashboard.action("tabs")).find(
            (value: any) => value.id === tabId,
          );
          assert(
            tab.jsDialog,
            "A pending website prompt must be exposed to dashboard users instead of blocking indefinitely",
          );
          assert.equal(tab.jsDialog.type, "prompt");
          assert.equal(tab.jsDialog.message, "Dashboard prompt");
          assert.equal(tab.jsDialog.defaultPromptText, "initial");
          assert.equal(tab.jsDialog.origin, server.origin);
          await runtime.dashboard.action(
            "js_dialog",
            tabId,
            { id: "stale", accept: true },
            "default",
            409,
          );
          assert.equal(
            (await runtime.dashboard.action("tabs")).find((value: any) => value.id === tabId)
              .jsDialog.id,
            tab.jsDialog.id,
          );
          await runtime.dashboard.action("js_dialog", tabId, {
            id: tab.jsDialog.id,
            accept: true,
            promptText: "human answer",
          });
          await wait(() => resolved !== undefined);
          assert.equal(resolved, "human answer");
          assert.equal(
            (await runtime.dashboard.action("tabs")).find((value: any) => value.id === tabId)
              .jsDialog,
            null,
          );
          await runtime.dashboard.action("return", tabId);
          const { leaseId } = await reservePage(runtime.client, tabId);
          resolved = undefined;
          await runtime.client.call("browser_click", { leaseId, target: "button" });
          const held = (await runtime.dashboard.action("tabs")).find(
            (value: any) => value.id === tabId,
          ).jsDialog;
          assert(held);
          const listed = (await runtime.client.call("browser_tabs", { action: "list" })).tabs.find(
            (value: any) => value.id === tabId,
          );
          assert.equal(
            listed.jsDialog,
            undefined,
            "Global agent listings must not disclose dialog contents",
          );
          await runtime.dashboard.action(
            "js_dialog",
            tabId,
            { id: held.id, accept: false },
            "default",
            409,
          );
          await runtime.dashboard.action("take", tabId);
          await runtime.client.call("browser_handle_dialog", { leaseId, accept: true }, true);
          await runtime.dashboard.action("js_dialog", tabId, { id: held.id, accept: false });
          await wait(() => resolved !== undefined);
          assert.equal(resolved, null);
          resolved = undefined;
          const navigation = runtime.dashboard.action("navigate", tabId, {
            url: `${server.origin}/load`,
          });
          // Attach the rejection handler immediately, including when an assertion below fails.
          const completion = navigation.then(
            () => null,
            (cause: unknown) => cause,
          );
          const loadingDialog = await wait(
            async () =>
              (await runtime.dashboard.action("tabs")).find((value: any) => value.id === tabId)
                ?.jsDialog,
          );
          await runtime.dashboard.action("js_dialog", tabId, {
            id: loadingDialog.id,
            accept: true,
            promptText: "continue loading",
          });
          assert.equal(await completion, null);
          await wait(() => resolved !== undefined);
          assert.equal(resolved, "continue loading");
        } finally {
          await runtime.stop();
        }
      });
      console.log("PASS: dashboard can inspect and resolve a human-owned website prompt");
    } finally {
      await server.stop();
    }
  } catch (cause) {
    failures.push(`dashboard-dialog: ${String(cause)}`);
  }
  try {
    const server = serve(
      () =>
        new Response(
          `<!doctype html><style>body{margin:0;height:2200px}#source,#destination{position:absolute;left:40px;width:120px;height:50px}#source{top:450px}#destination{top:650px}</style><div id="source">Source</div><div id="destination">Destination</div><script>window.starts=[];window.ends=[];addEventListener('pointerdown',e=>starts.push(e.target.id));addEventListener('pointerup',e=>ends.push(e.target.id));</script>`,
          { headers: { "Content-Type": "text/html" } },
        ),
    );
    try {
      await temporary(async (root) => {
        const runtime = await Runtime.launch(host, engine, root);
        try {
          const { leaseId } = await reservePage(runtime.client);
          await runtime.client.call("browser_navigate", { leaseId, url: server.origin });
          await runtime.client.call("browser_drag", {
            leaseId,
            startTarget: "#source",
            endTarget: "#destination",
          });
          const events = (
            await runtime.client.call("browser_evaluate", {
              leaseId,
              function: "() => ({starts,ends})",
            })
          ).value;
          assert.deepEqual(
            events.starts,
            ["source"],
            "Locating the destination must not move the source away from the mouse-down point",
          );
          assert.deepEqual(events.ends, ["destination"]);
          // Both endpoints remain reachable after a nonzero page scroll.
          await runtime.client.call("browser_evaluate", {
            leaseId,
            function: "() => { starts=[]; ends=[]; scrollTo(0, 300); }",
          });
          await runtime.client.call("browser_drag", {
            leaseId,
            startTarget: "#source",
            endTarget: "#destination",
          });
          const scrolled = (
            await runtime.client.call("browser_evaluate", {
              leaseId,
              function: "() => ({starts,ends})",
            })
          ).value;
          assert.deepEqual(scrolled, { starts: ["source"], ends: ["destination"] });
          // Unreachable pairs fail before starting a drag, rather than pressing the wrong node.
          await runtime.client.call("browser_evaluate", {
            leaseId,
            function:
              "() => { starts=[]; ends=[]; document.querySelector('#destination').style.top='1800px'; }",
          });
          await runtime.client.call(
            "browser_drag",
            { leaseId, startTarget: "#source", endTarget: "#destination" },
            true,
          );
          assert.deepEqual(
            (await runtime.client.call("browser_evaluate", { leaseId, function: "() => starts" }))
              .value,
            [],
          );
        } finally {
          await runtime.stop();
        }
      });
      console.log("PASS: drag endpoints share current viewport coordinates before pointer input");
    } finally {
      await server.stop();
    }
  } catch (cause) {
    failures.push(`drag-coordinates: ${String(cause)}`);
  }
  assert.equal(failures.length, 0, failures.join("\n"));
}
if (import.meta.main) {
  await cli(run);
}
