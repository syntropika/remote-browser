import assert from "node:assert/strict";
import test from "node:test";

import { createMobileKeyboard } from "../ui/mobile-keyboard.js";

class Element extends EventTarget {
  constructor(ownerDocument) {
    super();
    this.ownerDocument = ownerDocument;
  }
  value = "";
  placeholder = "Tap a field, then type";
  hidden = false;
  disabled = false;
  focused = false;
  attributes = new Map();
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  contains(element) {
    return (
      element === this || Boolean(element?.parentElement && this.contains(element.parentElement))
    );
  }
  focus() {
    if (this.focused) {
      return;
    }
    this.ownerDocument.activeElement?.blur();
    this.ownerDocument.activeElement = this;
    this.focused = true;
    this.dispatchEvent(new Event("focus"));
  }
  blur() {
    this.focused = false;
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
    this.dispatchEvent(new Event("blur"));
  }
}

function emit(element, type, properties = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, properties);
  element.dispatchEvent(event);
  return event;
}

function fixture({ open = true, initiallyAllowed = true } = {}) {
  let allowed = initiallyAllowed;
  let openCount = 0;
  const sent = [];
  const errors = [];
  const ownerDocument = { activeElement: null };
  let rfb = {
    focusOnClick: true,
    viewOnly: false,
    sendKey: (...key) => sent.push(key),
  };
  const elements = Object.fromEntries(
    ["input", "panel", "button", "closeButton", "enterButton"].map((name) => [
      name,
      new Element(ownerDocument),
    ]),
  );
  for (const [name, element] of Object.entries(elements)) {
    if (!["panel", "button"].includes(name)) {
      element.parentElement = elements.panel;
    }
  }
  const keyboard = createMobileKeyboard({
    ...elements,
    getRfb: () => rfb,
    canControl: () => allowed,
    onError: (error) => errors.push(error),
    onOpen: () => {
      openCount += 1;
    },
  });
  if (open) {
    keyboard.open();
  }
  const sentinel = "\u200B";
  function type(text, inputType = "insertText") {
    const before = emit(elements.input, "beforeinput", {
      data: text,
      inputType,
    });
    if (before.defaultPrevented) {
      return;
    }
    elements.input.value += text;
    emit(elements.input, "input", { data: text, inputType });
  }
  return {
    ...elements,
    keyboard,
    sent,
    errors,
    sentinel,
    type,
    openCount: () => openCount,
    rfb: () => rfb,
    revoke: () => {
      allowed = false;
    },
    grant: () => {
      allowed = true;
    },
    disconnect: () => {
      rfb = null;
    },
    replaceRfb: () => {
      rfb = {
        focusOnClick: true,
        viewOnly: false,
        sendKey: (...key) => sent.push(key),
      };
    },
  };
}

test("native text, autofill, and Unicode use keysyms without retaining typed text", () => {
  const f = fixture();
  assert.equal(f.input.focused, true);
  assert.equal(f.rfb().focusOnClick, false);
  f.type("A");
  f.type("é你😀", "insertReplacementText");
  assert.deepEqual(
    f.sent.map(([keysym]) => keysym),
    [0x41, 0xe9, 0x01_00_4f_60, 0x01_01_f6_00],
  );
  assert.equal(f.input.value, f.sentinel);
  assert.equal(f.input.selectionStart, f.sentinel.length);
});

test("backspace works with an empty bridge and forward delete stays distinct", () => {
  const f = fixture();
  for (const inputType of [
    "deleteContentBackward",
    "deleteContentBackward",
    "deleteContentForward",
  ]) {
    assert.equal(emit(f.input, "beforeinput", { inputType }).defaultPrevented, true);
  }
  assert.deepEqual(f.sent, [
    [0xff_08, "Backspace"],
    [0xff_08, "Backspace"],
    [0xff_ff, "Delete"],
  ]);
  assert.equal(f.input.value, f.sentinel);
});

test("IME commits once whether final input comes before or after compositionend", () => {
  for (const finalBeforeEnd of [true, false]) {
    const f = fixture();
    emit(f.input, "compositionstart");
    f.input.value = `${f.sentinel}に`;
    emit(f.input, "input", {
      data: "に",
      inputType: "insertCompositionText",
      isComposing: true,
    });
    assert.deepEqual(f.sent, []);
    f.input.value = `${f.sentinel}你`;
    if (finalBeforeEnd) {
      emit(f.input, "input", {
        data: "你",
        inputType: "insertFromComposition",
      });
    }
    emit(f.input, "compositionend", { data: "你" });
    if (!finalBeforeEnd) {
      f.input.value = `${f.sentinel}你`;
      emit(f.input, "input", {
        data: "你",
        inputType: "insertFromComposition",
      });
    }
    assert.deepEqual(f.sent, [[0x01_00_4f_60, undefined]]);
    f.type("你");
    assert.equal(f.sent.length, 2, "the next independent character must not be swallowed");
    assert.equal(f.input.value, f.sentinel);
  }
});

