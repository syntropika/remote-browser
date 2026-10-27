/** Native mobile text controls aligned with fields in the engine-painted page. */
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { action } from "./api.js";
import { background } from "./async-boundary.js";
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
  const active = useRef(false);
  const composing = useRef(false);
  const backend = useRef(field.value);
  const revision = useRef(0);
  const loaded = useRef(false);
  const initial = useRef<Selection>({
    value: field.value,
    start: field.value.length,
    end: field.value.length,
  });
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );

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
    requestAnimationFrame(() => {
      const target = control.current;
      if (target && active.current && revision.current === version) {
        try {
          target.setSelectionRange(count(state.start), count(state.end));
        } catch {
          /* Email and number controls do not expose a text selection. */
        }
      }
    });
  };
  const update = (target: TextControl) => {
    const next = selection(target);
    setDraft(next.value);
    const version = ++revision.current;
    if (composing.current) {
      return;
    }
    const beforeFocusReply = !loaded.current;
    background(
      request(
        "editor_update",
        () => {
          let { value } = next;
          let { start } = next;
          let { end } = next;
          // A password is fetched only after an explicit focus. Preserve text typed before
          // that first round trip rather than replacing an existing password with the draft.
          if (beforeFocusReply && field.value === "" && initial.current.value !== "") {
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
  const shared = {
    "aria-label": field.label,
    "data-page-editor": field.reference,
    autoComplete: "off",
    autoCapitalize: "none" as const,
    enterKeyHint: enterHint(field.enterKeyHint),
    inputMode: inputMode(field),
    spellCheck: field.type !== "password",
    maxLength: field.maxLength,
    className:
      "border-line-strong bg-card text-ink caret-accent pointer-events-auto absolute resize-none rounded-lg border px-2 text-base outline-none focus:border-accent",
    style: {
      left: box.left + field.x * box.scaleX,
      top: box.top + field.y * box.scaleY,
      width: field.width * box.scaleX,
      height: field.height * box.scaleY,
      lineHeight: `${Math.max(16, Math.min(24, field.height * box.scaleY - 2))}px`,
      opacity: focused ? 1 : 0,
    },
    value: draft,
    ref: (element: TextControl | null) => {
      control.current = element;
    },
    onFocus: () => {
      active.current = true;
      loaded.current = false;
      setFocused(true);
      const version = revision.current;
      background(
        request(
          "editor_focus",
          {
            reference: field.reference,
            x: field.x + field.width / 2,
            y: field.y + field.height / 2,
          },
          (reply) => {
            const state = record(reply);
            initial.current = {
              value: text(state.value),
              start: count(state.start),
              end: count(state.end),
            };
            loaded.current = true;
            // The local control already has focus from the actual tap, opening the keyboard
            // synchronously even when the engine response arrives later.
            const { current } = control;
            apply(
              {
                ...state,
                ...(current && field.type !== "password"
                  ? { start: current.selectionStart, end: current.selectionEnd }
                  : {}),
              },
              version,
            );
          },
        ),
        close,
      );
    },
    onBlur: () => {
      if (!active.current) {
        return;
      }
      active.current = false;
      setFocused(false);
      background(request("editor_blur", { reference: field.reference }), () => undefined);
    },
    onChange: (event: React.ChangeEvent<TextControl>) => update(event.currentTarget),
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: (event: React.CompositionEvent<TextControl>) => {
      composing.current = false;
      update(event.currentTarget);
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
  return field.type === "textarea" ? (
    <textarea {...shared} />
  ) : (
    <input {...shared} type={field.type === "password" ? "password" : "text"} />
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
