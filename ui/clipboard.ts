import { uiFailure } from "./api.js";
import type {
  ClipboardOptions,
  ApiKeyMetadata,
  SavedFile,
  RecordingStatus,
  BrowserTabs,
  RFB,
} from "./contracts.js";
import { element as domElement, type DomElements } from "./dom.js";
export function createClipboard({
  api,
  getRfb,
  canControl,
  onOpen,
  onUnauthorized,
}: ClipboardOptions) {
  const byId = domElement;
  const panel = byId("clipboard-panel");
  const input = byId("clipboard-text");
  const button = byId("clipboard-button");
  const readButton = byId("clipboard-read");
  const copyButton = byId("clipboard-copy");
  const pasteButton = byId("clipboard-send");
  const feedback = byId("clipboard-status");
  let generation = 0;
  let busy = false;

  function message(text = "") {
    feedback.textContent = text;
    feedback.hidden = !text;
  }

  function close() {
    generation++;
    busy = false;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    input.value = "";
    input.readOnly = false;
    panel.setAttribute("aria-busy", "false");
    message();
  }

  function sync() {
    if (!canControl()) close();
    readButton.disabled = busy || !canControl();
    copyButton.disabled = busy || !canControl() || !input.value;
    pasteButton.disabled = busy || !canControl() || !input.value;
    input.readOnly = busy;
    panel.setAttribute("aria-busy", String(busy));
  }

  function current(id: number, client: RFB | null) {
    return (
      id === generation && !panel.hidden && canControl() && getRfb() === client
    );
  }

  function shortcut(client: RFB | null, key: number, code: string) {
    client!.sendKey(0xffe3, "ControlLeft", true);
    try {
      client!.sendKey(key, code);
    } finally {
      client!.sendKey(0xffe3, "ControlLeft", false);
    }
  }

  function fail(cause: unknown) {
    const error = uiFailure(cause);
    if (error.statusCode === 401) onUnauthorized();
    else
      message(
        error.message ||
          "Clipboard transfer failed. Check the connection and try again.",
      );
  }

  button.addEventListener("click", () => {
    if (!canControl()) return;
    if (!panel.hidden) {
      close();
      return;
    }
    onOpen();
    close();
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    sync();
    input.focus({ preventScroll: true });
  });
  byId("clipboard-close").addEventListener("click", () => {
    close();
    byId("more-menu").querySelector("summary")!.focus({ preventScroll: true });
  });
  input.addEventListener("input", () => {
    message();
    sync();
  });

  readButton.addEventListener("click", async () => {
    if (busy || !canControl()) return;
    const id = generation;
    const client = getRfb();
    busy = true;
    message("Copying from the browser…");
    sync();
    try {
      // Local focus leaves Chromium's selection intact. Allow the VNC shortcut
      // to reach the desktop before reading its Unicode clipboard through HTTP.
      shortcut(client, 0x63, "KeyC");
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!current(id, client)) return;
      const { text } = await api("/api/clipboard");
      if (!current(id, client)) return;
      input.value = text;
      message(
        text
          ? "Ready to copy to your device."
          : "Select text in the browser, then try copying again.",
      );
    } catch (cause) {
      const error = uiFailure(cause);
      if (current(id, client)) fail(error);
    } finally {
      if (current(id, client)) {
        busy = false;
        sync();
      }
    }
  });

  copyButton.addEventListener("click", async () => {
    if (busy || !canControl() || !input.value) return;
    const id = generation;
    const client = getRfb();
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, input.value.length);
    // The synchronous gesture works on HTTP, including devices without the
    // secure-context Clipboard API. Leave the text selected for manual copying.
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      /* Use the available fallback. */
    }
    if (copied) {
      message("Copied to your device.");
      return;
    }
    if (!navigator.clipboard?.writeText) {
      message("Text selected. Use your device’s Copy action.");
      return;
    }
    const text = input.value;
    busy = true;
    sync();
    try {
      await navigator.clipboard.writeText(text);
      if (current(id, client)) message("Copied to your device.");
    } catch {
      if (current(id, client))
        message("Text selected. Use your device’s Copy action.");
    } finally {
      if (current(id, client)) {
        busy = false;
        sync();
      }
    }
  });

  pasteButton.addEventListener("click", async () => {
    if (busy || !canControl() || !input.value) return;
    const id = generation;
    const client = getRfb();
    busy = true;
    message("Pasting into the browser…");
    sync();
    try {
      await api("/api/clipboard", { text: input.value });
      if (!current(id, client)) return;
      shortcut(client, 0x76, "KeyV");
      close();
      client!.focus();
    } catch (cause) {
      const error = uiFailure(cause);
      if (current(id, client)) fail(error);
    } finally {
      if (current(id, client)) {
        busy = false;
        sync();
      }
    }
  });
  sync();
  return { close, sync };
}
