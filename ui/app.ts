import RFB from "/vendor/novnc/core/rfb.js";

import { asyncHandler, background } from "../src/async-boundary.js";
import { required } from "../src/invariants.js";
import { createAgentHandoff } from "./agent-handoff.js";
import { createApiKeys } from "./api-keys.js";
import { api, uiFailure } from "./api.js";
import { createBrowserControls } from "./browser-controls.js";
import { createClipboard } from "./clipboard.js";
import type { ControlState } from "./contracts.js";
import { element as domElement } from "./dom.js";
import { createBrowserFiles } from "./files.js";
import { createMobileKeyboard } from "./mobile-keyboard.js";
import { createMobileScroll } from "./mobile-scroll.js";

const byId = domElement;
const elements = {
  "login-screen": byId("login-screen"),
  "login-form": byId("login-form"),
  "login-title": byId("login-title"),
  "login-description": byId("login-description"),
  "login-error": byId("login-error"),
  "login-submit": byId("login-submit"),
  "login-submit-label": byId("login-submit-label"),
  username: byId("username"),
  password: byId("password"),
  "password-toggle": byId("password-toggle"),
  "password-note": byId("password-note"),
  "confirm-password": byId("confirm-password"),
  "confirm-password-field": byId("confirm-password-field"),
  "auth-loading": byId("auth-loading"),
  "auth-retry": byId("auth-retry"),
  "generate-password": byId("generate-password"),
  "generated-password-note": byId("generated-password-note"),
  workspace: byId("workspace"),
  "connection-status": byId("connection-status"),
  "connection-label": byId("connection-label"),
  "reconnect-button": byId("reconnect-button"),
  "logout-button": byId("logout-button"),
  "mode-icon": byId("mode-icon"),
  "mode-title": byId("mode-title"),
  "mode-description": byId("mode-description"),
  "lease-status": byId("lease-status"),
  "clipboard-button": byId("clipboard-button"),
  "take-button": byId("take-button"),
  "release-button": byId("release-button"),
  notice: byId("notice"),
  "clipboard-panel": byId("clipboard-panel"),
  "clipboard-text": byId("clipboard-text"),
  "clipboard-close": byId("clipboard-close"),
  "clipboard-send": byId("clipboard-send"),
  "browser-display": byId("browser-display"),
  "display-placeholder": byId("display-placeholder"),
  "display-title": byId("display-title"),
  "display-description": byId("display-description"),
  "view-label": byId("view-label"),
};

let authenticated = false;
let status: ControlState | null = null;
let apiOnline = false;
let actionInProgress = false;
let polling = false;
let renewing = false;
let rfb: RFB | null = null;
let connected = false;
let connectionMode: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let leaseTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 2000;
let authGeneration = 0;
let authMode: string | null = null;
let checkingAuth = false;
let submittingAuth = false;
let zoomed = false;

