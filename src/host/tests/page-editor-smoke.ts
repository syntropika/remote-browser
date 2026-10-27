/** Human field editing preserves native input and rejects stale references or other viewers. */
import { assert, cli, serve, wait, withEngine } from "./harness.js";
import type { Wire } from "./harness.js";

export async function run(binary: string) {
  const server = serve(
    () =>
      new Response(
        `<!doctype html><meta charset="utf-8"><style>input,textarea{display:block;margin:12px;width:200px;height:28px}iframe{width:300px;height:100px}</style>
    <input aria-label="Text"><input type="password" aria-label="Password" value="existing secret"><input type="number" aria-label="Number" value="12"><input readonly aria-label="Read only"><input type="hidden" aria-label="Hidden"><textarea aria-label="Multiline"></textarea><div contenteditable="true" aria-label="Rich text" style="width:260px;min-height:50px"><b>Hello</b> <i>world</i><span aria-label="Inherited">!</span></div><div contenteditable="plaintext-only" aria-label="Plain editable" style="width:260px;min-height:40px"></div><div contenteditable="true" aria-label="Paragraphs" style="width:260px"><p>one <b>bold</b></p><p>two</p></div><div contenteditable="false" aria-label="Not editable">Read only</div><div role="textbox" aria-label="Role only">Read only</div><div id="shadow"></div><iframe srcdoc="<input aria-label='Framed'><div contenteditable='true' aria-label='Framed rich'><b>frame</b></div>"></iframe>
    <script>window.events=[];document.addEventListener('input',event=>events.push({trusted:event.isTrusted,value:event.target.value}));document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input aria-label="Shadow"><div contenteditable="true" aria-label="Shadow rich"><b>shadow</b></div>';</script>`,
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
        (all: Wire[]) =>
          all.filter((field) => field.type === "contenteditable").length === 5 &&
          all.some((field) => field.label === "Framed"),
      );
      const field = (label: string) => fields.find((entry: Wire) => entry.label === label);
      assert(field("Shadow") && field("Framed"));
      assert.equal(fields.filter((entry) => entry.type === "contenteditable").length, 5);
      assert(!field("Inherited") && !field("Not editable") && !field("Role only"));
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
      for (const [label, initialValue] of [
        ["Framed rich", "frame"],
        ["Shadow rich", "shadow"],
      ]) {
        const entry = field(label);
        await focus(entry);
        assert.equal(
          (await update(entry, initialValue, `${initialValue}!`)).value,
          `${initialValue}!`,
        );
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
      const rich = field("Rich text");
      await focus(rich);
      assert.equal((await update(rich, "Hello world!", "Hello café 😀!")).value, "Hello café 😀!");
      assert.deepEqual(
        await call("evaluate", {
          script: `const e=document.querySelector('[aria-label="Rich text"]');return {bold:e.querySelector("b").textContent,italic:e.querySelector("i").textContent,inherited:e.querySelector("span").isContentEditable};`,
        }),
        { bold: "Hello", italic: "café 😀", inherited: true },
      );
      assert.equal((await update(rich, "Hello café 😀!", "Hello café!")).value, "Hello café!");
      const plain = field("Plain editable");
      await focus(plain);
      await update(plain, "", "first");
      const enter = await call("editor_key", { reference: plain.reference, key: "Enter" });
      assert.equal(enter.value, "first\n");
      assert.equal((await update(plain, "first\n", "first\nsecond")).value, "first\nsecond");
      const paragraphs = field("Paragraphs");
      await focus(paragraphs);
      assert.equal(
        (await update(paragraphs, "one bold\ntwo", "one bold\nthree 😀")).value,
        "one bold\nthree 😀",
      );
      assert.equal(
        await call("evaluate", {
          script: `return document.querySelector('[aria-label="Paragraphs"] b').textContent;`,
        }),
        "bold",
      );
      assert.equal(
        (await update(paragraphs, "one bold\nthree 😀", "one bold three 😀")).value,
        "one bold three 😀",
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
