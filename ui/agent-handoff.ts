import { asyncHandler, background } from "../src/async-boundary.js";
import { jsonObject } from "../src/invariants.js";
import { uiFailure } from "./api.js";
import type { ControlState, UiOptions } from "./contracts.js";
import { element as domElement } from "./dom.js";

export function createAgentHandoff({
  api,
  onState,
  onOpen,
  onUnauthorized,
}: UiOptions & { onState: (state: ControlState) => void }) {
  const byId = domElement;
  const dialog = byId("agent-handoff");
  const cancel = byId("agent-handoff-cancel");
  const countdown = byId("agent-handoff-countdown");
  const errorText = byId("agent-handoff-error");
  let source: EventSource | null = null;
  let request: ControlState["agentRequest"] = null;
  let deadline = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let previousFocus: HTMLButtonElement | null = null;
  let busy = false;

  function close(restoreFocus = false) {
    clearInterval(timer ?? undefined);
    timer = null;
    request = null;
    busy = false;
    if (dialog.open) {
      dialog.close();
    }
    errorText.textContent = "";
    errorText.hidden = true;
    if (restoreFocus && previousFocus?.isConnected && !previousFocus.disabled) {
      previousFocus.focus({ preventScroll: true });
    }
    previousFocus = null;
  }

  function render() {
    const seconds = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    countdown.textContent =
      seconds > 0
        ? `Taking control in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`
        : "Handing control to the agent…";
    cancel.disabled = busy || !request?.canCancel || seconds === 0;
    cancel.textContent = busy ? "Keeping control…" : "Cancel · Keep control";
  }

  function sync(state: ControlState | null) {
    const next = state?.agentRequest;
    if (!next) {
      close(Boolean(state?.ownsControl));
      return;
    }
    if (request?.id !== next.id) {
      close();
      // SAFETY: Dashboard focus is held by native HTML controls; null and disconnected controls are checked before restoration.
      previousFocus = document.activeElement as HTMLButtonElement | null;
      onOpen();
      dialog.showModal();
      cancel.focus({ preventScroll: true });
      timer = setInterval(render, 100);
    }
    request = next;
    deadline = performance.now() + Math.max(0, next.deadline - state.serverNow);
    render();
  }

  async function keepControl() {
    if (!request || busy || cancel.disabled) {
      return;
    }
    const { id } = request;
    busy = true;
    render();
    try {
      const state = await api("/api/control/agent/cancel", { id });
      if (request?.id === id) {
        onState(state);
        sync(state);
      }
    } catch (cause) {
      const error = uiFailure(cause);
      if (request?.id !== id) {
        return;
      }
      if (error.statusCode === 401) {
        onUnauthorized();
      } else {
        errorText.textContent = error.message || "Could not cancel. Check your connection.";
        errorText.hidden = false;
      }
    } finally {
      if (request?.id === id) {
        busy = false;
        render();
      }
    }
  }

  cancel.addEventListener(
    "click",
    asyncHandler(() => keepControl()),
  );
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    background(keepControl());
  });
  function connect() {
    if (source) {
      return;
    }
    const client = new EventSource("/api/control/events");
    source = client;
    client.addEventListener("message", (event: MessageEvent<string>) => {
      if (source !== client) {
        return;
      }
      try {
        // SAFETY: This same-origin event endpoint emits the gateway ControlState contract.
        const nextState = jsonObject(event.data) as ControlState;
        onState(nextState);
      } catch {
        /* Normal polling also refreshes control state. */
      }
    });
    client.addEventListener("error", () => {
      if (source === client) {
        close();
      }
    });
  }
  function reset() {
    source?.close();
    source = null;
    close();
  }
  return { connect, sync, reset };
}