const mobileKeyboard = createMobileKeyboard({
  input: byId("mobile-keyboard-input"),
  panel: byId("keyboard-panel"),
  button: byId("keyboard-button"),
  closeButton: byId("keyboard-close"),
  enterButton: byId("keyboard-enter"),
  getRfb: () => rfb,
  canControl: () => connected && connectionMode === "control" && hasControl(),
  onOpen: () => {
    browserControls.close();
    closeClipboard();
    byId("more-menu").open = false;
  },
  onError: notice,
});
const browserControls = createBrowserControls({
  api,
  canControl: hasControl,
  isAuthenticated: () => authenticated,
  beforeAction: () => {
    mobileKeyboard.close();
    closeClipboard();
  },
  onOpen: () => {
    mobileKeyboard.close();
    closeClipboard();
    byId("more-menu").open = false;
  },
  onError: notice,
  onUnauthorized: () => {
    showLogin("Your session ended. Please sign in again.");
  },
});
const mobileScroll = createMobileScroll({
  display: elements["browser-display"],
  canScroll: () => connected && connectionMode === "control" && hasControl() && !zoomed,
});
const apiKeys = createApiKeys({
  api,
  onOpen: () => {
    browserFiles.reset();
    mobileKeyboard.close();
    browserControls.close();
    closeClipboard();
    byId("more-menu").open = false;
  },
  onUnauthorized: () => {
    showLogin("Your session ended. Please sign in again.");
  },
});
const browserFiles = createBrowserFiles({
  api,
  onOpen: () => {
    apiKeys.reset();
    mobileKeyboard.close();
    browserControls.close();
    closeClipboard();
    byId("more-menu").open = false;
  },
  onUnauthorized: () => {
    showLogin("Your session ended. Please sign in again.");
  },
});
const clipboard = createClipboard({
  api,
  getRfb: () => rfb,
  canControl: () => connected && connectionMode === "control" && hasControl(),
  onOpen: () => {
    mobileKeyboard.close();
    browserControls.close();
    byId("more-menu").open = false;
  },
  onUnauthorized: () => {
    showLogin("Your session ended. Please sign in again.");
  },
});
const agentHandoff = createAgentHandoff({
  api,
  onOpen: () => {
    mobileKeyboard.close();
    closeClipboard();
    byId("more-menu").open = false;
  },
  onState: (next) => {
    if (!authenticated || !status || next.revision < status.revision) {
      return;
    }
    status = { ...status, ...next, ready: status.ready && next.ready };
    scheduleLeaseExpiry();
    renderStatus();
    ensureConnection();
  },
  onUnauthorized: () => {
    showLogin("Your session ended. Please sign in again.");
  },
});

// Move the same controls so their state, focus order, and handlers stay shared.
const mobileLayout = window.matchMedia(
  "(max-width: 760px), (pointer: coarse) and (max-height: 520px) and (max-width: 960px)",
);
function syncMobileLayout() {
  const mobile = mobileLayout.matches;
  const toolbar = required(document.querySelector<HTMLElement>(".toolbar"));
  const controlBar = required(document.querySelector<HTMLElement>(".control-bar"));
  const controlActions = required(document.querySelector<HTMLElement>(".control-actions"));
  const bottomStack = required(document.querySelector<HTMLElement>(".bottom-stack"));
  if (mobile) {
    elements.workspace.prepend(toolbar);
    controlBar.append(controlActions);
    elements.workspace.insertBefore(byId("tabs-panel"), bottomStack);
  } else {
    controlBar.append(toolbar);
    required(document.querySelector<HTMLElement>(".toolbar-actions")).prepend(controlActions);
    bottomStack.prepend(byId("tabs-panel"));
  }
  const actions = mobile ? byId("mobile-session-actions") : controlActions;
  actions.append(byId("zoom-button"), elements["take-button"], elements["release-button"]);
  byId("session-summary").append(
    required(document.querySelector<HTMLElement>(".control-description")),
    elements["connection-status"],
  );
  byId("zoom-button").hidden = !mobile;
  if (!mobile) {
    zoomed = false;
    applyDisplayMode();
  }
  mobileKeyboard.setInline(mobile);
}
mobileLayout.addEventListener("change", syncMobileLayout);
syncMobileLayout();

function applyDisplayMode() {
  mobileScroll.cancel();
  if (rfb) {
    rfb.scaleViewport = !zoomed;
    rfb.clipViewport = zoomed;
    rfb.dragViewport = zoomed;
  }
  byId("zoom-button").setAttribute("aria-pressed", String(zoomed));
  byId("zoom-button").setAttribute(
    "aria-label",
    zoomed ? "Fit the browser to the screen" : "Zoom to actual size",
  );
  byId("zoom-button").title = zoomed ? "Fit the browser to the screen" : "Zoom to actual size";
  required(byId("zoom-button").querySelector("use")).setAttribute(
    "href",
    zoomed ? "#icon-fit" : "#icon-zoom",
  );
  byId("zoom-label").textContent = zoomed ? "Fit" : "Zoom";
  elements.workspace.dataset.zoomed = String(zoomed);
}

