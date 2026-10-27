/** The page itself: frames the engine paints, and the input a person sends back. */
import { useCallback, useEffect, useRef } from "react";

import { action, displayId, failure } from "./api.js";
import { background } from "./async-boundary.js";
import { displayScale } from "./display-session.js";
import type { Frame } from "./model.js";
import { readFrame } from "./model.js";
import { PageEditors } from "./page-editors.js";
import type { PageRequest } from "./page-editors.js";
import { count, record } from "./wire.js";

/** How long the engine may hold a frame request while it waits for the page to move. */
const FRAME_WAIT = 250;
/** How long to wait after a failed frame before asking again. */
const FRAME_RETRY = 500;
/** A resize settles before the engine is asked for a new surface. */
const RESIZE_SETTLE = 80;
/** Movement below this is a tap rather than a drag. */
const DRAG_THRESHOLD = 4;

type Point = { x: number; y: number };

type Props = {
  profileId: string;
  tabId: string;
  /** Whether input reaches the page. A tab an agent holds only shows its frames. */
  interactive: boolean;
  controls: boolean;
  visible: boolean;
  epoch: number;
  onNotice: (message: string) => void;
  onReady: (ready: boolean) => void;
  /** Keys the dashboard keeps for itself, such as copy and cut. */
  onShortcut: (event: KeyboardEvent) => boolean;
  /** The size the engine is painting, which the settings panel reports. */
  onSurface: (size: string) => void;
  onPaste: (text: string) => void;
};

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function modifiers(event: MouseEvent | KeyboardEvent | React.PointerEvent | React.KeyboardEvent) {
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

export function Display({
  profileId,
  tabId,
  interactive,
  controls,
  visible,
  epoch,
  onNotice,
  onReady,
  onShortcut,
  onSurface,
  onPaste,
}: Props) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const surface = useRef({ width: 1024, height: 768 });
  /** Whether `surface` describes what the engine is painting now. Switching sessions hands the
   *  display another engine, whose surface is its own, so what was measured no longer holds. */
  const sized = useRef(false);
  const seq = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pressed = useRef<number | null>(null);
  const pendingMove = useRef<Point | null>(null);
  const touch = useRef<Point | null>(null);
  const pointerKind = useRef("mouse");
  const live = useRef({ profileId, tabId, interactive });
  live.current = { profileId, tabId, interactive };

  /** Input keeps its event order, including field focus, edits, blur and the next focus. */
  const request: PageRequest = useCallback(
    (op, args, receive) => {
      const { profileId: profile, tabId: tab } = live.current;
      const task = queue.current
        .catch(() => undefined)
        .then(async () => {
          if (
            op.startsWith("editor_") &&
            (live.current.tabId !== tab ||
              live.current.profileId !== profile ||
              !live.current.interactive)
          ) {
            throw new Error("The page no longer has input control");
          }
          const reply = await action(op, typeof args === "function" ? args() : args, tab, profile);
          receive?.(reply);
          return reply;
        });
      queue.current = task.catch((cause: unknown) => {
        onNotice(failure(cause).message);
      });
      return task;
    },
    [onNotice],
  );
  const enqueue = useCallback(
    (op: string, args: Record<string, unknown>) => {
      background(request(op, args), () => undefined);
    },
    [request],
  );

  const point = useCallback((event: { clientX: number; clientY: number }): Point => {
    const box = canvas.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) {
      return { x: 0, y: 0 };
    }
    const { width, height } = surface.current;
    // The last pixel of the surface is one less than its size.
    return {
      x: Math.max(0, Math.min(width - 1, ((event.clientX - box.left) * width) / box.width)),
      y: Math.max(0, Math.min(height - 1, ((event.clientY - box.top) * height) / box.height)),
    };
  }, []);

  // Frames. The engine holds each request until the page moves, so a change reaches the
  // display as soon as it is painted, and an unchanged page costs one reply.
  useEffect(() => {
    if (!tabId || !visible) {
      return;
    }
    let watching = true;
    seq.current = 0;
    sized.current = false;
    onReady(false);
    const draw = async (frame: Frame) => {
      const target = canvas.current;
      if (!target) {
        return;
      }
      const image = new Image();
      image.src = `data:image/png;base64,${frame.image}`;
      await image.decode();
      if (!watching) {
        return;
      }
      // A frame that covers the surface carries its size; a patch lands where it moved.
      // Assigning a size clears the canvas, so it is only assigned when it changes.
      const resized = target.width !== frame.surfaceWidth || target.height !== frame.surfaceHeight;
      if (
        frame.x === 0 &&
        frame.y === 0 &&
        frame.width === frame.surfaceWidth &&
        frame.height === frame.surfaceHeight
      ) {
        // A full frame is the engine telling the display how big its surface is, which is how
        // a session switch corrects what the previous engine was painting.
        surface.current = { width: frame.viewWidth, height: frame.viewHeight };
        sized.current = true;
        target.style.aspectRatio = `${frame.viewWidth} / ${frame.viewHeight}`;
        if (resized) {
          target.width = frame.surfaceWidth;
          target.height = frame.surfaceHeight;
          onSurface(`${frame.surfaceWidth} × ${frame.surfaceHeight}`);
        }
      }
      target.getContext("2d")?.drawImage(image, frame.x, frame.y);
    };
    const watch = async () => {
      for (;;) {
        if (!watching) {
          return;
        }
        try {
          const reply = await action(
            "screenshot",
            { since: seq.current, wait: FRAME_WAIT },
            tabId,
            profileId,
          );
          if (!watching) {
            return;
          }
          const frame = readFrame(reply);
          if (!frame) {
            // Nothing moved, so what is on the canvas is what the page looks like. A page
            // that sits still still has a display, and the view says so.
            if (seq.current > 0) {
              onReady(true);
            }
            continue;
          }
          await draw(frame);
          seq.current = frame.seq;
          onReady(true);
        } catch (cause) {
          if (!watching) {
            return;
          }
          const error = failure(cause);
          // A tab that has been closed takes its frames with it: the stream ends rather than
          // failing, and the strip drops the tab on its next listing.
          if (/no tab/iu.test(error.message)) {
            return;
          }
          if (!/busy/iu.test(error.message)) {
            onNotice(error.message);
          }
          await pause(FRAME_RETRY);
        }
      }
    };
    background(watch());
    return () => {
      watching = false;
    };
  }, [tabId, profileId, epoch, visible, onNotice, onReady, onSurface]);

  // The engine renders the surface the chrome leaves for the page, so a wide window shows
  // a wide page rather than a small one stretched to fit.
  useEffect(() => {
    const box = viewport.current;
    if (!box || !tabId || !controls || !visible) {
      return;
    }
    let timer = 0;
    let settled = true;
    let watching = true;
    let previous = "";
    const pointer = window.matchMedia("(pointer: coarse)");
    const hover = window.matchMedia("(hover: none)");
    const apply = async () => {
      const rect = box.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width < 320 || height < 240) {
        return;
      }
      const metrics = {
        width,
        height,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        deviceScaleFactor: displayScale(width, height, window.devicePixelRatio),
        mobile: pointer.matches && hover.matches,
      };
      const measured = JSON.stringify(metrics);
      if (!watching || measured === previous) {
        return;
      }
      settled = false;
      sized.current = false;
      try {
        const applied = record(await action("resize", metrics, tabId, profileId));
        if (!watching) {
          return;
        }
        previous = measured;
        surface.current = {
          width: count(applied.width, width),
          height: count(applied.height, height),
        };
        sized.current = true;
        // The canvas is resized by the next full frame, which the engine sends because the
        // display asks again from the beginning.
        seq.current = 0;
      } catch (cause) {
        if (watching) {
          onNotice(failure(cause).message);
        }
      } finally {
        settled = true;
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (settled) {
          background(apply());
        } else {
          schedule();
        }
      }, RESIZE_SETTLE);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(box);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    pointer.addEventListener("change", schedule);
    hover.addEventListener("change", schedule);
    schedule();
    return () => {
      observer.disconnect();
      watching = false;
      window.clearTimeout(timer);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      pointer.removeEventListener("change", schedule);
      hover.removeEventListener("change", schedule);
    };
  }, [tabId, profileId, epoch, controls, visible, onNotice]);

  // Wheel and touch listeners are registered here because a page scrolled with the wheel
  // must not also scroll the dashboard, and React's own listeners cannot prevent that.
  useEffect(() => {
    const target = viewport.current;
    if (!target) {
      return;
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!live.current.interactive) {
        return;
      }
      enqueue("scroll", {
        x: Math.trunc(Math.max(-10_000, Math.min(10_000, event.deltaX))),
        y: Math.trunc(Math.max(-10_000, Math.min(10_000, event.deltaY))),
        ...modifiers(event),
      });
    };
    const start = (event: TouchEvent) => {
      const first = event.touches[0];
      touch.current = first ? { x: first.clientX, y: first.clientY } : null;
    };
    const move = (event: TouchEvent) => {
      if (
        event.target === document.activeElement &&
        event.target instanceof Element &&
        event.target.matches("[data-page-editor]")
      ) {
        return;
      }
      const first = event.touches[0];
      if (!touch.current || !first || !live.current.interactive) {
        return;
      }
      const box = canvas.current?.getBoundingClientRect();
      if (!box) {
        return;
      }
      const x = Math.round(((touch.current.x - first.clientX) * surface.current.width) / box.width);
      const y = Math.round(
        ((touch.current.y - first.clientY) * surface.current.height) / box.height,
      );
      if (Math.abs(x) + Math.abs(y) < DRAG_THRESHOLD) {
        return;
      }
      event.preventDefault();
      touch.current = { x: first.clientX, y: first.clientY };
      enqueue("scroll", { x, y });
    };
    const end = () => {
      touch.current = null;
    };
    target.addEventListener("wheel", wheel, { passive: false });
    target.addEventListener("touchstart", start, { passive: true });
    target.addEventListener("touchmove", move, { passive: false });
    target.addEventListener("touchend", end);
    target.addEventListener("touchcancel", end);
    return () => {
      target.removeEventListener("wheel", wheel);
      target.removeEventListener("touchstart", start);
      target.removeEventListener("touchmove", move);
      target.removeEventListener("touchend", end);
      target.removeEventListener("touchcancel", end);
    };
  }, [enqueue]);

  const cancelPress = useCallback(() => {
    if (pressed.current === null) {
      return;
    }
    const pointerId = pressed.current;
    pressed.current = null;
    enqueue("input", { kind: "cancel" });
    if (canvas.current?.hasPointerCapture(pointerId)) {
      canvas.current.releasePointerCapture(pointerId);
    }
  }, [enqueue]);

  // A press that ends where the dashboard cannot see it is cancelled, so the page is told
  // the pointer left rather than waiting for a release that never comes.
  useEffect(() => {
    const blur = () => {
      cancelPress();
    };
    const hidden = () => {
      if (document.hidden) {
        cancelPress();
      }
    };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [cancelPress]);

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch") {
      return;
    }
    const held = pressed.current;
    if (held === null ? !interactive : event.pointerId !== held) {
      return;
    }
    // Until a frame says how big this engine's surface is, a position measured against the
    // previous one would land outside it.
    if (!sized.current) {
      return;
    }
    // Movement waiting behind an earlier action collapses into the latest position, so a
    // hover never falls behind the pointer.
    const latest = point(event);
    if (pendingMove.current) {
      pendingMove.current = latest;
      return;
    }
    pendingMove.current = latest;
    const keys = modifiers(event);
    queue.current = queue.current
      .catch(() => undefined)
      .then(() => {
        const position = pendingMove.current;
        pendingMove.current = null;
        const { profileId: profile, tabId: tab } = live.current;
        if (!position) {
          return undefined;
        }
        return action("input", { kind: "move", ...position, ...keys }, tab, profile);
      })
      .catch((cause: unknown) => {
        onNotice(failure(cause).message);
      });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointerKind.current = event.pointerType;
    if (event.pointerType === "touch" || event.button !== 0) {
      return;
    }
    if (pressed.current !== null) {
      if (event.pointerId !== pressed.current) {
        return;
      }
      cancelPress();
    }
    canvas.current?.focus({ preventScroll: true });
    if (!interactive) {
      onNotice("Wait for the page, or take control to interact from this screen.");
      return;
    }
    if (!sized.current) {
      onNotice("Wait for the page: this session is still painting its first frame.");
      return;
    }
    canvas.current?.setPointerCapture(event.pointerId);
    pressed.current = event.pointerId;
    pendingMove.current = null;
    enqueue("input", { kind: "down", ...point(event), ...modifiers(event) });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (pressed.current !== event.pointerId || event.button !== 0) {
      return;
    }
    pressed.current = null;
    pendingMove.current = null;
    // A release always ends its press; without a trustworthy position the engine uses the one
    // the pointer already had.
    enqueue("input", {
      kind: "up",
      ...(sized.current ? point(event) : {}),
      ...modifiers(event),
    });
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (pressed.current === event.pointerId) {
      cancelPress();
    }
  };

  const onPointerLeave = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch" || pressed.current !== null || !interactive) {
      return;
    }
    enqueue("input", { kind: "leave", ...point(event) });
  };

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    // A tap arrives as a click with no press before it; a mouse press is already sent.
    if (pointerKind.current !== "touch" || !interactive) {
      return;
    }
    canvas.current?.focus({ preventScroll: true });
    enqueue("input", { kind: "click", ...point(event) });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) {
      return;
    }
    if (onShortcut(event.nativeEvent)) {
      return;
    }
    event.preventDefault();
    if (!interactive) {
      return;
    }
    enqueue("input", { kind: "key", key: event.key, ...modifiers(event) });
  };

  return (
    <div
      className="bg-page relative flex size-full items-start justify-center overflow-hidden"
      data-display-id={displayId}
      ref={viewport}
    >
      <canvas
        aria-label="Browser page"
        // A frame keeps the size it was painted at: stretched to its box it would scale
        // the page for as long as a new surface takes to arrive, which reads as the page
        // changing resolution.
        className="block max-h-full max-w-full flex-none touch-none self-start bg-white outline-none"
        style={{ width: "auto", height: "auto", objectFit: "contain" }}
        height={768}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          event.preventDefault();
          if (interactive) {
            onPaste(event.clipboardData.getData("text/plain"));
          }
        }}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerLeave={onPointerLeave}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        ref={canvas}
        tabIndex={0}
        width={1024}
      />
      {/* Each controlling page owns its editors; changing tabs unmounts pending drafts. */}
      {interactive && visible && (
        <PageEditors
          key={`${profileId}:${tabId}`}
          enabled
          profileId={profileId}
          tabId={tabId}
          canvas={canvas}
          viewport={viewport}
          surface={surface}
          request={request}
        />
      )}
    </div>
  );
}
