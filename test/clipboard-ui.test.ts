import assert from "node:assert/strict";
import test from "node:test";

import { createClipboard } from "../ui/clipboard.js";

class Element extends EventTarget {
  value = "";
  hidden = false;
  attributes = {};
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  focus() {}
  select() {}
  setSelectionRange() {}
  querySelector() {
    return this;
  }
}
function fixture(t, api) {
  const elements = Object.fromEntries(
    [
      "clipboard-panel",
      "clipboard-text",
      "clipboard-button",
      "clipboard-read",
      "clipboard-copy",
      "clipboard-send",
      "clipboard-status",
      "clipboard-close",
      "more-menu",
    ].map((id) => [id, new Element()]),
  );
  elements["clipboard-panel"].hidden = true;
  const previous = globalThis.document;
  globalThis.document = { getElementById: (id) => elements[id] };
  t.after(() => {
    globalThis.document = previous;
  });
  const keys = [];
  let allowed = true;
  const client = { sendKey: (...args) => keys.push(args), focus() {} };
  const clipboard = createClipboard({
    api,
    getRfb: () => client,
    canControl: () => allowed,
    onOpen() {},
    onUnauthorized() {},
  });
  const click = (id) => elements[id].dispatchEvent(new Event("click"));
  click("clipboard-button");
  return {
    elements,
    clipboard,
    keys,
    click,
    revoke: () => {
      allowed = false;
      clipboard.sync();
    },
  };
}

test("closing a pending paste clears local text and does not send a later remote paste", async (t) => {
  let complete;
  const f = fixture(
    t,
    async () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  f.elements["clipboard-text"].value = "private synthetic text";
  f.click("clipboard-send");
  assert.equal(f.elements["clipboard-text"].readOnly, true);
  f.clipboard.close();
  complete({ written: true });
  await new Promise(setImmediate);
  assert.equal(f.elements["clipboard-text"].value, "");
  assert.equal(f.elements["clipboard-panel"].hidden, true);
  assert.deepEqual(f.keys, []);
});

test("losing control during a read prevents its result from repopulating the panel", async (t) => {
  let complete;
  const f = fixture(
    t,
    async () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  f.click("clipboard-read");
  await new Promise((resolve) => {
    setTimeout(resolve, 280);
  });
  assert.equal(typeof complete, "function");
  f.revoke();
  complete({ text: "private synthetic clipboard" });
  await new Promise(setImmediate);
  assert.equal(f.elements["clipboard-text"].value, "");
  assert.equal(f.elements["clipboard-status"].textContent, "");
  assert.equal(f.elements["clipboard-panel"].hidden, true);
});

test("remote shortcuts release Control even if sending the copy key fails", async (t) => {
  const f = fixture(t, async () => ({ text: "" }));
  // Exercise the actual client failure path, without a stuck modifier.
  const original = f.keys.push.bind(f.keys);
  f.keys.push = (args) => {
    original(args);
    if (args[1] === "KeyC") {
      throw new Error("Connection interrupted.");
    }
  };
  f.click("clipboard-read");
  await new Promise(setImmediate);
  assert.deepEqual(
    [...f.keys],
    [
      [0xff_e3, "ControlLeft", true],
      [0x63, "KeyC"],
      [0xff_e3, "ControlLeft", false],
    ],
  );
  assert.equal(f.elements["clipboard-status"].textContent, "Connection interrupted.");
});
