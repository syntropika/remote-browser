/** Human field editing preserves native input and rejects stale references or other viewers. */
import { assert, cli, serve, wait, withEngine } from "./harness.js";
import type { Wire } from "./harness.js";

export async function run(binary: string) {
  const server = serve(
    () =>
      new Response(
        `<!doctype html><meta charset="utf-8"><style>input,textarea{display:block;margin:12px;width:200px;height:28px}iframe{width:300px;height:100px}</style>
    <input aria-label="Text"><input type="password" aria-label="Password" value="existing secret"><input type="number" aria-label="Number" value="12"><input readonly aria-label="Read only"><input type="hidden" aria-label="Hidden"><textarea aria-label="Multiline"></textarea><div id="shadow"></div><iframe srcdoc="<input aria-label='Framed'>"></iframe>
    <script>window.events=[];document.addEventListener('input',event=>events.push({trusted:event.isTrusted,value:event.target.value}));document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input aria-label="Shadow">';</script>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      ),
  );
  try {
    await withEngine(binary, async (engine) => {
      const tab = (await engine.call("tabs"))[0].id;
      await engine.call("navigate", tab, { url: server.origin });
      const human = { human: true };
      const displayId = "editor-phone";
      await engine.call("display", tab, { displayId, visible: true }, human);
      const call = (op: string, args: Wire = {}, error = false) =>
        engine.call(op, tab, { ...args, displayId }, { ...human, error });
      const fields = await wait(
        async () => (await call("editor_fields")).fields,
        (all: Wire[]) => all.length === 6,
      );
      const field = (label: string) => fields.find((entry: Wire) => entry.label === label);
      assert(field("Shadow") && field("Framed"));
      assert.equal(field("Password").value, "", "Bulk metadata never includes password contents");
      assert(!field("Read only") && !field("Hidden"));
      const focus = (entry: Wire) =>
        call("editor_focus", {
          reference: entry.reference,
          x: entry.x + entry.width / 2,
          y: entry.y + entry.height / 2,
        });
      const update = (entry: Wire, expected: string, value: string) =>
        call("editor_update", { reference: entry.reference, expected, value });
      const text = field("Text");
      await focus(text);
      assert.equal((await update(text, "", "café 😀")).value, "café 😀");
      assert.equal((await update(text, "café 😀", "cafe 😁")).value, "cafe 😁");
      assert.equal((await update(text, "cafe 😁", "cafe")).value, "cafe");
      assert.match(
        await call(
          "editor_update",
          { reference: text.reference, expected: "outdated", value: "wrong" },
          true,
        ),
        /page changed/iu,
      );
      assert.equal((await focus(field("Password"))).value, "existing secret");
      for (const label of ["Framed", "Shadow"]) {
        const entry = field(label);
        await focus(entry);
        assert.equal((await update(entry, "", label)).value, label);
      }
      const number = field("Number");
      await focus(number);
      assert.equal((await update(number, "12", "123")).value, "123");
      assert.equal((await update(number, "123", "")).value, "");
      const multiline = field("Multiline");
      await focus(multiline);
      await update(multiline, "", "first");
      assert.equal(
        (await call("editor_key", { reference: multiline.reference, key: "Enter" })).value,
        "first\n",
      );
      const events = await call("evaluate", { script: "return events;" });
      assert(events.length >= 7 && events.every((event: Wire) => event.trusted));
      assert.match(
        await engine.call(
          "editor_fields",
          tab,
          { displayId: "spectator" },
          { ...human, error: true },
        ),
        /Another screen/iu,
      );
      await call("navigate", { url: `${server.origin}/next` });
      await call("editor_fields");
      assert.match(
        await call("editor_focus", { reference: text.reference }, true),
        /earlier page/iu,
      );
      await call("return");
      const lease = await engine.call("reserve", tab, {
        agentName: "Editor verifier",
        task: "Check editing isolation",
      });
      assert.match(await call("editor_fields", {}, true), /reserved/iu);
      assert.match(
        await engine.call("editor_fields", tab, {}, { lease: lease.leaseId, error: true }),
        /controlling dashboard/iu,
      );
      await engine.call("release", tab, {}, { lease: lease.leaseId });
    });
  } finally {
    await server.stop();
  }
  console.log(
    "PASS: trusted field edits, Unicode replacement, password privacy, frames, multiline and ownership/navigation guards",
  );
}
if (import.meta.main) {
  await cli(run);
}
