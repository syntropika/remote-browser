import { nativeError } from "./effects.js";
import type { RawData } from "ws";
import type { Protocol } from "../node_modules/playwright-core/types/protocol.js";
import { Data, Effect } from "effect";
import { attempt, run } from "./effects.js";
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
}
export interface BrowserTabs {
  tabs: BrowserTab[];
  activeId: string | null;
}
interface CommandOptions {
  deadline: number;
  sessionId?: string;
  mutating?: boolean;
  beforeMutation?: () => void;
}
interface PendingCommand {
  timer: NodeJS.Timeout;
  mutating: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
import { WebSocket } from "ws";

export class BrowserError extends Data.TaggedError("BrowserError")<{
  status: number;
  unknownCompletion: boolean;
  message: string;
}> {
  constructor(message: string, status = 502, unknownCompletion = false) {
    super({ message, status, unknownCompletion });
  }
}

export function navigationUrl(input: unknown) {
  if (typeof input !== "string" || !input.trim() || input.length > 4096) {
    throw new BrowserError(
      "Enter a URL or search query of up to 4096 characters.",
      400,
    );
  }
  const value = input.trim();
  if (value === "about:blank") return value;
  const host =
    /^(?:localhost|(?:[\p{L}\p{N}_-]+\.)+[\p{L}\p{N}_-]+|\[[a-f\d:]+\])(?::\d+)?(?:[/?#][^\s]*)?$/iu;
  let candidate;
  if (host.test(value)) candidate = `https://${value}`;
  else if (/^[a-z][a-z\d+.-]*:/i.test(value)) candidate = value;
  else return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
      throw new Error();
    return url.href;
  } catch {
    throw new BrowserError(
      "Use an HTTP or HTTPS address, or enter a search query.",
      400,
    );
  }
}

// One bounded CDP connection is shared by the dashboard. It never exposes CDP
// credentials or endpoints to a client, and reconnects after read-only failures.
export class BrowserService {
  endpoint: string;
  timeoutMs: number;
  maxInflight: number;
  nextId: number;
  pending: Map<number, PendingCommand>;
  sessions: Map<string, Promise<string>>;
  activeId: string | null;
  socket: WebSocket | null;
  connecting: Promise<WebSocket> | null;
  listing: Promise<BrowserTabs> | null;

  constructor({
    endpoint = "http://127.0.0.1:9222",
    timeoutMs = 8000,
    maxInflight = 16,
  } = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.maxInflight = maxInflight;
    this.nextId = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.activeId = null;
    this.socket = null;
    this.connecting = null;
    this.listing = null;
  }

  remaining(deadline: number) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new BrowserError("The browser took too long to respond.", 504);
    return remaining;
  }

  async connect(deadline: number) {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (!this.connecting) {
      this.connecting = (async () => {
        try {
          const response = await fetch(`${this.endpoint}/json/version`, {
            signal: AbortSignal.timeout(this.remaining(deadline)),
          });
          if (!response.ok) throw new Error();
          const info = await response.json();
          const address = new URL(info.webSocketDebuggerUrl);
          const expected = new URL(this.endpoint);
          if (
            !["ws:", "wss:"].includes(address.protocol) ||
            address.hostname !== expected.hostname ||
            address.port !== expected.port
          )
            throw new Error();
          const socket = new WebSocket(address, {
            handshakeTimeout: this.remaining(deadline),
            maxPayload: 2 * 1024 * 1024,
            perMessageDeflate: false,
          });
          await new Promise<void>((resolve, reject) => {
            socket.once("open", () => resolve());
            socket.once("error", reject);
          });
          this.socket = socket;
          socket.on("message", (data) => this.receive(data));
          socket.on("close", () => this.disconnected(socket));
          socket.on("error", () => this.disconnected(socket));
          return socket;
        } catch {
          throw new BrowserError("The browser service is unavailable.", 503);
        }
      })().finally(() => {
        this.connecting = null;
      });
    }
    const socket = await this.connecting;
    this.remaining(deadline);
    return socket;
  }

  disconnected(socket: WebSocket) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.sessions.clear();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(
        new BrowserError(
          "The browser connection was interrupted.",
          502,
          pending.mutating,
        ),
      );
    }
  }

  receive(data: RawData) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error)
      pending.reject(
        new BrowserError(
          "The browser could not complete this action. Refresh the tab list and try again.",
          502,
        ),
      );
    else pending.resolve(message.result || {});
  }

  async command<M extends keyof Protocol.CommandParameters>(
    method: M,
    params: Protocol.CommandParameters[M],
    {
      deadline,
      sessionId,
      mutating = false,
      beforeMutation = () => {},
    }: CommandOptions,
  ): Promise<Protocol.CommandReturnValues[M]> {
    const socket = await this.connect(deadline);
    if (this.pending.size >= this.maxInflight)
      throw new BrowserError("The browser is busy. Try again shortly.", 503);
    const timeout = this.remaining(deadline);
    if (mutating) beforeMutation();
    return await new Promise<Protocol.CommandReturnValues[M]>(
      (resolve, reject) => {
        const id = ++this.nextId;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new BrowserError(
              "The browser took too long to respond.",
              504,
              mutating,
            ),
          );
          // A command may still be executing. Its caller keeps the control gate
          // closed when the missing response belongs to a mutation.
          socket.terminate();
        }, timeout);
        this.pending.set(id, {
          resolve: (value) => resolve(value as Protocol.CommandReturnValues[M]),
          reject,
          timer,
          mutating,
        });
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
          (error) => {
            if (!error) return;
            const pending = this.pending.get(id);
            if (!pending) return;
            clearTimeout(timer);
            this.pending.delete(id);
            reject(
              new BrowserError(
                "The browser connection was interrupted.",
                502,
                mutating,
              ),
            );
          },
        );
      },
    );
  }

  async pageSession(tabId: string, deadline: number) {
    if (!this.sessions.has(tabId)) {
      const attaching = this.command(
        "Target.attachToTarget",
        { targetId: tabId, flatten: true },
        { deadline },
      )
        .then(({ sessionId }) => {
          if (!sessionId)
            throw new BrowserError("This tab is no longer available.", 409);
          return sessionId;
        })
        .catch((error) => {
          this.sessions.delete(tabId!);
          throw error;
        });
      this.sessions.set(tabId, attaching);
    }
    return await this.sessions.get(tabId)!;
  }

  async targets(deadline: number) {
    const { targetInfos = [] } = await this.command(
      "Target.getTargets",
      {},
      { deadline },
    );
    const tabs = targetInfos
      .filter((target) => target.type === "page")
      .map((target) => ({
        id: target.targetId,
        title: target.title || "New tab",
        url: target.url || "about:blank",
      }));
    const ids = new Set(tabs.map((tab) => tab.id));
    for (const id of this.sessions.keys())
      if (!ids.has(id)) this.sessions.delete(id);
    return tabs;
  }

  async activeTab(tabs: BrowserTab[], deadline: number) {
    // Browser CDP has no active-tab field. Read visibility and focus from each
    // page without executing site callbacks. Preserve our selected tab when
    // several browser windows have a visible page at the same time.
    const ordered = [...tabs].sort(
      (a, b) => Number(b.id === this.activeId) - Number(a.id === this.activeId),
    );
    let visible: string | null = null;
    for (const tab of ordered) {
      try {
        const sessionId = await this.pageSession(tab.id, deadline);
        const { result } = await this.command(
          "Runtime.evaluate",
          {
            expression:
              '({ visible: document.visibilityState === "visible", focused: document.hasFocus() })',
            returnByValue: true,
            throwOnSideEffect: true,
            timeout: Math.min(500, this.remaining(deadline)),
          },
          { deadline, sessionId },
        );
        if (result?.value?.visible) {
          visible ||= tab.id;
          if (result.value.focused) return tab.id;
        }
      } catch (errorCause) {
        const error = nativeError(errorCause);
        if (Date.now() >= deadline || error.status === 503) break;
        this.sessions.delete(tab.id);
      }
    }
    return (
      visible ||
      (tabs.some((tab) => tab.id === this.activeId)
        ? this.activeId
        : tabs[0]?.id) ||
      null
    );
  }

  async listTabs() {
    // Several viewers polling at once share one read instead of accumulating
    // commands or attaching duplicate sessions to the same targets.
    if (!this.listing) {
      this.listing = (async () => {
        const deadline = Date.now() + this.timeoutMs;
        const tabs = await this.targets(deadline);
        this.activeId = await this.activeTab(tabs, deadline);
        return { tabs, activeId: this.activeId };
      })().finally(() => {
        this.listing = null;
      });
    }
    return await this.listing;
  }

  listTabsEffect() {
    return attempt(() => this.listTabs());
  }

  action(
    input: Parameters<BrowserService["actionEffect"]>[0],
    options: Parameters<BrowserService["actionEffect"]>[1] = {},
  ) {
    return run(this.actionEffect(input, options));
  }

  actionEffect(
    input: { action?: string; tabId?: string; url?: unknown } | null,
    { beforeMutation = () => {} } = {},
  ) {
    return Effect.gen({ self: this }, function* () {
      const allowed = [
        "navigate",
        "new-tab",
        "activate",
        "close",
        "back",
        "forward",
        "reload",
      ];
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        !input.action ||
        !allowed.includes(input.action)
      ) {
        return yield* Effect.fail(
          new BrowserError("Choose a supported browser action.", 400),
        );
      }
      if (
        input.tabId !== undefined &&
        (typeof input.tabId !== "string" ||
          !/^[a-z\d_-]{1,128}$/i.test(input.tabId))
      ) {
        return yield* Effect.fail(
          new BrowserError("Choose a valid browser tab.", 400),
        );
      }
      const url = ["navigate", "new-tab"].includes(input.action)
        ? yield* attempt(() =>
            navigationUrl(
              input.url === undefined && input.action === "new-tab"
                ? "about:blank"
                : input.url,
            ),
          )
        : null;
      const deadline = Date.now() + this.timeoutMs;
      const options = { deadline, mutating: true, beforeMutation };
      const tabs = yield* attempt(() => this.targets(deadline));
      let tabId: string | null | undefined = input.tabId;
      if (input.action !== "new-tab") {
        tabId ||= yield* attempt(() => this.activeTab(tabs, deadline));
        if (!tabs.some((tab) => tab.id === tabId))
          return yield* Effect.fail(
            new BrowserError(
              "This tab is no longer available. Refresh the tab list.",
              409,
            ),
          );
      }
      if (input.action === "new-tab") {
        const created = yield* attempt(() =>
          this.command("Target.createTarget", { url: url! }, options),
        );
        tabId = created.targetId;
        yield* attempt(() =>
          this.command("Target.activateTarget", { targetId: tabId! }, options),
        );
        this.activeId = tabId!;
      } else if (input.action === "activate") {
        yield* attempt(() =>
          this.command("Target.activateTarget", { targetId: tabId! }, options),
        );
        this.activeId = tabId!;
      } else if (input.action === "close") {
        // Chromium exits when its last page closes, taking every session with it.
        if (tabs.length === 1) {
          const created = yield* attempt(() =>
            this.command(
              "Target.createTarget",
              { url: "about:blank" },
              options,
            ),
          );
          this.activeId = created.targetId;
        }
        const { success } = yield* attempt(() =>
          this.command("Target.closeTarget", { targetId: tabId! }, options),
        );
        if (!success)
          return yield* Effect.fail(
            new BrowserError(
              "This tab could not be closed. Refresh the tab list.",
              409,
            ),
          );
        this.sessions.delete(tabId!);
      } else {
        const sessionId = yield* attempt(() =>
          this.pageSession(tabId!, deadline),
        );
        const pageOptions = { ...options, sessionId };
        if (input.action === "navigate") {
          const result = yield* attempt(() =>
            this.command("Page.navigate", { url: url! }, pageOptions),
          );
          if (result.errorText)
            return yield* Effect.fail(
              new BrowserError(
                "This address could not be loaded. Check the address and try again.",
                422,
              ),
            );
        } else if (input.action === "reload") {
          yield* attempt(() => this.command("Page.reload", {}, pageOptions));
        } else {
          const history = yield* attempt(() =>
            this.command(
              "Page.getNavigationHistory",
              {},
              { deadline, sessionId },
            ),
          );
          const entry =
            history.entries?.[
              history.currentIndex + (input.action === "back" ? -1 : 1)
            ];
          if (entry)
            yield* attempt(() =>
              this.command(
                "Page.navigateToHistoryEntry",
                { entryId: entry.id },
                pageOptions,
              ),
            );
        }
      }
      // Fetch a fresh snapshot after the mutation rather than returning an older
      // poll that may have started while this action was running.
      const updated = yield* attempt(() => this.targets(deadline));
      this.activeId = yield* attempt(() => this.activeTab(updated, deadline));
      return { tabs: updated, activeId: this.activeId };
    });
  }

  close() {
    this.socket?.terminate();
  }
}
