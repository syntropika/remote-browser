/** Native mobile text controls aligned with fields in the engine-painted page. */
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { action } from "./api.js";
import { background } from "./async-boundary.js";
import { Icon } from "./icons.js";
import { count, list, record, text } from "./wire.js";

export type PageRequest = (
  op: string,
  args: Record<string, unknown> | (() => Record<string, unknown>),
  receive?: (value: unknown) => void,
) => Promise<unknown>;

type Field = {
  reference: string;
  x: number;
  y: number;
  width: number;
  height: number;
  value: string;
  type: string;
  inputMode: string;
  enterKeyHint: string;
  autocomplete: string;
  label: string;
  maxLength: number;
};
type TextControl = HTMLInputElement | HTMLTextAreaElement;
type Selection = { value: string; start: number; end: number };
type Box = { left: number; top: number; scaleX: number; scaleY: number };

function enterHint(value: string): React.HTMLAttributes<TextControl>["enterKeyHint"] {
  switch (value) {
    case "enter":
    case "done":
    case "go":
    case "next":
    case "previous":
    case "search":
    case "send": {
      return value;
    }
    default: {
      return "enter";
    }
  }
}
function inputMode(field: Field): React.HTMLAttributes<TextControl>["inputMode"] {
  switch (field.inputMode) {
    case "none":
    case "text":
    case "decimal":
    case "numeric":
    case "tel":
    case "search":
    case "email":
    case "url": {
      return field.inputMode;
    }
    default: {
      return field.type === "number"
        ? "decimal"
        : field.type === "tel"
          ? "tel"
          : field.type === "email"
            ? "email"
            : "text";
    }
  }
}
function selection(control: TextControl): Selection {
  return {
    value: control.value,
    start: control.selectionStart ?? control.value.length,
    end: control.selectionEnd ?? control.value.length,
  };
}

