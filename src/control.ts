import { randomUUID } from "node:crypto";

import { attempt } from "./effects.js";
import { required } from "./invariants.js";

export type FinishOperation = (error?: unknown) => void;
type AgentRequest = {
  id: string;
  owner: string;
  deadline: number;
  resolve: (finish: FinishOperation) => void;
  reject: (error: unknown) => void;
  beforeStart: () => void;
  signal?: AbortSignal;
  abort?: () => void;
  timer?: NodeJS.Timeout;
  timeout?: NodeJS.Timeout;
};

// The lease belongs to an authenticated UI session, never to a browser tab.
export class Control {
  leaseMs: number;
  now: () => number;
  onChange: () => void;
  owner: string | null;
  expires: number;
  active: number;
  humanOperationOwner: string | null;
  fault: string | null;
  agentTakeoverMs: number;
  agentRequest: AgentRequest | null;
  revision: number;
  agentCooldownUntil: number;

  constructor({
    leaseMs = 90_000,
    agentTakeoverMs = 5000,
    now = Date.now,
    onChange = (): void => undefined,
  } = {}) {
    this.leaseMs = leaseMs;
    this.now = now;
    this.onChange = onChange;
    this.owner = null;
    this.expires = 0;
    this.active = 0;
    this.humanOperationOwner = null;
    this.fault = null;
    this.agentTakeoverMs = agentTakeoverMs;
    this.agentRequest = null;
    this.revision = 0;
    this.agentCooldownUntil = 0;
  }

  notify() {
    this.revision++;
    this.onChange();
  }

  tick() {
    if (this.owner && this.expires <= this.now()) {
      this.owner = null;
      this.expires = 0;
      this.notify();
    }
    this.advanceAgentRequest();
  }

  status(session?: string) {
    this.tick();
    return {
      mode: this.owner
        ? this.active && this.humanOperationOwner !== this.owner
          ? "pending"
          : "human"
        : "agent",
      ownsControl: Boolean(this.owner && session === this.owner),
      leaseExpiresAt: this.owner ? this.expires : null,
      activeOperations: this.active,
      ready: !this.fault,
      serverNow: this.now(),
      revision: this.revision,
      agentRequest:
        this.agentRequest && this.agentRequest.owner === session
          ? {
              id: this.agentRequest.id,
              deadline: this.agentRequest.deadline,
              canCancel: this.owner === session && this.now() < this.agentRequest.deadline,
            }
          : null,
      ...(this.fault ? { error: this.fault } : {}),
    };
  }

  take(session: string) {
    this.tick();
    if (this.fault) {
      throw new Error(this.fault);
    }
    if (this.agentRequest && !this.owner) {
      throw new Error("An agent is taking control. Wait until the handoff finishes.");
    }
    if (this.owner && this.owner !== session) {
      throw new Error("Another user has control.");
    }
    if (this.owner !== session) {
      this.agentCooldownUntil = 0;
    }
    this.owner = session;
    this.expires = this.now() + this.leaseMs;
    this.notify();
    return this.status(session);
  }

  renew(session: string) {
    this.tick();
    if (!this.owner || this.owner !== session) {
      throw new Error("You do not own control.");
    }
    this.expires = this.now() + this.leaseMs;
    this.notify();
    return this.status(session);
  }

  release(session: string) {
    this.tick();
    if (this.owner && this.owner !== session) {
      throw new Error("Another user has control.");
    }
    this.owner = null;
    this.expires = 0;
    this.agentCooldownUntil = 0;
    this.notify();
    this.advanceAgentRequest();
    return this.status(session);
  }

  begin() {
    this.tick();
    if (this.fault) {
      throw new Error(this.fault);
    }
    if (this.owner) {
      throw new Error(
        "Human control is active or pending. Wait until control is returned to the agent.",
      );
    }
    if (this.agentRequest) {
      throw new Error("Another agent is waiting for browser control. Retry after it completes.");
    }
    if (this.active) {
      throw new Error("Another browser operation is running. Retry after it completes.");
    }
    return this.beginOperation();
  }

  beginAgentEffect(options: { signal?: AbortSignal; beforeStart?: () => void } = {}) {
    return attempt(async () => this.beginAgent(options));
  }

