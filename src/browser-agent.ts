import { Effect } from "effect";
import { attempt, run } from "./effects.js";
import type {
  Page,
  BrowserContext,
  CDPSession,
  ElementHandle,
} from "playwright";
interface PageState {
  refs: Map<string, { handle: ElementHandle }>;
  nodes: Map<number, string>;
  current: Set<string>;
  document: number | null | undefined;
  baseline: Map<string, string>;
  options: string;
}
interface ContextState {
  pages: WeakMap<Page, PageState>;
  owned: Map<string, string>;
  sequence: number;
}
interface TabOptions {
  tabId?: string;
}
interface SnapshotOptions extends TabOptions {
  scope?: string;
  interactive?: boolean;
  maxNodes?: number;
  maxDepth?: number;
  delta?: boolean;
}
import { randomUUID } from "node:crypto";

// Agent conveniences share native Playwright objects and the existing control lease.
const contexts = new WeakMap<BrowserContext, ContextState>();
const interactiveRoles = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
]);
const structuralRoles = new Set([
  "heading",
  "main",
  "navigation",
  "dialog",
  "alert",
  "status",
  "region",
  "banner",
  "contentinfo",
]);

function stateFor(context: BrowserContext) {
  if (!contexts.has(context))
    contexts.set(context, {
      pages: new WeakMap(),
      owned: new Map(),
      sequence: 0,
    });
  return contexts.get(context)!;
}

function stateForPage(state: ContextState, page: Page) {
  if (!state.pages.has(page))
    state.pages.set(page, {
      refs: new Map(),
      nodes: new Map(),
      current: new Set(),
      document: null,
      baseline: new Map(),
      options: "",
    });
  return state.pages.get(page)!;
}

function withCDP<A>(
  context: BrowserContext,
  page: Page,
  callback: (cdp: CDPSession) => Promise<A>,
): Promise<A> {
  return run(
    Effect.acquireUseRelease(
      attempt(() => context.newCDPSession(page)),
      (cdp) => attempt(() => callback(cdp)),
      (cdp) => attempt(() => cdp.detach()).pipe(Effect.orDie),
    ),
  );
}

async function tabId(context: BrowserContext, page: Page) {
  return withCDP(
    context,
    page,
    async (cdp) => (await cdp.send("Target.getTargetInfo")).targetInfo.targetId,
  );
}

// Resolve a backend node to a native handle without leaving attributes in the visited DOM.
async function handleFor(cdp: CDPSession, page: Page, backendNodeId: number) {
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId });
  const key = `__remoteBrowserRef_${randomUUID().replaceAll("-", "")}`;
  try {
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId!,
      returnByValue: true,
      arguments: [{ value: key }],
      functionDeclaration: `function(key) {
        if (this.nodeType !== 1 || !this.isConnected) return null;
        Object.defineProperty(this.ownerDocument.defaultView, key, { value: this, configurable: true });
        return true;
      }`,
    });
    if (!result.value) return null;
    const handle = await page.evaluateHandle((key) => {
      const element = (globalThis as unknown as Record<string, Element>)[key];
      delete (globalThis as unknown as Record<string, Element>)[key];
      return element;
    }, key);
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      return null;
    }
    return element;
  } finally {
    if (object.objectId) {
      await cdp
        .send("Runtime.callFunctionOn", {
          objectId: object.objectId!,
          functionDeclaration:
            "function(key) { delete this.ownerDocument.defaultView[key]; }",
          arguments: [{ value: key }],
        })
        .catch(() => {});
      await cdp
        .send("Runtime.releaseObject", { objectId: object.objectId! })
        .catch(() => {});
    }
  }
}