function FieldEditor({ field, box, request }: { field: Field; box: Box; request: PageRequest }) {
  const control = useRef<TextControl | null>(null);
  const [draft, setDraft] = useState(field.value);
  const [focused, setFocused] = useState(false);
  const [useCredentials, setUseCredentials] = useState(false);
  const active = useRef(false);
  const focusReady = useRef(false);
  const credentialMode = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const retarget = useRef(false);
  const composing = useRef(false);
  const backend = useRef(field.value);
  const revision = useRef(0);
  const selected = useRef({ start: 0, end: 0 });
  const selectionChanged = useRef<() => void>(() => undefined);
  const loaded = useRef(false);
  const initial = useRef<Selection>({
    value: field.value,
    start: field.value.length,
    end: field.value.length,
  });
  useEffect(() => {
    const changed = () => {
      if (document.activeElement === control.current) {
        selectionChanged.current();
      }
    };
    document.addEventListener("selectionchange", changed);
    return () => {
      active.current = false;
      document.removeEventListener("selectionchange", changed);
    };
  }, []);

  useEffect(() => {
    if (!active.current) {
      backend.current = field.value;
      setDraft(field.value);
    }
  }, [field.value]);

  const close = () => {
    active.current = false;
    setFocused(false);
    control.current?.blur();
  };
  const apply = (reply: unknown, version: number) => {
    const state = record(reply);
    backend.current = text(state.value);
    if (!active.current || revision.current !== version) {
      return;
    }
    setDraft(backend.current);
    const target = control.current;
    if (target && !composing.current) {
      target.value = backend.current;
      selected.current = { start: count(state.start), end: count(state.end) };
      target.setSelectionRange(selected.current.start, selected.current.end);
    }
  };
  const update = (target: TextControl) => {
    const next = selection(target);
    setDraft(next.value);
    const version = ++revision.current;
    if (composing.current) {
      return;
    }
    const beforeFocusReply = !loaded.current;
    const completeCredential = credentialMode.current;
    background(
      request(
        "editor_update",
        () => {
          let { value } = next;
          let { start } = next;
          let { end } = next;
          // Text typed while native focus is pending is a buffer inserted at the native caret.
          if (!completeCredential && beforeFocusReply) {
            const state = initial.current;
            value = state.value.slice(0, state.start) + value + state.value.slice(state.end);
            start += state.start;
            end += state.start;
          }
          return { reference: field.reference, expected: backend.current, value, start, end };
        },
        (reply) => apply(reply, version),
      ),
      close,
    );
  };
  const rebase = (target: TextControl) => {
    const buffer = selection(target);
    const native = initial.current;
    const value =
      native.value.slice(0, native.start) + buffer.value + native.value.slice(native.end);
    setDraft(value);
    target.value = value;
    selected.current = { start: native.start + buffer.start, end: native.start + buffer.end };
    target.setSelectionRange(selected.current.start, selected.current.end);
    loaded.current = true;
  };
  const beginFocus = () => {
    active.current = true;
    loaded.current = false;
    setFocused(true);
    focusReady.current = false;
    const version = ++revision.current;
    if (!credentialMode.current) {
      setDraft("");
      if (control.current) {
        control.current.value = "";
      }
    }
    background(
      request(
        "editor_focus",
        {
          reference: field.reference,
          x: pointer.current?.x ?? field.x + field.width / 2,
          y: pointer.current?.y ?? field.y + field.height / 2,
        },
        (reply) => {
          const state = record(reply);
          initial.current = {
            value: text(state.value),
            start: count(state.start),
            end: count(state.end),
          };
          backend.current = initial.current.value;
          focusReady.current = true;
          if (composing.current) {
            return;
          }
          const target = control.current;
          if (!credentialMode.current && revision.current !== version && target) {
            rebase(target);
          } else {
            loaded.current = true;
            apply(state, version);
          }
        },
      ),
      close,
    );
  };
  selectionChanged.current = () => {
    const target = control.current;
    if (!target) {
      return;
    }
    if (!active.current || !loaded.current || composing.current) {
      return;
    }
    const next = selection(target);
    if (next.start === selected.current.start && next.end === selected.current.end) {
      return;
    }
    selected.current = { start: next.start, end: next.end };
    const version = ++revision.current;
    background(
      request(
        "editor_update",
        () => ({
          reference: field.reference,
          expected: backend.current,
          value: backend.current,
          start: next.start,
          end: next.end,
        }),
        (reply) => apply(reply, version),
      ),
      close,
    );
  };
  const shared = {
    "aria-label": field.label,
    "data-page-editor": field.reference,
    autoComplete:
      field.type === "password" && useCredentials
        ? field.autocomplete === "new-password"
          ? "new-password"
          : "current-password"
        : focused && ["username", "one-time-code"].includes(field.autocomplete)
          ? field.autocomplete
          : "off",
    autoCapitalize: "none" as const,
    enterKeyHint: enterHint(field.enterKeyHint),
    inputMode: inputMode(field),
    spellCheck: false,
    autoCorrect: field.type === "password" ? "off" : "on",
    maxLength: field.maxLength,
    className:
      "pointer-events-auto absolute resize-none border-0 bg-transparent text-base text-transparent caret-transparent outline-none selection:bg-transparent selection:text-transparent",
    style: {
      left: box.left + field.x * box.scaleX,
      top: box.top + field.y * box.scaleY,
      width: field.width * box.scaleX,
      height: field.height * box.scaleY,
      lineHeight: `${Math.max(16, Math.min(24, field.height * box.scaleY - 2))}px`,
      paddingRight: field.type === "password" ? 44 : undefined,
    },
    value: draft,
    ref: (element: TextControl | null) => {
      control.current = element;
    },
    onPointerDown: (event: React.PointerEvent<TextControl>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      pointer.current = {
        x: field.x + (event.clientX - rect.left) / box.scaleX,
        y: field.y + (event.clientY - rect.top) / box.scaleY,
      };
      retarget.current = active.current && loaded.current;
    },
    onPointerUp: (event: React.PointerEvent<TextControl>) => {
      if (
        retarget.current &&
        !composing.current &&
        event.currentTarget.selectionStart === event.currentTarget.selectionEnd
      ) {
        retarget.current = false;
        beginFocus();
      }
    },
    onFocus: beginFocus,
    onBlur: () => {
      if (!active.current) {
        return;
      }
      active.current = false;
      setFocused(false);
      setUseCredentials(false);
      credentialMode.current = false;
      background(request("editor_blur", { reference: field.reference }), () => undefined);
    },
    onSelect: () => selectionChanged.current(),
    onChange: (event: React.ChangeEvent<TextControl>) => update(event.currentTarget),
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: (event: React.CompositionEvent<TextControl>) => {
      composing.current = false;
      update(event.currentTarget);
      if (focusReady.current && !loaded.current && !credentialMode.current) {
        rebase(event.currentTarget);
      }
    },
    onKeyDown: (event: React.KeyboardEvent<TextControl>) => {
      if (composing.current || event.nativeEvent.isComposing) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        control.current?.blur();
        return;
      }
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      update(event.currentTarget);
      const version = revision.current;
      background(
        request("editor_key", { reference: field.reference, key: "Enter" }, (reply) => {
          if (reply === null) {
            close();
          } else {
            apply(reply, version);
          }
        }),
        close,
      );
    },
  };
  return (
    <>
      {["textarea", "contenteditable"].includes(field.type) ? (
        <textarea {...shared} />
      ) : (
        <input {...shared} type={field.type === "password" ? "password" : "text"} />
      )}
      {focused && field.type === "password" && (
        <div
          className="pointer-events-none absolute"
          style={{
            left: shared.style.left,
            top: shared.style.top,
            width: shared.style.width,
            height: shared.style.height,
          }}
        >
          <button
            type="button"
            aria-label="Use saved passwords"
            title="Use saved passwords from your keyboard"
            className="bg-card text-ink pointer-events-auto absolute end-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              const target = control.current;
              // Renew keyboard focus inside this gesture, including after the device hid it.
              target?.blur();
              credentialMode.current = true;
              setUseCredentials(true);
              target?.setAttribute(
                "autocomplete",
                field.autocomplete === "new-password" ? "new-password" : "current-password",
              );
              target?.focus({ preventScroll: true });
            }}
          >
            <Icon name="key" />
          </button>
          {useCredentials && (
            <p
              role="status"
              className="bg-card text-ink absolute start-0 top-full mt-1 rounded-lg p-2 text-xs"
            >
              Use the password key on your keyboard and choose the remote site's login.
            </p>
          )}
        </div>
      )}
    </>
  );
}

