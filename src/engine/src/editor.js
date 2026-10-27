/** Private, tab-scoped field handles for the controlling human display. */
/** @typedef {HTMLInputElement | HTMLTextAreaElement} TextControl */
/** @param {number} prefix - Document generation. */
((prefix) => {
  /** @type {WeakMap<TextControl, string>} */
  const ids = new WeakMap();
  /** @type {Map<string, TextControl>} */
  let elements = new Map();
  let next = 0;
  /** @type {TextControl | null} */
  let active = null;
  const types = new Set(["text", "search", "url", "tel", "email", "password", "number"]);
  /** @param {Element | null | undefined} element - Candidate page field.
   * @returns {element is TextControl} Whether the field can be edited. */
  const editable = (element) => {
    if (!element?.isConnected || !["INPUT", "TEXTAREA"].includes(element.tagName)) {
      return false;
    }
    const view = element.ownerDocument.defaultView;
    if (
      !view ||
      !(element instanceof view.HTMLInputElement || element instanceof view.HTMLTextAreaElement)
    ) {
      return false;
    }
    return (
      !element.disabled &&
      !element.readOnly &&
      (element.tagName === "TEXTAREA" || types.has(element.type))
    );
  };
  /** @param {TextControl} element - Candidate page field. */
  const value = (element) => element.value;
  /** @param {TextControl} element - Candidate page field. */
  const identity = (element) => {
    const known = ids.get(element);
    if (known) {
      return known;
    }
    const id = `${prefix}:${++next}`;
    ids.set(element, id);
    return id;
  };
  /** @param {TextControl} element - Candidate page field. */
  const bounds = (element) => {
    const r = element.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    let { width, height } = r;
    let win = element.ownerDocument.defaultView;
    if (!win) {
      throw new Error("This document is no longer available");
    }
    while (win !== window) {
      const owner = win.frameElement;
      if (!owner || !owner.isConnected || owner.tagName !== "IFRAME") {
        throw new Error("This frame is no longer available");
      }
      const view = owner.ownerDocument.defaultView;
      if (!view || !(owner instanceof view.HTMLIFrameElement)) {
        throw new Error("This frame is no longer available");
      }
      const frame = owner;
      if (!frame) {
        throw new Error("This frame is no longer available");
      }
      const rect = frame.getBoundingClientRect();
      const sx = rect.width / frame.offsetWidth;
      const sy = rect.height / frame.offsetHeight;
      x = rect.left + (frame.clientLeft + x) * sx;
      y = rect.top + (frame.clientTop + y) * sy;
      width *= sx;
      height *= sy;
      win = win.parent;
    }
    const viewport = window.visualViewport;
    const scale = viewport?.scale || 1;
    return {
      x: (x - (viewport?.offsetLeft || 0)) * scale,
      y: (y - (viewport?.offsetTop || 0)) * scale,
      width: width * scale,
      height: height * scale,
    };
  };
  /** @param {TextControl} element - Candidate page field. */
  const state = (element) => ({
    value: value(element),
    start: element.selectionStart ?? value(element).length,
    end: element.selectionEnd ?? value(element).length,
  });
  /** @param {string} reference - Opaque field handle. */
  const target = (reference) => {
    const element = elements.get(reference);
    if (!editable(element) || value(element).length > 4096) {
      throw new Error("This field changed; tap it again");
    }
    return element;
  };
  /** @param {string} reference - Opaque field handle. */
  const focused = (reference) => {
    const element = target(reference);
    bounds(element);
    if (active !== element || fieldRoot(element).activeElement !== element) {
      throw new Error("This field no longer has focus");
    }
    return element;
  };
  /** @param {TextControl} element - Candidate page field. */
  const fieldRoot = (element) => {
    const root = element.getRootNode();
    const view = element.ownerDocument.defaultView;
    if (view && (root instanceof view.Document || root instanceof view.ShadowRoot)) {
      return root;
    }
    throw new Error("This document is no longer available");
  };
  return {
    scan() {
      /** @type {Map<string, TextControl>} */
      const found = new Map();
      /** @type {Array<{reference:string,x:number,y:number,width:number,height:number,value:string,type:string,inputMode:string,enterKeyHint:string,label:string,maxLength:number}>} */
      const fields = [];
      let visited = 0;
      /** @param {Element} element - Candidate page field. */
      const add = (element) => {
        if (!editable(element) || value(element).length > 4096) {
          return;
        }
        const win = element.ownerDocument.defaultView;
        if (!win) {
          return;
        }
        const style = win.getComputedStyle(element);
        const rect = bounds(element);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.visibility !== "visible" ||
          style.opacity === "0"
        ) {
          return;
        }
        if (active !== element) {
          if (
            rect.x + rect.width <= 0 ||
            rect.y + rect.height <= 0 ||
            rect.x >= innerWidth * (visualViewport?.scale || 1) ||
            rect.y >= innerHeight * (visualViewport?.scale || 1)
          ) {
            return;
          }
          const local = element.getBoundingClientRect();
          const hit = fieldRoot(element).elementFromPoint(
            local.left + local.width / 2,
            local.top + local.height / 2,
          );
          if (hit !== element && !element.contains(hit)) {
            return;
          }
        }
        const reference = identity(element);
        found.set(reference, element);
        fields.push({
          reference,
          ...rect,
          value: element.type === "password" ? "" : value(element),
          type: element.tagName === "TEXTAREA" ? "textarea" : element.type,
          inputMode: element.inputMode,
          enterKeyHint:
            element.enterKeyHint ||
            (element.type === "search" || element.name === "q" ? "search" : "enter"),
          label: (
            element.getAttribute("aria-label") ||
            element.labels?.[0]?.textContent ||
            element.placeholder ||
            "Page text field"
          ).slice(0, 160),
          maxLength: element.maxLength >= 0 ? Math.min(4096, element.maxLength) : 4096,
        });
      };
      /** @param {Document | ShadowRoot} root - Document or open shadow root. */
      const collect = (root) => {
        for (const element of root.querySelectorAll("*")) {
          if (++visited > 6000 || fields.length >= 48) {
            break;
          }
          add(element);
          if (element.shadowRoot) {
            collect(element.shadowRoot);
          }
          const view = element.ownerDocument.defaultView;
          if (view && element instanceof view.HTMLIFrameElement) {
            const frame = element;
            try {
              if (frame.contentDocument) {
                collect(frame.contentDocument);
              }
            } catch {
              /* Another origin requires a separate frame bridge. */
            }
          }
        }
      };
      collect(document);
      elements = found;
      return fields;
    },
    /** @param {string} reference - Opaque field handle. */
    prepare(reference) {
      const element = target(reference);
      return bounds(element);
    },
    /** @param {string} reference - Opaque field handle. */
    focus(reference) {
      const element = target(reference);
      if (fieldRoot(element).activeElement !== element) {
        throw new Error("The field no longer has focus");
      }
      active = element;
      return state(element);
    },
    /** @param {string} reference - Opaque field handle. */
    state(reference) {
      return state(focused(reference));
    },
    /** @param {string} reference - Opaque field handle. @param {number} start - Selection start in UTF-16 units. @param {number} end - Selection end in UTF-16 units. */
    range(reference, start, end) {
      const element = focused(reference);
      try {
        element.setSelectionRange(start, end);
        return true;
      } catch {
        return false;
      }
    },
    /** @param {string} reference - Opaque field handle. */
    blur(reference) {
      if (active && elements.get(reference) === active) {
        active.blur();
        active = null;
      }
      return null;
    },
  };
})(EDITOR_GENERATION);
