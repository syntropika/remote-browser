import type { RFB } from "./contracts.js";
interface KeyboardOptions {
  input: HTMLInputElement;
  panel: HTMLElement;
  button: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  enterButton: HTMLButtonElement;
  getRfb: () => RFB | null;
  canControl: () => boolean;
  onError?: (message: string) => void;
  onOpen?: () => void;
}
const SENTINEL = "\u200b";
const MAX_TEXT_LENGTH = 4096;
const KEYS: Record<string, [number, string]> = {
  Enter: [0xff0d, "Enter"],
  Backspace: [0xff08, "Backspace"],
  Delete: [0xffff, "Delete"],
  Tab: [0xff09, "Tab"],
};

// The local input is only a keyboard bridge. It never mirrors the remote field.
export function createMobileKeyboard({
  input,
  panel,
  button,
  closeButton,
  enterButton,
  getRfb,
  canControl,
  onError = (_message: string) => {},
  onOpen = () => {},
}: KeyboardOptions) {
  let opened = false;
  let inline = false;
  let composing = false;
  let compositionEcho: string | null = null;
  let focusedRfb: RFB | null = null;
  let previousFocusOnClick = true;
  const inputPlaceholder = input.placeholder;

  function available() {
    return Boolean(canControl() && getRfb() && !getRfb()!.viewOnly);
  }

  function clearBuffer() {
    input.value = opened ? SENTINEL : "";
    if (opened) input.setSelectionRange(SENTINEL.length, SENTINEL.length);
  }

  function reset() {
    composing = false;
    compositionEcho = null;
    clearBuffer();
  }

  function updateVisibility() {
    panel.hidden = !inline && !opened;
    button.setAttribute("aria-expanded", String(!panel.hidden));
  }

  function close({ restoreFocus = false } = {}) {
    const wasOpen = opened;
    const activeElement = panel.ownerDocument.activeElement;
    opened = false;
    updateVisibility();
    reset();
    input.blur();
    if (inline && panel.contains(activeElement))
      (activeElement as HTMLElement).blur();
    if (focusedRfb) focusedRfb!.focusOnClick = previousFocusOnClick;
    focusedRfb = null;
    if (wasOpen && restoreFocus && !inline && !button.disabled)
      button.focus({ preventScroll: true });
  }

  function activate() {
    if (!available()) {
      close();
      return false;
    }
    if (!opened) onOpen();
    if (focusedRfb !== getRfb()) {
      if (focusedRfb) focusedRfb!.focusOnClick = previousFocusOnClick;
      focusedRfb = getRfb();
      previousFocusOnClick = focusedRfb!.focusOnClick;
      focusedRfb!.focusOnClick = false;
    }
    opened = true;
    updateVisibility();
    reset();
    return true;
  }

  function open() {
    if (!activate()) return;
    // Keep focus inside the user gesture: iOS will not show its keyboard later.
    input.focus({ preventScroll: true });
  }

  function setInline(value: boolean) {
    const next = Boolean(value);
    if (next === inline) return;
    inline = next;
    // A layout change must not summon the native keyboard or retain a draft.
    close();
    sync();
  }

  function sync() {
    const enabled = available();
    button.disabled = !enabled;
    input.disabled = !enabled;
    input.placeholder = enabled
      ? inputPlaceholder
      : canControl()
        ? "Connecting keyboard…"
        : "Take control to type";
    enterButton.disabled = !enabled;
    if (!enabled || (opened && focusedRfb !== getRfb())) close();
  }

  function sendKey(keysym: number, code?: string) {
    if (!opened || !available() || focusedRfb !== getRfb()) {
      close();
      return false;
    }
    try {
      getRfb()!.sendKey(keysym, code);
      return true;
    } catch {
      close();
      onError("Could not send keyboard input. Reconnect and try again.");
      return false;
    }
  }

  function sendSpecial(name: string) {
    return sendKey(...KEYS[name]);
  }

  function sendText(text: string) {
    const characters = Array.from(text.replace(/\r\n?/g, "\n"));
    if (characters.length > MAX_TEXT_LENGTH) {
      onError("Text is too long. Send up to 4,096 characters at a time.");
      return;
    }
    for (const character of characters) {
      if (character === "\n") {
        if (!sendSpecial("Enter")) return;
      } else if (character === "\t") {
        if (!sendSpecial("Tab")) return;
      } else {
        const point = character.codePointAt(0)!;
        if (
          point < 0x20 ||
          (point >= 0x7f && point < 0xa0) ||
          (point >= 0xd800 && point <= 0xdfff)
        )
          continue;
        if (!sendKey(point <= 0xff ? point : 0x01000000 + point)) return;
      }
    }
  }

  function bufferText() {
    return input.value.startsWith(SENTINEL)
      ? input.value.slice(SENTINEL.length)
      : input.value;
  }

  input.addEventListener("focus", () => {
    if (inline && !opened) activate();
  });

  input.addEventListener("beforeinput", (event) => {
    if (!opened || !available()) {
      event.preventDefault();
      close();
      return;
    }
    if (composing || event.isComposing) return;
    if (event.inputType?.includes("Composition")) return;
    compositionEcho = null;
    if (event.inputType?.startsWith("delete")) {
      event.preventDefault();
      sendSpecial(event.inputType.endsWith("Forward") ? "Delete" : "Backspace");
      reset();
    } else if (
      ["insertLineBreak", "insertParagraph"].includes(event.inputType)
    ) {
      event.preventDefault();
      sendSpecial("Enter");
      reset();
    } else if (event.inputType?.startsWith("history")) {
      // A local undo stack has no relationship to the remote field's history.
      event.preventDefault();
      reset();
    }
  });

  input.addEventListener("input", (rawEvent) => {
    const event = rawEvent as InputEvent;
    if (!opened || !available()) return close();
    if (composing || event.isComposing) return;
    const text = bufferText();
    // Engines can dispatch their final composition input after compositionend.
    if (
      compositionEcho !== null &&
      (event.inputType?.includes("Composition") ||
        text === compositionEcho ||
        !text)
    ) {
      compositionEcho = null;
      clearBuffer();
      return;
    }
    compositionEcho = null;
    if (event.inputType?.startsWith("delete")) {
      sendSpecial(event.inputType.endsWith("Forward") ? "Delete" : "Backspace");
    } else if (text) sendText(text);
    clearBuffer();
  });

  input.addEventListener("compositionstart", () => {
    if (!opened || !available()) return close();
    composing = true;
    compositionEcho = null;
  });

  input.addEventListener("compositionend", (event) => {
    // A reset caused by a remote field change also cancels uncommitted input.
    if (!composing) return reset();
    composing = false;
    if (!opened || !available()) return close();
    const text = typeof event.data === "string" ? event.data : bufferText();
    compositionEcho = text;
    sendText(text);
    clearBuffer();
  });

  input.addEventListener("paste", (event) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    if (!opened || !available()) return close();
    sendText(event.clipboardData.getData("text/plain"));
    reset();
  });

  function dismissOnEscape(event: KeyboardEvent) {
    if (
      (!opened && !inline) ||
      event.key !== "Escape" ||
      composing ||
      event.isComposing ||
      event.keyCode === 229
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    close({ restoreFocus: true });
  }

  input.addEventListener("keydown", (event) => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") return dismissOnEscape(event);
    // Physical Tab and Shift+Tab must navigate the local interface.
    if (event.key !== "Enter") return;
    event.preventDefault();
    sendSpecial("Enter");
    reset();
  });
  panel.addEventListener("keydown", dismissOnEscape);

  input.addEventListener("blur", reset);
  button.addEventListener("click", () =>
    opened ? close({ restoreFocus: true }) : open(),
  );
  closeButton.addEventListener("click", () => close({ restoreFocus: true }));
  enterButton.addEventListener("pointerdown", (event) =>
    event.preventDefault(),
  );
  enterButton.addEventListener("click", () => {
    if (inline && !opened && !activate()) return;
    if (!opened || !available()) return close();
    sendSpecial("Enter");
    reset();
    if (opened) input.focus({ preventScroll: true });
  });

  close();
  sync();
  return { open, close, sync, reset, setInline };
}