let viewportFrame: number | null = null;
function updateViewport() {
  if (viewportFrame) {
    return;
  }
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = null;
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty(
      "--viewport-height",
      `${viewport?.height || window.innerHeight}px`,
    );
    document.documentElement.style.setProperty("--viewport-top", `${viewport?.offsetTop || 0}px`);
    elements.workspace.dataset.compact = String((viewport?.height || window.innerHeight) < 520);
  });
}
window.visualViewport?.addEventListener("resize", updateViewport);
window.visualViewport?.addEventListener("scroll", updateViewport);
window.addEventListener("resize", updateViewport);
updateViewport();

function notice(message = "") {
  elements.notice.textContent = message;
  elements.notice.hidden = !message;
}

function connectionLabel(label: string, state = "connecting") {
  elements["connection-label"].textContent = label;
  elements["connection-status"].dataset.state = state;
  elements["connection-status"].title = label;
}

function placeholder(title: string, description: string) {
  elements["display-title"].textContent = title;
  elements["display-description"].textContent = description;
  elements["display-placeholder"].hidden = false;
}

function closeClipboard() {
  clipboard.close();
}

function disconnect() {
  mobileScroll.cancel();
  mobileKeyboard.close();
  closeClipboard();
  clearTimeout(retryTimer ?? undefined);
  retryTimer = null;
  const previous = rfb;
  rfb = null;
  connected = false;
  connectionMode = null;
  if (previous) {
    previous.disconnect();
  }
  elements["browser-display"].replaceChildren();
}

function clearPasswords() {
  elements.password.value = "";
  elements["confirm-password"].value = "";
  elements.password.type = "password";
  elements["password-toggle"].textContent = "Show";
  elements["password-toggle"].setAttribute("aria-label", "Show password");
  elements["password-toggle"].setAttribute("aria-pressed", "false");
  elements["generated-password-note"].hidden = true;
}

function authError(message = "") {
  elements["login-error"].textContent = message;
  elements["login-error"].hidden = !message;
}

function setAuthBusy(busy: boolean) {
  const setup = authMode === "setup";
  elements.username.readOnly = busy;
  elements.password.readOnly = busy;
  elements["password-toggle"].disabled = busy;
  elements["generate-password"].disabled = busy;
  elements["confirm-password"].disabled = !setup;
  elements["confirm-password"].readOnly = busy;
  elements["login-submit"].disabled = busy;
  elements["login-form"].setAttribute("aria-busy", String(busy));
  elements["login-submit-label"].textContent = busy
    ? setup
      ? "Creating account…"
      : "Signing in…"
    : setup
      ? "Create account"
      : "Sign in";
}

function renderAuthForm() {
  const setup = authMode === "setup";
  elements["login-title"].textContent = setup ? "Create your account" : "Welcome back";
  elements["login-description"].textContent = setup
    ? "Choose a username and password to access your browser. You only need to do this once."
    : "Sign in to view your browser or take the controls.";
  elements.password.autocomplete = setup ? "new-password" : "current-password";
  elements["login-form"].action = setup ? "/api/auth/setup" : "/api/login";
  if (setup) {
    elements.password.setAttribute("passwordrules", "minlength: 12; maxlength: 256;");
  } else {
    elements.password.removeAttribute("passwordrules");
  }
  elements.password.minLength = setup ? 12 : 1;
  elements["password-note"].hidden = !setup;
  elements["generate-password"].hidden = !setup;
  if (!setup) {
    elements["generated-password-note"].hidden = true;
  }
  elements["confirm-password-field"].hidden = !setup;
  elements["confirm-password"].required = setup;
  elements["auth-loading"].hidden = true;
  elements["auth-retry"].hidden = true;
  elements["login-form"].hidden = false;
  setAuthBusy(false);
}

function showLogin(message = "") {
  agentHandoff.reset();
  browserFiles.reset();
  authGeneration += 1;
  authenticated = false;
  apiKeys.reset();
  browserControls.reset();
  byId("more-menu").open = false;
  apiOnline = false;
  status = null;
  clearTimeout(leaseTimer ?? undefined);
  leaseTimer = null;
  disconnect();
  closeClipboard();
  notice();
  elements.workspace.hidden = true;
  elements["login-screen"].hidden = false;
  clearPasswords();
  authError(message);
  if (authMode === null) {
    background(refreshAuthStatus(message));
  } else {
    renderAuthForm();
  }
}

