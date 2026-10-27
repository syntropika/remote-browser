/** Native editing offsets for contenteditable hosts, without rewriting their markup. */
export default (() => {
  /** @typedef {{node: Node, offset: number}} Point */
  /** @param {Element | null | undefined} element - Candidate editing host.
   * @returns {element is HTMLElement} Whether this is an editable HTML host. */
  const accepts = (element) => {
    const view = element?.ownerDocument.defaultView;
    return !!(
      view &&
      element instanceof view.HTMLElement &&
      element.isContentEditable &&
      !element.parentElement?.isContentEditable &&
      !element.closest('[inert],[aria-disabled="true"],[aria-readonly="true"]')
    );
  };
  /** @param {HTMLElement} element - Editing host. */
  const model = (element) => {
    let text = "";
    let pendingBreak = false;
    let visited = 0;
    /** @type {Point[]} */
    const points = [{ node: element, offset: 0 }];
    /** @type {Map<Node, number[]>} */
    const offsets = new Map();
    /** @param {string} value - Text to append. @param {Point} point - End of the appended unit. */
    const append = (value, point) => {
      text += value;
      points.push(point);
      if (text.length > 4096) {
        throw new Error("This editor exceeds the text limit");
      }
    };
    /** @param {Node} node - Node in the editing host. */
    const visit = (node) => {
      if (++visited > 6000) {
        throw new Error("This editor exceeds the node limit");
      }
      const view = node.ownerDocument?.defaultView;
      if (!view) {
        return;
      }
      if (node instanceof view.Text) {
        // Chromium uses nonbreaking spaces while editing; keep logical offsets unchanged.
        const value = node.data.replaceAll("\u00A0", " ");
        if (text.length + value.length > 4096) {
          throw new Error("This editor exceeds the text limit");
        }
        if (pendingBreak && value) {
          append("\n", { node, offset: 0 });
          pendingBreak = false;
        }
        const start = text.length;
        offsets.set(
          node,
          Array.from({ length: value.length + 1 }, (_, index) => start + index),
        );
        if (value) {
          points[text.length] = { node, offset: 0 };
        }
        for (let index = 0; index < value.length; index++) {
          append(value[index], { node, offset: index + 1 });
        }
        return;
      }
      if (!(node instanceof view.HTMLElement)) {
        return;
      }
      const style = view.getComputedStyle(node);
      if (style.display === "none" || style.visibility !== "visible") {
        return;
      }
      const block =
        node !== element &&
        !["inline", "inline-block", "inline-flex", "inline-grid", "contents"].includes(
          style.display,
        );
      if (node.tagName === "BR") {
        // Chromium adds a final placeholder break to keep an empty line editable.
        if (
          !node.nextSibling &&
          (!node.previousSibling || node.previousSibling.nodeName === "BR")
        ) {
          return;
        }
        const parent = node.parentNode;
        if (parent) {
          append("\n", {
            node: parent,
            offset: Array.prototype.indexOf.call(parent.childNodes, node) + 1,
          });
        }
        return;
      }
      if ((block || pendingBreak) && text) {
        append("\n", { node, offset: 0 });
      }
      pendingBreak = false;
      if (!node.isContentEditable) {
        // Noneditable embedded content is an atomic character, never flattened into text.
        const parent = node.parentNode;
        if (parent) {
          const index = Array.prototype.indexOf.call(parent.childNodes, node);
          points[text.length] = { node: parent, offset: index };
          append("\uFFFC", { node: parent, offset: index + 1 });
        }
        return;
      }
      const boundaries = [text.length];
      for (const child of node.childNodes) {
        visit(child);
        boundaries.push(text.length);
      }
      offsets.set(node, boundaries);
      pendingBreak = block;
    };
    visit(element);
    // Plaintext editing keeps a final LF as a caret placeholder, like a trailing BR.
    if (element.contentEditable === "plaintext-only" && text.endsWith("\n")) {
      text = text.slice(0, -1);
      points.pop();
    }
    /** @param {Node | null} node - Selection node. @param {number} index - DOM selection offset. */
    const offset = (node, index) => {
      const positions = node && offsets.get(node);
      const position = positions?.[index];
      if (position === undefined) {
        throw new Error("The editor selection changed");
      }
      return Math.min(text.length, position);
    };
    return { text, points, offset };
  };
  /** @param {HTMLElement} element - Editing host. */
  const state = (element) => {
    const selection = element.ownerDocument.getSelection();
    const view = element.ownerDocument.defaultView;
    let root = element.getRootNode();
    const shadows = [];
    if (view) {
      while (root instanceof view.ShadowRoot) {
        shadows.push(root);
        root = root.host.getRootNode();
      }
    }
    const range = selection?.getComposedRanges({ shadowRoots: shadows })[0];
    if (
      !range ||
      !element.contains(range.startContainer) ||
      !element.contains(range.endContainer)
    ) {
      throw new Error("This editor no longer has a selection");
    }
    const current = model(element);
    const anchor = current.offset(range.startContainer, range.startOffset);
    const focus = current.offset(range.endContainer, range.endOffset);
    return { value: current.text, start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  };
  return {
    accepts,
    /** @param {HTMLElement} element - Editing host. */
    value: (element) => model(element).text,
    state,
    /** @param {HTMLElement} element - Editing host. @param {number} start - UTF-16 start. @param {number} end - UTF-16 end. */
    range(element, start, end) {
      const selection = element.ownerDocument.getSelection();
      if (!selection) {
        throw new Error("This editor no longer has a selection");
      }
      const current = model(element);
      const a = current.points[Math.min(current.text.length, Math.max(0, start))];
      const b = current.points[Math.min(current.text.length, Math.max(start, end))];
      if (!a || !b) {
        throw new Error("The editor selection changed");
      }
      const previous = state(element);
      if (previous.start !== start || previous.end !== end) {
        selection.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
      }
      return true;
    },
  };
})();
