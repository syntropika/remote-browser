import assert from "node:assert/strict";
import test from "node:test";

import { createClipboardShortcuts } from "../ui/clipboard-shortcuts.js";

function event(type, properties = {}) {
  const value = new Event(type, { cancelable: true });
  Object.assign(value, properties);
  return value;
}

const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const previousItem = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");

function fixture(t, api, clipboardApi?) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: clipboardApi },
  });
  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    value: class {
      constructor(data) {
        this.data = data;
      }
      async getType(type) {
        return await this.data[type];
      }
    },
  });
  t.after(() => {
    for (const [key, descriptor] of [
      ["navigator", previousNavigator],
      ["ClipboardItem", previousItem],
    ]) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  const display = new EventTarget();
  let remoteFocused = true;
  display.querySelector = () => (remoteFocused ? display : null);
  let allowed = true;
  const keys = [];
  let client = { sendKey: (...args) => keys.push(args) };
  const fallbacks = [];
  let unauthorized = false;
  const shortcuts = createClipboardShortcuts({
    display,
    api,
    getRfb: () => client,
    canControl: () => allowed,
    onFallback: (...args) => fallbacks.push(args),
    onUnauthorized: () => {
      unauthorized = true;
    },
  });
  const dispatch = (type, properties) => {
    const value = event(type, properties);
    display.dispatchEvent(value);
    return value;
  };
  const paste = (text) => dispatch("paste", { clipboardData: { getData: () => text } });
  const key = (value, options = {}) =>
    dispatch("keydown", { key: value, code: `Key${value.toUpperCase()}`, ...options });
  return {
    keys,
    fallbacks,
    shortcuts,
    key,
    paste,
    dispatch,
    local: () => {
      remoteFocused = false;
    },
    revoke: () => {
      allowed = false;
      shortcuts.sync();
    },
    reconnect: () => {
      client = { sendKey: (...args) => keys.push(args) };
    },
    unauthorized: () => unauthorized,
  };
}

test("Ctrl+V allows native paste and sends remote Ctrl+V only after Unicode clipboard upload", async (t) => {
  let complete;
  const requests = [];
  const f = fixture(t, async (...args) => {
    requests.push(args);
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const key = f.key("v", { ctrlKey: true });
  assert.equal(key.defaultPrevented, false);
  const pasted = f.paste("Synthetic clipboard 😀\nSecond line");
  assert.equal(pasted.defaultPrevented, true);
  assert.deepEqual(requests, [["/api/clipboard", { text: "Synthetic clipboard 😀\nSecond line" }]]);
  assert.deepEqual(f.keys, []);
  complete({ written: true });
  await new Promise(setImmediate);
  assert.deepEqual(f.keys, [
    [0xff_e3, "ControlLeft", true],
    [0x76, "KeyV"],
    [0xff_e3, "ControlLeft", false],
  ]);
});

test("secure clipboard paste starts reading during Cmd+V and uploads only after the read completes", async (t) => {
  let complete;
  let reading = false;
  const requests = [];
  const f = fixture(
    t,
    async (...args) => {
      requests.push(args);
      return { written: true };
    },
    {
      readText: async () => {
        reading = true;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    },
  );
  const pressed = f.key("v", { metaKey: true });
  assert.equal(pressed.defaultPrevented, true);
  assert.equal(reading, true);
  assert.deepEqual(requests, []);
  complete("Mac clipboard text");
  await new Promise(setImmediate);
  assert.deepEqual(requests, [["/api/clipboard", { text: "Mac clipboard text" }]]);
  assert.equal(
    f.keys.some((entry) => entry[1] === "KeyV"),
    true,
  );
});

test("denied local clipboard reads never paste stale remote data", async (t) => {
  const requests = [];
  const f = fixture(
    t,
    async (...args) => {
      requests.push(args);
    },
    {
      readText: async () => {
        throw new Error("Clipboard permission denied.");
      },
    },
  );
  f.key("v", { ctrlKey: true });
  await new Promise(setImmediate);
  assert.deepEqual(requests, []);
  assert.deepEqual(f.keys, []);
  assert.equal(f.fallbacks[0][1], "Clipboard permission denied.");
});

test("Cmd shortcuts translate to Control and release it when Command or focus is released", async (t) => {
  const f = fixture(t, async () => ({ written: true }));
  const command = f.key("Meta", { code: "MetaLeft", metaKey: true });
  assert.equal(command.defaultPrevented, true);
  assert.equal(f.key("v", { metaKey: true }).defaultPrevented, false);
  f.paste("Command paste");
  await new Promise(setImmediate);
  assert.equal(
    f.keys.some((entry) => entry[1] === "KeyV"),
    true,
  );
  f.dispatch("keyup", { code: "MetaLeft" });
  assert.deepEqual(f.keys.at(-1), [0xff_e3, "ControlLeft", false]);
  f.key("Meta", { code: "MetaRight", metaKey: true });
  f.dispatch("focusout");
  assert.deepEqual(f.keys.at(-1), [0xff_e3, "ControlLeft", false]);
});

test("Ctrl+C begins the local clipboard write in the gesture before the remote read finishes", async (t) => {
  let resolveRead;
  let writing = false;
  let output;
  const f = fixture(
    t,
    async () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    {
      write: async ([item]) => {
        writing = true;
        output = await (await item.getType("text/plain")).text();
      },
    },
  );
  const copied = f.key("c", { ctrlKey: true });
  assert.equal(copied.defaultPrevented, true);
  assert.equal(writing, true);
  assert.equal(resolveRead, undefined);
  await new Promise((resolve) => {
    setTimeout(resolve, 280);
  });
  resolveRead({ text: "Copied remote text 😀" });
  await new Promise(setImmediate);
  assert.equal(output, "Copied remote text 😀");
  assert.deepEqual(f.fallbacks, []);
});

test("HTTP and denied clipboard writes preserve copied text in the panel fallback", async (t) => {
  for (const clipboardApi of [
    undefined,
    {
      write: async () => {
        throw new Error("Clipboard permission denied.");
      },
    },
  ]) {
    const f = fixture(t, async () => ({ text: "Manual copy text" }), clipboardApi);
    f.key("c", { metaKey: true });
    await new Promise((resolve) => {
      setTimeout(resolve, 280);
    });
    assert.equal(f.fallbacks[0][0], "Manual copy text");
  }
});

test("control loss or a replaced VNC connection cancels a pending paste", async (t) => {
  for (const invalidate of ["revoke", "reconnect"]) {
    let complete;
    const f = fixture(
      t,
      async () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    f.paste("Pending paste");
    f[invalidate]();
    complete({ written: true });
    await new Promise(setImmediate);
    assert.deepEqual(f.keys, []);
    assert.deepEqual(f.fallbacks, []);
  }
});

test("control loss during copy prevents writing late clipboard data to the device", async (t) => {
  let complete;
  let writes = 0;
  const f = fixture(
    t,
    async () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    {
      write: async ([item]) => {
        await item.getType("text/plain");
        writes++;
      },
    },
  );
  f.key("c", { ctrlKey: true });
  await new Promise((resolve) => {
    setTimeout(resolve, 280);
  });
  f.revoke();
  complete({ text: "Late private text" });
  await new Promise(setImmediate);
  assert.equal(writes, 0);
  assert.deepEqual(f.fallbacks, []);
});

test("local inputs, observation mode, modified shortcuts, and empty pastes preserve clipboard state", async (t) => {
  const requests = [];
  const f = fixture(t, async (...args) => {
    requests.push(args);
  });
  assert.equal(f.key("c", { ctrlKey: true, shiftKey: true }).defaultPrevented, false);
  assert.equal(f.key("v", { ctrlKey: true, altKey: true }).defaultPrevented, false);
  f.paste("");
  assert.equal(f.fallbacks.length, 1);
  assert.deepEqual(requests, []);
  f.local();
  assert.equal(f.key("c", { ctrlKey: true }).defaultPrevented, false);
  assert.equal(f.paste("Local input").defaultPrevented, false);
  f.revoke();
  assert.equal(f.key("v", { metaKey: true }).defaultPrevented, false);
  assert.deepEqual(requests, []);
});