async function refreshAuthStatus(message = "") {
  if (checkingAuth) {
    return;
  }
  checkingAuth = true;
  const generation = ++authGeneration;
  elements["login-form"].hidden = true;
  elements["auth-retry"].hidden = true;
  elements["auth-loading"].hidden = false;
  authError();
  try {
    const next = await api("/api/auth/status");
    if (generation !== authGeneration) {
      return;
    }
    if (typeof next.configured !== "boolean" || typeof next.authenticated !== "boolean") {
      throw new TypeError("The server returned an invalid sign-in status.");
    }
    authMode = next.configured ? "login" : "setup";
    if (next.authenticated) {
      clearPasswords();
      authenticated = true;
      elements["login-screen"].hidden = true;
      elements.workspace.hidden = false;
      await refreshStatus();
    } else {
      showLogin(message);
    }
  } catch {
    if (generation !== authGeneration) {
      return;
    }
    elements["auth-loading"].hidden = true;
    elements["auth-retry"].hidden = false;
    authError("Could not connect to the server. Check your connection and try again.");
  } finally {
    checkingAuth = false;
  }
}

function ownsLease() {
  return Boolean(
    apiOnline &&
    status?.ready &&
    status.ownsControl &&
    ["pending", "human"].includes(status.mode) &&
    Number.isFinite(status.leaseExpiresAt) &&
    (status.leaseExpiresAt ?? 0) > Date.now(),
  );
}

function hasControl() {
  return ownsLease() && status?.mode === "human";
}

function scheduleLeaseExpiry() {
  clearTimeout(leaseTimer ?? undefined);
  leaseTimer = null;
  if (!status?.ownsControl || !Number.isFinite(status.leaseExpiresAt)) {
    return;
  }
  leaseTimer = setTimeout(
    () => {
      leaseTimer = null;
      renderStatus();
      ensureConnection();
      background(refreshStatus());
    },
    Math.max(0, (status.leaseExpiresAt ?? 0) - Date.now() + 1),
  );
}

function updateLease() {
  const expiry = status?.leaseExpiresAt;
  const remaining = expiry ? Math.max(0, Math.ceil((expiry - Date.now()) / 1000)) : null;
  elements["lease-status"].hidden = !ownsLease() || remaining === null;
  elements["lease-status"].textContent = remaining === null ? "" : `Control lease · ${remaining}s`;
}

