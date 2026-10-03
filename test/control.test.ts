import test from "node:test";
import assert from "node:assert/strict";
import { Control } from "../src/control.js";
import { Auth } from "../src/auth.js";

test("takeover drains an existing operation and blocks new operations", () => {
  const control = new Control();
  const finish = control.begin();
  assert.equal(control.take("alice").mode, "pending");
  assert.throws(() => control.begin(), /Human control/);
  assert.equal(control.canControl("alice"), false);
  finish();
  assert.equal(control.canControl("alice"), true);
  assert.equal(control.canControl("bob"), false);
  assert.throws(() => control.take("bob"), /Another user/);
  assert.throws(() => control.release("bob"), /Another user/);
  control.release("alice");
  control.begin()();
});

test("an abandoned lease expires and cannot be renewed by another session", () => {
  let now = 0;
  const control = new Control({ now: () => now, leaseMs: 100 });
  control.take("alice");
  assert.throws(() => control.renew("bob"), /do not own/);
  now = 50;
  control.renew("alice");
  now = 110;
  assert.equal(control.canControl("alice"), true);
  now = 151;
  assert.equal(control.canControl("alice"), false);
  assert.equal(control.status("alice").mode, "agent");
});

test("uncertain upstream completion fails closed, including human takeover", () => {
  const control = new Control();
  const finish = control.begin();
  control.take("alice");
  finish(new Error("Lost connection"));
  finish();
  assert.equal(control.active, 0);
  assert.equal(control.status("alice").ready, false);
  assert.equal(control.canControl("alice"), false);
  assert.throws(() => control.take("alice"), /Restart/);
  control.release("alice");
  assert.throws(() => control.begin(), /Restart/);
});

test("parallel agent operations cannot race over the shared browser", () => {
  const control = new Control();
  const finish = control.begin();
  assert.throws(() => control.begin(), /Another browser operation/);
  finish();
  control.begin()();
});

test("native human actions remain exclusive after release and allow owner VNC input", () => {
  const control = new Control();
  assert.throws(() => control.beginHuman("alice"), /Take control/);
  control.take("alice");
  const finish = control.beginHuman("alice");
  assert.equal(control.canControl("alice"), true);
  assert.throws(() => control.beginHuman("alice"), /Another browser operation/);
  control.release("alice");
  assert.throws(() => control.begin(), /Another browser operation/);
  assert.equal(control.take("bob").mode, "pending");
  assert.equal(control.canControl("bob"), false);
  finish();
  assert.equal(control.canControl("bob"), true);
});

test("expired human leases do not release an unfinished native action to the agent", () => {
  let now = 0;
  const control = new Control({ leaseMs: 10, now: () => now });
  control.take("alice");
  const finish = control.beginHuman("alice");
  now = 11;
  assert.equal(control.canControl("alice"), false);
  assert.throws(() => control.begin(), /Another browser operation/);
  finish(new Error("Native navigation completion is unknown"));
  assert.throws(() => control.begin(), /Restart/);
});

test("UI sessions expire independently of the access token", () => {
  let now = 0;
  const token = "test-token-".repeat(8);
  const auth = new Auth(token, { now: () => now, sessionMs: 100 });
  const id = auth.createSession();
  const req = { headers: { cookie: auth.cookie(id) } };
  assert.deepEqual(auth.identify(req), { type: "session", id });
  assert.equal(auth.validToken(`${token}wrong`), false);
  now = 101;
  assert.equal(auth.identify(req), null);
  assert.deepEqual(
    auth.identify({ headers: { authorization: `Bearer ${token}` } }),
    { type: "bearer" },
  );
  auth.cleanup();
  assert.equal(auth.sessions.size, 0);
});

test("agent handoff keeps human input for exactly five seconds, then reserves agent control", async () => {
  let now = 0;
  const control = new Control({ now: () => now });
  control.take("alice");
  const waiting = control.beginAgent();
  assert.equal(control.status("alice").agentRequest.deadline, 5000);
  assert.equal(control.status("bob").agentRequest, null);
  assert.equal(control.canControl("alice"), true);
  assert.throws(() => control.beginAgent(), /Another agent/);
  now = 4999;
  control.tick();
  assert.equal(control.canControl("alice"), true);
  now = 5000;
  control.tick();
  const finish = await waiting;
  assert.equal(control.canControl("alice"), false);
  assert.equal(control.status("alice").agentRequest, null);
  assert.equal(control.active, 1);
  assert.throws(() => control.begin(), /Another browser operation/);
  finish();
});

test("only the owner can cancel the current handoff and repeated prompts have a cooldown", async () => {
  let now = 0;
  const control = new Control({ now: () => now });
  control.take("alice");
  const waiting = control.beginAgent();
  const rejected = assert.rejects(waiting, /cancelled/);
  const id = control.status("alice").agentRequest.id;
  assert.throws(() => control.cancelAgent("bob", id), /Only the control owner/);
  assert.throws(
    () => control.cancelAgent("alice", "old-request"),
    /already ended/,
  );
  now = 4999;
  control.cancelAgent("alice", id);
  await rejected;
  assert.equal(control.canControl("alice"), true);
  assert.equal(control.active, 0);
  assert.throws(() => control.beginAgent(), /Retry in 30 seconds/);
  control.release("alice");
  (await control.beginAgent())();
});

test("handoff revokes VNC at its deadline but waits for native actions to drain", async () => {
  let now = 0;
  const control = new Control({ now: () => now });
  control.take("alice");
  const nativeFinish = control.beginHuman("alice");
  const waiting = control.beginAgent();
  const id = control.status("alice").agentRequest.id;
  now = 5000;
  control.tick();
  assert.equal(control.canControl("alice"), false);
  assert.equal(control.active, 1);
  assert.throws(
    () => control.cancelAgent("alice", id),
    /Only the control owner/,
  );
  assert.throws(() => control.take("alice"), /handoff finishes/);
  nativeFinish();
  const agentFinish = await waiting;
  assert.equal(control.active, 1);
  agentFinish();
});

test("disconnects and uncertain native completion cancel pending handoffs without executing", async () => {
  const control = new Control();
  control.take("alice");
  const abort = new AbortController();
  const waiting = control.beginAgent({ signal: abort.signal });
  const rejected = assert.rejects(waiting, /disconnected/);
  abort.abort();
  await rejected;
  assert.equal(control.canControl("alice"), true);
  assert.equal(control.active, 0);
  const nativeFinish = control.beginHuman("alice");
  const next = control.beginAgent();
  const faulted = assert.rejects(next, /Restart/);
  nativeFinish(new Error("Unknown native completion"));
  await faulted;
  assert.equal(control.active, 0);
  assert.equal(control.canControl("alice"), false);
});

test("manual return grants a waiting agent early and rechecks authorization before transfer", async () => {
  let now = 0,
    allowed = true;
  const control = new Control({ now: () => now });
  control.take("alice");
  const waiting = control.beginAgent();
  control.release("alice");
  (await waiting)();
  control.take("alice");
  const next = control.beginAgent({
    beforeStart: () => {
      if (!allowed) throw new Error("Revoked");
    },
  });
  const rejected = assert.rejects(next, /Revoked/);
  allowed = false;
  now = 5000;
  control.tick();
  await rejected;
  assert.equal(control.canControl("alice"), true);
  assert.equal(control.active, 0);
});
