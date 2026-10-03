import assert from "node:assert/strict";
import test from "node:test";

import { createMobileScroll } from "../ui/mobile-scroll.js";

function fixture() {
  let enabled = true;
  const handlers = new Map();
  const received = [];
  const canvas = {
    tagName: "CANVAS",
    width: 1280,
    height: 800,
    getBoundingClientRect: () => ({ width: 320, height: 200 }),
    dispatchEvent: (event) => received.push(event),
  };
  const control = createMobileScroll({
    display: {
      addEventListener: (type, listener) => handlers.set(type, listener),
    },
    canScroll: () => enabled,
  });
  return {
    received,
    control,
    enable(value) {
      enabled = value;
    },
    send(type, gesture = "drag", x = 100, y = 200) {
      let intercepted = false;
      handlers.get(type)({
        type,
        target: canvas,
        detail: { type: gesture, clientX: x, clientY: y },
        stopImmediatePropagation() {
          intercepted = true;
        },
      });
      return intercepted;
    },
  };
}

test("fitted swipes scroll at the original remote position with display-scaled distance", () => {
  const f = fixture();
  assert.equal(f.send("gesturestart"), true);
  f.send("gesturemove", "drag", 105, 150);
  const { detail } = f.received.at(-1);
  assert.deepEqual(detail, {
    type: "twodrag",
    clientX: 100,
    clientY: 200,
    magnitudeX: 20,
    magnitudeY: -200,
  });
  f.send("gestureend", "drag", 105, 150);
  assert.equal(f.received.length, 3);
});

test("taps, existing multitouch gestures, and zoom panning keep their native handlers", () => {
  const f = fixture();
  for (const gesture of ["onetap", "twotap", "longpress", "twodrag", "pinch"]) {
    assert.equal(f.send("gesturestart", gesture), false);
  }
  f.enable(false);
  assert.equal(f.send("gesturestart"), false);
  assert.equal(f.send("gesturemove"), false);
  assert.equal(f.send("gestureend"), false);
  assert.equal(f.received.length, 0);
});

test("losing control cancels the whole swipe even if control returns before release", () => {
  const f = fixture();
  f.send("gesturestart");
  f.enable(false);
  assert.equal(f.send("gesturemove", "drag", 100, 150), true);
  f.enable(true);
  f.send("gesturemove", "drag", 100, 100);
  f.send("gestureend", "drag", 100, 100);
  assert.equal(f.received.length, 1);
  f.send("gesturestart");
  f.send("gesturemove", "drag", 100, 150);
  assert.equal(f.received.length, 3);
});

test("disconnect or display mode change suppresses the remaining drag", () => {
  const f = fixture();
  f.send("gesturestart");
  f.control.cancel();
  assert.equal(f.send("gesturemove", "drag", 100, 150), true);
  assert.equal(f.send("gestureend", "drag", 100, 150), true);
  assert.equal(f.received.length, 1);
});