test("changing remote field cancels unfinished composition", () => {
  const f = fixture();
  emit(f.input, "compositionstart");
  f.input.value += "private";
  f.keyboard.reset();
  emit(f.input, "compositionend", { data: "private" });
  assert.deepEqual(f.sent, []);
  assert.equal(f.input.value, f.sentinel);
});

test("paste sends Unicode, line breaks and tabs once and bounds the operation", () => {
  const f = fixture();
  const paste = (value) => emit(f.input, "paste", { clipboardData: { getData: () => value } });
  assert.equal(paste("a\r\nb\tc").defaultPrevented, true);
  assert.deepEqual(f.sent, [
    [0x61, undefined],
    [0xff_0d, "Enter"],
    [0x62, undefined],
    [0xff_09, "Tab"],
    [0x63, undefined],
  ]);
  paste("x".repeat(4097));
  assert.equal(f.sent.length, 5);
  assert.equal(f.errors.length, 1);
  assert.equal(f.input.value, f.sentinel);
});

test("the Enter button and native Enter keep focus and send synchronously", () => {
  const f = fixture();
  emit(f.enterButton, "click");
  assert.equal(emit(f.input, "keydown", { key: "Enter" }).defaultPrevented, true);
  assert.deepEqual(
    f.sent.map(([keysym]) => keysym),
    [0xff_0d, 0xff_0d],
  );
  assert.equal(f.input.focused, true);
});

