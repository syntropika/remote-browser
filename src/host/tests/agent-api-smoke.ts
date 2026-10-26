import { assert, cli, Http, INIT, reference, Runtime, serve, temporary, wait } from "./harness.js";

export async function run(engine: string, host: string) {
  assert(host, "--host-binary is required");
  const server = serve(
    () =>
      new Response(
        `<!doctype html><title>Agent API</title>
    <label>Name<input id="name"></label><label>City<input id="city"></label>
    <select aria-label="Plan"><option value="basic">Basic</option><option value="pro">Pro</option></select>
    <button id="run">Run</button><button id="dialog">Prompt</button>
    <button id="hover">Hover</button><output id="result"></output>
    <button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button>
    <input id="hidden" style="display:none"><button id="disabled" disabled>Disabled</button><div id="dragFrom" role="button" style="display:inline-block;width:80px;height:40px">Drag source</div><div id="dragTo" role="button" style="display:inline-block;width:80px;height:40px">Drag target</div><div style="height:2400px">Long document</div>
    <script>
      document.querySelector('#run').onclick=()=>{console.log('agent-action');setTimeout(()=>document.querySelector('#result').textContent='Results ready',150)};
      document.querySelector('#dialog').onclick=()=>document.querySelector('#result').textContent=prompt('Name?','default') || 'dismissed';
      document.querySelector('#hover').onmouseenter=()=>document.body.dataset.hover='yes';
      document.querySelector('#dragFrom').onpointerdown=e=>{e.target.setPointerCapture(e.pointerId);document.body.dataset.dragStart=String(e.isTrusted)};
      document.querySelector('#dragFrom').onpointermove=e=>{if(e.buttons===1)document.body.dataset.dragMove=String(e.isTrusted)};
      document.querySelector('#dragFrom').onpointerup=e=>document.body.dataset.dragEnd=String(e.isTrusted);
    </script>`,
        { headers: { "Content-Type": "text/html" } },
      ),
  );
  try {
    await temporary(async (root) => {
      const runtime = await Runtime.launch(host, engine, root);
      const { client } = runtime;
      try {
        const initial = (await client.call("browser_tabs", { action: "list" })).tabs[0].id;
        await client.call("browser_snapshot", { tabId: initial }, true);
        const reservation = await client.call("browser_tabs", {
          action: "reserve",
          agentName: "Agent one",
          task: "page operations",
        });
        const { leaseId, tabId } = reservation;
        const args = { leaseId };
        await client.call("browser_navigate", { ...args, url: server.origin });
        const snapshot = await client.call("browser_snapshot", args);
        await client.call("browser_type", {
          ...args,
          target: reference(snapshot, "Name"),
          text: "Ada",
        });
        await client.call("browser_fill_form", {
          ...args,
          fields: [
            { target: "#name", value: "Grace" },
            { target: "#city", value: "Lisbon" },
          ],
        });
        await client.call("browser_select_option", {
          ...args,
          target: { role: "combobox", name: "Plan" },
          values: ["pro"],
        });
        await client.call("browser_hover", { ...args, target: "#hover" });
        await client.call("browser_click", { ...args, target: "#run" });
        await client.call("browser_wait_for", { ...args, text: "Results ready" });
        assert.equal(
          (
            await client.call("browser_evaluate", {
              ...args,
              function:
                "() => [document.querySelector('#name').value,document.querySelector('#city').value,document.querySelector('select').value,document.body.dataset.hover]",
            })
          ).value.join(","),
          "Grace,Lisbon,pro,yes",
        );
        assert(
          (await client.call("browser_find", { ...args, text: "Results ready" })).matches.length,
        );
        await client.call("browser_scroll", { ...args, y: 700 });
        await wait(
          async () =>
            (await client.call("browser_evaluate", { ...args, function: "() => scrollY" })).value,
          (y) => y > 0,
        );
        const shot = await client.call("browser_take_screenshot", { ...args, fullPage: true });
        assert.equal(shot.content[0].type, "image");
        await client.call("browser_click", { ...args, target: "#disabled" }, true);
        await client.call("browser_click", { ...args, target: ".duplicate" }, true);
        await client.call("browser_click", { ...args, target: "#dialog" });
        await client.call("browser_handle_dialog", {
          ...args,
          accept: true,
          promptText: "accepted",
        });
        await client.call("browser_wait_for", { ...args, text: "accepted" });
        await client.call("browser_drag", {
          ...args,
          startTarget: "#dragFrom",
          endTarget: "#dragTo",
        });
        await client.call(
          "browser_type",
          { ...args, target: "#hidden", text: "wrong target" },
          true,
        );
        assert.deepEqual(
          (
            await client.call("browser_evaluate", {
              ...args,
              function:
                "() => [document.body.dataset.dragStart,document.body.dataset.dragMove,document.body.dataset.dragEnd]",
            })
          ).value,
          ["true", "true", "true"],
        );
        const code = await client.call("browser_run_code", {
          ...args,
          code: `
          for (const name of ['first', 'second']) {
            await page.getByRole('textbox', {name:'Name'}).fill(name);
            await page.locator('#run').click();
            await page.waitForText('Results ready');
          }
          return {name:await page.evaluate(() => document.querySelector('#name').value), globals:[typeof process,typeof fetch,typeof require]};
        `,
        });
        const thrown = await client.call(
          "browser_run_code",
          { ...args, code: "throw new Error('specific-code-error')" },
          true,
        );
        assert(JSON.stringify(thrown).includes("specific-code-error"));
        const route = JSON.parse(Buffer.from(leaseId, "base64url").toString());
        const tampered = Buffer.from(JSON.stringify({ ...route, tabId: initial })).toString(
          "base64url",
        );
        await client.call("browser_scroll", { leaseId: tampered, y: 50 }, true);
        assert.deepEqual(code.value, {
          name: "second",
          globals: ["undefined", "undefined", "undefined"],
        });
        await client.call(
          "browser_run_code",
          { ...args, code: "while (true) {}", timeoutMs: 100 },
          true,
        );
        await client.call(
          "browser_run_code",
          { ...args, code: "for(let i=0;i<101;i++) await page.evaluate(() => 1)" },
          true,
        );
        await client.call("browser_run_code", { ...args, code: "return 'x'.repeat(40000)" }, true);
        await client.call(
          "browser_run_code",
          { ...args, code: "return new Array(12000000).fill('x')" },
          true,
        );
        assert.equal(
          (await client.call("browser_evaluate", { ...args, function: "() => 42" })).value,
          42,
        );
        await client.call("browser_click", { ...args, tabId: initial, target: "#run" }, true);
        const profile = (
          await client.call("browser_profiles", { action: "create", name: "Second account" })
        ).id;
        const other = await client.call("browser_tabs", {
          action: "reserve",
          profileId: profile,
          agentName: "Agent two",
          task: "profile routing",
        });
        await client.call("browser_navigate", { leaseId: other.leaseId, url: server.origin });
        await client.call("browser_type", {
          leaseId: other.leaseId,
          target: "#name",
          text: "other account",
        });
        assert.equal(
          (
            await client.call("browser_evaluate", {
              ...args,
              function: "() => document.querySelector('#name').value",
            })
          ).value,
          "second",
        );
        const key = (await runtime.dashboard.api("/api/keys", { name: "Another client" }, 201))
          .data;
        const http = new Http(runtime.url, key.secret);
        await http.request("initialize", INIT);
        for (const [tool, extra] of [
          ["browser_snapshot", {}],
          ["browser_scroll", { y: 10 }],
          ["browser_run_code", { code: "return 1" }],
        ] as const) {
          await http.call(tool, { ...args, ...extra }, true);
        }
        await client.call("browser_control", {
          ...args,
          action: "record_start",
          name: "reserved-tab.mp4",
          maxSeconds: 20,
        });
        const neighbor = await client.call("browser_tabs", {
          action: "reserve",
          agentName: "Neighbor",
          task: "recording isolation",
        });
        await client.call(
          "browser_control",
          { leaseId: neighbor.leaseId, action: "record_stop" },
          true,
        );
        await Bun.sleep(350);
        const pending = client.call(
          "browser_run_code",
          {
            ...args,
            code: "await page.evaluate(() => document.body.dataset.waiting = 'yes'); await page.waitForText('never present', 5000); await page.evaluate(() => document.body.dataset.illegal = 'yes');",
          },
          true,
        );
        await wait(
          async () =>
            (
              await client.call("browser_evaluate", {
                ...args,
                function: "() => document.body.dataset.waiting",
              })
            ).value,
          (v) => v === "yes",
        );
        await runtime.dashboard.action("take", tabId);
        await pending;
        await wait(async () =>
          (await client.call("browser_files", { action: "list" })).files.some(
            (file: any) => file.id === "recordings/reserved-tab.mp4",
          ),
        );
        for (const [tool, extra] of [
          ["browser_snapshot", {}],
          ["browser_scroll", { y: 10 }],
          ["browser_console_messages", {}],
        ] as const) {
          await client.call(tool, { ...args, ...extra }, true);
        }
        await runtime.dashboard.action("return", tabId);
        await client.call("browser_snapshot", args, true);
        const next = await client.call("browser_tabs", {
          action: "reserve",
          tabId,
          agentName: "Agent three",
          task: "new ownership",
        });
        await client.call("browser_control", {
          leaseId: next.leaseId,
          action: "record_start",
          name: "new-reservation.mp4",
          maxSeconds: 1,
        });
        await wait(
          async () =>
            !(
              await client.call("browser_control", {
                leaseId: next.leaseId,
                action: "record_status",
              })
            ).active,
        );
        assert.notEqual(next.leaseId, leaseId);
        assert.equal(
          (
            await client.call("browser_evaluate", {
              leaseId: next.leaseId,
              function: "() => document.body.dataset.illegal || null",
            })
          ).value,
          null,
        );
        await client.call("browser_tabs", { action: "release", leaseId: next.leaseId });
        assert(
          (await client.call("browser_tabs", { action: "list" })).tabs.some(
            (t: any) => t.id === tabId && !t.reservation,
          ),
        );
        await client.call("browser_snapshot", { leaseId: next.leaseId }, true);
        const close = await client.call("browser_tabs", {
          action: "reserve",
          tabId,
          agentName: "Cleanup",
          task: "close",
        });
        await client.call("browser_tabs", { action: "close", leaseId: close.leaseId });
        await client.call("browser_snapshot", { leaseId: close.leaseId }, true);
        assert.equal(
          (await client.call("browser_tabs", { action: "list" })).tabs.find((t: any) => t.active)
            .id,
          initial,
        );
        assert(!(await client.call("browser_status", {})).uncertain);
      } finally {
        await runtime.stop();
      }
    });
  } finally {
    await server.stop();
  }
  console.log(
    "PASS: lease-only routing, individual tools, embedded code, bounded execution, client isolation and takeover revocation",
  );
}
if (import.meta.main) {
  await cli(run);
}