function renderStatus() {
  agentHandoff.sync(status);
  browserFiles.sync(status?.recording ?? null);
  const mine = hasControl();
  const pending = status?.mode === "pending";
  const human = status?.mode === "human";
  const pendingMine = pending && ownsLease();
  elements.workspace.dataset.mode = mine ? "human" : pending ? "pending" : "agent";
  elements["take-button"].hidden = mine || pendingMine;
  elements["release-button"].hidden = !mine && !pendingMine;
  const releaseLabel = pendingMine ? "Cancel request" : "Return to agent";
  byId("release-label").textContent = releaseLabel;
  elements["release-button"].setAttribute("aria-label", releaseLabel);
  elements["release-button"].title = releaseLabel;
  byId("release-icon").setAttribute("href", pendingMine ? "#icon-close" : "#icon-hand");
  elements["take-button"].disabled =
    actionInProgress || !apiOnline || !status?.ready || pending || human;
  elements["release-button"].disabled = actionInProgress || !apiOnline;
  elements["clipboard-button"].hidden = !mine;
  elements["clipboard-button"].disabled = !connected;
  clipboard.sync();
  elements["reconnect-button"].disabled = !apiOnline || !status?.ready;
  if (!mine) {
    closeClipboard();
  }
  if (rfb) {
    rfb.viewOnly = !mine;
  }
  mobileKeyboard.sync();
  browserControls.sync();
  byId("zoom-button").disabled = !connected;

  if (!apiOnline) {
    elements["mode-title"].textContent = "Connection interrupted";
    elements["mode-description"].textContent =
      "Browser input is paused while the server reconnects.";
    elements["mode-icon"].textContent = "○";
  } else if (status?.error) {
    elements["mode-title"].textContent = "Browser requires attention";
    elements["mode-description"].textContent = status.error;
    elements["mode-icon"].textContent = "!";
  } else if (!status?.ready) {
    elements["mode-title"].textContent = "Browser is starting";
    elements["mode-description"].textContent = "Your saved profile will be available shortly.";
    elements["mode-icon"].textContent = "○";
  } else if (status.ownsControl && !ownsLease()) {
    elements["mode-title"].textContent = "Control lease ended";
    elements["mode-description"].textContent =
      "Input is paused while the server confirms who has control.";
    elements["mode-icon"].textContent = "○";
  } else if (mine) {
    elements["mode-title"].textContent = "You have control";
    elements["mode-description"].textContent =
      "The agent is paused. Sign in or use the browser, then return control.";
    elements["mode-icon"].textContent = "↗";
  } else if (pending) {
    elements["mode-title"].textContent = "Waiting for the current action";
    elements["mode-description"].textContent =
      "New agent actions are paused. Human control will begin when the current action finishes.";
    elements["mode-icon"].textContent = "◷";
  } else if (human) {
    elements["mode-title"].textContent = "Another viewer has control";
    elements["mode-description"].textContent =
      "You can watch the session. Control will be available when they finish.";
    elements["mode-icon"].textContent = "◎";
  } else {
    elements["mode-title"].textContent = "Agent control";
    elements["mode-description"].textContent =
      "You are watching live. Take control whenever you need to sign in or step in.";
    elements["mode-icon"].textContent = "◎";
  }
  elements["view-label"].textContent = mine
    ? "Live browser · interactive"
    : "Live browser · view only";
  updateLease();
}