test("physical Tab and Shift+Tab leave native focus navigation available", () => {
  const f = fixture();
  for (const shiftKey of [false, true]) {
    const event = emit(f.input, "keydown", { key: "Tab", shiftKey });
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(f.sent, []);
  assert.equal(f.panel.hidden, false);
});

test("physical Escape dismisses the local keyboard and restores its trigger", () => {
  for (const target of ["input", "panel"]) {
    const f = fixture();
    const event = emit(f[target], "keydown", { key: "Escape" });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(f.sent, []);
    assert.equal(f.panel.hidden, true);
    assert.equal(f.input.value, "");
    assert.equal(f.input.focused, false);
    assert.equal(f.button.focused, true);
    assert.equal(f.rfb().focusOnClick, true);
  }
});

test("Escape remains available to an unfinished IME composition", () => {
  const f = fixture();
  emit(f.input, "compositionstart");
  const event = emit(f.input, "keydown", { key: "Escape", isComposing: true });
  assert.equal(event.defaultPrevented, false);
  assert.equal(f.panel.hidden, false);
  assert.deepEqual(f.sent, []);
});

test("lease loss and disconnection close, blur, and wipe without sending", () => {
  for (const loseAccess of ["revoke", "disconnect"]) {
    const f = fixture();
    const originalRfb = f.rfb();
    f.input.value += "private";
    f[loseAccess]();
    f.keyboard.sync();
    emit(f.input, "input", { data: "private", inputType: "insertText" });
    emit(f.enterButton, "click");
    assert.deepEqual(f.sent, []);
    assert.equal(f.input.value, "");
    assert.equal(f.input.focused, false);
    assert.equal(f.panel.hidden, true);
    assert.equal(f.button.disabled, true);
    assert.equal(originalRfb.focusOnClick, true);
  }
});

test("every key rechecks control even if ownership changes during a text operation", () => {
  const f = fixture();
  const originalSend = f.rfb().sendKey;
  f.rfb().sendKey = (...key) => {
    originalSend(...key);
    f.revoke();
  };
  f.type("abc");
  assert.deepEqual(f.sent, [[0x61, undefined]]);
  assert.equal(f.input.value, "");
  assert.equal(f.panel.hidden, true);
});

test("inline input stays visible and only a direct focus activates the bridge", () => {
  const f = fixture({ open: false, initiallyAllowed: false });
  f.keyboard.setInline(true);
  assert.equal(f.panel.hidden, false);
  assert.equal(f.button.attributes.get("aria-expanded"), "true");
  assert.equal(f.input.disabled, true);
  assert.equal(f.input.placeholder, "Take control to type");
  assert.equal(f.enterButton.disabled, true);
  assert.equal(f.input.value, "");
  assert.equal(f.input.focused, false);
  assert.equal(f.rfb().focusOnClick, true);
  assert.equal(f.openCount(), 0);

  f.grant();
  f.keyboard.sync();
  assert.equal(f.input.disabled, false);
  assert.equal(f.input.placeholder, "Tap a field, then type");
  assert.equal(f.input.focused, false, "granting control must not open the native keyboard");
  assert.equal(f.rfb().focusOnClick, true);
  f.input.focus();
  assert.equal(f.input.value, f.sentinel);
  assert.equal(f.rfb().focusOnClick, false);
  assert.equal(f.openCount(), 1);
  f.type("a");
  assert.deepEqual(f.sent, [[0x61, undefined]]);
});

test("inline lease loss wipes and disables the visible bridge without refocusing on renewal", () => {
  const f = fixture({ open: false });
  f.keyboard.setInline(true);
  f.input.focus();
  emit(f.input, "compositionstart");
  f.input.value += "private";
  f.revoke();
  f.keyboard.sync();
  emit(f.input, "compositionend", { data: "private" });
  assert.deepEqual(f.sent, []);
  assert.equal(f.panel.hidden, false);
  assert.equal(f.input.value, "");
  assert.equal(f.input.disabled, true);
  assert.equal(f.input.focused, false);
  assert.equal(f.rfb().focusOnClick, true);
  f.grant();
  f.keyboard.sync();
  assert.equal(f.input.disabled, false);
  assert.equal(f.input.focused, false);
  assert.equal(f.openCount(), 1);
});

test("inline disconnection and RFB replacement release focus ownership and keep the panel visible", () => {
  for (const changeRfb of ["disconnect", "replaceRfb"]) {
    const f = fixture({ open: false });
    f.keyboard.setInline(true);
    f.input.focus();
    const originalRfb = f.rfb();
    f.input.value += "private";
    f[changeRfb]();
    f.keyboard.sync();
    assert.equal(originalRfb.focusOnClick, true);
    assert.equal(f.panel.hidden, false);
    assert.equal(f.input.value, "");
    assert.equal(f.input.focused, false);
    assert.deepEqual(f.sent, []);
    if (changeRfb === "replaceRfb") {
      assert.equal(f.rfb().focusOnClick, true);
      f.input.focus();
      f.type("b");
      assert.equal(f.rfb().focusOnClick, false);
      assert.deepEqual(f.sent, [[0x62, undefined]]);
    } else {
      assert.equal(f.input.disabled, true);
      assert.equal(f.input.placeholder, "Connecting keyboard…");
    }
  }
});

test("inline Escape and close dismiss the keyboard while leaving an empty input ready", () => {
  for (const dismiss of ["escape", "close"]) {
    const f = fixture({ open: false });
    f.keyboard.setInline(true);
    f.input.focus();
    f.input.value += "private";
    if (dismiss === "escape") {
      emit(f.input, "keydown", { key: "Escape" });
    } else {
      emit(f.closeButton, "click");
    }
    assert.equal(f.panel.hidden, false);
    assert.equal(f.input.value, "");
    assert.equal(f.input.focused, false);
    assert.equal(f.button.focused, false, "the hidden desktop trigger must not receive focus");
    assert.equal(f.rfb().focusOnClick, true);
    assert.deepEqual(f.sent, []);
    f.input.focus();
    f.type("c");
    assert.deepEqual(f.sent, [[0x63, undefined]]);
  }
});

test("layout changes reset keyboard focus and preserve desktop toggle behavior", () => {
  const f = fixture();
  f.keyboard.setInline(true);
  assert.equal(f.panel.hidden, false);
  assert.equal(f.input.focused, false);
  assert.equal(f.rfb().focusOnClick, true);
  f.input.focus();
  f.keyboard.setInline(true);
  assert.equal(f.input.focused, true, "reapplying the same layout must preserve typing");
  f.keyboard.setInline(false);
  assert.equal(f.panel.hidden, true);
  assert.equal(f.input.focused, false);
  assert.equal(f.input.value, "");
  assert.equal(f.rfb().focusOnClick, true);
  emit(f.button, "click");
  assert.equal(f.panel.hidden, false);
  assert.equal(f.input.focused, true);
  emit(f.button, "click");
  assert.equal(f.panel.hidden, true);
  assert.equal(f.button.focused, true);
});

test("inline Enter activates synchronously before the input has been focused", () => {
  const f = fixture({ open: false });
  f.keyboard.setInline(true);
  emit(f.enterButton, "click");
  assert.deepEqual(f.sent, [[0xff_0d, "Enter"]]);
  assert.equal(f.input.focused, true);
  assert.equal(f.rfb().focusOnClick, false);
  assert.equal(f.openCount(), 1);
});

test("inline close clears focus within the panel while preserving external focus", () => {
  for (const target of ["closeButton", "enterButton", "external"]) {
    const f = fixture({ open: false });
    f.keyboard.setInline(true);
    f.input.focus();
    const focused = target === "external" ? new Element(f.input.ownerDocument) : f[target];
    focused.focus();
    if (target === "closeButton") {
      emit(f.closeButton, "click");
    } else if (target === "enterButton") {
      emit(f.panel, "keydown", { key: "Escape" });
    } else {
      f.keyboard.close();
    }
    assert.equal(f.panel.hidden, false);
    assert.equal(f.input.focused, false);
    assert.equal(focused.focused, target === "external");
    assert.equal(f.input.ownerDocument.activeElement, target === "external" ? focused : null);
    assert.equal(f.rfb().focusOnClick, true);
    assert.deepEqual(f.sent, []);
  }
});

test("inline Escape dismisses a panel control even before keyboard activation", () => {
  const f = fixture({ open: false });
  f.keyboard.setInline(true);
  f.enterButton.focus();
  const event = emit(f.panel, "keydown", { key: "Escape" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.enterButton.focused, false);
  assert.equal(f.panel.hidden, false);
  assert.equal(f.openCount(), 0);
  assert.deepEqual(f.sent, []);
});
