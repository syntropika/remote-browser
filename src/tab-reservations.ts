import { randomUUID } from "node:crypto";

export type TabCredentials = { owner?: string; leaseId?: string };
type ReservationOptions = { task?: string; ttlMs?: number };
type Reservation = {
  tabId: string;
  leaseId: string;
  owner: string;
  task: string;
  ttlMs: number;
  expiresAt: number;
};

// Reservations coordinate trusted clients; native Playwright remains available.
export class TabReservations {
  private readonly leases = new Map<string, Reservation>();
  private readonly now: () => number;

  constructor(now = Date.now) {
    this.now = now;
  }

  private current(tabId: string) {
    const lease = this.leases.get(tabId);
    if (lease && lease.expiresAt <= this.now()) {
      this.leases.delete(tabId);
      return undefined;
    }
    return lease;
  }

  check(tabId: string, credentials: TabCredentials, requireLease = false) {
    const lease = this.current(tabId);
    if (!lease) {
      if (requireLease) {
        throw new Error("Tab reservation expired or was released. Reserve the tab again.");
      }
      return;
    }
    if (lease.owner !== credentials.owner || lease.leaseId !== credentials.leaseId) {
      throw new Error(
        `Tab is reserved for another task until ${new Date(lease.expiresAt).toISOString()}. Use another tab or retry after release or expiry.`,
      );
    }
  }

  reserve(tabId: string, credentials: TabCredentials, options: ReservationOptions = {}) {
    if (!credentials.owner) {
      throw new Error("Tab reservations require an authenticated MCP client.");
    }
    const { task = "Agent task", ttlMs = 300_000 } = options;
    if (typeof task !== "string" || !task.trim() || task.length > 120) {
      throw new Error("Use a short task label.");
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000) {
      throw new Error("Use ttlMs between 1000 and 300000.");
    }
    this.check(tabId, credentials);
    const lease = {
      tabId,
      leaseId: this.current(tabId)?.leaseId || randomUUID(),
      owner: credentials.owner,
      task,
      ttlMs,
      expiresAt: this.now() + ttlMs,
    };
    this.leases.set(tabId, lease);
    return this.result(lease);
  }

  renew(tabId: string, credentials: TabCredentials, ttlMs?: number) {
    this.check(tabId, credentials, true);
    const lease = this.current(tabId);
    if (!lease) {
      throw new Error("Tab reservation expired. Reserve the tab again.");
    }
    return this.reserve(tabId, credentials, { task: lease.task, ttlMs: ttlMs ?? lease.ttlMs });
  }

  release(tabId: string, credentials: TabCredentials) {
    this.check(tabId, credentials, true);
    this.leases.delete(tabId);
    return { tabId, released: true };
  }

  forget(tabId: string) {
    this.leases.delete(tabId);
  }

  retain(ids: Set<string>) {
    for (const id of this.leases.keys()) {
      if (!ids.has(id)) {
        this.leases.delete(id);
      }
    }
  }

  status(tabId: string) {
    const lease = this.current(tabId);
    return lease ? { task: lease.task, expiresAt: lease.expiresAt } : null;
  }

  private result({ owner: _owner, ...lease }: Reservation) {
    return lease;
  }
}
