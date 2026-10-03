import { uiFailure } from "./api.js";
import type {
  UiOptions,
  ApiKeyMetadata,
  SavedFile,
  RecordingStatus,
  BrowserTabs,
  RFB,
} from "./contracts.js";
import { element as domElement, type DomElements } from "./dom.js";
export function createApiKeys({ api, onOpen, onUnauthorized }: UiOptions) {
  const byId = domElement;
  const panel = byId("api-keys-panel");
  const workspace = byId("workspace");
  const form = byId("api-key-form");
  const nameInput = byId("api-key-name");
  const createButton = byId("api-key-create");
  const refreshButton = byId("api-keys-refresh");
  const list = byId("api-keys-list");
  const secretInput = byId("api-key-secret");
  const created = byId("api-key-created");
  const errorText = byId("api-keys-error");
  const feedback = byId("api-keys-status");
  const endpoint = byId("mcp-endpoint");
  endpoint.value = new URL("/mcp", location.href).href;
  let generation = 0;
  let busy = false;
  let createdId: string | null = null;
  let keys: ApiKeyMetadata[] = [];

  function message(element: HTMLElement, value = "") {
    element.textContent = value;
    element.hidden = !value;
  }

  function clearSecret() {
    secretInput.value = "";
    created.hidden = true;
    createdId = null;
  }

  function setBusy(value: boolean) {
    busy = value;
    nameInput.readOnly = value;
    createButton.disabled = value;
    refreshButton.disabled = value;
    form.setAttribute("aria-busy", String(value));
    for (const button of list.querySelectorAll("button"))
      button.disabled = value;
  }

  function handleError(cause: unknown, fallback: string) {
    const error = uiFailure(cause);
    if (error.statusCode === 401) onUnauthorized();
    else message(errorText, error.message || fallback);
  }

  // Keep the display's geometry intact while removing browser controls from focus.
  function setBackgroundInactive(value: boolean) {
    for (const element of workspace.querySelectorAll<HTMLElement>(
      ".toolbar, .browser-shell, .bottom-stack, .tabs-panel, .notice, .session-footer, .recording-indicator",
    )) {
      element.inert = value;
    }
  }

  function close(restoreFocus = true) {
    generation += 1;
    panel.hidden = true;
    delete workspace.dataset.settings;
    setBackgroundInactive(false);
    clearSecret();
    nameInput.value = "";
    nameInput.setCustomValidity("");
    keys = [];
    list.replaceChildren();
    message(errorText);
    message(feedback);
    setBusy(false);
    if (restoreFocus)
      byId("more-menu")
        .querySelector("summary")!
        .focus({ preventScroll: true });
  }

  function dateLabel(value: string) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function makeButton(text: string, className: string, action: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${className}`;
    button.textContent = text;
    button.addEventListener("click", action);
    return button;
  }

  function renderKeys() {
    list.replaceChildren();
    byId("api-keys-count").textContent = String(keys.length);
    byId("api-keys-empty").hidden = keys.length !== 0;
    for (const key of keys) {
      const row = document.createElement("li");
      row.className = "api-key-row";
      row.dataset.keyId = key.id;
      const info = document.createElement("div");
      info.className = "api-key-info";
      const name = document.createElement("h3");
      name.textContent = key.name;
      const prefix = document.createElement("code");
      prefix.textContent = `${key.prefix}…`;
      const meta = document.createElement("p");
      meta.className = "api-key-meta";
      const added = document.createElement("span");
      added.textContent = `Created ${dateLabel(key.createdAt)}`;
      const used = document.createElement("span");
      used.textContent = `Last used: ${key.lastUsedAt ? dateLabel(key.lastUsedAt) : "Never"}`;
      meta.append(added, used);
      info.append(name, prefix, meta);
      const actions = document.createElement("div");
      actions.className = "api-key-actions";
      const confirmation = document.createElement("div");
      confirmation.className = "key-revoke-confirm";
      confirmation.hidden = true;
      const prompt = document.createElement("p");
      prompt.textContent = `Revoke “${key.name}”? This client will lose access.`;
      const confirmActions = document.createElement("div");
      const cancel = makeButton("Cancel", "button-secondary", () => {
        confirmation.hidden = true;
        revokeButton.hidden = false;
        revokeButton.focus();
      });
      const confirm = makeButton(
        "Revoke key",
        "button-destructive button-secondary",
        () => void revoke(key),
      );
      confirmActions.append(cancel, confirm);
      confirmation.append(prompt, confirmActions);
      const revokeButton = makeButton(
        "Revoke",
        "button-quiet button-destructive",
        () => {
          confirmation.hidden = false;
          revokeButton.hidden = true;
          cancel.focus();
        },
      );
      revokeButton.setAttribute("aria-label", `Revoke ${key.name}`);
      actions.append(revokeButton);
      row.append(info, actions, confirmation);
      list.append(row);
    }
  }

  async function refresh() {
    if (busy || panel.hidden) return;
    const current = generation;
    setBusy(true);
    message(errorText);
    byId("api-keys-loading").hidden = false;
    try {
      const response = await api("/api/keys");
      if (current !== generation) return;
      keys = response.keys;
      renderKeys();
    } catch (cause) {
      const error = uiFailure(cause);
      if (current === generation)
        handleError(error, "Could not load keys. Try refreshing.");
    } finally {
      if (current === generation) {
        byId("api-keys-loading").hidden = true;
        setBusy(false);
      }
    }
  }

  async function revoke(key: ApiKeyMetadata) {
    if (busy) return;
    const current = generation;
    setBusy(true);
    message(errorText);
    message(feedback);
    try {
      await api("/api/keys/revoke", { id: key.id });
      if (current !== generation) return;
      if (createdId === key.id) clearSecret();
      keys = keys.filter((item) => item.id !== key.id);
      renderKeys();
      message(feedback, `“${key.name}” revoked.`);
      refreshButton.disabled = false;
      refreshButton.focus({ preventScroll: true });
    } catch (cause) {
      const error = uiFailure(cause);
      if (current === generation)
        handleError(error, "Could not revoke this key. Try again.");
    } finally {
      if (current === generation) setBusy(false);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const name = nameInput.value.trim();
    if (!name || /\p{Cc}/u.test(name)) {
      nameInput.setCustomValidity("Enter a name without control characters.");
      nameInput.reportValidity();
      return;
    }
    const current = generation;
    setBusy(true);
    clearSecret();
    message(errorText);
    message(feedback);
    try {
      const result = await api("/api/keys", { name });
      if (current !== generation) return;
      keys.unshift(result.key);
      createdId = result.key.id;
      secretInput.value = result.secret;
      created.hidden = false;
      nameInput.value = "";
      renderKeys();
      secretInput.focus();
      secretInput.select();
      message(feedback, "Key created. Copy it before leaving this page.");
    } catch (cause) {
      const error = uiFailure(cause);
      if (current === generation)
        handleError(
          error,
          "Could not create a key. Refresh the list before trying again.",
        );
    } finally {
      if (current === generation) setBusy(false);
    }
  });
  nameInput.addEventListener("input", () => nameInput.setCustomValidity(""));

  async function copy(input: HTMLInputElement, label: string) {
    if (!input.value) return;
    const current = generation;
    message(feedback);
    // execCommand runs directly inside the click for private-LAN HTTP and iOS.
    input.focus();
    input.select();
    input.setSelectionRange(0, input.value.length);
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {}
    if (!copied && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(input.value);
        copied = true;
      } catch {}
    }
    if (current === generation)
      message(
        feedback,
        copied
          ? `${label} copied.`
          : "Text selected. Use Copy from your device’s selection menu.",
      );
  }

  byId("api-keys-button").addEventListener("click", () => {
    onOpen();
    generation += 1;
    panel.hidden = false;
    workspace.dataset.settings = "api-keys";
    setBackgroundInactive(true);
    panel.scrollTop = 0;
    byId("api-keys-count").textContent = "";
    byId("api-keys-empty").hidden = true;
    byId("api-keys-title").focus({ preventScroll: true });
    void refresh();
  });
  byId("api-keys-close").addEventListener("click", () => close());
  refreshButton.addEventListener("click", () => void refresh());
  byId("mcp-endpoint-copy").addEventListener(
    "click",
    () => void copy(endpoint, "Server URL"),
  );
  byId("api-key-copy").addEventListener(
    "click",
    () => void copy(secretInput, "API key"),
  );
  byId("api-key-dismiss").addEventListener("click", () => {
    clearSecret();
    message(feedback);
    nameInput.focus();
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  return { reset: () => close(false) };
}
