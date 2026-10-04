import { background } from "../src/async-boundary.js";
import { uiFailure } from "./api.js";
import type { ClipboardOptions, RFB } from "./contracts.js";

type ShortcutOptions = Omit<ClipboardOptions, "onOpen"> & {
  display: HTMLElement;
  onFallback: (text: string, message: string) => void;
};

export function sendClipboardShortcut(client: RFB, key: number, code: string) {
  client.sendKey(0xff_e3, "ControlLeft", true);
  try {
    client.sendKey(key, code);
  } finally {
    client.sendKey(0xff_e3, "ControlLeft", false);
  }
}

// Capture before noVNC so a local paste cannot race a remote Ctrl+V.
export function createClipboardShortcuts({
  display,
  api,
  getRfb,
  canControl,
  onFallback,
  onUnauthorized,
}: ShortcutOptions) {
  let generation = 0;
  let busy = false;
  const commandKeys = new Set<string>();
  const controlKeys = new Set<string>();
  const handledKeys = new Set<string>();

  function current(id: number, client: RFB) {
    return generation === id && canControl() && getRfb() === client;
  }

  function reset() {
    generation++;
    busy = false;
    const client = getRfb();
    if ((commandKeys.size || controlKeys.size) && client && canControl()) {
      client.sendKey(0xff_e3, "ControlLeft", false);
    }
    commandKeys.clear();
    controlKeys.clear();
    handledKeys.clear();
  }

  function fail(cause: unknown, text: string) {
    const error = uiFailure(cause);
    if (error.statusCode === 401) {
      onUnauthorized();
    } else {
      onFallback(text, error.message || "Clipboard transfer failed. Use the clipboard panel.");
    }
  }

  async function readSelection(id: number, client: RFB) {
    shortcut(client, 0x63, "KeyC");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    if (!current(id, client)) {
      throw new Error("Clipboard transfer cancelled.");
    }
    const { text } = await api("/api/clipboard");
    if (!current(id, client)) {
      throw new Error("Clipboard transfer cancelled.");
    }
    return text;
  }

  function shortcut(client: RFB, key: number, code: string) {
    sendClipboardShortcut(client, key, code);
    if (commandKeys.size || controlKeys.size) {
      client.sendKey(0xff_e3, "ControlLeft", true);
    }
  }

  async function copy(client: RFB) {
    const id = generation;
    busy = true;
    let text = "";
    let selection: Promise<string> | undefined;
    try {
      selection = readSelection(id, client);
      const pendingSelection = selection;
      // Begin the browser write within the keyboard gesture. Promise-backed
      // ClipboardItem data preserves activation while the remote read finishes.
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        const data = (async () => {
          text = await pendingSelection;
          return new Blob([text], { type: "text/plain" });
        })();
        // Observe the read even if write() rejects before consuming its data.
        background(data, () => {
          // The outer copy operation reports errors from this same read.
        });
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": data })]);
      } else {
        text = await selection;
        if (!navigator.clipboard?.writeText) {
          throw new Error("Text ready. Use Copy to device in the clipboard panel.");
        }
        await navigator.clipboard.writeText(text);
      }
    } catch (cause) {
      let error = cause;
      if (selection) {
        try {
          text = await selection;
          // oxlint-disable-next-line unicorn/catch-error-name -- Keep the clipboard-write failure distinct from the subsequent read failure.
        } catch (readFailure) {
          error = readFailure;
        }
      }
      if (current(id, client)) {
        fail(error, text);
      }
    } finally {
      if (current(id, client)) {
        busy = false;
      }
    }
  }

  async function paste(client: RFB, source: string | Promise<string>) {
    const id = generation;
    busy = true;
    let text = "";
    try {
      text = typeof source === "string" ? source : await source;
      if (!current(id, client)) {
        return;
      }
      if (!text) {
        throw new Error(
          "The clipboard contains no plain text. Use the clipboard panel to paste text.",
        );
      }
      await api("/api/clipboard", { text });
      if (current(id, client)) {
        shortcut(client, 0x76, "KeyV");
      }
    } catch (cause) {
      if (current(id, client)) {
        fail(cause, text);
      }
    } finally {
      if (current(id, client)) {
        busy = false;
      }
    }
  }

  display.addEventListener(
    "keydown",
    (event) => {
      const client = getRfb();
      if (
        event.target !== display.querySelector("canvas") ||
        !canControl() ||
        !client ||
        event.isComposing
      ) {
        return;
      }
      if (event.key === "Meta") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!commandKeys.has(event.code)) {
          commandKeys.add(event.code);
          client.sendKey(0xff_e3, "ControlLeft", true);
        }
        return;
      }
      if (event.key === "Control") {
        controlKeys.add(event.code);
        return;
      }
      const key = event.key.toLowerCase();
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        !["c", "v"].includes(key)
      ) {
        return;
      }
      event.stopImmediatePropagation();
      handledKeys.add(event.code);
      if (key === "c" || busy || event.repeat) {
        event.preventDefault();
      }
      if (key === "c" && !busy && !event.repeat) {
        background(copy(client));
      } else if (key === "v" && !busy && !event.repeat && navigator.clipboard?.readText) {
        // Some macOS browsers do not fire a native paste event on a canvas.
        // Start readText within the shortcut gesture, before any remote request.
        event.preventDefault();
        background(paste(client, navigator.clipboard.readText()));
      }
      // Allow the native paste event to supply local clipboard text on HTTP too.
    },
    true,
  );

  display.addEventListener(
    "keyup",
    (event) => {
      if (controlKeys.delete(event.code) && !controlKeys.size && !commandKeys.size) {
        const client = getRfb();
        if (client && canControl()) {
          client.sendKey(0xff_e3, "ControlLeft", false);
        }
      }
      if (commandKeys.delete(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const client = getRfb();
        if (!commandKeys.size && !controlKeys.size && client && canControl()) {
          client.sendKey(0xff_e3, "ControlLeft", false);
        }
      } else if (handledKeys.delete(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  display.addEventListener(
    "paste",
    (event) => {
      const client = getRfb();
      if (event.target !== display.querySelector("canvas") || !canControl() || !client) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (busy) {
        return;
      }
      const text = event.clipboardData?.getData("text/plain");
      if (!text) {
        onFallback(
          "",
          "The clipboard contains no plain text. Use the clipboard panel to paste text.",
        );
        return;
      }
      background(paste(client, text));
    },
    true,
  );

  display.addEventListener("focusout", () => {
    if (commandKeys.size || controlKeys.size) {
      const client = getRfb();
      if (client && canControl()) {
        client.sendKey(0xff_e3, "ControlLeft", false);
      }
      commandKeys.clear();
      controlKeys.clear();
    }
  });

  return {
    reset,
    sync() {
      if (!canControl()) {
        reset();
      }
    },
  };
}
