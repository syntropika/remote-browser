"""Check the dashboard's actual pointer handlers at their event-handler seam.

The pointer handler block of ui/index.html runs in a Node VM with a minimal canvas, window and
action boundary. The checks cover which tab and profile receive each input action: a press
and its movement and release stay on the view that received the press, other pointers are
ignored, a press that ends without an observable release (lost capture, pointer cancellation,
window blur, hidden page) sends the native `cancel` command to the pressed view instead of any
release, and ordinary movement coalescing, reservation checks and touch taps are kept.
pointer_cancel_smoke.py checks what the native `cancel` command does in the engine.
"""
import argparse
import os
import pathlib
import shutil
import subprocess

HARNESS = r'''
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(process.env.REMOTE_BROWSER_DASHBOARD_HTML, "utf8");
const start = html.indexOf('      let pointerType = "mouse",');
const end = html.indexOf('      canvas.addEventListener("keydown",', start);
assert.ok(start > 0 && end > start, "pointer handler block not found");
const block = html.slice(start, end);

function dashboard({ editable = true } = {}) {
  const handlers = {}, windowHandlers = {}, documentHandlers = {};
  const actions = [], taps = [], notices = [], captured = new Set();
  const context = vm.createContext({
    canvas: {
      addEventListener: (name, callback) => (handlers[name] = callback),
      focus() {},
      setPointerCapture: (id) => captured.add(id),
      hasPointerCapture: (id) => captured.has(id),
      releasePointerCapture(id) {
        captured.delete(id);
        handlers.lostpointercapture?.({ pointerId: id, pointerType: "mouse" });
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }),
    },
    // Each action completes on a later turn, so input queues up as it does in a browser.
    action: (op, args, tab, profile) =>
      new Promise((resolve) => setImmediate(() => resolve(actions.push({ op, ...args, tab, profile })))),
    editable: () => editable,
    notice: (message) => message && notices.push(message),
    enqueueInput: (args) => taps.push(args),
    window: { addEventListener: (name, callback) => (windowHandlers[name] = callback) },
    document: { hidden: false, addEventListener: (name, callback) => (documentHandlers[name] = callback) },
  });
  vm.runInContext(
    'let tabId = "tab-a", profileId = "profile-a", viewReady = true, inputQueue = Promise.resolve(), suppressClickUntil = 0;',
    context,
  );
  vm.runInContext(block, context);
  // As in browsers, capture is released implicitly right after pointerup.
  const pointer = (name, fields = {}) => {
    const event = { pointerType: "mouse", pointerId: 1, button: 0, clientX: 100, clientY: 100, ...fields };
    handlers[name](event);
    if (name === "pointerup" && captured.delete(event.pointerId))
      handlers.lostpointercapture?.({ pointerId: event.pointerId, pointerType: "mouse" });
  };
  return {
    pointer,
    select: (tab, profile) =>
      vm.runInContext(`tabId = ${JSON.stringify(tab)}; profileId = ${JSON.stringify(profile)};`, context),
    blur: () => windowHandlers.blur?.(),
    hide() {
      context.document.hidden = true;
      documentHandlers.visibilitychange?.();
    },
    // A non-primary press only records the pointer type that the click handler checks.
    click(pointerType) {
      handlers.pointerdown({ pointerType, pointerId: 9, button: 1, clientX: 5, clientY: 6 });
      handlers.click({ clientX: 5, clientY: 6 });
    },
    settled: async () => {
      await vm.runInContext("inputQueue", context);
      return actions;
    },
    taps,
    notices,
  };
}

const summary = (actions) => actions.map(({ kind, tab, profile }) => `${kind}@${tab}/${profile}`);

test("a press, its movement and its release reach one view in order", async () => {
  const view = dashboard();
  view.pointer("pointerdown");
  view.pointer("pointermove", { clientX: 110 });
  view.pointer("pointermove", { clientX: 120 });
  view.pointer("pointermove", { clientX: 130 });
  view.pointer("pointerup", { clientX: 130 });
  const actions = await view.settled();
  // Moves waiting behind the press collapse into the latest position.
  assert.deepEqual(summary(actions), ["down@tab-a/profile-a", "move@tab-a/profile-a", "up@tab-a/profile-a"]);
  assert.equal(actions[1].x, 130);
  assert.equal(actions[2].x, 130);
});

test("a selection change during a press keeps movement and release on the pressed view", async () => {
  const view = dashboard();
  view.pointer("pointerdown");
  view.select("tab-b", "profile-b");
  view.pointer("pointermove", { clientX: 140 });
  view.pointer("pointerup", { clientX: 140 });
  await view.settled();
  // After the release, hover movement follows the current selection again.
  view.pointer("pointermove", { clientX: 150 });
  assert.deepEqual(summary(await view.settled()), [
    "down@tab-a/profile-a",
    "move@tab-a/profile-a",
    "up@tab-a/profile-a",
    "move@tab-b/profile-b",
  ]);
});

test("other pointers neither move, press nor release a held press", async () => {
  const view = dashboard();
  view.pointer("pointerdown");
  view.pointer("pointermove", { pointerId: 2, clientX: 300 });
  view.pointer("pointerdown", { pointerId: 2 });
  view.pointer("pointerup", { pointerId: 2 });
  view.pointer("pointercancel", { pointerId: 2 });
  view.pointer("pointerup", { clientX: 104 });
  const actions = await view.settled();
  assert.deepEqual(summary(actions), ["down@tab-a/profile-a", "up@tab-a/profile-a"]);
  assert.equal(actions[1].x, 104);
});

for (const [name, finish] of [
  ["lost pointer capture", (view) => view.pointer("lostpointercapture")],
  ["pointer cancellation", (view) => view.pointer("pointercancel")],
  ["window blur", (view) => view.blur()],
  ["hidden page", (view) => view.hide()],
]) {
  test(`${name} cancels the press natively on the pressed view, without a release`, async () => {
    const view = dashboard();
    view.pointer("pointerdown");
    view.pointer("pointermove", { clientX: 120 });
    view.select("tab-b", "profile-b");
    finish(view);
    // A late release or movement of the cancelled press is not delivered as part of it.
    view.pointer("pointerup");
    view.pointer("pointercancel");
    const actions = await view.settled();
    assert.deepEqual(summary(actions), ["down@tab-a/profile-a", "move@tab-a/profile-a", "cancel@tab-a/profile-a"]);
    // The cancel command carries no position: it is not a release somewhere else.
    assert.deepEqual(Object.keys(actions[2]).sort(), ["kind", "op", "profile", "tab"]);
    assert.equal(actions[2].op, "input");
    assert.ok(!actions.some((action) => ["up", "click", "leave"].includes(action.kind)));
  });
}

test("a repeated press from the same pointer first ends the undelivered one", async () => {
  const view = dashboard();
  view.pointer("pointerdown");
  view.select("tab-b", "profile-b");
  view.pointer("pointerdown", { clientX: 900, clientY: 700 });
  view.pointer("pointerup", { clientX: 900, clientY: 700 });
  assert.deepEqual(summary(await view.settled()), [
    "down@tab-a/profile-a",
    "cancel@tab-a/profile-a",
    "down@tab-b/profile-b",
    "up@tab-b/profile-b",
  ]);
});

test("reserved or unready views receive no pointer input", async () => {
  const view = dashboard({ editable: false });
  view.pointer("pointermove");
  view.pointer("pointerdown");
  view.pointer("pointerup");
  assert.deepEqual(await view.settled(), []);
  assert.equal(view.notices.length, 1);
});

test("touch keeps tap clicks and mouse clicks are not repeated", async () => {
  const view = dashboard();
  view.click("touch");
  view.click("mouse");
  // The arguments come from the VM realm, so compare their values.
  assert.deepEqual(JSON.parse(JSON.stringify(view.taps)), [{ kind: "click", x: 5, y: 6 }]);
  assert.deepEqual(await view.settled(), []);
});
'''


def exercise(node, dashboard):
    result = subprocess.run([node, '--test-reporter=spec', '--input-type=module', '-'], input=HARNESS, text=True,
                            capture_output=True, env=dict(os.environ, REMOTE_BROWSER_DASHBOARD_HTML=str(dashboard)), timeout=120)
    counts = [line.removeprefix('ℹ ') for line in result.stdout.splitlines() if line.startswith(('ℹ pass', 'ℹ fail'))]
    assert result.returncode == 0, result.stdout + result.stderr
    print('PASS: dashboard pointer presses stay on their view and cancel without a click (' + ', '.join(counts) + ')')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', default=shutil.which('node'), help='Node.js executable (default: node on PATH)')
    parser.add_argument('--dashboard', type=pathlib.Path,
                        default=pathlib.Path(__file__).resolve().parent.parent / 'ui' / 'index.html')
    arguments = parser.parse_args()
    assert arguments.node, 'Node.js is required (--node)'
    exercise(arguments.node, arguments.dashboard)