  beginAgent({
    signal,
    beforeStart = (): void => undefined,
  }: {
    signal?: AbortSignal;
    beforeStart?: () => void;
  } = {}): Promise<FinishOperation> {
    this.tick();
    beforeStart();
    if (signal?.aborted) {
      throw new Error("The agent request was disconnected.");
    }
    if (this.fault) {
      throw new Error(this.fault);
    }
    if (this.agentRequest) {
      throw new Error("Another agent is waiting for browser control. Retry after it completes.");
    }
    if (!this.owner) {
      return Promise.resolve(this.begin());
    }
    if (this.active && this.humanOperationOwner !== this.owner) {
      throw new Error("Another browser operation is running. Retry after it completes.");
    }
    if (this.now() < this.agentCooldownUntil) {
      throw new Error("Human control was kept. Retry in 30 seconds or after control is returned.");
    }
    return new Promise<FinishOperation>((resolve, reject) => {
      const request: AgentRequest = {
        id: randomUUID(),
        owner: required(this.owner),
        deadline: this.now() + this.agentTakeoverMs,
        resolve,
        reject,
        beforeStart,
        signal,
      };
      // oxlint-disable-next-line unicorn/no-immediate-mutation -- Install request callbacks after capturing its stable identity.
      request.abort = () => {
        this.rejectAgentRequest(new Error("The agent request was disconnected."));
      };
      request.timer = setTimeout(() => {
        this.advanceAgentRequest();
      }, this.agentTakeoverMs);
      request.timeout = setTimeout(() => {
        this.rejectAgentRequest(
          new Error("The current browser action did not finish. Retry after it completes."),
        );
      }, this.agentTakeoverMs + 45_000);
      signal?.addEventListener("abort", request.abort, { once: true });
      this.agentRequest = request;
      this.notify();
    });
  }

  clearAgentRequest() {
    const request = this.agentRequest;
    if (!request) {
      return null;
    }
    this.agentRequest = null;
    clearTimeout(request.timer);
    clearTimeout(request.timeout);
    request.signal?.removeEventListener("abort", required(request.abort));
    return request;
  }

  rejectAgentRequest(error: unknown) {
    const request = this.clearAgentRequest();
    if (!request) {
      return;
    }
    request.reject(error);
    this.notify();
  }

  advanceAgentRequest() {
    const request = this.agentRequest;
    if (!request) {
      return;
    }
    if (this.fault) {
      this.rejectAgentRequest(new Error(this.fault));
      return;
    }
    if (this.owner && this.now() < request.deadline) {
      return;
    }
    try {
      request.beforeStart();
    } catch (cause) {
      this.rejectAgentRequest(cause);
      return;
    }
    if (this.owner) {
      this.owner = null;
      this.expires = 0;
      this.notify();
    }
    // Reserve the agent operation before notifying clients or resolving its
    // waiter. An unfinished native action must drain before that reservation.
    if (this.active || this.agentRequest !== request) {
      return;
    }
    this.clearAgentRequest();
    const finish = this.beginOperation();
    request.resolve(finish);
  }

  cancelAgent(session: string, id: unknown) {
    this.tick();
    if (!this.agentRequest || this.agentRequest.id !== id) {
      throw new Error("This control request has already ended.");
    }
    if (this.owner !== session || this.agentRequest.owner !== session) {
      throw new Error("Only the control owner can cancel this request.");
    }
    this.agentCooldownUntil = this.now() + 30_000;
    this.rejectAgentRequest(
      new Error(
        "Human control request cancelled. Retry in 30 seconds or after control is returned.",
      ),
    );
    return this.status(session);
  }

  close() {
    this.rejectAgentRequest(new Error("The browser gateway is shutting down."));
  }

  beginHuman(session: string) {
    if (!this.canControl(session)) {
      throw new Error("Take control before using the browser controls.");
    }
    if (this.active) {
      throw new Error("Another browser operation is running. Retry after it completes.");
    }
    this.humanOperationOwner = session;
    return this.beginOperation();
  }

  beginOperation() {
    this.active++;
    this.notify();
    let finished = false;
    return (error: unknown = null) => {
      if (finished) {
        return;
      }
      finished = true;
      this.active--;
      this.humanOperationOwner = null;
      if (error) {
        // Losing the upstream response does not prove the browser stopped acting.
        this.fault =
          "Browser operation completion is unknown. Restart the container before continuing.";
      }
      this.advanceAgentRequest();
      this.notify();
    };
  }

  canControl(session: string) {
    const status = this.status(session);
    return status.ready && status.mode === "human" && status.ownsControl;
  }
}