export function createBrowserAgent(page: Page, context: BrowserContext) {
  const state = stateFor(context);
  async function select(id?: string) {
    if (id === undefined) return page;
    for (const candidate of context.pages())
      if ((await tabId(context, candidate)) === id) return candidate;
    throw new Error(
      "Tab not found. Read browser.tabs.list() and use its stable id.",
    );
  }
  async function clearRefs(current: PageState) {
    await Promise.all(
      [...current.refs.values()].map((value) =>
        value.handle.dispose().catch(() => {}),
      ),
    );
    current.refs.clear();
    current.nodes.clear();
    current.current.clear();
    current.baseline.clear();
  }
  async function snapshot({
    tabId: id,
    scope,
    interactive = true,
    maxNodes = 120,
    maxDepth = 12,
    delta = false,
  }: SnapshotOptions = {}) {
    if (
      !Number.isInteger(maxNodes) ||
      maxNodes < 1 ||
      maxNodes > 200 ||
      !Number.isInteger(maxDepth) ||
      maxDepth < 1 ||
      maxDepth > 30
    )
      throw new Error("Use maxNodes 1–200 and maxDepth 1–30.");
    if (
      scope !== undefined &&
      (typeof scope !== "string" || !scope.trim() || scope.length > 512)
    )
      throw new Error("scope must be a CSS selector.");
    const target = await select(id);
    const current = stateForPage(state, target);
    return withCDP(context, target, async (cdp) => {
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      const root = nodes.find((node) => node.role?.value === "RootWebArea");
      if (current.document !== root?.backendDOMNodeId) {
        await clearRefs(current);
        current.document = root?.backendDOMNodeId;
      }
      const byNode = new Map(nodes.map((node) => [node.nodeId, node]));
      let scopeObject;
      if (scope) {
        const { root: document } = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", {
          nodeId: document.nodeId,
          selector: scope,
        });
        if (!nodeId)
          throw new Error(
            "Snapshot scope was not found. Use a CSS selector in the main document.",
          );
        scopeObject = (await cdp.send("DOM.resolveNode", { nodeId })).object
          .objectId;
      }
      const entries: { key: string; line: string }[] = [];
      let textBytes = 0;
      let matched = 0;
      const active = new Set<string>();
      try {
        for (const node of nodes) {
          const role = node.role?.value;
          if (
            node.ignored ||
            (!interactiveRoles.has(role) &&
              (interactive ||
                (!structuralRoles.has(role) && role !== "StaticText")))
          )
            continue;
          let depth = 0;
          let ancestor: typeof node | undefined = node;
          while (ancestor?.parentId && depth <= maxDepth) {
            depth++;
            ancestor = byNode.get(ancestor.parentId);
          }
          if (depth > maxDepth) continue;
          if (scopeObject) {
            if (!node.backendDOMNodeId) continue;
            const { object } = await cdp.send("DOM.resolveNode", {
              backendNodeId: node.backendDOMNodeId,
            });
            try {
              const { result } = await cdp.send("Runtime.callFunctionOn", {
                objectId: object.objectId!,
                functionDeclaration:
                  "function(scope) { return scope.contains(this); }",
                arguments: [{ objectId: scopeObject }],
                returnByValue: true,
              });
              if (!result.value) continue;
            } finally {
              await cdp
                .send("Runtime.releaseObject", { objectId: object.objectId! })
                .catch(() => {});
            }
          }
          matched++;
          if (entries.length >= maxNodes || textBytes >= 10000) continue;
          const name = String(node.name?.value || "").slice(0, 300);
          let ref;
          if (interactiveRoles.has(role) && node.backendDOMNodeId) {
            ref = current.nodes.get(node.backendDOMNodeId);
            if (!ref) {
              const handle = await handleFor(
                cdp,
                target,
                node.backendDOMNodeId,
              ).catch(() => null);
              if (handle) {
                ref = `e${++state.sequence}`;
                current.nodes.set(node.backendDOMNodeId, ref);
                current.refs.set(ref, { handle });
              }
            }
            if (ref) active.add(ref);
          }
          const properties =
            node.properties?.filter((property) =>
              [
                "checked",
                "selected",
                "disabled",
                "expanded",
                "required",
                "level",
              ].includes(property.name),
            ) || [];
          const value =
            role === "textbox" || role === "searchbox"
              ? ""
              : String(node.value?.value || "").slice(0, 120);
          const line = `${ref ? `@${ref} ` : ""}[${role}] ${JSON.stringify(name)}${value ? ` value=${JSON.stringify(value)}` : ""}${properties.map((p) => ` ${p.name}=${p.value.value}`).join("")}`;
          textBytes += Buffer.byteLength(JSON.stringify(line));
          entries.push({ key: ref || node.nodeId, line });
        }
      } finally {
        if (scopeObject)
          await cdp
            .send("Runtime.releaseObject", { objectId: scopeObject })
            .catch(() => {});
      }
      // Discard references omitted by the latest observation, bounding retained handles.
      for (const [ref, value] of current.refs)
        if (!active.has(ref)) {
          await value.handle.dispose().catch(() => {});
          current.refs.delete(ref);
        }
      for (const [node, ref] of current.nodes)
        if (!active.has(ref)) current.nodes.delete(node);
      current.current = active;
      const options = JSON.stringify({
        scope,
        interactive,
        maxNodes,
        maxDepth,
      });
      const next = new Map(entries.map((entry) => [entry.key, entry.line]));
      const incremental =
        delta && current.options === options && current.baseline.size > 0;
      const lines = incremental
        ? [
            ...entries
              .filter((entry) => current.baseline.get(entry.key) !== entry.line)
              .map((entry) => `+ ${entry.line}`),
            ...[...current.baseline]
              .filter(([key]) => !next.has(key))
              .map(([, line]) => `- ${line}`),
          ]
        : entries.map((entry) => entry.line);
      current.baseline = next;
      current.options = options;
      return {
        tabId: await tabId(context, target),
        url: target.url().slice(0, 2048),
        text:
          lines.join("\n") ||
          (incremental ? "(unchanged)" : "(no matching elements)"),
        delta: incremental,
        truncated: matched > entries.length,
        refs: [...active],
      };
    });
  }
  async function reference(ref: string, { tabId: id }: TabOptions = {}) {
    const target = await select(id);
    const current = stateForPage(state, target);
    const key = typeof ref === "string" ? ref.replace(/^@/, "") : "";
    const value = current.current.has(key) && current.refs.get(key);
    if (
      !value ||
      !(await value.handle
        .evaluate((element) => element.isConnected)
        .catch(() => false))
    )
      throw new Error(
        "Stale or unknown reference. Take a fresh browser.snapshot() on this tab.",
      );
    return value.handle;
  }
  return {
    snapshot,
    ref: reference,
    async read({
      tabId: id,
      scope = "body",
      maxChars = 12000,
    }: TabOptions & { scope?: string; maxChars?: number } = {}) {
      if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 16000)
        throw new Error("Use maxChars 1–16000.");
      const target = await select(id);
      const rendered = await target
        .locator(scope)
        .evaluate((element, maximum) => {
          const text = (element as HTMLElement).innerText;
          return { text: text.slice(0, maximum), length: text.length };
        }, maxChars);
      let text = rendered.text;
      while (Buffer.byteLength(JSON.stringify(text)) > 24000)
        text = text.slice(0, Math.floor(text.length * 0.8));
      return {
        tabId: await tabId(context, target),
        url: target.url().slice(0, 2048),
        text,
        truncated: rendered.length > text.length,
      };
    },
    tabs: {
      async list() {
        const result = [];
        for (const target of context.pages()) {
          const info = await withCDP(context, target, async (cdp) => {
            const { targetInfo } = await cdp.send("Target.getTargetInfo");
            const { result } = await cdp.send("Runtime.evaluate", {
              expression: 'document.visibilityState === "visible"',
              returnByValue: true,
              throwOnSideEffect: true,
              timeout: 500,
            });
            return { id: targetInfo.targetId, active: Boolean(result.value) };
          });
          result.push({
            ...info,
            url: target.url().slice(0, 2048),
            title: (await target.title()).slice(0, 300),
            owned: state.owned.has(info.id),
            task: state.owned.get(info.id) || null,
          });
        }
        return result;
      },
      async use(id: string) {
        const target = await select(id);
        await target.bringToFront();
        return target;
      },
      async open({ url = "about:blank", task = "Agent task" } = {}) {
        if (typeof task !== "string" || !task.trim() || task.length > 120)
          throw new Error("Use a short task label.");
        const target = await context.newPage();
        const id = await tabId(context, target);
        state.owned.set(id, task);
        await target.bringToFront();
        await target.goto(url, { waitUntil: "commit" });
        return { id, url: target.url(), task };
      },
      async close(id: string) {
        if (!state.owned.has(id))
          throw new Error(
            "This helper closes only tabs opened with browser.tabs.open(). Preserve user tabs.",
          );
        const target = await select(id);
        await clearRefs(stateForPage(state, target));
        await target.close();
        state.owned.delete(id);
      },
    },
    async screenshot({
      tabId: id,
      annotate = false,
      ...options
    }: TabOptions & { annotate?: boolean } & Parameters<
        Page["screenshot"]
      >[0] = {}) {
      const target = await select(id);
      if (!annotate) return target.screenshot(options);
      if (options.fullPage)
        throw new Error(
          "Annotated screenshots cover the viewport. Use a native full-page screenshot separately.",
        );
      await snapshot({ tabId: id });
      const current = stateForPage(state, target);
      const boxes = [];
      for (const ref of current.current) {
        const box = await current.refs.get(ref)!.handle.boundingBox();
        if (box) boxes.push({ ref, ...box });
      }
      const overlay = await target.evaluateHandle((boxes) => {
        const root = document.createElement("div");
        root.setAttribute("aria-hidden", "true");
        root.style.cssText =
          "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
        const shadow = root.attachShadow({ mode: "closed" });
        for (const box of boxes) {
          if (
            box.x + box.width < 0 ||
            box.y + box.height < 0 ||
            box.x > innerWidth ||
            box.y > innerHeight
          )
            continue;
          const label = document.createElement("span");
          label.textContent = "@" + box.ref;
          label.style.cssText = `position:absolute;left:${Math.max(0, box.x)}px;top:${Math.max(0, box.y)}px;background:#111;color:#fff;border:1px solid #fff;border-radius:4px;padding:2px 4px;font:12px/16px system-ui;`;
          shadow.append(label);
        }
        document.documentElement.append(root);
        return root;
      }, boxes);
      try {
        return await target.screenshot(options);
      } finally {
        await overlay.evaluate((element) => element.remove()).catch(() => {});
        await overlay.dispose();
      }
    },
  };
}