function scheduleReconnect() {
  if (retryTimer || !authenticated || !apiOnline || !status?.ready) {
    return;
  }
  retryTimer = setTimeout(() => {
    retryTimer = null;
    ensureConnection();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
}

function ensureConnection() {
  if (!authenticated || !apiOnline || !status?.ready) {
    return;
  }
  const mode = hasControl() ? "control" : "view";
  if (rfb && connectionMode === mode) {
    return;
  }
  if (!rfb && retryTimer) {
    return;
  }
  disconnect();
  connectionMode = mode;
  connectionLabel("Connecting");
  placeholder("Connecting to your browser", "The live session will appear here.");
  try {
    const url = new URL("/vnc", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("mode", mode);
    const client = new RFB(elements["browser-display"], url.href);
    rfb = client;
    applyDisplayMode();
    client.resizeSession = false;
    client.background = "#09090b";
    client.viewOnly = mode !== "control";
    client.addEventListener("connect", () => {
      if (rfb !== client) {
        return;
      }
      connected = true;
      reconnectDelay = 2000;
      connectionLabel("Connected", "connected");
      elements["display-placeholder"].hidden = true;
      renderStatus();
    });
    client.addEventListener("disconnect", () => {
      if (rfb !== client) {
        return;
      }
      rfb = null;
      connected = false;
      connectionMode = null;
      connectionLabel("Reconnecting", "error");
      placeholder(
        "Browser display disconnected",
        "Reconnecting automatically. You can also use the Reconnect button.",
      );
      renderStatus();
      scheduleReconnect();
    });
    client.addEventListener("securityfailure", () => {
      if (rfb === client) {
        notice("The browser display could not authenticate. Check the server configuration.");
      }
    });
    client.addEventListener("credentialsrequired", () => {
      if (rfb === client) {
        notice(
          "The browser display requested additional authentication. Check the server configuration.",
        );
      }
    });
  } catch {
    disconnect();
    connectionLabel("Display unavailable", "error");
    placeholder(
      "The browser display is unavailable",
      "Retrying automatically. Check the server if the problem continues.",
    );
    scheduleReconnect();
  }
}

async function refreshStatus() {
  if (polling) {
    return;
  }
  polling = true;
  const generation = authGeneration;
  try {
    const next = await api("/api/status");
    if (generation !== authGeneration) {
      return;
    }
    if (status && next.revision < status.revision) {
      return;
    }
    const recovered = !apiOnline;
    status = next;
    apiOnline = true;
    authenticated = true;
    agentHandoff.connect();
    scheduleLeaseExpiry();
    elements["login-screen"].hidden = true;
    elements.workspace.hidden = false;
    if (recovered) {
      notice();
    }
    renderStatus();
    if (status?.ready) {
      ensureConnection();
    } else {
      disconnect();
      if (status?.error) {
        connectionLabel("Recovery required", "error");
        placeholder("Browser requires attention", status.error);
        notice(status.error);
      } else {
        connectionLabel("Starting");
        placeholder(
          "Starting your browser",
          "Preparing the persistent browser profile. This can take a moment.",
        );
      }
    }
    background(browserControls.refresh());
  } catch (cause) {
    const error = uiFailure(cause);
    if (generation !== authGeneration) {
      return;
    }
    if (error.statusCode === 401) {
      showLogin(authenticated ? "Your session ended. Please sign in again." : "");
    } else if (authenticated) {
      apiOnline = false;
      renderStatus();
      connectionLabel("Server unavailable", "error");
      notice("The server is not responding. Reconnecting automatically; browser input is paused.");
    } else {
      elements["login-error"].textContent =
        "The server is unavailable. Check the connection and try again.";
      elements["login-error"].hidden = false;
    }
  } finally {
    polling = false;
  }
}

async function controlAction(path: string) {
  if (actionInProgress) {
    return;
  }
  actionInProgress = true;
  notice();
  renderStatus();
  try {
    await api(path, {});
    await refreshStatus();
  } catch (cause) {
    const error = uiFailure(cause);
    if (error.statusCode === 401) {
      showLogin("Your session ended. Please sign in again.");
    } else {
      notice(
        error.name === "TimeoutError"
          ? "The request is still waiting. The session status will update automatically."
          : error.message || "The request failed. Please try again.",
      );
      await refreshStatus();
    }
  } finally {
    actionInProgress = false;
    renderStatus();
  }
}

elements["login-form"].addEventListener(
  "submit",
  asyncHandler(async (event: Event) => {
    event.preventDefault();
    if (submittingAuth || authMode === null) {
      return;
    }
    const setup = authMode === "setup";
    if (setup && elements.password.value !== elements["confirm-password"].value) {
      authError("Your passwords do not match. Enter the same password in both fields.");
      elements["confirm-password"].focus();
      return;
    }
    submittingAuth = true;
    setAuthBusy(true);
    authError();
    try {
      const result = await api(setup ? "/api/auth/setup" : "/api/login", {
        username: elements.username.value.trim(),
        password: elements.password.value,
      });
      if (!result.authenticated) {
        throw new Error("Could not confirm your sign-in. Please try again.");
      }
      // Keep the submitted form intact until navigation so password managers can save it.
      window.location.replace("/");
    } catch (cause) {
      const error = uiFailure(cause);
      if (setup && error.statusCode === 409) {
        clearPasswords();
        await refreshAuthStatus("An account has already been created. Sign in to continue.");
      } else {
        authError(
          error.statusCode === 401
            ? "That username or password was not accepted."
            : error.name === "TimeoutError"
              ? "The server took too long to respond. Please try again."
              : error.message || "Could not sign in. Please try again.",
        );
      }
    } finally {
      submittingAuth = false;
      setAuthBusy(false);
    }
  }),
);

elements["auth-retry"].addEventListener(
  "click",
  asyncHandler(() => refreshAuthStatus()),
);
elements["generate-password"].addEventListener("click", () => {
  if (authMode !== "setup" || submittingAuth) {
    return;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  try {
    // The 64-character alphabet divides 256 exactly, avoiding modulo bias.
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const password = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
    for (const field of [elements.password, elements["confirm-password"]]) {
      field.value = password;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
    authError();
    elements["generated-password-note"].hidden = false;
    elements.password.focus();
  } catch {
    authError("Password generation is unavailable. Use your password manager or enter a password.");
  }
});
elements.password.addEventListener("input", () => {
  elements["generated-password-note"].hidden = true;
});
elements["password-toggle"].addEventListener("click", () => {
  const visible = elements.password.type === "password";
  elements.password.type = visible ? "text" : "password";
  elements["password-toggle"].textContent = visible ? "Hide" : "Show";
  elements["password-toggle"].setAttribute(
    "aria-label",
    visible ? "Hide password" : "Show password",
  );
  elements["password-toggle"].setAttribute("aria-pressed", String(visible));
});
elements["take-button"].addEventListener(
  "click",
  asyncHandler(() => controlAction("/api/control/take")),
);
elements["release-button"].addEventListener("click", () => {
  mobileKeyboard.close();
  background(controlAction("/api/control/release"));
});
byId("zoom-button").addEventListener("click", () => {
  zoomed = !zoomed;
  applyDisplayMode();
});
elements["browser-display"].addEventListener(
  "pointerdown",
  () => {
    mobileKeyboard.reset();
  },
  { capture: true },
);
elements["reconnect-button"].addEventListener("click", () => {
  byId("more-menu").open = false;
  disconnect();
  reconnectDelay = 2000;
  ensureConnection();
});
elements["logout-button"].addEventListener(
  "click",
  asyncHandler(async () => {
    elements["logout-button"].disabled = true;
    if (rfb) {
      rfb.viewOnly = true;
    }
    try {
      await api("/api/logout", {});
      showLogin();
    } catch (cause) {
      const error = uiFailure(cause);
      if (error.statusCode === 401) {
        showLogin();
      } else {
        notice("Could not sign out. Please retry when the server is reachable.");
        renderStatus();
      }
    } finally {
      elements["logout-button"].disabled = false;
    }
  }),
);
const moreMenu = byId("more-menu");
moreMenu.addEventListener("toggle", () => {
  if (!moreMenu.open) {
    return;
  }
  mobileKeyboard.close();
  browserControls.close();
  closeClipboard();
});
document.addEventListener("pointerdown", (event) => {
  // SAFETY: A pointer event delivered through the dashboard document has a DOM Node target.
  if (moreMenu.open && !moreMenu.contains(event.target as Node)) {
    moreMenu.open = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (moreMenu.open) {
    event.preventDefault();
    moreMenu.open = false;
    required(moreMenu.querySelector("summary")).focus({ preventScroll: true });
  } else if (!elements["clipboard-panel"].hidden) {
    event.preventDefault();
    closeClipboard();
    required(moreMenu.querySelector("summary")).focus({ preventScroll: true });
  }
});

setInterval(() => {
  if (authenticated) {
    background(refreshStatus());
  }
}, 2000);
setInterval(updateLease, 1000);
setInterval(
  asyncHandler(async () => {
    if (!ownsLease() || renewing) {
      return;
    }
    renewing = true;
    try {
      await api("/api/control/renew", {});
      await refreshStatus();
    } catch (cause) {
      const error = uiFailure(cause);
      if (error.statusCode === 401) {
        showLogin("Your session ended. Please sign in again.");
      } else {
        apiOnline = false;
        renderStatus();
        notice("Control could not be renewed. Checking the session before allowing more input.");
        await refreshStatus();
      }
    } finally {
      renewing = false;
    }
  }),
  30_000,
);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && authenticated) {
    background(refreshStatus());
  }
});
window.addEventListener("online", () => {
  if (authenticated) {
    background(refreshStatus());
  } else if (!elements["auth-retry"].hidden) {
    background(refreshAuthStatus());
  }
});
window.addEventListener("pagehide", disconnect);
window.addEventListener("pagehide", () => {
  agentHandoff.reset();
});
window.addEventListener("pagehide", () => {
  apiKeys.reset();
});
window.addEventListener("pagehide", () => {
  browserFiles.reset();
});
background(refreshAuthStatus());
