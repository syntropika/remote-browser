import { asyncHandler, background } from "../src/async-boundary.js";
import { required } from "../src/invariants.js";
import { uiFailure } from "./api.js";
import type { BrowserControlOptions, BrowserTabs } from "./contracts.js";
import { element as domElement } from "./dom.js";

export function createBrowserControls({
  api,
  canControl,
  isAuthenticated,
  beforeAction,
  onError,
  onUnauthorized,
  onOpen,
}: BrowserControlOptions) {
  const element = domElement;
  const input = element("address-input");
  const panel = element("tabs-panel");
  const list = element("tabs-list");
  const tabsButton = element("tabs-button");
  const newTabButton = element("new-tab-button");
  const closeButton = element("tabs-close");
  const navigation = (
    ["address-go", "back-button", "forward-button", "reload-button"] as const
  ).map((id) => element(id));
  let state: BrowserTabs = { tabs: [], activeId: null };
  let busy = false;
  let loading = false;
  let generation = 0;
  const rows = new Map<string, ReturnType<typeof createRow>>();

  function closeTabs({ restoreFocus = false } = {}) {
    const wasOpen = !panel.hidden;
    panel.hidden = true;
    tabsButton.setAttribute("aria-expanded", "false");
    if (wasOpen && restoreFocus && !tabsButton.disabled) {
      tabsButton.focus({ preventScroll: true });
    }
  }

  function createRow(id: string) {
    const row = document.createElement("li");
    row.className = "tab-item";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "tab-select";
    select.dataset.tabId = id;
    const title = document.createElement("span");
    title.className = "tab-title";
    const url = document.createElement("span");
    url.className = "tab-url";
    select.append(title, url);
    select.addEventListener("click", () => {
      if (!canControl() || busy) {
        return;
      }
      closeTabs({ restoreFocus: true });
      background(action("activate", { tabId: id }));
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    close.addEventListener(
      "click",
      asyncHandler(() => action("close", { tabId: id })),
    );
    row.append(select, close);
    return { row, select, close, title, url };
  }

  function renderTabs(editable: boolean) {
    // SAFETY: Dashboard pointer targets and focus controls are native DOM elements; null focus is checked before use.
    const focused = document.activeElement as HTMLButtonElement | null;
    const previousRows = [...list.children];
    const focusedIndex = previousRows.findIndex((row) => row.contains(focused));
    const remaining = new Set(state.tabs.map((tab) => tab.id));
    for (const [id, item] of rows) {
      if (remaining.has(id)) {
        continue;
      }
      item.row.remove();
      rows.delete(id);
    }
    if (state.tabs.length) {
      list.querySelector(".tabs-empty")?.remove();
      for (const [index, tab] of state.tabs.entries()) {
        let item = rows.get(tab.id);
        if (!item) {
          item = createRow(tab.id);
          rows.set(tab.id, item);
        }
        item.row.dataset.active = String(tab.id === state.activeId);
        for (const button of [item.select, item.close]) {
          button.disabled = !editable;
          // Keep focused controls mounted while a request is in flight.
          button.setAttribute("aria-disabled", String(!editable || busy));
        }
        if (tab.id === state.activeId) {
          item.select.setAttribute("aria-current", "page");
        } else {
          item.select.removeAttribute("aria-current");
        }
        item.title.textContent = tab.title || "New tab";
        item.url.textContent = tab.url === "about:blank" ? "New tab" : tab.url;
        item.close.setAttribute("aria-label", `Close ${tab.title || "tab"}`);
        const current = list.children[index];
        if (current !== item.row) {
          if (current) {
            current.before(item.row);
          } else {
            list.append(item.row);
          }
        }
      }
    } else if (!list.firstElementChild) {
      const empty = document.createElement("li");
      empty.className = "tabs-empty";
      empty.textContent = "No tabs available.";
      list.append(empty);
    }
    if (!panel.hidden && focusedIndex !== -1) {
      if (list.contains(focused)) {
        // Moving an existing row can blur its focused button in some engines.
        if (document.activeElement !== focused && !required(focused).disabled) {
          required(focused).focus({ preventScroll: true });
        }
      } else {
        const next = state.tabs[Math.min(focusedIndex, state.tabs.length - 1)];
        const replacement = editable && next ? required(rows.get(next.id)).select : closeButton;
        replacement.focus({ preventScroll: true });
      }
    }
  }

  function render() {
    const editable = canControl();
    input.disabled = !isAuthenticated();
    if (!editable && document.activeElement === input) {
      input.blur();
    }
    input.readOnly = !editable;
    input.placeholder = editable ? "Search or enter address" : "Take control to browse";
    for (const button of navigation) {
      button.disabled = !editable || busy;
    }
    newTabButton.disabled = !editable || busy;
    tabsButton.disabled = !isAuthenticated();
    element("tab-count").textContent = String(state.tabs.length);
    tabsButton.setAttribute("aria-label", `Tabs (${state.tabs.length})`);
    const active = state.tabs.find((tab) => tab.id === state.activeId);
    if (!busy && document.activeElement !== input) {
      input.value = active?.url === "about:blank" ? "" : active?.url || "";
      input.scrollLeft = 0;
    }
    renderTabs(editable);
  }

  async function refresh() {
    if (!isAuthenticated() || loading || busy) {
      return;
    }
    const current = generation;
    loading = true;
    try {
      const next = await api("/api/browser/tabs");
      if (current !== generation || !isAuthenticated()) {
        return;
      }
      state = next;
      render();
    } catch (cause) {
      const error = uiFailure(cause);
      if (current === generation && error.statusCode === 401) {
        onUnauthorized();
      }
    } finally {
      loading = false;
    }
  }

  async function action(name: string, extra = {}) {
    if (!canControl() || busy) {
      return;
    }
    beforeAction();
    const current = ++generation;
    busy = true;
    render();
    try {
      const next = await api("/api/browser/action", { action: name, ...extra });
      if (current !== generation || !isAuthenticated()) {
        return;
      }
      state = next;
    } catch (cause) {
      const error = uiFailure(cause);
      if (current !== generation) {
        return;
      }
      if (error.statusCode === 401) {
        onUnauthorized();
      } else {
        onError(error.message || "Could not update the browser. Try again.");
      }
    } finally {
      busy = false;
      render();
      background(refresh());
    }
  }

  element("address-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const url = input.value.trim();
    if (!url || !canControl() || busy) {
      return;
    }
    input.blur();
    background(action("navigate", { url }));
  });
  input.addEventListener("focus", () => {
    if (canControl()) {
      input.select();
    }
  });
  tabsButton.addEventListener("click", () => {
    if (!panel.hidden) {
      closeTabs({ restoreFocus: true });
      return;
    }
    onOpen();
    panel.hidden = false;
    tabsButton.setAttribute("aria-expanded", "true");
    const active = rows.get(state.activeId ?? "")?.select;
    (active && !active.disabled ? active : closeButton).focus({
      preventScroll: true,
    });
    background(refresh());
  });
  closeButton.addEventListener("click", () => {
    closeTabs({ restoreFocus: true });
  });
  newTabButton.addEventListener("click", () => {
    if (!canControl() || busy) {
      return;
    }
    closeTabs();
    // Focus before starting asynchronous work to retain iOS's user gesture.
    input.value = "";
    input.focus({ preventScroll: true });
    background(action("new-tab"));
  });
  for (const name of ["back", "forward", "reload"] as const) {
    element(`${name}-button`).addEventListener(
      "click",
      asyncHandler(() => action(name)),
    );
  }
  document.addEventListener("keydown", (event) => {
    if (panel.hidden || event.key !== "Escape" || event.isComposing) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeTabs({ restoreFocus: true });
  });
  document.addEventListener("pointerdown", (event) => {
    // SAFETY: Dashboard pointer targets and focus controls are native DOM elements; null focus is checked before use.
    if (
      !panel.hidden &&
      !panel.contains(event.target as Node) &&
      !tabsButton.contains(event.target as Node)
    ) {
      closeTabs();
    }
  });

  return {
    close: closeTabs,
    refresh,
    sync: render,
    reset() {
      generation++;
      state = { tabs: [], activeId: null };
      input.value = "";
      closeTabs();
      render();
    },
  };
}