export function PageEditors({
  enabled,
  profileId,
  tabId,
  canvas,
  viewport,
  surface,
  request,
}: {
  enabled: boolean;
  profileId: string;
  tabId: string;
  canvas: RefObject<HTMLCanvasElement | null>;
  viewport: RefObject<HTMLDivElement | null>;
  surface: RefObject<{ width: number; height: number }>;
  request: PageRequest;
}) {
  const [touch, setTouch] = useState(window.matchMedia("(pointer: coarse)").matches);
  const [fields, setFields] = useState<Field[]>([]);
  const [box, setBox] = useState<Box>({ left: 0, top: 0, scaleX: 1, scaleY: 1 });
  useEffect(() => {
    const media = window.matchMedia("(pointer: coarse)");
    const changed = () => setTouch(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!enabled || !touch || !tabId) {
      return undefined;
    }
    let watching = true;
    let timer = 0;
    const measure = () => {
      const page = canvas.current?.getBoundingClientRect();
      const parent = viewport.current?.getBoundingClientRect();
      if (page && parent) {
        setBox({
          left: page.left - parent.left,
          top: page.top - parent.top,
          scaleX: page.width / surface.current.width,
          scaleY: page.height / surface.current.height,
        });
      }
    };
    const poll = async () => {
      try {
        const reply = record(await action("editor_fields", {}, tabId, profileId));
        if (
          watching &&
          reply.width === surface.current.width &&
          reply.height === surface.current.height
        ) {
          setFields(
            list(reply.fields).map((value) => {
              const field = record(value);
              return {
                reference: text(field.reference),
                x: count(field.x),
                y: count(field.y),
                width: count(field.width),
                height: count(field.height),
                value: text(field.value),
                type: text(field.type),
                inputMode: text(field.inputMode),
                enterKeyHint: text(field.enterKeyHint),
                autocomplete: text(field.autocomplete),
                label: text(field.label),
                maxLength: count(field.maxLength, 4096),
              };
            }),
          );
          measure();
        }
      } catch {
        /* Loading, navigation and ownership changes invalidate field metadata. */
      }
      if (watching) {
        timer = window.setTimeout(() => {
          background(poll());
        }, 200);
      }
    };
    const observer = new ResizeObserver(measure);
    if (canvas.current) {
      observer.observe(canvas.current);
    }
    background(poll());
    return () => {
      watching = false;
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [enabled, touch, tabId, profileId, canvas, viewport, surface]);
  if (!enabled || !touch) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {fields.map((field) => (
        <FieldEditor
          key={`${profileId}:${tabId}:${field.reference}`}
          field={field}
          box={box}
          request={request}
        />
      ))}
    </div>
  );
}
