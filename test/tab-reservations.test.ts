import assert from "node:assert/strict";
import test from "node:test";

import { TabReservations } from "../src/tab-reservations.js";

test("leases are exclusive to a task token and API key, and expire without a timer", () => {
  let now = 1000;
  const tabs = new TabReservations(() => now);
  const lease = tabs.reserve("tab", { owner: "a" }, { task: "Research", ttlMs: 1000 });
  const credentials = { owner: "a", leaseId: lease.leaseId };
  assert.equal(lease.expiresAt, 2000);
  assert.equal("owner" in lease, false);
  tabs.check("tab", credentials, true);
  assert.throws(() => tabs.reserve("tab", { owner: "a" }), /reserved/u);
  assert.throws(() => tabs.reserve("tab", { owner: "b", leaseId: lease.leaseId }), /reserved/u);
  assert.throws(() => tabs.release("tab", { owner: "a", leaseId: "wrong" }), /reserved/u);
  now = 2000;
  assert.equal(tabs.status("tab"), null);
  assert.throws(() => tabs.check("tab", credentials, true), /expired/u);
  const replacement = tabs.reserve("tab", { owner: "b" });
  assert.notEqual(replacement.leaseId, lease.leaseId);
  assert.throws(() => tabs.check("tab", credentials, true), /reserved/u);
});

test("renewal extends the lease and retains its token; release and closing discard it", () => {
  let now = 0;
  const tabs = new TabReservations(() => now);
  const lease = tabs.reserve("tab", { owner: "a" }, { ttlMs: 1000 });
  const credentials = { owner: "a", leaseId: lease.leaseId };
  now = 500;
  const renewed = tabs.renew("tab", credentials);
  assert.equal(renewed.expiresAt, 1500);
  assert.equal(renewed.leaseId, lease.leaseId);
  tabs.release("tab", credentials);
  tabs.check("tab", { owner: "b" });
  tabs.reserve("tab", { owner: "b" });
  tabs.forget("tab");
  assert.equal(tabs.status("tab"), null);
  tabs.reserve("closed", { owner: "a" });
  tabs.reserve("open", { owner: "a" });
  tabs.retain(new Set(["open"]));
  assert.equal(tabs.status("closed"), null);
  assert.ok(tabs.status("open"));
});

test("invalid reservations do not change existing ownership or expiry", () => {
  const tabs = new TabReservations(() => 0);
  assert.throws(() => tabs.reserve("tab", {}), /authenticated/u);
  for (const ttlMs of [0, 999, 300_001, 1.5, Number.NaN]) {
    assert.throws(() => tabs.reserve("tab", { owner: "a" }, { ttlMs }), /ttlMs/u);
  }
  const lease = tabs.reserve("tab", { owner: "a" });
  assert.throws(() => tabs.renew("tab", { owner: "a", leaseId: lease.leaseId }, 0), /ttlMs/u);
  assert.deepEqual(tabs.status("tab"), { task: "Agent task", expiresAt: 300_000 });
});
